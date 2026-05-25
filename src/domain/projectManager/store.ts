import { randomUUID } from "node:crypto";

import type {
  ParsedProjectAnalysis,
  ProjectAnalysis,
  ProjectManagerRun,
  ProjectManagerTrigger,
} from "./types.js";

export interface StartProjectManagerRunInput {
  repositoryName: string;
  trigger: ProjectManagerTrigger;
}

export interface CompleteProjectManagerRunInput {
  analysisId?: string;
  proposedGoalIds?: string[];
  proposedTaskIds?: string[];
}

export interface RecordProjectAnalysisInput extends ParsedProjectAnalysis {
  repositoryName: string;
}

export interface ProjectManagerStore {
  startRun(input: StartProjectManagerRunInput): Promise<ProjectManagerRun>;
  completeRun(
    runId: string,
    input: CompleteProjectManagerRunInput,
  ): Promise<ProjectManagerRun>;
  failRun(runId: string, diagnostic: string): Promise<ProjectManagerRun>;
  recordAnalysis(input: RecordProjectAnalysisInput): Promise<ProjectAnalysis>;
  listRuns(): Promise<ProjectManagerRun[]>;
  listAnalyses(): Promise<ProjectAnalysis[]>;
}

export interface InMemoryProjectManagerStoreInput {
  now?: () => Date;
}

export class InMemoryProjectManagerStore implements ProjectManagerStore {
  private readonly now: () => Date;
  private readonly runs = new Map<string, ProjectManagerRun>();
  private readonly analyses = new Map<string, ProjectAnalysis>();

  public constructor(input: InMemoryProjectManagerStoreInput = {}) {
    this.now = input.now ?? (() => new Date());
  }

  public async startRun(
    input: StartProjectManagerRunInput,
  ): Promise<ProjectManagerRun> {
    const run: ProjectManagerRun = {
      id: `pm_run_${randomUUID()}`,
      repositoryName: input.repositoryName,
      trigger: input.trigger,
      status: "started",
      proposedGoalIds: [],
      proposedTaskIds: [],
      startedAt: this.now().toISOString(),
    };
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  public async completeRun(
    runId: string,
    input: CompleteProjectManagerRunInput,
  ): Promise<ProjectManagerRun> {
    const existing = this.requireRun(runId);
    const completed: ProjectManagerRun = {
      ...existing,
      status: "completed",
      ...(input.analysisId ? { analysisId: input.analysisId } : {}),
      proposedGoalIds: input.proposedGoalIds ?? existing.proposedGoalIds,
      proposedTaskIds: input.proposedTaskIds ?? existing.proposedTaskIds,
      completedAt: this.now().toISOString(),
    };
    this.runs.set(runId, structuredClone(completed));
    return structuredClone(completed);
  }

  public async failRun(
    runId: string,
    diagnostic: string,
  ): Promise<ProjectManagerRun> {
    const existing = this.requireRun(runId);
    const failed: ProjectManagerRun = {
      ...existing,
      status: "failed",
      diagnostic,
      completedAt: this.now().toISOString(),
    };
    this.runs.set(runId, structuredClone(failed));
    return structuredClone(failed);
  }

  public async recordAnalysis(
    input: RecordProjectAnalysisInput,
  ): Promise<ProjectAnalysis> {
    const analysis: ProjectAnalysis = {
      id: `pm_analysis_${randomUUID()}`,
      repositoryName: input.repositoryName,
      summary: input.summary,
      healthSignals: input.healthSignals,
      proposedGoals: input.proposedGoals,
      staleGoalIds: input.staleGoalIds,
      ...(input.replanReason ? { replanReason: input.replanReason } : {}),
      createdAt: this.now().toISOString(),
    };
    this.analyses.set(analysis.id, structuredClone(analysis));
    return structuredClone(analysis);
  }

  public async listRuns(): Promise<ProjectManagerRun[]> {
    return structuredClone([...this.runs.values()]);
  }

  public async listAnalyses(): Promise<ProjectAnalysis[]> {
    return structuredClone([...this.analyses.values()]);
  }

  private requireRun(runId: string): ProjectManagerRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Project manager run not found: ${runId}`);
    }
    return structuredClone(run);
  }
}
