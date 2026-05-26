import type { TaskType } from "../../models/types.js";
import type { ProjectSignalSnapshot } from "./types.js";
import {
  PROJECT_GOAL_REPLAN_DECISIONS,
  PROJECT_REPLAN_MARKER,
} from "./types.js";

export interface BuildProjectAnalysisPromptInput {
  snapshot: ProjectSignalSnapshot;
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
  allowedTaskTypes?: TaskType[];
  focusAreas?: string[];
  maxSnapshotChars?: number;
}

export interface ProjectReplanTaskSnapshot {
  id: string;
  title: string;
  status: string;
  repositoryName?: string;
  queue?: string;
  priority?: string;
  taskType?: string;
  updatedAt?: string;
  latestAiSummary?: string;
  latestValidationSummary?: string;
  mergeRequestUrl?: string;
  blockerReason?: string;
  failedAgentRuns?: number;
  failedValidations?: number;
}

export interface ProjectReplanGoalSnapshot {
  id: string;
  title: string;
  status: string;
  problemStatement?: string;
  desiredOutcome?: string;
  successMetrics?: string[];
  linkedTasks: ProjectReplanTaskSnapshot[];
}

export interface ProjectReplanSnapshot {
  repositoryName: string;
  generatedAt: string;
  replanReason: string;
  previousAnalysisId?: string;
  activeGoals: ProjectReplanGoalSnapshot[];
}

export interface BuildProjectReplanPromptInput {
  snapshot: ProjectReplanSnapshot;
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
  allowedTaskTypes?: TaskType[];
  focusAreas?: string[];
  maxSnapshotChars?: number;
}

const DEFAULT_MAX_GOALS_PER_RUN = 5;
const DEFAULT_MAX_TASK_PROPOSALS_PER_GOAL = 5;
const DEFAULT_ALLOWED_TASK_TYPES: TaskType[] = [
  "documentation",
  "tests_only",
  "dependency_update",
];
const DEFAULT_MAX_SNAPSHOT_CHARS = 12000;

const RESPONSE_SCHEMA = {
  summary: "string",
  healthSignals: [
    {
      kind: "string",
      severity: "low|medium|high|critical",
      title: "string",
      description: "string",
      evidenceRefs: [{ kind: "string", ref: "string", summary: "string" }],
      recommendation: "string",
    },
  ],
  proposedGoals: [
    {
      title: "string",
      problemStatement: "string",
      desiredOutcome: "string",
      successMetrics: ["string"],
      evidenceRefs: [{ kind: "string", ref: "string", summary: "string" }],
      priority: "low|normal|high|critical",
      riskLevel: "low|medium|high",
      suggestedTaskProposals: [
        {
          title: "string",
          description: "string",
          taskType: "allowed task type",
          acceptanceCriteria: ["string"],
          expectedBlastRadius: "string",
          evidenceRefs: [{ kind: "string", ref: "string", summary: "string" }],
        },
      ],
    },
  ],
  staleGoalIds: ["string"],
  replanReason: "string optional",
};

const REPLAN_RESPONSE_SCHEMA = {
  previousAnalysisId: "string optional",
  summary: "string",
  healthSignals: RESPONSE_SCHEMA.healthSignals,
  proposedGoals: RESPONSE_SCHEMA.proposedGoals,
  staleGoalIds: ["string"],
  replanReason: "string",
  goalReplans: [
    {
      goalId: "string",
      decision: PROJECT_GOAL_REPLAN_DECISIONS.join("|"),
      rationale: "string",
      evidenceRefs: [{ kind: "string", ref: "string", summary: "string" }],
      followUpGoals: RESPONSE_SCHEMA.proposedGoals,
      humanQuestion: "string required when decision is ask_human",
    },
  ],
};

const truncateSnapshot = (snapshotJson: string, maxChars: number): string => {
  if (snapshotJson.length <= maxChars) {
    return snapshotJson;
  }
  return `${snapshotJson.slice(0, maxChars)}[snapshot truncated at ${maxChars} chars]`;
};

