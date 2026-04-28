import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { QueryResult, QueryResultRow } from "pg";

import type {
  PostgresPoolLike,
  PostgresQueryable,
} from "./postgresTaskTracker.js";

export interface InternalTrackerMigration {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

export interface InternalTrackerMigrationStatus {
  tableExists: boolean;
  applied: string[];
  pending: string[];
  missing: string[];
}

type TransactionClient = PostgresQueryable & { release?: () => void };

const MIGRATION_TABLE = "internal_tracker_schema_migrations";
const migrationDir = dirname(fileURLToPath(import.meta.url));

export const REQUIRED_INTERNAL_TRACKER_TABLES = [
  "tasks",
  "task_revisions",
  "task_external_refs",
  "task_events",
  "task_comments",
  "task_decisions",
  "task_plans",
  "task_steps",
  "task_dependencies",
  "artifacts",
  "task_step_artifacts",
  "task_leases",
  "idempotency_keys",
  "agent_runs",
  "quality_gate_runs",
  "quality_gate_run_artifacts",
  "merge_request_records",
  "review_metadata_records",
  "memory_context_refs",
  "sync_cursors",
  "external_issue_snapshots",
  "external_field_ownership",
  "imported_human_commands",
  "external_digest_exports",
  "external_status_syncs",
  "task_proposals",
  "task_proposal_evidence",
  "task_proposal_duplicate_signatures",
  "autonomy_policy_evaluations",
  "proposal_rate_limit_windows",
  "proposal_cleanup_metadata",
  "internal_tracker_cleanup_runs",
] as const;

export const REQUIRED_INTERNAL_TRACKER_INDEXES = [
  "task_events_task_time_idx",
  "task_comments_task_time_idx",
  "task_dependencies_from_idx",
  "task_dependencies_to_idx",
  "task_leases_active_task_unique_idx",
  "task_leases_active_repository_unique_idx",
  "task_leases_task_active_idx",
  "task_leases_repository_active_idx",
  "task_leases_expires_at_idx",
  "tasks_claim_idx",
  "idempotency_keys_expiry_idx",
  "agent_runs_task_time_idx",
  "quality_gate_runs_task_time_idx",
  "merge_request_records_task_time_idx",
  "review_metadata_records_task_time_idx",
  "memory_context_refs_task_time_idx",
  "external_issue_snapshots_ref_idx",
  "task_proposals_status_idx",
  "task_proposals_duplicate_signature_idx",
  "task_proposal_evidence_ref_idx",
  "task_proposal_duplicate_repo_idx",
  "autonomy_policy_evaluations_task_time_idx",
  "artifacts_cleanup_idx",
  "task_leases_released_cleanup_idx",
  "agent_runs_cleanup_idx",
] as const;

const isPoolLike = (value: PostgresQueryable): value is PostgresPoolLike =>
  typeof (value as { connect?: unknown }).connect === "function";

const checksum = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

export const listInternalTrackerMigrations = (): InternalTrackerMigration[] => {
  const compiledAdjacent = join(migrationDir, "migrations");
  const sourceTree = join(
    process.cwd(),
    "src",
    "integrations",
    "internalTracker",
    "migrations",
  );
  const directory = existsSync(compiledAdjacent) ? compiledAdjacent : sourceTree;
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(directory, filename), "utf8");
      const match = filename.match(/^(\d+)_([^.]+)\.sql$/);
      if (!match) {
        throw new Error(`Invalid internal tracker migration filename: ${filename}`);
      }
      return {
        version: match[1] as string,
        name: match[2] as string,
        filename,
        checksum: checksum(sql),
        sql,
      };
    });
};

const withMigrationConnection = async <T>(
  db: PostgresQueryable,
  callback: (client: TransactionClient) => Promise<T>,
): Promise<T> => {
  const client: TransactionClient = isPoolLike(db) ? await db.connect() : db;
  try {
    return await callback(client);
  } finally {
    client.release?.();
  }
};

const ensureMigrationTable = async (client: PostgresQueryable): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

export const runInternalTrackerMigrations = async (
  db: PostgresQueryable,
): Promise<InternalTrackerMigration[]> =>
  withMigrationConnection(db, async (client) => {
    await ensureMigrationTable(client);
    const appliedResult = await client.query<{
      version: string;
      checksum: string;
    }>(`SELECT version, checksum FROM ${MIGRATION_TABLE}`);
    const applied = new Map(
      appliedResult.rows.map((row) => [row.version, row.checksum]),
    );
    const ran: InternalTrackerMigration[] = [];

    for (const migration of listInternalTrackerMigrations()) {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Internal tracker migration ${migration.filename} checksum changed after it was applied.`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `
            INSERT INTO ${MIGRATION_TABLE} (version, name, checksum)
            VALUES ($1, $2, $3)
          `,
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        ran.push(migration);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    return ran;
  });

export const getInternalTrackerMigrationStatus = async (
  db: PostgresQueryable,
): Promise<InternalTrackerMigrationStatus> => {
  const table = await db.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [MIGRATION_TABLE],
  );
  const tableExists = table.rows[0]?.exists === true;
  const migrations = listInternalTrackerMigrations();
  if (!tableExists) {
    return {
      tableExists,
      applied: [],
      pending: migrations.map((migration) => migration.version),
      missing: migrations.map((migration) => migration.version),
    };
  }

  const appliedResult = await db.query<{ version: string }>(
    `SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`,
  );
  const applied = appliedResult.rows.map((row) => row.version);
  const appliedSet = new Set(applied);
  const pending = migrations
    .filter((migration) => !appliedSet.has(migration.version))
    .map((migration) => migration.version);

  return {
    tableExists,
    applied,
    pending,
    missing: pending,
  };
};

const relationExists = async (
  db: PostgresQueryable,
  relationName: string,
): Promise<boolean> => {
  const result = await db.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [relationName],
  );
  return result.rows[0]?.exists === true;
};

const assertTransactionClaimSupport = async (
  db: PostgresQueryable,
): Promise<void> => {
  await withMigrationConnection(db, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT id FROM tasks LIMIT 0 FOR UPDATE SKIP LOCKED");
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
};

export const assertInternalTrackerOperational = async (
  db: PostgresQueryable,
): Promise<void> => {
  await db.query("SELECT 1");

  const status = await getInternalTrackerMigrationStatus(db);
  if (!status.tableExists) {
    throw new Error(
      "Internal tracker migrations are not initialized. Run npm run tracker:migrate.",
    );
  }
  if (status.pending.length > 0) {
    throw new Error(
      `Internal tracker migrations are pending: ${status.pending.join(", ")}. Run npm run tracker:migrate.`,
    );
  }

  const missingTables: string[] = [];
  for (const table of REQUIRED_INTERNAL_TRACKER_TABLES) {
    if (!(await relationExists(db, table))) {
      missingTables.push(table);
    }
  }
  if (missingTables.length > 0) {
    throw new Error(
      `Internal tracker schema is missing tables: ${missingTables.join(", ")}.`,
    );
  }

  const missingIndexes: string[] = [];
  for (const index of REQUIRED_INTERNAL_TRACKER_INDEXES) {
    if (!(await relationExists(db, index))) {
      missingIndexes.push(index);
    }
  }
  if (missingIndexes.length > 0) {
    throw new Error(
      `Internal tracker schema is missing indexes: ${missingIndexes.join(", ")}.`,
    );
  }

  await assertTransactionClaimSupport(db);
};

export type InternalTrackerMigrationQueryResult<R extends QueryResultRow = QueryResultRow> =
  QueryResult<R>;
