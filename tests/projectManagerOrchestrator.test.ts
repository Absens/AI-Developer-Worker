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
  PROJECT_REPLAN_MARKER,
  ProjectManagerOrchestrator,
  type ProjectManagerConfig,
  type ProjectGoalDraft,
} from "../src/domain/projectManager/index.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";
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
    getTask: vi.fn(async (taskId: string) => tasks.find((task) => task.id === taskId)),
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

const expectTrackerMutationsUnused = (tracker: TaskTrackerClient): void => {
  expect(tracker.createTask).not.toHaveBeenCalled();
  expect(tracker.proposeTask).not.toHaveBeenCalled();
  expect(tracker.approveProposal).not.toHaveBeenCalled();
  expect(tracker.rejectProposal).not.toHaveBeenCalled();
  expect(tracker.cleanupProposals).not.toHaveBeenCalled();
  expect(tracker.updateTaskRevision).not.toHaveBeenCalled();
  expect(tracker.updateExternalTaskFields).not.toHaveBeenCalled();
  expect(tracker.attachExternalRef).not.toHaveBeenCalled();
  expect(tracker.markReady).not.toHaveBeenCalled();
  expect(tracker.findTaskByExternalRef).not.toHaveBeenCalled();
  expect(tracker.getAgentTaskContext).not.toHaveBeenCalled();
  expect(tracker.appendEvent).not.toHaveBeenCalled();
  expect(tracker.appendComment).not.toHaveBeenCalled();
  expect(tracker.setStatus).not.toHaveBeenCalled();
  expect(tracker.recordDecision).not.toHaveBeenCalled();
  expect(tracker.recordAnalysis).not.toHaveBeenCalled();
  expect(tracker.recordTaskStep).not.toHaveBeenCalled();
  expect(tracker.askClarification).not.toHaveBeenCalled();
  expect(tracker.recordHumanAnswer).not.toHaveBeenCalled();
  expect(tracker.recordAgentRun).not.toHaveBeenCalled();
  expect(tracker.recordValidation).not.toHaveBeenCalled();
  expect(tracker.recordMergeRequest).not.toHaveBeenCalled();
  expect(tracker.recordReviewMetadata).not.toHaveBeenCalled();
  expect(tracker.recordDecomposition).not.toHaveBeenCalled();
  expect(tracker.createChildTasks).not.toHaveBeenCalled();
  expect(tracker.linkDependency).not.toHaveBeenCalled();
  expect(tracker.recordMemoryContext).not.toHaveBeenCalled();
  expect(tracker.addDependency).not.toHaveBeenCalled();
  expect(tracker.claimNextTask).not.toHaveBeenCalled();
  expect(tracker.claimReviewTask).not.toHaveBeenCalled();
  expect(tracker.heartbeatLease).not.toHaveBeenCalled();
  expect(tracker.releaseLease).not.toHaveBeenCalled();
};

const expectTrackerStrictReadOnly = (tracker: TaskTrackerClient): void => {
  expectTrackerMutationsUnused(tracker);
  expect(tracker.getTask).not.toHaveBeenCalled();
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

const analysisResponseWithGoals = (proposedGoals: unknown[]): string =>
  `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
    summary: "Repository is healthy enough for a documentation follow-up.",
    healthSignals: [],
    proposedGoals,
    staleGoalIds: [],
  })}`;

const analysisResponse = (overrides: Record<string, unknown> = {}): string =>
  `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
    summary: "Repository is healthy enough for a documentation follow-up.",
    healthSignals: [],
    proposedGoals: [validGoal()],
    staleGoalIds: [],
    ...overrides,
  })}`;

const replanResponse = (overrides: Record<string, unknown> = {}): string =>
  `${PROJECT_REPLAN_MARKER} ${JSON.stringify({
    summary: "Replanned active project goals after task feedback.",
    healthSignals: [],
    proposedGoals: [],
    staleGoalIds: [],
    replanReason: "task failed validation",
    goalReplans: [],
    ...overrides,
  })}`;

const validEvidenceRef = (ref = "docs/runbook.md"): Record<string, unknown> => ({
  kind: "file",
  ref,
});

const validProposal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: "Document project manager analysis mode",
  description: "Add runbook notes for PM analysis-only behavior.",
  taskType: "documentation",
  acceptanceCriteria: ["Runbook documents analysis-only guardrails"],
  expectedBlastRadius: "documentation only",
  evidenceRefs: [validEvidenceRef()],
  ...overrides,
});

