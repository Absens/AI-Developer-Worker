# Telegram task intake, queue execution and Digital Twin

Этот документ фиксирует рабочий сценарий: пользователь пишет Telegram-боту,
бот собирает draft задачи, получает подтверждение, создает internal task,
переводит ее в `ready` при разрешенной policy, а дальше задачу подбирает
обычный `InternalWorkerOrchestrator`.

Executable Telegram intake implemented for trusted private users and
owner-approved Business/TWIN proposals. A confirmed low/medium-risk trusted
private task can be created with `repositoryName`, `repoPathKey`, `baseBranch`
and `queue`, then moved to `ready` for `InternalWorkerOrchestrator` claim.
High-risk and external Business/TWIN requests require owner/admin approval.

## Краткий статус

| Сценарий | Сейчас | Условие |
| --- | --- | --- |
| Private Telegram bot -> confirmation -> execution queue | Да | User has write role, task creation is enabled, repository profile resolved, risk is low/medium. |
| Private Telegram bot -> high-risk task -> owner/admin approval -> execution queue | Да | Risk classifier selects `owner_approval`; configured owner/admin confirms in private chat. |
| Telegram Business/Profile automation -> owner approval -> execution queue | Да | Business policy passes, repository profile is resolved, owner confirms the executable draft. |
| Digital Twin Business chat -> explicit task request -> owner approval | Да | `create_task_draft` intent is routed before conversational Digital Twin auto-reply. |
| Digital Twin conversational reply | Да | Non-task Business messages still use durable per-contact Codex sessions when enabled and allowed. |
| Telegram reply to AI question -> resume task | Да | Subscribed task is `awaiting_human`; reply is recorded directly or through confirmation policy. |

## Private bot path

`src/domain/telegramAssistant/intentRouter.ts` recognizes phrases such as
`создай задачу`, `надо сделать`, `починить`, `добавить` as
`create_task_draft`. `TelegramAssistantService` then:

1. Checks assistant access, write role, `TELEGRAM_TASK_CREATION_ENABLED`,
   daily task creation limits and message identity.
2. Resolves a repository profile from `TELEGRAM_DEFAULT_REPOSITORY`, repository
   name, queue or tag text. If multiple profiles match, the bot asks for
   repository/queue clarification.
3. Builds an executable draft with `repositoryName`, `repoPathKey`,
   `baseBranch`, `queue`, acceptance criteria, tags and risk factors.
4. Shows an inline confirmation card. Text confirmations such as `да`, `ок`,
   `создай`, `подтверждаю` are also accepted.
5. Creates the task through internal `TaskTrackerClient`, subscribes the chat to
   lifecycle notifications and marks the task `ready` when execution mode allows
   it.

The assistant does not call the human TaskTracker HTTP API. Runtime writes go
through the internal `TaskTrackerClient`, so executable task creation requires
`TASK_TRACKER_PROVIDER=internal`.

## Execution fields and queue claim

Telegram-created executable tasks include:

- `repositoryName`;
- `repoPathKey`;
- `baseBranch`;
- `queue`;
- `tags`, including `telegram` and risk tags;
- acceptance criteria;
- external Telegram snapshot and external ref.

`repoPathKey` currently uses the repository profile `name`. This matches the
existing claim profile semantics while keeping future room for an explicit
Telegram-specific repo path key.

The worker still executes through the existing internal tracker queue. There is
no Telegram-native executor. After task creation, the service calls
`markReady()` for `auto_ready` and owner-approved executable drafts. Claiming is
then performed by `InternalWorkerOrchestrator.claimTask()` with the configured
repository profiles.

## Risk and approval policy

Risk is deterministic and conservative:

- docs, tests and copy-only work are low risk;
- isolated bugfixes/features are medium risk;
- auth/security, payment/billing, destructive data changes, infra/deploy and
  broad ambiguous work are high risk.

