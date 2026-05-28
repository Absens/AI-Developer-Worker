import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ProjectGoalDraft,
  type ProjectGoalReplanClassification,
  type ProjectGoalStatus,
} from "../src/domain/projectManager/index.js";
import type { TaskActor } from "../src/domain/taskTracker/index.js";
import {
  listInternalTrackerMigrations,
  PostgresProjectManagerStore,
  REQUIRED_INTERNAL_TRACKER_INDEXES,
  REQUIRED_INTERNAL_TRACKER_TABLES,
  type PostgresQueryable,
} from "../src/integrations/internalTracker/index.js";

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
  evidenceRefs: [{ kind: "file", ref: "docs/runbook.md" }],
  priority: "normal",
  riskLevel: "low",
  suggestedTaskProposals: [
    {
      title: "Update runbook",
      description: "Document project manager analysis mode.",
      taskType: "documentation",
      acceptanceCriteria: ["Runbook mentions analysis-only mode"],
      evidenceRefs: [{ kind: "file", ref: "docs/runbook.md" }],
    },
  ],
  ...overrides,
});

const replanClassification = (
  goalId: string,
): ProjectGoalReplanClassification => ({
  goalId,
  decision: "create_follow_up",
  rationale: "The original docs goal needs a follow-up for Windows operators.",
  evidenceRefs: [{ kind: "file", ref: "docs/windows.md" }],
  followUpGoals: [
    goalDraft({
      title: "Document Windows operator flow",
      evidenceRefs: [{ kind: "file", ref: "docs/windows.md" }],
    }),
  ],
  humanQuestion: "Should the Windows guide live in the main runbook?",
});

const queryResult = <T extends QueryResultRow>(
  rows: T[],
  rowCount = rows.length,
): QueryResult<T> => ({
  command: "SELECT",
  oid: 0,
  fields: [],
  rows,
  rowCount,
});

const asQueryResult = <R extends QueryResultRow>(
  result: QueryResult<QueryResultRow>,
): QueryResult<R> => result as unknown as QueryResult<R>;

type ProjectGoalRow = QueryResultRow & {
  id: string;
  source_analysis_id: string;
  source_run_id: string | null;
  repository_name: string;
  status: ProjectGoalStatus;
  title: string;
  problem_statement: string;
  desired_outcome: string;
  success_metrics: string[];
  evidence_refs: unknown;
  priority: string;
  risk_level: string;
  suggested_task_proposals: unknown;
  duplicate_signature: string;
  approved_by: unknown | null;
  approved_at: string | null;
  activated_by: unknown | null;
  activated_at: string | null;
  completed_by: unknown | null;
  completed_at: string | null;
  rejected_by: unknown | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  stale_by: unknown | null;
  stale_at: string | null;
  stale_reason: string | null;
  created_at: string;
  updated_at: string;
};

class ProjectManagerMemoryDb implements PostgresQueryable {
  private readonly runs: QueryResultRow[] = [];
  private readonly analyses: QueryResultRow[] = [];
  private readonly goals: ProjectGoalRow[] = [];
  private readonly events: QueryResultRow[] = [];
  private readonly links: QueryResultRow[] = [];
  private readonly tasks = new Set<string>();
  public readonly projectGoalTaskDuplicateSelects: string[] = [];
  public projectGoalTaskUpdateQueries = 0;

  public seedTask(taskId: string): void {
    this.tasks.add(taskId);
  }

