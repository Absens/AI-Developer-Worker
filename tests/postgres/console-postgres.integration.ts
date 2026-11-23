import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskWriteConflictError } from "../../src/domain/taskTracker/errors.js";
import type { ProposeTaskInput, TaskRevisionInput } from "../../src/domain/taskTracker/types.js";
import { createPostgresFixture, human, taskInput, type PostgresFixture } from "./fixture.js";

type TestWorker = ReturnType<PostgresFixture["newWorker"]>;

let fixture: PostgresFixture | undefined;

const start = async (): Promise<PostgresFixture> => {
  fixture = await createPostgresFixture();
  return fixture;
};

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.dispose();
});

const raceOnLockedTask = async <Result>(
  f: PostgresFixture,
  taskId: string,
  writers: ReadonlyArray<{ worker: TestWorker; write: () => Promise<Result> }>,
): Promise<PromiseSettledResult<Result>[]> => {
  const pids = await Promise.all(writers.map(async ({ worker }) => {
    const result = await worker.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = result.rows[0]?.pid;
    expect(pid).toBeTypeOf("number");
    return pid;
  }));
  expect(new Set(pids).size).toBe(writers.length);

  const blocker = await f.newPool().connect();
  let attempts: Promise<PromiseSettledResult<Result>[]>;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
    attempts = Promise.allSettled(writers.map(({ write }) => write()));
    // Both writes have reached PostgreSQL and overlap while the fixture holds the row.
    await vi.waitFor(async () => {
      const result = await f.db.query<{ waiting: number }>(
        "SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'",
        [pids],
      );
      expect(result.rows[0]?.waiting).toBe(writers.length);
    }, { timeout: 3_000, interval: 20 });
  } finally {
    try {
      await blocker.query("ROLLBACK");
    } finally {
      blocker.release();
    }
  }
  return attempts;
};

const proposalInput = (title: string, evidenceNote: number): ProposeTaskInput => ({
  source: "ai_proposal",
  proposedBy: "postgres-ci",
  repositoryName: "repo-a",
  title,
  description: "Update the matching guide in the isolated fixture.",
  proposalReason: "The fixture guide lacks a test description.",
  evidenceRefs: [{ kind: "review_comment", ref: `gitlab://project/1/mr/1#note-${evidenceNote}` }],
  suggestedAcceptanceCriteria: ["The isolated guide describes its test."],
  taskType: "documentation",
  autonomyLevel: "proposal_only",
});

const createTaskForAcceptance = async (tracker: TestWorker["tracker"], id: string): Promise<string> => {
  const task = await tracker.createTask(taskInput(id));
  for (const status of ["claimed", "analyzing", "validating", "review", "human_testing"] as const) {
    await tracker.setStatus(task.id, status);
  }
  return task.id;
};

