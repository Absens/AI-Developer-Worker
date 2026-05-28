export type TaskStatusDto =
  | 'new'
  | 'triage'
  | 'ready'
  | 'claimed'
  | 'analyzing'
  | 'awaiting_human'
  | 'decomposing'
  | 'implementing'
  | 'validating'
  | 'review'
  | 'human_testing'
  | 'fixing_review'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export type SessionRoleDto = 'viewer' | 'developer' | 'operator' | 'admin';
export type SessionAuthModeDto = 'trusted_proxy' | 'bearer' | 'localhost';
export type SessionServiceDto = 'human' | 'system' | 'agent' | 'localhost' | 'anonymous';

export interface SessionDto {
  user: {
    id: string;
    displayName?: string;
    service: SessionServiceDto;
  };
  role: SessionRoleDto;
  authMode: SessionAuthModeDto;
  capabilities: Record<string, boolean>;
  apiPath: string;
  uiPath: string;
  generatedAt: string;
}

export interface ApiErrorDto {
  status: 'error';
  error: string;
  details?: unknown;
}

export interface TaskListResponseDto {
  tasks: TaskSummaryDto[];
  role: SessionRoleDto;
  generatedAt: string;
}

export interface TaskSummaryDto {
  id: string;
  title: string;
  status: TaskStatusDto;
  repositoryName?: string;
  repoPathKey?: string;
  queue?: string;
  priority?: string;
  activeWorker?: string;
  blockerReason?: string;
  latestAiSummary?: string;
  latestValidationSummary?: string;
  mergeRequestUrl?: string;
  branch?: string;
  tags?: string[];
  updatedAt: string;
}

export interface CreateTaskRequestDto {
  title: string;
  description: string;
  humanSummary?: string;
  repositoryName?: string;
  repoPathKey?: string;
  baseBranch?: string;
  queue?: string;
  priority?: string;
  tags?: string[];
  components?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  riskFactors?: string[];
  missingContext?: string[];
  taskType?:
    | 'frontend_ui_fix'
    | 'backend_endpoint'
    | 'tests_only'
    | 'refactor'
    | 'dependency_update'
    | 'documentation';
  promptProfileId?: string;
  status?: TaskStatusDto;
  idempotencyKey?: string;
}

export interface CreateTaskResponseDto {
  task: TaskDetailDto;
  idempotent: boolean;
}

export interface TaskDetailResponseDto {
  task: TaskDetailDto;
  summary: TaskSummaryDto;
  activeLeases: LeaseDto[];
  children: ChildTaskSummaryDto[];
  latestValidation?: ValidationSummaryDto;
  latestMergeRequest?: MergeRequestSummaryDto;
  diagnostics: TaskDiagnosticsDto;
  projectGoals?: ProjectGoalSummaryDto[];
}

export interface TaskDetailDto extends TaskSummaryDto {
  description: string;
  humanSummary?: string;
  acceptanceCriteria: string[];
  constraints: string[];
  riskFactors: string[];
  missingContext: string[];
  baseBranch?: string;
  businessStatus?: string;
  createdAt: string;
  createdBy?: ActorDto;
  clarificationQuestions: ClarificationQuestionDto[];
  humanAnswers: HumanAnswerDto[];
  comments: TaskCommentDto[];
  events: TimelineEventDto[];
}

export interface ActorDto {
  owner: string;
  id: string;
  displayName?: string;
}

export interface LeaseDto {
  id: string;
  kind: string;
  taskId?: string;
  repositoryName?: string;
  workerId: string;
  expiresAt: string;
  heartbeatAt?: string;
  releasedAt?: string;
}