  public async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    const sql = text.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      return asQueryResult(queryResult([]));
    }

    if (sql.startsWith("INSERT INTO project_manager_runs")) {
      const row = {
        id: values[0],
        repository_name: values[1],
        mode: values[2],
        trigger: values[3],
        status: "started",
        analysis_id: null,
        proposed_goal_ids: values[4],
        proposed_task_ids: values[5],
        diagnostic: null,
        started_at: values[6],
        completed_at: null,
      };
      this.runs.push(row);
      return asQueryResult(queryResult([row]));
    }
    if (sql.startsWith("UPDATE project_manager_runs")) {
      const row = this.runs.find((candidate) => candidate.id === values[0]);
      if (!row) {
        return asQueryResult(queryResult([]));
      }
      if (sql.includes("diagnostic")) {
        Object.assign(row, {
          status: "failed",
          diagnostic: values[1],
          completed_at: values[2],
        });
      } else {
        if (
          values[1] &&
          !this.analyses.some((analysis) => analysis.id === values[1])
        ) {
          throw new Error(
            `violates foreign key constraint "project_manager_runs_analysis_id_fkey"`,
          );
        }
        Object.assign(row, {
          status: "completed",
          analysis_id: values[1],
          proposed_goal_ids: values[2],
          proposed_task_ids: values[3],
          completed_at: values[4],
        });
      }
      return asQueryResult(queryResult([row]));
    }
    if (sql.includes("FROM project_manager_runs")) {
      return asQueryResult(queryResult([...this.runs]));
    }

    if (sql.startsWith("INSERT INTO project_analyses")) {
      const row = {
        id: values[0],
        repository_name: values[1],
        analysis_kind: values[2],
        summary: values[3],
        health_signals: JSON.parse(String(values[4])),
        proposed_goals: JSON.parse(String(values[5])),
        stale_goal_ids: values[6],
        replan_reason: values[7],
        previous_analysis_id: values[8],
        goal_replans: JSON.parse(String(values[9])),
        strategy_analysis_lenses: JSON.parse(String(values[10])),
        strategy_opportunities: JSON.parse(String(values[11])),
        strategy_goal_links: JSON.parse(String(values[12])),
        strategy_questions: JSON.parse(String(values[13])),
        strategy_brief: values[14],
        created_at: values[15],
      };
      this.analyses.push(row);
      return asQueryResult(queryResult([row]));
    }
    if (sql.includes("FROM project_analyses")) {
      return asQueryResult(queryResult([...this.analyses]));
    }

    if (sql.startsWith("SELECT 1 FROM tasks")) {
      return asQueryResult(
        queryResult(this.tasks.has(String(values[0])) ? [{ "?column?": 1 }] : []),
      );
    }

    if (sql.startsWith("INSERT INTO project_goals")) {
      if (!this.analyses.some((analysis) => analysis.id === values[1])) {
        throw new Error(
          `violates foreign key constraint "project_goals_source_analysis_id_fkey"`,
        );
      }
      if (values[2] && !this.runs.some((run) => run.id === values[2])) {
        throw new Error(
          `violates foreign key constraint "project_goals_source_run_id_fkey"`,
        );
      }
      const duplicate = this.goals.find(
        (goal) =>
          goal.repository_name === values[3] &&
          goal.duplicate_signature === values[12] &&
          !["completed", "rejected", "stale"].includes(goal.status),
      );
      if (duplicate) {
        return asQueryResult(queryResult([]));
      }
      const row: ProjectGoalRow = {
        id: String(values[0]),
        source_analysis_id: String(values[1]),
        source_run_id: values[2] ? String(values[2]) : null,
        repository_name: String(values[3]),
        status: "proposed",
        title: String(values[4]),
        problem_statement: String(values[5]),
        desired_outcome: String(values[6]),
        success_metrics: values[7] as string[],
        evidence_refs: JSON.parse(String(values[8])),
        priority: String(values[9]),
        risk_level: String(values[10]),
        suggested_task_proposals: JSON.parse(String(values[11])),
        duplicate_signature: String(values[12]),
        approved_by: null,
        approved_at: null,
        activated_by: null,
        activated_at: null,
        completed_by: null,
        completed_at: null,
        rejected_by: null,
        rejected_at: null,
        rejection_reason: null,
        stale_by: null,
        stale_at: null,
        stale_reason: null,
        created_at: String(values[13]),
        updated_at: String(values[14]),
      };
      this.goals.push(row);
      return asQueryResult(queryResult([row]));
    }
    if (sql.startsWith("UPDATE project_goals")) {
      const row = this.goals.find((goal) => goal.id === values[0]);
      if (!row) {
        return asQueryResult(queryResult([]));
      }
      row.status = values[1] as ProjectGoalStatus;
      row.updated_at = String(values[2]);
      const jsonValue = (value: unknown): unknown | null =>
        value === null || value === undefined ? null : JSON.parse(String(value));
      if (sql.includes("approved_by")) {
        row.approved_by = jsonValue(values[3]);
        row.approved_at = String(values[2]);
      }
      if (sql.includes("activated_by")) {
        row.activated_by = jsonValue(values[3]);
        row.activated_at = String(values[2]);
      }
      if (sql.includes("completed_by")) {
        row.completed_by = jsonValue(values[3]);
        row.completed_at = String(values[2]);
      }
      if (sql.includes("rejected_by")) {
        row.rejected_by = jsonValue(values[3]);
        row.rejected_at = String(values[2]);
        row.rejection_reason = String(values[4]);
      }
      if (sql.includes("stale_by")) {
        row.stale_by = jsonValue(values[3]);
        row.stale_at = String(values[2]);
        row.stale_reason = String(values[4]);
      }
      return asQueryResult(queryResult([row]));
    }
    if (sql.includes("FROM project_goals")) {
      if (sql.includes("id = $1")) {
        const row = this.goals.find((goal) => goal.id === values[0]);
        return asQueryResult(queryResult(row ? [row] : []));
      }
      let rows = [...this.goals];
      let valueIndex = 0;
      if (sql.includes("repository_name =")) {
        const repositoryName = values[valueIndex++];
        rows = rows.filter((goal) => goal.repository_name === repositoryName);
      }
      if (sql.includes("source_analysis_id =")) {
        const sourceAnalysisId = values[valueIndex++];
        rows = rows.filter((goal) => goal.source_analysis_id === sourceAnalysisId);
      }
      if (sql.includes("status = ANY")) {
        const statuses = values[valueIndex++] as string[];
        rows = rows.filter((goal) => statuses.includes(goal.status));
      }
      return asQueryResult(queryResult(rows));
    }

    if (sql.startsWith("INSERT INTO project_goal_events")) {
      const row = {
        id: values[0],
        goal_id: values[1],
        kind: values[2],
        actor: values[3] ? JSON.parse(String(values[3])) : null,
        message: values[4],
        payload: values[5] ? JSON.parse(String(values[5])) : null,
        created_at: values[6],
      };
      this.events.push(row);
      return asQueryResult(queryResult([row]));
    }
    if (sql.includes("FROM project_goal_events")) {
      return asQueryResult(
        queryResult(this.events.filter((event) => event.goal_id === values[0])),
      );
    }

    if (sql.startsWith("INSERT INTO project_goal_tasks")) {
      if (sql.includes("DO UPDATE")) {
        this.projectGoalTaskUpdateQueries += 1;
        throw new Error("project_goal_tasks duplicate handling must not use DO UPDATE");
      }
      if (!this.tasks.has(String(values[2]))) {
        throw new Error(
          `violates foreign key constraint "project_goal_tasks_task_id_fkey"`,
        );
      }
      const existing = this.links.find(
        (link) =>
          link.goal_id === values[1] &&
          link.task_id === values[2] &&
          link.link_type === values[3],
      );
      if (existing) {
        return asQueryResult(queryResult([]));
      }
      const row = {
        id: values[0],
        goal_id: values[1],
        task_id: values[2],
        link_type: values[3],
        created_at: values[4],
      };
      this.links.push(row);
      return asQueryResult(queryResult([row]));
    }
    if (sql.includes("FROM project_goal_tasks")) {
      if (sql.includes("task_id = ANY")) {
        const taskIds = values[0] as string[];
        return asQueryResult(
          queryResult(this.links.filter((link) => taskIds.includes(String(link.task_id)))),
        );
      }
      if (sql.includes("task_id =") && sql.includes("link_type =")) {
        this.projectGoalTaskDuplicateSelects.push(sql);
        return asQueryResult(
          queryResult(
            this.links.filter(
              (link) =>
                link.goal_id === values[0] &&
                link.task_id === values[1] &&
                link.link_type === values[2],
            ),
          ),
        );
      }
      return asQueryResult(
        queryResult(this.links.filter((link) => link.goal_id === values[0])),
      );
    }

    throw new Error(`Unexpected SQL in project manager store test: ${sql}`);
  }
}

