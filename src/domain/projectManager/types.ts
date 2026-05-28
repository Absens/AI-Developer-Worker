import type { AutonomyLevel, TaskType } from "../../models/types.js";
import type { EvidenceRef, TaskActor } from "../taskTracker/types.js";

export const PROJECT_ANALYSIS_MARKER = "PROJECT_ANALYSIS:";
export const PROJECT_REPLAN_MARKER = "PROJECT_REPLAN:";
export const PROJECT_STRATEGY_MARKER = "PROJECT_STRATEGY:";

export const PROJECT_MANAGER_MODES = ["analysis", "replan", "strategy"] as const;
export type ProjectManagerMode = (typeof PROJECT_MANAGER_MODES)[number];

export const PROJECT_ANALYSIS_KINDS = ["analysis", "replan", "strategy"] as const;
export type ProjectAnalysisKind = (typeof PROJECT_ANALYSIS_KINDS)[number];

export const PROJECT_STRATEGY_LENSES = [
  "strategy",
  "reframing",
  "empathy",
  "execution",
  "risk",
  "architecture",
  "synthesis",
] as const;
export type ProjectStrategyLens = (typeof PROJECT_STRATEGY_LENSES)[number];

export const PROJECT_STRATEGY_DIMENSIONS = [
  "product",
  "technical",
  "product_technical",
] as const;
export type ProjectStrategyDimension =
  (typeof PROJECT_STRATEGY_DIMENSIONS)[number];

export const PROJECT_STRATEGY_NEXT_STEPS = [
  "create_goal",
  "research",
  "ask_human",
  "defer",
] as const;
export type ProjectStrategyRecommendedNextStep =
  (typeof PROJECT_STRATEGY_NEXT_STEPS)[number];

export const PROJECT_STRATEGY_ARCHITECT_VERDICTS = [
  "pursue",
  "research_first",
  "defer",
  "reject",
] as const;
export type ProjectStrategyArchitectVerdict =
  (typeof PROJECT_STRATEGY_ARCHITECT_VERDICTS)[number];

export const PROJECT_GOAL_REPLAN_DECISIONS = [
  "continue",
  "split",
  "pause",
  "mark_completed",
  "create_follow_up",
  "ask_human",
] as const;

export type ProjectGoalReplanDecision =
  (typeof PROJECT_GOAL_REPLAN_DECISIONS)[number];

export const PROJECT_GOAL_STATUSES = [
  "proposed",
  "approved",
  "active",
  "completed",
  "rejected",
  "stale",
] as const;

export type ProjectGoalStatus = (typeof PROJECT_GOAL_STATUSES)[number];

export const PROJECT_GOAL_TERMINAL_STATUSES = [
  "completed",
  "rejected",
  "stale",
] as const satisfies readonly ProjectGoalStatus[];

export type ProjectGoalTerminalStatus =
  (typeof PROJECT_GOAL_TERMINAL_STATUSES)[number];

export const isTerminalProjectGoalStatus = (
  status: ProjectGoalStatus,
): status is ProjectGoalTerminalStatus =>
  PROJECT_GOAL_TERMINAL_STATUSES.includes(status as ProjectGoalTerminalStatus);

export const PROJECT_GOAL_PRIORITIES = [
  "low",
  "normal",
  "high",
  "critical",
] as const;

export type ProjectGoalPriority = (typeof PROJECT_GOAL_PRIORITIES)[number];

export const PROJECT_GOAL_RISK_LEVELS = ["low", "medium", "high"] as const;

export type ProjectGoalRiskLevel = (typeof PROJECT_GOAL_RISK_LEVELS)[number];

export const PROJECT_HEALTH_SIGNAL_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type ProjectHealthSignalSeverity =
  (typeof PROJECT_HEALTH_SIGNAL_SEVERITIES)[number];

export const PROJECT_MANAGER_TRIGGERS = [
  "manual",
  "schedule",
  "post_task_event",
] as const;

export type ProjectManagerTrigger = (typeof PROJECT_MANAGER_TRIGGERS)[number];

export interface ProjectTaskProposalDraft {
  title: string;
  description: string;
  taskType: TaskType;
  acceptanceCriteria: string[];
  expectedBlastRadius?: string;
  evidenceRefs: EvidenceRef[];
}

