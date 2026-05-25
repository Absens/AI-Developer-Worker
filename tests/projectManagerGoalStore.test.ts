import { describe, expect, it } from "vitest";

import {
  buildProjectGoalDuplicateSignature,
  InMemoryProjectManagerStore,
  normalizeProjectGoalTitle,
  PROJECT_GOAL_TERMINAL_STATUSES,
  type ProjectGoalDraft,
} from "../src/domain/projectManager/index.js";

const baseTime = "2026-05-25T08:00:00.000Z";

const goalDraft = (overrides: Partial<ProjectGoalDraft> = {}): ProjectGoalDraft => ({
  title: "Improve operator documentation",
  problemStatement: "Operators need clearer project manager run guidance.",
  desiredOutcome: "Runbook covers project manager analysis mode.",
  successMetrics: ["Operator docs explain analysis-only mode"],
  evidenceRefs: [
    {
      kind: "file",
      ref: "docs/runbook.md",
    },
  ],
  priority: "normal",
  riskLevel: "low",
  suggestedTaskProposals: [],
  ...overrides,
});

const createStore = (): InMemoryProjectManagerStore =>
  new InMemoryProjectManagerStore({
    now: () => new Date(baseTime),
  });

describe("project manager goal policy", () => {
  it("normalizes goal titles by trimming, lowercasing, and collapsing whitespace", () => {
    expect(normalizeProjectGoalTitle("  Improve   Operator\nDocumentation  ")).toBe(
      "improve operator documentation",
    );
  });

  it("builds duplicate signatures stable across title case, whitespace, and evidence order", () => {
    const first = buildProjectGoalDuplicateSignature({
      repositoryName: "developer",
      title: " Improve   Operator Documentation ",
      evidenceRefs: [
        { kind: "file", ref: " DOCS/RUNBOOK.md " },
        { kind: "metric", ref: "Repeated-Failures" },
      ],
    });
    const second = buildProjectGoalDuplicateSignature({
      repositoryName: "developer",
      title: "improve operator\ndocumentation",
      evidenceRefs: [
        { kind: "metric", ref: " repeated-failures " },
        { kind: "file", ref: "docs/runbook.md" },
        { kind: "file", ref: "docs/runbook.md" },
      ],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exports completed, rejected, and stale as terminal goal statuses", () => {
    expect(PROJECT_GOAL_TERMINAL_STATUSES).toEqual([
      "completed",
      "rejected",
      "stale",
    ]);
  });
});

describe("InMemoryProjectManagerStore goals", () => {
  it("creates, lists, and gets goals from analysis drafts", async () => {
    const store = createStore();

    const created = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    expect(created).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_goal_/),
        analysisId: "pm_analysis_1",
        repositoryName: "developer",
        status: "proposed",
        title: "Improve operator documentation",
        problemStatement: "Operators need clearer project manager run guidance.",
        desiredOutcome: "Runbook covers project manager analysis mode.",
        successMetrics: ["Operator docs explain analysis-only mode"],
        evidenceRefs: [{ kind: "file", ref: "docs/runbook.md" }],
        priority: "normal",
        riskLevel: "low",
        createdAt: baseTime,
        duplicateSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    await expect(store.listGoals()).resolves.toEqual(created);
    await expect(store.listGoals({ repositoryName: "developer" })).resolves.toEqual(
      created,
    );
    await expect(store.listGoals({ status: "proposed" })).resolves.toEqual(created);
    await expect(store.getGoal(created[0]!.id)).resolves.toEqual(created[0]);
  });

  it("records audit events for created, approved, rejected, and stale lifecycle changes", async () => {
    const store = createStore();
    const [goalToApprove] = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft({ title: "Approve docs goal" })],
    });
    const [goalToReject] = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft({ title: "Reject docs goal" })],
    });
    const [goalToStale] = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft({ title: "Stale docs goal" })],
    });

    const approved = await store.approveGoal(goalToApprove!.id, {
      approvedBy: "pm-admin",
    });
    const rejected = await store.rejectGoal(goalToReject!.id, {
      rejectedBy: "pm-admin",
      rejectionReason: "Already covered by another initiative.",
    });
    const stale = await store.markGoalStale(goalToStale!.id, {
      staleReason: "Evidence no longer applies.",
    });

    expect(approved).toEqual(
      expect.objectContaining({
        status: "approved",
        approvedBy: "pm-admin",
        approvedAt: baseTime,
      }),
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        status: "rejected",
        rejectedBy: "pm-admin",
        rejectedAt: baseTime,
        rejectionReason: "Already covered by another initiative.",
      }),
    );
    expect(stale).toEqual(
      expect.objectContaining({
        status: "stale",
        staleAt: baseTime,
        staleReason: "Evidence no longer applies.",
      }),
    );
    await expect(store.listGoalEvents(goalToApprove!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created", createdAt: baseTime }),
      expect.objectContaining({
        kind: "project_goal_approved",
        actor: "pm-admin",
        createdAt: baseTime,
      }),
    ]);
    await expect(store.listGoalEvents(goalToReject!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({
        kind: "project_goal_rejected",
        actor: "pm-admin",
        message: "Already covered by another initiative.",
      }),
    ]);
    await expect(store.listGoalEvents(goalToStale!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({
        kind: "project_goal_stale",
        message: "Evidence no longer applies.",
      }),
    ]);
  });

  it("rejects invalid lifecycle transitions with the current status in the error", async () => {
    const store = createStore();
    const [goal] = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    await store.approveGoal(goal!.id, { approvedBy: "pm-admin" });

    await expect(
      store.rejectGoal(goal!.id, {
        rejectedBy: "pm-admin",
        rejectionReason: "No longer needed.",
      }),
    ).rejects.toThrow(/approved/);
  });

  it("skips duplicate non-terminal goals in the same repository", async () => {
    const store = createStore();
    await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    const created = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_2",
      repositoryName: "developer",
      goals: [
        goalDraft({
          title: "  improve   OPERATOR documentation ",
          evidenceRefs: [{ kind: "file", ref: " DOCS/RUNBOOK.md " }],
        }),
      ],
    });

    expect(created).toEqual([]);
    await expect(store.listGoals({ repositoryName: "developer" })).resolves.toHaveLength(
      1,
    );
  });

  it("allows duplicate goals in another repository or after a matching goal is terminal", async () => {
    const store = createStore();
    const [rejectedGoal] = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    const otherRepositoryGoals = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "another-repo",
      goals: [goalDraft()],
    });
    await store.rejectGoal(rejectedGoal!.id, {
      rejectedBy: "pm-admin",
      rejectionReason: "Not needed.",
    });

    const recreatedAfterReject = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_2",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    await store.markGoalStale(recreatedAfterReject[0]!.id, {
      staleReason: "Evidence aged out.",
    });
    const recreatedAfterStale = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_3",
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    expect(otherRepositoryGoals).toHaveLength(1);
    expect(recreatedAfterReject).toHaveLength(1);
    expect(recreatedAfterStale).toHaveLength(1);
    await expect(store.listGoals({ repositoryName: "developer" })).resolves.toHaveLength(
      3,
    );
  });

  it("returns existing goal-task links for duplicate goal, task, and type tuples", async () => {
    const store = createStore();
    const [goal] = await store.createGoalsFromAnalysis({
      analysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    const first = await store.linkGoalTask({
      goalId: goal!.id,
      taskId: "task-1",
      linkType: "implements",
    });
    const second = await store.linkGoalTask({
      goalId: goal!.id,
      taskId: "task-1",
      linkType: "implements",
    });

    expect(second).toEqual(first);
    await expect(store.listGoalTaskLinks(goal!.id)).resolves.toEqual([first]);
  });
});
