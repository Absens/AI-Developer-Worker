import type { LogicalStatus, TaskType } from "../../models/types.js";

export const TASK_STATUSES = [
  "new",
  "triage",
  "ready",
  "claimed",
  "analyzing",
  "awaiting_human",
  "decomposing",
  "implementing",
  "validating",
  "review",
  "fixing_review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_MESSAGE_KINDS = [
  "comment",
  "question",
  "answer",
  "command",
  "status_digest",
  "system_event",
] as const;

export type TaskMessageKind = (typeof TASK_MESSAGE_KINDS)[number];

export type TaskFieldOwner =
  | "human"
  | "external_source"
  | "worker_agent"
  | "gitlab_sync"
  | "policy_admin";

export type TaskFieldGroup =
  | "human_input"
  | "external_snapshot"
  | "worker_runtime"
  | "gitlab_sync"
  | "policy_admin";

export interface TaskActor {
  owner: TaskFieldOwner;
  id: string;
  displayName?: string;
}

export interface TaskFieldOwnership {
  group: TaskFieldGroup;
  owner: TaskFieldOwner;
  fields: string[];
  updatedAt: string;
}

export interface TaskExternalRef {
  id: string;
  taskId: string;
  provider: string;
  externalKey: string;
  externalUrl?: string;
  businessStatus?: string;
  lastSeenAt?: string;
  createdAt: string;
}

export interface TaskExternalRefInput {
  provider: string;
  externalKey: string;
  externalUrl?: string;
  businessStatus?: string;
  lastSeenAt?: string;
}

export interface TaskSource {
  kind: "native" | "external" | "system";
  provider?: string;
  externalKey?: string;
}

export interface TaskRevision {
  id: string;
  taskId: string;
  revisionNumber: number;
  owner: "human" | "external_source";
  author: TaskActor;
  title: string;
  description: string;
  humanSummary?: string;
  acceptanceCriteria: string[];
  constraints: string[];
  riskFactors: string[];
  missingContext: string[];
  externalSnapshot?: Record<string, unknown>;
  externalRevisionId?: string;
  reason?: string;
  createdAt: string;
}

