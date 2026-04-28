# Phase 7 - AI-native Task Tracker Concept

_Актуально на 2026-04-28._

## Краткое решение

Вместо текущей Phase 7, где следующий шаг описан как универсальная multi-provider абстракция для Jira, Linear, GitHub Issues и YouTrack, предлагается сделать свой task tracker для AI-разработки. Yandex Tracker может оставаться в контуре как внешний корпоративный источник задач и канал видимости для команды, но не должен быть обязательной зависимостью. AI Developer Worker должен получить собственную систему задач, оптимизированную под одновременную работу человека, worker fleet и AI agents.

Рабочее название: **AI Task Tracker**.

Главная идея: AI Task Tracker является основной системой задач. В standalone режиме человек или внешняя система создают задачу сразу в AI Task Tracker, без Yandex. Если подключён Yandex Tracker, он работает как integration adapter: задачи импортируются или синхронизируются в AI Task Tracker, выполнение идёт внутри нашей системы, а в Yandex отправляются только важные обновления, вопросы, уведомления и итоговые статусы.

Каноническая задача всегда живёт в AI Task Tracker. Yandex issue, GitLab MR, CI run, incident id и будущие внешние системы являются `externalRefs`, а не заменой внутренней task model.

## Почему это лучше текущего Phase 7

Текущий roadmap ведёт к provider-neutral контрактам: `TaskTracker`, `CodeReviewPlatform`, `AICodeEngine`. Это снижает vendor lock-in, но не решает главный продуктовый узел: обычные issue trackers плохо подходят как runtime state store для AI.

В текущем проекте Yandex Tracker уже используется не только как список задач:

- очередь задач выбирается по queue/tag;
- логические статусы мапятся через `TRACKER_STATUS_MAP_FILE`;
- комментарии стали транспортом для `AI STATUS`, `AI QUESTION`, `AI MR`, `AI REVIEW`, `AI LEASE`, `AI ANALYSIS`, `AI DECOMPOSITION`;
- lease backend хранит task/repository locks в комментариях Tracker;
- priority queue учитывает priority, deadline, components, tags и confidence из structured comments;
- decomposition создаёт sub-issues и dependency links;
- clarification loop зависит от комментариев и явного `/resume`;
- observability отдельно пишет events, dashboard и alerts.

Это работает как MVP, но модель перегружает комментарии Tracker техническими событиями. Для AI и fleet это неудобно: состояние не атомарно, сложнее искать и восстанавливать execution context, трудно показать человеку понятную картину без шума, а будущий Phase 8 с persisted multi-step plans будет ещё сильнее упираться в отсутствие собственной task runtime модели.

Поэтому Phase 7 лучше сфокусировать не на новых внешних providers, а на собственном tracker core. После этого Jira, GitHub Issues или Linear можно подключать как внешние источники и зеркала, не делая их runtime state store.

## Цели

- Создать self-hosted tracker, который одинаково понятен человеку и удобен AI.
- Разделить бизнес-описание задачи и техническое состояние AI-исполнения.
- Перенести structured AI state из комментариев в нормальные сущности и API.
- Дать worker fleet атомарные claim/lease операции без Tracker-comment lock limitations.
- Подготовить foundation для Phase 8: persisted plans, step state machine, TDD mode, RAG и multimodal inputs.
- Оставить Yandex Tracker как optional external source/mirror без поломки текущего корпоративного процесса.

## Non-goals для MVP

- Заставлять всю организацию полностью заменить Yandex Tracker. Standalone mode нужен для отдельных проектов, команд или automation flows.
- Делать универсальный Jira/Linear/GitHub Issues clone.
- Строить SaaS/multi-tenant продукт до отдельной security-модели.
- Переносить code review из GitLab внутрь tracker.
- Делать сложную кастомизацию workflow уровня enterprise trackers.

## Принципы продукта

