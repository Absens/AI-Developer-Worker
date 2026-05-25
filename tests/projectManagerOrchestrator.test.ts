import { describe, expect, it, vi } from "vitest";

import type {
  CodexExecution,
  CodexRunner,
  CodexRunObserver,
  CodexRunOptions,
} from "../src/models/types.js";
import {
  InMemoryProjectManagerStore,
  PROJECT_ANALYSIS_MARKER,
  ProjectManagerOrchestrator,
  type ProjectManagerConfig,
} from "../src/domain/projectManager/index.js";
import type {
  TaskLeaseRecord,
  TaskRecord,
  TaskTrackerClient,
} from "../src/domain/taskTracker/index.js";

const baseTime = "2026-05-25T08:00:00.000Z";

const config: ProjectManagerConfig = {
  enabled: true,
  runOnce: true,
  intervalMinutes: 30,
  maxGoalsPerRun: 2,
  maxTaskProposalsPerGoal: 1,
  defaultAutonomyLevel: "proposal_only",
  autoApproveLowRisk: false,
  allowedTaskTypes: ["documentation", "tests_only"],
  repositoryScanEnabled: false,
  repositoryScanMaxFiles: 20,
  requireHumanGoalApproval: true,
};

const baseTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: overrides.id ?? "task-1",
  title: overrides.title ?? "Task",
  description: "Task description.",
  source: { kind: "native" },
  createdBy: { owner: "human", id: "user-1" },
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: [],
  components: [],
  priority: "normal",
  status: overrides.status ?? "ready",
  taskType: "documentation",
  acceptanceCriteria: [],
  constraints: [],
  riskFactors: [],
  missingContext: [],
  externalRefs: [],
  fieldOwners: [],
  revisions: [],
  events: [],
  comments: [],
  decisions: [],
  plans: [],
  dependencies: [],
  artifacts: [],
  agentRuns: [],
  qualityGateRuns: [],
  mergeRequests: [],
  clarificationQuestions: [],
  humanAnswers: [],
  decompositionDecisions: [],
  reviewMetadata: [],
  memoryContextRefs: [],
  createdAt: baseTime,
  updatedAt: baseTime,
  ...overrides,
});

const readonlyTracker = (tasks: TaskRecord[]): TaskTrackerClient => {
  const mutatingMethod = vi.fn(() => {
    throw new Error("project manager orchestrator must be read-only");
  });
  return {
    listTasks: vi.fn(async () => tasks),
    listActiveLeases: vi.fn(async (): Promise<TaskLeaseRecord[]> => []),
    createTask: mutatingMethod,
    proposeTask: mutatingMethod,
    approveProposal: mutatingMethod,
    rejectProposal: mutatingMethod,
    cleanupProposals: mutatingMethod,
    updateTaskRevision: mutatingMethod,
    updateExternalTaskFields: mutatingMethod,
    attachExternalRef: mutatingMethod,
    markReady: mutatingMethod,
    getTask: mutatingMethod,
    findTaskByExternalRef: mutatingMethod,
    getAgentTaskContext: mutatingMethod,
    appendEvent: mutatingMethod,
    appendComment: mutatingMethod,
    setStatus: mutatingMethod,
    recordDecision: mutatingMethod,
    recordAnalysis: mutatingMethod,
    recordTaskStep: mutatingMethod,
    askClarification: mutatingMethod,
    recordHumanAnswer: mutatingMethod,
    recordAgentRun: mutatingMethod,
    recordValidation: mutatingMethod,
    recordMergeRequest: mutatingMethod,
    recordReviewMetadata: mutatingMethod,
    recordDecomposition: mutatingMethod,
    createChildTasks: mutatingMethod,
    linkDependency: mutatingMethod,
    recordMemoryContext: mutatingMethod,
    addDependency: mutatingMethod,
    claimNextTask: mutatingMethod,
    claimReviewTask: mutatingMethod,
    heartbeatLease: mutatingMethod,
    releaseLease: mutatingMethod,
  } as unknown as TaskTrackerClient;
};

class FakeCodexRunner implements CodexRunner {
  public readonly prompts: string[] = [];
  public readonly options: CodexRunOptions[] = [];

  public constructor(private readonly execution: CodexExecution) {}

  async runInitial(
    prompt: string,
    _observer?: CodexRunObserver,
    options: CodexRunOptions = {},
  ): Promise<CodexExecution> {
    this.prompts.push(prompt);
    this.options.push(options);
    return this.execution;
  }

  async runFix(): Promise<CodexExecution> {
    throw new Error("runFix must not be called");
  }

