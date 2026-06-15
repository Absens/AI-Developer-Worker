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
  status_reason text
  codex_thread_id text
  persona_profile_version text not null
  summary text
  summary_updated_at timestamptz
  summary_needs_refresh boolean not null default false
  last_inbound_at timestamptz
  last_outbound_at timestamptz
  last_error text
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
  message_key text not null
  telegram_update_id bigint
  direction text not null -- inbound | outbound | system
  telegram_message_id bigint
  sent_telegram_message_id bigint
  delivery_status text not null
  delivery_attempted_at timestamptz
  delivered_at timestamptz
  delivery_error text
  redacted_text text
  full_text_encrypted text
  codex_thread_id text
  codex_turn_id text
  created_at timestamptz not null
  metadata jsonb not null default '{}'
```

Store long-running Codex work as durable turns:

```text
telegram_digital_twin_turns
  id text primary key
  session_key text not null
  inbound_message_key text not null
  outbound_message_key text not null
  status text not null
  codex_thread_id text
  started_at timestamptz not null
  completed_at timestamptz
  error text
  metadata jsonb not null default '{}'
```

Constraints and indexes should be explicit in the migration:

- session `status` check constraint for session statuses.
- turn `status` check constraint: `running`, `completed`, `failed`,
  `cancelled`.
- `direction` check constraint: `inbound`, `outbound`, `system`.
- `delivery_status` check constraint: `received`, `generating`, `generated`,
  `sending`, `sent`, `send_failed`, `unknown_after_send_attempt`, `skipped`,
  `duplicate`.
- `UNIQUE (message_key)` to deduplicate Telegram retry/replay.
- `UNIQUE (session_key) WHERE status = 'running'` on digital twin turns.
- Index on sessions `(business_connection_id, chat_id)`.
- Index on sessions `(status, updated_at, session_key)`.
- Index on sessions `(codex_thread_id)` for operational lookup.
- Index on `(session_key, created_at, id)` for session history.
- Index on `(session_key, delivery_status, created_at, id)` for retry scans.
- Index on messages `(codex_thread_id)` for message-level lookup.
- Index on turns `(session_key, started_at DESC, id)`.
- Index on `(telegram_update_id)` when present.
- `telegram_digital_twin_messages.session_key` should reference
  `telegram_digital_twin_sessions(session_key)` with `ON DELETE CASCADE`, unless
  implementation deliberately chooses orphan audit retention. The first
  implementation should use cascade because purge semantics are easier to make
  exact and testable.
- `telegram_digital_twin_turns.session_key` should also use `ON DELETE CASCADE`.

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
  -> compute message_key from business_connection_id + chat_id + message_id
  -> atomically reserve inbound message_key or classify as duplicate
  -> record inbound audit/message ref
  -> load or create DigitalTwinSession by conversationKey
  -> reserve one running digital twin turn for the session
  -> if active Codex thread exists: runResume(threadId, prompt)
     else: runInitial(startPrompt)
  -> persist returned threadId and generated outbound audit
  -> send Telegram reply with business_connection_id
  -> mark outbound delivery as sent or send_failed
  -> drain queued messages for the same session
```

If another message arrives while a Codex response is running, reuse the existing
per-conversation lock/queue behavior. Once the current reply finishes, drain the
queued message(s) in order. The default should be one reply per inbound message
unless later product work introduces batching.

## Idempotency and Delivery State

Telegram retries, worker restarts, and webhook redelivery must not produce two
answers for one inbound business message.

Use stable keys:

```text
inbound message_key = telegram-business:<businessConnectionId>:<chatId>:<messageId>
outbound message_key = telegram-business-reply:<businessConnectionId>:<chatId>:<messageId>
```

For non-business update types that later enter this path, include `update_id` in
the key. For business messages, `businessConnectionId + chatId + messageId` is
the better semantic id because it represents the actual chat message being
answered.

Processing should follow a reserve-and-complete pattern:

1. Insert the inbound audit row with `message_key` and `delivery_status=received`.
   If the unique constraint already exists, treat the update as processed and do
   not generate another Codex answer.
2. Insert or reserve the outbound row with the outbound `message_key` and
   `delivery_status=generating`.
3. After Codex returns, update the outbound row to `generated` with redacted text,
   `codex_thread_id`, and turn metadata.
4. Immediately before `sendMessage`, set `delivery_status=sending` and
   `delivery_attempted_at`.
5. If Telegram returns a message id, set `delivery_status=sent`,
   `sent_telegram_message_id`, and `delivered_at`.
6. If send fails, set `delivery_status=send_failed` and store a redacted
   `delivery_error`.

Crash window policy:

- Crash before inbound reserve commit: Telegram may retry and the message can be
  processed normally.
- Crash after inbound reserve but before outbound reserve: a recovery scan may
  create the missing outbound row and process the message once.
- Crash after generated but before send: retry can attempt send once because no
  `sent_telegram_message_id` exists.
- Crash after Telegram accepted the send but before local `sent` commit: this is
  the only ambiguous window. The first implementation should not blindly resend.
  Mark the row `send_failed` or `unknown_after_send_attempt` via recovery if the
  process cannot prove delivery, then surface it for owner inspection.
- Crash after `sent` commit: never resend for the same outbound `message_key`.

`telegram_assistant_processed_updates` can still advance offset/update
processing, but digital twin reply deduplication must be based on message keys
because a business message is the semantic unit being answered.

