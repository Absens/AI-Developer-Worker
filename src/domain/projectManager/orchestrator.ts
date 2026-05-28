import type { CodexRunner } from "../../models/types.js";
import {
  NoopMetricsRegistry,
  type MetricsRegistry,
} from "../../observability/metrics.js";
import type { TaskActor } from "../taskTracker/types.js";
import type { TaskTrackerClient } from "../taskTracker/types.js";
import {
  assertProjectAnalysisWithinPolicy,
  assertProjectReplanWithinPolicy,
  assertProjectStrategyWithinPolicy,
} from "./analysisPolicy.js";
import {
  parseProjectAnalysisResponse,
  parseProjectReplanResponse,
  parseProjectStrategyResponse,
} from "./analysisParser.js";
import {
  buildProjectAnalysisPrompt,
  buildProjectReplanPrompt,
  buildProjectStrategyPrompt,
} from "./promptBuilder.js";
import { collectProjectReplanSnapshot } from "./replanSnapshot.js";
import { collectProjectSignals } from "./signalCollector.js";
import type { ProjectManagerStore } from "./store.js";
import { collectProjectStrategySnapshot } from "./strategySnapshot.js";
import type {
  ProjectAnalysis,
  ProjectGoalReplanClassification,
  ProjectManagerConfig,
  ProjectManagerMode,
  ProjectManagerRun,
  ProjectManagerTrigger,
  ProjectStrategyGoalLink,
  ProjectStrategyLensSummary,
  ProjectStrategyOpportunity,
  ProjectStrategyQuestion,
} from "./types.js";

export interface ProjectManagerOrchestratorInput {
  taskTracker: TaskTrackerClient;
  codex: CodexRunner;
  store: ProjectManagerStore;
  config: ProjectManagerConfig;
  focusAreas?: string[];
  metrics?: MetricsRegistry;
}

export interface RunProjectAnalysisOnceInput {
  repositoryName: string;
  trigger?: ProjectManagerTrigger;
}

export interface RunProjectAnalysisOnceResult {
  run: ProjectManagerRun;
  analysis: ProjectAnalysis;
}

export interface RunProjectReplanOnceInput {
  repositoryName: string;
  replanReason: string;
  trigger?: ProjectManagerTrigger;
}

export interface RunProjectReplanOnceResult {
  run: ProjectManagerRun;
  analysis: ProjectAnalysis;
}

export interface RunProjectStrategyOnceInput {
  repositoryName: string;
  strategyBrief?: string;
  trigger?: ProjectManagerTrigger;
  repositoryProfile?: {
    baseBranch?: string;
    queue?: string;
    tags?: string[];
  };
}

export interface RunProjectStrategyOnceResult {
  run: ProjectManagerRun;
  analysis: ProjectAnalysis;
  strategy: {
    summary: string;
    analysisLenses: ProjectStrategyLensSummary[];
    opportunities: ProjectStrategyOpportunity[];
    goalLinks: ProjectStrategyGoalLink[];
    questionsForHuman: ProjectStrategyQuestion[];
  };
}

const diagnosticFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeStrategyBrief = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 2000) {
    throw new Error("strategyBrief must be at most 2000 characters.");
  }
  return trimmed;
};

const replanActor: TaskActor = {
  owner: "policy_admin",
  id: "project-manager-replan",
  displayName: "Project Manager Replan",
};

export class ProjectManagerOrchestrator {
  private readonly taskTracker: TaskTrackerClient;
  private readonly codex: CodexRunner;
  private readonly store: ProjectManagerStore;
  private readonly config: ProjectManagerConfig;
  private readonly focusAreas?: string[];
  private readonly metrics: MetricsRegistry;

  public constructor(input: ProjectManagerOrchestratorInput) {
    this.taskTracker = input.taskTracker;
    this.codex = input.codex;
    this.store = input.store;
    this.config = input.config;
    this.focusAreas = input.focusAreas ?? input.config.focusAreas;
    this.metrics = input.metrics ?? new NoopMetricsRegistry();
  }

