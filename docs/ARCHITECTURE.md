# Архитектура AI Developer Worker

Этот документ описывает **текущие** модули, runtime-режимы и поток данных проекта. Для установки и эксплуатации используйте [указатель документации](README.md). Отдельные исторические планы в `docs/superpowers/` не гарантируют фактической реализации.

## Назначение и границы

`AI-Developer-Worker` — Node.js/TypeScript-воркер для задач инженерной разработки. Он получает задачу из Yandex Tracker или собственного internal task tracker, анализирует её с помощью Codex CLI, изменяет целевой git checkout, выполняет настроенные проверки и создаёт GitLab merge request.

Дополнительные компоненты: внутренний PostgreSQL-трекер, мост импорта Yandex, HTTP API/observability, Angular-консоль, Telegram Assistant и Project Manager Agent. **Здесь нет полнофункционального корпоративного MCP-шлюза, автоматического деплоя по merge или общего Sentry/BugLens intake** — эти функции требуют отдельной разработки.

Исследование конкурентов Wildberries/Ozon удалено из `main`, исходная реализация доступна в архивной ветке `archive/competitor-research-2026`.

## Точки входа

| Компонент | Назначение |
| --- | --- |
| `src/index.ts` | Создание приложения, запуск preflight-only или основного runtime |
| `src/app.ts` | Composition root: конфигурация, адаптеры, observability, cleanup, Telegram, Project Manager |
| `src/config.ts` | Парсер `.env` и fleet YAML, значения по умолчанию, проверка совместимости |
| `src/preflight.ts` | Однократная проверка окружения без обработки задач |
| `scripts/internal-tracker-migrate.ts` | Миграции PostgreSQL |
| `web/` | Angular-консоль (отдельный build) |

Запуск в разработке: `npm run dev`. Сборка backend: `npm run build`, затем `npm run start`. Команды интерфейса — в [web/README.md](../web/README.md).

## Режимы исполнения

| Условие | Оркестратор | Источник состояния |
| --- | --- | --- |
| `TASK_TRACKER_PROVIDER=yandex`, без fleet-файла | `WorkerOrchestrator` | Статусы и структурированные комментарии Yandex Tracker |
| `TASK_TRACKER_PROVIDER=internal`, без fleet-файла | `InternalWorkerOrchestrator` | Внутренний трекер, обычно PostgreSQL |
| `TASK_TRACKER_PROVIDER=yandex` + `WORKER_CONFIG_FILE` | `FleetOrchestrator` | Yandex с профилями нескольких репозиториев |
| `TASK_TRACKER_PROVIDER=internal` + `WORKER_CONFIG_FILE` | `InternalWorkerOrchestrator` с несколькими contexts | Internal tracker + repository profiles |
| `WORKER_PREFLIGHT_ONLY=true` | `PreflightService` | Только проверки |

`WORKER_RUN_ONCE=true` выполняет один цикл. Для непрерывной работы используется polling; при остановке воркер должен корректно завершить текущую обработку.

## Жизненный цикл задачи

```text
Yandex / Internal Tracker
         │
         ▼
Task analysis → policy / dependencies / lease
         │
         ▼
Git branch + Codex exec / resume
         │
         ▼
Typecheck → Lint → Tests → Build → Security → SAST → Coverage → Visual
         │
         ▼
Commit / Push → GitLab MR
         │
         ▼
Review & human testing → Accepted (done)
```

