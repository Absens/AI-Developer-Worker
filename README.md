# AI Developer Worker

Node.js/TypeScript воркер для AI-разработки: он забирает задачи из Yandex Tracker или внутреннего task tracker, запускает Codex CLI в целевом репозитории, валидирует результат и создает или переиспользует merge request в GitLab.

Проект рассчитан на запуск как локально, так и в Docker. Основной сценарий: воркер берет подходящую задачу, готовит ветку в смонтированном checkout, передает задачу Codex, прогоняет проверки качества, публикует изменения в GitLab и обновляет задачу комментариями, статусами и структурированными событиями.

## Что делает воркер

За один цикл воркер:

1. Восстанавливает незавершенную задачу текущего `WORKER_ID`, если такая есть.
2. Иначе выбирает подходящую задачу через Yandex queue/tag или internal tracker claim queue с учетом lease-aware priority scoring.
3. Делает структурированный анализ задачи, сохраняет `AI ANALYSIS:` в Tracker или structured decision во внутреннем tracker и выбирает режим обработки.
4. Проверяет зависимости `blockedBy` до получения lease и до изменения git-состояния.
5. Переводит задачу по логическим статусам из `TRACKER_STATUS_MAP_FILE`.
6. Готовит ветку `feature/ai-task-{tracker_id}` в локальном checkout целевого репозитория.
7. Запускает `codex exec`, затем настроенные проверки качества.
8. Создает commit, push, merge request и обновляет task tracker.

Если Codex не может продолжить без бизнес-уточнения, он возвращает одну строку `AI_QUESTION:`. Воркер сохраняет `threadId`, переводит задачу в ожидание ответа и позже возобновляет тот же Codex-сеанс после команды человека.

## Архитектура и поток данных

Точка входа [src/index.ts](src/index.ts) загружает конфигурацию, запускает observability/cleanup, проверяет готовность целевого репозитория и Codex auth, затем вызывает orchestrator в one-shot или continuous режиме.

Основные runtime-режимы:

- **Direct Yandex mode**: `WorkerOrchestrator` использует Yandex Tracker как очередь задач и runtime state store. Технические события пишутся структурированными комментариями `AI STATUS`, `AI QUESTION`, `AI MR`, `AI REVIEW`, `AI LEASE`, `AI ANALYSIS` и `AI DECOMPOSITION`.
- **Internal tracker mode**: `InternalWorkerOrchestrator` работает с внутренней task-моделью, atomic claim/lease, task events, decisions, validations и MR records. PostgreSQL - production storage, in-memory storage используется только для тестов и локальных smoke-сценариев.
- **Fleet mode**: `WORKER_CONFIG_FILE` описывает несколько repository profiles. Для каждого профиля строится отдельный runtime context с собственным `repoPath`, `baseBranch`, GitLab project id, queues/tags и quality gates.

Упрощенный поток:

```text
Task source -> Orchestrator -> Codex CLI -> Quality gates -> Git/GitLab -> Task tracker
```

## Структура проекта

- [src/](src/) - runtime-код воркера.
- [src/domain/](src/domain/) - оркестрация, маршрутизация задач, сборка prompt-ов и проверки качества.
- [src/integrations/](src/integrations/) - адаптеры Tracker, internal tracker, Yandex bridge, GitLab, Git и Codex.
- [src/observability/](src/observability/) - health/readiness, метрики и оповещения.
- [src/utils/](src/utils/) - запуск shell-команд, retry, логирование и общие helper-ы.
- [tests/](tests/) - unit и smoke tests на Vitest.
- [web/](web/) - Angular human console для internal task tracker.
- [scripts/](scripts/) - операционные helper-ы, включая bootstrap Codex auth.
- [docs/](docs/) - runbook-и по окружению, Docker, fleet mode, memory и observability.
- [config/](config/) - пример карты статусов Tracker.

## Быстрый старт

1. Установите зависимости: `npm install`.
2. Скопируйте [.env.example](.env.example) в `.env` и заполните Tracker, GitLab, Codex и git-настройки.
3. Проверьте `TRACKER_STATUS_MAP_FILE`; пример лежит в [config/trackerStatusMap.example.json](config/trackerStatusMap.example.json).
4. Подготовьте локальный checkout целевого репозитория и убедитесь, что в нем настроены fetch/push credentials.
5. Выполните preflight: `npm run preflight`.
6. Первый рабочий запуск делайте с `WORKER_RUN_ONCE=true`.
7. Переключайте воркер в непрерывный режим только после успешного one-shot запуска.