1. **Structured first.** Всё, что влияет на AI execution, хранится как валидируемые поля, а не как свободный текст.
2. **Human readable by default.** У каждой задачи есть короткая человеческая карточка: цель, критерии, статус, блокеры, текущий вопрос, MR и результат проверок.
3. **Append-only audit.** Все решения AI, human commands, retries, status changes и integration events пишутся в журнал.
4. **Clear ownership.** Для каждого поля понятно, кто владелец: человек, AI, worker, Yandex sync или GitLab sync.
5. **Atomic coordination.** Claim, lease, heartbeat и release должны быть транзакционными.
6. **External trackers are integrations.** Yandex Tracker и будущие Jira/GitHub Issues должны быть источниками входящих snapshots, command channels и зеркалами важных событий, а не primary task store и не местом хранения AI runtime state.
7. **Debuggable execution.** Любую задачу можно открыть и понять: почему она выбрана, что AI решил, какие команды запускались, где провалилась validation, что нужно от человека.

## Роли

| Роль | Что нужно |
| --- | --- |
| Developer / reviewer | Понять задачу, увидеть MR, ответить на вопрос AI, оценить риск, принять или вернуть в работу. |
| Manager / lead | Видеть очередь, blocked tasks, SLA, failed tasks, throughput и где требуется человек. |
| AI worker | Быстро получить следующую задачу, атомарно занять её, получить полный structured context, записать шаги выполнения. |
| Operator | Настроить repositories, integrations, tokens, workers, retries, retention и alerts. |

## Место в архитектуре

AI Task Tracker становится внутренним доменным сервисом между external task sources и worker orchestration.

### Yandex integration mode

```text
Yandex Tracker
  -> Yandex sync bridge
  -> AI Task Tracker API + DB
  -> Worker/Fleet Orchestrator
  -> Codex CLI
  -> GitLab
  -> AI Task Tracker API + DB
  -> Yandex sync bridge
  -> Yandex Tracker status/comment digest
```

### Standalone mode

```text
Human UI / system API / webhook
  -> AI Task Tracker API + DB
  -> Worker/Fleet Orchestrator
  -> Codex CLI
  -> GitLab
  -> AI Task Tracker API + DB
  -> Human UI / webhook notifications
```

Для MVP это может быть тот же Node.js процесс с дополнительным HTTP API и PostgreSQL, но границы лучше проектировать как отдельный сервис.

## Режимы постановки задач

AI Task Tracker должен поддерживать несколько intake modes на уровне проекта или repository profile.

| Mode | Как появляется задача | Когда использовать |
| --- | --- | --- |
| `standalone` | Человек создаёт задачу в UI или внешняя система вызывает API/webhook. | Проекты без Yandex Tracker, внутренние automation flows, технические maintenance-задачи. |
| `yandex_integration` | Bridge импортирует issue из Yandex Tracker в AI Task Tracker и зеркалит digest/status обратно. | Команды, где Yandex остаётся внешним корпоративным каналом или legacy board. |
| `hybrid` | Задачи можно создавать и внутри AI Task Tracker, и импортировать из Yandex. | Переходный период или команды, где AI-задачи живут отдельно от общих бизнес-задач. |
| `system_only` | Задачи создают CI, incident system, monitoring, product backend или другой service account. | Автоматические исправления, dependency updates, регулярные code health задачи. |

Yandex integration mode должен быть адаптером, а не фундаментальным предположением доменной модели.

## Источники правды

| Данные | Source of truth |
| --- | --- |
| Каноническая задача, текущий статус, исполнительная модель | AI Task Tracker |
| Внешний исходный текст Yandex issue, если integration включена | Yandex snapshot imported into `TaskRevision` |
| AI routing, confidence, prompt profile, risks | AI Task Tracker |
| Agent run, thread id, retries, quality gates | AI Task Tracker |
| Task/repository leases | AI Task Tracker |
| MR/PR URL, review feedback processing state | GitLab + AI Task Tracker cache |
| Финальный бизнес-статус для команды | AI Task Tracker; optional Yandex mirror |
| Long-term repository memory | existing memory store, later linked into AI Task Tracker |

Правило конфликта: человек в Yandex может менять внешний issue. Sync bridge не меняет runtime state напрямую; он создаёт новую `TaskRevision`, пишет audit event и помечает running work как `context_changed`, если изменение важно для текущего execution. Решение продолжать, перезапустить analysis или поставить задачу на human review принимается уже внутри AI Task Tracker.

## Доменная модель