export interface TaskRevisionInput {
  owner: TaskFieldOwner;
  author: TaskActor;
  title?: string;
  description?: string;
  humanSummary?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  riskFactors?: string[];
  missingContext?: string[];
  externalSnapshot?: Record<string, unknown>;
  externalRevisionId?: string;
  reason?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: string;
  source: TaskFieldOwner;
  actor?: TaskActor;
  message?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface TaskEventInput {
  kind: string;
  source: TaskFieldOwner;
  actor?: TaskActor;
  message?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  kind: TaskMessageKind;
  author: TaskActor;
  body?: string;
  payload?: Record<string, unknown>;
  externalRef?: {
    provider: string;
    externalKey: string;
    externalUrl?: string;
  };
  createdAt: string;
}

export interface CommentInput {
  kind: TaskMessageKind;
  author: TaskActor;
  body?: string;
  payload?: Record<string, unknown>;
  externalRef?: {
    provider: string;
    externalKey: string;
    externalUrl?: string;
  };
  createdAt?: string;
}

export const TASK_PLAN_STATUSES = ["active", "complete", "abandoned"] as const;
export type TaskPlanStatus = (typeof TASK_PLAN_STATUSES)[number];

export const TASK_STEP_KINDS = [
  "analyze",
  "plan",
  "implement",
  "validate",
  "fix",
  "publish",
  "review_fix",
] as const;

export type TaskStepKind = (typeof TASK_STEP_KINDS)[number];

export interface ArtifactRef {
  id: string;
  taskId: string;
  kind: string;
  path?: string;
  uri?: string;
  summary?: string;
  retentionClass: "short_lived" | "task_lifetime" | "audit";
  createdAt: string;
}

export interface TaskStep {
  id: string;
  taskId: string;
  planId: string;
  kind: TaskStepKind;
  attempt: number;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  inputContextHash?: string;
  outputSummary?: string;
  artifacts: ArtifactRef[];
  failureKind?: string;
  diagnostic?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPlan {
  id: string;
  taskId: string;
  status: TaskPlanStatus;
  schemaVersion: number;
  steps: TaskStep[];
  createdAt: string;
  updatedAt: string;
}

export const TASK_DECISION_KINDS = [
  "analysis",
  "routing",
  "decomposition",
  "manual",
] as const;

export type TaskDecisionKind = (typeof TASK_DECISION_KINDS)[number];

export interface TaskDecision {
  id: string;
  taskId: string;
  kind: TaskDecisionKind;
  schemaVersion: number;
  source: TaskFieldOwner;
  authorId?: string;
  workerId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDecisionInput {
  kind: TaskDecisionKind;
  schemaVersion: number;
  source: TaskFieldOwner;
  authorId?: string;
  workerId?: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export const TASK_DEPENDENCY_KINDS = [
  "blocks",
  "blocked_by",
  "parent_child",
  "relates",
  "duplicates",
  "requires_human_input",
  "requires_external_change",
] as const;

export type TaskDependencyKind = (typeof TASK_DEPENDENCY_KINDS)[number];

export interface TaskDependency {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  kind: TaskDependencyKind;
  reason?: string;
  status: "active" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}

export interface TaskDependencyInput {
  fromTaskId: string;
  toTaskId: string;
  kind: TaskDependencyKind;
  reason?: string;
  status?: "active" | "resolved";
  createdAt?: string;
  resolvedAt?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  humanSummary?: string;
  source: TaskSource;
  createdBy: TaskActor;
  repositoryName?: string;
  repoPathKey?: string;
  baseBranch?: string;
  queue?: string;
  tags: string[];
  components: string[];
  priority?: string;
  deadline?: string;
  status: TaskStatus;
  businessStatus?: string;
  taskType: TaskType;
  promptProfileId?: string;
  confidence?: number;
  acceptanceCriteria: string[];
  constraints: string[];
  riskFactors: string[];
  missingContext: string[];
  externalRefs: TaskExternalRef[];
  fieldOwners: TaskFieldOwnership[];
  revisions: TaskRevision[];
  events: TaskEvent[];
  comments: TaskComment[];
  decisions: TaskDecision[];
  plans: TaskPlan[];
  dependencies: TaskDependency[];
  artifacts: ArtifactRef[];
  createdAt: string;
  updatedAt: string;
  lastSyncedAt?: string;
}

export interface ClaimRepositoryProfile {
  name: string;
  repoPathKey?: string;
  queues?: string[];
  tags?: string[];
}

export interface ClaimTaskInput {
  workerId: string;
  repositoryProfiles: ClaimRepositoryProfile[];
  capabilities?: string[];
  maxTasks?: number;
  leaseTtlSeconds: number;
  targetExternalKey?: string;
  idempotencyKey?: string;
}

export interface TaskLeaseRecord {
  leaseId: string;
  kind: "task" | "repository";
  leaseKey: string;
  taskId: string;
  repositoryName: string;
  workerId: string;
  token: string;
  expiresAt: string;
  heartbeatAt: string;
  releasedAt?: string;
}

export interface ClaimedTask {
  task: TaskRecord;
  agentContext: AgentTaskContext;
  taskLease: TaskLeaseRecord;
  repositoryLease: TaskLeaseRecord;
}

export interface LeaseHeartbeatInput {
  workerId: string;
  token: string;
  leaseTtlSeconds: number;
  idempotencyKey?: string;
}

export interface ReleaseLeaseInput {
  workerId: string;
  token: string;
  idempotencyKey?: string;
}

export interface CreateTaskInput {
  id?: string;
  title: string;
  description: string;
  humanSummary?: string;
  source?: TaskSource;
  createdBy: TaskActor;
  repositoryName?: string;
  repoPathKey?: string;
  baseBranch?: string;
  queue?: string;
  tags?: string[];
  components?: string[];
  priority?: string;
  deadline?: string;
  status?: TaskStatus;
  businessStatus?: string;
  taskType?: TaskType;
  promptProfileId?: string;
  confidence?: number;
  acceptanceCriteria?: string[];
  constraints?: string[];
  riskFactors?: string[];
  missingContext?: string[];
  externalRefs?: TaskExternalRefInput[];
  externalSnapshot?: Record<string, unknown>;
  externalRevisionId?: string;
  createdAt?: string;
  lastSyncedAt?: string;
}

export interface AgentTaskContext {
  taskId: string;
  status: TaskStatus;
  logicalStatus: LogicalStatus;
  title: string;
  description: string;
  humanSummary?: string;
  repositoryName?: string;
  repoPathKey?: string;
  baseBranch?: string;
  queue?: string;
  tags: string[];
  components: string[];
  priority?: string;
  deadline?: string;
  taskType: TaskType;
  promptProfileId?: string;
  confidence?: number;
  acceptanceCriteria: string[];
  constraints: string[];
  riskFactors: string[];
  missingContext: string[];
  externalRefs: TaskExternalRef[];
  latestRevision: TaskRevision;
  activePlan: TaskPlan;
  comments: TaskComment[];
  events: TaskEvent[];
  decisions: TaskDecision[];
}

export interface TaskTrackerClient {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  updateTaskRevision(taskId: string, input: TaskRevisionInput): Promise<TaskRecord>;
  markReady(taskId: string, reason?: string): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord>;
  getAgentTaskContext(taskId: string): Promise<AgentTaskContext>;
  appendEvent(taskId: string, input: TaskEventInput): Promise<void>;
  appendComment(taskId: string, input: CommentInput): Promise<void>;
  setStatus(taskId: string, status: TaskStatus, reason?: string): Promise<void>;
  addDependency(input: TaskDependencyInput): Promise<TaskDependency>;
  claimNextTask(input: ClaimTaskInput): Promise<ClaimedTask | null>;
  heartbeatLease(
    leaseId: string,
    input: LeaseHeartbeatInput,
  ): Promise<TaskLeaseRecord>;
  releaseLease(leaseId: string, input: ReleaseLeaseInput): Promise<void>;
}

export interface ImportCandidatesInput {
  queue?: string;
  since?: string;
  limit?: number;
}

export interface ExternalIssueSnapshot {
  provider: string;
  externalKey: string;
  title: string;
  description: string;
  businessStatus?: string;
  queue?: string;
  tags?: string[];
  components?: string[];
  priority?: string;
  deadline?: string;
  payload: Record<string, unknown>;
  observedAt: string;
}

export interface ExportDigestInput {
  taskId: string;
  provider: string;
  externalKey: string;
  digest: string;
  payload?: Record<string, unknown>;
}

export interface ExternalTransitionInput {
  taskId: string;
  provider: string;
  externalKey: string;
  targetBusinessStatus: string;
  reason?: string;
}

export interface ExternalTaskSource {
  importCandidates(input: ImportCandidatesInput): Promise<ExternalIssueSnapshot[]>;
  exportDigest(input: ExportDigestInput): Promise<void>;
  transitionExternal(input: ExternalTransitionInput): Promise<void>;
}
