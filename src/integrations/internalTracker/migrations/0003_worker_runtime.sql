-- Phase 7D worker runtime records.

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  thread_id text,
  exit_code integer,
  timed_out boolean,
  final_message text,
  diagnostic text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_runs_task_time_idx
  ON agent_runs(task_id, started_at, id);

CREATE TABLE IF NOT EXISTS quality_gate_runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  status text NOT NULL,
  changed boolean NOT NULL,
  tests_passed boolean NOT NULL,
  lint_passed boolean NOT NULL,
  gates jsonb NOT NULL,
  diagnostic text NOT NULL,
  summary text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS quality_gate_runs_task_time_idx
  ON quality_gate_runs(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS quality_gate_run_artifacts (
  validation_id text NOT NULL REFERENCES quality_gate_runs(id) ON DELETE CASCADE,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (validation_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS merge_request_records (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  merge_request jsonb NOT NULL,
  branch text NOT NULL,
  outcome text NOT NULL,
  validation_summary text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS merge_request_records_task_time_idx
  ON merge_request_records(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS review_metadata_records (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS review_metadata_records_task_time_idx
  ON review_metadata_records(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS memory_context_refs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  prompt_profile_id text NOT NULL,
  task_type text NOT NULL,
  knowledge_section_ids text[] NOT NULL DEFAULT '{}',
  prompt_rule_ids text[] NOT NULL DEFAULT '{}',
  similar_failure_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_context_refs_task_time_idx
  ON memory_context_refs(task_id, created_at, id);