### Task

Центральная сущность. Не равна Yandex issue один к одному: у неё может быть внешний источник, внутренние child tasks, execution state и несколько revisions.

Основные поля:

- `id` - stable internal id, например `task_01...`;
- `externalRefs` - ссылки на Yandex issue, GitLab MR, future providers;
- `source` - `ui`, `api`, `webhook`, `yandex`, `decomposition`, `system`;
- `createdBy` - human user, service account, bridge or worker id;
- `title`, `description`, `humanSummary`;
- `repositoryName`, `repoPathKey`, `baseBranch`;
- `queue`, `tags`, `components`, `priority`, `deadline`;
- `status` - внутренний lifecycle status;
- `businessStatus` - нормализованный внешний статус;
- `taskType`, `promptProfileId`, `confidence`;
- `acceptanceCriteria`;
- `constraints`;
- `riskFactors`;
- `missingContext`;
- `createdAt`, `updatedAt`, `lastSyncedAt`.

### Task Revision

Версия человеческого входа:

- title/description/criteria snapshot;
- source: `yandex`, `ui`, `api`, `decomposition`, `import`;
- author;
- diff against previous revision;
- `requiresReanalysis` flag.

Это нужно, чтобы worker не продолжал старую реализацию после существенного изменения задачи.

### Task State

Внутренний lifecycle должен быть богаче текущих `open`, `in_progress`, `waiting_for_answer`, `review`, `failed`, `done`.

Рекомендуемые статусы:

| Status | Meaning | Mapping to current logical status |
| --- | --- | --- |
| `new` | Импортирована, ещё не нормализована | `open` |
| `triage` | Нужно уточнить routing/repository/context | `open` |
| `ready` | Можно брать worker'у | `open` |
| `claimed` | Есть активный task lease | `in_progress` |
| `analyzing` | Идёт AI analysis | `in_progress` |
| `awaiting_human` | Нужен ответ/решение человека | `waiting_for_answer` |
| `decomposing` | Идёт decomposition | `in_progress` |
| `implementing` | Идёт implementation | `in_progress` |
| `validating` | Идут quality gates | `in_progress` |
| `review` | MR готов или ждёт review | `review` |
| `fixing_review` | AI исправляет review feedback | `in_progress` |
| `blocked` | Зависимости не закрыты | `open` или `waiting_for_answer` |
| `done` | Завершена | `done` |
| `failed` | Terminal failure | `failed` |
| `cancelled` | Человек отменил | `failed` или external-specific |

### Plan and Steps

Для Phase 8 лучше заложить сущности уже сейчас:

- `TaskPlan` - текущий план выполнения;
- `TaskStep` - шаги `analyze`, `plan`, `implement`, `validate`, `fix`, `publish`, `review_fix`;
- `status`, `attempt`, `startedAt`, `finishedAt`;
- `inputContextHash`;
- `outputSummary`;
- `artifacts`;
- `failureKind`, `diagnostic`.

Даже MVP может начать с одного implicit plan, чтобы не переписывать модель позже.

### Agent Run

Каждый запуск Codex/AI engine:

- `runId`;
- `taskId`;
- `workerId`;
- `engine`: `codex-cli`;
- `threadId`;
- `stage`;
- `promptProfileId`;
- `startedAt`, `finishedAt`;
- `exitCode`, `timedOut`;
- `finalMessage`;
- `token/cost metadata` в будущем;
- ссылки на logs/artifacts.

Это заменяет необходимость восстанавливать состояние по тексту комментариев.

### Decisions

Структурированные решения:

- `analysisDecision` - confidence, task type, mode, risks, missing context;
- `routingDecision` - почему задача попала в repository profile;
- `decompositionDecision` - parent/child tasks and dependencies;
- `manualDecision` - human approve/resume/skip/cancel.

Каждое decision должно иметь `schemaVersion`, `source`, `author/workerId`, `createdAt`.

### Conversation

Нужны два слоя:

- human discussion - обычные комментарии людей;
- AI protocol messages - вопросы, ответы, commands, summaries.

В UI их можно показывать вместе, но API должен различать:

- `comment`;
- `question`;
- `answer`;
- `command`;
- `status_digest`;
- `system_event`.

