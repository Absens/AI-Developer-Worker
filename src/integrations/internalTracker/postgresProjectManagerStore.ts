import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { buildProjectGoalDuplicateSignature } from "../../domain/projectManager/goalPolicy.js";
import type {
  CompleteProjectManagerRunInput,
  ProjectManagerStore,
  RecordGoalReplanClassificationInput,
  RecordProjectAnalysisInput,
  StartProjectManagerRunInput,
} from "../../domain/projectManager/store.js";
import type {
  ActivateProjectGoalInput,
  ApproveProjectGoalInput,
  CompleteProjectGoalInput,
  CreateProjectGoalsFromAnalysisInput,
  LinkProjectGoalTaskInput,
  ListProjectGoalsInput,
  MarkProjectGoalStaleInput,
  ProjectAnalysis,
  ProjectGoal,
  ProjectGoalAuditEvent,
  ProjectGoalAuditEventKind,
  ProjectGoalTaskLink,
  ProjectManagerRun,
  RejectProjectGoalInput,
} from "../../domain/projectManager/types.js";
import type { TaskActor } from "../../domain/taskTracker/types.js";
import type { PostgresPoolLike, PostgresQueryable } from "./postgresTaskTracker.js";

export interface PostgresProjectManagerStoreOptions {
  now?: () => Date;
}

type TransactionClient = PostgresQueryable & { release?: () => void };

type ProjectManagerRunRow = QueryResultRow & {
  id: string;
  repository_name: string;
  trigger: ProjectManagerRun["trigger"];
  status: ProjectManagerRun["status"];
  analysis_id: string | null;
  proposed_goal_ids: string[];
  proposed_task_ids: string[];
  diagnostic: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
};

type ProjectAnalysisRow = QueryResultRow & {
  id: string;
  repository_name: string;
  summary: string;
  health_signals: unknown;
  proposed_goals: unknown;
  stale_goal_ids: string[];
  previous_analysis_id?: string | null;
  replan_reason: string | null;
  goal_replans?: unknown | null;
  created_at: Date | string;
};

type ProjectGoalRow = QueryResultRow & {
  id: string;
  source_analysis_id: string;
  source_run_id: string | null;
  repository_name: string;
  status: ProjectGoal["status"];
  title: string;
  problem_statement: string;
  desired_outcome: string;
  success_metrics: string[];
  evidence_refs: unknown;
  priority: ProjectGoal["priority"];
  risk_level: ProjectGoal["riskLevel"];
  suggested_task_proposals: unknown;
  duplicate_signature: string;
  approved_by: unknown | null;
  approved_at: Date | string | null;
  activated_by: unknown | null;
  activated_at: Date | string | null;
  completed_by: unknown | null;
  completed_at: Date | string | null;
  rejected_by: unknown | null;
  rejected_at: Date | string | null;
  rejection_reason: string | null;
  stale_by: unknown | null;
  stale_at: Date | string | null;
  stale_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ProjectGoalEventRow = QueryResultRow & {
  id: string;
  goal_id: string;
  kind: ProjectGoalAuditEventKind;
  actor: unknown | null;
  message: string | null;
  payload: unknown | null;
  created_at: Date | string;
};

type ProjectGoalTaskRow = QueryResultRow & {
  id: string;
  goal_id: string;
  task_id: string;
  link_type: string;
  created_at: Date | string;
};

const isPoolLike = (value: PostgresQueryable): value is PostgresPoolLike =>
  typeof (value as { connect?: unknown }).connect === "function";

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

const optionalIso = (value: Date | string | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : toIso(value);

const clone = <T>(value: T): T => structuredClone(value);

const jsonValue = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) {
    return clone(fallback);
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return clone(value as T);
};

const optionalJsonValue = <T>(value: unknown | null): T | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return clone(value as T);
};

const mapRunRow = (row: ProjectManagerRunRow): ProjectManagerRun => ({
  id: row.id,
  repositoryName: row.repository_name,
  trigger: row.trigger,
  status: row.status,
  ...(row.analysis_id ? { analysisId: row.analysis_id } : {}),
  proposedGoalIds: [...row.proposed_goal_ids],
  proposedTaskIds: [...row.proposed_task_ids],
  ...(row.diagnostic ? { diagnostic: row.diagnostic } : {}),
  startedAt: toIso(row.started_at),
  ...(row.completed_at ? { completedAt: toIso(row.completed_at) } : {}),
});

