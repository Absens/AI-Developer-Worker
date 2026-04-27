export type LogicalStatus =
  | "open"
  | "in_progress"
  | "waiting_for_answer"
  | "review"
  | "failed"
  | "done";

export type WorkerTaskMode =
  | "auto"
  | "implement"
  | "decompose"
  | "analyze_only"
  | "human";

export type TaskExecutionMode =
  | "implement"
  | "ask_clarification"
  | "decompose"
  | "human";

export type TaskType =
  | "frontend_ui_fix"
  | "backend_endpoint"
  | "tests_only"
  | "refactor"
  | "dependency_update"
  | "documentation"
  | "unknown";

export type DependencyUnknownStatusPolicy = "block" | "warn" | "ignore";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type MemoryBootstrapCodexSandbox = "inherit" | CodexSandbox;

export interface MemoryConfig {
  enabled: boolean;
  dir: string;
  maxContextChars: number;
  strict: boolean;
  includeDraftRules: boolean;
  similarFailureLimit: number;
  bootstrapOnStart: boolean;
  refreshOnPreflight: boolean;
  bootstrapCodexSandbox: MemoryBootstrapCodexSandbox;
}

export type AlertSeverity = "info" | "warning" | "error";

export interface ObservabilityMetricsConfig {
  enabled: boolean;
  path: string;
}

export interface ObservabilityHealthConfig {
  path: string;
  readinessPath: string;
}

export interface ObservabilityEventStoreConfig {
  store: "memory" | "file";
  file?: string;
  retention: number;
}

export interface ObservabilityDashboardConfig {
  enabled: boolean;
  path: string;
  refreshSeconds: number;
  apiPath: string;
  bearerToken?: string;
}

export type AlertChannelConfig =
  | {
      type: "webhook";
      url?: string;
    }
  | {
      type: "slack";
      webhookUrl?: string;
    }
  | {
      type: "telegram";
      botToken?: string;
      chatId?: string;
    };

export interface ObservabilityAlertsConfig {
  enabled: boolean;
  minSeverity: AlertSeverity;
  dedupWindowSeconds: number;
  queueBlockedCycles: number;
  codexTimeoutWindowSeconds: number;
  codexTimeoutThreshold: number;
  validationFailureWindowSeconds: number;
  validationFailureThreshold: number;
  workerStaleSeconds: number;
  channels: AlertChannelConfig[];
}

export interface ObservabilityConfig {
  enabled: boolean;
  host: string;
  port: number;
  baseUrl: string;
  strictStartup: boolean;
  redactMaxChars: number;
  metrics: ObservabilityMetricsConfig;
  health: ObservabilityHealthConfig;
  events: ObservabilityEventStoreConfig;
  dashboard: ObservabilityDashboardConfig;
  alerts: ObservabilityAlertsConfig;
}

export interface TrackerStatusConfig {
  statuses: string[];
  transition?: string;
}

export interface TaskAnalysisDecision {
  confidence: number;
  taskType: TaskType;
  recommendedMode: TaskExecutionMode;
  promptProfileId: string;
  expectedFiles: string[];
  expectedSubsystems: string[];
  riskFactors: string[];
  missingContext: string[];
  reasoning: string;
}

export interface PromptProfile {
  id: string;
  taskType: TaskType;
  matchHints: string[];
  implementationInstructions: string[];
  validationFocus: string[];
  riskChecklist: string[];
}

export interface PromptProfileOverrides {
  matchHints?: string[];
  implementationInstructions?: string[];
  validationFocus?: string[];
  riskChecklist?: string[];
}

export type PromptProfileOverrideMap = Record<string, PromptProfileOverrides>;

export interface RepositoryKnowledgeBase {
  repositoryName: string;
  schemaVersion: 1;
  updatedAt: string;
  architectureMap: KnowledgeSection[];
  entryPoints: KnowledgeSection[];
  codePatterns: KnowledgeSection[];
  testStrategy: KnowledgeSection[];
  knownPitfalls: KnowledgeSection[];
  conventions: KnowledgeSection[];
}

