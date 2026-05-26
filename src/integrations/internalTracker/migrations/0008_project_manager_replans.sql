ALTER TABLE project_analyses
  ADD COLUMN IF NOT EXISTS previous_analysis_id text NULL,
  ADD COLUMN IF NOT EXISTS goal_replans jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS project_analyses_previous_analysis_idx
  ON project_analyses(previous_analysis_id)
  WHERE previous_analysis_id IS NOT NULL;
