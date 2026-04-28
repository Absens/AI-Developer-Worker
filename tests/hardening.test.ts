import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InMemoryTaskTrackerClient,
  type CreateTaskInput,
  type TaskActor,
} from "../src/domain/taskTracker/index.js";
import {
  assertInternalTrackerOperational,
  listInternalTrackerMigrations,
  PostgresTaskTrackerClient,
  type PostgresQueryable,
} from "../src/integrations/internalTracker/index.js";
import { InternalTrackerCleanupRunner } from "../src/integrations/internalTracker/cleanup.js";
import { mapTaskTimelineEventToObservability } from "../src/observability/lifecycleMapping.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";

const human: TaskActor = {
  owner: "human",
  id: "dev-1",
};

const baseTaskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  id: "task-hardening",
  title: "Harden tracker",
  description: "Verify operational hardening.",
  createdBy: human,
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  status: "ready",
  taskType: "backend_endpoint",
  ...overrides,
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

describe("Phase 7H hardening", () => {
  it("preflight fails when migration metadata is missing", async () => {
    const db: PostgresQueryable = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        if (text === "SELECT 1") {
          return asQueryResult(queryResult([{ "?column?": 1 }]));
        }
        if (text.includes("to_regclass") && values?.[0] === "internal_tracker_schema_migrations") {
          return asQueryResult(queryResult([{ exists: false }]));
        }
        return asQueryResult(queryResult([]));
      },
    };

    await expect(assertInternalTrackerOperational(db)).rejects.toThrow(/migrations/);
  });

  it("preflight fails when a required index is missing", async () => {
    const applied = listInternalTrackerMigrations().map((migration) => ({
      version: migration.version,
    }));
    const db: PostgresQueryable = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        if (text === "SELECT 1" || text === "BEGIN" || text === "ROLLBACK") {
          return asQueryResult(queryResult([]));
        }
        if (text.includes("SELECT version FROM internal_tracker_schema_migrations")) {
          return asQueryResult(queryResult(applied));
        }
        if (text.includes("FOR UPDATE SKIP LOCKED")) {
          return asQueryResult(queryResult([]));
        }
        if (text.includes("to_regclass")) {
          const relation = String(values?.[0] ?? "");
          return asQueryResult(queryResult([
            { exists: relation !== "task_leases_active_task_unique_idx" },
          ]));
        }
        return asQueryResult(queryResult([]));
      },
    };

    await expect(assertInternalTrackerOperational(db)).rejects.toThrow(
      /task_leases_active_task_unique_idx/,
    );
  });

  it("redacts secrets before storing events, comments, and diagnostics", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    await tracker.createTask(baseTaskInput());
    await tracker.appendEvent("task-hardening", {
      kind: "secret_event",
      source: "worker_agent",
      message: "TOKEN=super-secret",
      payload: { authorization: "Bearer super-secret" },
    });
    await tracker.appendComment("task-hardening", {
      kind: "comment",
      author: human,
      body: "Authorization: Bearer super-secret",
    });
    await tracker.recordValidation("task-hardening", {
      workerId: "worker-1",
      status: "failed",
      validation: {
        changed: true,
        testsPassed: false,
        lintPassed: true,
        gates: [],
        diagnostic: "GITLAB_TOKEN=super-secret",
      },
    });

    const task = await tracker.getTask("task-hardening");
    expect(JSON.stringify(task)).not.toContain("super-secret");
    expect(task.events.find((event) => event.kind === "secret_event")?.message).toContain(
      "[redacted]",
    );
    expect(task.qualityGateRuns[0]?.diagnostic).toContain("[redacted]");
  });

  it("emits cleanup metrics while preserving compact task history outside artifact deletion", async () => {
    const metrics = new InMemoryMetricsRegistry();
    const tracker = new InMemoryTaskTrackerClient();
    const db: PostgresQueryable = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
      ): Promise<QueryResult<R>> {
        if (text.includes("DELETE FROM artifacts")) {
          return asQueryResult(queryResult(
            [
              { id: "artifact-1", kind: "raw_codex_log" },
              { id: "artifact-2", kind: "validation_artifact" },
            ],
            2,
          ));
        }
        if (text.includes("DELETE FROM task_leases")) {
          return asQueryResult(queryResult([], 1));
        }
        return asQueryResult(queryResult([]));
      },
    };
    const runner = new InternalTrackerCleanupRunner({
      db,
      taskTracker: tracker,
      operational: {
        retention: {
          rawLogDays: 30,
          artifactDays: 30,
          failedArtifactDays: 90,
          historyDays: 365,
        },
        cleanup: { enabled: true, intervalSeconds: 3600 },
        metricsEnabled: true,
        redactionEnabled: true,
      },
      metrics,
      now: () => new Date("2026-04-28T12:00:00.000Z"),
    });

    const result = await runner.runOnce();

    expect(result).toMatchObject({
      deletedRawLogs: 1,
      deletedArtifacts: 2,
      releasedLeases: 1,
    });
    expect(metrics.renderPrometheus()).toContain(
      "ai_developer_task_tracker_cleanup_deleted_total",
    );
  });

  it("maps task timeline events to observability events with stable identifiers", () => {
    const mapped = mapTaskTimelineEventToObservability(
      {
        id: "evt-1",
        taskId: "task-1",
        kind: "task_status_changed",
        source: "worker_agent",
        actor: { owner: "worker_agent", id: "worker-1" },
        message: "failed",
        payload: {
          from: "validating",
          to: "failed",
          taskLeaseId: "lease-task",
          repositoryLeaseId: "lease-repo",
          failureKind: "validation",
        },
        createdAt: "2026-04-28T12:00:00.000Z",
      },
      { task: { id: "task-1", repositoryName: "developer", status: "failed", updatedAt: "" } },
    );

    expect(mapped).toMatchObject({
      id: "evt-1",
      issueKey: "task-1",
      workerId: "worker-1",
      repositoryName: "developer",
      type: "task_failed",
      status: "error",
      details: {
        taskId: "task-1",
        workerId: "worker-1",
        repositoryName: "developer",
        leaseId: "lease-task",
        repositoryLeaseId: "lease-repo",
        statusFrom: "validating",
        statusTo: "failed",
        failureClassification: "validation",
      },
    });
  });
});

const testDatabaseUrl = process.env.TASK_TRACKER_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("Phase 7H PostgreSQL restart recovery", () => {
  let pg: Client;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `phase7h_${randomUUID().replace(/-/g, "")}`;
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

  it("recovers task and active lease state through a new client instance", async () => {
    const first = new PostgresTaskTrackerClient(pg);
    await first.createTask(baseTaskInput({ id: "pg-recovery" }));
    const claim = await first.claimNextTask({
      workerId: "worker-1",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });

    const restarted = new PostgresTaskTrackerClient(pg);
    const task = await restarted.getTask("pg-recovery");
    const leases = await restarted.listActiveLeases();

    expect(task.status).toBe("claimed");
    expect(leases.map((lease) => lease.leaseId)).toEqual(
      expect.arrayContaining([
        claim?.taskLease.leaseId,
        claim?.repositoryLease.leaseId,
      ]),
    );
  });
});
