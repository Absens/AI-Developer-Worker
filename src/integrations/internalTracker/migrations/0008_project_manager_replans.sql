ALTER TABLE project_analyses
  ADD COLUMN IF NOT EXISTS previous_analysis_id text NULL,
  ADD COLUMN IF NOT EXISTS goal_replans jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS project_analyses_previous_analysis_idx
  ON project_analyses(previous_analysis_id)
  WHERE previous_analysis_id IS NOT NULL;

ALTER TABLE project_goal_events
  DROP CONSTRAINT IF EXISTS project_goal_events_kind_check,
  ADD CONSTRAINT project_goal_events_kind_check
  CHECK (kind IN (
    'project_goal_created',
    'project_goal_approved',
    'project_goal_activated',
    'project_goal_completed',
    'project_goal_rejected',
    'project_goal_stale',
    'project_goal_replan_classified'
  ));
