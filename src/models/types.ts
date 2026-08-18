import type {
  ProjectManagerConfig,
  RepositoryProjectManagerConfig,
} from "../domain/projectManager/types.js";

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

export type AutonomyLevel =
  | "proposal_only"
  | "auto_triage"
  | "auto_execute_low_risk";

export interface RepositoryAutonomyPolicyConfig {
  proposalsEnabled?: boolean;
  autoExecuteLowRiskEnabled?: boolean;
  allowedTaskTypes?: TaskType[];
  dailyProposalLimit?: number;
  windowProposalLimit?: number;
  windowSeconds?: number;
}

export interface AutonomyPolicyConfig {
  aiProposalsEnabled: boolean;
  autoExecuteLowRiskEnabled: boolean;
  defaultAllowedTaskTypes: TaskType[];
  defaultDailyProposalLimit: number;
  defaultWindowProposalLimit: number;
  defaultWindowSeconds: number;
  repositories: Record<string, RepositoryAutonomyPolicyConfig>;
}

export type DependencyUnknownStatusPolicy = "block" | "warn" | "ignore";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type MemoryBootstrapCodexSandbox = "inherit" | CodexSandbox;
export type TaskTrackerProvider = "yandex" | "internal";
export type TaskIntakeMode =
  | "standalone"
  | "yandex_integration"
  | "hybrid"
  | "system_only"
  | "ai_proposed";
export type TaskTrackerStorageAdapter = "postgres" | "memory";

export interface TaskTrackerRetentionConfig {
  rawLogDays: number;
  artifactDays: number;
  failedArtifactDays: number;
  historyDays: number;
}

export interface TaskTrackerCleanupConfig {
  enabled: boolean;
  intervalSeconds: number;
}

export interface TaskTrackerOperationalConfig {
  retention: TaskTrackerRetentionConfig;
  cleanup: TaskTrackerCleanupConfig;
  metricsEnabled: boolean;
  redactionEnabled: boolean;
}

export interface BaseInternalTaskTrackerConfig {
  intakeMode: TaskIntakeMode;
  yandexSyncEnabled: boolean;
  operational: TaskTrackerOperationalConfig;
}

export interface PostgresInternalTaskTrackerConfig
  extends BaseInternalTaskTrackerConfig {
  storage: "postgres";
  databaseUrl: string;
}

export interface MemoryInternalTaskTrackerConfig extends BaseInternalTaskTrackerConfig {
  storage: "memory";
  databaseUrl?: string;
}

export type InternalTaskTrackerConfig =
  | PostgresInternalTaskTrackerConfig
  | MemoryInternalTaskTrackerConfig;

export type TaskTrackerConfig =
  | {
      provider: "yandex";
    }
  | {
      provider: "internal";
      internal: InternalTaskTrackerConfig;
    };

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

export type TaskTrackerHumanAuthMode = "trusted_proxy" | "bearer" | "localhost";
export type TaskTrackerHumanRole = "viewer" | "developer" | "operator" | "admin";

export interface TaskTrackerUiConfig {
  enabled: boolean;
  path: string;
  apiPath: string;
  assetPath: string;
  staticDir?: string;
  authMode: TaskTrackerHumanAuthMode;
  trustedUserHeader: string;
  trustedRoleHeader: string;
  agentToken?: string;
  systemToken?: string;
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
  taskTrackerUi: TaskTrackerUiConfig;
  alerts: ObservabilityAlertsConfig;
}

export interface TrackerStatusConfig {
  statuses: string[];
  transition?: string;
}

export interface TrackerAttachmentAuthor {
  id?: string;
  display?: string;
}

export interface TrackerAttachmentMetadata {
  size?: string;
}

export interface TrackerAttachment {
  id: string;
  name: string;
  content?: string;
  thumbnail?: string;
  createdBy?: TrackerAttachmentAuthor;
  createdAt?: string;
  mimetype?: string;
  size?: number;
  metadata?: TrackerAttachmentMetadata;
}

export interface TrackerImageContextConfig {
  enabled: boolean;
  maxCount: number;
  maxBytes: number;
  tempDir?: string;
}

export type TelegramAssistantMode = "polling" | "webhook";
export type TelegramAssistantRole = "viewer" | "developer" | "operator" | "admin";
export type TelegramAssistantGroupMode =
  | "private_only"
  | "mentions_and_replies"
  | "all_messages";

export interface TelegramAssistantMediaConfig {
  enabled: boolean;
  maxBytes: number;
  allowedMimeTypes: string[];
}

export interface TelegramProfileAutomationConfig {
  enabled: boolean;
  autoReplyEnabled: boolean;
  requireOwnerApproval: boolean;
  projectQaEnabled: boolean;
  allowedOwnerIds: string[];
  allowedChatIds: string[];
  maxMessageAgeSeconds: number;
}

export interface TelegramAssistantWebhookConfig {
  path: string;
  secretToken?: string;
}