const createStoreWithDb = (): {
  db: ProjectManagerMemoryDb;
  store: PostgresProjectManagerStore;
} => {
  const db = new ProjectManagerMemoryDb();
  return {
    db,
    store: new PostgresProjectManagerStore(db, {
      now: () => new Date(baseTime),
    }),
  };
};

const createStore = (): PostgresProjectManagerStore =>
  new PostgresProjectManagerStore(new ProjectManagerMemoryDb(), {
    now: () => new Date(baseTime),
  });

const recordTestAnalysis = (
  store: PostgresProjectManagerStore,
  overrides: {
    repositoryName?: string;
    summary?: string;
    proposedGoals?: ProjectGoalDraft[];
  } = {},
) =>
  store.recordAnalysis({
    repositoryName: overrides.repositoryName ?? "developer",
    analysisKind: "analysis",
    summary: overrides.summary ?? "Docs need attention.",
    healthSignals: [],
    proposedGoals: overrides.proposedGoals ?? [goalDraft()],
    staleGoalIds: [],
  });

describe("PostgresProjectManagerStore", () => {
  it("persists strategy run mode and analysis metadata", async () => {
    const { store } = createStoreWithDb();

    const run = await store.startRun({
      repositoryName: "developer",
      trigger: "manual",
      mode: "strategy",
    });
    expect(run.mode).toBe("strategy");

    const analysis = await store.recordAnalysis({
      repositoryName: "developer",
      analysisKind: "strategy",
      summary: "Strategy summary.",
      healthSignals: [],
      proposedGoals: [],
      staleGoalIds: [],
      goalReplans: [],
      strategyAnalysisLenses: [{ lens: "risk", summary: "Limit fan-out." }],
      strategyOpportunities: [],
      strategyGoalLinks: [],
      strategyQuestions: [
        {
          question: "Which workflow matters most?",
          whyItMatters: "Product context is missing.",
        },
      ],
      strategyBrief: "Focus on operator confidence.",
    });

    const analyses = await store.listAnalyses();
    expect(
      analyses.find((candidate) => candidate.id === analysis.id),
    ).toMatchObject({
      analysisKind: "strategy",
      strategyBrief: "Focus on operator confidence.",
      strategyQuestions: [
        expect.objectContaining({ question: "Which workflow matters most?" }),
      ],
    });
  });

  it("persists runs and analyses with optional fields", async () => {
    const store = createStore();

    const run = await store.startRun({
      repositoryName: "developer",
      mode: "analysis",
      trigger: "manual",
    });
    const analysis = await store.recordAnalysis({
      repositoryName: "developer",
      analysisKind: "replan",
      summary: "Docs need attention.",
      healthSignals: [
        {
          kind: "documentation_gap",
          severity: "medium",
          title: "Missing runbook",
          description: "The PM runbook omits analysis mode.",
          evidenceRefs: [{ kind: "file", ref: "docs/runbook.md" }],
          recommendation: "Update the runbook.",
        },
      ],
      proposedGoals: [goalDraft()],
      staleGoalIds: ["pm_goal_old"],
      replanReason: "New operator signal.",
    });
    const completed = await store.completeRun(run.id, {
      analysisId: analysis.id,
      proposedGoalIds: ["pm_goal_1"],
      proposedTaskIds: [],
    });
    const failedRun = await store.startRun({
      repositoryName: "developer",
      mode: "analysis",
      trigger: "schedule",
    });

    await store.failRun(failedRun.id, "codex failed");

    expect(completed).toEqual(
      expect.objectContaining({
        id: run.id,
        status: "completed",
        analysisId: analysis.id,
        proposedGoalIds: ["pm_goal_1"],
        proposedTaskIds: [],
        startedAt: baseTime,
        completedAt: baseTime,
      }),
    );
    await expect(store.listAnalyses()).resolves.toEqual([
      expect.objectContaining({
        id: analysis.id,
        repositoryName: "developer",
        summary: "Docs need attention.",
        proposedGoals: [goalDraft()],
        staleGoalIds: ["pm_goal_old"],
        replanReason: "New operator signal.",
        createdAt: baseTime,
      }),
    ]);
    await expect(store.listRuns()).resolves.toEqual([
      expect.objectContaining({ id: run.id, status: "completed" }),
      expect.objectContaining({
        id: failedRun.id,
        status: "failed",
        diagnostic: "codex failed",
      }),
    ]);
  });

  it("creates, lists, gets, skips active duplicates, and recreates terminal duplicates", async () => {
    const store = createStore();
    const run = await store.startRun({
      repositoryName: "developer",
      mode: "analysis",
      trigger: "manual",
    });
    const analysis1 = await recordTestAnalysis(store);
    const analysis2 = await recordTestAnalysis(store);
    const otherRepositoryAnalysis = await recordTestAnalysis(store, {
      repositoryName: "other-repo",
    });
    const analysis3 = await recordTestAnalysis(store);
    const analysis4 = await recordTestAnalysis(store);
    const analysis5 = await recordTestAnalysis(store);

    const created = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis1.id,
      sourceRunId: run.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    const duplicate = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis2.id,
      repositoryName: "developer",
      goals: [
        goalDraft({
          title: "  improve   OPERATOR documentation ",
          evidenceRefs: [{ kind: "file", ref: " DOCS/RUNBOOK.md " }],
        }),
      ],
    });
    const otherRepository = await store.createGoalsFromAnalysis({
      sourceAnalysisId: otherRepositoryAnalysis.id,
      repositoryName: "other-repo",
      goals: [goalDraft()],
    });

    await store.rejectGoal(created[0]!.id, {
      actor,
      rejectionReason: "Already handled.",
    });
    const recreated = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis3.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    await store.markGoalStale(recreated[0]!.id, {
      actor,
      staleReason: "Evidence aged out.",
    });
    const recreatedAfterStale = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis4.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    await store.approveGoal(recreatedAfterStale[0]!.id, { actor });
    await store.activateGoal(recreatedAfterStale[0]!.id, { actor });
    await store.completeGoal(recreatedAfterStale[0]!.id, { actor });
    const recreatedAfterComplete = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis5.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    expect(created).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pm_goal_/),
        sourceAnalysisId: analysis1.id,
        sourceRunId: run.id,
        repositoryName: "developer",
        status: "proposed",
        title: "Improve operator documentation",
        suggestedTaskProposals: goalDraft().suggestedTaskProposals,
        duplicateSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
        createdAt: baseTime,
        updatedAt: baseTime,
      }),
    ]);
    expect(duplicate).toEqual([]);
    expect(otherRepository).toHaveLength(1);
    expect(recreated).toHaveLength(1);
    expect(recreatedAfterStale).toHaveLength(1);
    expect(recreatedAfterComplete).toHaveLength(1);
    await expect(store.getGoal(created[0]!.id)).resolves.toEqual(
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "Already handled.",
      }),
    );
    await expect(
      store.listGoals({
        repositoryName: "developer",
        status: ["rejected", "stale", "completed", "proposed"],
      }),
    ).resolves.toHaveLength(4);
    await expect(store.listGoalEvents(created[0]!.id)).resolves.toEqual([
      expect.objectContaining({
        kind: "project_goal_created",
        payload: {
          sourceAnalysisId: analysis1.id,
          sourceRunId: run.id,
          repositoryName: "developer",
        },
      }),
      expect.objectContaining({
        kind: "project_goal_rejected",
        actor,
        message: "Already handled.",
      }),
    ]);
  });

  it("persists lifecycle transitions and reports invalid current statuses", async () => {
    const store = createStore();
    const analysis = await recordTestAnalysis(store);
    const [goalToComplete] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [goalDraft({ title: "Complete docs goal" })],
    });
    const [goalToStale] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [goalDraft({ title: "Stale docs goal" })],
    });

    const approved = await store.approveGoal(goalToComplete!.id, { actor });
    const active = await store.activateGoal(approved.id, { actor });
    const completed = await store.completeGoal(active.id, { actor });
    const stale = await store.markGoalStale(goalToStale!.id, {
      actor,
      staleReason: "Evidence no longer applies.",
    });

    expect(completed).toEqual(
      expect.objectContaining({
        status: "completed",
        approvedBy: actor,
        approvedAt: baseTime,
        activatedBy: actor,
        activatedAt: baseTime,
        completedBy: actor,
        completedAt: baseTime,
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
    await expect(
      store.rejectGoal(approved.id, {
        actor,
        rejectionReason: "Too late.",
      }),
    ).rejects.toThrow(/completed/);
    await expect(store.listGoalEvents(goalToComplete!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({ kind: "project_goal_approved", actor }),
      expect.objectContaining({ kind: "project_goal_activated", actor }),
      expect.objectContaining({ kind: "project_goal_completed", actor }),
    ]);
  });

  it("persists replan analysis fields and goal replan audit events", async () => {
    const store = createStore();
    const analysis1 = await recordTestAnalysis(store);
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis1.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    const classification = replanClassification(goal!.id);

    const analysis2 = await store.recordAnalysis({
      repositoryName: "developer",
      analysisKind: "replan",
      summary: "Docs need replan.",
      healthSignals: [],
      proposedGoals: [],
      staleGoalIds: [],
      previousAnalysisId: analysis1.id,
      replanReason: "Operator flow changed.",
      goalReplans: [classification],
    });
    classification.evidenceRefs[0]!.ref = "mutated.md";
    classification.followUpGoals[0]!.title = "Mutated title";

    await expect(store.listAnalyses()).resolves.toEqual([
      expect.objectContaining({
        id: analysis1.id,
        goalReplans: [],
      }),
      expect.objectContaining({
        id: analysis2.id,
        previousAnalysisId: analysis1.id,
        replanReason: "Operator flow changed.",
        goalReplans: [
          expect.objectContaining({
            goalId: goal!.id,
            decision: "create_follow_up",
            rationale:
              "The original docs goal needs a follow-up for Windows operators.",
            evidenceRefs: [{ kind: "file", ref: "docs/windows.md" }],
            followUpGoals: [
              expect.objectContaining({
                title: "Document Windows operator flow",
              }),
            ],
            humanQuestion: "Should the Windows guide live in the main runbook?",
          }),
        ],
      }),
    ]);

    const event = await store.recordGoalReplanClassification({
      goalId: goal!.id,
      analysisId: analysis2.id,
      classification: replanClassification(goal!.id),
    });

    expect(event).toEqual(
      expect.objectContaining({
        goalId: goal!.id,
        kind: "project_goal_replan_classified",
        message: "The original docs goal needs a follow-up for Windows operators.",
        payload: expect.objectContaining({
          analysisId: analysis2.id,
          decision: "create_follow_up",
          rationale:
            "The original docs goal needs a follow-up for Windows operators.",
          evidenceRefs: [{ kind: "file", ref: "docs/windows.md" }],
          followUpGoals: [
            expect.objectContaining({
              title: "Document Windows operator flow",
            }),
          ],
          humanQuestion: "Should the Windows guide live in the main runbook?",
        }),
        createdAt: baseTime,
      }),
    );
    event.payload = { mutated: true };
    await expect(store.listGoalEvents(goal!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({
        kind: "project_goal_replan_classified",
        payload: expect.objectContaining({
          analysisId: analysis2.id,
          evidenceRefs: [{ kind: "file", ref: "docs/windows.md" }],
          followUpGoals: [
            expect.objectContaining({
              title: "Document Windows operator flow",
            }),
          ],
        }),
      }),
    ]);
  });

  it("returns existing goal-task links for duplicate tuples and requires goals for reads", async () => {
    const { db, store } = createStoreWithDb();
    db.seedTask("task-1");
    const analysis = await recordTestAnalysis(store);
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
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
    expect(db.projectGoalTaskUpdateQueries).toBe(0);
    expect(db.projectGoalTaskDuplicateSelects).toHaveLength(1);
    await expect(store.listGoalTaskLinks(goal!.id)).resolves.toEqual([first]);
    await expect(store.listGoalEvents("pm_goal_missing")).rejects.toThrow(
      /Project manager goal not found/,
    );
    await expect(store.listGoalTaskLinks("pm_goal_missing")).rejects.toThrow(
      /Project manager goal not found/,
    );
  });

  it("lists goal task links by task ids", async () => {
    const { db, store } = createStoreWithDb();
    db.seedTask("task-pg-1");
    db.seedTask("task-pg-2");
    const analysis = await recordTestAnalysis(store);
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [goalDraft({ title: "Link lookup goal" })],
    });
    const first = await store.linkGoalTask({
      goalId: goal!.id,
      taskId: "task-pg-1",
      linkType: "proposed_task",
    });
    await store.linkGoalTask({
      goalId: goal!.id,
      taskId: "task-pg-2",
      linkType: "proposed_task",
    });

    await expect(
      store.listGoalTaskLinksForTaskIds(["task-pg-1", "missing"]),
    ).resolves.toEqual([first]);
  });

  it("rejects goals created for a missing source analysis", async () => {
    const store = createStore();

    await expect(
      store.createGoalsFromAnalysis({
        sourceAnalysisId: "pm_analysis_missing",
        repositoryName: "developer",
        goals: [goalDraft()],
      }),
    ).rejects.toThrow(/project_goals_source_analysis_id_fkey/);
  });

  it("rejects goals created for a missing source run", async () => {
    const store = createStore();
    const analysis = await recordTestAnalysis(store);

    await expect(
      store.createGoalsFromAnalysis({
        sourceAnalysisId: analysis.id,
        sourceRunId: "pm_run_missing",
        repositoryName: "developer",
        goals: [goalDraft()],
      }),
    ).rejects.toThrow(/project_goals_source_run_id_fkey/);
  });

  it("rejects goal-task links for missing tasks with a clear error", async () => {
    const store = createStore();
    const analysis = await recordTestAnalysis(store);
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    await expect(
      store.linkGoalTask({
        goalId: goal!.id,
        taskId: "task-missing",
        linkType: "implements",
      }),
    ).rejects.toThrow("Project manager linked task not found: task-missing");
  });
});