### Leases

Task/repository leases должны стать отдельной таблицей:

- `leaseId`;
- `kind`: `task` или `repository`;
- `leaseKey`;
- `taskId`;
- `repositoryName`;
- `workerId`;
- `token`;
- `expiresAt`;
- `heartbeatAt`;
- `releasedAt`.

Claim должен быть атомарным: worker либо получил задачу и lease, либо нет.

### Dependencies

Dependency graph должен поддерживать:

- `blocks`;
- `blocked_by`;
- `parent_child`;
- `relates`;
- `duplicates`;
- `requires_human_input`;
- `requires_external_change`.

Для AI особенно важны typed dependencies с reason и status. Это лучше, чем provider-specific link names вроде `is blocked by`.

### Artifacts

Артефакты задачи:

- validation logs;
- coverage reports;
- visual regression screenshots;
- generated plan;
- diff snapshot;
- MR description;
- uploaded files from human;
- future multimodal inputs: screenshots, Figma links, OpenAPI specs.

MVP может хранить только metadata и filesystem/object-store path.

## AI-first task card

Человеку нужна компактная карточка, а AI нужен строгий контракт. Поэтому задача должна иметь два представления одной модели:

### Human view

- title;
- current status;
- repository;
- goal;
- acceptance criteria;
- current blocker/question;
- MR link;
- last AI summary;
- validation summary;
- next action.

### Agent context view

Пример ответа API для worker:

```json
{
  "taskId": "task_01HWQ4",
  "externalRefs": [
    {
      "provider": "yandex_tracker",
      "key": "FRONTEND-42",
      "url": "https://tracker.yandex.ru/FRONTEND-42"
    }
  ],
  "repository": {
    "name": "client-application",
    "baseBranch": "main",
    "profileTags": ["ai_dev"]
  },
  "work": {
    "title": "Fix checkout form validation",
    "description": "Business description from the latest approved revision.",
    "acceptanceCriteria": [
      "Invalid email shows inline error.",
      "Submit remains disabled until required fields are valid."
    ],
    "constraints": [
      "Keep existing form architecture.",
      "Do not change payment API contract."
    ]
  },
  "ai": {
    "taskType": "frontend_ui_fix",
    "promptProfileId": "frontend_ui_fix",
    "confidence": 82,
    "recommendedMode": "implement",
    "expectedFiles": ["src/components/CheckoutForm.tsx"],
    "riskFactors": ["visual regression risk"],
    "missingContext": []
  },
  "state": {
    "status": "ready",
    "dependencies": [],
    "latestHumanAnswer": null,
    "latestPlan": null
  }
}
```

## Task intake

AI Task Tracker должен уметь принимать задачи напрямую, без внешнего tracker.

### Human-created tasks

В UI человек создаёт задачу с минимальным набором полей:

- title;
- description;
- repository or queue;
- priority;
- acceptance criteria;
- optional deadline;
- optional attachments/links;
- optional labels/components.

После сохранения задача получает статус `triage` или `ready`:

- `triage`, если не выбран repository, нет acceptance criteria, конфликтует routing или нужен human review;
- `ready`, если repository profile определён и задача достаточно конкретна для AI analysis.

### System-created tasks

Внешняя система может ставить задачи через API или webhook:

- CI создаёт задачу на flaky test или failing build;
- dependency monitor создаёт dependency update;
- security scanner создаёт vulnerability fix;
- product backend создаёт task из feature flag/experiment backlog;
- другой AI/planner создаёт child tasks после decomposition.

System-created task обязательно должна иметь `source`, `createdBy`, idempotency key и raw source payload для аудита.

### Task creation API

```http
POST /api/tasks
```

Минимальный payload:

```json
{
  "source": "api",
  "createdBy": "service:dependency-monitor",
  "idempotencyKey": "dep-update:client-application:react:19.2.0",
  "repositoryName": "client-application",
  "title": "Update React to 19.2.0",
  "description": "Update React and fix compatibility issues.",
  "acceptanceCriteria": [
    "Lockfile is updated.",
    "Typecheck, tests and build pass.",
    "Breaking changes are documented in the MR description."
  ],
  "priority": "normal",
  "tags": ["ai_dev", "dependency_update"]
}
```