export interface ProjectHealthSignal {
  kind: string;
  severity: ProjectHealthSignalSeverity;
  title: string;
  description: string;
  evidenceRefs: EvidenceRef[];
  recommendation?: string;
}

export interface ProjectGoalDraft {
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  successMetrics: string[];
  evidenceRefs: EvidenceRef[];
  priority: ProjectGoalPriority;
  riskLevel: ProjectGoalRiskLevel;
  suggestedTaskProposals: ProjectTaskProposalDraft[];
}

export interface ProjectStrategyLensSummary {
  lens: ProjectStrategyLens;
  summary: string;
}

export interface ProjectStrategyOpportunity {
  opportunityId: string;
  dimension: ProjectStrategyDimension;
  title: string;
  problemStatement: string;
  userOrBusinessImpact: string;
  technicalImpact: string;
  evidenceRefs: EvidenceRef[];
  confidence: number;
  priority: ProjectGoalPriority;
  riskLevel: ProjectGoalRiskLevel;
  recommendedNextStep: ProjectStrategyRecommendedNextStep;
  rationale: string;
  redTeamNotes: string[];
  architectVerdict: ProjectStrategyArchitectVerdict;
}

export interface ProjectStrategyProposedGoalDraft extends ProjectGoalDraft {
  sourceOpportunityId: string;
}

export interface ProjectStrategyQuestion {
  question: string;
  whyItMatters: string;
  relatedOpportunityId?: string;
  relatedOpportunityTitle?: string;
}

export interface ProjectStrategyGoalLink {
  sourceOpportunityId: string;
  proposedGoalTitle: string;
  evidenceRefs: EvidenceRef[];
}

export interface ParsedProjectStrategyAnalysis {
  summary: string;
  analysisLenses: ProjectStrategyLensSummary[];
  opportunities: ProjectStrategyOpportunity[];
  proposedGoals: ProjectStrategyProposedGoalDraft[];
  questionsForHuman: ProjectStrategyQuestion[];
}

export interface ProjectGoalReplanClassification {
  goalId: string;
  decision: ProjectGoalReplanDecision;
  rationale: string;
  evidenceRefs: EvidenceRef[];
  followUpGoals: ProjectGoalDraft[];
  humanQuestion?: string;
}