export interface ValidationSummaryDto {
  id?: string;
  workerId?: string;
  status: string;
  summary?: string;
  diagnostic?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface MergeRequestSummaryDto {
  id?: string | number;
  iid?: string | number;
  url?: string;
  title?: string;
  branch?: string;
  sourceBranch?: string;
  targetBranch?: string;
  outcome?: string;
  createdAt: string;
}

export interface ClarificationQuestionDto {
  id: string;
  summary?: string;
  blockingReason?: string;
  question: string;
  options?: string[];
  resumeHint?: string;
  createdAt: string;
}

export interface HumanAnswerDto {
  id: string;
  questionId?: string;
  author?: ActorDto;
  body: string;
  command?: unknown;
  createdAt: string;
}

export interface TaskCommentDto {
  id: string;
  author?: ActorDto;
  body: string;
  createdAt: string;
}

export interface TimelineEventDto {
  id?: string;
  kind: string;
  source?: string;
  actor?: ActorDto;
  message?: string;
  createdAt: string;
}

export interface ChildTaskSummaryDto extends TaskSummaryDto {
  dependencyReason?: string;
  externalMirrorStatus?: 'mirrored' | 'internal_only' | string;
}

export interface TaskDiagnosticsDto {
  latestFailure?: unknown;
  failedRuns?: unknown[];
  repeatedValidationFailures: number;
}

export interface CommandResponseDto {
  task: TaskDetailDto;
}

export interface TaskConversationResponseDto {
  comments: TaskCommentDto[];
  questions: ClarificationQuestionDto[];
  answers: HumanAnswerDto[];
}

export interface AnswerTaskRequestDto {
  questionId?: string;
  body: string;
  command?: unknown;
}

export interface ProposalListResponseDto {
  proposals: ProposalSummaryDto[];
  role: SessionRoleDto;
  generatedAt: string;
}

export interface ProposalSummaryDto extends TaskSummaryDto {
  proposal: {
    supervisorStatus: 'proposed' | 'approved' | 'rejected' | string;
    approvalPolicy?: string;
    autonomyLevel?: string;
    proposedBy?: string;
    proposalReason?: string;
    policyDecision?: string;
    policyReason?: string;
    evidenceRefs?: EvidenceRefDto[];
    suggestedAcceptanceCriteria?: string[];
    createdAt: string;
  };
  projectGoals?: ProjectGoalSummaryDto[];
}

export interface EvidenceRefDto {
  kind: string;
  ref: string;
  summary?: string;
}

export type ProjectGoalStatusDto =
  | 'proposed'
  | 'approved'
  | 'active'
  | 'completed'
  | 'rejected'
  | 'stale';
export type ProjectGoalPriorityDto = 'low' | 'normal' | 'high' | 'critical';
export type ProjectGoalRiskLevelDto = 'low' | 'medium' | 'high';
export type ProjectAnalysisKindDto = 'analysis' | 'replan' | 'strategy';
export type ProjectStrategyDimensionDto = 'product' | 'technical' | 'product_technical';
export type ProjectStrategyNextStepDto = 'create_goal' | 'research' | 'ask_human' | 'defer';
export type ProjectStrategyArchitectVerdictDto = 'pursue' | 'research_first' | 'defer' | 'reject';

export interface ProjectStrategyLensSummaryDto {
  lens: string;
  summary: string;
}

export interface ProjectStrategyOpportunityDto {
  opportunityId: string;
  dimension: ProjectStrategyDimensionDto;
  title: string;
  problemStatement: string;
  userOrBusinessImpact: string;
  technicalImpact: string;
  evidenceRefs: EvidenceRefDto[];
  confidence: number;
  priority: ProjectGoalPriorityDto;
  riskLevel: ProjectGoalRiskLevelDto;
  recommendedNextStep: ProjectStrategyNextStepDto;
  rationale: string;
  redTeamNotes: string[];
  architectVerdict: ProjectStrategyArchitectVerdictDto;
}

export interface ProjectStrategyGoalLinkDto {
  sourceOpportunityId: string;
  proposedGoalTitle: string;
  evidenceRefs: EvidenceRefDto[];
}

export interface ProjectStrategyQuestionDto {
  question: string;
  whyItMatters: string;
  relatedOpportunityId?: string;
  relatedOpportunityTitle?: string;
}

export interface ProjectStrategyAnalysisDto {
  summary: string;
  analysisLenses: ProjectStrategyLensSummaryDto[];
  opportunities: ProjectStrategyOpportunityDto[];
  goalLinks: ProjectStrategyGoalLinkDto[];
  questionsForHuman: ProjectStrategyQuestionDto[];
}

export interface ProjectAnalysisDto {
  id: string;
  repositoryName: string;
  analysisKind: ProjectAnalysisKindDto;
  summary: string;
  strategy?: ProjectStrategyAnalysisDto;
  createdAt: string;
}

export interface ProjectAnalysisListResponseDto {
  analyses: ProjectAnalysisDto[];
}

export interface ProjectGoalDto {
  id: string;
  sourceAnalysisId: string;
  sourceRunId?: string;
  repositoryName: string;
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  successMetrics: string[];
  evidenceRefs: EvidenceRefDto[];
  status: ProjectGoalStatusDto;
  priority: ProjectGoalPriorityDto;
  riskLevel: ProjectGoalRiskLevelDto;
  suggestedTaskProposals: ProjectTaskProposalDraftDto[];
  approvedAt?: string;
  activatedAt?: string;
  completedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  staleAt?: string;
  staleReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskProposalDraftDto {
  title: string;
  description: string;
  taskType: string;
  acceptanceCriteria: string[];
  expectedBlastRadius?: string;
  evidenceRefs: EvidenceRefDto[];
}

export interface ProjectGoalSummaryDto {
  id: string;
  title: string;
  status: ProjectGoalStatusDto;
  priority: ProjectGoalPriorityDto;
  riskLevel: ProjectGoalRiskLevelDto;
  repositoryName: string;
}

export interface ProjectGoalAuditEventDto {
  id: string;
  goalId: string;
  kind: string;
  actor?: ActorDto;
  message?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectGoalTaskLinkDto {
  id: string;
  goalId: string;
  taskId: string;
  linkType: string;
  createdAt: string;
}

export interface ProjectGoalListResponseDto {
  goals: ProjectGoalDto[];
  linkedTaskCounts: Record<string, number>;
  role: SessionRoleDto;
  generatedAt: string;
}

export interface ProjectGoalDetailResponseDto {
  goal: ProjectGoalDto;
  auditEvents: ProjectGoalAuditEventDto[];
  taskLinks: ProjectGoalTaskLinkDto[];
  linkedTasks: TaskSummaryDto[];
}

export interface ProjectGoalCommandResponseDto {
  goal: ProjectGoalDto;
}

export interface ProjectGoalProposeTasksResponseDto {
  goal: ProjectGoalDto;
  tasks: TaskDetailDto[];
  proposals: unknown[];
  taskLinks: ProjectGoalTaskLinkDto[];
}

export interface OperationsSnapshotDto {
  workers: WorkerSnapshotDto[];
  leases: LeaseDto[];
  repositories: string[];
  queueDepth: QueueDepthDto[];
  failedTasks: TaskSummaryDto[];
  repeatedFailures: TaskSummaryDto[];
  waitingForHuman: TaskSummaryDto[];
  taskDiagnostics?: OperationTaskDiagnosticDto[];
  generatedAt: string;
}

export interface WorkerSnapshotDto {
  workerId: string;
  state: string;
  repositoryName?: string;
  currentTaskId?: string;
  currentIssueKey?: string;
  issueKey?: string;
  currentStage?: string;
  stage?: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  updatedAt?: string;
  lastErrorSummary?: string;
  activeLeaseAgeSeconds?: number;
}

export interface QueueDepthDto {
  repositoryName: string;
  queue: string;
  status: string;
  priority?: string;
  depth: number;
}

export interface OperationTaskDiagnosticDto {
  taskId: string;
  latestFailedAgentRun?: OperationAgentRunSummaryDto;
  latestValidation?: OperationValidationSummaryDto;
  latestQuestion?: OperationQuestionSummaryDto;
  failedAgentRuns: number;
  repeatedValidationFailures: number;
  recentEvents: OperationEventSummaryDto[];
  updatedAt: string;
}

export interface OperationAgentRunSummaryDto {
  id?: string;
  workerId?: string;
  stage?: string;
  status?: string;
  exitCode?: number;
  timedOut?: boolean;
  finalMessage?: string;
  diagnostic?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OperationValidationSummaryDto {
  id?: string;
  workerId?: string;
  status: string;
  changed?: boolean;
  testsPassed?: boolean;
  lintPassed?: boolean;
  summary?: string;
  diagnostic?: string;
  createdAt: string;
}

export interface OperationQuestionSummaryDto {
  id: string;
  summary?: string;
  blockingReason?: string;
  question?: string;
  createdAt: string;
}

export interface OperationEventSummaryDto {
  id?: string;
  kind: string;
  source?: string;
  message?: string;
  createdAt: string;
}

export interface AgentContextPreviewResponseDto {
  agentContext: unknown;
}
