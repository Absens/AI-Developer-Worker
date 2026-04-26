import type {
  DecompositionPlan,
  SubtaskDraft,
  TaskDependencyDraft,
} from "../models/types.js";

const DECOMPOSITION_MARKER = "AI_DECOMPOSITION:";

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

const extractJsonPayload = (message: string): Record<string, unknown> | undefined => {
  const trimmed = message.trim();
  if (!trimmed.startsWith(DECOMPOSITION_MARKER)) {
    return undefined;
  }

  const payload = trimmed.slice(DECOMPOSITION_MARKER.length).trim();
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

const normalizeSubtask = (value: unknown): SubtaskDraft | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const temporaryId = normalizeString(raw.temporaryId);
  const title = normalizeString(raw.title);
  const description = normalizeString(raw.description);
  if (!temporaryId || !title || !description) {
    return undefined;
  }

  return {
    temporaryId,
    title,
    description,
    ...(normalizeString(raw.queue) ? { queue: normalizeString(raw.queue) } : {}),
    tags: normalizeStringArray(raw.tags),
    acceptanceCriteria: normalizeStringArray(raw.acceptanceCriteria),
    recommendedPromptProfileId: normalizeString(raw.recommendedPromptProfileId) ?? "general",
  };
};

const normalizeDependency = (value: unknown): TaskDependencyDraft | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const blockedTaskTemporaryId = normalizeString(raw.blockedTaskTemporaryId);
  const blockingTaskTemporaryId = normalizeString(raw.blockingTaskTemporaryId);
  if (!blockedTaskTemporaryId || !blockingTaskTemporaryId) {
    return undefined;
  }

  return {
    blockedTaskTemporaryId,
    blockingTaskTemporaryId,
    reason: normalizeString(raw.reason) ?? "Dependency produced by decomposition.",
  };
};

export const normalizeDecompositionPlan = (
  payload: Record<string, unknown>,
  options: {
    parentIssueKey: string;
    maxSubtasks: number;
  },
): DecompositionPlan | undefined => {
  const parentIssueKey =
    normalizeString(payload.parentIssueKey) ?? options.parentIssueKey;
  if (parentIssueKey !== options.parentIssueKey) {
    return undefined;
  }

  if (!Array.isArray(payload.subtasks)) {
    return undefined;
  }

  const subtasks = payload.subtasks
    .map(normalizeSubtask)
    .filter((subtask): subtask is SubtaskDraft => subtask !== undefined);
  if (
    subtasks.length === 0 ||
    subtasks.length !== payload.subtasks.length ||
    subtasks.length > options.maxSubtasks
  ) {
    return undefined;
  }

  const temporaryIds = new Set(subtasks.map((subtask) => subtask.temporaryId));
  if (temporaryIds.size !== subtasks.length) {
    return undefined;
  }

  const dependencies = Array.isArray(payload.dependencies)
    ? payload.dependencies
        .map(normalizeDependency)
        .filter((entry): entry is TaskDependencyDraft => entry !== undefined)
    : [];
  if (
    dependencies.some(
      (entry) =>
        !temporaryIds.has(entry.blockedTaskTemporaryId) ||
        !temporaryIds.has(entry.blockingTaskTemporaryId) ||
        entry.blockedTaskTemporaryId === entry.blockingTaskTemporaryId,
    )
  ) {
    return undefined;
  }

  return {
    parentIssueKey,
    summary: normalizeString(payload.summary) ?? "Task decomposition plan.",
    subtasks,
    dependencies,
    risks: normalizeStringArray(payload.risks),
  };
};

export const parseDecompositionPlan = (
  message: string | undefined,
  options: {
    parentIssueKey: string;
    maxSubtasks: number;
  },
): DecompositionPlan | undefined => {
  if (!message) {
    return undefined;
  }

  const payload = extractJsonPayload(message);
  return payload ? normalizeDecompositionPlan(payload, options) : undefined;
};

export const formatSubtaskDescription = (
  parentIssueKey: string,
  subtask: SubtaskDraft,
  options: {
    dependencyNotes?: string[];
  } = {},
): string =>
  [
    subtask.description,
    "",
    `Parent issue: ${parentIssueKey}`,
    `Recommended prompt profile: ${subtask.recommendedPromptProfileId}`,
    "",
    "Acceptance criteria:",
    ...(subtask.acceptanceCriteria.length > 0
      ? subtask.acceptanceCriteria.map((entry) => `- ${entry}`)
      : ["- Implement the described subtask and pass configured checks."]),
    ...(options.dependencyNotes && options.dependencyNotes.length > 0
      ? ["", "Dependencies:", ...options.dependencyNotes.map((entry) => `- ${entry}`)]
      : []),
  ].join("\n");
