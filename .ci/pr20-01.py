from pathlib import Path
r=Path.cwd()
def edit(p,a,b,n=1):
 f=r/p;s=f.read_text();assert s.count(a)==n,(p,s.count(a),a[:60]);f.write_text(s.replace(a,b))
def write(p,s): (r/p).write_text(s)
write('src/domain/taskTracker/recovery.ts','''import type { RecoverAbandonedTaskInput, TaskStatus } from "./types.js";

// An expired lease is not proof that a process touching this checkout has stopped.
export const EXECUTION_TASK_STATUSES: readonly TaskStatus[] = [
  "analyzing", "decomposing", "implementing", "validating", "fixing_review",
];

export const isExecutionInProgress = (status: TaskStatus): boolean =>
  EXECUTION_TASK_STATUSES.includes(status);

export const assertRecoveryConfirmation = (input: RecoverAbandonedTaskInput): void => {
  if (input.previousExecutorStopped !== true || !input.reason?.trim()) {
    throw new Error("Recovery requires confirmation that the previous executor stopped and a reason.");
  }
  if (input.actor.owner !== "human" && input.actor.owner !== "policy_admin") {
    throw new Error("Only a human operator may confirm abandoned execution recovery.");
  }
  if (!isExecutionInProgress(input.expectedStatus)) {
    throw new Error("Recovery requires an executing task status.");
  }
};
''')
edit('src/domain/taskTracker/types.ts','export interface TaskTrackerClient {','''export interface RecoverAbandonedTaskInput {
  actor: TaskActor;
  expectedStatus: TaskStatus;
  previousExecutorStopped: boolean;
  reason: string;
}

export interface TaskTrackerClient {
  recoverAbandonedTask(taskId: string, input: RecoverAbandonedTaskInput): Promise<TaskRecord>;''')
p='src/domain/taskTracker/inMemoryTaskTracker.ts'
edit(p,'import { assertValidTaskStatusTransition }','import { assertRecoveryConfirmation, isExecutionInProgress } from "./recovery.js";\nimport { assertValidTaskStatusTransition }')
edit(p,'  ReleaseLeaseInput,','  ReleaseLeaseInput,\n  RecoverAbandonedTaskInput,')
edit(p,'  async markReady(taskId: string, reason?: string): Promise<void> {','''  async recoverAbandonedTask(taskId: string, input: RecoverAbandonedTaskInput): Promise<TaskRecord> {
    assertRecoveryConfirmation(input);
    const task = this.requireTask(taskId);
    if (task.status !== input.expectedStatus) throw new Error("Task state changed; refresh before recovery.");
    const key = repositoryLeaseKeyForTask(task);
    const now = this.now();
    if ([...this.leases.values()].some((lease) => isLeaseActiveAt(lease, now) &&
      (lease.taskId === taskId || (lease.kind === "repository" && lease.leaseKey === key)))) {
      throw new Error("Cannot recover a task while its checkout has active leases.");
    }
    const from = task.status;
    task.status = from === "fixing_review" ? "review" : "ready";
    task.updatedAt = now.toISOString();
    task.events.push({
      id: `evt_${randomUUID()}`, taskId, kind: "task_status_changed", source: input.actor.owner,
      actor: clone(input.actor), message: input.reason,
      payload: { from, to: task.status, previousExecutorStopped: true, recovery: "operator_confirmed" },
      createdAt: task.updatedAt,
    });
    return clone(task);
  }

  async markReady(taskId: string, reason?: string): Promise<void> {''')
edit(p,'''    const repositoryLeaseKey = repositoryLeaseKeyForTask(task);
    return !activeLeases.some(''','''    const repositoryLeaseKey = repositoryLeaseKeyForTask(task);
    if ([...this.tasks.values()].some((other) => other.id !== task.id &&
      other.repositoryName && other.repoPathKey && isExecutionInProgress(other.status) &&
      repositoryLeaseKeyForTask(other) === repositoryLeaseKey)) {
      return false;
    }
    return !activeLeases.some(''',2)
