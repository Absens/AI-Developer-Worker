-- Telegram executable task intake persistence.

CREATE TABLE IF NOT EXISTS telegram_executable_task_draft_sessions (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  source text NOT NULL,
  initiator_user_id bigint,
  owner_user_id bigint,
  owner_chat_id bigint,
  chat_id bigint NOT NULL,
  message_id bigint,
  original_text text NOT NULL,
  draft jsonb NOT NULL,
  status text NOT NULL,
  clarification_question jsonb,
  clarification_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (source IN ('private', 'business', 'twin')),
  CHECK (status IN ('collecting', 'awaiting_user_confirmation', 'awaiting_owner_approval', 'completed', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS telegram_executable_task_draft_sessions_active_idx
  ON telegram_executable_task_draft_sessions(conversation_key, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_executable_task_draft_sessions_expiry_idx
  ON telegram_executable_task_draft_sessions(expires_at, status);

CREATE TABLE IF NOT EXISTS telegram_active_task_question_prompts (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  chat_id bigint NOT NULL,
  user_id bigint,
  task_id text NOT NULL,
  question_id text NOT NULL,
  prompt_message_id bigint,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (status IN ('open', 'answered', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS telegram_active_task_question_prompts_conversation_idx
  ON telegram_active_task_question_prompts(conversation_key, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_active_task_question_prompts_task_idx
  ON telegram_active_task_question_prompts(task_id, question_id, status);
