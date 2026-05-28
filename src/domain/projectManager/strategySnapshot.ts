import type { TaskType } from "../../models/types.js";
import { TaskNotFoundError } from "../taskTracker/errors.js";
import type {
  QualityGateRun,
  TaskRecord,
  TaskTrackerClient,
} from "../taskTracker/types.js";
import { collectProjectSignals } from "./signalCollector.js";
import type { ProjectManagerStore } from "./store.js";
import type {
  ProjectAnalysis,
  ProjectGoal,
  ProjectManagerConfig,
  ProjectSignalSnapshot,
} from "./types.js";

export interface ProjectStrategyRepositoryProfile {
  baseBranch?: string;
  queue?: string;
  tags: string[];
  focusAreas: string[];
  allowedProjectManagerTaskTypes: TaskType[];
}

export interface ProjectStrategySnapshot {
  repositoryName: string;
  generatedAt: string;
  strategyBrief?: string;
  projectSignals: ProjectSignalSnapshot;
  recentAnalyses: Array<{
    id: string;
    analysisKind: ProjectAnalysis["analysisKind"];
    summary: string;
    createdAt: string;
  }>;
  goals: Array<{
    id: string;
    status: ProjectGoal["status"];
    title: string;
    priority: ProjectGoal["priority"];
    riskLevel: ProjectGoal["riskLevel"];
    summary: string;
    linkedTaskOutcomes: Array<{
      taskId: string;
      status: string;
      latestValidationSummary?: string;
      failedAgentRuns: number;
      failedValidations: number;
    }>;
  }>;
  proposalBacklog: {
    proposed: number;
    approved: number;
    autoApproved: number;
    rejected: number;
    stale: number;
  };
  taskTypeSummary: {
    counts: Record<string, number>;
    unknownTaskTypeCount: number;
  };
  repositoryProfile: ProjectStrategyRepositoryProfile;
  productContext: {
    knownUsersOrRoles: string[];
    knownWorkflows: string[];
    knownProductSignals: string[];
    missingProductSignals: string[];
  };
}

export interface CollectProjectStrategySnapshotInput {
  taskTracker: TaskTrackerClient;
  store: ProjectManagerStore;
  repositoryName: string;
  config: ProjectManagerConfig;
  strategyBrief?: string;
  repositoryProfile?: {
    baseBranch?: string;
    queue?: string;
    tags?: string[];
  };
  now?: () => Date;
  limit?: number;
}

const MAX_STRATEGY_GOALS = 25;
const MAX_LINKED_TASK_OUTCOMES_PER_GOAL = 5;

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

const latestValidation = (task: TaskRecord): QualityGateRun | undefined =>
  latestByTime(task.qualityGateRuns, (run) => run.createdAt);

const nonBlank = (value: string | undefined): string | undefined =>
  value?.trim() ? value : undefined;

const firstNonBlank = (
  ...values: Array<string | undefined>
): string | undefined => values.map(nonBlank).find((value) => value !== undefined);

const trimStrategyBrief = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
};

const recentAnalysesForRepository = (
  analyses: readonly ProjectAnalysis[],
  repositoryName: string,
): ProjectStrategySnapshot["recentAnalyses"] =>
  analyses
    .filter((analysis) => analysis.repositoryName === repositoryName)
    .sort((left, right) => timeValue(right.createdAt) - timeValue(left.createdAt))
    .slice(0, 10)
    .map((analysis) => ({
      id: analysis.id,
      analysisKind: analysis.analysisKind,
      summary: analysis.summary,
      createdAt: analysis.createdAt,
    }));