export interface TelegramDigitalTwinConfig {
  enabled: boolean;
  autoReplyEnabled: boolean;
  fullAccess: boolean;
  sessionTtlDays: number;
  summaryRefreshMessageInterval: number;
  maxRecentMessages: number;
  codexTimeoutSeconds: number;
  redactedRetentionDays: number;
  fullTextRetentionDays: number;
  auditEncryptionKeyEnv?: string;
  personaProfileVersion: string;
  ownerStylePrompt: string;
}

export interface TelegramAssistantConfig {
  enabled: boolean;
  botToken?: string;
  botUsername?: string;
  codexModel?: string;
  mode: TelegramAssistantMode;
  pollIntervalSeconds: number;
  confirmWriteActions: boolean;
  projectQaEnabled: boolean;
  taskCreationEnabled: boolean;
  allowedChatIds: string[];
  allowedUserIds: string[];
  developerUserIds: string[];
  operatorUserIds: string[];
  adminUserIds: string[];
  groupMode: TelegramAssistantGroupMode;
  defaultRepository?: string;
  userTaskCreationDailyLimit: number;
  userCodexQaDailyLimit: number;
  codexTimeoutSeconds: number;
  codexMaxContextChars: number;
  maxQueuedMessagesPerChat: number;
  conversationRetentionDays: number;
  maxInboundMessageAgeSeconds: number;
  webhook?: TelegramAssistantWebhookConfig;
  media: TelegramAssistantMediaConfig;
  digitalTwin: TelegramDigitalTwinConfig;
  profileAutomation: TelegramProfileAutomationConfig;
}

export type CodexOutputSchema = Record<string, unknown>;

export interface CodexRunOptions {
  imagePaths?: string[];
  sandbox?: CodexSandbox;
  outputSchema?: CodexOutputSchema;
  webSearch?: boolean;
}

export interface CodexReviewRunOptions {
  baseBranch: string;
  title?: string;
  outputSchema?: CodexOutputSchema;
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

export type TaskIntakeReviewStatus =
  | "ready"
  | "needs_clarification"
  | "needs_decomposition"
  | "reject_as_invalid";

export interface TaskIntakeReviewDecision {
  status: TaskIntakeReviewStatus;
  readinessScore: number;
  summary: string;
  rewrittenTitle?: string;
  rewrittenDescription?: string;
  acceptanceCriteria: string[];
  clarificationQuestions: string[];
  decompositionHints: string[];
  riskFactors: string[];
  reasoning: string;
}

export interface TaskIntakeReviewConfig {
  enabled: boolean;
  tag: string;
  maxQuestions: number;
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
  taskTracker?: TaskTrackerConfig;
  taskIntakeReview?: TaskIntakeReviewConfig;
  trackerToken: string;
  trackerOrgHeader: TrackerOrgHeader;
  trackerOrgId: string;
  trackerDefaultQueue: string;
  trackerTag: string;
  trackerStatusMap: Record<LogicalStatus, TrackerStatusConfig>;
  trackerApiBaseUrl: string;
  trackerImageContext?: TrackerImageContextConfig;
  telegramAssistant?: TelegramAssistantConfig;
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
  codexSelfReviewEnabled: boolean;
  codexSelfReviewMaxFixAttempts: number;
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
  autonomy?: AutonomyPolicyConfig;
  projectManager?: ProjectManagerConfig;
}

export type LockBackendKind = "none" | "tracker" | "redis" | "postgres";

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
  selfReviewEnabled: boolean;
  selfReviewMaxFixAttempts: number;
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
  autonomy?: RepositoryAutonomyPolicyConfig;
  projectManager?: RepositoryProjectManagerConfig;
}