  async runResume(): Promise<CodexExecution> {
    throw new Error("runResume must not be called");
  }

  async runReview(): Promise<CodexExecution> {
    throw new Error("runReview must not be called");
  }
}

const codexExecution = (finalMessage: string, exitCode = 0): CodexExecution => ({
  process: {
    stdout: "",
    stderr: "",
    exitCode,
  },
  finalMessage,
});

const validAnalysisResponse = `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
  summary: "Repository is healthy enough for a documentation follow-up.",
  healthSignals: [],
  proposedGoals: [
    {
      title: "Improve operator documentation",
      problemStatement: "Operators need clearer project manager run guidance.",
      desiredOutcome: "Runbook covers project manager analysis mode.",
      successMetrics: ["Operator docs explain analysis-only mode"],
      priority: "normal",
      riskLevel: "low",
      evidenceRefs: [
        {
          kind: "file",
          ref: "docs/runbook.md",
        },
      ],
      suggestedTaskProposals: [
        {
          title: "Document project manager analysis mode",
          description: "Add runbook notes for PM analysis-only behavior.",
          taskType: "documentation",
          acceptanceCriteria: ["Runbook documents analysis-only guardrails"],
          expectedBlastRadius: "documentation only",
          evidenceRefs: [
            {
              kind: "file",
              ref: "docs/runbook.md",
            },
          ],
        },
      ],
    },
  ],
  staleGoalIds: [],
})}`;

describe("ProjectManagerOrchestrator", () => {
  it("stores a completed analysis run without mutating tasks", async () => {
    const tracker = readonlyTracker([baseTask()]);
    const codex = new FakeCodexRunner(codexExecution(validAnalysisResponse));
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex,
      store,
      config,
      focusAreas: ["operator docs"],
    });

    const initialTasks = structuredClone(await tracker.listTasks());

    await orchestrator.runAnalysisOnce({
      repositoryName: "developer",
      trigger: "manual",
    });

    const runs = await store.listRuns();
    const analyses = await store.listAnalyses();
    expect(runs).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_run_/),
        repositoryName: "developer",
        trigger: "manual",
        status: "completed",
        proposedGoalIds: [],
        proposedTaskIds: [],
        analysisId: expect.stringMatching(/^pm_analysis_/),
        startedAt: baseTime,
        completedAt: baseTime,
      }),
    ]);
    expect(analyses).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_analysis_/),
        repositoryName: "developer",
        summary: "Repository is healthy enough for a documentation follow-up.",
        createdAt: baseTime,
      }),
    ]);
    expect(runs[0]?.analysisId).toBe(analyses[0]?.id);
    expect(codex.prompts).toHaveLength(1);
    expect(codex.prompts[0]).toContain("Mode: project-management-analysis-only");
    expect(codex.prompts[0]).toContain("Do not create executable tasks directly");
    expect(codex.prompts[0]).toContain("Allowed task types: documentation, tests_only");
    expect(codex.prompts[0]).toContain("Focus areas: operator docs");
    expect(codex.options).toEqual([expect.objectContaining({ sandbox: "read-only" })]);
    expect(await tracker.listTasks()).toEqual(initialTasks);
    expect(tracker.createTask).not.toHaveBeenCalled();
    expect(tracker.proposeTask).not.toHaveBeenCalled();
    expect(tracker.markReady).not.toHaveBeenCalled();
    expect(tracker.setStatus).not.toHaveBeenCalled();
    expect(tracker.appendEvent).not.toHaveBeenCalled();
    expect(tracker.appendComment).not.toHaveBeenCalled();
    expect(tracker.recordAnalysis).not.toHaveBeenCalled();
  });

  it("stores a failed run when Codex output is not valid PROJECT_ANALYSIS", async () => {
    const tracker = readonlyTracker([baseTask()]);
    const codex = new FakeCodexRunner(codexExecution("not project analysis"));
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex,
      store,
      config,
    });

    await expect(
      orchestrator.runAnalysisOnce({
        repositoryName: "developer",
        trigger: "manual",
      }),
    ).rejects.toThrow(/valid PROJECT_ANALYSIS/);

    expect(await store.listAnalyses()).toEqual([]);
    expect(await store.listRuns()).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_run_/),
        repositoryName: "developer",
        trigger: "manual",
        status: "failed",
        diagnostic: expect.stringMatching(/valid PROJECT_ANALYSIS/),
        proposedGoalIds: [],
        proposedTaskIds: [],
        completedAt: baseTime,
      }),
    ]);
  });
});