Дополнительные endpoints:

```http
POST /api/tasks:bulk-create
POST /api/tasks/{taskId}/revisions
POST /api/tasks/{taskId}/attachments
POST /api/tasks/{taskId}/commands/mark-ready
```

### Templates

Для людей и систем нужны task templates:

- feature implementation;
- bug fix;
- UI polish;
- tests-only;
- refactor;
- dependency update;
- documentation;
- security fix.

Template должен задавать required fields, default prompt profile hints, default acceptance criteria checklist and validation expectations.

## API для worker fleet

MVP API должен быть не CRUD-first, а workflow-first.

### Queue and claim

```http
POST /api/agent/tasks:claim
```

Input:

- `workerId`;
- `repositoryProfiles`;
- `capabilities`;
- `maxTasks`;
- `leaseTtlSeconds`;
- optional `targetExternalKey`.

Output:

- claimed task;
- task lease;
- repository lease;
- normalized agent context.

Claim должен учитывать:

- status `ready` или resumable active status;
- dependencies;
- repository lease;
- priority score;
- stale leases;
- manual override;
- confidence score.

### Lifecycle events

```http
POST /api/agent/tasks/{taskId}/events
```

Пишет `analysis_started`, `analysis_completed`, `implementation_started`, `validation_completed`, `mr_ready`, `task_failed` и другие события, которые сейчас живут в observability.

### Decisions

```http
POST /api/agent/tasks/{taskId}/decisions/analysis
POST /api/agent/tasks/{taskId}/decisions/decomposition
```

Валидирует JSON schema и обновляет derived fields задачи.

### Questions and resume

```http
POST /api/agent/tasks/{taskId}/questions
POST /api/human/tasks/{taskId}/answers
POST /api/human/tasks/{taskId}/commands/resume
```

Это заменяет parsing `/resume` из комментариев как основной механизм. Для Yandex Tracker bridge можно оставить совместимость: комментарий `/resume` импортируется как human command.

### Validation and publish

```http
POST /api/agent/tasks/{taskId}/validation-runs
POST /api/agent/tasks/{taskId}/merge-requests
```

Хранит quality gate results, artifact refs, branch, MR URL и MR iid.

### Lease heartbeat

```http
POST /api/agent/leases/{leaseId}:heartbeat
POST /api/agent/leases/{leaseId}:release
```

Нужно поддержать idempotency key, чтобы сетевые повторы не создавали двойные события.

## Human UI

Минимальный UI должен быть рабочим инструментом, а не витриной.

### Queue view

- фильтры по repository, status, queue, priority, assignee/worker, tag;
- отдельные группы: ready, awaiting human, review, failed, blocked;
- видимые причины блокировки;
- score breakdown для выбранной задачи.

### Create task view

- создание задачи без Yandex Tracker;
- выбор repository/queue или автоматический routing по описанию;
- task templates с обязательными полями;
- acceptance criteria editor;
- attachments and external links;
- preview agent context перед переводом в `ready`;
- кнопки save draft, mark ready, request human triage.

### Task detail

Экран задачи:

- слева - human task card: цель, описание, acceptance criteria, attachments, external links;
- справа - AI execution panel: current stage, active worker, lease TTL, plan, latest run, quality gates;
- timeline - audit events and decisions;
- conversation - human comments and AI questions;
- MR panel - branch, MR URL, unresolved review feedback summary;
- actions - answer, resume, hold, cancel, retry, force reanalysis, approve decomposition.

### Decomposition view

- graph parent/child tasks;
- dependencies with reasons;
- status of each child;
- ability to approve created subtasks before syncing to Yandex.

### Operations view

Это может расширить текущий dashboard:

- workers and heartbeats;
- active leases;
- queue depth;
- failed tasks;
- repeated validation failures;
- tasks waiting for human longer than threshold.

## Yandex Tracker integration

Yandex остаётся первым external source для совместимости с текущим проектом, но integration должна быть optional. В standalone/system modes Yandex bridge не включается: задачи создаются в AI Task Tracker, а внешние уведомления уходят через UI, webhook, Slack/Telegram или другой configured sink.