describe("real PostgreSQL console search and write conflicts", () => {
  it("filters literally before limiting and paginates tied timestamps without dropping rows", async () => {
    const f = await start();
    const { tracker } = f.newWorker("console-reader");
    const repositoryName = "repo-by-label";
    const byRepository = await tracker.createTask(taskInput("repository-match", repositoryName));
    f.advance(1_000);
    await tracker.createTask({ ...taskInput("tie-b"), title: "log %_ second row" });
    await tracker.createTask({ ...taskInput("tie-a"), title: "log %_ first row" });
    f.advance(1_000);
    await tracker.createTask({ ...taskInput("noise"), title: "log abc is newer" });

    const search = { text: "LOG %_", repositoryNames: [repositoryName] };
    const [first] = await tracker.listTasks({ search, limit: 1 });
    expect(first?.id).toBe("tie-a");
    const [second] = await tracker.listTasks({ search, after: first, limit: 1 });
    expect(second?.id).toBe("tie-b");
    expect(second?.updatedAt).toBe(first?.updatedAt);
    const [third] = await tracker.listTasks({ search, after: second, limit: 1 });
    expect(third?.id).toBe(byRepository.id);
    await expect(tracker.listTasks({ search, after: third, limit: 1 })).resolves.toEqual([]);

    await expect(tracker.listTasks({
      search: { text: "TIE-A", repositoryNames: [] },
    })).resolves.toMatchObject([{ id: "tie-a" }]);
    await expect(tracker.listTasks({
      search: { text: "REPO-BY-LABEL", repositoryNames: [] },
    })).resolves.toMatchObject([{ id: byRepository.id }]);
  });

  it("finds pending and approved proposals before the page limit", async () => {
    const f = await start();
    const { tracker } = f.newWorker("proposal-reader");
    const pending = await tracker.proposeTask(proposalInput("Document draft validation", 1));
    f.advance(1_000);
    const approved = await tracker.proposeTask(proposalInput("Explain pagination on the console", 2));
    await tracker.approveProposal(approved.id, { actor: human, reason: "Fixture reviewed." });
    f.advance(1_000);
    await tracker.createTask(taskInput("newer-non-proposal"));

    await expect(tracker.listTasks({ proposal: { supervisorStatus: "proposed" }, limit: 1 }))
      .resolves.toMatchObject([{ id: pending.id, proposal: { supervisorStatus: "proposed" } }]);
    await expect(tracker.listTasks({ proposal: { supervisorStatus: "approved" }, limit: 1 }))
      .resolves.toMatchObject([{ id: approved.id, proposal: { supervisorStatus: "approved" } }]);
    await expect(tracker.listTasks({ proposal: {}, limit: 1 }))
      .resolves.toMatchObject([{ id: approved.id }]);
  });

  it("keeps one concurrent draft edit and makes only the saved title searchable", async () => {
    const f = await start();
    const a = f.newWorker("draft-editor-a");
    const b = f.newWorker("draft-editor-b");
    const draft = await a.tracker.createTask({ ...taskInput("draft-edit"), status: "new" });
    const edit = (title: string): TaskRevisionInput => ({
      owner: "human",
      author: human,
      expectedStatus: "new",
      expectedRevisionNumber: 1,
      title,
    });
    const firstTitle = "Draft quartz";
    const secondTitle = "Draft garnet";
    const results = await raceOnLockedTask(f, draft.id, [
      { worker: a, write: () => a.tracker.updateTaskRevision(draft.id, edit(firstTitle)) },
      { worker: b, write: () => b.tracker.updateTaskRevision(draft.id, edit(secondTitle)) },
    ]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const conflicts = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBeInstanceOf(TaskWriteConflictError);
    expect(conflicts[0]?.reason).toMatchObject({ field: "revision", expected: 1, actual: 2 });

    const saved = await b.tracker.getTask(draft.id);
    expect(saved.title).toBe(accepted[0]?.value.title);
    expect(saved.revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([1, 2]);
    const discardedTitle = saved.title === firstTitle ? secondTitle : firstTitle;
    await expect(b.tracker.listTasks({ search: { text: saved.title, repositoryNames: [] } }))
      .resolves.toMatchObject([{ id: draft.id, title: saved.title }]);
    await expect(b.tracker.listTasks({ search: { text: discardedTitle, repositoryNames: [] } }))
      .resolves.toEqual([]);

    await a.tracker.markReady(draft.id);
    await expect(b.tracker.updateTaskRevision(draft.id, {
      ...edit("Late draft edit"),
      expectedRevisionNumber: 2,
    })).rejects.toMatchObject({ field: "status", expected: "new", actual: "ready" });
  });

  it("allows only one concurrent acceptance and records its actor and reason once", async () => {
    const f = await start();
    const a = f.newWorker("acceptance-a");
    const b = f.newWorker("acceptance-b");
    const taskId = await createTaskForAcceptance(a.tracker, "accept-result");
    const first = { ...human, id: "reviewer-a" };
    const second = { ...human, id: "reviewer-b" };
    const results = await raceOnLockedTask(f, taskId, [
      {
        worker: a,
        write: () => a.tracker.setStatus(taskId, "done", "Checked by A", {
          expectedStatus: "human_testing", expectedRevisionNumber: 1, actor: first,
        }),
      },
      {
        worker: b,
        write: () => b.tracker.setStatus(taskId, "done", "Checked by B", {
          expectedStatus: "human_testing", expectedRevisionNumber: 1, actor: second,
        }),
      },
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const conflicts = results.filter((result) => result.status === "rejected");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBeInstanceOf(TaskWriteConflictError);
    expect(conflicts[0]?.reason).toMatchObject({ field: "status", expected: "human_testing", actual: "done" });

    const saved = await b.tracker.getTask(taskId);
    const [actor, message] = results[0]?.status === "fulfilled"
      ? [first, "Checked by A"] : [second, "Checked by B"];
    expect(saved.status).toBe("done");
    expect(saved.events.filter((event) =>
      event.kind === "task_status_changed" && event.payload?.to === "done",
    )).toMatchObject([{ actor, message, payload: { from: "human_testing", to: "done" } }]);
  });

  it("rejects acceptance against older criteria without changing the task state", async () => {
    const f = await start();
    const reviewer = f.newWorker("reading-reviewer");
    const editor = f.newWorker("criteria-editor");
    const taskId = await createTaskForAcceptance(reviewer.tracker, "acceptance-revision");
    const seen = await reviewer.tracker.getTask(taskId);
    expect(seen.revisions.at(-1)?.revisionNumber).toBe(1);

    const acceptanceCriteria = ["The revised outcome is verified."];
    const revised = await editor.tracker.updateTaskRevision(taskId, {
      owner: "human",
      author: human,
      acceptanceCriteria,
    });
    expect(revised).toMatchObject({ status: "human_testing", acceptanceCriteria });
    expect(revised.revisions.at(-1)?.revisionNumber).toBe(2);

    const actor = { ...human, id: "reviewer-current" };
    const stale = reviewer.tracker.setStatus(taskId, "done", "Checked the old criteria", {
      expectedStatus: "human_testing", expectedRevisionNumber: 1, actor,
    });
    await expect(stale).rejects.toBeInstanceOf(TaskWriteConflictError);
    await expect(stale).rejects.toMatchObject({ field: "revision", expected: 1, actual: 2 });
    await expect(reviewer.tracker.getTask(taskId)).resolves.toMatchObject({
      status: "human_testing", acceptanceCriteria,
    });

    const message = "Checked the revised criteria";
    await reviewer.tracker.setStatus(taskId, "done", message, {
      expectedStatus: "human_testing", expectedRevisionNumber: 2, actor,
    });
    const saved = await editor.tracker.getTask(taskId);
    expect(saved).toMatchObject({ status: "done", acceptanceCriteria });
    expect(saved.events.filter((event) =>
      event.kind === "task_status_changed" && event.payload?.to === "done",
    )).toMatchObject([{ actor, message, payload: { from: "human_testing", to: "done" } }]);
  });
});
