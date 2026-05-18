# AI Developer Worker

Node.js/TypeScript воркер, который опрашивает Yandex Tracker, запускает `codex-cli` в целевом репозитории, валидирует результат и создает или переиспользует merge request в GitLab.

Проект рассчитан на запуск как локально, так и в Docker. Основной сценарий: воркер берет подходящую задачу Tracker, готовит ветку в смонтированном checkout, передает задачу Codex, прогоняет проверки качества, публикует изменения в GitLab и обновляет задачу комментариями/статусами.

## Что делает воркер

За один цикл воркер:

1. Восстанавливает незавершенную задачу текущего `WORKER_ID`, если такая есть.
2. Иначе выбирает подходящую задачу Tracker с учетом lease-aware priority scoring.
3. Делает структурированный анализ задачи, сохраняет комментарий `AI ANALYSIS:` и выбирает режим обработки.
4. Проверяет зависимости `blockedBy` до получения lease и до изменения git-состояния.
5. Переводит задачу по логическим статусам из `TRACKER_STATUS_MAP_FILE`.
6. Готовит ветку `feature/ai-task-{tracker_id}` в локальном checkout целевого репозитория.
7. Запускает `codex exec`, затем настроенные проверки качества.
8. Создает commit, push, merge request и обновляет Tracker.

Если Codex не может продолжить без бизнес-уточнения, он возвращает одну строку `AI_QUESTION:`. Воркер сохраняет `threadId`, переводит задачу в ожидание ответа и позже возобновляет тот же Codex-сеанс после комментария человека.

## Структура проекта

- [src/](src/) - runtime-код воркера.
- [src/domain/](src/domain/) - оркестрация, маршрутизация задач, сборка prompt-ов и проверки качества.
- [src/integrations/](src/integrations/) - адаптеры Tracker, GitLab, Git и Codex.
- [src/observability/](src/observability/) - health/readiness, метрики и оповещения.
- [src/utils/](src/utils/) - запуск shell-команд, retry, логирование и общие helper-ы.
- [tests/](tests/) - unit и smoke tests на Vitest.
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
- `WORKER_RUN_ONCE=true|false`
- `WORKER_CONFIG_FILE=/workspace/worker.config.yaml` для fleet mode.

Для Codex CLI `0.130.0` глобальные флаги вроде `--search` и `--ask-for-approval never` должны находиться в `CODEX_CLI_ARGS_JSON`, например:

```json
["--search", "--ask-for-approval", "never"]
```

`CODEX_EXEC_ARGS_JSON` предназначен только для аргументов уровня `codex exec`, например:

```json
["--add-dir", "/workspace/shared"]
```

When a Yandex Tracker issue includes image attachments, the worker downloads supported images to a temporary directory and passes them to `codex exec` with `--image`. The prompt also lists which attachments were included or skipped.

Полная таблица переменных окружения находится в [docs/ENV_CONFIGURATION.md](docs/ENV_CONFIGURATION.md).

## Режимы работы

`TASK_MODE` управляет маршрутизацией задач:

- `auto` - режим по умолчанию; воркер следует структурированному `AI_ANALYSIS`.
- `implement` - принудительно запускает реализацию.
- `decompose` - просит Codex разложить задачу на подзадачи Tracker.
- `analyze_only` - сохраняет анализ и останавливается.
- `human` - переводит задачу в ручное удержание.

Для ручной отладки одной задачи задайте:

```env
TARGET_ISSUE_KEY=FRONTEND-42
WORKER_RUN_ONCE=true
```

В этом режиме воркер загружает только указанную задачу и не сканирует очередь.

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

Docker builds the Angular console into the image by default and sets
`TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser`.
The old embedded task UI is removed; if the UI is enabled without static assets,
`/tasks` returns a clear error instead of fallback HTML. Bearer auth remains a
backend/service-client or reverse-proxy concern; the browser app does not store
bearer tokens.

## Документация

- [docs/ENV_CONFIGURATION.md](docs/ENV_CONFIGURATION.md) - все переменные окружения и источники значений.
- [docs/FLEET_OPERATIONAL_RUNBOOK.md](docs/FLEET_OPERATIONAL_RUNBOOK.md) - fleet config, leases и операционная координация.
- [docs/MEMORY_LIFECYCLE.md](docs/MEMORY_LIFECYCLE.md) - lifecycle repository memory.
- [docs/OBSERVABILITY_RUNBOOK.md](docs/OBSERVABILITY_RUNBOOK.md) - metrics, probes и alerts.
- [docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md](docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md) - PostgreSQL migrations, retention, backup/restore и rollback для internal tracker.
- [docs/LOCAL_DOCKER_RUN.md](docs/LOCAL_DOCKER_RUN.md) - локальный Docker-запуск и prerequisites.
- [docs/WINDOWS_POWERSHELL_QUICKSTART.md](docs/WINDOWS_POWERSHELL_QUICKSTART.md) - команды для Windows PowerShell.
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
- Dockerfile устанавливает `git`, `curl`, `jq`, `ripgrep`, `openssh-client` и зафиксированную версию `@openai/codex@0.130.0`.
- `CODEX_API_KEY` можно использовать как прямой источник неинтерактивной аутентификации. Если есть только `OPENAI_API_KEY`, заранее сохраните его в `CODEX_HOME` через `printenv OPENAI_API_KEY | codex login --with-api-key`.