Важно: даже при включённой Yandex integration основной tracker остаётся AI Task Tracker. Bridge не отдаёт worker'у Yandex issue напрямую. Он копирует или обновляет внутреннюю задачу, после чего worker работает только с internal `taskId`, leases, plan, events и decisions. В Yandex возвращаются compact digest-события, чтобы люди, которые остаются в Yandex, видели важные моменты без технического шума.

### Import

Bridge периодически читает Yandex по queue/tag и создаёт/обновляет internal tasks:

- `externalRefs.provider = yandex_tracker`;
- `externalRefs.key = FRONTEND-42`;
- сохраняет raw payload для диагностики;
- мапит Yandex status в `businessStatus`;
- создаёт `TaskRevision`, если title/description/priority/deadline/tags changed.

Import должен быть idempotent по `(provider, externalKey)`: повторное чтение `FRONTEND-42` обновляет существующую internal task, а не создаёт дубль.

### Export

В Yandex надо писать не весь технический журнал, а digest:

- task started;
- AI question;
- MR ready;
- failed with compact diagnostic;
- done;
- decomposition summary and links to created child issues if enabled.

Технические `AI LEASE` comments можно перестать писать после миграции lock backend.

### Commands from Yandex

Для совместимости bridge должен импортировать:

- human comments;
- `/resume`;
- `/skip`;
- `/cancel`;
- direct answer to latest AI question.

Внутри AI Task Tracker это становится `HumanCommand`, а не просто текст комментария.

### Status sync

Рекомендуемая политика:

- internal `ready/analyzing/implementing/validating/fixing_review` -> Yandex `in_progress`;
- internal `awaiting_human` -> Yandex `waiting_for_answer`;
- internal `review` -> Yandex `review`;
- internal `done` -> Yandex `done`;
- internal `failed` -> Yandex `failed`;
- internal `blocked` -> оставить Yandex `open` или `waiting_for_answer` по настройке.

Status sync должен быть idempotent и писать audit event с результатом.

## Standalone project workflow

Для проекта без Yandex Tracker базовый flow такой:

1. Человек создаёт задачу в AI Task Tracker UI или система вызывает `POST /api/tasks`.
2. Tracker валидирует required fields, выбирает repository profile или переводит задачу в `triage`.
3. После `mark-ready` задача попадает в claim queue.
4. Worker атомарно получает task/repository lease и запускает analysis.
5. Если нужен человек, вопрос появляется в task detail и optional notification channel.
6. После ответа worker продолжает execution.
7. MR создаётся в GitLab, ссылка и validation summary пишутся в task timeline.
8. После merge/done задача закрывается внутри AI Task Tracker.

Для таких проектов `externalRefs` может содержать только GitLab MR, incident id, CI run id или вообще быть пустым.

## Интеграция с текущим кодом

### Новый contract

Существующий `TrackerClient` в `src/models/types.ts` сейчас совмещает external issue API и runtime protocol. Для нового tracker стоит ввести отдельные контракты:

```typescript
export interface TaskTrackerClient {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  updateTaskRevision(taskId: string, input: TaskRevisionInput): Promise<TaskRecord>;
  markReady(taskId: string, reason?: string): Promise<void>;
  claimNextTask(input: ClaimTaskInput): Promise<ClaimedTask | null>;
  getTask(taskId: string): Promise<TaskRecord>;
  appendEvent(taskId: string, input: TaskEventInput): Promise<void>;
  appendComment(taskId: string, input: CommentInput): Promise<void>;
  setStatus(taskId: string, status: TaskStatus, reason?: string): Promise<void>;
  recordAnalysis(taskId: string, decision: TaskAnalysisDecision): Promise<void>;
  recordDecomposition(taskId: string, plan: DecompositionPlan): Promise<void>;
  createChildTasks(taskId: string, subtasks: SubtaskDraft[]): Promise<TaskRecord[]>;
  linkDependency(input: LinkTaskDependencyInput): Promise<void>;
  askClarification(taskId: string, question: ClarificationQuestion): Promise<void>;
  recordMergeRequest(taskId: string, input: MergeRequestRecordInput): Promise<void>;
  recordValidation(taskId: string, input: ValidationRecordInput): Promise<void>;
}
```

