import type { TaskType } from "../../models/types.js";
import { EVIDENCE_REF_KINDS } from "../taskTracker/types.js";
import type { ProjectReplanSnapshot } from "./replanSnapshot.js";
import type { ProjectStrategySnapshot } from "./strategySnapshot.js";
import type { ProjectSignalSnapshot } from "./types.js";
import {
  PROJECT_GOAL_REPLAN_DECISIONS,
  PROJECT_REPLAN_MARKER,
  PROJECT_STRATEGY_ARCHITECT_VERDICTS,
  PROJECT_STRATEGY_DIMENSIONS,
  PROJECT_STRATEGY_LENSES,
  PROJECT_STRATEGY_MARKER,
  PROJECT_STRATEGY_NEXT_STEPS,
} from "./types.js";

export interface BuildProjectAnalysisPromptInput {
  snapshot: ProjectSignalSnapshot;
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
  allowedTaskTypes?: TaskType[];
  focusAreas?: string[];
  maxSnapshotChars?: number;
}

export interface BuildProjectReplanPromptInput {
  snapshot: ProjectReplanSnapshot;
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
  allowedTaskTypes?: TaskType[];
  focusAreas?: string[];
  maxSnapshotChars?: number;
}

export interface BuildProjectStrategyPromptInput {
  snapshot: ProjectStrategySnapshot;
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
const ALLOWED_EVIDENCE_REF_KINDS = EVIDENCE_REF_KINDS.join("|");
const ALL_TASK_TYPES = [
  "frontend_ui_fix",
  "backend_endpoint",
  "tests_only",
  "refactor",
  "dependency_update",
  "documentation",
  "unknown",
] as const;

const RESPONSE_SCHEMA = {
  summary: "string",
  healthSignals: [
    {
      kind: "string",
      severity: "low|medium|high|critical",
      title: "string",
      description: "string",
      evidenceRefs: [
        { kind: ALLOWED_EVIDENCE_REF_KINDS, ref: "string", summary: "string" },
      ],
      recommendation: "string",
    },
  ],
  proposedGoals: [
    {
      title: "string",
      problemStatement: "string",
      desiredOutcome: "string",
      successMetrics: ["string"],
      evidenceRefs: [
        { kind: ALLOWED_EVIDENCE_REF_KINDS, ref: "string", summary: "string" },
      ],
      priority: "low|normal|high|critical",
      riskLevel: "low|medium|high",
      suggestedTaskProposals: [
        {
          title: "string",
          description: "string",
          taskType: "allowed task type",
          acceptanceCriteria: ["string"],
          expectedBlastRadius: "string",
          evidenceRefs: [
            { kind: ALLOWED_EVIDENCE_REF_KINDS, ref: "string", summary: "string" },
          ],
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
      evidenceRefs: [
        { kind: ALLOWED_EVIDENCE_REF_KINDS, ref: "string", summary: "string" },
      ],
      followUpGoals: RESPONSE_SCHEMA.proposedGoals,
      humanQuestion: "string required when decision is ask_human",
    },
  ],
};

const STRATEGY_RESPONSE_SCHEMA = {
  summary: "string",
  analysisLenses: [
    {
      lens: PROJECT_STRATEGY_LENSES.join("|"),
      summary: "short audit summary only",
    },
  ],
  opportunities: [
    {
      opportunityId: "string",
      dimension: PROJECT_STRATEGY_DIMENSIONS.join("|"),
      title: "string",
      problemStatement: "string",
      userOrBusinessImpact: "string",
      technicalImpact: "string",
      evidenceRefs: [
        { kind: ALLOWED_EVIDENCE_REF_KINDS, ref: "string", summary: "string" },
      ],
      confidence: "integer 0-100",
      priority: "low|normal|high|critical",
      riskLevel: "low|medium|high",
      recommendedNextStep: PROJECT_STRATEGY_NEXT_STEPS.join("|"),
      rationale: "string",
      redTeamNotes: ["string"],
      architectVerdict: PROJECT_STRATEGY_ARCHITECT_VERDICTS.join("|"),
    },
  ],
  proposedGoals: [
    {
      sourceOpportunityId: "string",
      ...RESPONSE_SCHEMA.proposedGoals[0],
    },
  ],
  questionsForHuman: [
    {
      question: "string",
      whyItMatters: "string",
      relatedOpportunityId: "string optional",
      relatedOpportunityTitle: "string optional",
    },
  ],
};

const stringArrayJsonSchema = {
  type: "array",
  items: { type: "string" },
};

const evidenceRefJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "ref"],
  properties: {
    kind: { type: "string", enum: [...EVIDENCE_REF_KINDS] },
    ref: { type: "string", minLength: 1 },
    summary: { type: "string" },
  },
};

const evidenceRefsJsonSchema = {
  type: "array",
  items: evidenceRefJsonSchema,
};

const taskProposalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "description",
    "taskType",
    "acceptanceCriteria",
    "evidenceRefs",
  ],
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    taskType: { type: "string", enum: [...ALL_TASK_TYPES] },
    acceptanceCriteria: stringArrayJsonSchema,
    expectedBlastRadius: { type: "string" },
    evidenceRefs: evidenceRefsJsonSchema,
  },
};

const projectGoalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "problemStatement",
    "desiredOutcome",
    "successMetrics",
    "evidenceRefs",
    "priority",
    "riskLevel",
    "suggestedTaskProposals",
  ],
  properties: {
    title: { type: "string", minLength: 1 },
    problemStatement: { type: "string", minLength: 1 },
    desiredOutcome: { type: "string", minLength: 1 },
    successMetrics: stringArrayJsonSchema,
    evidenceRefs: evidenceRefsJsonSchema,
    priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    suggestedTaskProposals: {
      type: "array",
      items: taskProposalJsonSchema,
    },
  },
};

const healthSignalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "severity", "title", "description", "evidenceRefs"],
  properties: {
    kind: { type: "string", minLength: 1 },
    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    evidenceRefs: evidenceRefsJsonSchema,
    recommendation: { type: "string" },
  },
};

export const PROJECT_ANALYSIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "healthSignals", "proposedGoals", "staleGoalIds"],
  properties: {
    summary: { type: "string", minLength: 1 },
    healthSignals: { type: "array", items: healthSignalJsonSchema },
    proposedGoals: { type: "array", items: projectGoalJsonSchema },
    staleGoalIds: stringArrayJsonSchema,
    previousAnalysisId: { type: "string" },
    replanReason: { type: "string" },
  },
} satisfies Record<string, unknown>;

export const PROJECT_REPLAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "healthSignals",
    "proposedGoals",
    "staleGoalIds",
    "replanReason",
    "goalReplans",
  ],
  properties: {
    previousAnalysisId: { type: "string" },
    summary: { type: "string", minLength: 1 },
    healthSignals: { type: "array", items: healthSignalJsonSchema },
    proposedGoals: { type: "array", items: projectGoalJsonSchema },
    staleGoalIds: stringArrayJsonSchema,
    replanReason: { type: "string", minLength: 1 },
    goalReplans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "decision", "rationale", "evidenceRefs", "followUpGoals"],
        properties: {
          goalId: { type: "string", minLength: 1 },
          decision: { type: "string", enum: [...PROJECT_GOAL_REPLAN_DECISIONS] },
          rationale: { type: "string", minLength: 1 },
          evidenceRefs: evidenceRefsJsonSchema,
          followUpGoals: { type: "array", items: projectGoalJsonSchema },
          humanQuestion: { type: "string" },
        },
      },
    },
  },
} satisfies Record<string, unknown>;

export const PROJECT_STRATEGY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "analysisLenses",
    "opportunities",
    "proposedGoals",
    "questionsForHuman",
  ],
  properties: {
    summary: { type: "string", minLength: 1 },
    analysisLenses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lens", "summary"],
        properties: {
          lens: { type: "string", enum: [...PROJECT_STRATEGY_LENSES] },
          summary: { type: "string", minLength: 1 },
        },
      },
    },
    opportunities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "opportunityId",
          "dimension",
          "title",
          "problemStatement",
          "userOrBusinessImpact",
          "technicalImpact",
          "evidenceRefs",
          "confidence",
          "priority",
          "riskLevel",
          "recommendedNextStep",
          "rationale",
          "redTeamNotes",
          "architectVerdict",
        ],
        properties: {
          opportunityId: { type: "string", minLength: 1 },
          dimension: { type: "string", enum: [...PROJECT_STRATEGY_DIMENSIONS] },
          title: { type: "string", minLength: 1 },
          problemStatement: { type: "string", minLength: 1 },
          userOrBusinessImpact: { type: "string", minLength: 1 },
          technicalImpact: { type: "string", minLength: 1 },
          evidenceRefs: evidenceRefsJsonSchema,
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
          recommendedNextStep: {
            type: "string",
            enum: [...PROJECT_STRATEGY_NEXT_STEPS],
          },
          rationale: { type: "string", minLength: 1 },
          redTeamNotes: stringArrayJsonSchema,
          architectVerdict: {
            type: "string",
            enum: [...PROJECT_STRATEGY_ARCHITECT_VERDICTS],
          },
        },
      },
    },
    proposedGoals: {
      type: "array",
      items: {
        ...projectGoalJsonSchema,
        required: ["sourceOpportunityId", ...(projectGoalJsonSchema.required as string[])],
        properties: {
          sourceOpportunityId: { type: "string", minLength: 1 },
          ...projectGoalJsonSchema.properties,
        },
      },
    },
    questionsForHuman: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "whyItMatters"],
        properties: {
          question: { type: "string", minLength: 1 },
          whyItMatters: { type: "string", minLength: 1 },
          relatedOpportunityId: { type: "string" },
          relatedOpportunityTitle: { type: "string" },
        },
      },
    },
  },
} satisfies Record<string, unknown>;

