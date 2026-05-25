import { describe, expect, it, vi } from "vitest";

import { collectProjectSignals } from "../src/domain/projectManager/index.js";
import type {
  TaskLeaseRecord,
  TaskRecord,
  TaskStatus,
  TaskTrackerClient,
} from "../src/domain/taskTracker/index.js";

const baseTask = (overrides: Partial<TaskRecord>): TaskRecord => {
  const now = "2026-05-25T08:00:00.000Z";
  return {
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
    taskType: "backend_endpoint",
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

const lease = (
  overrides: Partial<TaskLeaseRecord> = {},
): TaskLeaseRecord => ({
  leaseId: overrides.leaseId ?? "lease-1",
  kind: "task",
  leaseKey: overrides.leaseKey ?? "task:task-1",
  taskId: overrides.taskId ?? "task-1",
  repositoryName: overrides.repositoryName ?? "developer",
  workerId: overrides.workerId ?? "worker-1",
  token: overrides.token ?? "token",
  expiresAt: overrides.expiresAt ?? "2026-05-25T09:30:00.000Z",
  heartbeatAt: overrides.heartbeatAt ?? "2026-05-25T08:30:00.000Z",
  ...(overrides.releasedAt ? { releasedAt: overrides.releasedAt } : {}),
});

const readonlyTracker = (
  tasks: TaskRecord[],
  leases: TaskLeaseRecord[],
): TaskTrackerClient => {
  const mutatingMethod = vi.fn(() => {
    throw new Error("collector must be read-only");
  });
  return {
    listTasks: vi.fn(async () => tasks),
    listActiveLeases: vi.fn(async () => leases),
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

describe("project manager signal collector", () => {
  it("collects read-only task health signals for one repository", async () => {
    const ready = baseTask({
      id: "ready-task",
      title: "Ready task",
      status: "ready",
      agentRuns: [
        {
          id: "run-1",
          taskId: "ready-task",
          workerId: "worker-1",
          stage: "implementation",
          status: "failed",
          diagnostic: "First implementation failed.",
          startedAt: "2026-05-25T08:05:00.000Z",
          completedAt: "2026-05-25T08:06:00.000Z",
        },
        {
          id: "run-2",
          taskId: "ready-task",
          workerId: "worker-1",
          stage: "implementation",
          status: "failed",
          finalMessage: "Second implementation failed.",
          startedAt: "2026-05-25T08:10:00.000Z",
          completedAt: "2026-05-25T08:11:00.000Z",
        },
      ],
    });
    const failed = baseTask({
      id: "failed-task",
      title: "Failed task",
      status: "failed",
      priority: "high",
      taskType: "tests_only",
      qualityGateRuns: [
        {
          id: "validation-1",
          taskId: "failed-task",
          workerId: "worker-1",
          status: "failed",
          changed: true,
          testsPassed: false,
          lintPassed: true,
          gates: [],
          diagnostic: "Unit test failed.",
          createdAt: "2026-05-25T08:12:00.000Z",
          artifactRefs: [],
        },
        {
          id: "validation-2",
          taskId: "failed-task",
          workerId: "worker-1",
          status: "failed",
          changed: true,
          testsPassed: false,
          lintPassed: true,
          gates: [],
          diagnostic: "Repeated validation failure.",
          summary: "Unit test failed again.",
          createdAt: "2026-05-25T08:20:00.000Z",
          artifactRefs: [],
        },
      ],
      mergeRequests: [
        {
          id: "mr-1",
          taskId: "failed-task",
          workerId: "worker-1",
          branch: "feature/failed-task",
          outcome: "created",
          mergeRequest: {
            id: 10,
            iid: 10,
            url: "https://gitlab.example/mr/10",
            title: "Failed task",
            sourceBranch: "feature/failed-task",
            targetBranch: "main",
          },
          createdAt: "2026-05-25T08:30:00.000Z",
        },
      ],
    });
    const waiting = baseTask({
      id: "waiting-task",
      title: "Waiting task",
      status: "awaiting_human",
      clarificationQuestions: [
        {
          id: "question-1",
          taskId: "waiting-task",
          workerId: "worker-1",
          status: "open",
          question: {
            summary: "Need API choice.",
            blockingReason: "Variant is unclear.",
            question: "Which variant?",
            options: ["A", "B"],
            resumeHint: "Reply with A or B.",
          },
          createdAt: "2026-05-25T08:15:00.000Z",
        },
      ],
    });
    const review = baseTask({
      id: "review-task",
      title: "Review task",
      status: "review",
    });
    const humanTesting = baseTask({
      id: "human-testing-task",
      title: "Human testing task",
      status: "human_testing",
    });
    const otherRepository = baseTask({
      id: "other-repository-task",
      repositoryName: "other",
      status: "failed" as TaskStatus,
    });
    const tracker = readonlyTracker(
      [ready, failed, waiting, review, humanTesting, otherRepository],
      [
        lease({ taskId: "ready-task" }),
        lease({
          leaseId: "lease-other",
          taskId: "other-repository-task",
          repositoryName: "other",
        }),
        lease({
          leaseId: "lease-expired",
          taskId: "failed-task",
          expiresAt: "2026-05-25T07:59:00.000Z",
        }),
      ],
    );

    const snapshot = await collectProjectSignals({
      taskTracker: tracker,
      repositoryName: "developer",
      now: new Date("2026-05-25T08:30:00.000Z"),
      limit: 42,
    });

    expect(tracker.listTasks).toHaveBeenCalledWith({
      repositoryName: "developer",
      limit: 42,
    });
    expect(tracker.listActiveLeases).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      repositoryName: "developer",
      generatedAt: "2026-05-25T08:30:00.000Z",
      totalTasks: 5,
      statusCounts: {
        ready: 1,
        failed: 1,
        awaiting_human: 1,
        review: 1,
        human_testing: 1,
      },
      activeLeases: 1,
    });
    expect(snapshot.readyTasks).toEqual([
      expect.objectContaining({
        id: "ready-task",
        latestAiSummary: "Second implementation failed.",
        failedAgentRuns: 2,
      }),
    ]);
    expect(snapshot.failedTasks).toEqual([
      expect.objectContaining({
        id: "failed-task",
        priority: "high",
        taskType: "tests_only",
        latestValidationSummary: "Unit test failed again.",
        mergeRequestUrl: "https://gitlab.example/mr/10",
        failedValidations: 2,
      }),
    ]);
    expect(snapshot.waitingForHuman).toEqual([
      expect.objectContaining({
        id: "waiting-task",
        blockerReason: "Variant is unclear.",
      }),
    ]);
    expect(snapshot.repeatedFailures.map((task) => task.id).sort()).toEqual([
      "failed-task",
      "ready-task",
    ]);
    expect(snapshot.recentReviewTasks.map((task) => task.id).sort()).toEqual([
      "human-testing-task",
      "review-task",
    ]);
    expect(
      [
        ...snapshot.readyTasks,
        ...snapshot.failedTasks,
        ...snapshot.waitingForHuman,
        ...snapshot.repeatedFailures,
        ...snapshot.recentReviewTasks,
      ].some((task) => task.id === "other-repository-task"),
    ).toBe(false);
  });
});
