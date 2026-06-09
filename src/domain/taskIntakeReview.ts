import { createHash } from "node:crypto";

import type {
  CommentWithMetadata,
  TaskIntakeReviewDecision,
  TaskIntakeReviewStatus,
  TrackerIssue,
} from "../models/types.js";

const TASK_INTAKE_REVIEW_MARKER = "AI_TASK_REVIEW:";

const VALID_REVIEW_STATUSES = new Set<TaskIntakeReviewStatus>([
  "ready",
  "needs_clarification",
  "needs_decomposition",
  "reject_as_invalid",
]);

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

const normalizeStatus = (value: unknown): TaskIntakeReviewStatus | undefined =>
  typeof value === "string" &&
  VALID_REVIEW_STATUSES.has(value.trim() as TaskIntakeReviewStatus)
    ? (value.trim() as TaskIntakeReviewStatus)
    : undefined;

const normalizeReadinessScore = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  if (value < 0 || value > 100) {
    return undefined;
  }

  return value;
};

const extractTaskIntakeReviewPayload = (
  message: string,
): Record<string, unknown> | undefined => {
  const trimmed = message.trim();
  if (!trimmed.startsWith(TASK_INTAKE_REVIEW_MARKER)) {
    return undefined;
  }

  const payload = trimmed.slice(TASK_INTAKE_REVIEW_MARKER.length).trim();
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

const compareStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
};

const sortStrings = (values: string[] | undefined): string[] =>
  [...(values ?? [])].sort(compareStrings);

export const normalizeTaskIntakeReviewDecision = (
  payload: Record<string, unknown>,
): TaskIntakeReviewDecision | undefined => {
  const status = normalizeStatus(payload.status);
  const readinessScore = normalizeReadinessScore(payload.readinessScore);
  const summary = normalizeString(payload.summary);
  const reasoning = normalizeString(payload.reasoning);

  if (!status || readinessScore === undefined || !summary || !reasoning) {
    return undefined;
  }

  const decision: TaskIntakeReviewDecision = {
    status,
    readinessScore,
    summary,
    acceptanceCriteria: normalizeStringArray(payload.acceptanceCriteria),
    clarificationQuestions: normalizeStringArray(payload.clarificationQuestions),
    decompositionHints: normalizeStringArray(payload.decompositionHints),
    riskFactors: normalizeStringArray(payload.riskFactors),
    reasoning,
  };

  const rewrittenTitle = normalizeString(payload.rewrittenTitle);
  if (rewrittenTitle) {
    decision.rewrittenTitle = rewrittenTitle;
  }

  const rewrittenDescription = normalizeString(payload.rewrittenDescription);
  if (rewrittenDescription) {
    decision.rewrittenDescription = rewrittenDescription;
  }

  return decision;
};

export const parseTaskIntakeReviewDecision = (
  message: string | undefined,
): TaskIntakeReviewDecision | undefined => {
  if (!message) {
    return undefined;
  }

  const payload = extractTaskIntakeReviewPayload(message);
  return payload ? normalizeTaskIntakeReviewDecision(payload) : undefined;
};

export const limitTaskIntakeReviewQuestions = (
  decision: TaskIntakeReviewDecision,
  maxQuestions: number,
): TaskIntakeReviewDecision => {
  const normalizedMax = Number.isInteger(maxQuestions) && maxQuestions > 0 ? maxQuestions : 1;

  return {
    ...decision,
    clarificationQuestions: decision.clarificationQuestions.slice(0, normalizedMax),
  };
};

export const createTaskIntakeFingerprint = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
): string => {
  const payload = {
    title: issue.title,
    description: issue.description,
    queue: issue.queue ?? "",
    tags: sortStrings(issue.tags),
    priority: issue.priority ?? "",
    deadline: issue.deadline ?? "",
    components: sortStrings(issue.components),
    humanComments: comments
      .filter((comment) => !comment.metadata && !comment.isSystem)
      .map((comment) => ({
        id: comment.id,
        text: comment.text.trim(),
        createdAt: comment.createdAt,
        author: comment.author ?? "",
      }))
      .sort(
        (left, right) =>
          compareStrings(left.createdAt, right.createdAt) ||
          compareStrings(left.id, right.id),
      ),
  };

  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
};
