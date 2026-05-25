import { describe, expect, it } from "vitest";

import {
  buildProjectGoalDuplicateSignature,
  InMemoryProjectManagerStore,
  normalizeProjectGoalTitle,
  PROJECT_GOAL_TERMINAL_STATUSES,
  type ProjectGoalDraft,
} from "../src/domain/projectManager/index.js";
import type { TaskActor } from "../src/domain/taskTracker/index.js";

const baseTime = "2026-05-25T08:00:00.000Z";
const actor: TaskActor = {
  owner: "policy_admin",
  id: "pm-admin",
  displayName: "PM Admin",
};

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
      sourceAnalysisId: "pm_analysis_1",
      sourceRunId: "pm_run_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    expect(created).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_goal_/),
        sourceAnalysisId: "pm_analysis_1",
        sourceRunId: "pm_run_1",
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
        updatedAt: baseTime,
        duplicateSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    await expect(store.listGoals()).resolves.toEqual(created);
    await expect(store.listGoals({ repositoryName: "developer" })).resolves.toEqual(
      created,
    );
    await expect(
      store.listGoals({ sourceAnalysisId: "pm_analysis_1" }),
    ).resolves.toEqual(created);
    await expect(store.listGoals({ status: "proposed" })).resolves.toEqual(created);
    await expect(store.getGoal(created[0]!.id)).resolves.toEqual(created[0]);
  });

  it("records audit events for created, approved, active, completed, rejected, and stale lifecycle changes", async () => {
    const store = createStore();
    const [goalToApprove] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft({ title: "Approve docs goal" })],
    });
    const [goalToComplete] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft({ title: "Complete docs goal" })],
    });
    const [goalToReject] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft({ title: "Reject docs goal" })],
    });
    const [goalToStale] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft({ title: "Stale docs goal" })],
    });

    const approved = await store.approveGoal(goalToApprove!.id, {
      actor,
    });
    const approvedForCompletion = await store.approveGoal(goalToComplete!.id, {
      actor,
    });
    const active = await store.activateGoal(approvedForCompletion.id, {
      actor,
    });
    const completed = await store.completeGoal(active.id, {
      actor,
    });
    const rejected = await store.rejectGoal(goalToReject!.id, {
      actor,
      rejectionReason: "Already covered by another initiative.",
    });
    const stale = await store.markGoalStale(goalToStale!.id, {
      actor,
      staleReason: "Evidence no longer applies.",
    });

    expect(approved).toEqual(
      expect.objectContaining({
        status: "approved",
        approvedBy: actor,
        approvedAt: baseTime,
        updatedAt: baseTime,
      }),
    );
    expect(active).toEqual(
      expect.objectContaining({
        status: "active",
        activatedBy: actor,
        activatedAt: baseTime,
        updatedAt: baseTime,
      }),
    );
    expect(completed).toEqual(
      expect.objectContaining({
        status: "completed",
        completedBy: actor,
        completedAt: baseTime,
        updatedAt: baseTime,
      }),
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        status: "rejected",
        rejectedBy: actor,
        rejectedAt: baseTime,
        rejectionReason: "Already covered by another initiative.",
      }),
    );
    expect(stale).toEqual(
      expect.objectContaining({
        status: "stale",
        staleBy: actor,
        staleAt: baseTime,
        staleReason: "Evidence no longer applies.",
      }),
    );
    await expect(store.listGoalEvents(goalToApprove!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created", createdAt: baseTime }),
      expect.objectContaining({
        kind: "project_goal_approved",
        actor,
        createdAt: baseTime,
      }),
    ]);
    await expect(store.listGoalEvents(goalToComplete!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({
        kind: "project_goal_approved",
        actor,
      }),
      expect.objectContaining({
        kind: "project_goal_activated",
        actor,
      }),
      expect.objectContaining({
        kind: "project_goal_completed",
        actor,
      }),
    ]);
    await expect(store.listGoalEvents(goalToReject!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({
        kind: "project_goal_rejected",
        actor,
        message: "Already covered by another initiative.",
      }),
    ]);
    await expect(store.listGoalEvents(goalToStale!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({
        kind: "project_goal_stale",
        actor,
        message: "Evidence no longer applies.",
      }),
    ]);
  });

  it("rejects invalid lifecycle transitions with the current status in the error", async () => {
    const store = createStore();
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    await store.approveGoal(goal!.id, { actor });

    await expect(
      store.rejectGoal(goal!.id, {
        actor,
        rejectionReason: "No longer needed.",
      }),
    ).rejects.toThrow(/approved/);
  });

  it("skips duplicate non-terminal goals in the same repository", async () => {
    const store = createStore();
    await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    const created = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_2",
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
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    const otherRepositoryGoals = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "another-repo",
      goals: [goalDraft()],
    });
    await store.rejectGoal(rejectedGoal!.id, {
      actor,
      rejectionReason: "Not needed.",
    });

    const recreatedAfterReject = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_2",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    await store.markGoalStale(recreatedAfterReject[0]!.id, {
      actor,
      staleReason: "Evidence aged out.",
    });
    const recreatedAfterStale = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_3",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    await store.approveGoal(recreatedAfterStale[0]!.id, { actor });
    await store.activateGoal(recreatedAfterStale[0]!.id, { actor });
    await store.completeGoal(recreatedAfterStale[0]!.id, { actor });
    const recreatedAfterComplete = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_4",
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    expect(otherRepositoryGoals).toHaveLength(1);
    expect(recreatedAfterReject).toHaveLength(1);
    expect(recreatedAfterStale).toHaveLength(1);
    expect(recreatedAfterComplete).toHaveLength(1);
    await expect(store.listGoals({ repositoryName: "developer" })).resolves.toHaveLength(
      4,
    );
  });

  it("returns existing goal-task links for duplicate goal, task, and type tuples", async () => {
    const store = createStore();
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
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

  it("protects stored goals, events, and links from caller mutations", async () => {
    const store = createStore();
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: "pm_analysis_1",
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    const link = await store.linkGoalTask({
      goalId: goal!.id,
      taskId: "task-1",
      linkType: "implements",
    });

    goal!.successMetrics.push("mutated metric");
    goal!.evidenceRefs[0]!.ref = "mutated.md";
    const events = await store.listGoalEvents(goal!.id);
    events[0]!.payload = { mutated: true };
    const links = await store.listGoalTaskLinks(goal!.id);
    links[0]!.taskId = "mutated-task";

    await expect(store.getGoal(goal!.id)).resolves.toEqual(
      expect.objectContaining({
        successMetrics: ["Operator docs explain analysis-only mode"],
        evidenceRefs: [{ kind: "file", ref: "docs/runbook.md" }],
      }),
    );
    await expect(store.listGoalEvents(goal!.id)).resolves.toEqual([
      expect.objectContaining({
        kind: "project_goal_created",
        payload: {
          sourceAnalysisId: "pm_analysis_1",
          repositoryName: "developer",
        },
      }),
    ]);
    await expect(store.listGoalTaskLinks(goal!.id)).resolves.toEqual([link]);
  });
});
