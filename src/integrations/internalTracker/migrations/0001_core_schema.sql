-- Phase 7A core schema skeleton for the internal AI task tracker.
-- This file is intentionally not wired into application startup yet.

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  human_summary text,
  source jsonb NOT NULL,
  created_by jsonb NOT NULL,
  repository_name text,
  repo_path_key text,
  base_branch text,
  queue text,
  tags text[] NOT NULL DEFAULT '{}',
  components text[] NOT NULL DEFAULT '{}',
  priority text,
  deadline timestamptz,
  status text NOT NULL,
  business_status text,
  task_type text NOT NULL,
  prompt_profile_id text,
  confidence integer,
  acceptance_criteria text[] NOT NULL DEFAULT '{}',
  constraints text[] NOT NULL DEFAULT '{}',
  risk_factors text[] NOT NULL DEFAULT '{}',
  missing_context text[] NOT NULL DEFAULT '{}',
  field_owners jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_synced_at timestamptz,
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100))
);

CREATE TABLE IF NOT EXISTS task_revisions (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  owner text NOT NULL,
  author jsonb NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  human_summary text,
  acceptance_criteria text[] NOT NULL DEFAULT '{}',
  constraints text[] NOT NULL DEFAULT '{}',
  risk_factors text[] NOT NULL DEFAULT '{}',
  missing_context text[] NOT NULL DEFAULT '{}',
  external_snapshot jsonb,
  external_revision_id text,
  reason text,
  created_at timestamptz NOT NULL,
  UNIQUE (task_id, revision_number)
);

CREATE TABLE IF NOT EXISTS task_external_refs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_key text NOT NULL,
  external_url text,
  business_status text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (provider, external_key)
);

CREATE TABLE IF NOT EXISTS task_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source text NOT NULL,
  actor jsonb,
  message text,
  payload jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS task_events_task_time_idx
  ON task_events(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS task_comments (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  author jsonb NOT NULL,
  body text,
  payload jsonb,
  external_ref jsonb,
  created_at timestamptz NOT NULL,
  CHECK (kind IN (
    'comment',
    'question',
    'answer',
    'command',
    'status_digest',
    'system_event'
  ))
);

CREATE INDEX IF NOT EXISTS task_comments_task_time_idx
  ON task_comments(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS task_decisions (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  schema_version integer NOT NULL,
  source text NOT NULL,
  author_id text,
  worker_id text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS task_plans (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status text NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS task_steps (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
  kind text NOT NULL,
  attempt integer NOT NULL,
  status text NOT NULL,
  input_context_hash text,
  output_summary text,
  failure_kind text,
  diagnostic text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id text PRIMARY KEY,
  from_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  reason text,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS task_dependencies_from_idx
  ON task_dependencies(from_task_id, status);

CREATE INDEX IF NOT EXISTS task_dependencies_to_idx
  ON task_dependencies(to_task_id, status);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  path text,
  uri text,
  summary text,
  retention_class text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (path IS NOT NULL OR uri IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS task_step_artifacts (
  step_id text NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (step_id, artifact_id)
);