  public async runAnalysisOnce(
    input: RunProjectAnalysisOnceInput,
  ): Promise<RunProjectAnalysisOnceResult> {
    if (!this.config.enabled) {
      throw new Error("Project manager is disabled.");
    }

    const trigger = input.trigger ?? "manual";
    const run = await this.store.startRun({
      repositoryName: input.repositoryName,
      mode: "analysis",
      trigger,
    });

    try {
      const snapshot = await collectProjectSignals({
        taskTracker: this.taskTracker,
        repositoryName: input.repositoryName,
      });
      const prompt = buildProjectAnalysisPrompt({
        snapshot,
        maxGoalsPerRun: this.config.maxGoalsPerRun,
        maxTaskProposalsPerGoal: this.config.maxTaskProposalsPerGoal,
        allowedTaskTypes: this.config.allowedTaskTypes,
        focusAreas: this.focusAreas,
      });
      const execution = await this.codex.runInitial(prompt, undefined, {
        sandbox: "read-only",
      });
      if (execution.process.exitCode !== 0) {
        throw new Error(
          `Codex project analysis failed with exit code ${execution.process.exitCode}.`,
        );
      }

      const parsed = parseProjectAnalysisResponse(execution.finalMessage);
      if (!parsed) {
        throw new Error("Codex response must be valid PROJECT_ANALYSIS output.");
      }
      assertProjectAnalysisWithinPolicy(parsed, this.config);

      const analysis = await this.store.recordAnalysis({
        repositoryName: input.repositoryName,
        analysisKind: "analysis",
        ...parsed,
      });
      const goals = await this.store.createGoalsFromAnalysis({
        repositoryName: input.repositoryName,
        sourceAnalysisId: analysis.id,
        sourceRunId: run.id,
        goals: analysis.proposedGoals,
      });
      const completedRun = await this.store.completeRun(run.id, {
        analysisId: analysis.id,
        proposedGoalIds: goals.map((goal) => goal.id),
        proposedTaskIds: [],
      });
      this.recordProjectManagerRunMetric(
        input.repositoryName,
        "analysis",
        trigger,
        "completed",
      );

      return {
        run: completedRun,
        analysis,
      };
    } catch (error) {
      await this.store.failRun(run.id, diagnosticFor(error));
      this.recordProjectManagerRunMetric(
        input.repositoryName,
        "analysis",
        trigger,
        "failed",
      );
      throw error;
    }
  }

  public async runStrategyOnce(
    input: RunProjectStrategyOnceInput,
  ): Promise<RunProjectStrategyOnceResult> {
    if (!this.config.enabled) {
      throw new Error("Project manager is disabled.");
    }

    const strategyBrief = normalizeStrategyBrief(input.strategyBrief);
    const trigger = input.trigger ?? "manual";
    const run = await this.store.startRun({
      repositoryName: input.repositoryName,
      trigger,
      mode: "strategy",
    });

    try {
      const snapshot = await collectProjectStrategySnapshot({
        taskTracker: this.taskTracker,
        store: this.store,
        repositoryName: input.repositoryName,
        config: this.config,
        strategyBrief,
        repositoryProfile: input.repositoryProfile,
      });
      const prompt = buildProjectStrategyPrompt({
        snapshot,
        maxGoalsPerRun: this.config.maxGoalsPerRun,
        maxTaskProposalsPerGoal: this.config.maxTaskProposalsPerGoal,
        allowedTaskTypes: this.config.allowedTaskTypes,
        focusAreas: this.focusAreas,
      });
      const execution = await this.codex.runInitial(prompt, undefined, {
        sandbox: "read-only",
      });
      if (execution.process.exitCode !== 0) {
        throw new Error(
          `Codex project strategy failed with exit code ${execution.process.exitCode}.`,
        );
      }

      const parsed = parseProjectStrategyResponse(execution.finalMessage);
      if (!parsed) {
        throw new Error("Codex response must be valid PROJECT_STRATEGY output.");
      }
      assertProjectStrategyWithinPolicy({
        parsed,
        config: this.config,
      });

      const goalLinks = parsed.proposedGoals.map((goal) => ({
        sourceOpportunityId: goal.sourceOpportunityId,
        proposedGoalTitle: goal.title,
        evidenceRefs: structuredClone(goal.evidenceRefs),
      }));
      const proposedGoals = parsed.proposedGoals.map(
        ({ sourceOpportunityId: _sourceOpportunityId, ...goal }) => goal,
      );
      const analysis = await this.store.recordAnalysis({
        repositoryName: input.repositoryName,
        analysisKind: "strategy",
        summary: parsed.summary,
        healthSignals: [],
        proposedGoals,
        staleGoalIds: [],
        goalReplans: [],
        strategyAnalysisLenses: parsed.analysisLenses,
        strategyOpportunities: parsed.opportunities,
        strategyGoalLinks: goalLinks,
        strategyQuestions: parsed.questionsForHuman,
        ...(strategyBrief ? { strategyBrief } : {}),
      });
      const goals = await this.store.createGoalsFromAnalysis({
        repositoryName: input.repositoryName,
        sourceAnalysisId: analysis.id,
        sourceRunId: run.id,
        goals: analysis.proposedGoals,
      });
      const completedRun = await this.store.completeRun(run.id, {
        analysisId: analysis.id,
        proposedGoalIds: goals.map((goal) => goal.id),
        proposedTaskIds: [],
      });
      this.recordProjectManagerRunMetric(
        input.repositoryName,
        "strategy",
        trigger,
        "completed",
      );

      return {
        run: completedRun,
        analysis,
        strategy: {
          summary: analysis.summary,
          analysisLenses: analysis.strategyAnalysisLenses,
          opportunities: analysis.strategyOpportunities,
          goalLinks: analysis.strategyGoalLinks,
          questionsForHuman: analysis.strategyQuestions,
        },
      };
    } catch (error) {
      await this.store.failRun(run.id, diagnosticFor(error));
      this.recordProjectManagerRunMetric(
        input.repositoryName,
        "strategy",
        trigger,
        "failed",
      );
      throw error;
    }
  }

