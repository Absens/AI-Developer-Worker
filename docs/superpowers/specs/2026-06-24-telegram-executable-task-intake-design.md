# Telegram Executable Task Intake Design

## Goal

Сделать Telegram Assistant полноценным intake/control layer: пользователь
общается с ботом обычным языком, бот доводит запрос до executable task draft,
получает нужные подтверждения, ставит задачу в internal tracker execution queue,
а затем сообщает в Telegram о ходе работы, MR readiness и финальном acceptance.

## Current State

Сейчас Telegram Assistant уже умеет распознавать `create_task_draft`, создавать
pending action и после подтверждения вызывать `TaskTrackerClient.createTask`.
Этого достаточно для создания internal task, но недостаточно для выполнения:
текущий Telegram create path не передает `repoPathKey`, `baseBranch`, `queue` и
не переводит task в `ready`. `InternalWorkerOrchestrator` подбирает только
claimable tasks со статусом `ready` или `claimed`, подходящим repository profile
и заполненными execution fields.

Digital Twin сейчас является conversational/session path для Telegram
Business/Secretary chats. Он не должен напрямую создавать executable tasks:
ему нужен отдельный owner-approved proposal/action boundary.

## Product Decisions

- Policy mode: hybrid.
- Trusted private users могут запускать low/medium-risk задачи после своего
  подтверждения.
- External Business/TWIN contacts не получают прямой запуск; их предложения
  отправляются owner/admin на подтверждение.
- Repository profile выбирается автоматически только когда это безопасно и
  однозначно; при неоднозначности бот спрашивает выбор.
- Бот уточняет задачу до executable draft перед финальным подтверждением.
- Auto execution controlled by risk gate.
- High-risk tasks можно запустить из Telegram только после owner/admin approval.
- Execution notifications are two-level: MR ready first, done/accepted later.
- `AI_QUESTION` во время выполнения возвращается в Telegram. Для TWIN/business
  clarification loop гибридный: продуктовые вопросы можно вернуть внешнему
  контакту, технические и рискованные вопросы идут owner/admin.

## User Flow

### Trusted Private User

1. Пользователь пишет боту обычным языком: "сделай X", "почини Y",
   "добавь Z".
2. Бот распознает `create_task_draft`, но не создает задачу сразу.
3. Бот строит executable draft:
   - title;
   - description;
   - acceptance criteria;
   - repository profile: `repositoryName`, `repoPathKey`, `baseBranch`, `queue`;
   - risk level;
   - execution decision.
4. Если данных недостаточно, бот задает 1-3 коротких уточняющих вопроса.
5. Если repository profile определяется однозначно, бот подставляет его сам.
   Если вариантов несколько, бот показывает выбор.
6. Бот показывает финальное резюме:
   - что будет сделано;
   - где будет сделано;
   - acceptance criteria;
   - risk level;
   - пойдет ли task сразу в выполнение.
7. Пользователь подтверждает "Создать и запустить" или отменяет действие.
8. Бот создает internal task со всеми execution fields.
9. Если policy разрешает execution, task переводится в `ready`.
10. Worker подбирает задачу обычным `InternalWorkerOrchestrator.claimTask`.
11. Бот отправляет lifecycle updates в Telegram.

### Business/TWIN Contact

1. Внешний контакт пишет в Telegram Business/Secretary chat.
2. Digital Twin может распознать потенциальную задачу и сформировать proposal.
3. Owner/admin получает private approval card с draft, repository profile, risk
   summary и execution decision.
4. После owner/admin approval используется тот же executable intake path.
5. Внешний контакт не получает internal logs, security-sensitive diagnostics,
   MR details or execution controls.

## Architecture

Telegram остается поверх internal tracker, а не становится отдельным executor.
Execution continues through the existing internal tracker queue, leases,
lifecycle, validations, GitLab MR flow and observability.

### TelegramExecutableTaskDraft

Новая draft model хранит:

- `id`;
- `conversationKey`;
- `initiatorUserId`;
- `source`: `private`, `business`, `twin`;
- original Telegram message snapshot;
- collected task fields;
- missing fields;
- clarification history;
- selected repository profile;
- risk assessment;
- approval target;
- desired execution mode: `auto_ready`, `owner_approval`, `triage_only`;
- created/updated/expiry timestamps.

Draft state должен жить в Telegram Assistant store рядом с pending actions,
processed updates and queued messages. PostgreSQL implementation should persist
it when Telegram Assistant runs with PostgreSQL-backed state.