export interface KnowledgeSection {
  id: string;
  title: string;
  body: string;
  source: "repo_docs" | "worker_observation" | "review_learning" | "manual";
  sourceRefs: string[];
  tags: string[];
  taskTypes: TaskType[];
  confidence: number;
  updatedAt: string;
}

export interface FailureMemoryEntry {
  repositoryName: string;
  issueKey: string;
  taskType: TaskType;
  promptProfileId: string;
  failureKind: string;
  diagnosticSummary: string;
  resolutionSummary?: string;
  affectedFiles: string[];
  tags: string[];
  createdAt: string;
}

export interface ReviewLearningEntry {
  repositoryName: string;
  issueKey: string;
  mergeRequestIid: number;
  taskType: TaskType;
  promptProfileId: string;
  source: "review_discussion" | "merge_diff" | "validation_failure";
  observation: string;
  recommendedRule?: string;
  affectedFiles: string[];
  tags: string[];
  confidence: number;
  approvalState: "draft" | "approved" | "rejected";
  createdAt: string;
}

export interface PromptRule {
  id: string;
  repositoryName: string;
  title: string;
  instruction: string;
  taskTypes: TaskType[];
  promptProfileIds: string[];
  sourceEntryIds: string[];
  confidence: number;
  approvalState: "draft" | "approved";
  createdAt: string;
  updatedAt: string;
}

export interface DecompositionPlan {
  parentIssueKey: string;
  summary: string;
  subtasks: SubtaskDraft[];
  dependencies: TaskDependencyDraft[];
  risks: string[];
}

export interface SubtaskDraft {
  temporaryId: string;
  title: string;
  description: string;
  queue?: string;
  tags: string[];
  acceptanceCriteria: string[];
  recommendedPromptProfileId: string;
}

export interface TaskDependencyDraft {
  blockedTaskTemporaryId: string;
  blockingTaskTemporaryId: string;
  reason: string;
}

export interface RepositoryDecompositionConfig {
  defaultSubtaskTag?: string;
  subtaskTitlePrefix?: string;
  maxSubtasks?: number;
}

export interface CreateTrackerIssueInput {
  queue: string;
  title: string;
  description: string;
  tags?: string[];
}

export interface LinkTrackerIssueInput {
  sourceIssueKey: string;
  targetIssueKey: string;
  linkType: string;
}

export interface TrackerIssueLink {
  id?: string;
  sourceIssueKey?: string;
  targetIssueKey: string;
  linkType: string;
  direction?: "inward" | "outward" | "unknown";
}

export type TrackerOrgHeader = "X-Org-ID" | "X-Cloud-Org-ID";

export interface AppConfig {
  trackerToken: string;
  trackerOrgHeader: TrackerOrgHeader;
  trackerOrgId: string;
  trackerDefaultQueue: string;
  trackerTag: string;
  trackerStatusMap: Record<LogicalStatus, TrackerStatusConfig>;
  trackerApiBaseUrl: string;
  trackerParentLinkType?: string;
  trackerBlockedByLinkType?: string;
  gitlabUrl: string;
  gitlabToken: string;
  gitlabProjectId: string;
  gitRemoteName: string;
  gitRepositoryToken: string;
  gitRepositoryUsername: string;
  gitRepositoryUrl?: string;
  gitCommitNoVerify: boolean;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  repoPath: string;
  baseBranch: string;
  pollIntervalMinutes: number;
  pollIntervalMs: number;
  codexHome: string;
  codexCliCommand: string;
  codexCliArgs: string[];
  codexModel?: string;
  codexProfile?: string;
  codexSandbox: CodexSandbox;
  codexExecArgs: string[];
  codexTimeoutMs: number;
  codexProgressLogIntervalMs: number;
  codexLogFullEvents: boolean;
  codexQuestionMarker: string;
  maxFixAttempts: number;
  maxReviewFixAttempts: number;
  workerId: string;
  typeCheckCommand?: string;
  testCommand: string;
  lintCommand: string;
  buildCommand?: string;
  securityScanCommand?: string;
  sastCommand?: string;
  coverageCommand?: string;
  minCoveragePercent?: number;
  coverageReportFile?: string;
  visualRegressionCommand?: string;
  visualRegressionArtifactsDir?: string;
  runOnce: boolean;
  preflightOnly: boolean;
  trackerPreflightIssueKey?: string;
  gitlabPreflightSourceBranch?: string;
  preflightRunTargetCommands: boolean;
  targetIssueKey?: string;
  taskMode?: WorkerTaskMode;
  confidenceImplementThreshold?: number;
  confidenceHumanThreshold?: number;
  decompositionMaxSubtasks?: number;
  decompositionCreateIssues?: boolean;
  decompositionDryRun?: boolean;
  decompositionDefaultSubtaskTag?: string;
  decompositionSubtaskTitlePrefix?: string;
  dependencyEnforcement?: boolean;
  dependencyUnknownStatusPolicy?: DependencyUnknownStatusPolicy;
  promptProfiles?: PromptProfileOverrideMap;
  memory?: MemoryConfig;
  observability?: ObservabilityConfig;
}