const EVIDENCE_GUARDRAILS = [
  "- Do not create goals from weak or missing evidence.",
  "- If the snapshot only shows no-op validation commands, treat validation confidence as weak.",
  "- Avoid duplicate goals that differ only in wording.",
  "- Prefer tests-only or documentation proposals when evidence points to validation, reporting, or documentation gaps.",
  "- Keep goal scope small enough for one or two task proposals.",
];

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
    ...EVIDENCE_GUARDRAILS,
    "- Obey limits.",
    "- task proposals must use allowed task types.",
    `- evidenceRefs.kind must be one of: ${EVIDENCE_REF_KINDS.join(", ")}.`,
    "",
    `Limits: maxGoalsPerRun=${maxGoalsPerRun}, maxTaskProposalsPerGoal=${maxTaskProposalsPerGoal}.`,
    `Allowed task types: ${allowedTaskTypes.join(", ")}`,
    `Focus areas: ${focusAreas}`,
    "",
    "Required output:",
    "Reply with exactly one compact JSON object matching this schema. Legacy callers may prefix it with PROJECT_ANALYSIS:, but prefer raw JSON when the CLI provides --output-schema.",
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
  const goalIds = input.snapshot.goals.map((entry) => entry.goal.id);

  return [
    "Mode: project-management-replan-only",
    "",
    "Replan approved or active repository project goals from the provided snapshot.",
    "Guardrails:",
    "- Analyze only the provided snapshot.",
    "- Do not modify files.",
    "- Do not create executable tasks directly.",
    "- Do not call external services.",
    "- Classify only approved or active goals listed in the snapshot.",
    "- Use linked task data as evidence for each classification.",
    ...EVIDENCE_GUARDRAILS,
    "- Obey limits.",
    "- follow-up task proposals must use allowed task types.",
    `- evidenceRefs.kind must be one of: ${EVIDENCE_REF_KINDS.join(", ")}.`,
    "",
    `Limits: maxGoalsPerRun=${maxGoalsPerRun}, maxTaskProposalsPerGoal=${maxTaskProposalsPerGoal}.`,
    `Allowed task types: ${allowedTaskTypes.join(", ")}`,
    `Focus areas: ${focusAreas}`,
    `Replan reason: ${input.snapshot.replanReason}`,
    `Goal ids: ${goalIds.join(", ") || "none"}`,
    "",
    "Required output:",
    `Reply with exactly one compact JSON object matching this schema. Legacy callers may prefix it with ${PROJECT_REPLAN_MARKER}, but prefer raw JSON when the CLI provides --output-schema.`,
    JSON.stringify(REPLAN_RESPONSE_SCHEMA),
    "",
    "Linked task data:",
    snapshotJson,
  ].join("\n");
};

export const buildProjectStrategyPrompt = (
  input: BuildProjectStrategyPromptInput,
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
    "Mode: project-management-strategy-only",
    "",
    "Analyze product and technical opportunities from the bounded strategy snapshot.",
    "Use this fixed internal lens sequence:",
    "1. Strategic framing",
    "2. Product and technical opportunity discovery",
    "3. Defamiliarizing reframing",
    "4. Empathic impact check",
    "5. Executive conversion to actionable goals",
    "6. Red Team rejection and risk reduction",
    "7. Sober Architect final decision",
    "8. Synthetic JSON output",
    "",
    "Guardrails:",
    "- Analyze only the provided strategy snapshot.",
    "- For this first strategy slice, do not inspect repository files directly or browse local files outside the provided bounded strategy snapshot.",
    "- Do not modify files.",
    "- Do not create executable tasks directly.",
    "- Do not call external services.",
    "- Do not expose chain-of-thought; return only short audit summaries in analysisLenses.",
    "- Raw opportunities are advisory and must not create executable work.",
    "- Only proposedGoals with sourceOpportunityId can be materialized as normal proposed goals.",
    "- If product evidence is missing, ask focused questions instead of inventing product claims.",
    ...EVIDENCE_GUARDRAILS,
    "- proposed goal evidenceRefs must overlap the source opportunity evidenceRefs.",
    "- task proposals must use allowed task types.",
    `- evidenceRefs.kind must be one of: ${EVIDENCE_REF_KINDS.join(", ")}.`,
    "",
    `Limits: maxGoalsPerRun=${maxGoalsPerRun}, maxTaskProposalsPerGoal=${maxTaskProposalsPerGoal}.`,
    `Allowed task types: ${allowedTaskTypes.join(", ")}`,
    `Focus areas: ${focusAreas}`,
    `Strategy brief: ${input.snapshot.strategyBrief ?? "none"}`,
    "",
    "Required output:",
    `Reply with exactly one compact JSON object matching this schema. Legacy callers may prefix it with ${PROJECT_STRATEGY_MARKER}, but prefer raw JSON when the CLI provides --output-schema.`,
    JSON.stringify(STRATEGY_RESPONSE_SCHEMA),
    "",
    "Strategy snapshot:",
    snapshotJson,
  ].join("\n");
};