И отдельно:

```typescript
export interface ExternalTaskSource {
  importCandidates(input: ImportCandidatesInput): Promise<ExternalIssueSnapshot[]>;
  exportDigest(input: ExportDigestInput): Promise<void>;
  transitionExternal(input: ExternalTransitionInput): Promise<void>;
}
```

`YandexTrackerClient` постепенно переезжает в `ExternalTaskSource`, а worker перестаёт напрямую зависеть от Yandex issue comments.

### Orchestrator changes

Минимальные изменения по шагам:

1. Добавить AI Task Tracker adapter рядом с текущим `YandexTrackerClient`.
2. В single-repo mode оставить Yandex напрямую как fallback, но добавить feature flag `TASK_TRACKER_PROVIDER=internal`.
3. В fleet mode перевести queue selection на `claimNextTask`, чтобы claim и lease были атомарными.
4. `commentProtocol.ts` оставить как compatibility layer для Yandex bridge.
5. `WorkerOrchestrator` заменить `TrackerIssue` на neutral `TaskRecord` в новых paths.
6. Prompt builder должен получать `AgentTaskContext`, а не собирать контекст из комментариев.
7. Observability events писать и в текущий event store, и в task timeline, затем объединить storage.

Новые настройки:

```env
TASK_TRACKER_PROVIDER=internal
TASK_INTAKE_MODE=standalone
YANDEX_SYNC_ENABLED=false
```

Для текущего поведения:

```env
TASK_TRACKER_PROVIDER=yandex
```

Для режима Yandex integration с новым tracker:

```env
TASK_TRACKER_PROVIDER=internal
TASK_INTAKE_MODE=yandex_integration
YANDEX_SYNC_ENABLED=true
```

### Lock backend

Текущий `TrackerCommentLockBackend` можно оставить как fallback. Новый backend:

- хранит leases в DB;
- использует unique active lease constraints;
- поддерживает heartbeat/release;
- не требует чтения комментариев;
- быстрее восстанавливается после рестарта.

### Memory

Phase 5 memory остаётся отдельным store. AI Task Tracker должен ссылаться на memory context snapshots:

- какие rules попали в prompt;
- какие failure memories были использованы;
- какой knowledge version применялся.

Это поможет отлаживать, почему AI выбрал конкретное решение.

## Storage

Для production MVP рекомендуется PostgreSQL. SQLite можно оставить для local dev/smoke tests.

Почему PostgreSQL:

- транзакционный claim/lease;
- row-level locks;
- JSONB для schema-versioned AI payloads;
- индексы по status, repository, external key, deadline;
- нормальная база для будущего API/UI.

Минимальные таблицы:

| Table | Purpose |
| --- | --- |
| `tasks` | Текущая task card and derived fields. |
| `task_revisions` | Версии входного человеческого описания. |
| `task_external_refs` | Yandex/GitLab/future provider links. |
| `task_events` | Append-only timeline. |
| `task_comments` | Human and AI-visible discussion. |
| `task_decisions` | Analysis, routing, decomposition, manual decisions. |
| `task_plans` | Persisted plans. |
| `task_steps` | Step state machine. |
| `agent_runs` | Codex/AI engine executions. |
| `quality_gate_runs` | Validation results and diagnostics. |
| `task_dependencies` | Typed dependency graph. |
| `task_leases` | Atomic task/repository leases. |
| `artifacts` | Logs, reports, screenshots, specs, attachments. |
| `sync_cursors` | External source polling state. |

Standalone deployments still use the same schema. They simply do not create Yandex external refs or sync cursor rows unless another external source is enabled.

## Security and operations

MVP должен оставаться self-hosted.

Обязательные требования:

- bearer token or service token auth for agent API;
- separate human API auth before exposing UI outside trusted network;
- RBAC минимум: viewer, operator, developer, admin;
- secret redaction for logs/events/comments;
- audit log for every mutation;
- retention policy for raw Codex logs and artifacts;
- integration tokens never stored in task payloads;
- preflight checks for DB, Yandex sync, GitLab sync and worker API.

## MVP milestones

