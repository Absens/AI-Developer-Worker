import { describe, expect, it, vi } from "vitest";

import {
  collectProjectReplanSnapshot,
  collectProjectSignals,
  InMemoryProjectManagerStore,
  type ProjectGoalDraft,
} from "../src/domain/projectManager/index.js";
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
  leases: TaskLeaseRecord[] = [],
  tasksById: Map<string, TaskRecord> = new Map(
    tasks.map((task) => [task.id, task]),
  ),
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
    getTask: vi.fn(async (taskId: string) => {
      const task = tasksById.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return task;
    }),
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

const createGoalDraft = (title: string): ProjectGoalDraft => ({
  title,
  problemStatement: `${title} problem`,
  desiredOutcome: `${title} outcome`,
  successMetrics: [`${title} metric`],
  evidenceRefs: [{ kind: "metric", ref: "TASK-1", summary: "Task evidence" }],
  priority: "normal" as const,
  riskLevel: "medium" as const,
  suggestedTaskProposals: [],
});

const requireValue = <T>(value: T | undefined, label: string): T => {
  if (!value) {
    throw new Error(`Missing test fixture value: ${label}`);
  }
  return value;
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
          finalMessage: "   ",
          diagnostic: "Second implementation failed.",
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
          summary: "",
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
      activeLeases: 2,
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
        latestValidationSummary: "Repeated validation failure.",
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

describe("project manager replan snapshot collector", () => {
  it("collects active/approved goals with linked task summaries for replanning", async () => {
    const failedTask = baseTask({
      id: "failed-task",
      title: "Fix repeated validation failure",
      status: "failed",
      agentRuns: [
        {
          id: "run-1",
          taskId: "failed-task",
          workerId: "worker-1",
          stage: "implementation",
          status: "failed",
          diagnostic: "Implementation failed.",
          startedAt: "2026-05-25T08:10:00.000Z",
          completedAt: "2026-05-25T08:11:00.000Z",
        },
      ],
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
          diagnostic: "Validation failed.",
          createdAt: "2026-05-25T08:20:00.000Z",
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
          summary: "Repeated validation failure.",
          createdAt: "2026-05-25T08:30:00.000Z",
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
            title: "Fix repeated validation failure",
            sourceBranch: "feature/failed-task",
            targetBranch: "main",
          },
          createdAt: "2026-05-25T08:40:00.000Z",
        },
      ],
    });
    const otherRepositoryTask = baseTask({
      id: "other-task",
      repositoryName: "other",
      status: "failed",
    });
    const tracker = readonlyTracker([failedTask, otherRepositoryTask]);
    const store = new InMemoryProjectManagerStore({
      now: () => new Date("2026-05-25T09:00:00.000Z"),
    });
    const analysis = await store.recordAnalysis({
      repositoryName: "developer",
      summary: "Prior PM analysis.",
      healthSignals: [],
      proposedGoals: [createGoalDraft("Stabilize validation")],
      staleGoalIds: [],
    });
    const createdGoals = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [createGoalDraft("Stabilize validation")],
    });
    const proposedGoal = requireValue(createdGoals[0], "proposed goal");
    const approvedGoal = await store.approveGoal(proposedGoal.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    const activeGoal = await store.activateGoal(approvedGoal.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    const link = await store.linkGoalTask({
      goalId: activeGoal.id,
      taskId: "failed-task",
      linkType: "implements",
    });

    const snapshot = await collectProjectReplanSnapshot({
      taskTracker: tracker,
      store,
      repositoryName: "developer",
      replanReason: "failed task needs replanning",
      now: () => new Date("2026-05-25T10:00:00.000Z"),
      limit: 25,
    });

    expect(tracker.listTasks).toHaveBeenCalledWith({
      repositoryName: "developer",
      limit: 25,
    });
    expect(snapshot.repositoryName).toBe("developer");
    expect(snapshot.generatedAt).toBe("2026-05-25T10:00:00.000Z");
    expect(snapshot.replanReason).toBe("failed task needs replanning");
    expect(snapshot.previousAnalysisId).toBe(analysis.id);
    expect(snapshot.previousAnalysisSummary).toBe("Prior PM analysis.");
    expect(snapshot.projectSignals).toMatchObject({
      repositoryName: "developer",
      generatedAt: "2026-05-25T10:00:00.000Z",
      totalTasks: 1,
      failedTasks: [expect.objectContaining({ id: "failed-task" })],
    });
    expect(snapshot.goals).toHaveLength(1);
    expect(snapshot.goals[0]?.goal).toMatchObject({
      id: activeGoal.id,
      title: "Stabilize validation",
      status: "active",
    });
    expect(snapshot.goals[0]?.linkedTasks).toEqual([
      expect.objectContaining({
        id: "failed-task",
        title: "Fix repeated validation failure",
        status: "failed",
        failedAgentRuns: 1,
        failedValidations: 2,
        latestAiSummary: "Implementation failed.",
        latestValidationSummary: "Repeated validation failure.",
        mergeRequestUrl: "https://gitlab.example/mr/10",
      }),
    ]);
    expect(snapshot.goals[0]?.taskLinks).toEqual([link]);
    expect(snapshot.goals[0]?.auditEvents.map((event) => event.kind)).toEqual([
      "project_goal_created",
      "project_goal_approved",
      "project_goal_activated",
    ]);
    expectTrackerMutationsUnused(tracker);
  });

  it("omits terminal goals and linked tasks from other repositories", async () => {
    const listedRepositoryTask = baseTask({
      id: "listed-repo-task",
      title: "Listed repo task",
      status: "ready",
    });
    const linkedRepositoryTask = baseTask({
      id: "linked-repo-task",
      title: "Linked repo task",
      status: "failed",
    });
    const otherRepositoryTask = baseTask({
      id: "other-repo-task",
      title: "Other repo task",
      repositoryName: "other",
      status: "failed",
    });
    const tracker = readonlyTracker(
      [listedRepositoryTask],
      [],
      new Map([
        [listedRepositoryTask.id, listedRepositoryTask],
        [linkedRepositoryTask.id, linkedRepositoryTask],
        [otherRepositoryTask.id, otherRepositoryTask],
      ]),
    );
    const store = new InMemoryProjectManagerStore({
      now: () => new Date("2026-05-25T09:00:00.000Z"),
    });
    const analysis = await store.recordAnalysis({
      repositoryName: "developer",
      summary: "Prior analysis.",
      healthSignals: [],
      proposedGoals: [
        createGoalDraft("Approved goal"),
        createGoalDraft("Active goal"),
        createGoalDraft("Completed goal"),
        createGoalDraft("Rejected goal"),
        createGoalDraft("Stale goal"),
      ],
      staleGoalIds: [],
    });
    const goalCandidates = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [
        createGoalDraft("Approved goal"),
        createGoalDraft("Active goal"),
        createGoalDraft("Completed goal"),
        createGoalDraft("Rejected goal"),
        createGoalDraft("Stale goal"),
      ],
    });
    const approvedCandidate = requireValue(goalCandidates[0], "approved goal");
    const activeCandidate = requireValue(goalCandidates[1], "active goal");
    const completedCandidate = requireValue(goalCandidates[2], "completed goal");
    const rejectedCandidate = requireValue(goalCandidates[3], "rejected goal");
    const staleCandidate = requireValue(goalCandidates[4], "stale goal");
    const approvedGoal = await store.approveGoal(approvedCandidate.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    const activeApprovedGoal = await store.approveGoal(activeCandidate.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    const activeGoal = await store.activateGoal(activeApprovedGoal.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    const completedApprovedGoal = await store.approveGoal(completedCandidate.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    const completedActiveGoal = await store.activateGoal(completedApprovedGoal.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    await store.completeGoal(completedActiveGoal.id, {
      actor: { owner: "human", id: "pm-1" },
    });
    await store.rejectGoal(rejectedCandidate.id, {
      actor: { owner: "human", id: "pm-1" },
      rejectionReason: "Not needed.",
    });
    await store.markGoalStale(staleCandidate.id, {
      actor: { owner: "human", id: "pm-1" },
      staleReason: "Outdated.",
    });
    await store.linkGoalTask({
      goalId: approvedGoal.id,
      taskId: "other-repo-task",
      linkType: "related",
    });
    await store.linkGoalTask({
      goalId: approvedGoal.id,
      taskId: "linked-repo-task",
      linkType: "implements",
    });
    await store.linkGoalTask({
      goalId: activeGoal.id,
      taskId: "linked-repo-task",
      linkType: "implements",
    });
    await store.linkGoalTask({
      goalId: activeGoal.id,
      taskId: "missing-task",
      linkType: "related",
    });

    const snapshot = await collectProjectReplanSnapshot({
      taskTracker: tracker,
      store,
      repositoryName: "developer",
      replanReason: "manual replan",
      now: () => new Date("2026-05-25T10:00:00.000Z"),
    });

    expect(snapshot.goals.map((entry) => entry.goal.id)).toEqual([
      approvedGoal.id,
      activeGoal.id,
    ]);
    expect(snapshot.goals[0]?.taskLinks.map((link) => link.taskId)).toEqual([
      "other-repo-task",
      "linked-repo-task",
    ]);
    expect(snapshot.goals[0]?.linkedTasks.map((task) => task.id)).toEqual([
      "linked-repo-task",
    ]);
    expect(snapshot.goals[1]?.linkedTasks.map((task) => task.id)).toEqual([
      "linked-repo-task",
    ]);
    expect(tracker.getTask).toHaveBeenCalledWith("other-repo-task");
    expect(tracker.getTask).toHaveBeenCalledWith("linked-repo-task");
    expect(tracker.getTask).toHaveBeenCalledWith("missing-task");
    expectTrackerMutationsUnused(tracker);
  });
});