describe("project manager internal tracker migrations", () => {
  it("exports required project manager relations for preflight checks", () => {
    expect(REQUIRED_INTERNAL_TRACKER_TABLES).toEqual(
      expect.arrayContaining([
        "project_manager_runs",
        "project_analyses",
        "project_goals",
        "project_goal_events",
        "project_goal_tasks",
      ]),
    );
    expect(REQUIRED_INTERNAL_TRACKER_INDEXES).toEqual(
      expect.arrayContaining([
        "project_manager_runs_repository_time_idx",
        "project_analyses_repository_time_idx",
        "project_analyses_repository_kind_time_idx",
        "project_analyses_previous_analysis_idx",
        "project_goals_repository_status_idx",
        "project_goals_duplicate_signature_idx",
        "project_goals_active_duplicate_signature_unique_idx",
        "project_goal_events_goal_time_idx",
        "project_goal_tasks_goal_idx",
        "project_goal_tasks_task_idx",
      ]),
    );
  });

  it("includes a migration for project manager goals with active duplicate protection", () => {
    const migration = listInternalTrackerMigrations().find(
      (candidate) => candidate.filename === "0007_project_manager_goals.sql",
    );

    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS project_goals");
    expect(migration?.sql).toContain(
      "CONSTRAINT project_manager_runs_analysis_id_fkey",
    );
    expect(migration?.sql).toContain(
      "CONSTRAINT project_goals_source_analysis_id_fkey",
    );
    expect(migration?.sql).toContain(
      "CONSTRAINT project_goals_source_run_id_fkey",
    );
    expect(migration?.sql).toContain(
      "CONSTRAINT project_goal_tasks_task_id_fkey",
    );
    expect(migration?.sql).toContain(
      "project_goals_active_duplicate_signature_unique_idx",
    );
    expect(migration?.sql).toContain("WHERE status NOT IN");
  });

  it("includes a migration for project manager replan persistence", () => {
    const migration = listInternalTrackerMigrations().find(
      (candidate) => candidate.filename === "0008_project_manager_replans.sql",
    );

    expect(migration?.sql).toContain("previous_analysis_id text NULL");
    expect(migration?.sql).toContain("goal_replans jsonb NOT NULL DEFAULT");
    expect(migration?.sql).toContain("project_analyses_previous_analysis_idx");
    expect(migration?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS project_goal_events_kind_check",
    );
    expect(migration?.sql).toContain(
      "ADD CONSTRAINT project_goal_events_kind_check",
    );
    expect(migration?.sql).toContain("'project_goal_replan_classified'");
  });

  it("includes a follow-up migration backfill for existing replan analyses and runs", () => {
    const migration = listInternalTrackerMigrations().find(
      (candidate) =>
        candidate.filename === "0010_project_manager_strategy_backfill.sql",
    );

    expect(migration?.sql).toContain("UPDATE project_analyses");
    expect(migration?.sql).toContain("analysis_kind = 'replan'");
    expect(migration?.sql).toContain(
      "(analysis_kind IS NULL OR analysis_kind = 'analysis')",
    );
    expect(migration?.sql).toContain("replan_reason IS NOT NULL");
    expect(migration?.sql).toContain("jsonb_array_length(goal_replans)");
    expect(migration?.sql).toContain("UPDATE project_manager_runs");
    expect(migration?.sql).toContain("mode = 'replan'");
    expect(migration?.sql).toContain("analysis_id");
    expect(migration?.sql).toContain("ALTER COLUMN mode DROP DEFAULT");
    expect(migration?.sql).toContain(
      "ALTER COLUMN analysis_kind DROP DEFAULT",
    );
    expect(migration?.sql).toContain(
      "project_analyses_repository_kind_time_idx",
    );
  });

  it("includes a migration for project manager strategy persistence", () => {
    const migration = listInternalTrackerMigrations().find(
      (candidate) => candidate.filename === "0009_project_manager_strategy.sql",
    );

    expect(migration?.sql).toContain("ADD COLUMN IF NOT EXISTS mode text");
    expect(migration?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS analysis_kind text",
    );
    expect(migration?.sql).toContain("strategy_opportunities jsonb");
    expect(migration?.sql).toContain("project_manager_runs_mode_check");
    expect(migration?.sql).toContain("project_analyses_analysis_kind_check");
  });
});

