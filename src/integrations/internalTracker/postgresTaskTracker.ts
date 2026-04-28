import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";

import { buildAgentTaskContext } from "../../domain/taskTracker/agentContext.js";
import {
  FIELD_OWNERSHIP_RULES,
  assertOwnerCanUpdateFieldGroup,
} from "../../domain/taskTracker/fieldOwnership.js";
import {
  activeBlockingDependenciesForTask,
  isLeaseActiveAt,
  repositoryLeaseKeyForTask,
  taskLeaseKeyForTask,
} from "../../domain/taskTracker/queueEligibility.js";
import { assertValidTaskStatusTransition } from "../../domain/taskTracker/status.js";
import {
  DuplicateExternalRefError,
  LeaseExpiredError,
  LeaseNotFoundError,
  LeaseOwnershipError,
  TaskNotFoundError,
  TaskReadinessError,
} from "../../domain/taskTracker/errors.js";
import type {
  AgentTaskContext,
  ArtifactRef,
  ClaimedTask,
  ClaimRepositoryProfile,
  ClaimTaskInput,
  CommentInput,
  CreateTaskInput,
  LeaseHeartbeatInput,
  ReleaseLeaseInput,
  TaskActor,
  TaskComment,
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
  TaskRecord,
  TaskRevision,
  TaskRevisionInput,
  TaskStatus,
  TaskStep,
  TaskTrackerClient,
  TaskLeaseRecord,
} from "../../domain/taskTracker/types.js";

export interface PostgresQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresQueryable & { release(): void }>;
}

export interface PostgresTaskTrackerOptions {
  now?: () => Date;
}

type TransactionClient = PostgresQueryable & { release?: () => void };

type TaskRow = QueryResultRow & {
  id: string;
  title: string;
  description: string;
  human_summary: string | null;
  source: unknown;
  created_by: unknown;
  repository_name: string | null;
  repo_path_key: string | null;
  base_branch: string | null;
  queue: string | null;
  tags: string[];
  components: string[];
  priority: string | null;
  deadline: Date | string | null;
  status: TaskStatus;
  business_status: string | null;
  task_type: TaskRecord["taskType"];
  prompt_profile_id: string | null;
  confidence: number | null;
  acceptance_criteria: string[];
  constraints: string[];
  risk_factors: string[];
  missing_context: string[];
  field_owners: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  last_synced_at: Date | string | null;
};

type TaskLeaseRow = QueryResultRow & {
  lease_id: string;
  kind: "task" | "repository";
  lease_key: string;
  task_id: string;
  repository_name: string;
  worker_id: string;
  token: string;
  expires_at: Date | string;
  heartbeat_at: Date | string;
  released_at: Date | string | null;
};

const clone = <T>(value: T): T => structuredClone(value);

const isPoolLike = (value: PostgresQueryable): value is PostgresPoolLike =>
  typeof (value as { connect?: unknown }).connect === "function";

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

const optionalIso = (value: Date | string | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : toIso(value);

const normalizeStringArray = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];

const externalRefKey = (provider: string, externalKey: string): string =>
  `${provider.trim().toLowerCase()}:${externalKey.trim().toLowerCase()}`;

const REQUIRED_EXECUTION_FIELDS = [
  "repositoryName",
  "repoPathKey",
  "baseBranch",
  "queue",
] as const;

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
    const value = input[field];
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
  author: clone(author),
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

const mapLeaseRow = (row: TaskLeaseRow): TaskLeaseRecord => ({
  leaseId: row.lease_id,
  kind: row.kind,
  leaseKey: row.lease_key,
  taskId: row.task_id,
  repositoryName: row.repository_name,
  workerId: row.worker_id,
  token: row.token,
  expiresAt: toIso(row.expires_at),
  heartbeatAt: toIso(row.heartbeat_at),
  ...(row.released_at ? { releasedAt: toIso(row.released_at) } : {}),
});

const buildRepositoryProfileWhere = (
  profiles: readonly ClaimRepositoryProfile[],
  addParam: (value: unknown) => string,
): string => {
  const clauses = profiles.map((profile) => {
    const parts = [`t.repository_name = ${addParam(profile.name)}`];
    if (profile.repoPathKey) {
      parts.push(`t.repo_path_key = ${addParam(profile.repoPathKey)}`);
    }
    if (profile.queues && profile.queues.length > 0) {
      parts.push(`t.queue = ANY(${addParam(profile.queues)}::text[])`);
    }

    return `(${parts.join(" AND ")})`;
  });

  return clauses.join(" OR ");
};

export class PostgresTaskTrackerClient implements TaskTrackerClient {
  private readonly now: () => Date;

