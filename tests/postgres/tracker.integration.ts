import { afterEach, describe, expect, it } from "vitest";

import {
  assertInternalTrackerOperational,
  listInternalTrackerMigrations,
  listInternalTrackerMigrationStatus,
  runInternalTrackerMigrations,
} from "../../src/integrations/internalTracker/migrations.js";
import type { ClaimedTask } from "../../src/domain/taskTracker/types.js";
import { createPostgresFixture, human, taskInput, type PostgresFixture } from "./fixture.js";

let fixture: PostgresFixture | undefined;
const start = async (migrate = true): Promise<PostgresFixture> => {
  fixture = await createPostgresFixture(migrate);
  return fixture;
};
const claimed = (value: ClaimedTask | null): ClaimedTask => {
  expect(value).not.toBeNull();
  if (!value) throw new Error("Expected a claimed task");
  return value;
};
const leaseIds = (claim: ClaimedTask): string[] =>
  [claim.taskLease.leaseId, claim.repositoryLease.leaseId].sort();

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.dispose();
});

describe("real PostgreSQL migrations and operational checks", () => {
  it("migrates an empty schema with the production runner and is idempotent", async () => {
    const f = await start(false);
    const migrations = listInternalTrackerMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    const before = await listInternalTrackerMigrationStatus(f.db);
    expect(before).toHaveLength(migrations.length);
    expect(before.every((entry) => !entry.applied)).toBe(true);

    expect(await runInternalTrackerMigrations(f.db)).toEqual(migrations.map((entry) => entry.version));
    await expect(assertInternalTrackerOperational(f.db)).resolves.toBeUndefined();
    const applied = await f.db.query("SELECT version, checksum, applied_at FROM internal_tracker_schema_migrations ORDER BY version");
    expect(applied.rows.map((row) => ({ version: row.version, checksum: row.checksum }))).toEqual(
      migrations.map(({ version, checksum }) => ({ version, checksum })),
    );
    expect((await listInternalTrackerMigrationStatus(f.db)).every((entry) => entry.applied)).toBe(true);
    expect(await runInternalTrackerMigrations(f.db)).toEqual([]);
    expect((await f.db.query("SELECT version, checksum, applied_at FROM internal_tracker_schema_migrations ORDER BY version")).rows).toEqual(applied.rows);
  });

  it("refuses missing migration metadata on a real empty schema", async () => {
    const f = await start(false);
    await expect(assertInternalTrackerOperational(f.db)).rejects.toThrow(/migration/i);
  });

  it("refuses pending migrations even when their tables happen to exist", async () => {
    const f = await start();
    const latest = listInternalTrackerMigrations().at(-1);
    if (!latest) throw new Error("No migrations discovered");
    await f.db.query("DELETE FROM internal_tracker_schema_migrations WHERE version = $1", [latest.version]);
    await expect(assertInternalTrackerOperational(f.db)).rejects.toThrow(/migration/i);
  });

  it("detects an applied migration checksum mismatch", async () => {
    const f = await start();
    const first = listInternalTrackerMigrations()[0];
    if (!first) throw new Error("No migrations discovered");
    await f.db.query("UPDATE internal_tracker_schema_migrations SET checksum = 'corrupted' WHERE version = $1", [first.version]);
    await expect(runInternalTrackerMigrations(f.db)).rejects.toThrow(/checksum/i);
  });

  it("detects the absence of the repository lease uniqueness index", async () => {
    const f = await start();
    await f.db.query("DROP INDEX task_leases_active_repository_unique_idx");
    await expect(assertInternalTrackerOperational(f.db)).rejects.toThrow(/task_leases_active_repository_unique_idx/);
  });
});

