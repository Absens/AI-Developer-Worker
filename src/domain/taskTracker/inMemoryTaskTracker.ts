import { randomUUID } from "node:crypto";

import { buildAgentTaskContext } from "./agentContext.js";
import {
  FIELD_OWNERSHIP_RULES,
  assertOwnerCanUpdateFieldGroup,
} from "./fieldOwnership.js";
import {
  DuplicateExternalRefError,
  LeaseExpiredError,
  LeaseNotFoundError,
  LeaseOwnershipError,
  TaskNotFoundError,
  TaskReadinessError,
} from "./errors.js";
import {
  activeBlockingDependenciesForTask,
  compareTasksForClaim,
  isLeaseActiveAt,
  repositoryLeaseKeyForTask,
  taskLeaseKeyForTask,
  taskMatchesRepositoryProfile,
  taskMatchesTarget,
} from "./queueEligibility.js";
import { assertValidTaskStatusTransition } from "./status.js";
import type {
  AgentTaskContext,
  ClaimedTask,
  ClaimTaskInput,
  CommentInput,
  CreateTaskInput,
  LeaseHeartbeatInput,
  ReleaseLeaseInput,
  TaskActor,
  TaskDecision,
  TaskDecisionInput,
  TaskDependency,
  TaskDependencyInput,
  TaskEvent,
  TaskEventInput,
  TaskExternalRef,
  TaskExternalRefInput,
  TaskFieldOwner,
  TaskFieldOwnership,
  TaskPlan,
  TaskLeaseRecord,
  TaskRecord,
  TaskRevision,
  TaskRevisionInput,
  TaskStatus,
  TaskTrackerClient,
} from "./types.js";

export interface InMemoryTaskTrackerOptions {
  now?: () => Date;
}

const REQUIRED_EXECUTION_FIELDS = [
  "repositoryName",
  "repoPathKey",
  "baseBranch",
  "queue",
] as const;

type RequiredExecutionField = (typeof REQUIRED_EXECUTION_FIELDS)[number];

const clone = <T>(value: T): T => structuredClone(value);

const normalizeStringArray = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];

const externalRefKey = (provider: string, externalKey: string): string =>
  `${provider.trim().toLowerCase()}:${externalKey.trim().toLowerCase()}`;

const requireRevisionOwner = (owner: TaskFieldOwner): "human" | "external_source" => {
  assertOwnerCanUpdateFieldGroup(owner, "human_input");
  return owner === "external_source" ? "external_source" : "human";
};

const missingExecutionFields = (
  input: Pick<
    TaskRecord | CreateTaskInput,
    "repositoryName" | "repoPathKey" | "baseBranch" | "queue"
  >,
): string[] =>
  REQUIRED_EXECUTION_FIELDS.filter((field) => {
    const value = input[field as RequiredExecutionField];
    return typeof value !== "string" || value.trim() === "";
  });

const assertReadyFields = (
  input: Pick<
    TaskRecord | CreateTaskInput,
    "repositoryName" | "repoPathKey" | "baseBranch" | "queue"
  >,
): void => {
  const missing = missingExecutionFields(input);
  if (missing.length > 0) {
    throw new TaskReadinessError(missing);
  }
};

const initialStatusFor = (input: CreateTaskInput): TaskStatus =>
  missingExecutionFields(input).length === 0 ? "new" : "triage";

const createFieldOwnership = (
  owner: "human" | "external_source",
  createdAt: string,
): TaskFieldOwnership[] =>
  FIELD_OWNERSHIP_RULES.map((rule) => ({
    group: rule.group,
    owner: rule.group === "human_input" ? owner : rule.owner,
    fields: [...rule.owns],
    updatedAt: createdAt,
  }));

const createImplicitPlan = (taskId: string, createdAt: string): TaskPlan => ({
  id: `plan_${randomUUID()}`,
  taskId,
  status: "active",
  schemaVersion: 1,
  steps: [],
  createdAt,
  updatedAt: createdAt,
});