p='src/integrations/internalTracker/postgresTaskTracker.ts'
edit(p,'import { assertValidTaskStatusTransition }','import { assertRecoveryConfirmation, EXECUTION_TASK_STATUSES } from "../../domain/taskTracker/recovery.js";\nimport { assertValidTaskStatusTransition }')
edit(p,'  ReleaseLeaseInput,','  ReleaseLeaseInput,\n  RecoverAbandonedTaskInput,')
edit(p,'  async markReady(taskId: string, reason?: string): Promise<void> {','''  async recoverAbandonedTask(taskId: string, input: RecoverAbandonedTaskInput): Promise<TaskRecord> {
    assertRecoveryConfirmation(input);
    return this.withTransaction(async (client) => {
      const locked = await client.query<{ status: TaskStatus }>(
        "SELECT status FROM tasks WHERE id = $1 FOR UPDATE", [taskId],
      );
      const from = locked.rows[0]?.status;
      if (!from) throw new TaskNotFoundError(taskId);
      if (from !== input.expectedStatus) throw new Error("Task state changed; refresh before recovery.");
      const task = await this.getTaskUsing(client, taskId);
      const now = this.nowIso();
      const active = await client.query(
        `SELECT 1 FROM task_leases
         WHERE released_at IS NULL AND expires_at > $3
           AND (task_id = $1 OR (kind = 'repository' AND lease_key = $2)) LIMIT 1`,
        [taskId, repositoryLeaseKeyForTask(task), now],
      );
      if (active.rows.length) throw new Error("Cannot recover a task while its checkout has active leases.");
      const to: TaskStatus = from === "fixing_review" ? "review" : "ready";
      await client.query("UPDATE tasks SET status = $2, updated_at = $3 WHERE id = $1", [taskId, to, now]);
      await this.insertEvent(client, {
        id: `evt_${randomUUID()}`, taskId, kind: "task_status_changed", source: input.actor.owner,
        actor: clone(input.actor), message: input.reason,
        payload: { from, to, previousExecutorStopped: true, recovery: "operator_confirmed" },
        createdAt: now,
      });
      return this.getTaskUsing(client, taskId);
    });
  }

  async markReady(taskId: string, reason?: string): Promise<void> {''')
edit(p,'AND t.repo_path_key IS NOT NULL','''AND t.repo_path_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tasks running
            WHERE running.id <> t.id
              AND running.status IN (${EXECUTION_TASK_STATUSES.map((status) => `'${status}'`).join(", ")})
              AND lower(replace(trim(coalesce(running.repo_path_key, running.repository_name)), chr(92), '/'))
                = lower(replace(trim(coalesce(t.repo_path_key, t.repository_name)), chr(92), '/'))
          )''',2)
p='src/observability/taskTrackerHumanApi.ts'
edit(p,'  | "force-reanalysis"','  | "recover-abandoned"\n  | "force-reanalysis"')
edit(p,'  "force-reanalysis": "operator",','  "recover-abandoned": "operator",\n  "force-reanalysis": "operator",')
edit(p,'    if (command === "force-reanalysis") {','''    if (command === "recover-abandoned") {
      const task = await tracker.getTask(taskId);
      if (body.expectedStatus !== task.status) throw new Error("Task state changed; refresh before recovery.");
      await tracker.recoverAbandonedTask(taskId, {
        actor: auth.actor, expectedStatus: task.status,
        previousExecutorStopped: body.previousExecutorStopped === true,
        reason: optionalString(body.reason) ?? "",
      });
      return;
    }
    if (command === "force-reanalysis") {''')
f=r/p;f.write_text('import { isExecutionInProgress } from "../domain/taskTracker/recovery.js";\n'+f.read_text())
edit(p,'''    if (command === "mark-ready") {
      await tracker.markReady''','''    if (["mark-ready", "resume", "hold", "cancel", "retry"].includes(command)) {
      const current = await tracker.getTask(taskId);
      if (isExecutionInProgress(current.status)) {
        throw new HttpApiError(409, "Stop the executor and use recover-abandoned before changing an executing task.");
      }
    }
    if (command === "mark-ready") {
      await tracker.markReady''')
p='src/domain/internalWorkerOrchestrator.ts'
edit(p,'''          await this.taskTracker.setStatus(
            task.id,
            "review",
            "Recovering stale review fix after inactive lease.",
          );
          task = await this.taskTracker.getTask(task.id);''','''          this.logger.warn("Abandoned review execution requires confirmed executor stop before recovery.", {
            taskId: task.id,
          });
          continue;''')
