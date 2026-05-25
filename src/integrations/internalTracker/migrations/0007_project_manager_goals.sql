-- Project manager goal storage.

CREATE TABLE IF NOT EXISTS project_analyses (
  id text PRIMARY KEY,
  repository_name text NOT NULL,
  summary text NOT NULL,
  health_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  stale_goal_ids text[] NOT NULL DEFAULT '{}',
  replan_reason text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS project_analyses_repository_time_idx
  ON project_analyses(repository_name, created_at DESC, id);

CREATE TABLE IF NOT EXISTS project_manager_runs (
  id text PRIMARY KEY,
  repository_name text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL,
  analysis_id text,
  proposed_goal_ids text[] NOT NULL DEFAULT '{}',
  proposed_task_ids text[] NOT NULL DEFAULT '{}',
  diagnostic text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT project_manager_runs_analysis_id_fkey
    FOREIGN KEY (analysis_id) REFERENCES project_analyses(id) ON DELETE SET NULL,
  CHECK (trigger IN ('manual', 'schedule', 'post_task_event')),
  CHECK (status IN ('started', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS project_manager_runs_repository_time_idx
  ON project_manager_runs(repository_name, started_at DESC, id);

CREATE TABLE IF NOT EXISTS project_goals (
  id text PRIMARY KEY,
  source_analysis_id text NOT NULL
    CONSTRAINT project_goals_source_analysis_id_fkey
    REFERENCES project_analyses(id) ON DELETE CASCADE,
  source_run_id text,
  repository_name text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  problem_statement text NOT NULL,
  desired_outcome text NOT NULL,
  success_metrics text[] NOT NULL DEFAULT '{}',
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority text NOT NULL,
  risk_level text NOT NULL,
  suggested_task_proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_signature text NOT NULL,
  approved_by jsonb,
  approved_at timestamptz,
  activated_by jsonb,
  activated_at timestamptz,
  completed_by jsonb,
  completed_at timestamptz,
  rejected_by jsonb,
  rejected_at timestamptz,
  rejection_reason text,
  stale_by jsonb,
  stale_at timestamptz,
  stale_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT project_goals_source_run_id_fkey
    FOREIGN KEY (source_run_id) REFERENCES project_manager_runs(id) ON DELETE SET NULL,
  CHECK (status IN (
    'proposed',
    'approved',
    'active',
    'completed',
    'rejected',
    'stale'
  )),
  CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  CHECK (risk_level IN ('low', 'medium', 'high'))
);

CREATE INDEX IF NOT EXISTS project_goals_repository_status_idx
  ON project_goals(repository_name, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS project_goals_duplicate_signature_idx
  ON project_goals(repository_name, duplicate_signature);

CREATE UNIQUE INDEX IF NOT EXISTS project_goals_active_duplicate_signature_unique_idx
  ON project_goals(repository_name, duplicate_signature)
  WHERE status NOT IN ('completed', 'rejected', 'stale');

CREATE TABLE IF NOT EXISTS project_goal_events (
  id text PRIMARY KEY,
  goal_id text NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor jsonb,
  message text,
  payload jsonb,
  created_at timestamptz NOT NULL,
  CHECK (kind IN (
    'project_goal_created',
    'project_goal_approved',
    'project_goal_activated',
    'project_goal_completed',
    'project_goal_rejected',
    'project_goal_stale'
  ))
);

CREATE INDEX IF NOT EXISTS project_goal_events_goal_time_idx
  ON project_goal_events(goal_id, created_at, id);

CREATE TABLE IF NOT EXISTS project_goal_tasks (
  id text PRIMARY KEY,
  goal_id text NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
  task_id text NOT NULL
    CONSTRAINT project_goal_tasks_task_id_fkey
    REFERENCES tasks(id) ON DELETE CASCADE,
  link_type text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (goal_id, task_id, link_type)
);

CREATE INDEX IF NOT EXISTS project_goal_tasks_goal_idx
  ON project_goal_tasks(goal_id, created_at, id);

CREATE INDEX IF NOT EXISTS project_goal_tasks_task_idx
  ON project_goal_tasks(task_id, created_at, id);