Контейнер не выполняет OAuth login при старте. Если `CODEX_HOME` отсутствует или не аутентифицирован, startup завершается до того, как воркер начнет менять Tracker или GitLab.

## Запуск в Docker

Соберите образ:

```bash
docker build -t ai-developer-worker .
```

Для Docker Compose задайте в `.env`:

```env
HOST_CODEX_HOME=C:/Users/you/.codex
TARGET_REPO_PATH=C:/path/to/target/repository
CODEX_HOME=/codex-home
REPO_PATH=/workspace/project
WORKER_RUN_ONCE=true
```

Затем запустите:

```bash
docker compose up --build
```

Для долгоживущего воркера предпочтительнее отдельный writable volume `CODEX_HOME`, а не прямой bind mount host `~/.codex`. Подробности и Windows-команды есть в [docs/LOCAL_DOCKER_RUN.md](docs/LOCAL_DOCKER_RUN.md) и [docs/WINDOWS_POWERSHELL_QUICKSTART.md](docs/WINDOWS_POWERSHELL_QUICKSTART.md).

## Команды разработки

- `npm install` - установить зависимости.
- `npm run typecheck` - запустить строгую проверку TypeScript без emit.
- `npm test` - запустить весь набор Vitest.
- `npm run test:smoke` - запустить end-to-end smoke test с mock Tracker/GitLab и реальным git flow.
- `npm run build` - собрать production bundle в `dist/`.
- `npm run verify:codex-cli` - проверить статический контракт установленного Codex CLI.
- `npm run dev` - запустить воркер через `tsx` с `.env`.
- `npm run start` - запустить собранный bundle из `dist/`.
- `npm run tracker:migrate` - применить PostgreSQL migrations для internal task tracker.
- `npm run web:typecheck` - проверить Angular console TypeScript.
- `npm run web:test` - запустить Angular unit tests.
- `npm run web:build` - собрать Angular console в `web/dist/task-tracker-console/browser`.
- `npm run web:e2e` - собрать Angular console и запустить Playwright critical-flow smoke tests.
- `npm run preflight` - проверить конфигурацию, Codex auth, git, Tracker, GitLab и target commands без обработки очереди.
- `npm run memory:validate` - проверить файловое хранилище repository memory.
- `npm run bootstrap:codex-home` - скопировать существующую Codex auth directory в целевой путь или mounted volume.

Проект требует Node.js `>=22.0.0`.

## Основная конфигурация

Минимально нужны:

- `TRACKER_TOKEN`
- `TRACKER_ORG_ID`
- `TRACKER_STATUS_MAP_FILE`
- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`
- `MAX_FIX_ATTEMPTS`
- `WORKER_ID`

Часто настраиваются:

- `TRACKER_TAG=ai_dev`
- `TRACKER_DEFAULT_QUEUE=FRONTEND`
- `REPO_PATH=/workspace/project`
- `BASE_BRANCH=main`
- `GIT_REMOTE_NAME=origin`
- `GIT_REPOSITORY_URL` и `GIT_REPOSITORY_TOKEN` для HTTPS git auth bootstrap.
- `GIT_AUTHOR_NAME` и `GIT_AUTHOR_EMAIL` для commit identity внутри Docker.
- `TEST_COMMAND`, `LINT_COMMAND`, `TYPE_CHECK_COMMAND`, `BUILD_COMMAND` и другие проверки качества целевого репозитория.
- `POLL_INTERVAL_MINUTES=30`
- `CODEX_HOME=/codex-home`
- `CODEX_CLI_COMMAND=codex`
- `CODEX_CLI_ARGS_JSON=[]`
- `CODEX_EXEC_ARGS_JSON=[]`
- `CODEX_SELF_REVIEW_ENABLED=false` - optional pre-publish gate that runs `codex exec review` against `BASE_BRANCH` after quality gates pass.
- `CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS=1` - how many Codex fix attempts are allowed for blocking self-review findings before the worker fails the task.
- `CODEX_SANDBOX=danger-full-access`
- `CODEX_MODEL` и `CODEX_PROFILE`, если нужен явный выбор Codex-конфигурации.
- `TRACKER_IMAGE_CONTEXT_ENABLED=true` для передачи screenshot-вложений Tracker в Codex.
- `TASK_TRACKER_PROVIDER=yandex|internal` - источник runtime-состояния задач.
- `TASK_INTAKE_MODE=standalone|yandex_integration|hybrid|system_only|ai_proposed` для internal tracker.
- `YANDEX_SYNC_ENABLED=true|false` для импорта и зеркалирования Yandex через internal tracker.
- `TASK_TRACKER_DATABASE_URL=postgres://...` для production internal tracker.
- `TASK_TRACKER_UI_ENABLED=true|false`, `TASK_TRACKER_UI_STATIC_DIR=...`, `TASK_TRACKER_SYSTEM_TOKEN` и trusted proxy headers для human UI/API.
- `AI_PROPOSALS_ENABLED`, `AUTO_EXECUTE_LOW_RISK_ENABLED` и лимиты `AI_PROPOSAL_*` для AI-created proposals.
- `WORKER_RUN_ONCE=true|false`
- `WORKER_CONFIG_FILE=/workspace/worker.config.yaml` для fleet mode.

