import type { CodexRunner } from "../../models/types.js";
import type { TaskTrackerClient } from "../taskTracker/types.js";
import { assertProjectAnalysisWithinPolicy } from "./analysisPolicy.js";
import { parseProjectAnalysisResponse } from "./analysisParser.js";
import { buildProjectAnalysisPrompt } from "./promptBuilder.js";
import { collectProjectSignals } from "./signalCollector.js";
import type { ProjectManagerStore } from "./store.js";
import type {
  ProjectAnalysis,
  ProjectManagerConfig,
  ProjectManagerRun,
  ProjectManagerTrigger,
} from "./types.js";

export interface ProjectManagerOrchestratorInput {
  taskTracker: TaskTrackerClient;
  codex: CodexRunner;
  store: ProjectManagerStore;
  config: ProjectManagerConfig;
  focusAreas?: string[];
}

export interface RunProjectAnalysisOnceInput {
  repositoryName: string;
  trigger?: ProjectManagerTrigger;
}

export interface RunProjectAnalysisOnceResult {
  run: ProjectManagerRun;
  analysis: ProjectAnalysis;
}

const diagnosticFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ProjectManagerOrchestrator {
  private readonly taskTracker: TaskTrackerClient;
  private readonly codex: CodexRunner;
  private readonly store: ProjectManagerStore;
  private readonly config: ProjectManagerConfig;
  private readonly focusAreas?: string[];

  public constructor(input: ProjectManagerOrchestratorInput) {
    this.taskTracker = input.taskTracker;
    this.codex = input.codex;
    this.store = input.store;
    this.config = input.config;
    this.focusAreas = input.focusAreas ?? input.config.focusAreas;
  }

  public async runAnalysisOnce(
    input: RunProjectAnalysisOnceInput,
  ): Promise<RunProjectAnalysisOnceResult> {
    if (!this.config.enabled) {
      throw new Error("Project manager is disabled.");
    }

    const run = await this.store.startRun({
      repositoryName: input.repositoryName,
      trigger: input.trigger ?? "manual",
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
        ...parsed,
      });
      const completedRun = await this.store.completeRun(run.id, {
        analysisId: analysis.id,
        proposedGoalIds: [],
        proposedTaskIds: [],
      });

      return {
        run: completedRun,
        analysis,
      };
    } catch (error) {
      await this.store.failRun(run.id, diagnosticFor(error));
      throw error;
    }
  }
}
