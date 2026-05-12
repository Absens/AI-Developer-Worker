import { randomUUID } from "node:crypto";

import type {
  TaskTrackerClient,
  TaskTrackerOperationalConfig,
} from "../../models/types.js";
import type { MetricsRegistry } from "../../observability/metrics.js";
import type { Logger } from "../../utils/logger.js";
import type { PostgresQueryable } from "./postgresTaskTracker.js";

export interface InternalTrackerCleanupResult {
  deletedRawLogs: number;
  deletedArtifacts: number;
  releasedLeases: number;
  staleProposals: number;
  durationMs: number;
}

export interface InternalTrackerCleanupRunnerInput {
  db: PostgresQueryable;
  taskTracker: TaskTrackerClient;
  operational: TaskTrackerOperationalConfig;
  metrics?: MetricsRegistry;
  logger?: Logger;
  now?: () => Date;
}

const RAW_LOG_KINDS = new Set(["raw_codex_log", "codex_raw_log", "codex_log"]);
const dayMs = 24 * 60 * 60 * 1000;

const cutoff = (now: Date, days: number): string =>
  new Date(now.getTime() - days * dayMs).toISOString();

const safeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class InternalTrackerCleanupRunner {
  private readonly now: () => Date;

  constructor(private readonly input: InternalTrackerCleanupRunnerInput) {
    this.now = input.now ?? (() => new Date());
  }

  async runOnce(): Promise<InternalTrackerCleanupResult> {
    const started = Date.now();
    const now = this.now();
    const retention = this.input.operational.retention;
    const rawLogCutoff = cutoff(now, retention.rawLogDays);
    const artifactCutoff = cutoff(now, retention.artifactDays);
    const failedArtifactCutoff = cutoff(now, retention.failedArtifactDays);

    const proposals = await this.input.taskTracker.cleanupProposals({
      now: now.toISOString(),
      limit: 500,
    });
    const deletedArtifacts = await this.input.db.query<{
      id: string;
      kind: string;
    }>(
      `
        DELETE FROM artifacts a
        USING tasks t
        WHERE a.task_id = t.id
          AND (
            (
              (a.kind = ANY($1::text[]) OR a.retention_class = 'short_lived')
              AND a.created_at < $2
            )
            OR (
              a.kind = 'validation_artifact'
              AND t.status <> 'failed'
              AND a.created_at < $3
            )
            OR (
              a.kind = 'validation_artifact'
              AND t.status = 'failed'
              AND a.created_at < $4
            )
          )
        RETURNING a.id, a.kind
      `,
      [[...RAW_LOG_KINDS], rawLogCutoff, artifactCutoff, failedArtifactCutoff],
    );
    const releasedLeases = await this.input.db.query(
      `
        DELETE FROM task_leases
        WHERE released_at IS NOT NULL AND released_at < $1
      `,
      [rawLogCutoff],
    );
    const result: InternalTrackerCleanupResult = {
      deletedRawLogs: deletedArtifacts.rows.filter((row) =>
        RAW_LOG_KINDS.has(row.kind),
      ).length,
      deletedArtifacts: deletedArtifacts.rowCount ?? deletedArtifacts.rows.length,
      releasedLeases: releasedLeases.rowCount ?? 0,
      staleProposals: proposals.staleRejected.length,
      durationMs: Date.now() - started,
    };

    await this.input.db.query(
      `
        INSERT INTO internal_tracker_cleanup_runs (
          id, job_name, started_at, completed_at, deleted_raw_logs,
          deleted_artifacts, released_leases, stale_proposals, details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        `cleanup_${randomUUID()}`,
        "internal_tracker_retention",
        new Date(started).toISOString(),
        new Date().toISOString(),
        result.deletedRawLogs,
        result.deletedArtifacts,
        result.releasedLeases,
        result.staleProposals,
        JSON.stringify({
          retainedRejectedProposals: proposals.rejectedRetained.length,
          rawLogCutoff,
          artifactCutoff,
          failedArtifactCutoff,
        }),
      ],
    );

    this.input.metrics?.observeHistogram(
      "ai_developer_task_tracker_cleanup_duration_seconds",
      { job: "internal_tracker_retention" },
      result.durationMs / 1000,
    );
    this.input.metrics?.incrementCounter(
      "ai_developer_task_tracker_cleanup_deleted_total",
      { kind: "raw_log" },
      result.deletedRawLogs,
    );
    this.input.metrics?.incrementCounter(
      "ai_developer_task_tracker_cleanup_deleted_total",
      { kind: "artifact" },
      result.deletedArtifacts,
    );
    this.input.metrics?.incrementCounter(
      "ai_developer_task_tracker_cleanup_deleted_total",
      { kind: "released_lease" },
      result.releasedLeases,
    );
    this.input.metrics?.incrementCounter(
      "ai_developer_task_tracker_proposals_cleaned_total",
      { outcome: "stale_rejected" },
      result.staleProposals,
    );

    this.input.logger?.info("Internal tracker cleanup completed.", result);
    return result;
  }
}

export class InternalTrackerCleanupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly runner: InternalTrackerCleanupRunner,
    private readonly operational: TaskTrackerOperationalConfig,
    private readonly logger?: Logger,
  ) {}

  start(): void {
    if (!this.operational.cleanup.enabled || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        this.logger?.warn("Internal tracker cleanup failed.", {
          error: safeError(error),
        });
      });
    }, this.operational.cleanup.intervalSeconds * 1000);
    this.timer.unref?.();
  }

  async runOnce(): Promise<InternalTrackerCleanupResult | undefined> {
    if (!this.operational.cleanup.enabled || this.running) {
      return undefined;
    }
    this.running = true;
    try {
      return await this.runner.runOnce();
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