Для Codex CLI `0.142.0` глобальные флаги вроде `--search` и `--ask-for-approval never` должны находиться в `CODEX_CLI_ARGS_JSON`, например:

```json
["--search", "--ask-for-approval", "never"]
```

`CODEX_EXEC_ARGS_JSON` предназначен только для аргументов уровня `codex exec`, например:

```json
["--add-dir", "/workspace/shared"]
```

When a Yandex Tracker issue includes image attachments, the worker downloads supported images to a temporary directory and passes them to `codex exec` with `--image`. The prompt also lists which attachments were included or skipped.

Полная таблица переменных окружения находится в [docs/ENV_CONFIGURATION.md](docs/ENV_CONFIGURATION.md).

## Провайдеры задач

Воркер поддерживает два источника runtime-состояния:

- `TASK_TRACKER_PROVIDER=yandex` - прямой режим совместимости. Очередь, статусы, вопросы, MR metadata и leases хранятся в Yandex Tracker через статусы и structured comments.
- `TASK_TRACKER_PROVIDER=internal` - внутренний task tracker. Каноническая задача, lifecycle, leases, decisions, agent runs, validation results и MR records хранятся во внутренней модели. Для production используйте `TASK_TRACKER_STORAGE=postgres`, примените `npm run tracker:migrate`, затем запускайте `npm run preflight`.

Для internal provider `TASK_INTAKE_MODE` задает, откуда появляются задачи:

- `standalone` - задачи создаются напрямую во внутреннем tracker через UI/API.
- `yandex_integration` - Yandex bridge импортирует задачи из Yandex и зеркалит важные обновления обратно.
- `hybrid` - разрешены и native/internal задачи, и импорт из Yandex.
- `system_only` - задачи создает service account или внешняя automation-система.
- `ai_proposed` - AI создает proposals, а выполнение контролируется policy и approval.

`YANDEX_SYNC_ENABLED=true` допустим только для `yandex_integration` или `hybrid` и требует обычные Yandex credentials. Внутренний tracker не считает GitLab merge сам по себе бизнес-приемкой: merged MR переводит задачу в `human_testing`, а `done` наступает после ручного принятия внешней или внутренней задачи.

## Режимы работы

`TASK_MODE` управляет маршрутизацией задач:

- `auto` - режим по умолчанию; воркер следует структурированному `AI_ANALYSIS`.
- `implement` - принудительно запускает реализацию.
- `decompose` - просит Codex разложить задачу на подзадачи Tracker.
- `analyze_only` - сохраняет анализ и останавливается.
- `human` - переводит задачу в ручное удержание.

### Предварительная проверка постановки задач

`TASK_INTAKE_REVIEW_ENABLED=true` включает отдельный intake-режим для задач с тегом `TASK_INTAKE_REVIEW_TAG`, по умолчанию `ai_task_analysis`. В этом режиме воркер проверяет качество постановки задачи и пишет комментарий `AI TASK REVIEW:` с одним из результатов:

- `ready` - постановка достаточно понятна для разработки.
- `needs_clarification` - автору нужно ответить на конкретные вопросы.
- `needs_decomposition` - задача слишком крупная для одного изменения.
- `reject_as_invalid` - задача не подходит для AI-разработчика в текущем виде.

Первый релиз работает только через комментарии: воркер не меняет описание задачи, не добавляет `ai_dev`, не переводит статус, не создает ветку и не открывает merge request.

Для ручной отладки одной задачи задайте:

```env
TARGET_ISSUE_KEY=FRONTEND-42
WORKER_RUN_ONCE=true
```

В этом режиме воркер загружает только указанную задачу и не сканирует очередь.

## Команды человека

Когда Codex задает вопрос, воркер переводит задачу в ожидание ответа и сохраняет `threadId`. Для возобновления нужна явная команда в новом человеческом комментарии или через internal UI/API:

- `/resume` или `/resume continue` - продолжить с новым контекстом.
- `/resume A` - выбрать вариант из предложенных Codex options.
- `/resume freeform: <ответ>` - передать произвольный ответ; строки после команды также попадут в ответ.
- `/skip` - пропустить текущую задачу без продолжения реализации.
- `/cancel` - отменить обработку задачи.

Обычный комментарий без slash-команды не возобновляет задачу. Это защищает воркер от случайного продолжения после обсуждений, не адресованных AI.

## Telegram Assistant

Telegram Assistant is an optional Bot API surface for internal tracker tasks. It
can answer task status questions, collect write confirmations for task creation
and AI question answers, run project Q&A through Codex, and deliver subscribed
task notifications. It never calls the human TaskTracker API over HTTP; writes go
through the internal `TaskTrackerClient`, and task creation requires
`TASK_TRACKER_PROVIDER=internal`.

Trusted private Telegram users can create executable low/medium-risk tasks after
confirmation. The assistant resolves a repository profile, writes
`repositoryName`, `repoPathKey`, `baseBranch` and `queue`, marks approved tasks
`ready`, and the existing worker queue claims them through
`InternalWorkerOrchestrator`. High-risk private tasks and Business/Profile
automation requests are routed to owner/admin approval before execution.

`TELEGRAM_DIGITAL_TWIN_*` is a strategic Telegram Assistant submode rather than
a simple notification feature. It is intended for Telegram Business/Secretary
chats where the assistant can maintain durable per-contact Codex sessions, reply
on behalf of the owner after explicit access gates, preserve thread continuity
through `runResume`, and keep retention-limited audit records. Keep it disabled
by default, document owner consent before production use, and treat persona,
session reset, audit encryption, and full-text retention settings as part of the
runtime contract.

Use `TELEGRAM_ASSISTANT_BOT_TOKEN` for the assistant. Alert delivery uses the
separate `TELEGRAM_BOT_TOKEN`, even if both variables intentionally contain the
same bot token. Keep allowlists tight: chat/user allowlists grant read access,
while `TELEGRAM_DEVELOPER_USER_IDS`, `TELEGRAM_OPERATOR_USER_IDS`, and
`TELEGRAM_ADMIN_USER_IDS` are required for write confirmations. Group mode
defaults to mentions and replies to align with Telegram privacy mode.

Operational details, metrics, Bot API links, retention behavior, webhook
requirements, Digital Twin sessions, task lifecycle notifications, and
business/profile automation consent rules are documented in
[docs/OBSERVABILITY_RUNBOOK.md](docs/OBSERVABILITY_RUNBOOK.md) and
[docs/LOCAL_DOCKER_RUN.md](docs/LOCAL_DOCKER_RUN.md). The current
Telegram-to-task intake boundary, including trusted private executable intake,
owner approval, and the Digital Twin explicit task proposal path, is documented in
[docs/TELEGRAM_TASK_INTAKE.md](docs/TELEGRAM_TASK_INTAKE.md).

## Проверки качества

Перед публикацией merge request воркер проверяет наличие изменений в целевом репозитории и запускает настроенные проверки качества в порядке:

```text
typecheck -> lint -> tests -> build -> security_scan -> sast -> coverage -> visual_regression
```

`TEST_COMMAND` и `LINT_COMMAND` имеют значения по умолчанию. Остальные проверки включаются только если задана соответствующая переменная с командой. Любой ненулевой exit code блокирует публикацию и передается обратно в Codex fix prompt вместе с stdout/stderr.

When `CODEX_SELF_REVIEW_ENABLED=true`, the worker runs `codex exec review --base <BASE_BRANCH> --uncommitted` after tests/lint/build pass and before publishing the merge request. Blocking review findings are fed back into the existing Codex fix loop, then local quality gates and self-review run again. Human GitLab review remains the source of truth after the MR is published.

### Review task finalization

When a task is in logical `review`, the worker periodically checks the associated GitLab merge request. If GitLab reports the MR as merged, the worker treats that as code-delivery evidence, not human acceptance. In direct Yandex mode, the external issue remains in logical `review`; configure that logical status to the Yandex status `Тестируется`. In internal-tracker mode, the task moves to `human_testing`, which also syncs to external logical `review`. The internal task moves to `done` only after the external Yandex task is manually resolved.

If the MR is closed without merge, the task moves to a human hold state instead of being marked complete. Open MRs keep the existing unresolved review discussion handling.

## Fleet, memory и observability

Fleet mode включается через `WORKER_CONFIG_FILE` и позволяет одному процессу обслуживать несколько репозиториев. Координация между воркерами выполняется через Tracker-комментарии `AI LEASE:`.