### 7.1 Schema and contracts

- Зафиксировать `TaskTrackerClient`, `ExternalTaskSource`, `TaskRecord`, `AgentTaskContext`.
- Добавить PostgreSQL schema migrations.
- Добавить in-memory or SQLite test implementation for unit tests.
- Описать status mapping from internal statuses to current logical statuses.

### 7.2 Internal tracker API

- Реализовать claim, lease heartbeat/release, task read, event append.
- Реализовать direct task creation, revision update, attachments metadata and mark-ready command.
- Перенести priority queue scoring в tracker claim path.
- Добавить idempotency keys.
- Покрыть concurrency tests для двойного claim.

### 7.3 Task intake and Yandex bridge

- Поддержать `standalone`, `yandex_integration`, `hybrid`, `system_only` intake modes.
- Добавить UI/API создание задач без Yandex.
- Добавить webhook/API path для system-created tasks.
- Import queue/tag issues into internal tasks.
- Export digest comments and status transitions.
- Import `/resume`, `/skip`, `/cancel` and human answers.
- Keep current direct Yandex mode as fallback.

### 7.4 Worker migration

- Добавить `TASK_TRACKER_PROVIDER=internal|yandex`.
- Перевести analysis, clarification, decomposition, validation, publish на structured task API.
- Оставить `commentProtocol.ts` только для bridge compatibility.
- Добавить smoke test: mock Yandex -> internal tracker -> mock GitLab -> worker.

### 7.5 Human UI

- Queue view.
- Task detail.
- Awaiting human workflow.
- Failed task diagnostics.
- MR and validation summary.

### 7.6 Operational hardening

- DB preflight.
- Backup/restore runbook.
- Retention settings.
- Dashboard auth alignment.
- Metrics for sync lag, claim latency, lease conflicts and task lifecycle duration.

## Acceptance criteria

- Worker can process a task end-to-end using AI Task Tracker as primary task state store.
- A human can create a task directly in AI Task Tracker without any Yandex issue.
- A system/service account can create a task through API with idempotency key and audit trail.
- In Yandex integration mode, Yandex issue remains visible and receives compact status/comment digests.
- No `AI LEASE` comments are required in Yandex for internal mode.
- A human can answer an AI question from internal UI; in Yandex integration mode the same answer can also come from Yandex comment.
- Decomposition creates internal child tasks first, then optionally mirrors child issues to Yandex.
- Restart recovery uses DB state, not comment parsing.
- Concurrent workers cannot claim the same task or repository lease.
- Current tests for Yandex direct mode continue to pass until fallback is intentionally removed.

## Open questions

- Should internal child tasks always be mirrored to Yandex, or only after human approval?
- Is PostgreSQL mandatory for first MVP, or do we need SQLite-only local mode?
- Should GitLab review discussions be mirrored into task timeline on every poll or only when review fix starts?
- What is the minimum human auth model acceptable for the first UI?
- Do managers need Yandex as the official status board after internal UI exists, or only as intake/source?
- How long should raw Codex logs and validation artifacts be retained?

## Main risks

| Risk | Mitigation |
| --- | --- |
| Scope creep into full issue tracker | Keep MVP focused on AI execution workflow and Yandex bridge. |
| Two sources of truth conflict | Define field ownership and revision/audit model from day one. |
| Worker migration touches many modules | Add provider flag and run internal tracker path in parallel with current Yandex path. |
| UI delays backend value | Build workflow API first, then minimal queue/task UI. |
| DB operational burden | Provide Docker Compose defaults, preflight, backup runbook and SQLite test adapter. |

## Recommended roadmap replacement

Replace current Phase 7 "Multi-provider architecture" with:

```text
Phase 7 - AI-native Task Tracker
7.1 Task tracker domain model and DB schema
7.2 Agent workflow API with atomic claim/lease
7.3 Direct task intake API and optional Yandex Tracker bridge
7.4 Worker migration behind provider flag
7.5 Human queue/task UI
7.6 Operational hardening and runbooks
```

Then move provider-neutral Jira/GitHub/Linear work after this phase. At that point new providers become external sources and mirrors for the internal tracker, not replacements for the AI runtime state model.