const validHealthSignal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "documentation_gap",
  severity: "medium",
  title: "Documentation gap",
  description: "Operators need clearer PM run guidance.",
  evidenceRefs: [validEvidenceRef()],
  ...overrides,
});

const validGoal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  suggestedTaskProposals: [validProposal()],
  ...overrides,
});

const validGoalDraft = (
  overrides: Record<string, unknown> = {},
): ProjectGoalDraft => validGoal(overrides) as unknown as ProjectGoalDraft;

const createActiveGoal = async (
  store: InMemoryProjectManagerStore,
  goalOverrides: Record<string, unknown> = {},
) => {
  const [goal] = await store.createGoalsFromAnalysis({
    sourceAnalysisId: "pm_analysis_seed",
    repositoryName: "developer",
    goals: [validGoalDraft(goalOverrides)],
  });
  const actor = { owner: "human" as const, id: "user-1" };
  await store.approveGoal(goal!.id, { actor });
  return store.activateGoal(goal!.id, { actor });
};

const expectPolicyFailure = async (
  finalMessage: string,
  expectedDiagnostic: RegExp,
): Promise<void> => {
  const tracker = readonlyTracker([baseTask()]);
  const codex = new FakeCodexRunner(codexExecution(finalMessage));
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
  ).rejects.toThrow(expectedDiagnostic);

  expect(await store.listAnalyses()).toEqual([]);
  expect(await store.listRuns()).toEqual([
    expect.objectContaining({
      repositoryName: "developer",
      status: "failed",
      diagnostic: expect.stringMatching(expectedDiagnostic),
    }),
  ]);
};