Repository memory по умолчанию выключена. При `MEMORY_ENABLED=true` prompts получают компактный repository context из approved rules, manual knowledge и похожих failure entries. Перед production-включением запустите `npm run memory:validate`.

Observability по умолчанию выключена. При `OBSERVABILITY_ENABLED=true` воркер поднимает HTTP-сервер для `/healthz`, `/readyz`, `/metrics` и опциональных оповещений.

Для `TASK_TRACKER_PROVIDER=internal` production mode используйте PostgreSQL, примените `npm run tracker:migrate`, затем `npm run preflight`. Human workflow UI включается через `TASK_TRACKER_UI_ENABLED=true`; Angular UI будет на `/tasks` при configured `TASK_TRACKER_UI_STATIC_DIR`, JSON API начинается с `/api`, а write actions требуют trusted proxy role headers или `TASK_TRACKER_SYSTEM_TOKEN`.

Для локальной разработки UI сначала поднимите Node observability/API server на `127.0.0.1:9464`, затем выполните:

```bash
npm install --prefix web
npm run web:dev
```

Angular dev server будет доступен на `http://127.0.0.1:4200/tasks` и проксирует `/api` в Node server. Production bundle собирается командой `npm run web:build` в `web/dist/task-tracker-console/browser`.

Docker по умолчанию собирает Angular console в image и задает `TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser`. Старый embedded task UI удален: если UI включен без static assets, `/tasks` возвращает явную ошибку, а не fallback HTML. Bearer auth остается задачей backend/service-client или reverse proxy; browser app не хранит bearer tokens.

## Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - карта runtime-потоков, модульных границ и точек изменения.
- [docs/ENV_CONFIGURATION.md](docs/ENV_CONFIGURATION.md) - все переменные окружения и источники значений.
- [docs/FLEET_OPERATIONAL_RUNBOOK.md](docs/FLEET_OPERATIONAL_RUNBOOK.md) - fleet config, leases и операционная координация.
- [docs/MEMORY_LIFECYCLE.md](docs/MEMORY_LIFECYCLE.md) - lifecycle repository memory.
- [docs/OBSERVABILITY_RUNBOOK.md](docs/OBSERVABILITY_RUNBOOK.md) - metrics, probes и alerts.
- [docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md](docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md) - PostgreSQL migrations, retention, backup/restore и rollback для internal tracker.
- [docs/LOCAL_DOCKER_RUN.md](docs/LOCAL_DOCKER_RUN.md) - локальный Docker-запуск и prerequisites.
- [docs/WINDOWS_POWERSHELL_QUICKSTART.md](docs/WINDOWS_POWERSHELL_QUICKSTART.md) - команды для Windows PowerShell.
- [web/README.md](web/README.md) - локальная разработка и сборка Angular human console.
- [docs/CODEX_AUTH_TROUBLESHOOTING.md](docs/CODEX_AUTH_TROUBLESHOOTING.md) - диагностика Codex auth, включая `refresh_token_reused`.
- [docs/CODEX_CLI_UPDATE_RUNBOOK.md](docs/CODEX_CLI_UPDATE_RUNBOOK.md) - обновление Codex CLI и compatibility checks.
- [compose.yaml](compose.yaml) - Compose-конфигурация.
- [AGENTS.md](AGENTS.md) - правила для участников и coding conventions.

## Важные замечания

- Не коммитьте `.env`, `.codex-home/` и любое состояние Codex auth.
- В Docker используйте отдельный writable `CODEX_HOME` volume.
- Целевой репозиторий должен иметь рабочие credentials для `git fetch`, `git pull` и `git push`.
- Если remote целевого репозитория использует SSH, воркер может переписать `origin` на HTTPS и использовать `GIT_REPOSITORY_TOKEN` или `GITLAB_TOKEN`.
- Для commit внутри Docker задайте `GIT_AUTHOR_NAME` и `GIT_AUTHOR_EMAIL` либо настройте `user.name` и `user.email` в целевом checkout.
- Не открывайте `TASK_TRACKER_UI_BIND_HOST=0.0.0.0` без trusted reverse proxy или bearer/system tokens; `localhost` auth mode предназначен только для локальной разработки.
- Dockerfile устанавливает `git`, `curl`, `jq`, `ripgrep`, `openssh-client` и зафиксированную версию `@openai/codex@0.142.0`.
- `CODEX_API_KEY` можно использовать как прямой источник неинтерактивной аутентификации. Если есть только `OPENAI_API_KEY`, заранее сохраните его в `CODEX_HOME` через `printenv OPENAI_API_KEY | codex login --with-api-key`.
