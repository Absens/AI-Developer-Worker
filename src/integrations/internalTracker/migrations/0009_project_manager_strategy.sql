ALTER TABLE project_manager_runs
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'analysis';

ALTER TABLE project_analyses
  ADD COLUMN IF NOT EXISTS analysis_kind text NOT NULL DEFAULT 'analysis',
  ADD COLUMN IF NOT EXISTS strategy_analysis_lenses jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_opportunities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_goal_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_brief text NULL;

UPDATE project_analyses
SET analysis_kind = 'replan'
WHERE analysis_kind = 'analysis'
  AND (
    replan_reason IS NOT NULL
    OR jsonb_array_length(goal_replans) > 0
  );

UPDATE project_manager_runs
SET mode = 'replan'
WHERE mode = 'analysis'
  AND analysis_id IN (
    SELECT id
    FROM project_analyses
    WHERE analysis_kind = 'replan'
  );

ALTER TABLE project_manager_runs
  DROP CONSTRAINT IF EXISTS project_manager_runs_mode_check,
  ADD CONSTRAINT project_manager_runs_mode_check
  CHECK (mode IN ('analysis', 'replan', 'strategy'));

ALTER TABLE project_analyses
  DROP CONSTRAINT IF EXISTS project_analyses_analysis_kind_check,
  ADD CONSTRAINT project_analyses_analysis_kind_check
  CHECK (analysis_kind IN ('analysis', 'replan', 'strategy'));
