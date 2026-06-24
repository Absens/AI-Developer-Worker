import type {
  ClarificationQuestion,
  TaskAnalysisDecision,
  TaskExecutionMode,
  TaskType,
} from "../models/types.js";

export const DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD = 70;
export const DEFAULT_CONFIDENCE_HUMAN_THRESHOLD = 40;

const VALID_TASK_TYPE_VALUES = [
  "frontend_ui_fix",
  "backend_endpoint",
  "tests_only",
  "refactor",
  "dependency_update",
  "documentation",
  "unknown",
] as const satisfies readonly TaskType[];

const VALID_TASK_TYPES = new Set<TaskType>(VALID_TASK_TYPE_VALUES);

const VALID_EXECUTION_MODE_VALUES = [
  "implement",
  "ask_clarification",
  "decompose",
  "human",
] as const satisfies readonly TaskExecutionMode[];

const VALID_EXECUTION_MODES = new Set<TaskExecutionMode>(VALID_EXECUTION_MODE_VALUES);

const ANALYSIS_MARKER = "AI_ANALYSIS:";

const stringArraySchema = {
  type: "array",
  items: { type: "string" },
};

export const TASK_ANALYSIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "confidence",
    "taskType",
    "recommendedMode",
    "promptProfileId",
    "expectedFiles",
    "expectedSubsystems",
    "riskFactors",
    "missingContext",
    "reasoning",
  ],
  properties: {
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    taskType: { type: "string", enum: [...VALID_TASK_TYPE_VALUES] },
    recommendedMode: { type: "string", enum: [...VALID_EXECUTION_MODE_VALUES] },
    promptProfileId: { type: "string", minLength: 1 },
    expectedFiles: stringArraySchema,
    expectedSubsystems: stringArraySchema,
    riskFactors: stringArraySchema,
    missingContext: stringArraySchema,
    reasoning: { type: "string", minLength: 1 },
  },
} satisfies Record<string, unknown>;

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
};

const normalizeTaskType = (value: unknown): TaskType =>
  typeof value === "string" && VALID_TASK_TYPES.has(value as TaskType)
    ? (value as TaskType)
    : "unknown";

const normalizeMode = (value: unknown): TaskExecutionMode | undefined =>
  typeof value === "string" && VALID_EXECUTION_MODES.has(value as TaskExecutionMode)
    ? (value as TaskExecutionMode)
    : undefined;

const normalizeConfidence = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  if (value < 0 || value > 100) {
    return undefined;
  }

  return value;
};

const extractAnalysisPayload = (message: string): Record<string, unknown> | undefined => {
  const trimmed = message.trim();
  const payload = trimmed.startsWith(ANALYSIS_MARKER)
    ? trimmed.slice(ANALYSIS_MARKER.length).trim()
    : trimmed;
  if (!payload.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

export const applyConfidencePolicy = (
  decision: TaskAnalysisDecision,
  options: {
    implementThreshold?: number;
    humanThreshold?: number;
  } = {},
): TaskAnalysisDecision => {
  const implementThreshold =
    options.implementThreshold ?? DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD;
  const humanThreshold = options.humanThreshold ?? DEFAULT_CONFIDENCE_HUMAN_THRESHOLD;

  if (decision.recommendedMode !== "implement") {
    return decision;
  }

  if (decision.confidence < humanThreshold) {
    return {
      ...decision,
      recommendedMode: "human",
      riskFactors: [
        ...decision.riskFactors,
        `Confidence ${decision.confidence} is below human threshold ${humanThreshold}.`,
      ],
    };
  }

  if (decision.confidence < implementThreshold || decision.missingContext.length > 0) {
    return {
      ...decision,
      recommendedMode: decision.missingContext.length > 0 ? "ask_clarification" : "human",
      riskFactors: [
        ...decision.riskFactors,
        `Confidence ${decision.confidence} is below implementation threshold ${implementThreshold}.`,
      ],
    };
  }

  return decision;
};

export const normalizeTaskAnalysisDecision = (
  payload: Record<string, unknown>,
  options: {
    implementThreshold?: number;
    humanThreshold?: number;
  } = {},
): TaskAnalysisDecision | undefined => {
  const confidence = normalizeConfidence(payload.confidence);
  const recommendedMode = normalizeMode(payload.recommendedMode);
  if (confidence === undefined || !recommendedMode) {
    return undefined;
  }

  const decision: TaskAnalysisDecision = {
    confidence,
    taskType: normalizeTaskType(payload.taskType),
    recommendedMode,
    promptProfileId: normalizeString(payload.promptProfileId) ?? "general",
    expectedFiles: normalizeStringArray(payload.expectedFiles),
    expectedSubsystems: normalizeStringArray(payload.expectedSubsystems),
    riskFactors: normalizeStringArray(payload.riskFactors),
    missingContext: normalizeStringArray(payload.missingContext),
    reasoning:
      normalizeString(payload.reasoning) ??
      "Codex did not provide analysis reasoning.",
  };

  return applyConfidencePolicy(decision, options);
};

export const parseTaskAnalysisDecision = (
  message: string | undefined,
  options: {
    implementThreshold?: number;
    humanThreshold?: number;
  } = {},
): TaskAnalysisDecision | undefined => {
  if (!message) {
    return undefined;
  }

  const payload = extractAnalysisPayload(message);
  return payload ? normalizeTaskAnalysisDecision(payload, options) : undefined;
};

export const createReadyAnalysisDecision = (
  overrides: Partial<TaskAnalysisDecision> = {},
): TaskAnalysisDecision => ({
  confidence: overrides.confidence ?? 100,
  taskType: overrides.taskType ?? "unknown",
  recommendedMode: overrides.recommendedMode ?? "implement",
  promptProfileId: overrides.promptProfileId ?? "general",
  expectedFiles: overrides.expectedFiles ?? [],
  expectedSubsystems: overrides.expectedSubsystems ?? [],
  riskFactors: overrides.riskFactors ?? [],
  missingContext: overrides.missingContext ?? [],
  reasoning: overrides.reasoning ?? "Legacy READY_FOR_IMPLEMENTATION analysis marker.",
});

export const createManualHoldAnalysisDecision = (
  reason: string,
): TaskAnalysisDecision => ({
  confidence: 0,
  taskType: "unknown",
  recommendedMode: "human",
  promptProfileId: "general",
  expectedFiles: [],
  expectedSubsystems: [],
  riskFactors: [reason],
  missingContext: [reason],
  reasoning: reason,
});

export const createClarificationFromAnalysis = (
  decision: TaskAnalysisDecision,
): ClarificationQuestion => {
  const missingContext =
    decision.missingContext.length > 0
      ? decision.missingContext.join("; ")
      : "The analysis confidence is too low to proceed safely.";

  return {
    summary: `Clarification required before implementation (${decision.taskType}).`,
    blockingReason: missingContext,
    question:
      decision.missingContext[0] ??
      "What additional context should the worker use before implementing this task?",
    options: decision.missingContext.map((entry, index) => `${index + 1}: ${entry}`),
    resumeHint: "Reply with /resume freeform: <missing context or implementation guidance>.",
  };
};