  constructor(
    private readonly db: PostgresQueryable,
    options: PostgresTaskTrackerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const task = this.createTaskRecord(input);
    await this.withTransaction(async (client) => {
      await this.assertExternalRefsAvailable(client, task.externalRefs);
      await this.insertTaskRecord(client, task);
    });

    return clone(task);
  }

  async updateTaskRevision(
    taskId: string,
    input: TaskRevisionInput,
  ): Promise<TaskRecord> {
    return this.withTransaction(async (client) => {
      const task = await this.getTaskUsing(client, taskId);
      const previous = task.revisions.at(-1);
      if (!previous) {
        throw new Error(`Task ${taskId} has no previous revision.`);
      }

      const createdAt = this.nowIso();
      const revisionOwner = requireRevisionOwner(input.owner);
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
        ...(input.externalSnapshot
          ? { externalSnapshot: clone(input.externalSnapshot) }
          : {}),
        ...(input.externalRevisionId
          ? { externalRevisionId: input.externalRevisionId }
          : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        createdAt,
      };

      const fieldOwners = task.fieldOwners.map((ownership) =>
        ownership.group === "human_input"
          ? { ...ownership, owner: revisionOwner, updatedAt: createdAt }
          : ownership,
      );

      await client.query(
        `
          UPDATE tasks
          SET title = $2,
              description = $3,
              human_summary = $4,
              acceptance_criteria = $5,
              constraints = $6,
              risk_factors = $7,
              missing_context = $8,
              field_owners = $9::jsonb,
              updated_at = $10
          WHERE id = $1
        `,
        [
          taskId,
          revision.title,
          revision.description,
          revision.humanSummary ?? null,
          revision.acceptanceCriteria,
          revision.constraints,
          revision.riskFactors,
          revision.missingContext,
          JSON.stringify(fieldOwners),
          createdAt,
        ],
      );
      await this.insertRevision(client, revision);
      await this.insertEvent(client, {
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

      return this.getTaskUsing(client, taskId);
    });
  }

  async markReady(taskId: string, reason?: string): Promise<void> {
    const task = await this.getTask(taskId);
    assertReadyFields(task);
    await this.setStatus(taskId, "ready", reason ?? "Task marked ready.");
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    return this.getTaskUsing(this.db, taskId);
  }

  async getAgentTaskContext(taskId: string): Promise<AgentTaskContext> {
    return buildAgentTaskContext(await this.getTask(taskId));
  }

  async appendEvent(taskId: string, input: TaskEventInput): Promise<void> {
    const createdAt = input.createdAt ?? this.nowIso();
    await this.withTransaction(async (client) => {
      await this.ensureTaskExists(client, taskId);
      await this.insertEvent(client, {
        id: `evt_${randomUUID()}`,
        taskId,
        kind: input.kind,
        source: input.source,
        ...(input.actor ? { actor: clone(input.actor) } : {}),
        ...(input.message ? { message: input.message } : {}),
        ...(input.payload ? { payload: clone(input.payload) } : {}),
        createdAt,
      });
      await this.touchTask(client, taskId, createdAt);
    });
  }

  async appendComment(taskId: string, input: CommentInput): Promise<void> {
    const createdAt = input.createdAt ?? this.nowIso();
    await this.withTransaction(async (client) => {
      await this.ensureTaskExists(client, taskId);
      await client.query(
        `
          INSERT INTO task_comments (
            id, task_id, kind, author, body, payload, external_ref, created_at
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8)
        `,
        [
          `comment_${randomUUID()}`,
          taskId,
          input.kind,
          JSON.stringify(input.author),
          input.body ?? null,
          input.payload ? JSON.stringify(input.payload) : null,
          input.externalRef ? JSON.stringify(input.externalRef) : null,
          createdAt,
        ],
      );
      await this.insertEvent(client, {
        id: `evt_${randomUUID()}`,
        taskId,
        kind: "task_comment_created",
        source: input.author.owner,
        actor: clone(input.author),
        payload: { messageKind: input.kind },
        createdAt,
      });
      await this.touchTask(client, taskId, createdAt);
    });
  }

  async setStatus(taskId: string, status: TaskStatus, reason?: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const result = await client.query<{ status: TaskStatus }>(
        "SELECT status FROM tasks WHERE id = $1 FOR UPDATE",
        [taskId],
      );
      const current = result.rows[0]?.status;
      if (!current) {
        throw new TaskNotFoundError(taskId);
      }
      if (current === status) {
        return;
      }

      assertValidTaskStatusTransition(current, status);
      const createdAt = this.nowIso();
      await client.query("UPDATE tasks SET status = $2, updated_at = $3 WHERE id = $1", [
        taskId,
        status,
        createdAt,
      ]);
      await this.insertEvent(client, {
        id: `evt_${randomUUID()}`,
        taskId,
        kind: "task_status_changed",
        source: "worker_agent",
        message: reason ?? `Task status changed from ${current} to ${status}.`,
        payload: { from: current, to: status },
        createdAt,
      });
    });
  }