1. При старте проверяется конфигурация, целевой репозиторий и авторизация Codex.
2. Воркер восстанавливает незавершённую задачу или выбирает новую из очереди. В internal mode используются атомарные claims и leases.
3. Перед изменениями проверяются зависимости `blockedBy` и возможность безопасно получить права на репозиторий.
4. Для задачи выбирается режим `implement`, `decompose`, `analyze_only` или `human`, формируется контекст из описания, комментариев, промпт-профиля и доступной памяти.
5. Codex может вернуть `AI_QUESTION:`. Тогда сохраняется `threadId`, задача ожидает явного ответа (`/resume`, `/skip`, `/cancel`).
6. В режиме реализации запускаются настроенные quality gates и цикл исправлений. Не заданная команда отдельного gate может быть пропущена — нельзя считать список названий автоматически включёнными проверками.
7. После успешной обработки публикуется MR; дальнейшие замечания GitLab могут инициировать доработки.
8. **Merge MR подтверждает доставку кода, а не бизнес-приёмку.** Во внутреннем трекере задача переходит в `human_testing` и закрывается после принятия человеком.

Важно: в `src/domain/orchestrator.ts` (direct Yandex) есть необязательный `CODEX_SELF_REVIEW_ENABLED`; он не равнозначен независимому reviewer для всех MR и не должен подразумеваться в internal mode.

## Границы модулей

| Путь | Ответственность |
| --- | --- |
| `src/domain/orchestrator.ts` | Direct Yandex, AI comments, ветки/MR, feedback и self-review |
| `src/domain/internalWorkerOrchestrator.ts` | Internal task lifecycle, claims, leases, результат проверок, синхронизация |
| `src/domain/fleetOrchestrator.ts` | Несколько репозиториев при прямой работе с Yandex |
| `src/domain/taskTracker/` | Статусы, типы, зависимости, права полей, proposals |
| `src/domain/projectManager/` | Анализ проектов, цели, предложения и replanning |
| `src/domain/telegramAssistant/` | Intents, диалоги, подтверждения, подписки, Digital Twin |
| `src/domain/promptBuilder.ts` | Промпт-контракты анализа, выполнения, уточнения, исправления |
| `src/domain/qualityGates.ts` | Команды проверки и диагностика |
| `src/domain/memoryStore.ts` | Локальная файловая память проекта |
| `src/integrations/tracker/` | Yandex Tracker API и structured comments |
| `src/integrations/internalTracker/` | PostgreSQL, миграции, cleanup, хранилища |
| `src/integrations/yandexBridge/` | Импорт и зеркалирование Yandex |
| `src/integrations/codex/` | Codex CLI, JSONL, auth, resume/review |
| `src/integrations/git/` | Ветки, diff, commit, push |
| `src/integrations/gitlab/` | GitLab API, MR, discussions |
| `src/integrations/telegram/` | Telegram Bot API, polling/webhook |
| `src/observability/` | HTTP, логи событий, метрики, алерты, human API |
| `web/` | Angular-консоль |

**Правило модульности:** решения о задачах и политике — в `src/domain/`. Адаптеры `src/integrations/` переводят внешние API во внутренние контракты, не определяя бизнес-логику. Операции со сторонними системами должны иметь ограниченные права и журналирование.

## Internal Task Tracker

Каноническая модель — `src/domain/taskTracker/types.ts`; PostgreSQL-адаптер — `src/integrations/internalTracker/postgresTaskTracker.ts`. Production хранит задачи, события, ревизии, решения, agent runs, validations, MR, dependencies, proposals и leases в БД. In-memory adapter предназначен для тестов и локальных smoke-сценариев.

Атомарный claim использует PostgreSQL и блокировки задач/репозиториев, чтобы несколько workers не изменяли один checkout одновременно. Правила ownership защищают поля, принадлежащие человеку, системе и агентам.

`YANDEX_SYNC_ENABLED=true` доступно в режимах intake `yandex_integration` и `hybrid`. Перед стартом применяйте `npm run tracker:migrate` и `npm run preflight`.

## HTTP API и Angular UI

`src/observability/server.ts` предоставляет `/healthz`, `/readyz`, `/metrics`, события и при включении human API. Реализация сценарных операций — `src/observability/taskTrackerHumanApi.ts`: списки задач, детали, команды, proposals, goals и runs. Это не универсальный CRUD.

