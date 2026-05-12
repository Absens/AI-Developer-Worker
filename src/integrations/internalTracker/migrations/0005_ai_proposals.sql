-- Phase 7G AI task proposals and autonomy policy audit.

CREATE TABLE IF NOT EXISTS task_proposals (
  task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source = 'ai_proposal'),
  proposed_by text NOT NULL,
  proposal_reason text NOT NULL,
  suggested_acceptance_criteria text[] NOT NULL DEFAULT '{}',
  supervisor_status text NOT NULL CHECK (
    supervisor_status IN ('proposed', 'approved', 'rejected', 'auto_approved')
  ),
  approval_policy text NOT NULL,
  autonomy_level text NOT NULL CHECK (
    autonomy_level IN ('proposal_only', 'auto_triage', 'auto_execute_low_risk')
  ),
  duplicate_signature text NOT NULL,
  expected_blast_radius text,
  cleanup_owner text NOT NULL DEFAULT 'policy_admin',
  stale_after timestamptz,
  rejected_after timestamptz,
  approved_by jsonb,
  approved_at timestamptz,
  rejected_by jsonb,
  rejected_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS task_proposals_status_idx
  ON task_proposals(supervisor_status, created_at);

CREATE INDEX IF NOT EXISTS task_proposals_duplicate_signature_idx
  ON task_proposals(duplicate_signature);

CREATE TABLE IF NOT EXISTS task_proposal_evidence (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES task_proposals(task_id) ON DELETE CASCADE,
  kind text NOT NULL,
  ref text NOT NULL,
  summary text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS task_proposal_evidence_ref_idx
  ON task_proposal_evidence(kind, lower(ref));

CREATE TABLE IF NOT EXISTS task_proposal_duplicate_signatures (
  duplicate_signature text PRIMARY KEY,
  task_id text NOT NULL REFERENCES task_proposals(task_id) ON DELETE CASCADE,
  repository_name text NOT NULL,
  supervisor_status text NOT NULL,
  created_at timestamptz NOT NULL,
  terminal_at timestamptz
);

CREATE INDEX IF NOT EXISTS task_proposal_duplicate_repo_idx
  ON task_proposal_duplicate_signatures(repository_name, supervisor_status);

CREATE TABLE IF NOT EXISTS autonomy_policy_evaluations (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES task_proposals(task_id) ON DELETE CASCADE,
  decision text NOT NULL,
  policy text NOT NULL,
  allowed boolean NOT NULL,
  auto_approved boolean NOT NULL,
  reason text NOT NULL,
  autonomy_level text NOT NULL,
  evidence_refs jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS autonomy_policy_evaluations_task_time_idx
  ON autonomy_policy_evaluations(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS proposal_rate_limit_windows (
  repository_name text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL,
  proposal_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (repository_name, window_start, window_seconds)
);

CREATE TABLE IF NOT EXISTS proposal_cleanup_metadata (
  task_id text PRIMARY KEY REFERENCES task_proposals(task_id) ON DELETE CASCADE,
  cleanup_owner text NOT NULL DEFAULT 'policy_admin',
  stale_after timestamptz,
  rejected_after timestamptz,
  last_evaluated_at timestamptz,
  cleaned_at timestamptz
);
