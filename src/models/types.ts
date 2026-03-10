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
  trackerTag: string;
  trackerStatusMap: Record<LogicalStatus, TrackerStatusConfig>;
  trackerApiBaseUrl: string;
  gitlabUrl: string;
  gitlabToken: string;
  gitlabProjectId: string;
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
  codexQuestionMarker: string;
  maxFixAttempts: number;
  workerId: string;
  testCommand: string;
  lintCommand: string;
  runOnce: boolean;
}

export interface TrackerIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  createdAt?: string;
  updatedAt?: string;
  statusKey?: string;
  statusDisplay?: string;
  logicalStatus?: LogicalStatus;
}

export interface TrackerComment {
  id: string;
  text: string;
  createdAt: string;
  author?: string;
  isSystem: boolean;
}

export type ServiceCommentKind = "AI STATUS" | "AI QUESTION" | "AI MR";

export interface ParsedServiceComment {
  kind: ServiceCommentKind;
  worker: string;
  state?: LogicalStatus;
  details?: string;
  question?: string;
  threadId?: string;
  url?: string;
  branch?: string;
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
}

export interface ValidationResult {
  changed: boolean;
  testsPassed: boolean;
  lintPassed: boolean;
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

export interface TrackerClient {
  findCandidateIssues(): Promise<TrackerIssue[]>;
  findOwnedIssues(statuses: LogicalStatus[]): Promise<TrackerIssue[]>;
  getIssue(issueKey: string): Promise<TrackerIssue>;
  getComments(issueKey: string): Promise<CommentWithMetadata[]>;
  addComment(issueKey: string, text: string): Promise<void>;
  transition(issueKey: string, targetStatus: LogicalStatus): Promise<void>;
  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined;
}

export interface GitService {
  getCurrentBranch(): Promise<string>;
  hasChanges(): Promise<boolean>;
  hasDiffFromBase(): Promise<boolean>;
  syncBaseBranch(): Promise<void>;
  checkoutTaskBranch(issueKey: string): Promise<string>;
  commit(message: string): Promise<void>;
  push(branch: string): Promise<void>;
}

export interface GitLabService {
  findOpenMergeRequestByBranch(
    sourceBranch: string,
  ): Promise<MergeRequestInfo | null>;
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
}

export interface CodexRunner {
  runInitial(prompt: string): Promise<CodexExecution>;
  runFix(prompt: string): Promise<CodexExecution>;
  runResume(threadId: string, prompt: string): Promise<CodexExecution>;
}
