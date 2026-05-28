ALTER TABLE IF EXISTS project_manager_runs
  ADD COLUMN IF NOT EXISTS mode text;

ALTER TABLE IF EXISTS project_analyses
  ADD COLUMN IF NOT EXISTS analysis_kind text;

UPDATE project_analyses
SET analysis_kind = 'replan'
WHERE (analysis_kind IS NULL OR analysis_kind = 'analysis')
  AND (
    replan_reason IS NOT NULL
    OR CASE
      WHEN jsonb_typeof(goal_replans) = 'array'
        THEN jsonb_array_length(goal_replans) > 0
      ELSE false
    END
  );

UPDATE project_analyses
SET analysis_kind = 'analysis'
WHERE analysis_kind IS NULL;

UPDATE project_manager_runs
SET mode = 'replan'
WHERE (mode IS NULL OR mode = 'analysis')
  AND analysis_id IN (
    SELECT id
    FROM project_analyses
    WHERE analysis_kind = 'replan'
  );

UPDATE project_manager_runs
SET mode = 'analysis'
WHERE mode IS NULL;

ALTER TABLE project_manager_runs
  ALTER COLUMN mode DROP DEFAULT;

ALTER TABLE project_analyses
  ALTER COLUMN analysis_kind DROP DEFAULT;

ALTER TABLE project_manager_runs
  ALTER COLUMN mode SET NOT NULL;

ALTER TABLE project_analyses
  ALTER COLUMN analysis_kind SET NOT NULL;

ALTER TABLE project_manager_runs
  DROP CONSTRAINT IF EXISTS project_manager_runs_mode_check,
  ADD CONSTRAINT project_manager_runs_mode_check
  CHECK (mode IN ('analysis', 'replan', 'strategy'));

ALTER TABLE project_analyses
  DROP CONSTRAINT IF EXISTS project_analyses_analysis_kind_check,
  ADD CONSTRAINT project_analyses_analysis_kind_check
  CHECK (analysis_kind IN ('analysis', 'replan', 'strategy'));

CREATE INDEX IF NOT EXISTS project_analyses_repository_kind_time_idx
  ON project_analyses(repository_name, analysis_kind, created_at DESC, id);