### Draft Builder

Текущий эвристический draft builder расширяется до staged builder:

- extracts title/description/acceptance criteria from the user's text;
- merges clarification answers into the active draft session;
- identifies missing executable fields;
- chooses the next clarification question;
- creates a final executable draft only when required fields and acceptance
  criteria are present.

The builder must be deterministic for the first implementation. Codex-assisted
drafting can be added later behind an explicit feature flag.

### Repository Profile Resolver

Resolver maps Telegram context to repository profiles from runtime config.

Rules:

- If there is exactly one execution-capable repository profile, select it.
- If message text contains a configured alias, repository name, queue key or
  repo path key, select the matching profile.
- If multiple profiles match, return `needs_selection` with options.
- If no profile matches and no default exists, block execution and ask for
  selection/configuration.

Selected profile must provide:

- `repositoryName`;
- `repoPathKey`;
- `baseBranch`;
- `queue`;
- optional tags/default quality profile metadata.

### Risk Classifier

Use deterministic risk classification first.

Low risk examples:

- documentation-only changes;
- tests-only additions;
- copy/text tweaks;
- small non-behavioral cleanup.

Medium risk examples:

- isolated bugfix;
- small UI behavior change;
- minor feature in a known repository area.

High risk triggers:

- auth/security/permissions;
- payments/billing;
- data deletion or destructive migration;
- infrastructure/deployment/CI secrets;
- broad refactor;
- unclear production behavior;
- "сделай все" or unrestricted project-wide improvement;
- requests requiring credentials or private third-party actions;
- ambiguous scope after clarification.

Risk classifier output:

- `riskLevel`: `low`, `medium`, `high`;
- `reasons`: concise strings shown in approval cards;
- `requiresOwnerApproval`: boolean.

### Execution Policy

Policy must be explicit and testable.

Rules:

- Trusted private user + clear repository profile + low/medium risk +
  confirmation -> create task and move it to `ready`.
- Trusted private user + high risk -> owner/admin approval required before
  `ready`.
- External business/TWIN source -> owner/admin approval required before task
  creation/execution.
- Ambiguous repository profile -> ask selection before final approval.
- Insufficient task details -> clarification loop before final approval.
- Failed policy gate -> create triage task only or refuse if the request is not
  allowed.

Trusted users are based on:

- `TELEGRAM_DEVELOPER_USER_IDS`;
- `TELEGRAM_OPERATOR_USER_IDS`;
- `TELEGRAM_ADMIN_USER_IDS`.

Owner/admin approval users are based on:

- `TELEGRAM_PROFILE_AUTOMATION_ALLOWED_OWNER_IDS`;
- `TELEGRAM_ADMIN_USER_IDS`.

### Task Creation and Readiness

After approval, task creation must include execution fields:

- `repositoryName`;
- `repoPathKey`;
- `baseBranch`;
- `queue`;
- `acceptanceCriteria`;
- tags such as `telegram`, `telegram_auto_intake`, `risk_low|risk_medium|risk_high`;
- external ref provider `telegram`;
- Telegram snapshot with chat/message/action ids.

Task creation should remain idempotent by Telegram external ref. Repeated
callback presses must return the already created task.

Readiness should use existing domain methods and validation, not direct storage
mutation. If task cannot be marked `ready`, the bot must report that it was
created for triage/review.

### Notification Bridge

Telegram Assistant should auto-subscribe the relevant conversation to task
events after task creation.

Notifications:

- created/queued: task created and moved to `ready`;
- claimed: worker picked up the task;
- waiting for answer: Codex returned `AI_QUESTION`;
- MR ready: implementation passed quality gates and MR is ready;
- failed: worker failed, with short redacted reason;
- done/accepted: task reached final accepted state.

The existing notification router should be reused or extended instead of adding
a separate Telegram polling mechanism for task status.

### Resume Loop

When a task enters clarification required state and has Telegram subscription:

1. Bot sends the `AI_QUESTION` to the appropriate chat.
2. Reply is associated with the task, not treated as a new free-standing intent.
3. Bot records the answer through internal task workflow.
4. Task returns to `ready` or equivalent resume-ready status.
5. Worker resumes the same Codex thread.

For TWIN/business, product clarifications can go to the external contact through
Twin when policy marks them product-safe. Technical, access, risk and execution
questions go to owner/admin.

## Digital Twin Boundary