  async addDependency(input: TaskDependencyInput): Promise<TaskDependency> {
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

    await this.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO task_dependencies (
            id, from_task_id, to_task_id, kind, reason, status, created_at, resolved_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          dependency.id,
          dependency.fromTaskId,
          dependency.toTaskId,
          dependency.kind,
          dependency.reason ?? null,
          dependency.status,
          dependency.createdAt,
          dependency.resolvedAt ?? null,
        ],
      );
      await this.touchTask(client, input.fromTaskId, createdAt);
      await this.touchTask(client, input.toTaskId, createdAt);
    });

    return clone(dependency);
  }

  async claimNextTask(input: ClaimTaskInput): Promise<ClaimedTask | null> {
    this.assertClaimInput(input);
    const now = this.now();
    const nowIso = now.toISOString();

    return this.withTransaction(async (client) => {
      if (input.idempotencyKey) {
        const existing = await this.findIdempotency<ClaimedTask | null>(
          client,
          "claimNextTask",
          input.idempotencyKey,
        );
        if (existing.found) {
          return clone(existing.response);
        }
      }

      await client.query(
        `
          UPDATE task_leases
          SET released_at = $1
          WHERE released_at IS NULL AND expires_at <= $1
        `,
        [nowIso],
      );

      const candidateId = await this.selectClaimCandidate(client, input, nowIso);
      if (!candidateId) {
        if (input.idempotencyKey) {
          await this.storeIdempotency(
            client,
            "claimNextTask",
            input.idempotencyKey,
            null,
          );
        }
        return null;
      }

      const task = await this.getTaskUsing(client, candidateId);
      if (activeBlockingDependenciesForTask(task.id, task.dependencies).length > 0) {
        if (input.idempotencyKey) {
          await this.storeIdempotency(
            client,
            "claimNextTask",
            input.idempotencyKey,
            null,
          );
        }
        return null;
      }

      const taskLease = this.createLeaseRecord(
        "task",
        taskLeaseKeyForTask(task.id),
        task,
        input.workerId,
        now,
        input.leaseTtlSeconds,
      );
      const repositoryLease = this.createLeaseRecord(
        "repository",
        repositoryLeaseKeyForTask(task),
        task,
        input.workerId,
        now,
        input.leaseTtlSeconds,
      );

      const repositoryInserted = await this.insertLeaseIfAvailable(
        client,
        repositoryLease,
      );
      if (!repositoryInserted) {
        if (input.idempotencyKey) {
          await this.storeIdempotency(
            client,
            "claimNextTask",
            input.idempotencyKey,
            null,
          );
        }
        return null;
      }

      const taskInserted = await this.insertLeaseIfAvailable(client, taskLease);
      if (!taskInserted) {
        await client.query("DELETE FROM task_leases WHERE lease_id = $1", [
          repositoryLease.leaseId,
        ]);
        if (input.idempotencyKey) {
          await this.storeIdempotency(
            client,
            "claimNextTask",
            input.idempotencyKey,
            null,
          );
        }
        return null;
      }

      await client.query("UPDATE tasks SET status = 'claimed', updated_at = $2 WHERE id = $1", [
        task.id,
        nowIso,
      ]);
      await this.insertEvent(client, {
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
        createdAt: nowIso,
      });

      const claimedTask = await this.getTaskUsing(client, task.id);
      const claimed: ClaimedTask = {
        task: claimedTask,
        agentContext: buildAgentTaskContext(claimedTask),
        taskLease,
        repositoryLease,
      };

      if (input.idempotencyKey) {
        await this.storeIdempotency(
          client,
          "claimNextTask",
          input.idempotencyKey,
          claimed,
        );
      }

      return clone(claimed);
    });
  }

  async heartbeatLease(
    leaseId: string,
    input: LeaseHeartbeatInput,
  ): Promise<TaskLeaseRecord> {
    this.assertPositiveTtl(input.leaseTtlSeconds);
    const operation = `heartbeatLease:${leaseId}`;

    return this.withTransaction(async (client) => {
      if (input.idempotencyKey) {
        const existing = await this.findIdempotency<TaskLeaseRecord>(
          client,
          operation,
          input.idempotencyKey,
        );
        if (existing.found) {
          return clone(existing.response as TaskLeaseRecord);
        }
      }

      const lease = await this.requireLeaseForUpdate(client, leaseId);
      this.assertLeaseOwner(lease, input.workerId, input.token);
      const now = this.now();
      if (!isLeaseActiveAt(lease, now)) {
        throw new LeaseExpiredError(leaseId);
      }

      const updated = await client.query<TaskLeaseRow>(
        `
          UPDATE task_leases
          SET heartbeat_at = $2,
              expires_at = $3
          WHERE lease_id = $1
          RETURNING *
        `,
        [
          leaseId,
          now.toISOString(),
          new Date(now.getTime() + input.leaseTtlSeconds * 1000).toISOString(),
        ],
      );
      const result = mapLeaseRow(updated.rows[0] as TaskLeaseRow);

      if (input.idempotencyKey) {
        await this.storeIdempotency(client, operation, input.idempotencyKey, result);
      }

      return clone(result);
    });
  }

  async releaseLease(leaseId: string, input: ReleaseLeaseInput): Promise<void> {
    const operation = `releaseLease:${leaseId}`;
    await this.withTransaction(async (client) => {
      if (input.idempotencyKey) {
        const existing = await this.findIdempotency<null>(
          client,
          operation,
          input.idempotencyKey,
        );
        if (existing.found) {
          return;
        }
      }

      const lease = await this.requireLeaseForUpdate(client, leaseId);
      this.assertLeaseOwner(lease, input.workerId, input.token);

      if (!lease.releasedAt) {
        const now = this.nowIso();
        await client.query(
          `
            UPDATE task_leases
            SET released_at = $2,
                heartbeat_at = $2,
                expires_at = $2
            WHERE lease_id = $1
          `,
          [leaseId, now],
        );
      }

      if (input.idempotencyKey) {
        await this.storeIdempotency(client, operation, input.idempotencyKey, null);
      }
    });
  }

  private async withTransaction<T>(
    callback: (client: PostgresQueryable) => Promise<T>,
  ): Promise<T> {
    const client: TransactionClient = isPoolLike(this.db)
      ? await this.db.connect()
      : this.db;
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  private createTaskRecord(input: CreateTaskInput): TaskRecord {
    const createdAt = input.createdAt ?? this.nowIso();
    const taskId = input.id ?? `task_${randomUUID()}`;
    const revisionOwner = requireRevisionOwner(input.createdBy.owner);
    const requestedStatus = input.status ?? initialStatusFor(input);

    if (!["new", "triage", "ready"].includes(requestedStatus)) {
      throw new Error(`Task cannot be created directly in ${requestedStatus} status.`);
    }
    if (requestedStatus === "ready") {
      assertReadyFields(input);
    }

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

    return task;
  }

  private async insertTaskRecord(
    client: PostgresQueryable,
    task: TaskRecord,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO tasks (
          id, title, description, human_summary, source, created_by,
          repository_name, repo_path_key, base_branch, queue, tags, components,
          priority, deadline, status, business_status, task_type,
          prompt_profile_id, confidence, acceptance_criteria, constraints,
          risk_factors, missing_context, field_owners, created_at, updated_at,
          last_synced_at
        )
        VALUES (
          $1, $2, $3, $4, $5::jsonb, $6::jsonb,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24::jsonb, $25, $26,
          $27
        )
      `,
      [
        task.id,
        task.title,
        task.description,
        task.humanSummary ?? null,
        JSON.stringify(task.source),
        JSON.stringify(task.createdBy),
        task.repositoryName ?? null,
        task.repoPathKey ?? null,
        task.baseBranch ?? null,
        task.queue ?? null,
        task.tags,
        task.components,
        task.priority ?? null,
        task.deadline ?? null,
        task.status,
        task.businessStatus ?? null,
        task.taskType,
        task.promptProfileId ?? null,
        task.confidence ?? null,
        task.acceptanceCriteria,
        task.constraints,
        task.riskFactors,
        task.missingContext,
        JSON.stringify(task.fieldOwners),
        task.createdAt,
        task.updatedAt,
        task.lastSyncedAt ?? null,
      ],
    );

    for (const ref of task.externalRefs) {
      await this.insertExternalRef(client, ref);
    }
    for (const revision of task.revisions) {
      await this.insertRevision(client, revision);
    }
    for (const plan of task.plans) {
      await client.query(
        `
          INSERT INTO task_plans (
            id, task_id, status, schema_version, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          plan.id,
          plan.taskId,
          plan.status,
          plan.schemaVersion,
          plan.createdAt,
          plan.updatedAt,
        ],
      );
    }
    for (const event of task.events) {
      await this.insertEvent(client, event);
    }
  }

  private async insertExternalRef(
    client: PostgresQueryable,
    ref: TaskExternalRef,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO task_external_refs (
          id, task_id, provider, external_key, external_url, business_status,
          last_seen_at, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        ref.id,
        ref.taskId,
        ref.provider,
        ref.externalKey,
        ref.externalUrl ?? null,
        ref.businessStatus ?? null,
        ref.lastSeenAt ?? null,
        ref.createdAt,
      ],
    );
  }

  private async insertRevision(
    client: PostgresQueryable,
    revision: TaskRevision,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO task_revisions (
          id, task_id, revision_number, owner, author, title, description,
          human_summary, acceptance_criteria, constraints, risk_factors,
          missing_context, external_snapshot, external_revision_id, reason,
          created_at
        )
        VALUES (
          $1, $2, $3, $4, $5::jsonb, $6, $7,
          $8, $9, $10, $11,
          $12, $13::jsonb, $14, $15,
          $16
        )
      `,
      [
        revision.id,
        revision.taskId,
        revision.revisionNumber,
        revision.owner,
        JSON.stringify(revision.author),
        revision.title,
        revision.description,
        revision.humanSummary ?? null,
        revision.acceptanceCriteria,
        revision.constraints,
        revision.riskFactors,
        revision.missingContext,
        revision.externalSnapshot ? JSON.stringify(revision.externalSnapshot) : null,
        revision.externalRevisionId ?? null,
        revision.reason ?? null,
        revision.createdAt,
      ],
    );
  }

  private async insertEvent(client: PostgresQueryable, event: TaskEvent): Promise<void> {
    await client.query(
      `
        INSERT INTO task_events (
          id, task_id, kind, source, actor, message, payload, created_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
      `,
      [
        event.id,
        event.taskId,
        event.kind,
        event.source,
        event.actor ? JSON.stringify(event.actor) : null,
        event.message ?? null,
        event.payload ? JSON.stringify(event.payload) : null,
        event.createdAt,
      ],
    );
  }

  private async getTaskUsing(
    client: PostgresQueryable,
    taskId: string,
  ): Promise<TaskRecord> {
    const taskResult = await client.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [
      taskId,
    ]);
    const row = taskResult.rows[0];
    if (!row) {
      throw new TaskNotFoundError(taskId);
    }

    const [
      refs,
      revisions,
      events,
      comments,
      decisions,
      plans,
      steps,
      dependencies,
      artifacts,
      stepArtifacts,
    ] = await Promise.all([
      client.query("SELECT * FROM task_external_refs WHERE task_id = $1 ORDER BY created_at, id", [
        taskId,
      ]),
      client.query("SELECT * FROM task_revisions WHERE task_id = $1 ORDER BY revision_number", [
        taskId,
      ]),
      client.query("SELECT * FROM task_events WHERE task_id = $1 ORDER BY created_at, id", [
        taskId,
      ]),
      client.query("SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at, id", [
        taskId,
      ]),
      client.query("SELECT * FROM task_decisions WHERE task_id = $1 ORDER BY created_at, id", [
        taskId,
      ]),
      client.query("SELECT * FROM task_plans WHERE task_id = $1 ORDER BY created_at, id", [
        taskId,
      ]),
      client.query("SELECT * FROM task_steps WHERE task_id = $1 ORDER BY created_at, id", [
        taskId,
      ]),
      client.query(
        `
          SELECT *
          FROM task_dependencies
          WHERE from_task_id = $1 OR to_task_id = $1
          ORDER BY created_at, id
        `,
        [taskId],
      ),
      client.query("SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at, id", [
        taskId,
      ]),
      client.query(
        `
          SELECT step_id, artifact_id
          FROM task_step_artifacts
          WHERE artifact_id IN (SELECT id FROM artifacts WHERE task_id = $1)
        `,
        [taskId],
      ),
    ]);

    const artifactRecords = artifacts.rows.map((artifact) =>
      this.mapArtifact(artifact),
    );
    const artifactById = new Map(artifactRecords.map((artifact) => [artifact.id, artifact]));
    const artifactsByStepId = new Map<string, ArtifactRef[]>();
    for (const link of stepArtifacts.rows) {
      const artifact = artifactById.get(String(link.artifact_id));
      if (!artifact) {
        continue;
      }
      const bucket = artifactsByStepId.get(String(link.step_id)) ?? [];
      bucket.push(artifact);
      artifactsByStepId.set(String(link.step_id), bucket);
    }

    const stepsByPlanId = new Map<string, TaskStep[]>();
    for (const step of steps.rows) {
      const mapped = this.mapStep(step, artifactsByStepId.get(String(step.id)) ?? []);
      const bucket = stepsByPlanId.get(mapped.planId) ?? [];
      bucket.push(mapped);
      stepsByPlanId.set(mapped.planId, bucket);
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      ...(row.human_summary ? { humanSummary: row.human_summary } : {}),
      source: row.source as TaskRecord["source"],
      createdBy: row.created_by as TaskActor,
      ...(row.repository_name ? { repositoryName: row.repository_name } : {}),
      ...(row.repo_path_key ? { repoPathKey: row.repo_path_key } : {}),
      ...(row.base_branch ? { baseBranch: row.base_branch } : {}),
      ...(row.queue ? { queue: row.queue } : {}),
      tags: row.tags ?? [],
      components: row.components ?? [],
      ...(row.priority ? { priority: row.priority } : {}),
      ...(optionalIso(row.deadline) ? { deadline: optionalIso(row.deadline) } : {}),
      status: row.status,
      ...(row.business_status ? { businessStatus: row.business_status } : {}),
      taskType: row.task_type,
      ...(row.prompt_profile_id ? { promptProfileId: row.prompt_profile_id } : {}),
      ...(row.confidence !== null ? { confidence: row.confidence } : {}),
      acceptanceCriteria: row.acceptance_criteria ?? [],
      constraints: row.constraints ?? [],
      riskFactors: row.risk_factors ?? [],
      missingContext: row.missing_context ?? [],
      externalRefs: refs.rows.map((ref) => this.mapExternalRef(ref)),
      fieldOwners: row.field_owners as TaskFieldOwnership[],
      revisions: revisions.rows.map((revision) => this.mapRevision(revision)),
      events: events.rows.map((event) => this.mapEvent(event)),
      comments: comments.rows.map((comment) => this.mapComment(comment)),
      decisions: decisions.rows.map((decision) => this.mapDecision(decision)),
      plans: plans.rows.map((plan) => this.mapPlan(plan, stepsByPlanId)),
      dependencies: dependencies.rows.map((dependency) =>
        this.mapDependency(dependency),
      ),
      artifacts: artifactRecords,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      ...(optionalIso(row.last_synced_at)
        ? { lastSyncedAt: optionalIso(row.last_synced_at) }
        : {}),
    };
  }

  private mapExternalRef(row: QueryResultRow): TaskExternalRef {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      provider: String(row.provider),
      externalKey: String(row.external_key),
      ...(row.external_url ? { externalUrl: String(row.external_url) } : {}),
      ...(row.business_status ? { businessStatus: String(row.business_status) } : {}),
      ...(row.last_seen_at ? { lastSeenAt: toIso(row.last_seen_at) } : {}),
      createdAt: toIso(row.created_at),
    };
  }

  private mapRevision(row: QueryResultRow): TaskRevision {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      revisionNumber: Number(row.revision_number),
      owner: row.owner as "human" | "external_source",
      author: row.author as TaskActor,
      title: String(row.title),
      description: String(row.description),
      ...(row.human_summary ? { humanSummary: String(row.human_summary) } : {}),
      acceptanceCriteria: (row.acceptance_criteria as string[]) ?? [],
      constraints: (row.constraints as string[]) ?? [],
      riskFactors: (row.risk_factors as string[]) ?? [],
      missingContext: (row.missing_context as string[]) ?? [],
      ...(row.external_snapshot
        ? { externalSnapshot: row.external_snapshot as Record<string, unknown> }
        : {}),
      ...(row.external_revision_id
        ? { externalRevisionId: String(row.external_revision_id) }
        : {}),
      ...(row.reason ? { reason: String(row.reason) } : {}),
      createdAt: toIso(row.created_at),
    };
  }

  private mapEvent(row: QueryResultRow): TaskEvent {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      kind: String(row.kind),
      source: row.source as TaskFieldOwner,
      ...(row.actor ? { actor: row.actor as TaskActor } : {}),
      ...(row.message ? { message: String(row.message) } : {}),
      ...(row.payload ? { payload: row.payload as Record<string, unknown> } : {}),
      createdAt: toIso(row.created_at),
    };
  }

  private mapComment(row: QueryResultRow): TaskComment {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      kind: row.kind as TaskComment["kind"],
      author: row.author as TaskActor,
      ...(row.body ? { body: String(row.body) } : {}),
      ...(row.payload ? { payload: row.payload as Record<string, unknown> } : {}),
      ...(row.external_ref
        ? { externalRef: row.external_ref as TaskComment["externalRef"] }
        : {}),
      createdAt: toIso(row.created_at),
    };
  }

  private mapDecision(row: QueryResultRow): TaskDecision {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      kind: row.kind as TaskDecision["kind"],
      schemaVersion: Number(row.schema_version),
      source: row.source as TaskFieldOwner,
      ...(row.author_id ? { authorId: String(row.author_id) } : {}),
      ...(row.worker_id ? { workerId: String(row.worker_id) } : {}),
      payload: row.payload as Record<string, unknown>,
      createdAt: toIso(row.created_at),
    };
  }

  private mapPlan(
    row: QueryResultRow,
    stepsByPlanId: Map<string, TaskStep[]>,
  ): TaskPlan {
    const id = String(row.id);
    return {
      id,
      taskId: String(row.task_id),
      status: row.status as TaskPlan["status"],
      schemaVersion: Number(row.schema_version),
      steps: stepsByPlanId.get(id) ?? [],
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapStep(row: QueryResultRow, artifacts: ArtifactRef[]): TaskStep {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      planId: String(row.plan_id),
      kind: row.kind as TaskStep["kind"],
      attempt: Number(row.attempt),
      status: row.status as TaskStep["status"],
      ...(row.input_context_hash
        ? { inputContextHash: String(row.input_context_hash) }
        : {}),
      ...(row.output_summary ? { outputSummary: String(row.output_summary) } : {}),
      artifacts,
      ...(row.failure_kind ? { failureKind: String(row.failure_kind) } : {}),
      ...(row.diagnostic ? { diagnostic: String(row.diagnostic) } : {}),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapDependency(row: QueryResultRow): TaskDependency {
    return {
      id: String(row.id),
      fromTaskId: String(row.from_task_id),
      toTaskId: String(row.to_task_id),
      kind: row.kind as TaskDependency["kind"],
      ...(row.reason ? { reason: String(row.reason) } : {}),
      status: row.status as TaskDependency["status"],
      createdAt: toIso(row.created_at),
      ...(row.resolved_at ? { resolvedAt: toIso(row.resolved_at) } : {}),
    };
  }

  private mapArtifact(row: QueryResultRow): ArtifactRef {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      kind: String(row.kind),
      ...(row.path ? { path: String(row.path) } : {}),
      ...(row.uri ? { uri: String(row.uri) } : {}),
      ...(row.summary ? { summary: String(row.summary) } : {}),
      retentionClass: row.retention_class as ArtifactRef["retentionClass"],
      createdAt: toIso(row.created_at),
    };
  }

  private async ensureTaskExists(
    client: PostgresQueryable,
    taskId: string,
  ): Promise<void> {
    const result = await client.query("SELECT 1 FROM tasks WHERE id = $1", [taskId]);
    if (result.rowCount === 0) {
      throw new TaskNotFoundError(taskId);
    }
  }

  private async touchTask(
    client: PostgresQueryable,
    taskId: string,
    updatedAt: string,
  ): Promise<void> {
    await client.query("UPDATE tasks SET updated_at = $2 WHERE id = $1", [
      taskId,
      updatedAt,
    ]);
  }

  private async assertExternalRefsAvailable(
    client: PostgresQueryable,
    refs: readonly TaskExternalRef[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = externalRefKey(ref.provider, ref.externalKey);
      if (seen.has(key)) {
        throw new DuplicateExternalRefError(ref.provider, ref.externalKey);
      }
      seen.add(key);

      const result = await client.query(
        `
          SELECT 1
          FROM task_external_refs
          WHERE lower(provider) = lower($1) AND lower(external_key) = lower($2)
          LIMIT 1
        `,
        [ref.provider, ref.externalKey],
      );
      if (result.rowCount && result.rowCount > 0) {
        throw new DuplicateExternalRefError(ref.provider, ref.externalKey);
      }
    }
  }

  private async selectClaimCandidate(
    client: PostgresQueryable,
    input: ClaimTaskInput,
    nowIso: string,
  ): Promise<string | null> {
    const params: unknown[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const repositoryWhere = buildRepositoryProfileWhere(
      input.repositoryProfiles,
      addParam,
    );
    const nowRef = addParam(nowIso);
    const targetRef = addParam(input.targetExternalKey ?? null);

    const result = await client.query<{ id: string }>(
      `
        WITH candidate AS (
          SELECT
            t.id,
            (
              CASE lower(coalesce(t.priority, ''))
                WHEN 'blocker' THEN 1000
                WHEN 'critical' THEN 700
                WHEN 'high' THEN 400
                WHEN 'normal' THEN 100
                ELSE 0
              END
              + CASE
                  WHEN t.deadline IS NULL THEN 0
                  WHEN t.deadline < date_trunc('day', ${nowRef}::timestamptz) THEN 600
                  WHEN t.deadline < date_trunc('day', ${nowRef}::timestamptz) + interval '1 day' THEN 300
                  ELSE 0
                END
              + CASE
                  WHEN EXISTS (
                    SELECT 1 FROM unnest(t.tags) tag WHERE lower(tag) = 'ai_priority'
                  ) THEN 10000
                  ELSE 0
                END
              + coalesce(t.confidence, 0) * 2
            ) AS claim_score
          FROM tasks t
          WHERE (${repositoryWhere})
            AND t.status IN ('ready', 'claimed')
            AND t.repository_name IS NOT NULL
            AND t.repo_path_key IS NOT NULL
            AND (
              ${targetRef}::text IS NULL
              OR t.id = ${targetRef}
              OR EXISTS (
                SELECT 1
                FROM task_external_refs xref
                WHERE xref.task_id = t.id AND xref.external_key = ${targetRef}
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM task_dependencies dep
              WHERE dep.status = 'active'
                AND (
                  (dep.kind = 'blocks' AND dep.to_task_id = t.id)
                  OR (
                    dep.kind IN (
                      'blocked_by',
                      'requires_human_input',
                      'requires_external_change'
                    )
                    AND dep.from_task_id = t.id
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM task_leases lease
              WHERE lease.kind = 'task'
                AND lease.task_id = t.id
                AND lease.released_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM task_leases lease
              WHERE lease.kind = 'repository'
                AND lease.lease_key = 'repo:' || lower(replace(coalesce(t.repo_path_key, t.repository_name), chr(92), '/'))
                AND lease.released_at IS NULL
            )
          ORDER BY claim_score DESC, t.deadline ASC NULLS LAST, t.created_at ASC, t.id ASC
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 1
        )
        SELECT id FROM candidate
      `,
      params,
    );

    return result.rows[0]?.id ?? null;
  }

  private createLeaseRecord(
    kind: "task" | "repository",
    leaseKey: string,
    task: TaskRecord,
    workerId: string,
    now: Date,
    leaseTtlSeconds: number,
  ): TaskLeaseRecord {
    if (!task.repositoryName) {
      throw new Error(`Task ${task.id} has no repositoryName.`);
    }

    return {
      leaseId: `lease_${randomUUID()}`,
      kind,
      leaseKey,
      taskId: task.id,
      repositoryName: task.repositoryName,
      workerId,
      token: `lease-token-${randomUUID()}`,
      expiresAt: new Date(now.getTime() + leaseTtlSeconds * 1000).toISOString(),
      heartbeatAt: now.toISOString(),
    };
  }

  private async insertLeaseIfAvailable(
    client: PostgresQueryable,
    lease: TaskLeaseRecord,
  ): Promise<boolean> {
    const result = await client.query(
      `
        INSERT INTO task_leases (
          lease_id, kind, lease_key, task_id, repository_name, worker_id,
          token, expires_at, heartbeat_at, released_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT DO NOTHING
        RETURNING lease_id
      `,
      [
        lease.leaseId,
        lease.kind,
        lease.leaseKey,
        lease.taskId,
        lease.repositoryName,
        lease.workerId,
        lease.token,
        lease.expiresAt,
        lease.heartbeatAt,
        lease.releasedAt ?? null,
      ],
    );

    return result.rowCount === 1;
  }

  private async requireLeaseForUpdate(
    client: PostgresQueryable,
    leaseId: string,
  ): Promise<TaskLeaseRecord> {
    const result = await client.query<TaskLeaseRow>(
      "SELECT * FROM task_leases WHERE lease_id = $1 FOR UPDATE",
      [leaseId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new LeaseNotFoundError(leaseId);
    }

    return mapLeaseRow(row);
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

  private async findIdempotency<T>(
    client: PostgresQueryable,
    operation: string,
    idempotencyKey: string,
  ): Promise<{ found: true; response: T } | { found: false }> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `${operation}:${idempotencyKey}`,
    ]);
    const result = await client.query<{ response: unknown }>(
      `
        SELECT response
        FROM idempotency_keys
        WHERE operation = $1 AND idempotency_key = $2
        FOR UPDATE
      `,
      [operation, idempotencyKey],
    );
    if (result.rowCount === 0) {
      return { found: false };
    }

    return { found: true, response: result.rows[0]?.response as T };
  }

  private async storeIdempotency(
    client: PostgresQueryable,
    operation: string,
    idempotencyKey: string,
    response: unknown,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO idempotency_keys (
          operation, idempotency_key, response, created_at
        )
        VALUES ($1, $2, $3::jsonb, $4)
        ON CONFLICT (operation, idempotency_key)
        DO UPDATE SET response = EXCLUDED.response
      `,
      [
        operation,
        idempotencyKey,
        JSON.stringify(response),
        this.nowIso(),
      ],
    );
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

  private nowIso(): string {
    return this.now().toISOString();
  }
}