  public async runReplanOnce(
    input: RunProjectReplanOnceInput,
  ): Promise<RunProjectReplanOnceResult> {
    if (!this.config.enabled) {
      throw new Error("Project manager is disabled.");
    }

    const replanReason = input.replanReason.trim();
    if (!replanReason) {
      throw new Error("Project replan reason is required.");
    }

    const trigger = input.trigger ?? "manual";
    const run = await this.store.startRun({
      repositoryName: input.repositoryName,
      mode: "replan",
      trigger,
    });

    try {
      const snapshot = await collectProjectReplanSnapshot({
        taskTracker: this.taskTracker,
        store: this.store,
        repositoryName: input.repositoryName,
        replanReason,
      });
      const prompt = buildProjectReplanPrompt({
        snapshot,
        maxGoalsPerRun: this.config.maxGoalsPerRun,
        maxTaskProposalsPerGoal: this.config.maxTaskProposalsPerGoal,
        allowedTaskTypes: this.config.allowedTaskTypes,
        focusAreas: this.focusAreas,
      });
      const execution = await this.codex.runInitial(prompt, undefined, {
        sandbox: "read-only",
      });
      if (execution.process.exitCode !== 0) {
        throw new Error(
          `Codex project replan failed with exit code ${execution.process.exitCode}.`,
        );
      }

      const parsed = parseProjectReplanResponse(execution.finalMessage);
      if (!parsed) {
        throw new Error("Codex response must be valid PROJECT_REPLAN output.");
      }
      assertProjectReplanWithinPolicy({
        parsed,
        config: this.config,
        activeGoalIds: snapshot.goals.map((entry) => entry.goal.id),
      });

      const analysis = await this.store.recordAnalysis({
        repositoryName: input.repositoryName,
        analysisKind: "replan",
        summary: parsed.summary,
        healthSignals: parsed.healthSignals,
        proposedGoals: parsed.proposedGoals,
        staleGoalIds: parsed.staleGoalIds,
        goalReplans: parsed.goalReplans,
        replanReason,
        ...(snapshot.previousAnalysisId
          ? { previousAnalysisId: snapshot.previousAnalysisId }
          : {}),
      });
      const materializableGoals = [
        ...analysis.proposedGoals,
        ...analysis.goalReplans.flatMap(
          (classification) => classification.followUpGoals,
        ),
      ];
      const goals = await this.store.createGoalsFromAnalysis({
        repositoryName: input.repositoryName,
        sourceAnalysisId: analysis.id,
        sourceRunId: run.id,
        goals: materializableGoals,
      });
      for (const goal of goals) {
        this.metrics.incrementCounter("ai_developer_project_goals_total", {
          repository: input.repositoryName,
          status: goal.status,
          source: "replan",
        });
      }

      for (const classification of analysis.goalReplans) {
        await this.store.recordGoalReplanClassification({
          goalId: classification.goalId,
          analysisId: analysis.id,
          classification,
        });
        this.metrics.incrementCounter("ai_developer_project_replans_total", {
          repository: input.repositoryName,
          decision: classification.decision,
        });
        await this.completeGoalWhenSafe(classification, snapshot);
      }

      const completedRun = await this.store.completeRun(run.id, {
        analysisId: analysis.id,
        proposedGoalIds: goals.map((goal) => goal.id),
        proposedTaskIds: [],
      });
      this.recordProjectManagerRunMetric(
        input.repositoryName,
        "replan",
        trigger,
        "completed",
      );

      return {
        run: completedRun,
        analysis,
      };
    } catch (error) {
      await this.store.failRun(run.id, diagnosticFor(error));
      this.recordProjectManagerRunMetric(
        input.repositoryName,
        "replan",
        trigger,
        "failed",
      );
      throw error;
    }
  }

  private recordProjectManagerRunMetric(
    repositoryName: string,
    mode: ProjectManagerMode,
    trigger: ProjectManagerTrigger,
    status: "completed" | "failed",
  ): void {
    this.metrics.incrementCounter("ai_developer_project_manager_runs_total", {
      repository: repositoryName,
      mode,
      trigger,
      status,
    });
  }

  private async completeGoalWhenSafe(
    classification: ProjectGoalReplanClassification,
    snapshot: Awaited<ReturnType<typeof collectProjectReplanSnapshot>>,
  ): Promise<void> {
    if (classification.decision !== "mark_completed") {
      return;
    }
    const entry = snapshot.goals.find(
      (candidate) => candidate.goal.id === classification.goalId,
    );
    const linkedTasksById = new Map(
      entry?.linkedTasks.map((task) => [task.id, task]) ?? [],
    );
    if (
      entry?.goal.status !== "active" ||
      entry.taskLinks.length === 0 ||
      entry.taskLinks.some((link) => linkedTasksById.get(link.taskId)?.status !== "done")
    ) {
      return;
    }

    await this.store.completeGoal(classification.goalId, {
      actor: replanActor,
    });
  }
}