export type LockBackendKind = "tracker" | "redis" | "postgres";

export interface CoordinationConfig {
  lockBackend: LockBackendKind;
  lockTtlMs: number;
  lockHeartbeatMs: number;
  redisUrl?: string;
  postgresUrl?: string;
}

export interface PriorityQueueConfig {
  manualOverrideTags: string[];
  priorityWeights: Record<string, number>;
  tagBoosts: Record<string, number>;
  componentBoosts: Record<string, number>;
  confidencePriorityWeight?: number;
  deadlineBoost: {
    dueToday: number;
    overdue: number;
  };
  createdAtTieBreaker: "oldest" | "newest";
}

export interface TrackerGlobalConfig {
  token: string;
  orgHeader: TrackerOrgHeader;
  orgId: string;
  statusMap: Record<LogicalStatus, TrackerStatusConfig>;
  apiBaseUrl: string;
}

export interface GitLabGlobalConfig {
  url: string;
  token: string;
}

export interface CodexGlobalConfig {
  home: string;
  cliCommand: string;
  cliArgs: string[];
  model?: string;
  profile?: string;
  sandbox: CodexSandbox;
  execArgs: string[];
  timeoutMs: number;
  progressLogIntervalMs: number;
  logFullEvents: boolean;
  questionMarker: string;
}

export interface RepositoryProfile {
  name: string;
  repoPath: string;
  gitlabProjectId: string;
  gitRemoteName: string;
  baseBranch: string;
  queues: string[];
  tags: string[];
  testCommand: string;
  lintCommand: string;
  typeCheckCommand?: string;
  buildCommand?: string;
  securityScanCommand?: string;
  sastCommand?: string;
  coverageCommand?: string;
  minCoveragePercent?: number;
  coverageReportFile?: string;
  visualRegressionCommand?: string;
  visualRegressionArtifactsDir?: string;
  gitRepositoryUrl?: string;
  promptProfiles?: PromptProfileOverrideMap;
  decomposition?: RepositoryDecompositionConfig;
}

export interface GlobalWorkerConfig {
  workerId: string;
  pollIntervalMinutes: number;
  pollIntervalMs: number;
  runOnce: boolean;
  preflightOnly: boolean;
  preflightRunTargetCommands: boolean;
  trackerPreflightIssueKey?: string;
  gitlabPreflightSourceBranch?: string;
  targetIssueKey?: string;
  taskMode?: WorkerTaskMode;
  confidenceImplementThreshold?: number;
  confidenceHumanThreshold?: number;
  decompositionMaxSubtasks?: number;
  decompositionCreateIssues?: boolean;
  decompositionDryRun?: boolean;
  decompositionDefaultSubtaskTag?: string;
  decompositionSubtaskTitlePrefix?: string;
  dependencyEnforcement?: boolean;
  dependencyUnknownStatusPolicy?: DependencyUnknownStatusPolicy;
  trackerParentLinkType?: string;
  trackerBlockedByLinkType?: string;
  maxFixAttempts: number;
  maxReviewFixAttempts: number;
  gitRepositoryToken: string;
  gitRepositoryUsername: string;
  gitCommitNoVerify: boolean;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  tracker: TrackerGlobalConfig;
  gitlab: GitLabGlobalConfig;
  codex: CodexGlobalConfig;
  coordination: CoordinationConfig;
  priorityQueue: PriorityQueueConfig;
  repositories: RepositoryProfile[];
  memory?: MemoryConfig;
  observability?: ObservabilityConfig;
}

