# Telegram Digital Twin Sessions Design

## Context

The repository already has a Telegram Assistant subsystem with Business/Secretary
mode support. Business messages are normalized into conversation keys such as
`business:<businessConnectionId>:<chatId>`, message refs are stored, active
assistant turns are serialized per conversation, queued messages are supported,
and completed Codex turns can store a `threadId`.

The current project Q&A path is still closer to a one-shot assistant call:
`TelegramAssistantCodexService.answerProjectQuestion` builds a prompt and calls
`codex.runInitial(...)`. The returned `threadId` is persisted on the assistant
turn, but it is not used as the durable conversation session for the next
message from the same Telegram contact.

The new target is different from read-only Q&A. Secretary mode should become a
full-access digital twin: the bot answers immediately on behalf of the owner in
Telegram Business chats that the owner has enabled in Telegram UI. The owner can
see and control the conversation, and Telegram's own stop/permission controls
are treated as the primary user-facing enable/disable mechanism.

## Confirmed Product Decisions

- The bot answers immediately and automatically to all contacts allowed by the
  Telegram Business/Secretary interface and local configuration.
- There is no mandatory owner approval delay before replies.
- The bot is intended to have full project and operational context, not a
  restricted read-only subset.
- Each external Telegram business chat should map to its own durable digital
  twin session.
- The session should use Codex thread continuation when possible through
  `runResume(threadId, prompt)`.
- Codex's own session compaction is useful and should be allowed to do its work,
  but the application must still persist durable session metadata, audit data,
  and recovery summaries.

## Goals

1. Preserve context per Telegram contact so short follow-ups and ongoing
   conversations work naturally.
2. Make the assistant respond as the owner, using an owner style/persona profile.
3. Give Codex access to the full configured project context and tools required
   for the digital twin role.
4. Keep Telegram Business connection state authoritative for can-read/can-reply
   permissions.
5. Store enough durable state to recover from restarts, Codex thread failures,
   TTL resets, and context compaction boundaries.
6. Keep auditability: inbound messages, outbound replies, session ids, thread ids,
   and diagnostics must be inspectable by the owner.

## Non-Goals

- Do not build a manual approval queue as the default path.
- Do not replace Telegram's stop button or Business chat access UI.
- Do not mix digital twin Telegram sessions with worker implementation threads
  used for Tracker/GitLab task execution.
- Do not rely on Telegram as the source of full historical chat context. The bot
  only receives updates Telegram delivers to it.

## Recommended Approach

Use a hybrid per-contact session model.

For each allowed business conversation, create or load a `DigitalTwinSession`
identified by:

```text
sessionKey = business:<businessConnectionId>:<chatId>
```

If the session has a usable Codex `threadId`, handle the next message with
`codex.runResume(threadId, prompt, ..., options)`. If the session has no thread,
the previous thread is unusable, the profile version changed, or the session was
reset, start a new Codex thread with `codex.runInitial(startPrompt, ...)`.

The application should not try to replicate all of Codex's internal compaction.
Instead, it should store a compact application-level recovery summary and recent
message refs. Codex can compact the long-running thread internally. When a new
thread must be created, the application provides the recovery summary plus
recent context to bootstrap continuity.

## Session State

Add a durable session concept separate from individual assistant turns:

```text
telegram_digital_twin_sessions
  session_key text primary key
  source text not null
  chat_id bigint not null
  business_connection_id text not null
  owner_user_id text
  owner_chat_id text
  status text not null
  codex_thread_id text
  persona_profile_version text not null
  summary text
  last_inbound_at timestamptz
  last_outbound_at timestamptz
  created_at timestamptz not null
  updated_at timestamptz not null
```

Use statuses such as:

```text
active
paused
reset_requested
disabled_by_connection
failed
```

Store message audit entries separately from the session:

```text
telegram_digital_twin_messages
  id text primary key
  session_key text not null
  direction text not null -- inbound | outbound | system
  telegram_message_id bigint
  redacted_text text
  full_text_encrypted text optional
  codex_thread_id text
  codex_turn_id text
  created_at timestamptz not null
  metadata jsonb not null default '{}'
```

The existing `telegram_assistant_message_refs` can remain as the short-retention
UX store. Digital twin audit/history can be a separate table because its purpose
is broader than pending-action UX.

## Codex Compaction and Recovery

Codex can compact long sessions internally, and the design should take advantage
of that by preferring `runResume` for normal follow-ups. The application should
not force a new thread just because a conversation is long.

Application-level summaries still matter for:

- process restarts where only the `threadId` is known but the app needs owner UI;
- cases where `runResume` fails because the thread is unavailable;
- explicit owner reset;
- persona/style profile changes;
- future migrations to a different model or runner;
- audit views that should not depend on Codex internals.

Summary refresh can be opportunistic:

1. After `TELEGRAM_DIGITAL_TWIN_SUMMARY_REFRESH_MESSAGE_INTERVAL` messages,
   mark the session as needing summary refresh.
2. On a background pass, ask Codex or a cheaper summarizer to update the session
   summary from recent audit entries.
