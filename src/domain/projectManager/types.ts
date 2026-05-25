import type { AutonomyLevel, TaskType } from "../../models/types.js";
import type { EvidenceRef } from "../taskTracker/types.js";

export const PROJECT_ANALYSIS_MARKER = "PROJECT_ANALYSIS:";

export const PROJECT_GOAL_STATUSES = [
  "proposed",
  "approved",
  "active",
  "completed",
  "rejected",
  "stale",
] as const;

export type ProjectGoalStatus = (typeof PROJECT_GOAL_STATUSES)[number];

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

export interface ProjectAnalysis {
  id: string;
  repositoryName: string;
  summary: string;
  healthSignals: ProjectHealthSignal[];
  proposedGoals: ProjectGoalDraft[];
  staleGoalIds: string[];
  replanReason?: string;
  createdAt: string;
}

export interface ParsedProjectAnalysis {
  summary: string;
  healthSignals: ProjectHealthSignal[];
  proposedGoals: ProjectGoalDraft[];
  staleGoalIds: string[];
  replanReason?: string;
}

export interface ProjectManagerRun {
  id: string;
  repositoryName: string;
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