export interface RepositoryRuntimeConfig extends AppConfig {
  repositoryName: string;
}

export interface PreflightCheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  details: string;
}

export interface TrackerIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  queue?: string;
  createdAt?: string;
  updatedAt?: string;
  statusKey?: string;
  statusDisplay?: string;
  logicalStatus?: LogicalStatus;
  priority?: string;
  deadline?: string;
  components?: string[];
  tags?: string[];
  blockedBy?: string[];
  blocks?: string[];
}

export interface TrackerComment {
  id: string;
  text: string;
  createdAt: string;
  author?: string;
  isSystem: boolean;
}

export type ServiceCommentKind =
  | "AI STATUS"
  | "AI QUESTION"
  | "AI MR"
  | "AI REVIEW"
  | "AI LEASE"
  | "AI ANALYSIS"
  | "AI DECOMPOSITION";
export type ClarificationMode = "clarification";
export type WaitingReason = "clarification" | "failure_recovery" | "manual_hold";
export type LeaseKind = "task" | "repository";

export interface ClarificationQuestion {
  summary: string;
  blockingReason: string;
  question: string;
  options: string[];
  resumeHint: string;
}

export interface HumanTaskCommand {
  type: "resume" | "skip" | "cancel";
  rawText: string;
  choice?: string;
  freeform?: string;
}

export interface ParsedServiceComment {
  kind: ServiceCommentKind;
  worker: string;
  state?: LogicalStatus;
  details?: string;
  question?: string;
  threadId?: string;
  url?: string;
  branch?: string;
  issueKey?: string;
  mergeRequestIid?: number;
  processedDiscussionIds?: string[];
  processedNoteIds?: number[];
  lastFixCommit?: string;
  mode?: ClarificationMode;
  summary?: string;
  blockingReason?: string;
  options?: string[];
  resumeHint?: string;
  waitingReason?: WaitingReason;
  leaseKind?: LeaseKind;
  leaseKey?: string;
  repositoryName?: string;
  repoPath?: string;
  acquiredAt?: string;
  expiresAt?: string;
  heartbeatAt?: string;
  token?: string;
  releasedAt?: string;
  confidence?: number;
  taskType?: TaskType;
  recommendedMode?: TaskExecutionMode;
  promptProfileId?: string;
  expectedFiles?: string[];
  expectedSubsystems?: string[];
  riskFactors?: string[];
  missingContext?: string[];
  reasoning?: string;
  parentIssueKey?: string;
  createdIssueKeys?: string[];
  dryRun?: boolean;
}

export interface TaskLease {
  kind: LeaseKind;
  leaseKey: string;
  issueKey: string;
  workerId: string;
  repositoryName: string;
  repoPath: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  token: string;
  releasedAt?: string;
}

export interface AcquireTaskLeaseInput {
  issueKey: string;
  workerId: string;
  repositoryName: string;
  repoPath: string;
  ttlMs: number;
  now?: Date;
}

export interface AcquireRepositoryLeaseInput extends AcquireTaskLeaseInput {
  leaseKey?: string;
}

export interface LockBackend {
  acquireTaskLease(input: AcquireTaskLeaseInput): Promise<TaskLease | null>;
  renewTaskLease(lease: TaskLease): Promise<TaskLease>;
  releaseTaskLease(lease: TaskLease): Promise<void>;
  getActiveLease(
    issueKey: string,
    options?: {
      kind?: LeaseKind;
      leaseKey?: string;
      now?: Date;
    },
  ): Promise<TaskLease | null>;
  acquireRepositoryLease(input: AcquireRepositoryLeaseInput): Promise<TaskLease | null>;
}