Angular UI из `web/` обслуживается по `/tasks`, API — обычно под `/api`. Браузер не хранит bearer token. Для удалённого доступа необходим проверенный reverse proxy и безопасная авторизация: доверенные заголовки должны приходить **только от него**, а не напрямую от клиента.

## Telegram Assistant

При включении Telegram Assistant использует internal `TaskTrackerClient`, не обращаясь к human HTTP API. В состоянии Telegram отдельно сохраняются offset, processed updates, pending actions, subscriptions, locks и audit; задачи остаются во внутреннем трекере.

**Актуальный путь создания задач реализован:** доверенный пользователь подтверждает draft с `repositoryName`, `repoPathKey`, `baseBranch`, `queue`; low/medium-risk draft может стать `ready`. High-risk или внешние Business/Profile заявки передаются owner/admin. Состояние и границы изложены в [Telegram task intake](TELEGRAM_TASK_INTAKE.md).

### Digital Twin

Опциональный `TELEGRAM_DIGITAL_TWIN_*` — долговременные Codex-сессии по Telegram Business/Secretary контактам, с idempotency, versioning persona, audit и retention. Явный `create_task_draft` проходит через согласование владельца **до** свободного разговорного ответа. Не включайте Digital Twin без согласия владельца, правил хранения, audit encryption и проверки `can_reply`.

Исторические описания дизайна лежат в `docs/superpowers/specs/` и `plans/`; эксплуатационные параметры — в [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md).

## Project Manager Agent

Project Manager выключен по умолчанию и требует internal tracker. Он анализирует сигналы проекта, формирует цели, предложения задач и replanning, используя `src/domain/projectManager/` и PostgreSQL store. Стандартная политика `proposal_only`: предложения не должны обходить утверждение человека и ограничения по типам задач.

Не смешивайте контексты задач, Digital Twin и Project Manager без явных интерфейсов и permission checks.

## Сопровождение и проверки

При изменении конфигурации синхронно меняйте `src/config.ts`, `src/models/types.ts`, `.env.example`, [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md), `tests/config.test.ts` и fleet-примеры.

| Область | Проверка |
| --- | --- |
| TypeScript и доменная логика | `npm run typecheck`, `npm test` |
| Прямой worker | `npm run test:smoke`, targeted orchestrator tests |
| PostgreSQL | `npm run tracker:migrate`, интеграционные тесты, `npm run preflight` |
| Codex CLI | `npm run verify:codex-cli`, безопасный live probe при необходимости |
| Angular | `npm run web:typecheck`, `npm run web:test`, `npm run web:build`, `npm run web:e2e` |
| Docker | `docker compose config`, one-shot запуск с реальными доступами |

Частые изменения требуют пересмотреть сразу несколько файлов:

- Новый статус задачи: типы, правила ownership, storage, API DTO, UI mapper и тесты.
- Новая интеграция: отдельный адаптер, redaction/retry, минимальный domain-facing контракт.
- Новый prompt marker: `promptBuilder.ts`, парсер, тесты и документация.
- Новая операция UI: human API, Angular model/service/component и E2E.
- Новая Telegram-функция: service/store/retention, tests, Telegram runbook.
- Новая переменная: parser, типы, `.env.example`, таблица переменных и preflight.

## Ограничения безопасности

1. Не помещайте токены, `auth.json`, `.env` и дампы в репозиторий или контекст модели.
2. Не делите writable `CODEX_HOME` между работающими воркерами.
3. `CODEX_SANDBOX=danger-full-access` в шаблоне не является безопасным production default. При вызове shell Codex-процесс потенциально наследует переменные процесса, поэтому нужны изоляция среды и контроль секретов.
4. Прежде чем менять production-репозитории, проверяйте credentials, target commands и полномочия по проектам.
5. Само создание MR не означает завершённое ревью, merge, deploy и acceptance; эти этапы независимы.

Для фактического запуска начните с [README](../README.md), [Docker runbook](LOCAL_DOCKER_RUN.md) и [PostgreSQL](INTERNAL_TRACKER_POSTGRES_RUNBOOK.md).