Low/medium trusted private tasks can enter the queue after user confirmation.
High-risk private tasks are routed to the first configured owner/admin private
chat. The requester receives a message that the task was sent for owner/admin
approval. The owner/admin confirms the same `create_task_draft` payload, after
which the task is created and marked `ready`.

If no owner/admin Telegram id is configured, high-risk approval is cancelled
instead of silently starting execution.

## Business/Profile automation path

Telegram Business/Secretary messages are controlled by
`TELEGRAM_PROFILE_AUTOMATION_*`. The service checks business connection state,
owner allowlist, chat allowlist, message age and Telegram rights before taking
action.

When a Business message is recognized as `create_task_draft` and
`TELEGRAM_PROFILE_AUTOMATION_REQUIRE_OWNER_APPROVAL=true`, the service builds an
executable draft and sends it to the owner private chat. The external Business
sender does not get a task-created reply from the bot. Owner confirmation creates
the task and marks it `ready`.

The owner approval pending action is idempotent. Repeated Business delivery does
not resurrect completed approval actions or create duplicate tasks; external
refs use the original Telegram message key.

## Digital Twin path

`TELEGRAM_DIGITAL_TWIN_*` remains a strategic Telegram Assistant submode for
Telegram Business/Secretary chats. It maintains durable per-contact Codex
sessions, delivery/audit state, persona versioning and retention controls.

Explicit task requests are not sent to the conversational Digital Twin turn.
`create_task_draft` is routed before `assistantCodex.answerAsDigitalTwin`, so a
Business/TWIN task request becomes an owner-approved executable task proposal.
Non-task Business messages still use Digital Twin auto-reply when the policy,
consent and `can_reply` checks allow it.

This means Digital Twin can participate in task intake safely as an explicit
proposal boundary, but it does not get a free-form tool that directly writes or
executes tasks without owner confirmation.

## Lifecycle and resume notifications

Telegram task subscriptions receive task lifecycle notifications for execution
events such as ready/claimed state changes, merge request recorded, awaiting
human answer, failures and done/accepted transitions.

When a subscribed task enters `awaiting_human`, the notification router stores an
active Telegram question prompt. A user reply in the same conversation is then
recorded as a human answer for that exact task question. If
`TELEGRAM_CONFIRM_WRITE_ACTIONS=true`, the answer uses the existing pending
confirmation path before recording.

## Operational guardrails

- `TELEGRAM_TASK_CREATION_ENABLED=false` blocks executable draft sessions,
  pending create-task actions and direct task writes.
- `TELEGRAM_CONFIRM_WRITE_ACTIONS=true` requires confirmation before task
  creation, ready transitions and Telegram-recorded AI question answers.
- Keep write roles limited to `TELEGRAM_DEVELOPER_USER_IDS`,
  `TELEGRAM_OPERATOR_USER_IDS` and `TELEGRAM_ADMIN_USER_IDS`.
- Keep Business/Profile automation owner allowlists explicit.
- Keep Digital Twin disabled until owner consent, retention and audit encryption
  policy are documented for the deployment.

## Verification points

Relevant tests:

- `tests/telegramExecutableTaskDraft.test.ts` covers repository resolution,
  risk and executable draft readiness.
- `tests/telegramAssistant.test.ts` covers private executable intake,
  high-risk owner approval, confirmations and AI question answers.
- `tests/telegramProfileAutomation.test.ts` covers Business owner approval and
  Digital Twin task proposal routing.
- `tests/telegramNotifications.test.ts` covers lifecycle notifications and
  active task question prompts.
- `tests/taskTrackerQueue.test.ts` covers claim queue semantics.

Recommended focused verification:

```bash
npx vitest run tests/telegramExecutableTaskDraft.test.ts tests/telegramAssistant.test.ts tests/telegramProfileAutomation.test.ts tests/telegramNotifications.test.ts tests/taskTrackerQueue.test.ts
npm run typecheck
```