const mapAnalysisRow = (row: ProjectAnalysisRow): ProjectAnalysis => ({
  id: row.id,
  repositoryName: row.repository_name,
  summary: row.summary,
  healthSignals: jsonValue(row.health_signals, []),
  proposedGoals: jsonValue(row.proposed_goals, []),
  staleGoalIds: [...row.stale_goal_ids],
  ...(row.previous_analysis_id
    ? { previousAnalysisId: row.previous_analysis_id }
    : {}),
  ...(row.replan_reason ? { replanReason: row.replan_reason } : {}),
  goalReplans: jsonValue(row.goal_replans, []),
  createdAt: toIso(row.created_at),
});

const mapGoalRow = (row: ProjectGoalRow): ProjectGoal => ({
  id: row.id,
  sourceAnalysisId: row.source_analysis_id,
  ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
  repositoryName: row.repository_name,
  status: row.status,
  title: row.title,
  problemStatement: row.problem_statement,
  desiredOutcome: row.desired_outcome,
  successMetrics: [...row.success_metrics],
  evidenceRefs: jsonValue(row.evidence_refs, []),
  priority: row.priority,
  riskLevel: row.risk_level,
  suggestedTaskProposals: jsonValue(row.suggested_task_proposals, []),
  duplicateSignature: row.duplicate_signature,
  ...(optionalJsonValue(row.approved_by)
    ? { approvedBy: optionalJsonValue(row.approved_by) }
    : {}),
  ...(optionalIso(row.approved_at) ? { approvedAt: optionalIso(row.approved_at) } : {}),
  ...(optionalJsonValue(row.activated_by)
    ? { activatedBy: optionalJsonValue(row.activated_by) }
    : {}),
  ...(optionalIso(row.activated_at)
    ? { activatedAt: optionalIso(row.activated_at) }
    : {}),
  ...(optionalJsonValue(row.completed_by)
    ? { completedBy: optionalJsonValue(row.completed_by) }
    : {}),
  ...(optionalIso(row.completed_at)
    ? { completedAt: optionalIso(row.completed_at) }
    : {}),
  ...(optionalJsonValue(row.rejected_by)
    ? { rejectedBy: optionalJsonValue(row.rejected_by) }
    : {}),
  ...(optionalIso(row.rejected_at) ? { rejectedAt: optionalIso(row.rejected_at) } : {}),
  ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
  ...(optionalJsonValue(row.stale_by)
    ? { staleBy: optionalJsonValue(row.stale_by) }
    : {}),
  ...(optionalIso(row.stale_at) ? { staleAt: optionalIso(row.stale_at) } : {}),
  ...(row.stale_reason ? { staleReason: row.stale_reason } : {}),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapGoalEventRow = (row: ProjectGoalEventRow): ProjectGoalAuditEvent => ({
  id: row.id,
  goalId: row.goal_id,
  kind: row.kind,
  ...(optionalJsonValue(row.actor) ? { actor: optionalJsonValue(row.actor) } : {}),
  ...(row.message ? { message: row.message } : {}),
  ...(optionalJsonValue(row.payload)
    ? { payload: optionalJsonValue(row.payload) }
    : {}),
  createdAt: toIso(row.created_at),
});

const mapGoalTaskRow = (row: ProjectGoalTaskRow): ProjectGoalTaskLink => ({
  id: row.id,
  goalId: row.goal_id,
  taskId: row.task_id,
  linkType: row.link_type,
  createdAt: toIso(row.created_at),
});

export class PostgresProjectManagerStore implements ProjectManagerStore {
  private readonly now: () => Date;

  public constructor(
    private readonly db: PostgresQueryable,
    options: PostgresProjectManagerStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async startRun(
    input: StartProjectManagerRunInput,
  ): Promise<ProjectManagerRun> {
    const result = await this.db.query<ProjectManagerRunRow>(
      `
        INSERT INTO project_manager_runs (
          id, repository_name, trigger, status, proposed_goal_ids,
          proposed_task_ids, started_at
        )
        VALUES ($1, $2, $3, 'started', $4, $5, $6)
        RETURNING *
      `,
      [
        `pm_run_${randomUUID()}`,
        input.repositoryName,
        input.trigger,
        [],
        [],
        this.nowIso(),
      ],
    );
    return mapRunRow(result.rows[0]!);
  }

  public async completeRun(
    runId: string,
    input: CompleteProjectManagerRunInput,
  ): Promise<ProjectManagerRun> {
    const existing = await this.requireRun(runId);
    const result = await this.db.query<ProjectManagerRunRow>(
      `
        UPDATE project_manager_runs
        SET status = 'completed',
            analysis_id = $2,
            proposed_goal_ids = $3,
            proposed_task_ids = $4,
            completed_at = $5
        WHERE id = $1
        RETURNING *
      `,
      [
        runId,
        input.analysisId ?? existing.analysisId ?? null,
        input.proposedGoalIds ?? existing.proposedGoalIds,
        input.proposedTaskIds ?? existing.proposedTaskIds,
        this.nowIso(),
      ],
    );
    return mapRunRow(result.rows[0]!);
  }

  public async failRun(
    runId: string,
    diagnostic: string,
  ): Promise<ProjectManagerRun> {
    await this.requireRun(runId);
    const result = await this.db.query<ProjectManagerRunRow>(
      `
        UPDATE project_manager_runs
        SET status = 'failed',
            diagnostic = $2,
            completed_at = $3
        WHERE id = $1
        RETURNING *
      `,
      [runId, diagnostic, this.nowIso()],
    );
    return mapRunRow(result.rows[0]!);
  }

  public async recordAnalysis(
    input: RecordProjectAnalysisInput,
  ): Promise<ProjectAnalysis> {
    const result = await this.db.query<ProjectAnalysisRow>(
      `
        INSERT INTO project_analyses (
          id, repository_name, summary, health_signals, proposed_goals,
          stale_goal_ids, replan_reason, previous_analysis_id, goal_replans,
          created_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10)
        RETURNING *
      `,
      [
        `pm_analysis_${randomUUID()}`,
        input.repositoryName,
        input.summary,
        JSON.stringify(input.healthSignals),
        JSON.stringify(input.proposedGoals),
        input.staleGoalIds,
        input.replanReason ?? null,
        input.previousAnalysisId ?? null,
        JSON.stringify(input.goalReplans ?? []),
        this.nowIso(),
      ],
    );
    return mapAnalysisRow(result.rows[0]!);
  }

  public async listRuns(): Promise<ProjectManagerRun[]> {
    const result = await this.db.query<ProjectManagerRunRow>(
      `
        SELECT *
        FROM project_manager_runs
        ORDER BY started_at, id
      `,
    );
    return result.rows.map(mapRunRow);
  }

  public async listAnalyses(): Promise<ProjectAnalysis[]> {
    const result = await this.db.query<ProjectAnalysisRow>(
      `
        SELECT *
        FROM project_analyses
        ORDER BY created_at, id
      `,
    );
    return result.rows.map(mapAnalysisRow);
  }

  public async createGoalsFromAnalysis(
    input: CreateProjectGoalsFromAnalysisInput,
  ): Promise<ProjectGoal[]> {
    return this.withTransaction(async (client) => {
      const createdGoals: ProjectGoal[] = [];

      for (const draft of input.goals) {
        const duplicateSignature = buildProjectGoalDuplicateSignature({
          repositoryName: input.repositoryName,
          title: draft.title,
          evidenceRefs: draft.evidenceRefs,
        });
        const createdAt = this.nowIso();
        const result = await client.query<ProjectGoalRow>(
          `
            INSERT INTO project_goals (
              id, source_analysis_id, source_run_id, repository_name, status,
              title, problem_statement, desired_outcome, success_metrics,
              evidence_refs, priority, risk_level, suggested_task_proposals,
              duplicate_signature, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4, 'proposed',
              $5, $6, $7, $8,
              $9::jsonb, $10, $11, $12::jsonb,
              $13, $14, $15
            )
            ON CONFLICT (repository_name, duplicate_signature)
              WHERE status NOT IN ('completed', 'rejected', 'stale')
            DO NOTHING
            RETURNING *
          `,
          [
            `pm_goal_${randomUUID()}`,
            input.sourceAnalysisId,
            input.sourceRunId ?? null,
            input.repositoryName,
            draft.title,
            draft.problemStatement,
            draft.desiredOutcome,
            draft.successMetrics,
            JSON.stringify(draft.evidenceRefs),
            draft.priority,
            draft.riskLevel,
            JSON.stringify(draft.suggestedTaskProposals),
            duplicateSignature,
            createdAt,
            createdAt,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          continue;
        }

        await this.insertGoalEvent(client, {
          goalId: row.id,
          kind: "project_goal_created",
          payload: {
            sourceAnalysisId: input.sourceAnalysisId,
            ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
            repositoryName: input.repositoryName,
          },
        });
        createdGoals.push(mapGoalRow(row));
      }

      return createdGoals;
    });
  }

  public async listGoals(
    input: ListProjectGoalsInput = {},
  ): Promise<ProjectGoal[]> {
    const params: unknown[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses: string[] = [];
    if (input.repositoryName) {
      clauses.push(`repository_name = ${addParam(input.repositoryName)}`);
    }
    if (input.sourceAnalysisId) {
      clauses.push(`source_analysis_id = ${addParam(input.sourceAnalysisId)}`);
    }
    if (input.status) {
      clauses.push(
        `status = ANY(${addParam(
          Array.isArray(input.status) ? input.status : [input.status],
        )}::text[])`,
      );
    }

    const result = await this.db.query<ProjectGoalRow>(
      `
        SELECT *
        FROM project_goals
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at, id
      `,
      params,
    );
    return result.rows.map(mapGoalRow);
  }

  public async getGoal(goalId: string): Promise<ProjectGoal> {
    return this.requireGoal(this.db, goalId);
  }

  public async approveGoal(
    goalId: string,
    input: ApproveProjectGoalInput,
  ): Promise<ProjectGoal> {
    return this.updateGoalLifecycle(goalId, {
      expectedStatus: "proposed",
      action: "approve",
      status: "approved",
      actor: input.actor,
      actorColumn: "approved_by",
      atColumn: "approved_at",
      eventKind: "project_goal_approved",
    });
  }

  public async activateGoal(
    goalId: string,
    input: ActivateProjectGoalInput,
  ): Promise<ProjectGoal> {
    return this.updateGoalLifecycle(goalId, {
      expectedStatus: "approved",
      action: "activate",
      status: "active",
      actor: input.actor,
      actorColumn: "activated_by",
      atColumn: "activated_at",
      eventKind: "project_goal_activated",
    });
  }

  public async completeGoal(
    goalId: string,
    input: CompleteProjectGoalInput,
  ): Promise<ProjectGoal> {
    return this.updateGoalLifecycle(goalId, {
      expectedStatus: "active",
      action: "complete",
      status: "completed",
      actor: input.actor,
      actorColumn: "completed_by",
      atColumn: "completed_at",
      eventKind: "project_goal_completed",
    });
  }

  public async rejectGoal(
    goalId: string,
    input: RejectProjectGoalInput,
  ): Promise<ProjectGoal> {
    return this.withTransaction(async (client) => {
      const existing = await this.requireGoal(client, goalId, true);
      this.requireGoalStatus(existing, "proposed", "reject");
      const updatedAt = this.nowIso();
      const result = await client.query<ProjectGoalRow>(
        `
          UPDATE project_goals
          SET status = $2,
              updated_at = $3,
              rejected_by = $4::jsonb,
              rejected_at = $3,
              rejection_reason = $5
          WHERE id = $1
          RETURNING *
        `,
        [
          goalId,
          "rejected",
          updatedAt,
          JSON.stringify(input.actor),
          input.rejectionReason,
        ],
      );
      await this.insertGoalEvent(client, {
        goalId,
        kind: "project_goal_rejected",
        actor: input.actor,
        message: input.rejectionReason,
      });
      return mapGoalRow(result.rows[0]!);
    });
  }

  public async markGoalStale(
    goalId: string,
    input: MarkProjectGoalStaleInput,
  ): Promise<ProjectGoal> {
    return this.withTransaction(async (client) => {
      const existing = await this.requireGoal(client, goalId, true);
      if (!["proposed", "approved", "active"].includes(existing.status)) {
        throw new Error(
          `Cannot mark project goal stale from status ${existing.status}`,
        );
      }
      const updatedAt = this.nowIso();
      const result = await client.query<ProjectGoalRow>(
        `
          UPDATE project_goals
          SET status = $2,
              updated_at = $3,
              stale_by = $4::jsonb,
              stale_at = $3,
              stale_reason = $5
          WHERE id = $1
          RETURNING *
        `,
        [
          goalId,
          "stale",
          updatedAt,
          input.actor ? JSON.stringify(input.actor) : null,
          input.staleReason,
        ],
      );
      await this.insertGoalEvent(client, {
        goalId,
        kind: "project_goal_stale",
        ...(input.actor ? { actor: input.actor } : {}),
        message: input.staleReason,
      });
      return mapGoalRow(result.rows[0]!);
    });
  }

  public async listGoalEvents(
    goalId: string,
  ): Promise<ProjectGoalAuditEvent[]> {
    await this.requireGoal(this.db, goalId);
    const result = await this.db.query<ProjectGoalEventRow>(
      `
        SELECT *
        FROM project_goal_events
        WHERE goal_id = $1
        ORDER BY created_at, id
      `,
      [goalId],
    );
    return result.rows.map(mapGoalEventRow);
  }

  public async recordGoalReplanClassification(
    input: RecordGoalReplanClassificationInput,
  ): Promise<ProjectGoalAuditEvent> {
    await this.requireGoal(this.db, input.goalId);
    const { classification } = input;
    return this.insertGoalEvent(this.db, {
      goalId: input.goalId,
      kind: "project_goal_replan_classified",
      message: classification.rationale,
      payload: {
        analysisId: input.analysisId,
        decision: classification.decision,
        rationale: classification.rationale,
        evidenceRefs: clone(classification.evidenceRefs),
        followUpGoals: clone(classification.followUpGoals),
        ...(classification.humanQuestion
          ? { humanQuestion: classification.humanQuestion }
          : {}),
      },
    });
  }

  public async linkGoalTask(
    input: LinkProjectGoalTaskInput,
  ): Promise<ProjectGoalTaskLink> {
    return this.withTransaction(async (client) => {
      await this.requireGoal(client, input.goalId, true);
      await this.requireLinkedTask(client, input.taskId);
      const result = await client.query<ProjectGoalTaskRow>(
        `
          INSERT INTO project_goal_tasks (
            id, goal_id, task_id, link_type, created_at
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (goal_id, task_id, link_type)
          DO NOTHING
          RETURNING *
        `,
        [
          `pm_goal_task_link_${randomUUID()}`,
          input.goalId,
          input.taskId,
          input.linkType,
          this.nowIso(),
        ],
      );
      const inserted = result.rows[0];
      if (inserted) {
        return mapGoalTaskRow(inserted);
      }

      const existing = await client.query<ProjectGoalTaskRow>(
        `
          SELECT *
          FROM project_goal_tasks
          WHERE goal_id = $1
            AND task_id = $2
            AND link_type = $3
        `,
        [input.goalId, input.taskId, input.linkType],
      );
      const existingRow = existing.rows[0];
      if (!existingRow) {
        throw new Error(
          `Project manager goal task link conflict could not be loaded for goal ${input.goalId}, task ${input.taskId}, link type ${input.linkType}.`,
        );
      }
      return mapGoalTaskRow(existingRow);
    });
  }

  public async listGoalTaskLinks(
    goalId: string,
  ): Promise<ProjectGoalTaskLink[]> {
    await this.requireGoal(this.db, goalId);
    const result = await this.db.query<ProjectGoalTaskRow>(
      `
        SELECT *
        FROM project_goal_tasks
        WHERE goal_id = $1
        ORDER BY created_at, id
      `,
      [goalId],
    );
    return result.rows.map(mapGoalTaskRow);
  }

  public async listGoalTaskLinksForTaskIds(
    taskIds: string[],
  ): Promise<ProjectGoalTaskLink[]> {
    if (taskIds.length === 0) {
      return [];
    }
    const result = await this.db.query<ProjectGoalTaskRow>(
      `
        SELECT *
        FROM project_goal_tasks
        WHERE task_id = ANY($1::text[])
        ORDER BY created_at, id
      `,
      [taskIds],
    );
    return result.rows.map(mapGoalTaskRow);
  }

  private async updateGoalLifecycle(
    goalId: string,
    input: {
      expectedStatus: ProjectGoal["status"];
      action: string;
      status: ProjectGoal["status"];
      actor: TaskActor;
      actorColumn: "approved_by" | "activated_by" | "completed_by";
      atColumn: "approved_at" | "activated_at" | "completed_at";
      eventKind: ProjectGoalAuditEventKind;
    },
  ): Promise<ProjectGoal> {
    return this.withTransaction(async (client) => {
      const existing = await this.requireGoal(client, goalId, true);
      this.requireGoalStatus(existing, input.expectedStatus, input.action);
      const updatedAt = this.nowIso();
      const result = await client.query<ProjectGoalRow>(
        `
          UPDATE project_goals
          SET status = $2,
              updated_at = $3,
              ${input.actorColumn} = $4::jsonb,
              ${input.atColumn} = $3
          WHERE id = $1
          RETURNING *
        `,
        [goalId, input.status, updatedAt, JSON.stringify(input.actor)],
      );
      await this.insertGoalEvent(client, {
        goalId,
        kind: input.eventKind,
        actor: input.actor,
      });
      return mapGoalRow(result.rows[0]!);
    });
  }

  private async requireRun(runId: string): Promise<ProjectManagerRun> {
    const result = await this.db.query<ProjectManagerRunRow>(
      `
        SELECT *
        FROM project_manager_runs
        WHERE id = $1
      `,
      [runId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Project manager run not found: ${runId}`);
    }
    return mapRunRow(row);
  }

  private async requireGoal(
    client: PostgresQueryable,
    goalId: string,
    forUpdate = false,
  ): Promise<ProjectGoal> {
    const result = await client.query<ProjectGoalRow>(
      `
        SELECT *
        FROM project_goals
        WHERE id = $1
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [goalId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Project manager goal not found: ${goalId}`);
    }
    return mapGoalRow(row);
  }

  private async requireLinkedTask(
    client: PostgresQueryable,
    taskId: string,
  ): Promise<void> {
    const result = await client.query(
      `
        SELECT 1
        FROM tasks
        WHERE id = $1
      `,
      [taskId],
    );
    if (!result.rows[0]) {
      throw new Error(`Project manager linked task not found: ${taskId}`);
    }
  }

  private requireGoalStatus(
    goal: ProjectGoal,
    expectedStatus: ProjectGoal["status"],
    action: string,
  ): void {
    if (goal.status !== expectedStatus) {
      throw new Error(
        `Cannot ${action} project goal from status ${goal.status}`,
      );
    }
  }

  private async insertGoalEvent(
    client: PostgresQueryable,
    input: Pick<ProjectGoalAuditEvent, "goalId" | "kind"> &
      Partial<Pick<ProjectGoalAuditEvent, "actor" | "message" | "payload">>,
  ): Promise<ProjectGoalAuditEvent> {
    const result = await client.query<ProjectGoalEventRow>(
      `
        INSERT INTO project_goal_events (
          id, goal_id, kind, actor, message, payload, created_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
        RETURNING *
      `,
      [
        `pm_goal_event_${randomUUID()}`,
        input.goalId,
        input.kind,
        input.actor ? JSON.stringify(input.actor) : null,
        input.message ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        this.nowIso(),
      ],
    );
    return mapGoalEventRow(result.rows[0]!);
  }

  private async withTransaction<T>(
    callback: (client: PostgresQueryable) => Promise<T>,
  ): Promise<T> {
    const client: TransactionClient = isPoolLike(this.db)
      ? await this.db.connect()
      : this.db;
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