export interface CommentWithMetadata extends TrackerComment {
  metadata?: ParsedServiceComment;
}

export interface TaskContext {
  issue: TrackerIssue;
  branch: string;
  comments: CommentWithMetadata[];
  existingMr?: MergeRequestInfo | null;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface QualityGate {
  id: string;
  label: string;
  command: string;
  required: boolean;
  artifactPath?: string;
}

export interface QualityGateResult {
  id: string;
  label: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  artifactPath?: string;
  coveragePercent?: number;
  coverageThreshold?: number;
  diagnostic: string;
}

export interface ValidationResult {
  changed: boolean;
  testsPassed: boolean;
  lintPassed: boolean;
  gates: QualityGateResult[];
  diagnostic: string;
}

export interface MergeRequestInfo {
  id: number;
  iid: number;
  url: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface MergeRequestDiscussion {
  id: string;
  individualNote: boolean;
  resolved: boolean;
  notes: MergeRequestNote[];
}

export interface MergeRequestNote {
  id: number;
  body: string;
  authorUsername: string;
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  createdAt: string;
  position?: {
    newPath?: string;
    oldPath?: string;
    newLine?: number;
    oldLine?: number;
  };
}

export interface ReviewMetadata {
  worker: string;
  issueKey: string;
  mergeRequestIid: number;
  processedDiscussionIds: string[];
  processedNoteIds: number[];
  lastFixCommit?: string;
}

export interface TrackerClient {
  checkReadAccess(): Promise<void>;
  findCandidateIssues(input?: { queue?: string; tag?: string }): Promise<TrackerIssue[]>;
  findOwnedIssues(statuses: LogicalStatus[]): Promise<TrackerIssue[]>;
  getIssue(issueKey: string): Promise<TrackerIssue>;
  getComments(issueKey: string): Promise<CommentWithMetadata[]>;
  addComment(issueKey: string, text: string): Promise<void>;
  transition(issueKey: string, targetStatus: LogicalStatus): Promise<void>;
  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined;
  createIssue?(input: CreateTrackerIssueInput): Promise<TrackerIssue>;
  linkIssue?(input: LinkTrackerIssueInput): Promise<void>;
  getIssueLinks?(issueKey: string): Promise<TrackerIssueLink[]>;
}

export interface GitService {
  assertRepositoryReady(): Promise<void>;
  getCurrentBranch(): Promise<string>;
  hasChanges(): Promise<boolean>;
  hasDiffFromBase(): Promise<boolean>;
  syncBaseBranch(): Promise<void>;
  checkoutBranch(branch: string): Promise<string>;
  checkoutTaskBranch(issueKey: string): Promise<string>;
  getDiffFromBase(): Promise<string>;
  getChangedFilesFromBase(): Promise<string[]>;
  getHeadSha(): Promise<string>;
  commit(message: string): Promise<void>;
  push(branch: string): Promise<void>;
}

export interface GitLabService {
  checkReadAccess(): Promise<void>;
  checkMergeRequestWriteAccess(sourceBranch: string): Promise<MergeRequestInfo>;
  findOpenMergeRequestByBranch(
    sourceBranch: string,
  ): Promise<MergeRequestInfo | null>;
  getMergeRequestDiscussions(iid: number): Promise<MergeRequestDiscussion[]>;
  replyToDiscussion(iid: number, discussionId: string, body: string): Promise<void>;
  getCurrentUser(): Promise<{ username: string }>;
  createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
  }): Promise<MergeRequestInfo>;
}

export interface CodexExecution {
  process: ProcessResult;
  finalMessage?: string;
  threadId?: string;
  question?: string;
  clarification?: ClarificationQuestion;
}

export interface CodexRunner {
  runInitial(prompt: string): Promise<CodexExecution>;
  runFix(prompt: string): Promise<CodexExecution>;
  runResume(threadId: string, prompt: string): Promise<CodexExecution>;
}

export interface TaskAnalysisResult {
  status: "ready" | "clarification_required";
  threadId?: string;
  clarification?: ClarificationQuestion;
  decision?: TaskAnalysisDecision;
}
