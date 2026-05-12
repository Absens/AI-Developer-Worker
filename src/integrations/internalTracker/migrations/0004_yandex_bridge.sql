-- Phase 7E Yandex bridge persistence.

ALTER TABLE task_revisions
  ADD COLUMN IF NOT EXISTS requires_reanalysis boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sync_cursors (
  provider text NOT NULL,
  scope text NOT NULL,
  cursor text NOT NULL,
  payload jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider, scope)
);

CREATE TABLE IF NOT EXISTS external_issue_snapshots (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_key text NOT NULL,
  external_revision_id text,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS external_issue_snapshots_ref_idx
  ON external_issue_snapshots(provider, external_key, observed_at);

CREATE TABLE IF NOT EXISTS external_field_ownership (
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_key text NOT NULL,
  owner text NOT NULL,
  fields text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, provider, external_key)
);

CREATE TABLE IF NOT EXISTS imported_human_commands (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_key text NOT NULL,
  external_comment_id text NOT NULL,
  author jsonb,
  body text NOT NULL,
  command jsonb,
  imported_at timestamptz NOT NULL,
  UNIQUE (provider, external_key, external_comment_id)
);

CREATE TABLE IF NOT EXISTS external_digest_exports (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_key text NOT NULL,
  digest_key text NOT NULL,
  digest text NOT NULL,
  payload jsonb,
  exported_at timestamptz NOT NULL,
  UNIQUE (provider, external_key, digest_key)
);

CREATE TABLE IF NOT EXISTS external_status_syncs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_key text NOT NULL,
  target_business_status text NOT NULL,
  reason text,
  synced_at timestamptz NOT NULL,
  UNIQUE (provider, external_key, target_business_status)
);
