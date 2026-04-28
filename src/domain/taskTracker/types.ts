import type {
  ClarificationQuestion,
  DecompositionPlan,
  HumanTaskCommand,
  LogicalStatus,
  MergeRequestInfo,
  QualityGateResult,
  ReviewMetadata,
  SubtaskDraft,
  TaskAnalysisDecision,
  TaskType,
  ValidationResult,
} from "../../models/types.js";

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

export interface ArtifactRefInput {
  kind: string;
  path?: string;
  uri?: string;
  summary?: string;
  retentionClass?: ArtifactRef["retentionClass"];
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

export interface TaskStepRecordInput {
  planId?: string;
  kind: TaskStepKind;
  attempt?: number;
  status: TaskStep["status"];
  inputContextHash?: string;
  outputSummary?: string;
  artifacts?: ArtifactRefInput[];
  failureKind?: string;
  diagnostic?: string;
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

export type AgentRunStage =
  | "analysis"
  | "decomposition"
  | "implementation"
  | "validation"
  | "fix"
  | "publish"
  | "review_fix";

export interface AgentRun {
  id: string;
  taskId: string;
  workerId: string;
  stage: AgentRunStage;
  status: "started" | "completed" | "failed";
  threadId?: string;
  exitCode?: number;
  timedOut?: boolean;
  finalMessage?: string;
  diagnostic?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AgentRunInput {
  workerId: string;
  stage: AgentRunStage;
  status: AgentRun["status"];
  threadId?: string;
  exitCode?: number;
  timedOut?: boolean;
  finalMessage?: string;
  diagnostic?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface QualityGateRun {
  id: string;
  taskId: string;
  workerId: string;
  status: "passed" | "failed";
  changed: boolean;
  testsPassed: boolean;
  lintPassed: boolean;
  gates: QualityGateResult[];
  diagnostic: string;
  summary?: string;
  artifactRefs: ArtifactRef[];
  createdAt: string;
}

export interface ValidationRecordInput {
  workerId: string;
  validation: ValidationResult;
  status: QualityGateRun["status"];
  summary?: string;
  artifacts?: ArtifactRefInput[];
}

export interface MergeRequestRecord {
  id: string;
  taskId: string;
  workerId: string;
  mergeRequest: MergeRequestInfo;
  branch: string;
  outcome: "created" | "reused";
  validationSummary?: string;
  createdAt: string;
}

export interface MergeRequestRecordInput {
  workerId: string;
  mergeRequest: MergeRequestInfo;
  branch: string;
  outcome: MergeRequestRecord["outcome"];
  validationSummary?: string;
}

export interface ClarificationQuestionRecord {
  id: string;
  taskId: string;
  workerId: string;
  question: ClarificationQuestion;
  threadId?: string;
  status: "open" | "answered";
  createdAt: string;
}

export type ClarificationQuestionInput = ClarificationQuestion & {
  workerId?: string;
  threadId?: string;
};

export interface HumanAnswerRecord {
  id: string;
  taskId: string;
  questionId?: string;
  author: TaskActor;
  body: string;
  command?: HumanTaskCommand;
  createdAt: string;
}

export interface HumanAnswerInput {
  questionId?: string;
  author: TaskActor;
  body: string;
  command?: HumanTaskCommand;
}

export interface ReviewMetadataRecord {
  id: string;
  taskId: string;
  metadata: ReviewMetadata;
  createdAt: string;
}

export interface ReviewMetadataRecordInput {
  metadata: ReviewMetadata;
}

export interface DecompositionDecisionRecord {
  id: string;
  taskId: string;
  plan: DecompositionPlan;
  createdAt: string;
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

export interface LinkTaskDependencyInput extends TaskDependencyInput {}

export interface TaskDependencyRecord extends TaskDependency {}

export interface MemoryContextRef {
  id: string;
  taskId: string;
  workerId: string;
  promptProfileId: string;
  taskType: TaskType;
  knowledgeSectionIds: string[];
  promptRuleIds: string[];
  similarFailureCount: number;
  createdAt: string;
}

export interface MemoryContextRecordInput {
  workerId: string;
  promptProfileId: string;
  taskType: TaskType;
  knowledgeSectionIds: string[];
  promptRuleIds: string[];
  similarFailureCount: number;
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
  agentRuns: AgentRun[];
  qualityGateRuns: QualityGateRun[];
  mergeRequests: MergeRequestRecord[];
  clarificationQuestions: ClarificationQuestionRecord[];
  humanAnswers: HumanAnswerRecord[];
  decompositionDecisions: DecompositionDecisionRecord[];
  reviewMetadata: ReviewMetadataRecord[];
  memoryContextRefs: MemoryContextRef[];
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
  recordDecision(taskId: string, input: TaskDecisionInput): Promise<TaskDecision>;
  recordAnalysis(taskId: string, decision: TaskAnalysisDecision): Promise<void>;
  recordTaskStep(taskId: string, input: TaskStepRecordInput): Promise<void>;
  askClarification(
    taskId: string,
    question: ClarificationQuestionInput,
  ): Promise<void>;
  recordHumanAnswer(taskId: string, input: HumanAnswerInput): Promise<void>;
  recordAgentRun(taskId: string, input: AgentRunInput): Promise<void>;
  recordValidation(taskId: string, input: ValidationRecordInput): Promise<void>;
  recordMergeRequest(taskId: string, input: MergeRequestRecordInput): Promise<void>;
  recordReviewMetadata(
    taskId: string,
    input: ReviewMetadataRecordInput,
  ): Promise<void>;
  recordDecomposition(taskId: string, plan: DecompositionPlan): Promise<void>;
  createChildTasks(taskId: string, subtasks: SubtaskDraft[]): Promise<TaskRecord[]>;
  linkDependency(input: LinkTaskDependencyInput): Promise<void>;
  recordMemoryContext(taskId: string, input: MemoryContextRecordInput): Promise<void>;
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
