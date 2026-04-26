export type LogicalStatus =
  | "open"
  | "in_progress"
  | "waiting_for_answer"
  | "review"
  | "failed"
  | "done";

export interface TrackerStatusConfig {
  statuses: string[];
  transition?: string;
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
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
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
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
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
  | "AI LEASE";
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
}