export interface GlobalWorkerConfig {
  taskTracker?: TaskTrackerConfig;
  taskIntakeReview?: TaskIntakeReviewConfig;
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
  trackerImageContext?: TrackerImageContextConfig;
  telegramAssistant?: TelegramAssistantConfig;
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
  autonomy?: AutonomyPolicyConfig;
  projectManager?: ProjectManagerConfig;
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
  attachments?: TrackerAttachment[];
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
  | "AI TASK REVIEW"
  | "AI DECOMPOSITION"
  | "AI DIGEST";
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
  reviewStatus?: TaskIntakeReviewStatus;
  readinessScore?: number;
  rewrittenTitle?: string;
  rewrittenDescription?: string;
  acceptanceCriteria?: string[];
  clarificationQuestions?: string[];
  decompositionHints?: string[];
  sourceFingerprint?: string;
  expectedFiles?: string[];
  expectedSubsystems?: string[];
  riskFactors?: string[];
  missingContext?: string[];
  reasoning?: string;
  parentIssueKey?: string;
  createdIssueKeys?: string[];
  dryRun?: boolean;
  taskId?: string;
  digestKind?: string;
  externalKey?: string;
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

export type MergeRequestState = "opened" | "merged" | "closed" | (string & {});

export interface MergeRequestInfo {
  id: number;
  iid: number;
  url: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state?: MergeRequestState;
  mergedAt?: string;
  closedAt?: string;
  updatedAt?: string;
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
  findCandidateIssues(input?: {
    queue?: string;
    tag?: string;
    issueKey?: string;
  }): Promise<TrackerIssue[]>;
  findOwnedIssues(statuses: LogicalStatus[]): Promise<TrackerIssue[]>;
  getIssue(issueKey: string): Promise<TrackerIssue>;
  getComments(issueKey: string): Promise<CommentWithMetadata[]>;
  addComment(issueKey: string, text: string): Promise<void>;
  transition(issueKey: string, targetStatus: LogicalStatus): Promise<void>;
  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined;
  createIssue?(input: CreateTrackerIssueInput): Promise<TrackerIssue>;
  linkIssue?(input: LinkTrackerIssueInput): Promise<void>;
  getIssueLinks?(issueKey: string): Promise<TrackerIssueLink[]>;
  getIssueAttachments?(issueKey: string): Promise<TrackerAttachment[]>;
  downloadIssueAttachment?(
    issueKey: string,
    attachment: TrackerAttachment,
  ): Promise<Uint8Array>;
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
  findMergeRequestByBranch(sourceBranch: string): Promise<MergeRequestInfo | null>;
  findOpenMergeRequestByBranch(
    sourceBranch: string,
  ): Promise<MergeRequestInfo | null>;
  getMergeRequest(iid: number): Promise<MergeRequestInfo | null>;
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

export type CodexProgressEventKind =
  | "codex_agent_message"
  | "codex_command_started"
  | "codex_command_progress"
  | "codex_command_completed"
  | "codex_turn_completed"
  | "codex_error";

export interface CodexProgressEvent {
  kind: CodexProgressEventKind;
  mode: "new" | "resume" | "review";
  type: string;
  itemType?: string;
  itemStatus?: string;
  elapsedSeconds?: number;
  exitCode?: number;
  timedOut?: boolean;
  message?: string;
}

export type CodexRunObserver = (event: CodexProgressEvent) => void;

export interface CodexRunner {
  runInitial(
    prompt: string,
    observer?: CodexRunObserver,
    options?: CodexRunOptions,
  ): Promise<CodexExecution>;
  runFix(
    prompt: string,
    observer?: CodexRunObserver,
    options?: CodexRunOptions,
  ): Promise<CodexExecution>;
  runResume(
    threadId: string,
    prompt: string,
    observer?: CodexRunObserver,
    options?: CodexRunOptions,
  ): Promise<CodexExecution>;
  runReview(
    prompt: string,
    observer?: CodexRunObserver,
    options?: CodexReviewRunOptions,
  ): Promise<CodexExecution>;
}

export interface TaskAnalysisResult {
  status: "ready" | "clarification_required";
  threadId?: string;
  clarification?: ClarificationQuestion;
  decision?: TaskAnalysisDecision;
}

export type { ProjectManagerConfig, RepositoryProjectManagerConfig };

export type {
  AgentTaskContext,
  AgentRun,
  AgentRunInput,
  AgentRunStage,
  ArtifactRef,
  ArtifactRefInput,
  ApproveProposalInput,
  ClaimedTask,
  ClarificationQuestionInput,
  ClarificationQuestionRecord,
  ClaimRepositoryProfile,
  ClaimReviewTaskInput,
  ClaimTaskInput,
  CommentInput,
  CreateTaskInput,
  DecompositionDecisionRecord,
  ExportDigestInput,
  ExternalFieldOwnership,
  ExternalIssueSnapshot,
  ExternalTaskSource,
  ExternalTaskFieldUpdateInput,
  ExternalTransitionInput,
  HumanAnswerInput,
  HumanAnswerRecord,
  ImportCandidatesInput,
  ImportedHumanCommand,
  LeaseHeartbeatInput,
  LinkTaskDependencyInput,
  MemoryContextRecordInput,
  MemoryContextRef,
  MergeRequestRecord,
  MergeRequestRecordInput,
  EvidenceRef,
  ProposalCleanupInput,
  ProposalCleanupResult,
  ProposalPolicyDecision,
  ProposalPolicyEvaluation,
  ProposalSupervisorStatus,
  ProposeTaskInput,
  QualityGateRun,
  RejectProposalInput,
  ReleaseLeaseInput,
  ReviewMetadataRecord,
  ReviewMetadataRecordInput,
  TaskActor,
  TaskComment,
  TaskDecision,
  TaskDecisionInput,
  TaskDependency,
  TaskDependencyInput,
  TaskDependencyRecord,
  TaskEvent,
  TaskEventInput,
  TaskExternalRef,
  TaskExternalRefInput,
  TaskFieldGroup,
  TaskFieldOwner,
  TaskFieldOwnership,
  TaskMessageKind,
  TaskPlan,
  TaskLeaseRecord,
  TaskProposalRecord,
  TaskRecord,
  TaskRevision,
  TaskRevisionInput,
  TaskSource,
  TaskStatus,
  TaskStep,
  TaskStepRecordInput,
  TaskTrackerClient,
  SyncCursor,
  ValidationRecordInput,
} from "../domain/taskTracker/types.js";
