import type { TaskType } from "../../models/types.js";
import type { ProjectSignalSnapshot } from "./types.js";

export interface BuildProjectAnalysisPromptInput {
  snapshot: ProjectSignalSnapshot;
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
