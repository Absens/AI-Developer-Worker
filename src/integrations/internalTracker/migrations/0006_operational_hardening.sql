-- Phase 7H operational hardening metadata.

CREATE TABLE IF NOT EXISTS internal_tracker_cleanup_runs (
  id text PRIMARY KEY,
  job_name text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  deleted_raw_logs integer NOT NULL DEFAULT 0,
  deleted_artifacts integer NOT NULL DEFAULT 0,
  released_leases integer NOT NULL DEFAULT 0,
  stale_proposals integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS artifacts_cleanup_idx
  ON artifacts(kind, retention_class, created_at);

CREATE INDEX IF NOT EXISTS task_leases_released_cleanup_idx
  ON task_leases(released_at)
  WHERE released_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runs_cleanup_idx
  ON agent_runs(completed_at)
  WHERE completed_at IS NOT NULL;
