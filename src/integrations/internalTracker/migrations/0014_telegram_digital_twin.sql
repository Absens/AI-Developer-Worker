-- Telegram digital twin persistence.

CREATE TABLE IF NOT EXISTS telegram_digital_twin_sessions (
  session_key text PRIMARY KEY,
  source text NOT NULL,
  chat_id bigint NOT NULL,
  business_connection_id text NOT NULL,
  owner_user_id text,
  owner_chat_id text,
  status text NOT NULL,
  status_reason text,
  codex_thread_id text,
  persona_profile_version text NOT NULL,
  summary text,
  summary_updated_at timestamptz,
  summary_needs_refresh boolean NOT NULL DEFAULT false,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (source IN ('business')),
  CHECK (status IN ('active', 'paused', 'reset_requested', 'disabled_by_connection', 'failed'))
);

CREATE INDEX IF NOT EXISTS telegram_digital_twin_sessions_business_chat_idx
  ON telegram_digital_twin_sessions(business_connection_id, chat_id);

CREATE INDEX IF NOT EXISTS telegram_digital_twin_sessions_status_idx
  ON telegram_digital_twin_sessions(status, updated_at, session_key);

CREATE INDEX IF NOT EXISTS telegram_digital_twin_sessions_thread_idx
  ON telegram_digital_twin_sessions(codex_thread_id);

CREATE TABLE IF NOT EXISTS telegram_digital_twin_messages (
  id text PRIMARY KEY,
  session_key text NOT NULL REFERENCES telegram_digital_twin_sessions(session_key) ON DELETE CASCADE,
  message_key text NOT NULL,
  telegram_update_id bigint,
  direction text NOT NULL,
  telegram_message_id bigint,
  sent_telegram_message_id bigint,
  delivery_status text NOT NULL,
  delivery_attempted_at timestamptz,
  delivered_at timestamptz,
  delivery_error text,
  redacted_text text,
  full_text_encrypted text,
  codex_thread_id text,
  codex_turn_id text,
  created_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (message_key),
  CHECK (direction IN ('inbound', 'outbound', 'system')),
  CHECK (delivery_status IN (
    'received',
    'generating',
    'generated',
    'sending',
    'sent',
    'send_failed',
    'unknown_after_send_attempt',
    'skipped',
    'duplicate'
  ))
);

CREATE INDEX IF NOT EXISTS telegram_digital_twin_messages_session_time_idx
  ON telegram_digital_twin_messages(session_key, created_at, id);

CREATE INDEX IF NOT EXISTS telegram_digital_twin_messages_delivery_idx
  ON telegram_digital_twin_messages(session_key, delivery_status, created_at, id);

CREATE INDEX IF NOT EXISTS telegram_digital_twin_messages_thread_idx
  ON telegram_digital_twin_messages(codex_thread_id);

CREATE INDEX IF NOT EXISTS telegram_digital_twin_messages_update_idx
  ON telegram_digital_twin_messages(telegram_update_id);

CREATE TABLE IF NOT EXISTS telegram_digital_twin_turns (
  id text PRIMARY KEY,
  session_key text NOT NULL REFERENCES telegram_digital_twin_sessions(session_key) ON DELETE CASCADE,
  inbound_message_key text NOT NULL,
  outbound_message_key text NOT NULL,
  status text NOT NULL,
  codex_thread_id text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_digital_twin_turns_running_unique_idx
  ON telegram_digital_twin_turns(session_key)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS telegram_digital_twin_turns_session_time_idx
  ON telegram_digital_twin_turns(session_key, started_at DESC, id);
