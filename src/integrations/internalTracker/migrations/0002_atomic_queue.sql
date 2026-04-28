-- Phase 7B atomic claim queue and lease tables.

CREATE TABLE IF NOT EXISTS task_leases (
  lease_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('task', 'repository')),
  lease_key text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repository_name text NOT NULL,
  worker_id text NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_leases_active_task_unique_idx
  ON task_leases(task_id)
  WHERE kind = 'task' AND released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS task_leases_active_repository_unique_idx
  ON task_leases(lease_key)
  WHERE kind = 'repository' AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS task_leases_task_active_idx
  ON task_leases(task_id, expires_at)
  WHERE kind = 'task' AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS task_leases_repository_active_idx
  ON task_leases(lease_key, expires_at)
  WHERE kind = 'repository' AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS task_leases_expires_at_idx
  ON task_leases(expires_at)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_claim_idx
  ON tasks(status, repository_name, priority, deadline);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx
  ON idempotency_keys(expires_at)
  WHERE expires_at IS NOT NULL;