const summarizeTaskOutcome = (
  task: TaskRecord,
): ProjectStrategySnapshot["goals"][number]["linkedTaskOutcomes"][number] => {
  const validation = latestValidation(task);
  const latestValidationSummary = firstNonBlank(
    validation?.summary,
    validation?.diagnostic,
  );

  return {
    taskId: task.id,
    status: task.status,
    ...(latestValidationSummary ? { latestValidationSummary } : {}),
    failedAgentRuns: task.agentRuns.filter((run) => run.status === "failed").length,
    failedValidations: task.qualityGateRuns.filter((run) => run.status === "failed")
      .length,
  };
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

const compareGoalsForStrategySnapshot = (
  left: ProjectGoal,
  right: ProjectGoal,
): number => {
  const timeComparison = timeValue(right.updatedAt) - timeValue(left.updatedAt);
  return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
};

const strategyGoalLimit = (limit: number | undefined): number =>
  Math.max(0, Math.min(limit ?? MAX_STRATEGY_GOALS, MAX_STRATEGY_GOALS));

const collectGoalSnapshots = async (
  input: CollectProjectStrategySnapshotInput,
): Promise<ProjectStrategySnapshot["goals"]> => {
  const goals = await input.store.listGoals({
    repositoryName: input.repositoryName,
    status: ["proposed", "approved", "active", "completed", "rejected", "stale"],
  });
  const sortedGoals = [...goals]
    .sort(compareGoalsForStrategySnapshot)
    .slice(0, strategyGoalLimit(input.limit));
  const snapshots: ProjectStrategySnapshot["goals"] = [];

  for (const goal of sortedGoals) {
    const links = (await input.store.listGoalTaskLinks(goal.id)).slice(
      0,
      MAX_LINKED_TASK_OUTCOMES_PER_GOAL,
    );
    const linkedTaskOutcomes: ProjectStrategySnapshot["goals"][number]["linkedTaskOutcomes"] = [];
    for (const link of links) {
      const task = await getLinkedTask(input.taskTracker, link.taskId);
      if (task?.repositoryName === input.repositoryName) {
        linkedTaskOutcomes.push(summarizeTaskOutcome(task));
      }
    }
    snapshots.push({
      id: goal.id,
      status: goal.status,
      title: goal.title,
      priority: goal.priority,
      riskLevel: goal.riskLevel,
      summary: goal.desiredOutcome,
      linkedTaskOutcomes,
    });
  }

  return snapshots;
};

const proposalBacklogFor = (
  tasks: readonly TaskRecord[],
  now: Date,
): ProjectStrategySnapshot["proposalBacklog"] => {
  const backlog: ProjectStrategySnapshot["proposalBacklog"] = {
    proposed: 0,
    approved: 0,
    autoApproved: 0,
    rejected: 0,
    stale: 0,
  };

  for (const task of tasks) {
    const proposal = task.proposal;
    if (!proposal) {
      continue;
    }
    if (proposal.supervisorStatus === "proposed") {
      backlog.proposed += 1;
      const staleAfter = proposal.cleanup.staleAfter;
      if (staleAfter && timeValue(staleAfter) < now.getTime()) {
        backlog.stale += 1;
      }
    } else if (proposal.supervisorStatus === "approved") {
      backlog.approved += 1;
    } else if (proposal.supervisorStatus === "auto_approved") {
      backlog.autoApproved += 1;
    } else if (proposal.supervisorStatus === "rejected") {
      backlog.rejected += 1;
    }
  }

  return backlog;
};

const taskTypeSummaryFor = (
  tasks: readonly TaskRecord[],
): ProjectStrategySnapshot["taskTypeSummary"] => {
  const counts: Record<string, number> = {};
  let unknownTaskTypeCount = 0;

  for (const task of tasks) {
    counts[task.taskType] = (counts[task.taskType] ?? 0) + 1;
    if (task.taskType === "unknown") {
      unknownTaskTypeCount += 1;
    }
  }

  return {
    counts,
    unknownTaskTypeCount,
  };
};

export const collectProjectStrategySnapshot = async (
  input: CollectProjectStrategySnapshotInput,
): Promise<ProjectStrategySnapshot> => {
  const now = input.now?.() ?? new Date();
  const limit = input.limit ?? 500;
  const projectSignals = await collectProjectSignals({
    taskTracker: input.taskTracker,
    repositoryName: input.repositoryName,
    now,
    limit,
  });
  const analyses = await input.store.listAnalyses();
  const goals = await collectGoalSnapshots(input);
  const tasks = (
    await input.taskTracker.listTasks({
      repositoryName: input.repositoryName,
      limit,
    })
  ).filter((task) => task.repositoryName === input.repositoryName);
  const strategyBrief = trimStrategyBrief(input.strategyBrief);

  return {
    repositoryName: input.repositoryName,
    generatedAt: now.toISOString(),
    ...(strategyBrief ? { strategyBrief } : {}),
    projectSignals,
    recentAnalyses: recentAnalysesForRepository(analyses, input.repositoryName),
    goals,
    proposalBacklog: proposalBacklogFor(tasks, now),
    taskTypeSummary: taskTypeSummaryFor(tasks),
    repositoryProfile: {
      ...(input.repositoryProfile?.baseBranch
        ? { baseBranch: input.repositoryProfile.baseBranch }
        : {}),
      ...(input.repositoryProfile?.queue
        ? { queue: input.repositoryProfile.queue }
        : {}),
      tags: input.repositoryProfile?.tags ?? [],
      focusAreas: input.config.focusAreas ?? [],
      allowedProjectManagerTaskTypes: input.config.allowedTaskTypes,
    },
    productContext: {
      knownUsersOrRoles: [],
      knownWorkflows: [],
      knownProductSignals: [],
      missingProductSignals: ["No explicit product telemetry configured."],
    },
  };
};
