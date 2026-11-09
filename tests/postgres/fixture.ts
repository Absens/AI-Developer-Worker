import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { requireTestDatabaseUrl } from "../../scripts/run-postgres-tests.js";
import { runInternalTrackerMigrations } from "../../src/integrations/internalTracker/migrations.js";
import { PostgresTaskTrackerClient } from "../../src/integrations/internalTracker/postgresTaskTracker.js";
import type { CreateTaskInput, TaskActor } from "../../src/domain/taskTracker/types.js";

export const human: TaskActor = { owner: "human", id: "postgres-ci-user" };
export const profile = (name = "repo-a") => ({
  name, repoPathKey: name, queues: ["DEV"], tags: ["ai_dev"],
});
export const taskInput = (id: string, repository = "repo-a"): CreateTaskInput => ({
  id,
  title: `PostgreSQL integration: ${id}`,
  description: "Isolated test task; no production integrations.",
  createdBy: human,
  repositoryName: repository,
  repoPathKey: repository,
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  status: "ready",
  taskType: "backend_endpoint",
  acceptanceCriteria: ["The current database contract holds."],
});

export const createPostgresFixture = async (migrate = true) => {
  const connectionString = requireTestDatabaseUrl(process.env);
  const schema = `pg_ci_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  const pools = new Set<Pool>();
  // Only lease time is controlled. PostgreSQL transactions, constraints and locks are real.
  let clock = new Date();
  let created = false;
  const closePools = async (): Promise<void> => {
    const closing = [...pools];
    pools.clear();
    await Promise.all(closing.map((pool) => pool.end()));
  };
  const dispose = async (): Promise<void> => {
    try {
      await closePools();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  };
  const newPool = (): Pool => {
    const pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`,
    });
    pools.add(pool);
    return pool;
  };
  try {
    // schema is generated locally, not derived from any task or user input.
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const db = newPool();
    if (migrate) await runInternalTrackerMigrations(db);
    const newWorker = (workerId: string) => {
      const pool = newPool();
      const tracker = new PostgresTaskTrackerClient(pool, { now: () => new Date(clock) });
      return {
        workerId, pool, tracker,
        claim: (repository = "repo-a", targetExternalKey?: string, leaseTtlSeconds = 60, idempotencyKey?: string) =>
          tracker.claimNextTask({
            workerId, repositoryProfiles: [profile(repository)], leaseTtlSeconds,
            ...(targetExternalKey ? { targetExternalKey } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
      };
    };
    return {
      schema, db, newPool, newWorker, closePools, dispose,
      now: () => new Date(clock),
      advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

export type PostgresFixture = Awaited<ReturnType<typeof createPostgresFixture>>;
