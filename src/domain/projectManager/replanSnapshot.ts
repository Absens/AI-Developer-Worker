import type {
  AgentRun,
  ClarificationQuestionRecord,
  MergeRequestRecord,
  QualityGateRun,
  TaskRecord,
  TaskTrackerClient,
} from "../taskTracker/types.js";
import { TaskNotFoundError } from "../taskTracker/errors.js";
import { collectProjectSignals } from "./signalCollector.js";
import type { ProjectManagerStore } from "./store.js";
import type {
  ProjectAnalysis,
  ProjectGoal,
  ProjectGoalAuditEvent,
  ProjectGoalTaskLink,
  ProjectSignalSnapshot,
} from "./types.js";

export interface CollectProjectReplanSnapshotInput {
  taskTracker: TaskTrackerClient;
  store: ProjectManagerStore;
  repositoryName: string;
  replanReason: string;
  now?: () => Date;
  limit?: number;
}

export interface ProjectReplanLinkedTaskSnapshot {
  id: string;
  title: string;
  status: string;
  repositoryName?: string;
  queue?: string;
  priority?: string;
  taskType?: string;
  updatedAt: string;
  latestAiSummary?: string;
  latestValidationSummary?: string;
  mergeRequestUrl?: string;
  blockerReason?: string;
  failedAgentRuns: number;
  failedValidations: number;
}

export interface ProjectReplanGoalSnapshot {
  goal: ProjectGoal;
  linkedTasks: ProjectReplanLinkedTaskSnapshot[];
  taskLinks: ProjectGoalTaskLink[];
  auditEvents: ProjectGoalAuditEvent[];
}

export interface ProjectReplanSnapshot {
  repositoryName: string;
  generatedAt: string;
  replanReason: string;
  previousAnalysisId?: string;
  previousAnalysisSummary?: string;
  projectSignals: ProjectSignalSnapshot;
  goals: ProjectReplanGoalSnapshot[];
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

const nonBlank = (value: string | undefined): string | undefined =>
  value?.trim() ? value : undefined;

const firstNonBlank = (
  ...values: Array<string | undefined>
): string | undefined => values.map(nonBlank).find((value) => value !== undefined);

const toLinkedTaskSnapshot = (
  task: TaskRecord,
): ProjectReplanLinkedTaskSnapshot => {
  const agentRun = latestAgentRun(task);
  const validation = latestValidation(task);
  const mergeRequest = latestMergeRequest(task);
  const openQuestion = latestOpenQuestion(task);
  const latestAiSummary = firstNonBlank(
    agentRun?.finalMessage,
    agentRun?.diagnostic,
  );
  const latestValidationSummary = firstNonBlank(
    validation?.summary,
    validation?.diagnostic,
  );

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.repositoryName ? { repositoryName: task.repositoryName } : {}),
    ...(task.queue ? { queue: task.queue } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
    ...(task.taskType ? { taskType: task.taskType } : {}),
    updatedAt: task.updatedAt,
    ...(latestAiSummary ? { latestAiSummary } : {}),
    ...(latestValidationSummary ? { latestValidationSummary } : {}),
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

const latestAnalysisForRepository = (
  analyses: readonly ProjectAnalysis[],
  repositoryName: string,
): ProjectAnalysis | undefined =>
  analyses
    .filter((analysis) => analysis.repositoryName === repositoryName)
    .reduce<ProjectAnalysis | undefined>((latest, analysis) => {
      if (!latest) {
        return analysis;
      }
      return timeValue(analysis.createdAt) >= timeValue(latest.createdAt)
        ? analysis
        : latest;
    }, undefined);

const taskIdsFromLinks = (
  linksByGoalId: ReadonlyMap<string, ProjectGoalTaskLink[]>,
): string[] => {
  const seen = new Set<string>();
  const taskIds: string[] = [];
  for (const links of linksByGoalId.values()) {
    for (const link of links) {
      if (!seen.has(link.taskId)) {
        seen.add(link.taskId);
        taskIds.push(link.taskId);
      }
    }
  }
  return taskIds;
};

const getLinkedTask = async (
  taskTracker: TaskTrackerClient,
  taskId: string,
): Promise<TaskRecord | undefined> => {
  try {
    return await taskTracker.getTask(taskId);
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return undefined;
    }
    throw error;
  }
};

export const collectProjectReplanSnapshot = async (
  input: CollectProjectReplanSnapshotInput,
): Promise<ProjectReplanSnapshot> => {
  const now = input.now?.() ?? new Date();
  const limit = input.limit ?? 500;
  const projectSignals = await collectProjectSignals({
    taskTracker: input.taskTracker,
    repositoryName: input.repositoryName,
    now,
    limit,
  });
  const goals = await input.store.listGoals({
    repositoryName: input.repositoryName,
    status: ["approved", "active"],
  });
  const linksByGoalId = new Map<string, ProjectGoalTaskLink[]>();
  const eventsByGoalId = new Map<string, ProjectGoalAuditEvent[]>();
  for (const goal of goals) {
    linksByGoalId.set(goal.id, await input.store.listGoalTaskLinks(goal.id));
    eventsByGoalId.set(goal.id, await input.store.listGoalEvents(goal.id));
  }
  const tasks = (
    await input.taskTracker.listTasks({
      repositoryName: input.repositoryName,
      limit,
    })
  ).filter((task) => task.repositoryName === input.repositoryName);
  const linkedTasksById = new Map(
    tasks.map((task) => [task.id, toLinkedTaskSnapshot(task)]),
  );
  for (const taskId of taskIdsFromLinks(linksByGoalId)) {
    if (linkedTasksById.has(taskId)) {
      continue;
    }
    const task = await getLinkedTask(input.taskTracker, taskId);
    if (task?.repositoryName === input.repositoryName) {
      linkedTasksById.set(task.id, toLinkedTaskSnapshot(task));
    }
  }
  const analyses = await input.store.listAnalyses();
  const previousAnalysis = latestAnalysisForRepository(
    analyses,
    input.repositoryName,
  );

  return {
    repositoryName: input.repositoryName,
    generatedAt: now.toISOString(),
    replanReason: input.replanReason,
    ...(previousAnalysis
      ? {
          previousAnalysisId: previousAnalysis.id,
          previousAnalysisSummary: previousAnalysis.summary,
        }
      : {}),
    projectSignals,
    goals: goals.map((goal) => {
      const taskLinks = linksByGoalId.get(goal.id) ?? [];
      const auditEvents = eventsByGoalId.get(goal.id) ?? [];
      const linkedTasks = taskLinks
        .map((link) => linkedTasksById.get(link.taskId))
        .filter(
          (task): task is ProjectReplanLinkedTaskSnapshot => task !== undefined,
        );

      return {
        goal,
        linkedTasks,
        taskLinks,
        auditEvents,
      };
    }),
  };
};
