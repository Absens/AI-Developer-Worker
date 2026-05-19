import type { LogicalStatus } from "../../models/types.js";
import type { TaskStatus } from "./types.js";

export class InvalidTaskStatusTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Invalid task status transition: ${from} -> ${to}`);
  }
}

export const TASK_STATUS_TO_LOGICAL_STATUS = {
  new: "open",
  triage: "open",
  ready: "open",
  claimed: "in_progress",
  analyzing: "in_progress",
  awaiting_human: "waiting_for_answer",
  decomposing: "in_progress",
  implementing: "in_progress",
  validating: "in_progress",
  review: "review",
  human_testing: "review",
  fixing_review: "in_progress",
  blocked: "waiting_for_answer",
  done: "done",
  failed: "failed",
  cancelled: "failed",
} satisfies Record<TaskStatus, LogicalStatus>;

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  new: ["triage", "ready", "cancelled"],
  triage: ["ready", "blocked", "cancelled"],
  ready: ["claimed", "triage", "blocked", "cancelled"],
  claimed: ["analyzing", "awaiting_human", "blocked", "failed", "cancelled"],
  analyzing: [
    "awaiting_human",
    "decomposing",
    "implementing",
    "validating",
    "ready",
    "failed",
    "cancelled",
  ],
  awaiting_human: ["ready", "analyzing", "implementing", "blocked", "cancelled"],
  decomposing: ["awaiting_human", "ready", "implementing", "failed", "cancelled"],
  implementing: ["validating", "awaiting_human", "blocked", "failed", "cancelled"],
  validating: ["review", "fixing_review", "implementing", "done", "failed", "cancelled"],
  review: ["fixing_review", "human_testing", "done", "awaiting_human", "failed", "cancelled"],
  human_testing: ["done", "awaiting_human", "failed", "cancelled"],
  fixing_review: ["validating", "review", "awaiting_human", "failed", "cancelled"],
  blocked: ["ready", "failed", "cancelled"],
  done: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};

export const mapTaskStatusToLogicalStatus = (status: TaskStatus): LogicalStatus =>
  TASK_STATUS_TO_LOGICAL_STATUS[status];

export const canTransitionTaskStatus = (
  from: TaskStatus,
  to: TaskStatus,
): boolean => from === to || ALLOWED_TRANSITIONS[from].includes(to);

export const assertValidTaskStatusTransition = (
  from: TaskStatus,
  to: TaskStatus,
): void => {
  if (!canTransitionTaskStatus(from, to)) {
    throw new InvalidTaskStatusTransitionError(from, to);
  }
};