export const buildProjectAnalysisPrompt = (
  input: BuildProjectAnalysisPromptInput,
): string => {
  const maxGoalsPerRun = input.maxGoalsPerRun ?? DEFAULT_MAX_GOALS_PER_RUN;
  const maxTaskProposalsPerGoal =
    input.maxTaskProposalsPerGoal ?? DEFAULT_MAX_TASK_PROPOSALS_PER_GOAL;
  const allowedTaskTypes =
    input.allowedTaskTypes ?? DEFAULT_ALLOWED_TASK_TYPES;
  const maxSnapshotChars =
    input.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
  const snapshotJson = truncateSnapshot(
    JSON.stringify(input.snapshot),
    maxSnapshotChars,
  );
  const focusAreas =
    input.focusAreas && input.focusAreas.length > 0
      ? input.focusAreas.join(", ")
      : "none";

  return [
    "Mode: project-management-analysis-only",
    "",
    "Analyze repository project health from the provided task snapshot.",
    "Guardrails:",
    "- Analyze only the provided snapshot.",
    "- Do not modify files.",
    "- Do not create executable tasks directly.",
    "- Do not call external services.",
    "- Evidence-backed goals only.",
    "- Obey limits.",
    "- task proposals must use allowed task types.",
    "",
    `Limits: maxGoalsPerRun=${maxGoalsPerRun}, maxTaskProposalsPerGoal=${maxTaskProposalsPerGoal}.`,
    `Allowed task types: ${allowedTaskTypes.join(", ")}`,
    `Focus areas: ${focusAreas}`,
    "",
    "Required output:",
    "Reply with exactly one line starting with PROJECT_ANALYSIS: followed by compact JSON matching this schema.",
    JSON.stringify(RESPONSE_SCHEMA),
    "",
    "Snapshot:",
    snapshotJson,
  ].join("\n");
};

export const buildProjectReplanPrompt = (
  input: BuildProjectReplanPromptInput,
): string => {
  const maxGoalsPerRun = input.maxGoalsPerRun ?? DEFAULT_MAX_GOALS_PER_RUN;
  const maxTaskProposalsPerGoal =
    input.maxTaskProposalsPerGoal ?? DEFAULT_MAX_TASK_PROPOSALS_PER_GOAL;
  const allowedTaskTypes =
    input.allowedTaskTypes ?? DEFAULT_ALLOWED_TASK_TYPES;
  const maxSnapshotChars =
    input.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
  const snapshotJson = truncateSnapshot(
    JSON.stringify(input.snapshot),
    maxSnapshotChars,
  );
  const focusAreas =
    input.focusAreas && input.focusAreas.length > 0
      ? input.focusAreas.join(", ")
      : "none";
  const activeGoalIds = input.snapshot.activeGoals.map((goal) => goal.id);

  return [
    "Mode: project-management-replan-only",
    "",
    "Replan active repository project goals from the provided snapshot.",
    "Guardrails:",
    "- Analyze only the provided snapshot.",
    "- Do not modify files.",
    "- Do not create executable tasks directly.",
    "- Do not call external services.",
    "- Classify only active goals listed in the snapshot.",
    "- Use linked task data as evidence for each classification.",
    "- Obey limits.",
    "- follow-up task proposals must use allowed task types.",
    "",
    `Limits: maxGoalsPerRun=${maxGoalsPerRun}, maxTaskProposalsPerGoal=${maxTaskProposalsPerGoal}.`,
    `Allowed task types: ${allowedTaskTypes.join(", ")}`,
    `Focus areas: ${focusAreas}`,
    `Replan reason: ${input.snapshot.replanReason}`,
    `Active goal ids: ${activeGoalIds.join(", ") || "none"}`,
    "",
    "Required output:",
    `Reply with exactly one line starting with ${PROJECT_REPLAN_MARKER} followed by compact JSON matching this schema.`,
    JSON.stringify(REPLAN_RESPONSE_SCHEMA),
    "",
    "Linked task data:",
    snapshotJson,
  ].join("\n");
};