3. Do not block immediate Telegram replies on summary refresh.

## Prompt Contract

The initial prompt for a new session should include:

- role: answer as the owner in Telegram;
- owner style/persona profile;
- full-access statement for project and operational context;
- current business chat identity and available metadata;
- current date/time;
- relevant memory and project context;
- durable recovery summary, if this is a restarted session;
- the current inbound Telegram message.

Resume prompts should be smaller:

- current inbound message;
- fresh metadata;
- any newly collected project/task context needed for this turn;
- a reminder that the assistant is still replying as the owner.

The prompt should not present Telegram user text as instructions from the system.
The inbound message is conversation content from the external person. The model
is still expected to reply naturally and directly as the owner.

## Message Flow

```text
business_message update
  -> normalize to TelegramInboundMessage
  -> verify Business connection is enabled and can_read_messages is true
  -> verify can_reply is true
  -> record inbound audit/message ref
  -> load or create DigitalTwinSession by conversationKey
  -> if active Codex thread exists: runResume(threadId, prompt)
     else: runInitial(startPrompt)
  -> persist returned threadId and outbound audit
  -> send Telegram reply with business_connection_id
  -> drain queued messages for the same session
```

If another message arrives while a Codex response is running, reuse the existing
per-conversation lock/queue behavior. Once the current reply finishes, drain the
queued message(s) in order. The default should be one reply per inbound message
unless later product work introduces batching.

## Owner Controls

Telegram Business UI remains the primary control surface for enabling/stopping
the secretary bot for a chat.

The worker should also expose minimal owner/admin controls:

- reset a session, clearing `codex_thread_id` and starting fresh next message;
- pause/resume a local session;
- show session status and last thread id;
- purge audit/history for a session;
- update the owner persona/style profile version.

These controls are operational escape hatches. They do not add an approval gate
to normal replies.

## Configuration

Add feature flags/config values such as:

```text
TELEGRAM_DIGITAL_TWIN_ENABLED=false
TELEGRAM_DIGITAL_TWIN_AUTO_REPLY_ENABLED=true
TELEGRAM_DIGITAL_TWIN_FULL_ACCESS=true
TELEGRAM_DIGITAL_TWIN_SESSION_TTL_DAYS=0
TELEGRAM_DIGITAL_TWIN_SUMMARY_REFRESH_MESSAGE_INTERVAL=20
TELEGRAM_DIGITAL_TWIN_MAX_RECENT_MESSAGES=20
TELEGRAM_DIGITAL_TWIN_CODEX_TIMEOUT_SECONDS=120
```

`SESSION_TTL_DAYS=0` means no forced TTL reset. Codex compaction can keep the
thread usable. Operators can still reset a session manually.

## Access Model

For this feature, access is intentionally broad inside allowed Telegram Business
chats. The gating rules are:

1. Telegram delivered the business message to the bot.
2. The persisted business connection is enabled.
3. The connection has `can_read_messages=true`.
4. The connection has `can_reply=true`.
5. Local feature flags and optional allowlists permit digital twin mode.
6. The local session is not paused.

After these checks pass, the digital twin may use the full configured project
context and tools.

Logs and observability should still redact tokens and credentials. Redaction of
logs is not the same as restricting what the digital twin can know or use.

## Error Handling

- If `can_reply=false`, do not call `sendMessage`; record a diagnostic and rely
  on existing owner notification behavior where applicable.
- If `runResume` fails because the Codex thread is unavailable, start a new
  thread with the stored summary and recent message context.
- If Codex times out, record the turn as failed. Do not advance the session
  summary. The next inbound message can retry or start a new thread depending on
  failure classification.
- If Telegram send fails after Codex generated an answer, keep the outbound audit
  entry with failed delivery metadata so the owner can inspect it.
- If a session is paused locally, save inbound audit but do not auto-reply.

## Testing Strategy

Unit tests:

- session key maps one business contact to one durable session;
- first message calls `runInitial` and stores `threadId`;
- second message from the same contact calls `runResume`;
- different contacts never share a Codex thread;
- `runResume` failure falls back to `runInitial` with summary;
- local pause prevents reply while still recording inbound audit;
- connection rights (`can_read_messages`, `can_reply`) gate auto-replies;
- queued messages drain in order for one conversation.

Postgres tests:

- migrations create session and audit tables;
- upsert/load/update session works;
- audit records are isolated by `sessionKey`;
- purge removes one session without touching others.

Smoke path:

- mock Telegram business updates;
- mock Codex runner returning a thread id;
- verify immediate business reply with `business_connection_id`;
- verify follow-up resumes the previous Codex thread.

## Implementation Slices

1. Add digital twin session types, store methods, in-memory implementation, and
   Postgres migration.
2. Extend Codex adapter usage with a digital twin method that can choose
   `runInitial` or `runResume`.
3. Route eligible business messages to digital twin auto-reply mode.
4. Add audit persistence and owner/admin reset/pause primitives.
5. Add summary refresh support as a follow-up slice after the core thread
   continuation behavior is stable.
