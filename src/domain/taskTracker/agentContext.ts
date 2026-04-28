import { mapTaskStatusToLogicalStatus } from "./status.js";
import type { AgentTaskContext, TaskRecord } from "./types.js";

export const buildAgentTaskContext = (task: TaskRecord): AgentTaskContext => {
  const latestRevision = task.revisions.at(-1);
  const activePlan = task.plans.find((plan) => plan.status === "active") ?? task.plans[0];

  if (!latestRevision) {
    throw new Error(`Task ${task.id} has no revisions.`);
  }
  if (!activePlan) {
    throw new Error(`Task ${task.id} has no active plan.`);
  }

  return {
    taskId: task.id,
    status: task.status,
    logicalStatus: mapTaskStatusToLogicalStatus(task.status),
    title: task.title,
    description: task.description,
    ...(task.humanSummary ? { humanSummary: task.humanSummary } : {}),
    ...(task.repositoryName ? { repositoryName: task.repositoryName } : {}),
    ...(task.repoPathKey ? { repoPathKey: task.repoPathKey } : {}),
    ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
    ...(task.queue ? { queue: task.queue } : {}),
    tags: [...task.tags],
    components: [...task.components],
    ...(task.priority ? { priority: task.priority } : {}),
    ...(task.deadline ? { deadline: task.deadline } : {}),
    taskType: task.taskType,
    ...(task.promptProfileId ? { promptProfileId: task.promptProfileId } : {}),
    ...(task.confidence !== undefined ? { confidence: task.confidence } : {}),
    acceptanceCriteria: [...task.acceptanceCriteria],
    constraints: [...task.constraints],
    riskFactors: [...task.riskFactors],
    missingContext: [...task.missingContext],
    externalRefs: structuredClone(task.externalRefs),
    latestRevision: structuredClone(latestRevision),
    activePlan: structuredClone(activePlan),
    comments: structuredClone(task.comments),
    events: structuredClone(task.events),
    decisions: structuredClone(task.decisions),
  };
};