Digital Twin can:

- infer that a conversation produced a potential task;
- create a task proposal draft;
- send owner/admin approval card;
- relay product-safe clarifications to the external contact;
- subscribe owner/admin to lifecycle updates.

Digital Twin cannot:

- directly create a task without owner/admin approval;
- move a task to `ready` without owner/admin approval;
- answer technical execution questions on behalf of owner/admin;
- expose internal logs, MR implementation details or sensitive diagnostics to
  the external contact.

This boundary keeps TWIN as a strategic conversation surface without bypassing
task execution safety.

## Error Handling and UX

The bot must distinguish these cases:

- Missing task details: ask the next short clarification question.
- Ambiguous repository profile: show selection options.
- No executable repository profile: explain that auto-execution is unavailable
  until repository profile config is added.
- Non-trusted user: route to owner/admin approval if source is allowed.
- High-risk task: show risk summary and ask owner/admin to approve execution.
- Task created but not executable: report "created for triage, not queued".
- Task queued: report "created and queued".
- Worker waiting too long: optionally report "still queued" after a configured
  threshold.
- Execution failed: report short redacted reason and task link/key.

No Telegram message should include raw logs, secrets, full command output or
unredacted diagnostics.

## Idempotency and Safety

- External refs must be stable per Telegram message/action.
- Duplicate Telegram updates must not create duplicate tasks.
- Duplicate callback presses should return the existing task.
- Clarification replies must attach to active draft session or active task
  question, not create new tasks.
- Callback confirmation must be bound to the user/owner authorized for that
  pending action.
- `TELEGRAM_TASK_CREATION_ENABLED=false` must block task creation.
- `TELEGRAM_CONFIRM_WRITE_ACTIONS=true` must require confirmation before any
  write action.

## Rollout Plan

Implement in four phases.

### Phase 1: Executable private bot intake

- Add executable draft session.
- Add repository profile resolver.
- Add deterministic risk classifier.
- Enforce task creation and confirmation config flags at runtime.
- Create internal task with execution fields.
- Move low/medium trusted tasks to `ready` after confirmation.

### Phase 2: Lifecycle notifications and resume loop

- Auto-subscribe Telegram conversation after task creation.
- Send queued/claimed/MR-ready/done/failed notifications.
- Route `AI_QUESTION` to Telegram and record answer as task resume input.

### Phase 3: Owner approval for high-risk and business

- Add owner/admin approval card for high-risk trusted tasks.
- Add owner/admin approval card for business/profile automation proposals.
- Support "create and run", "create as triage" and "cancel".

### Phase 4: Digital Twin proposal boundary

- Let Digital Twin produce owner-approved task proposals.
- Keep direct TWIN execution disabled.
- Add product-safe vs technical clarification routing.

## Test Strategy

Minimum tests:

1. Private trusted user creates executable draft, confirms it, and task gets
   `repositoryName`, `repoPathKey`, `baseBranch`, `queue` and `ready` status.
2. Ambiguous repository profile asks for selection and does not auto-ready.
3. Missing acceptance criteria starts clarification loop.
4. High-risk trusted task requires owner/admin approval before `ready`.
5. Business/TWIN proposal always requires owner/admin approval.
6. Active Digital Twin can produce proposal boundary without treating it as a
   plain answer-only turn.
7. Task event `claimed` sends Telegram notification.
8. MR-ready event sends "implementation ready" notification.
9. Done/accepted event sends final completion notification.
10. `AI_QUESTION` sends Telegram clarification and Telegram answer resumes task.
11. `TELEGRAM_TASK_CREATION_ENABLED=false` blocks task creation.
12. `TELEGRAM_CONFIRM_WRITE_ACTIONS=true` prevents write bypass.
13. Duplicate callback does not create duplicate task.
14. Unauthorized callback actor cannot approve another user's action.

Focused verification commands:

```bash
npx vitest run tests/telegramAssistant.test.ts tests/telegramProfileAutomation.test.ts tests/taskTrackerQueue.test.ts
npm run typecheck
```

Broader verification after notification/resume work:

```bash
npm test
npm run build
```

## Out of Scope

- Direct Codex execution from Telegram outside internal tracker queue.
- Letting Digital Twin directly mutate task state without owner/admin approval.
- AI-based risk classification as the first implementation.
- Exposing full internal logs or MR implementation details to external
  business/TWIN contacts.
- Replacing the human UI/API.
