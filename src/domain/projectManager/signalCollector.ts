import type {
  AgentRun,
  ClarificationQuestionRecord,
  MergeRequestRecord,
  QualityGateRun,
  TaskLeaseRecord,
  TaskRecord,
  TaskTrackerClient,
} from "../taskTracker/types.js";
import type { ProjectSignalSnapshot, ProjectTaskSignal } from "./types.js";

export interface CollectProjectSignalsInput {
  taskTracker: TaskTrackerClient;
  repositoryName: string;
  now?: Date;
  limit?: number;
}

const timeValue = (value: string | undefined): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const latestByTime = <T>(
  values: readonly T[],
  getTime: (value: T) => string | undefined,
): T | undefined =>
  values.reduce<T | undefined>((latest, value) => {
    if (!latest) {
      return value;
    }
    return timeValue(getTime(value)) >= timeValue(getTime(latest)) ? value : latest;
  }, undefined);

const latestAgentRun = (task: TaskRecord): AgentRun | undefined =>
  latestByTime(task.agentRuns, (run) => run.completedAt ?? run.startedAt);

const latestValidation = (task: TaskRecord): QualityGateRun | undefined =>
  latestByTime(task.qualityGateRuns, (run) => run.createdAt);

const latestMergeRequest = (task: TaskRecord): MergeRequestRecord | undefined =>
  latestByTime(task.mergeRequests, (mergeRequest) => mergeRequest.createdAt);

const latestOpenQuestion = (
  task: TaskRecord,
): ClarificationQuestionRecord | undefined =>
  latestByTime(
    task.clarificationQuestions.filter((question) => question.status === "open"),
    (question) => question.createdAt,
  );

const activeAt = (lease: TaskLeaseRecord, now: Date): boolean =>
  lease.releasedAt === undefined && timeValue(lease.expiresAt) > now.getTime();

const toTaskSignal = (task: TaskRecord): ProjectTaskSignal => {
  const agentRun = latestAgentRun(task);
  const validation = latestValidation(task);
  const mergeRequest = latestMergeRequest(task);
  const openQuestion = latestOpenQuestion(task);

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.repositoryName ? { repositoryName: task.repositoryName } : {}),
    ...(task.queue ? { queue: task.queue } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
    ...(task.taskType ? { taskType: task.taskType } : {}),
    updatedAt: task.updatedAt,
    ...(agentRun?.finalMessage || agentRun?.diagnostic
      ? { latestAiSummary: agentRun.finalMessage ?? agentRun.diagnostic }
      : {}),
    ...(validation?.summary || validation?.diagnostic
      ? { latestValidationSummary: validation.summary ?? validation.diagnostic }
      : {}),
    ...(mergeRequest?.mergeRequest.url
      ? { mergeRequestUrl: mergeRequest.mergeRequest.url }
      : {}),
    ...(openQuestion?.question.blockingReason
      ? { blockerReason: openQuestion.question.blockingReason }
      : {}),
    failedAgentRuns: task.agentRuns.filter((run) => run.status === "failed").length,
    failedValidations: task.qualityGateRuns.filter((run) => run.status === "failed")
      .length,
  };
};

const statusCountsFor = (tasks: readonly TaskRecord[]): Record<string, number> => {
  const statusCounts: Record<string, number> = {};
  for (const task of tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
  }
  return statusCounts;
};

export const collectProjectSignals = async (
  input: CollectProjectSignalsInput,
): Promise<ProjectSignalSnapshot> => {
  const now = input.now ?? new Date();
  const tasks = (
    await input.taskTracker.listTasks({
      repositoryName: input.repositoryName,
      limit: input.limit ?? 500,
    })
  ).filter((task) => task.repositoryName === input.repositoryName);
  const signals = tasks.map(toTaskSignal);
  const activeLeases = (await input.taskTracker.listActiveLeases()).filter(
    (lease) =>
      lease.repositoryName === input.repositoryName && activeAt(lease, now),
  );

  return {
    repositoryName: input.repositoryName,
    generatedAt: now.toISOString(),
    totalTasks: tasks.length,
    statusCounts: statusCountsFor(tasks),
    activeLeases: activeLeases.length,
    readyTasks: signals.filter((task) => task.status === "ready"),
    failedTasks: signals.filter((task) => task.status === "failed"),
    waitingForHuman: signals.filter((task) => task.status === "awaiting_human"),
    repeatedFailures: signals.filter(
      (task) => task.failedAgentRuns > 1 || task.failedValidations > 1,
    ),
    recentReviewTasks: signals.filter(
      (task) => task.status === "review" || task.status === "human_testing",
    ),
  };
};