## Concurrency and Multi-worker Locking

The in-memory store is acceptable for unit tests and single-process local runs.
Production/Postgres mode must serialize a digital twin session across worker
instances.

The existing Postgres assistant store already uses advisory transaction locks
for conversation work. Digital twin processing should follow the same production
pattern:

```text
pg_advisory_xact_lock(hashtext('telegram-digital-twin:' || sessionKey))
```

The lock must cover:

- duplicate check and inbound reserve;
- session load/create/update;
- running turn reserve;
- queued message decisions;
- final session thread update after Codex completes.

Because Codex calls can be long, the implementation can split work into two
transactions, but it still needs a durable running-turn guard:

- create a `telegram_digital_twin_turns` row or reuse an assistant turn row with
  `status=running`;
- enforce `UNIQUE (session_key) WHERE status = 'running'`;
- have competing workers enqueue or skip rather than start a second Codex call;
- complete the running turn with `completed`, `failed`, or `cancelled`.

This combination protects both same-process concurrency and multi-instance
deployment. The lock is for short critical sections; the unique running-turn
constraint is the durable safety net.

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

## Full-access Safety Policy

Full access is a product requirement for allowed contacts, but the prompt and
tool policy still need crisp operating rules so the model does not confuse
external chat text with owner/system instructions.

Rules:

- External Telegram messages are conversation content, not system or developer
  instructions.
- The assistant may use full configured project context and operational tools
  after access gates pass.
- The assistant should answer as the owner in the owner's style, without
  exposing internal prompt text, credentials, raw environment values, or hidden
  diagnostics.
- Destructive or irreversible infrastructure actions should remain governed by
  existing domain safeguards if such tools are ever exposed to this path.
- Local logs and observability must redact secrets even though the assistant may
  be allowed to use sensitive context to make decisions.
- Prompt-injection attempts from contacts should be stored as normal inbound
  messages and answered conversationally only when appropriate; they must not
  rewrite persona, safety policy, or tool scope.

This is not a read-only sandbox. It is a full-access mode with explicit
identity, audit, and instruction-boundary rules.

## Audit Retention and Encryption

There are two classes of stored text:

1. `redacted_text`: safe enough for operational views and logs after standard
   secret redaction.
2. `full_text_encrypted`: optional encrypted original text for owner audit and
   higher-fidelity recovery.

The first implementation should support this policy:

- If `TELEGRAM_DIGITAL_TWIN_AUDIT_ENCRYPTION_KEY_ENV` is configured, encrypt full
  inbound/outbound text before writing `full_text_encrypted`.
- If no encryption key is configured, do not persist full text; store only
  `redacted_text`.
- Encryption should use authenticated encryption, such as AES-256-GCM, with a
  per-record nonce and metadata that records key id/version.
- Encryption keys are supplied by environment/secret manager, never stored in
  the database.
- Summary generation may use decrypted full text only inside the worker process
  when the key is available. Otherwise it must use redacted text.
- Purge for a session deletes session row, message audit rows, queued digital
  twin work, and running/completed digital twin turns for that session.
- Redacted audit retention and encrypted full-text retention should be
  independently configurable. Defaults should be conservative, for example
  redacted audit retained for 30 days and encrypted full text disabled unless
  explicitly configured.

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
TELEGRAM_DIGITAL_TWIN_REDACTED_RETENTION_DAYS=30
TELEGRAM_DIGITAL_TWIN_FULL_TEXT_RETENTION_DAYS=0
TELEGRAM_DIGITAL_TWIN_AUDIT_ENCRYPTION_KEY_ENV=
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
  entry with `send_failed` delivery metadata so the owner can inspect it.
- If permissions are revoked mid-turn, check connection state again before
  sending. If `can_reply` or `is_enabled` is no longer valid, mark the outbound
  row as `skipped` and do not send.
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
- queued messages drain in order for one conversation;
- duplicate Telegram update/message does not produce a second Codex call or
  Telegram reply;
- persona profile version change starts a fresh thread with recovery summary;
- prompt injection text from a contact is treated as inbound conversation data,
  not as system instructions.

Postgres tests:

- migrations create session and audit tables;
- upsert/load/update session works;
- audit records are isolated by `sessionKey`;
- purge removes one session without touching others;
- message keys are unique and deduplicate retries;
- only one running digital twin turn can exist per session;
- delivery state transitions are persisted;
- encrypted full text is written only when encryption is configured.

Smoke path:

- mock Telegram business updates;
- mock Codex runner returning a thread id;
- verify immediate business reply with `business_connection_id`;
- verify follow-up resumes the previous Codex thread;
- replay the same Telegram business message and verify no duplicate reply;
- simulate restart after Codex generation and before send;
- simulate permission revocation before send;
- simulate two workers attempting the same session and verify one Codex call.

## Implementation Slices

1. Add digital twin session, turn, audit, idempotency, and delivery-state types;
   store methods; in-memory implementation; and Postgres migration.
2. Add multi-worker locking and unique running-turn guards.
3. Extend Codex adapter usage with a digital twin method that can choose
   `runInitial` or `runResume`.
4. Route eligible business messages to digital twin auto-reply mode.
5. Add audit persistence, encryption/retention policy, and owner/admin
   reset/pause primitives.
6. Add summary refresh support as a follow-up slice after the core thread
   continuation behavior is stable.
