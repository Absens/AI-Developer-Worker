-- Telegram assistant persistence.

CREATE TABLE IF NOT EXISTS telegram_assistant_offsets (
  scope text PRIMARY KEY,
  offset_value bigint NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_assistant_processed_updates (
  update_id bigint PRIMARY KEY,
  processed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_assistant_pending_actions (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  chat_id bigint NOT NULL,
  user_id bigint NOT NULL,
  intent jsonb NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  completed_at timestamptz,
  CHECK (status IN (
    'pending',
    'executing',
    'completed',
    'cancelled',
    'expired'
  ))
);

CREATE INDEX IF NOT EXISTS telegram_assistant_pending_actions_conversation_status_idx
  ON telegram_assistant_pending_actions(conversation_key, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_assistant_pending_actions_expiry_idx
  ON telegram_assistant_pending_actions(expires_at, status);

CREATE TABLE IF NOT EXISTS telegram_assistant_message_refs (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  source text NOT NULL,
  redacted_text text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (source IN ('user', 'assistant', 'system'))
);

CREATE INDEX IF NOT EXISTS telegram_assistant_message_refs_conversation_idx
  ON telegram_assistant_message_refs(conversation_key, created_at, id);

CREATE INDEX IF NOT EXISTS telegram_assistant_message_refs_expiry_idx
  ON telegram_assistant_message_refs(expires_at);

CREATE TABLE IF NOT EXISTS telegram_assistant_turns (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  input jsonb,
  thread_id text,
  completed_at timestamptz,
  diagnostic text,
  CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS telegram_assistant_turns_conversation_status_idx
  ON telegram_assistant_turns(conversation_key, status, started_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_assistant_turns_active_unique_idx
  ON telegram_assistant_turns(conversation_key)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS telegram_assistant_queued_messages (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  chat_id bigint NOT NULL,
  user_id bigint,
  message jsonb NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  CHECK (status IN ('queued', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS telegram_assistant_queued_messages_conversation_status_idx
  ON telegram_assistant_queued_messages(conversation_key, status, created_at, id);

CREATE INDEX IF NOT EXISTS telegram_assistant_queued_messages_expiry_idx
  ON telegram_assistant_queued_messages(expires_at);

CREATE TABLE IF NOT EXISTS telegram_assistant_subscriptions (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  conversation_key text NOT NULL,
  chat_id bigint NOT NULL,
  user_id bigint,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_notified_event_id text
);

CREATE INDEX IF NOT EXISTS telegram_assistant_subscriptions_conversation_idx
  ON telegram_assistant_subscriptions(conversation_key, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_assistant_subscriptions_task_idx
  ON telegram_assistant_subscriptions(task_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS telegram_assistant_sent_notifications (
  subscription_id text NOT NULL,
  event_id text NOT NULL,
  id text NOT NULL,
  status text NOT NULL,
  reserved_at timestamptz NOT NULL,
  stale_after timestamptz NOT NULL,
  completed_at timestamptz,
  error_message text,
  PRIMARY KEY (subscription_id, event_id),
  UNIQUE (id),
  CHECK (status IN ('sending', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS telegram_assistant_sent_notifications_status_idx
  ON telegram_assistant_sent_notifications(status, stale_after, reserved_at);

CREATE INDEX IF NOT EXISTS telegram_assistant_sent_notifications_subscription_idx
  ON telegram_assistant_sent_notifications(subscription_id, reserved_at DESC, event_id);

CREATE TABLE IF NOT EXISTS telegram_profile_automation_connections (
  id text PRIMARY KEY,
  user_id bigint NOT NULL,
  user_chat_id bigint NOT NULL,
  can_reply boolean NOT NULL,
  is_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_profile_automation_connections_user_idx
  ON telegram_profile_automation_connections(user_id, updated_at DESC, id);