describe("ProjectManagerOrchestrator", () => {
  it("stores a completed analysis run and materializes proposed goals without mutating tasks", async () => {
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

    const result = await orchestrator.runAnalysisOnce({
      repositoryName: "developer",
      trigger: "manual",
    });

    const runs = await store.listRuns();
    const analyses = await store.listAnalyses();
    const goals = await store.listGoals();
    expect(goals).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_goal_/),
        repositoryName: "developer",
        sourceAnalysisId: expect.stringMatching(/^pm_analysis_/),
        sourceRunId: expect.stringMatching(/^pm_run_/),
        title: "Improve operator documentation",
        status: "proposed",
        suggestedTaskProposals: [
          expect.objectContaining({
            title: "Document project manager analysis mode",
            taskType: "documentation",
          }),
        ],
      }),
    ]);
    expect(runs).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_run_/),
        repositoryName: "developer",
        trigger: "manual",
        status: "completed",
        proposedGoalIds: [goals[0]?.id],
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
    expect(goals[0]?.sourceAnalysisId).toBe(analyses[0]?.id);
    expect(goals[0]?.sourceRunId).toBe(runs[0]?.id);
    expect(result.run).toEqual(runs[0]);
    expect(result.run.proposedGoalIds).toEqual([goals[0]?.id]);
    expect(codex.prompts).toHaveLength(1);
    expect(codex.prompts[0]).toContain("Mode: project-management-analysis-only");
    expect(codex.prompts[0]).toContain("Do not create executable tasks directly");
    expect(codex.prompts[0]).toContain("Allowed task types: documentation, tests_only");
    expect(codex.prompts[0]).toContain("Focus areas: operator docs");
    expect(codex.options).toEqual([expect.objectContaining({ sandbox: "read-only" })]);
    expect(await tracker.listTasks()).toEqual(initialTasks);
    expectTrackerStrictReadOnly(tracker);
  });

  it("does not materialize duplicate non-terminal goals on repeated analysis", async () => {
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
    });

    const first = await orchestrator.runAnalysisOnce({
      repositoryName: "developer",
      trigger: "manual",
    });
    const second = await orchestrator.runAnalysisOnce({
      repositoryName: "developer",
      trigger: "manual",
    });

    const goals = await store.listGoals({ repositoryName: "developer" });
    const runs = await store.listRuns();
    const analyses = await store.listAnalyses();
    expect(goals).toHaveLength(1);
    expect(analyses).toHaveLength(2);
    expect(first.run.proposedGoalIds).toEqual([goals[0]?.id]);
    expect(second.run.proposedGoalIds).toEqual([]);
    expect(runs).toEqual([
      expect.objectContaining({
        id: first.run.id,
        proposedGoalIds: [goals[0]?.id],
        proposedTaskIds: [],
      }),
      expect.objectContaining({
        id: second.run.id,
        proposedGoalIds: [],
        proposedTaskIds: [],
      }),
    ]);
    expect(goals[0]?.sourceAnalysisId).toBe(first.analysis.id);
    expect(goals[0]?.sourceRunId).toBe(first.run.id);
    expect(codex.prompts).toHaveLength(2);
    expectTrackerStrictReadOnly(tracker);
  });

  it("uses focus areas from project manager config when explicit focus areas are not supplied", async () => {
    const tracker = readonlyTracker([baseTask()]);
    const codex = new FakeCodexRunner(codexExecution(validAnalysisResponse));
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex,
      store,
      config: {
        ...config,
        focusAreas: ["accessibility", "test coverage"],
      },
    });

    await orchestrator.runAnalysisOnce({
      repositoryName: "developer",
      trigger: "manual",
    });

    expect(codex.prompts[0]).toContain("Focus areas: accessibility, test coverage");
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

  it("stores a completed replan run, records classifications, and creates proposed follow-up goals without mutating tasks", async () => {
    const failedTask = baseTask({
      id: "task-failed",
      status: "failed",
      repositoryName: "developer",
      updatedAt: baseTime,
    });
    const tracker = readonlyTracker([failedTask]);
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    const activeGoal = await createActiveGoal(store);
    await store.linkGoalTask({
      goalId: activeGoal.id,
      taskId: failedTask.id,
      linkType: "implements",
    });
    const codex = new FakeCodexRunner(
      codexExecution(
        replanResponse({
          replanReason: "task-failed failed validation",
          proposedGoals: [
            validGoal({
              title: "Document failed validation recovery",
              problemStatement: "Operators need recovery steps after validation fails.",
              desiredOutcome: "Recovery steps are documented.",
              successMetrics: ["Runbook covers failed validation recovery"],
              evidenceRefs: [{ kind: "validation_failure", ref: "task-failed" }],
            }),
          ],
          goalReplans: [
            {
              goalId: activeGoal.id,
              decision: "create_follow_up",
              rationale: "The failed task exposed a separate operator docs gap.",
              evidenceRefs: [{ kind: "validation_failure", ref: "task-failed" }],
              followUpGoals: [
                validGoal({
                  title: "Document failed validation recovery",
                  problemStatement: "Operators need recovery steps after validation fails.",
                  desiredOutcome: "Recovery steps are documented.",
                  successMetrics: ["Runbook covers failed validation recovery"],
                  evidenceRefs: [{ kind: "validation_failure", ref: "task-failed" }],
                }),
              ],
            },
          ],
        }),
      ),
    );
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex,
      store,
      config,
      focusAreas: ["operator docs"],
    });

    const result = await orchestrator.runReplanOnce({
      repositoryName: "developer",
      replanReason: " task-failed failed validation ",
      trigger: "post_task_event",
    });

    const runs = await store.listRuns();
    const analyses = await store.listAnalyses();
    const goals = await store.listGoals({ repositoryName: "developer" });
    const replanEvents = await store.listGoalEvents(activeGoal.id);
    const followUpGoal = goals.find(
      (goal) => goal.title === "Document failed validation recovery",
    );

    expect(runs).toEqual([
      expect.objectContaining({
        id: result.run.id,
        repositoryName: "developer",
        trigger: "post_task_event",
        status: "completed",
        analysisId: result.analysis.id,
        proposedGoalIds: [followUpGoal?.id],
        proposedTaskIds: [],
      }),
    ]);
    expect(analyses).toEqual([
      expect.objectContaining({
        id: result.analysis.id,
        repositoryName: "developer",
        replanReason: "task-failed failed validation",
        goalReplans: [
          expect.objectContaining({
            goalId: activeGoal.id,
            decision: "create_follow_up",
          }),
        ],
      }),
    ]);
    expect(followUpGoal).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^pm_goal_/),
        status: "proposed",
        sourceAnalysisId: result.analysis.id,
        sourceRunId: result.run.id,
      }),
    );
    expect(replanEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "project_goal_replan_classified",
          payload: expect.objectContaining({
            analysisId: result.analysis.id,
            decision: "create_follow_up",
          }),
        }),
      ]),
    );
    expect(codex.prompts[0]).toContain("Mode: project-management-replan-only");
    expect(codex.prompts[0]).toContain("PROJECT_REPLAN:");
    expect(codex.prompts[0]).toContain("Replan reason: task-failed failed validation");
    expect(codex.options).toEqual([expect.objectContaining({ sandbox: "read-only" })]);
    expect(await tracker.listTasks()).toEqual([failedTask]);
    expectTrackerMutationsUnused(tracker);
  });

  it("stores a failed replan run when Codex output is invalid", async () => {
    const tracker = readonlyTracker([baseTask({ repositoryName: "developer" })]);
    const codex = new FakeCodexRunner(codexExecution("not project replan"));
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    await createActiveGoal(store);
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex,
      store,
      config,
    });

    await expect(
      orchestrator.runReplanOnce({
        repositoryName: "developer",
        replanReason: "manual replan",
      }),
    ).rejects.toThrow(/valid PROJECT_REPLAN/);

    expect(await store.listRuns()).toEqual([
      expect.objectContaining({
        repositoryName: "developer",
        status: "failed",
        diagnostic: expect.stringMatching(/valid PROJECT_REPLAN/),
      }),
    ]);
    expect(await store.listAnalyses()).toEqual([]);
  });

  it("auto-completes only safe mark_completed goals", async () => {
    const doneTask = baseTask({
      id: "task-done",
      status: "done",
      repositoryName: "developer",
    });
    const failedTask = baseTask({
      id: "task-still-failed",
      status: "failed",
      repositoryName: "developer",
    });
    const tracker = readonlyTracker([doneTask, failedTask]);
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    const safeGoal = await createActiveGoal(store, { title: "Safe complete goal" });
    const unsafeGoal = await createActiveGoal(store, { title: "Unsafe complete goal" });
    const unresolvedGoal = await createActiveGoal(store, {
      title: "Unresolved linked task goal",
    });
    await store.linkGoalTask({
      goalId: safeGoal.id,
      taskId: doneTask.id,
      linkType: "implements",
    });
    await store.linkGoalTask({
      goalId: unsafeGoal.id,
      taskId: failedTask.id,
      linkType: "implements",
    });
    await store.linkGoalTask({
      goalId: unresolvedGoal.id,
      taskId: doneTask.id,
      linkType: "implements",
    });
    await store.linkGoalTask({
      goalId: unresolvedGoal.id,
      taskId: "task-missing",
      linkType: "implements",
    });
    const codex = new FakeCodexRunner(
      codexExecution(
        replanResponse({
          replanReason: "completion sweep",
          goalReplans: [safeGoal, unsafeGoal, unresolvedGoal].map((goal) => ({
            goalId: goal.id,
            decision: "mark_completed",
            rationale: "Codex believes the linked work is finished.",
            evidenceRefs: [{ kind: "metric", ref: goal.id }],
            followUpGoals: [],
          })),
        }),
      ),
    );
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex,
      store,
      config,
    });

    await orchestrator.runReplanOnce({
      repositoryName: "developer",
      replanReason: "completion sweep",
    });

    await expect(store.getGoal(safeGoal.id)).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        completedBy: expect.objectContaining({
          owner: "policy_admin",
          id: "project-manager-replan",
        }),
      }),
    );
    await expect(store.getGoal(unsafeGoal.id)).resolves.toEqual(
      expect.objectContaining({ status: "active" }),
    );
    await expect(store.getGoal(unresolvedGoal.id)).resolves.toEqual(
      expect.objectContaining({ status: "active" }),
    );
    await expect(store.listGoalEvents(unsafeGoal.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "project_goal_replan_classified" }),
      ]),
    );
  });

  it("rejects replan classifications for unknown goals", async () => {
    const tracker = readonlyTracker([baseTask({ repositoryName: "developer" })]);
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    await createActiveGoal(store);
    const codex = new FakeCodexRunner(
      codexExecution(
        replanResponse({
          goalReplans: [
            {
              goalId: "pm_goal_unknown",
              decision: "continue",
              rationale: "Unknown goal should be rejected.",
              evidenceRefs: [],
              followUpGoals: [],
            },
          ],
        }),
      ),
    );
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex,
      store,
      config,
    });

    await expect(
      orchestrator.runReplanOnce({
        repositoryName: "developer",
        replanReason: "manual replan",
      }),
    ).rejects.toThrow(/unknown or inactive/);

    expect(await store.listRuns()).toEqual([
      expect.objectContaining({
        status: "failed",
        diagnostic: expect.stringMatching(/unknown or inactive/),
      }),
    ]);
  });

  it("records project manager run and replan metrics", async () => {
    const tracker = readonlyTracker([baseTask({ repositoryName: "developer" })]);
    const metrics = new InMemoryMetricsRegistry();
    const analysisCodex = new FakeCodexRunner(codexExecution(validAnalysisResponse));
    const store = new InMemoryProjectManagerStore({
      now: () => new Date(baseTime),
    });
    const analysisOrchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex: analysisCodex,
      store,
      config,
      metrics,
    });
    await analysisOrchestrator.runAnalysisOnce({
      repositoryName: "developer",
      trigger: "manual",
    });
    const activeGoal = await createActiveGoal(store, { title: "Metric replan goal" });
    const replanCodex = new FakeCodexRunner(
      codexExecution(
        replanResponse({
          replanReason: "metric replan",
          goalReplans: [
            {
              goalId: activeGoal.id,
              decision: "continue",
              rationale: "Keep current scope.",
              evidenceRefs: [],
              followUpGoals: [],
            },
          ],
        }),
      ),
    );
    const replanOrchestrator = new ProjectManagerOrchestrator({
      taskTracker: tracker,
      codex: replanCodex,
      store,
      config,
      metrics,
    });

    await replanOrchestrator.runReplanOnce({
      repositoryName: "developer",
      replanReason: "metric replan",
      trigger: "post_task_event",
    });

    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain(
      'ai_developer_project_manager_runs_total{mode="analysis",repository="developer",status="completed",trigger="manual"} 1',
    );
    expect(rendered).toContain(
      'ai_developer_project_manager_runs_total{mode="replan",repository="developer",status="completed",trigger="post_task_event"} 1',
    );
    expect(rendered).toContain(
      'ai_developer_project_replans_total{decision="continue",repository="developer"} 1',
    );
  });

  it("rejects project analysis with more proposed goals than configured", async () => {
    await expectPolicyFailure(
      analysisResponseWithGoals([
        validGoal({ title: "Goal 1" }),
        validGoal({ title: "Goal 2" }),
        validGoal({ title: "Goal 3" }),
      ]),
      /at most 2 proposed goals/,
    );
  });

  it("rejects project analysis with more task proposals than configured", async () => {
    await expectPolicyFailure(
      analysisResponseWithGoals([
        validGoal({
          suggestedTaskProposals: [
            {
              title: "Document project manager analysis mode",
              description: "Add runbook notes for PM analysis-only behavior.",
              taskType: "documentation",
              acceptanceCriteria: ["Runbook documents analysis-only guardrails"],
              evidenceRefs: [
                {
                  kind: "file",
                  ref: "docs/runbook.md",
                },
              ],
            },
            {
              title: "Add tests for project manager docs",
              description: "Add test coverage for PM docs generation.",
              taskType: "tests_only",
              acceptanceCriteria: ["Docs tests cover PM analysis"],
              evidenceRefs: [
                {
                  kind: "file",
                  ref: "tests/docs.test.ts",
                },
              ],
            },
          ],
        }),
      ]),
      /at most 1 task proposals/,
    );
  });

  it("rejects project analysis with task types outside configured policy", async () => {
    await expectPolicyFailure(
      analysisResponseWithGoals([
        validGoal({
          suggestedTaskProposals: [
            {
              title: "Refactor project manager storage",
              description: "Refactor PM store internals.",
              taskType: "refactor",
              acceptanceCriteria: ["Store internals are refactored"],
              evidenceRefs: [
                {
                  kind: "file",
                  ref: "src/domain/projectManager/store.ts",
                },
              ],
            },
          ],
        }),
      ]),
      /Task type refactor is not allowed/,
    );
  });

  it("rejects project analysis with too many health signals", async () => {
    await expectPolicyFailure(
      analysisResponse({
        healthSignals: Array.from({ length: 21 }, (_, index) =>
          validHealthSignal({ title: `Signal ${index}` }),
        ),
      }),
      /at most 20 health signals/,
    );
  });

  it("rejects project analysis with too many stale goal ids", async () => {
    await expectPolicyFailure(
      analysisResponse({
        staleGoalIds: Array.from({ length: 51 }, (_, index) => `goal-${index}`),
      }),
      /staleGoalIds must contain at most 50 entries/,
    );
  });

  it("rejects project analysis with too many nested evidence refs", async () => {
    await expectPolicyFailure(
      analysisResponseWithGoals([
        validGoal({
          evidenceRefs: Array.from({ length: 11 }, (_, index) =>
            validEvidenceRef(`docs/ref-${index}.md`),
          ),
        }),
      ]),
      /evidenceRefs must contain at most 10 entries/,
    );
  });

  it("rejects project analysis with too many success metrics", async () => {
    await expectPolicyFailure(
      analysisResponseWithGoals([
        validGoal({
          successMetrics: Array.from({ length: 11 }, (_, index) => `metric-${index}`),
        }),
      ]),
      /successMetrics must contain at most 10 entries/,
    );
  });

  it("rejects project analysis with too many acceptance criteria", async () => {
    await expectPolicyFailure(
      analysisResponseWithGoals([
        validGoal({
          suggestedTaskProposals: [
            validProposal({
              acceptanceCriteria: Array.from(
                { length: 11 },
                (_, index) => `criterion-${index}`,
              ),
            }),
          ],
        }),
      ]),
      /acceptanceCriteria must contain at most 10 entries/,
    );
  });

  it("rejects project analysis with oversized strings", async () => {
    await expectPolicyFailure(
      analysisResponse({
        summary: "x".repeat(4001),
      }),
      /summary must be at most 4000 characters/,
    );
  });
});