const createExternalRefs = (
  taskId: string,
  refs: readonly TaskExternalRefInput[],
  createdAt: string,
): TaskExternalRef[] =>
  refs.map((ref) => ({
    id: `xref_${randomUUID()}`,
    taskId,
    provider: ref.provider,
    externalKey: ref.externalKey,
    ...(ref.externalUrl ? { externalUrl: ref.externalUrl } : {}),
    ...(ref.businessStatus ? { businessStatus: ref.businessStatus } : {}),
    ...(ref.lastSeenAt ? { lastSeenAt: ref.lastSeenAt } : {}),
    createdAt,
  }));

const createInitialRevision = (
  task: Pick<
    TaskRecord,
    | "id"
    | "title"
    | "description"
    | "humanSummary"
    | "acceptanceCriteria"
    | "constraints"
    | "riskFactors"
    | "missingContext"
  >,
  owner: "human" | "external_source",
  author: TaskActor,
  createdAt: string,
  input: Pick<CreateTaskInput, "externalSnapshot" | "externalRevisionId">,
): TaskRevision => ({
  id: `rev_${randomUUID()}`,
  taskId: task.id,
  revisionNumber: 1,
  owner,
  author,
  title: task.title,
  description: task.description,
  ...(task.humanSummary ? { humanSummary: task.humanSummary } : {}),
  acceptanceCriteria: [...task.acceptanceCriteria],
  constraints: [...task.constraints],
  riskFactors: [...task.riskFactors],
  missingContext: [...task.missingContext],
  ...(input.externalSnapshot ? { externalSnapshot: clone(input.externalSnapshot) } : {}),
  ...(input.externalRevisionId ? { externalRevisionId: input.externalRevisionId } : {}),
  createdAt,
});

export class InMemoryTaskTrackerClient implements TaskTrackerClient {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly externalRefIndex = new Map<string, string>();
  private readonly leases = new Map<string, TaskLeaseRecord>();
  private readonly claimIdempotency = new Map<string, ClaimedTask | null>();
  private readonly heartbeatIdempotency = new Map<string, TaskLeaseRecord>();
  private readonly releaseIdempotency = new Set<string>();
  private readonly now: () => Date;

  constructor(options: InMemoryTaskTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const createdAt = input.createdAt ?? this.nowIso();
    const taskId = input.id ?? `task_${randomUUID()}`;
    const revisionOwner = requireRevisionOwner(input.createdBy.owner);
    const requestedStatus = input.status ?? initialStatusFor(input);

    if (this.tasks.has(taskId)) {
      throw new Error(`Task ${taskId} already exists.`);
    }
    if (!["new", "triage", "ready"].includes(requestedStatus)) {
      throw new Error(`Task cannot be created directly in ${requestedStatus} status.`);
    }
    if (requestedStatus === "ready") {
      assertReadyFields(input);
    }

    this.assertExternalRefsAvailable(input.externalRefs ?? []);

    const source =
      input.source ??
      (input.externalRefs?.[0]
        ? {
            kind: "external" as const,
            provider: input.externalRefs[0].provider,
            externalKey: input.externalRefs[0].externalKey,
          }
        : { kind: "native" as const });

    const task: TaskRecord = {
      id: taskId,
      title: input.title,
      description: input.description,
      ...(input.humanSummary ? { humanSummary: input.humanSummary } : {}),
      source,
      createdBy: clone(input.createdBy),
      ...(input.repositoryName ? { repositoryName: input.repositoryName } : {}),
      ...(input.repoPathKey ? { repoPathKey: input.repoPathKey } : {}),
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      ...(input.queue ? { queue: input.queue } : {}),
      tags: normalizeStringArray(input.tags),
      components: normalizeStringArray(input.components),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.deadline ? { deadline: input.deadline } : {}),
      status: requestedStatus,
      ...(input.businessStatus ? { businessStatus: input.businessStatus } : {}),
      taskType: input.taskType ?? "unknown",
      ...(input.promptProfileId ? { promptProfileId: input.promptProfileId } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      acceptanceCriteria: normalizeStringArray(input.acceptanceCriteria),
      constraints: normalizeStringArray(input.constraints),
      riskFactors: normalizeStringArray(input.riskFactors),
      missingContext: normalizeStringArray(input.missingContext),
      externalRefs: createExternalRefs(taskId, input.externalRefs ?? [], createdAt),
      fieldOwners: createFieldOwnership(revisionOwner, createdAt),
      revisions: [],
      events: [],
      comments: [],
      decisions: [],
      plans: [createImplicitPlan(taskId, createdAt)],
      dependencies: [],
      artifacts: [],
      createdAt,
      updatedAt: createdAt,
      ...(input.lastSyncedAt ? { lastSyncedAt: input.lastSyncedAt } : {}),
    };

    task.revisions.push(
      createInitialRevision(task, revisionOwner, input.createdBy, createdAt, input),
    );
    task.events.push({
      id: `evt_${randomUUID()}`,
      taskId,
      kind: "task_created",
      source: input.createdBy.owner,
      actor: clone(input.createdBy),
      message: `Task created in ${requestedStatus} status.`,
      createdAt,
    });

    for (const ref of task.externalRefs) {
      this.externalRefIndex.set(externalRefKey(ref.provider, ref.externalKey), task.id);
    }
    this.tasks.set(task.id, task);

    return clone(task);
  }

