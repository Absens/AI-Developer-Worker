import type { RecoverAbandonedTaskInput, TaskStatus } from "./types.js";

// An expired lease is not proof that a process touching this checkout has stopped.
export const EXECUTION_TASK_STATUSES: readonly TaskStatus[] = [
  "analyzing", "decomposing", "implementing", "validating", "fixing_review",
];

export const isExecutionInProgress = (status: TaskStatus): boolean =>
  EXECUTION_TASK_STATUSES.includes(status);

export const assertRecoveryConfirmation = (input: RecoverAbandonedTaskInput): void => {
  if (input.previousExecutorStopped !== true || !input.reason?.trim()) {
    throw new Error("Recovery requires confirmation that the previous executor stopped and a reason.");
  }
  if (input.actor.owner !== "human" && input.actor.owner !== "policy_admin") {
    throw new Error("Only a human operator may confirm abandoned execution recovery.");
  }
  if (!isExecutionInProgress(input.expectedStatus)) {
    throw new Error("Recovery requires an executing task status.");
  }
};