const testDatabaseUrl = process.env.TASK_TRACKER_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("PostgresProjectManagerStore with real PostgreSQL", () => {
  let pg: Client;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `pm_store_${randomUUID().replace(/-/g, "")}`;
    pg = new Client({ connectionString: testDatabaseUrl });
    await pg.connect();
    await pg.query(`CREATE SCHEMA ${schemaName}`);
    await pg.query(`SET search_path TO ${schemaName}`);

    const migrationDir = new URL(
      "../src/integrations/internalTracker/migrations/",
      import.meta.url,
    );
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
      await pg.query(readFileSync(new URL(file, migrationDir), "utf8"));
    }
  });

  afterEach(async () => {
    await pg.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    await pg.end().catch(() => undefined);
  });

  it("persists goals and skips active duplicates through PostgreSQL constraints", async () => {
    const store = new PostgresProjectManagerStore(pg, {
      now: () => new Date(baseTime),
    });
    const analysis = await recordTestAnalysis(store);
    const duplicateAnalysis = await recordTestAnalysis(store);

    const first = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    const duplicate = await store.createGoalsFromAnalysis({
      sourceAnalysisId: duplicateAnalysis.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });

    expect(first).toHaveLength(1);
    expect(duplicate).toEqual([]);
    await expect(store.listGoalEvents(first[0]!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
    ]);
  });

  it("persists replan analyses and classified events through PostgreSQL constraints", async () => {
    const store = new PostgresProjectManagerStore(pg, {
      now: () => new Date(baseTime),
    });
    const previousAnalysis = await recordTestAnalysis(store);
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: previousAnalysis.id,
      repositoryName: "developer",
      goals: [goalDraft()],
    });
    const classification = replanClassification(goal!.id);

    const replanAnalysis = await store.recordAnalysis({
      repositoryName: "developer",
      analysisKind: "replan",
      summary: "Docs need replan.",
      healthSignals: [],
      proposedGoals: [],
      staleGoalIds: [],
      previousAnalysisId: previousAnalysis.id,
      replanReason: "Operator flow changed.",
      goalReplans: [classification],
    });
    const event = await store.recordGoalReplanClassification({
      goalId: goal!.id,
      analysisId: replanAnalysis.id,
      classification,
    });

    await expect(store.listAnalyses()).resolves.toEqual([
      expect.objectContaining({
        id: previousAnalysis.id,
        goalReplans: [],
      }),
      expect.objectContaining({
        id: replanAnalysis.id,
        previousAnalysisId: previousAnalysis.id,
        goalReplans: [
          expect.objectContaining({
            goalId: goal!.id,
            decision: "create_follow_up",
            rationale:
              "The original docs goal needs a follow-up for Windows operators.",
            evidenceRefs: [{ kind: "file", ref: "docs/windows.md" }],
            followUpGoals: [
              expect.objectContaining({
                title: "Document Windows operator flow",
              }),
            ],
            humanQuestion: "Should the Windows guide live in the main runbook?",
          }),
        ],
      }),
    ]);
    expect(event).toEqual(
      expect.objectContaining({
        kind: "project_goal_replan_classified",
        message: "The original docs goal needs a follow-up for Windows operators.",
        payload: expect.objectContaining({
          analysisId: replanAnalysis.id,
          decision: "create_follow_up",
          evidenceRefs: [{ kind: "file", ref: "docs/windows.md" }],
          followUpGoals: [
            expect.objectContaining({
              title: "Document Windows operator flow",
            }),
          ],
        }),
      }),
    );
    await expect(store.listGoalEvents(goal!.id)).resolves.toEqual([
      expect.objectContaining({ kind: "project_goal_created" }),
      expect.objectContaining({
        kind: "project_goal_replan_classified",
        payload: expect.objectContaining({
          analysisId: replanAnalysis.id,
          rationale:
            "The original docs goal needs a follow-up for Windows operators.",
          humanQuestion: "Should the Windows guide live in the main runbook?",
        }),
      }),
    ]);
  });

  it("lists goal task links by task ids", async () => {
    const store = new PostgresProjectManagerStore(pg, {
      now: () => new Date(baseTime),
    });
    const analysis = await recordTestAnalysis(store);
    await pg.query(
      `
        INSERT INTO tasks (
          id, title, description, source, created_by, status, task_type,
          created_at, updated_at
        )
        VALUES
          (
            'task-pg-1', 'Task 1', 'Description 1', '{"kind":"native"}'::jsonb,
            '{"owner":"human","id":"dev-1"}'::jsonb, 'new', 'documentation', $1, $1
          ),
          (
            'task-pg-2', 'Task 2', 'Description 2', '{"kind":"native"}'::jsonb,
            '{"owner":"human","id":"dev-1"}'::jsonb, 'new', 'documentation', $1, $1
          )
      `,
      [baseTime],
    );
    const [goal] = await store.createGoalsFromAnalysis({
      sourceAnalysisId: analysis.id,
      repositoryName: "developer",
      goals: [goalDraft({ title: "Link lookup goal" })],
    });
    const first = await store.linkGoalTask({
      goalId: goal!.id,
      taskId: "task-pg-1",
      linkType: "proposed_task",
    });
    await store.linkGoalTask({
      goalId: goal!.id,
      taskId: "task-pg-2",
      linkType: "proposed_task",
    });

    await expect(
      store.listGoalTaskLinksForTaskIds(["task-pg-1", "missing"]),
    ).resolves.toEqual([first]);
  });
});