export interface ProjectGoal extends ProjectGoalDraft {
  id: string;
  sourceAnalysisId: string;
  sourceRunId?: string;
  repositoryName: string;
  status: ProjectGoalStatus;
  duplicateSignature: string;
  approvedBy?: TaskActor;
  approvedAt?: string;
  activatedBy?: TaskActor;
  activatedAt?: string;
  completedBy?: TaskActor;
  completedAt?: string;
  rejectedBy?: TaskActor;
  rejectedAt?: string;
  rejectionReason?: string;
  staleBy?: TaskActor;
  staleAt?: string;
  staleReason?: string;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_GOAL_AUDIT_EVENT_KINDS = [
  "project_goal_created",
  "project_goal_approved",
  "project_goal_activated",
  "project_goal_completed",
  "project_goal_rejected",
  "project_goal_stale",
  "project_goal_replan_classified",
] as const;

export type ProjectGoalAuditEventKind =
  (typeof PROJECT_GOAL_AUDIT_EVENT_KINDS)[number];

export interface ProjectGoalAuditEvent {
  id: string;
  goalId: string;
  kind: ProjectGoalAuditEventKind;
  actor?: TaskActor;
  message?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectGoalTaskLink {
  id: string;
  goalId: string;
  taskId: string;
  linkType: string;
  createdAt: string;
}

export interface ListProjectGoalsInput {
  repositoryName?: string;
  sourceAnalysisId?: string;
  status?: ProjectGoalStatus | ProjectGoalStatus[];
}

export interface CreateProjectGoalsFromAnalysisInput {
  sourceAnalysisId: string;
  sourceRunId?: string;
  repositoryName: string;
  goals: ProjectGoalDraft[];
}

export interface ApproveProjectGoalInput {
  actor: TaskActor;
}

export interface ActivateProjectGoalInput {
  actor: TaskActor;
}

export interface CompleteProjectGoalInput {
  actor: TaskActor;
}

export interface RejectProjectGoalInput {
  actor: TaskActor;
  rejectionReason: string;
}

export interface MarkProjectGoalStaleInput {
  actor?: TaskActor;
  staleReason: string;
}

export interface LinkProjectGoalTaskInput {
  goalId: string;
  taskId: string;
  linkType: string;
}

export interface ProjectAnalysis {
  id: string;
  repositoryName: string;
  analysisKind: ProjectAnalysisKind;
  summary: string;
  healthSignals: ProjectHealthSignal[];
  proposedGoals: ProjectGoalDraft[];
  staleGoalIds: string[];
  previousAnalysisId?: string;
  replanReason?: string;
  goalReplans: ProjectGoalReplanClassification[];
  strategyAnalysisLenses: ProjectStrategyLensSummary[];
  strategyOpportunities: ProjectStrategyOpportunity[];
  strategyGoalLinks: ProjectStrategyGoalLink[];
  strategyQuestions: ProjectStrategyQuestion[];
  strategyBrief?: string;
  createdAt: string;
}

export interface ParsedProjectAnalysis {
  summary: string;
  healthSignals: ProjectHealthSignal[];
  proposedGoals: ProjectGoalDraft[];
  staleGoalIds: string[];
  previousAnalysisId?: string;
  replanReason?: string;
  goalReplans: ProjectGoalReplanClassification[];
}

export interface ProjectManagerRun {
  id: string;
  repositoryName: string;
  mode: ProjectManagerMode;
  trigger: ProjectManagerTrigger;
  status: "started" | "completed" | "failed";
  analysisId?: string;
  proposedGoalIds: string[];
  proposedTaskIds: string[];
  diagnostic?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ProjectManagerConfig {
  enabled: boolean;
  focusAreas?: string[];
  runOnce: boolean;
  intervalMinutes: number;
  maxGoalsPerRun: number;
  maxTaskProposalsPerGoal: number;
  defaultAutonomyLevel: AutonomyLevel;
  autoApproveLowRisk: boolean;
  allowedTaskTypes: TaskType[];
  repositoryScanEnabled: boolean;
  repositoryScanMaxFiles: number;
  requireHumanGoalApproval: boolean;
}

export interface RepositoryProjectManagerConfig {
  enabled?: boolean;
  focusAreas?: string[];
  allowedTaskTypes?: TaskType[];
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
}

export interface ProjectTaskSignal {
  id: string;
  title: string;
  status: string;
  repositoryName?: string;
  queue?: string;
  priority?: string;
  taskType?: string;
  updatedAt: string;
  latestAiSummary?: string;
  latestValidationSummary?: string;
  mergeRequestUrl?: string;
  blockerReason?: string;
  failedAgentRuns: number;
  failedValidations: number;
}

export interface ProjectSignalSnapshot {
  repositoryName: string;
  generatedAt: string;
  totalTasks: number;
  statusCounts: Record<string, number>;
  activeLeases: number;
  readyTasks: ProjectTaskSignal[];
  failedTasks: ProjectTaskSignal[];
  waitingForHuman: ProjectTaskSignal[];
  repeatedFailures: ProjectTaskSignal[];
  recentReviewTasks: ProjectTaskSignal[];
}

export interface ProjectStrategySnapshot {
  repositoryName: string;
  generatedAt: string;
  strategyBrief?: string;
  projectSignals: ProjectSignalSnapshot;
  recentAnalyses: ProjectAnalysis[];
  goals: ProjectGoal[];
  proposalBacklog: {
    proposed: number;
    approved: number;
    autoApproved: number;
    rejected: number;
    stale: number;
  };
  taskTypeSummary: {
    counts: Partial<Record<TaskType, number>>;
    unknownTaskTypeCount: number;
  };
  repositoryProfile: {
    tags: string[];
    focusAreas: string[];
    allowedProjectManagerTaskTypes: TaskType[];
  };
  productContext: {
    knownUsersOrRoles: string[];
    knownWorkflows: string[];
    knownProductSignals: string[];
    missingProductSignals: string[];
  };
}