  async updateTaskRevision(
    taskId: string,
    input: TaskRevisionInput,
  ): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    const createdAt = this.nowIso();
    const revisionOwner = requireRevisionOwner(input.owner);
    const previous = task.revisions.at(-1);

    if (!previous) {
      throw new Error(`Task ${taskId} has no previous revision.`);
    }

    const revision: TaskRevision = {
      id: `rev_${randomUUID()}`,
      taskId,
      revisionNumber: previous.revisionNumber + 1,
      owner: revisionOwner,
      author: clone(input.author),
      title: input.title ?? task.title,
      description: input.description ?? task.description,
      ...(input.humanSummary ?? task.humanSummary
        ? { humanSummary: input.humanSummary ?? task.humanSummary }
        : {}),
      acceptanceCriteria: normalizeStringArray(
        input.acceptanceCriteria ?? task.acceptanceCriteria,
      ),
      constraints: normalizeStringArray(input.constraints ?? task.constraints),
      riskFactors: normalizeStringArray(input.riskFactors ?? task.riskFactors),
      missingContext: normalizeStringArray(input.missingContext ?? task.missingContext),
      ...(input.externalSnapshot ? { externalSnapshot: clone(input.externalSnapshot) } : {}),
      ...(input.externalRevisionId ? { externalRevisionId: input.externalRevisionId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt,
    };

    task.title = revision.title;
    task.description = revision.description;
    task.humanSummary = revision.humanSummary;
    task.acceptanceCriteria = [...revision.acceptanceCriteria];
    task.constraints = [...revision.constraints];
    task.riskFactors = [...revision.riskFactors];
    task.missingContext = [...revision.missingContext];
    task.revisions.push(revision);
    task.fieldOwners = task.fieldOwners.map((ownership) =>
      ownership.group === "human_input"
        ? { ...ownership, owner: revisionOwner, updatedAt: createdAt }
        : ownership,
    );
    task.updatedAt = createdAt;
    task.events.push({
      id: `evt_${randomUUID()}`,
      taskId,
      kind: "task_revision_created",
      source: input.owner,
      actor: clone(input.author),
      message:
        input.owner === "external_source"
          ? "External source update recorded as a task revision."
          : "Task revision recorded.",
      payload: { revisionNumber: revision.revisionNumber },
      createdAt,
    });

    return clone(task);
  }

  async markReady(taskId: string, reason?: string): Promise<void> {
    const task = this.requireTask(taskId);
    assertReadyFields(task);
    await this.setStatus(taskId, "ready", reason ?? "Task marked ready.");
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    return clone(this.requireTask(taskId));
  }

  async getAgentTaskContext(taskId: string): Promise<AgentTaskContext> {
    return buildAgentTaskContext(this.requireTask(taskId));
  }

  async appendEvent(taskId: string, input: TaskEventInput): Promise<void> {
    const task = this.requireTask(taskId);
    const createdAt = input.createdAt ?? this.nowIso();
    const event: TaskEvent = {
      id: `evt_${randomUUID()}`,
      taskId,
      kind: input.kind,
      source: input.source,
      ...(input.actor ? { actor: clone(input.actor) } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.payload ? { payload: clone(input.payload) } : {}),
      createdAt,
    };

    task.events.push(event);
    task.updatedAt = createdAt;
  }

  async appendComment(taskId: string, input: CommentInput): Promise<void> {
    const task = this.requireTask(taskId);
    const createdAt = input.createdAt ?? this.nowIso();
    task.comments.push({
      id: `comment_${randomUUID()}`,
      taskId,
      kind: input.kind,
      author: clone(input.author),
      ...(input.body ? { body: input.body } : {}),
      ...(input.payload ? { payload: clone(input.payload) } : {}),
      ...(input.externalRef ? { externalRef: clone(input.externalRef) } : {}),
      createdAt,
    });
    task.events.push({
      id: `evt_${randomUUID()}`,
      taskId,
      kind: "task_comment_created",
      source: input.author.owner,
      actor: clone(input.author),
      payload: { messageKind: input.kind },
      createdAt,
    });
    task.updatedAt = createdAt;
  }

  async setStatus(taskId: string, status: TaskStatus, reason?: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (task.status === status) {
      return;
    }

    assertValidTaskStatusTransition(task.status, status);
    const previousStatus = task.status;
    const createdAt = this.nowIso();
    task.status = status;
    task.updatedAt = createdAt;
    task.events.push({
      id: `evt_${randomUUID()}`,
      taskId,
      kind: "task_status_changed",
      source: "worker_agent",
      message: reason ?? `Task status changed from ${previousStatus} to ${status}.`,
      payload: { from: previousStatus, to: status },
      createdAt,
    });
  }

  async recordDecision(
    taskId: string,
    input: TaskDecisionInput,
  ): Promise<TaskDecision> {
    const task = this.requireTask(taskId);
    const createdAt = input.createdAt ?? this.nowIso();
    const decision: TaskDecision = {
      id: `decision_${randomUUID()}`,
      taskId,
      kind: input.kind,
      schemaVersion: input.schemaVersion,
      source: input.source,
      ...(input.authorId ? { authorId: input.authorId } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
      payload: clone(input.payload),
      createdAt,
    };

    task.decisions.push(decision);
    task.updatedAt = createdAt;
    return clone(decision);
  }

  async addDependency(input: TaskDependencyInput): Promise<TaskDependency> {
    const fromTask = this.requireTask(input.fromTaskId);
    const toTask = this.requireTask(input.toTaskId);
    const createdAt = input.createdAt ?? this.nowIso();
    const dependency: TaskDependency = {
      id: `dep_${randomUUID()}`,
      fromTaskId: input.fromTaskId,
      toTaskId: input.toTaskId,
      kind: input.kind,
      ...(input.reason ? { reason: input.reason } : {}),
      status: input.status ?? "active",
      createdAt,
      ...(input.resolvedAt ? { resolvedAt: input.resolvedAt } : {}),
    };

    fromTask.dependencies.push(dependency);
    if (toTask.id !== fromTask.id) {
      toTask.dependencies.push(dependency);
    }
    fromTask.updatedAt = createdAt;
    toTask.updatedAt = createdAt;

    return clone(dependency);
  }

  async claimNextTask(input: ClaimTaskInput): Promise<ClaimedTask | null> {
    this.assertClaimInput(input);
    if (input.idempotencyKey && this.claimIdempotency.has(input.idempotencyKey)) {
      return clone(this.claimIdempotency.get(input.idempotencyKey) ?? null);
    }

    const now = this.now();
    const candidates = [...this.tasks.values()]
      .filter((task) => this.isEligibleClaimCandidate(task, input, now))
      .sort(compareTasksForClaim(now));
    const task = candidates[0];

    if (!task) {
      if (input.idempotencyKey) {
        this.claimIdempotency.set(input.idempotencyKey, null);
      }
      return null;
    }

    const timestamp = now.toISOString();
    const repositoryName = task.repositoryName;
    if (!repositoryName) {
      throw new Error(`Task ${task.id} has no repositoryName.`);
    }

    const taskLease = this.createLeaseRecord("task", taskLeaseKeyForTask(task.id), task, input, now);
    const repositoryLease = this.createLeaseRecord(
      "repository",
      repositoryLeaseKeyForTask(task),
      task,
      input,
      now,
    );

    this.leases.set(taskLease.leaseId, taskLease);
    this.leases.set(repositoryLease.leaseId, repositoryLease);
    task.status = "claimed";
    task.updatedAt = timestamp;
    task.events.push({
      id: `evt_${randomUUID()}`,
      taskId: task.id,
      kind: "task_claimed",
      source: "worker_agent",
      actor: {
        owner: "worker_agent",
        id: input.workerId,
      },
      payload: {
        taskLeaseId: taskLease.leaseId,
        repositoryLeaseId: repositoryLease.leaseId,
        repositoryLeaseKey: repositoryLease.leaseKey,
      },
      createdAt: timestamp,
    });

    const claimed: ClaimedTask = {
      task: clone(task),
      agentContext: buildAgentTaskContext(task),
      taskLease: clone(taskLease),
      repositoryLease: clone(repositoryLease),
    };

    if (input.idempotencyKey) {
      this.claimIdempotency.set(input.idempotencyKey, clone(claimed));
    }

    return clone(claimed);
  }

  async heartbeatLease(
    leaseId: string,
    input: LeaseHeartbeatInput,
  ): Promise<TaskLeaseRecord> {
    this.assertPositiveTtl(input.leaseTtlSeconds);
    const idempotencyKey = input.idempotencyKey
      ? `${leaseId}:${input.idempotencyKey}`
      : undefined;
    if (idempotencyKey && this.heartbeatIdempotency.has(idempotencyKey)) {
      return clone(this.heartbeatIdempotency.get(idempotencyKey) as TaskLeaseRecord);
    }

    const lease = this.requireLease(leaseId);
    this.assertLeaseOwner(lease, input.workerId, input.token);
    const now = this.now();
    if (!isLeaseActiveAt(lease, now)) {
      throw new LeaseExpiredError(leaseId);
    }

    lease.heartbeatAt = now.toISOString();
    lease.expiresAt = this.expiresAt(now, input.leaseTtlSeconds);
    const result = clone(lease);

    if (idempotencyKey) {
      this.heartbeatIdempotency.set(idempotencyKey, result);
    }

    return clone(result);
  }

  async releaseLease(leaseId: string, input: ReleaseLeaseInput): Promise<void> {
    const idempotencyKey = input.idempotencyKey
      ? `${leaseId}:${input.idempotencyKey}`
      : undefined;
    if (idempotencyKey && this.releaseIdempotency.has(idempotencyKey)) {
      return;
    }

    const lease = this.requireLease(leaseId);
    this.assertLeaseOwner(lease, input.workerId, input.token);

    if (!lease.releasedAt) {
      const now = this.now().toISOString();
      lease.releasedAt = now;
      lease.heartbeatAt = now;
      lease.expiresAt = now;
    }

    if (idempotencyKey) {
      this.releaseIdempotency.add(idempotencyKey);
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    return task;
  }

  private assertExternalRefsAvailable(refs: readonly TaskExternalRefInput[]): void {
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = externalRefKey(ref.provider, ref.externalKey);
      if (seen.has(key) || this.externalRefIndex.has(key)) {
        throw new DuplicateExternalRefError(ref.provider, ref.externalKey);
      }
      seen.add(key);
    }
  }

  private isEligibleClaimCandidate(
    task: TaskRecord,
    input: ClaimTaskInput,
    now: Date,
  ): boolean {
    if (task.status !== "ready" && task.status !== "claimed") {
      return false;
    }
    if (!task.repositoryName || !task.repoPathKey) {
      return false;
    }
    if (!taskMatchesRepositoryProfile(task, input.repositoryProfiles)) {
      return false;
    }
    if (!taskMatchesTarget(task, input.targetExternalKey)) {
      return false;
    }

    const dependencies = this.allDependencies();
    if (activeBlockingDependenciesForTask(task.id, dependencies).length > 0) {
      return false;
    }

    const activeLeases = [...this.leases.values()].filter((lease) =>
      isLeaseActiveAt(lease, now),
    );
    const taskLeaseKey = taskLeaseKeyForTask(task.id);
    if (
      activeLeases.some(
        (lease) => lease.kind === "task" && lease.leaseKey === taskLeaseKey,
      )
    ) {
      return false;
    }

    const repositoryLeaseKey = repositoryLeaseKeyForTask(task);
    return !activeLeases.some(
      (lease) => lease.kind === "repository" && lease.leaseKey === repositoryLeaseKey,
    );
  }

  private allDependencies(): TaskDependency[] {
    const dependencies = new Map<string, TaskDependency>();
    for (const task of this.tasks.values()) {
      for (const dependency of task.dependencies) {
        dependencies.set(dependency.id, dependency);
      }
    }

    return [...dependencies.values()];
  }

  private createLeaseRecord(
    kind: "task" | "repository",
    leaseKey: string,
    task: TaskRecord,
    input: ClaimTaskInput,
    now: Date,
  ): TaskLeaseRecord {
    if (!task.repositoryName) {
      throw new Error(`Task ${task.id} has no repositoryName.`);
    }

    const timestamp = now.toISOString();
    return {
      leaseId: `lease_${randomUUID()}`,
      kind,
      leaseKey,
      taskId: task.id,
      repositoryName: task.repositoryName,
      workerId: input.workerId,
      token: `lease-token-${randomUUID()}`,
      expiresAt: this.expiresAt(now, input.leaseTtlSeconds),
      heartbeatAt: timestamp,
    };
  }

  private expiresAt(now: Date, leaseTtlSeconds: number): string {
    return new Date(now.getTime() + leaseTtlSeconds * 1000).toISOString();
  }

  private requireLease(leaseId: string): TaskLeaseRecord {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      throw new LeaseNotFoundError(leaseId);
    }

    return lease;
  }

  private assertLeaseOwner(
    lease: TaskLeaseRecord,
    workerId: string,
    token: string,
  ): void {
    if (lease.workerId !== workerId || lease.token !== token) {
      throw new LeaseOwnershipError(lease.leaseId);
    }
  }

  private assertClaimInput(input: ClaimTaskInput): void {
    if (!input.workerId.trim()) {
      throw new Error("workerId is required to claim a task.");
    }
    if (input.repositoryProfiles.length === 0) {
      throw new Error("At least one repository profile is required to claim a task.");
    }
    this.assertPositiveTtl(input.leaseTtlSeconds);
  }

  private assertPositiveTtl(leaseTtlSeconds: number): void {
    if (!Number.isFinite(leaseTtlSeconds) || leaseTtlSeconds <= 0) {
      throw new Error("leaseTtlSeconds must be a positive number.");
    }
  }
}