describe("real PostgreSQL claim concurrency", () => {
  it("gives one task to only one of two independent database connections", async () => {
    const f = await start();
    const a = f.newWorker("worker-a");
    const b = f.newWorker("worker-b");
    const pidA = (await a.pool.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    const pidB = (await b.pool.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    expect(pidA).toBeTypeOf("number");
    expect(pidB).not.toBe(pidA);
    await a.tracker.createTask(taskInput("single-task"));

    const attempts = await Promise.all([a.claim(), b.claim()]);
    const winners = attempts.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const winner = claimed(winners[0] ?? null);
    expect(winner.task.id).toBe("single-task");
    const leases = await a.tracker.listActiveLeases();
    expect(leases).toHaveLength(2);
    expect(new Set(leases.map((lease) => lease.workerId)).size).toBe(1);
    expect((await b.tracker.getTask("single-task")).status).toBe("claimed");
  });

  it("serializes two different tasks sharing the same checkout", async () => {
    const f = await start();
    const a = f.newWorker("worker-a");
    const b = f.newWorker("worker-b");
    await a.tracker.createTask(taskInput("same-repo-a"));
    await a.tracker.createTask(taskInput("same-repo-b"));
    const attempts = await Promise.all([
      a.claim("repo-a", "same-repo-a"),
      b.claim("repo-a", "same-repo-b"),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const statuses = await Promise.all([a.tracker.getTask("same-repo-a"), b.tracker.getTask("same-repo-b")]);
    expect(statuses.map((task) => task.status).sort()).toEqual(["claimed", "ready"]);
    expect(await a.tracker.listActiveLeases()).toHaveLength(2);
  });

  it("allows independent repositories to hold claims at the same time", async () => {
    const f = await start();
    const a = f.newWorker("worker-a");
    const b = f.newWorker("worker-b");
    await a.tracker.createTask(taskInput("different-a", "repo-a"));
    await a.tracker.createTask(taskInput("different-b", "repo-b"));
    const attempts = await Promise.all([a.claim("repo-a"), b.claim("repo-b")]);
    expect(attempts.map((claim) => claimed(claim).task.id).sort()).toEqual(["different-a", "different-b"]);
    expect(await a.tracker.listActiveLeases()).toHaveLength(4);
  });

  it("skips a row locked by another transaction without blocking an unrelated task", async () => {
    const f = await start();
    const worker = f.newWorker("claiming-worker");
    await worker.tracker.createTask(taskInput("locked", "repo-a"));
    await worker.tracker.createTask(taskInput("unlocked", "repo-b"));
    const blocker = await f.newPool().connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", ["locked"]);
      // The transaction stays open: this proves overlap rather than relying on timing.
      expect(await worker.claim("repo-a", "locked")).toBeNull();
      expect(claimed(await worker.claim("repo-b", "unlocked")).task.id).toBe("unlocked");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
});

describe("real PostgreSQL lease lifecycle", () => {
  it("reclaims expired work and rejects stale credentials for the new leases", async () => {
    const f = await start();
    const a = f.newWorker("previous-worker");
    const b = f.newWorker("new-worker");
    await a.tracker.createTask(taskInput("expiring"));
    const old = claimed(await a.claim("repo-a", "expiring", 10));
    await a.tracker.setStatus("expiring", "analyzing", "Simulated interrupted work");
    f.advance(11_000);
    const current = claimed(await b.claim("repo-a", "expiring", 60));
    expect(current.task.status).toBe("claimed");
    expect(leaseIds(current)).not.toEqual(leaseIds(old));

    for (const [stale, fresh] of [
      [old.taskLease, current.taskLease],
      [old.repositoryLease, current.repositoryLease],
    ] as const) {
      await expect(a.tracker.heartbeatLease(fresh.leaseId, {
        workerId: a.workerId, token: stale.token, leaseTtlSeconds: 60,
      })).rejects.toThrow();
      await expect(a.tracker.releaseLease(fresh.leaseId, {
        workerId: a.workerId, token: stale.token,
      })).rejects.toThrow();
      await expect(a.tracker.heartbeatLease(stale.leaseId, {
        workerId: a.workerId, token: stale.token, leaseTtlSeconds: 60,
      })).rejects.toThrow();
      // Releasing an already expired/released old lease is harmless and idempotent.
      await a.tracker.releaseLease(stale.leaseId, { workerId: a.workerId, token: stale.token });
    }
    expect((await b.tracker.listActiveLeases()).map((lease) => lease.leaseId).sort()).toEqual(leaseIds(current));
  });

  it("extends both leases with heartbeat and keeps competitors out past the original expiry", async () => {
    const f = await start();
    const a = f.newWorker("owner");
    const b = f.newWorker("competitor");
    await a.tracker.createTask(taskInput("heartbeat"));
    const current = claimed(await a.claim("repo-a", "heartbeat", 10));
    f.advance(5_000);
    for (const lease of [current.taskLease, current.repositoryLease]) {
      const updated = await a.tracker.heartbeatLease(lease.leaseId, {
        workerId: a.workerId, token: lease.token, leaseTtlSeconds: 30,
      });
      expect(Date.parse(updated.expiresAt)).toBe(f.now().getTime() + 30_000);
    }
    f.advance(6_000);
    expect(await b.claim("repo-a", "heartbeat")).toBeNull();
    expect(await a.tracker.listActiveLeases()).toHaveLength(2);
  });

  it("releases leases idempotently so another task in that checkout can run", async () => {
    const f = await start();
    const a = f.newWorker("owner");
    const b = f.newWorker("next-worker");
    await a.tracker.createTask(taskInput("first"));
    await a.tracker.createTask(taskInput("second"));
    const first = claimed(await a.claim("repo-a", "first"));
    expect(await b.claim("repo-a", "second")).toBeNull();
    for (const lease of [first.taskLease, first.repositoryLease]) {
      const credentials = { workerId: a.workerId, token: lease.token };
      await a.tracker.releaseLease(lease.leaseId, credentials);
      await a.tracker.releaseLease(lease.leaseId, credentials);
    }
    expect(await a.tracker.listActiveLeases()).toEqual([]);
    expect(claimed(await b.claim("repo-a", "second")).task.id).toBe("second");
  });

  it("reuses an idempotent claim without creating duplicate leases", async () => {
    const f = await start();
    const worker = f.newWorker("owner");
    await worker.tracker.createTask(taskInput("idempotent"));
    const first = claimed(await worker.claim("repo-a", "idempotent", 60, "claim-request-1"));
    const repeated = claimed(await worker.claim("repo-a", "idempotent", 60, "claim-request-1"));
    expect(leaseIds(repeated)).toEqual(leaseIds(first));
    expect(await worker.tracker.listActiveLeases()).toHaveLength(2);
  });
});

describe("real PostgreSQL persistence across new connections", () => {
  it("preserves questions, validation, MR and active leases after every worker pool is closed", async () => {
    const f = await start();
    const writer = f.newWorker("writer");
    const oldPid = (await writer.pool.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    await writer.tracker.createTask(taskInput("question-task", "repo-a"));
    await writer.tracker.createTask(taskInput("mr-task", "repo-b"));
    claimed(await writer.claim("repo-a", "question-task", 300));
    await writer.tracker.setStatus("question-task", "analyzing", "Analysis");
    await writer.tracker.askClarification("question-task", {
      workerId: writer.workerId, threadId: "persisted-thread",
      summary: "Need a business decision", blockingReason: "Ambiguous requirement",
      question: "Which variant should be used?", options: ["A", "B"], resumeHint: "/resume A",
    });
    await writer.tracker.setStatus("question-task", "awaiting_human", "Wait for answer");

    claimed(await writer.claim("repo-b", "mr-task", 300));
    await writer.tracker.setStatus("mr-task", "analyzing", "Analysis");
    await writer.tracker.setStatus("mr-task", "implementing", "Implementation");
    await writer.tracker.setStatus("mr-task", "validating", "Validation");
    await writer.tracker.recordValidation("mr-task", {
      workerId: writer.workerId, status: "passed", summary: "Current checks passed",
      validation: {
        changed: true, lintPassed: true, testsPassed: true, diagnostic: "",
        gates: ["lint", "tests"].map((id) => ({
          id: id as "lint" | "tests", label: id, command: `npm run ${id}`,
          status: "passed" as const, exitCode: 0, diagnostic: "passed",
        })),
      },
    });
    await writer.tracker.recordMergeRequest("mr-task", {
      workerId: writer.workerId, branch: "feature/ci-task", outcome: "created",
      validationSummary: "Current checks passed",
      mergeRequest: {
        id: 42, iid: 7, url: "https://gitlab.example.test/project/-/merge_requests/7",
        title: "Test MR", sourceBranch: "feature/ci-task", targetBranch: "main", state: "opened",
      },
    });
    await writer.tracker.setStatus("mr-task", "review", "Ready for human review");
    const questionBefore = await writer.tracker.getTask("question-task");
    const mrBefore = await writer.tracker.getTask("mr-task");
    const leasesBefore = await writer.tracker.listActiveLeases();
    expect(leasesBefore).toHaveLength(4);

    await f.closePools();
    const reader = f.newWorker("reader-after-reconnect");
    const newPid = (await reader.pool.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    expect(newPid).not.toBe(oldPid);
    const questionAfter = await reader.tracker.getTask("question-task");
    const mrAfter = await reader.tracker.getTask("mr-task");
    expect(questionAfter.status).toBe("awaiting_human");
    expect(questionAfter.clarificationQuestions).toEqual(questionBefore.clarificationQuestions);
    expect(questionAfter.clarificationQuestions[0]?.threadId).toBe("persisted-thread");
    expect(questionAfter.revisions).toEqual(questionBefore.revisions);
    expect(mrAfter.status).toBe("review");
    expect(mrAfter.qualityGateRuns).toEqual(mrBefore.qualityGateRuns);
    expect(mrAfter.mergeRequests).toEqual(mrBefore.mergeRequests);
    expect(mrAfter.mergeRequests[0]?.mergeRequest.iid).toBe(7);
    expect((await reader.tracker.listActiveLeases()).map((lease) => lease.leaseId).sort()).toEqual(
      leasesBefore.map((lease) => lease.leaseId).sort(),
    );
    await reader.tracker.recordHumanAnswer("question-task", {
      author: human, body: "/resume A", questionId: questionAfter.clarificationQuestions[0]?.id,
    });
    expect((await reader.tracker.getTask("question-task")).humanAnswers).toHaveLength(1);
  });
});
