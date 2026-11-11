-- Only encrypted credentials are stored inside document. No secrets in audit payloads.
CREATE TABLE managed_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0,
  document jsonb NOT NULL DEFAULT '{"revision":0,"connections":[],"projects":[]}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO managed_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE managed_settings_audit (
  revision bigint PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE managed_worker_settings (
  worker_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL,
  connection_revision integer NOT NULL,
  state text NOT NULL,
  message text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (worker_id, project_id)
);
