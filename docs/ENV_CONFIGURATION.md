# Руководство по настройке окружения

Это руководство объединяет все переменные окружения, которые используются кодом воркера и вспомогательными скриптами в этом репозитории.

Конфигурация приложения во время выполнения загружается в [src/config.ts](/C:/Users/gabba/projects/developer/src/config.ts). Интеграция merge request с GitLab реализована в [src/integrations/gitlab/client.ts](/C:/Users/gabba/projects/developer/src/integrations/gitlab/client.ts) и использует только:

- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`

Воркер не читает переменные GitLab CI/CD из проекта автоматически. Значения нужно передавать через `.env`, контейнерный `--env-file` или явные переопределения `-e KEY=value`.

## Как собрать `.env`

1. Скопируйте шаблон:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

2. Заполните обязательные значения из таблицы ниже.
3. Оставьте необязательные значения без изменений, если не нужно переопределять значения по умолчанию.
4. Запустите однократный старт с `WORKER_RUN_ONCE=true`, чтобы проверить конфигурацию перед включением цикла опроса.

Для статусов Tracker в репозитории уже есть пример файла [config/trackerStatusMap.example.json](/C:/Users/gabba/projects/developer/config/trackerStatusMap.example.json). В `.env` укажите путь к нему в `TRACKER_STATUS_MAP_FILE`, а затем замените примерные статусы и подсказки переходов на реальные значения из вашего рабочего процесса в Tracker.

## Переменные времени выполнения, используемые воркером

| Переменная | Обязательная | По умолчанию | Как получить значение |
| --- | --- | --- | --- |
| `TRACKER_TOKEN` | Да | Не задано | Создайте или используйте существующий Yandex Tracker API token для сервисного аккаунта или пользователя, который должен читать задачи, публиковать комментарии и менять статусы. |
| `TRACKER_ORG_ID` | Да | Не задано | Возьмите organization ID, соответствующий вашей установке Tracker. Он должен соответствовать типу заголовка в `TRACKER_ORG_HEADER`. |
| `TRACKER_ORG_HEADER` | Нет | `X-Cloud-Org-ID` | Оставьте значение по умолчанию для Yandex Cloud Tracker. Используйте `X-Org-ID` только если ваша установка Tracker требует этот заголовок. |
| `TRACKER_DEFAULT_QUEUE` | Нет | `FRONTEND` | Укажите ключ очереди Tracker, которую должен опрашивать воркер. Его можно взять в настройках очереди в Tracker. |
| `TRACKER_TAG` | Нет | `ai_dev` | Выберите тег задач, который помечает задачи как подходящие для воркера. Создайте тег в Tracker, если его еще нет. |
| `TRACKER_API_BASE_URL` | Нет | `https://api.tracker.yandex.net/v3` | Оставьте значение по умолчанию, если не используете нестандартный endpoint Tracker или тестовый stub. |
| `TRACKER_STATUS_MAP_FILE` | Да | Не задано | Путь к JSON-файлу, который сопоставляет логические состояния воркера с реальными статусами Tracker. Значения `statuses` в этом файле должны точно совпадать с названиями статусов задач, видимыми в Tracker. |
| `TRACKER_IMAGE_CONTEXT_ENABLED` | Нет | `true` | Downloads supported image attachments from Yandex Tracker and passes them to Codex as image inputs. |
| `TRACKER_IMAGE_CONTEXT_MAX_COUNT` | Нет | `5` | Maximum number of image attachments per Codex run. |
| `TRACKER_IMAGE_CONTEXT_MAX_BYTES` | Нет | `10485760` | Maximum accepted size per image attachment. Larger images are skipped and named in the prompt summary. |
| `TRACKER_IMAGE_CONTEXT_TEMP_DIR` | Нет | OS temp directory | Directory for temporary downloaded images. Do not set this inside the target repository checkout. |
| `GITLAB_URL` | Да | Не задано | Укажите базовый URL вашего GitLab instance, например `https://gitlab.example.com`. Не добавляйте `/api/v4`; клиент добавляет эту часть сам. |
| `GITLAB_TOKEN` | Да | Не задано | Создайте GitLab access token, который может читать и создавать merge requests, читать MR discussions, читать текущего пользователя и публиковать ответы в discussions целевого проекта. Для одного репозитория лучше использовать GitLab project access token, а не personal token. На практике дайте ему scope `api` и доступ на запись в репозиторий этого проекта. |
| `GITLAB_PROJECT_ID` | Да | Не задано | Используйте числовой или URL-encoded project ID, который принимает GitLab REST API. Его можно скопировать со страницы проекта или получить через GitLab API, если известен project path. |
| `GIT_AUTHOR_NAME` | Нет | Не задано | Необязательное имя автора git commit для процесса воркера. Используйте в Docker, если в смонтированном репозитории еще не задано `git config user.name`. |
| `GIT_AUTHOR_EMAIL` | Нет | Не задано | Необязательный email автора git commit для процесса воркера. Используйте в Docker, если в смонтированном репозитории еще не задано `git config user.email`. |
| `GIT_COMMIT_NO_VERIFY` | Нет | `true` | Управляет тем, использует ли воркер `git commit --no-verify` при создании commit. Оставьте значение по умолчанию, если намеренно не хотите запускать git hooks целевого репозитория, например `husky` или `lint-staged`. |
| `REPO_PATH` | Нет | `/workspace/project` | Оставьте значение по умолчанию в Docker. Переопределяйте только если воркер должен использовать другой локальный путь checkout. |
| `BASE_BRANCH` | Нет | `main` | Задайте ветку, в которую должны целиться feature branches и merge requests. |
| `POLL_INTERVAL_MINUTES` | Нет | `30` | Выберите частоту опроса Tracker воркером. Значение должно быть положительным целым числом. |
| `WORKER_CONFIG_FILE` | Нет | Не задано | Необязательная fleet-конфигурация YAML или JSON. Если она не указана, значения из `.env` преобразуются в один профиль репозитория по умолчанию. См. [docs/FLEET_OPERATIONAL_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/FLEET_OPERATIONAL_RUNBOOK.md). |
| `LOCK_BACKEND` | Нет | `tracker` | Backend координации. `tracker` пишет lease-комментарии в Tracker; `none` отключает locks и не пишет `AI LEASE:` comments, что подходит только для одного worker-а. `redis` и `postgres` зарезервированы и завершаются ошибкой до реализации. |
| `LOCK_TTL_SECONDS` | Нет | `900` | Lease TTL для task и repository locks. Истекшие leases не блокируют другого воркера. |
| `LOCK_HEARTBEAT_SECONDS` | Нет | `60` | Интервал продления lease во время работы Codex, validation и publish. |
| `LOCK_REDIS_URL` | Нет | Не задано | Зарезервировано для будущего Redis lock backend. |
| `LOCK_POSTGRES_URL` | Нет | Не задано | Зарезервировано для будущего PostgreSQL lock backend. |
| `CODEX_HOME` | Нет | `~/.codex` на текущей машине | Используйте writable Codex auth directory. В Docker обычно это должен быть путь смонтированного volume, например `/codex-home`. |
| `CODEX_CLI_COMMAND` | Нет | `codex` | Укажите executable, который запускает Codex CLI. Оставьте `codex`, если не нужен wrapper launcher. |
| `CODEX_CLI_ARGS_JSON` | Нет | `[]` | JSON-массив launcher/global аргументов Codex, передаваемых перед `exec`. Используйте для flags вроде `--search` или `--ask-for-approval never`. |
| `CODEX_MODEL` | Нет | Не задано | Необязательное явное имя модели Codex, если нужны воспроизводимые запуски. |
| `CODEX_PROFILE` | Нет | Не задано | Необязательное имя profile из локальной конфигурации Codex. |
| `CODEX_SANDBOX` | Нет | `danger-full-access` | Выберите одно из значений: `read-only`, `workspace-write` или `danger-full-access`. |
| `CODEX_EXEC_ARGS_JSON` | Нет | `[]` | JSON-массив дополнительных аргументов, которые принимает `codex exec --help`, например `--add-dir /workspace/shared`. Не помещайте сюда launcher/global flags. |
| `CODEX_TIMEOUT_SECONDS` | Нет | `1800` | Жесткий timeout для одного процесса `codex exec`. Если timeout достигнут, воркер завершает этот процесс Codex и считает запуск неуспешным. |
| `CODEX_LOG_FULL_EVENTS` | Нет | `false` | Если `true`, воркер логирует каждое сырое JSONL-событие, которое выводит `codex exec --json`. Включайте это для отладки на уровне контейнера, если сводок по умолчанию недостаточно. |
| `CODEX_QUESTION_MARKER` | Нет | `AI_QUESTION:` | Оставьте значение по умолчанию, если намеренно не меняли протокол комментариев воркера. |
| `TASK_MODE` | Нет | `auto` | Режим маршрутизации Phase 4. `auto` следует структурированному `AI_ANALYSIS`; `implement` принудительно запускает реализацию; `decompose` запускает декомпозицию; `analyze_only` записывает метаданные анализа и останавливается; `human` переводит задачи в ручное удержание. |
| `CONFIDENCE_IMPLEMENT_THRESHOLD` | Нет | `70` | Минимальная confidence из анализа для автоматической реализации в `TASK_MODE=auto`. |
| `CONFIDENCE_HUMAN_THRESHOLD` | Нет | `40` | Если confidence анализа ниже этого значения, задача направляется в ручное удержание. |
| `CONFIDENCE_PRIORITY_WEIGHT` | Нет | `2` | Множитель, используемый fleet priority scoring, когда у задачи уже есть комментарий `AI ANALYSIS`. |
| `DECOMPOSITION_MAX_SUBTASKS` | Нет | `8` | Максимальное количество subtasks, принимаемых из плана `AI_DECOMPOSITION`. |
| `DECOMPOSITION_CREATE_ISSUES` | Нет | `true` | Если `false`, decomposition пишет dry-run комментарий вместо создания задач Tracker. |
| `DECOMPOSITION_DRY_RUN` | Нет | `false` | Принудительно заставляет декомпозицию записать только предложенный план. |
| `DECOMPOSITION_DEFAULT_SUBTASK_TAG` | Нет | `ai_dev` | Тег, добавляемый к Tracker sub-issues, созданным decomposition. |
| `DECOMPOSITION_SUBTASK_TITLE_PREFIX` | Нет | `[AI split]` | Префикс, добавляемый к заголовкам созданных sub-issues. |
| `TRACKER_PARENT_LINK_TYPE` | Нет | `relates` | Связь Tracker, используемая для привязки decomposition sub-issues к родительской задаче. |
| `TRACKER_BLOCKED_BY_LINK_TYPE` | Нет | `is blocked by` | Связь Tracker, используемая для dependency links и dependency filtering. |
| `DEPENDENCY_ENFORCEMENT` | Нет | `true` | Если включено, задачи с unresolved dependencies `blockedBy` пропускаются до получения lease. |
| `DEPENDENCY_UNKNOWN_STATUS_POLICY` | Нет | `block` | Политика для dependencies, чей статус нельзя определить: `block`, `warn` или `ignore`. |
| `TASK_TRACKER_PROVIDER` | Нет | `yandex` | Runtime provider: `yandex` сохраняет прямой Tracker fallback, `internal` включает внутренний task tracker. |
| `TASK_TRACKER_STORAGE` | Нет | `postgres` | Storage adapter для internal provider. `memory` разрешен только в `NODE_ENV=test` или `TASK_TRACKER_LOCAL_SMOKE=true`. |
| `TASK_TRACKER_DATABASE_URL` | Да для internal/postgres | Не задано | PostgreSQL URL внутреннего task tracker. Перед запуском примените `npm run tracker:migrate`. |
| `TASK_INTAKE_MODE` | Нет | `standalone` | Intake mode internal tracker: `standalone`, `yandex_integration`, `hybrid`, `system_only` или `ai_proposed`. |
| `YANDEX_SYNC_ENABLED` | Нет | `false` | Включает Yandex bridge как source/mirror для internal tracker. Требует Yandex credentials и intake `yandex_integration` или `hybrid`. |
| `TASK_TRACKER_RETENTION_RAW_LOG_DAYS` | Нет | `30` | Retention для raw Codex log artifacts. |
| `TASK_TRACKER_RETENTION_ARTIFACT_DAYS` | Нет | `30` | Retention для обычных validation artifacts. |
| `TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS` | Нет | `90` | Retention для validation artifacts failed tasks. Не может быть меньше обычного artifact retention. |
| `TASK_TRACKER_RETENTION_HISTORY_DAYS` | Нет | `365` | Минимальный retention compact task history. Значение меньше 365 отклоняется. |
| `TASK_TRACKER_CLEANUP_ENABLED` | Нет | `true` | Включает periodic cleanup job для expired artifacts, raw logs, released leases и stale proposals. |
| `TASK_TRACKER_CLEANUP_INTERVAL_SECONDS` | Нет | `3600` | Интервал cleanup job. |
| `TASK_TRACKER_METRICS_ENABLED` | Нет | `true` | Включает internal tracker metrics: queue depth, claim latency, sync, proposals и cleanup. |
| `TASK_TRACKER_REDACTION_ENABLED` | Нет | `true` | Включает redaction перед записью task events/comments/diagnostics и digest export. |
| `MEMORY_ENABLED` | Нет | `false` | Включает repository memory Phase 5. Оставьте выключенным, пока `npm run memory:validate` не проходит для `MEMORY_DIR`. |
| `MEMORY_DIR` | Нет | `/workspace/ai-developer-memory` | Локальное хранилище memory вне целевого репозитория. Воркер пишет per-repository файлы в `repositories/<sanitized RepositoryProfile.name>/`. |
| `MEMORY_MAX_CONTEXT_CHARS` | Нет | `6000` | Жесткий лимит символов для секции memory context, добавляемой в analysis и implementation prompts. |
| `MEMORY_STRICT` | Нет | `false` | Если `false`, поврежденная repository memory отключается с warning. Если `true`, invalid memory блокирует обработку. |
| `MEMORY_INCLUDE_DRAFT_RULES` | Нет | `false` | Включает draft prompt rules в prompts. Оставьте выключенным для обычной работы; approved rules включаются автоматически. |
| `MEMORY_SIMILAR_FAILURE_LIMIT` | Нет | `3` | Максимальное количество similar failure memory entries, включаемых в один prompt context bundle. |
| `MEMORY_BOOTSTRAP_ON_START` | Нет | `false` | Зарезервировано для post-MVP bootstrap flow. MVP проверяет storage и потребляет manually maintained memory. |
| `MEMORY_REFRESH_ON_PREFLIGHT` | Нет | `false` | Зарезервировано для post-MVP refresh flow. Legacy-опечатка `MEMORY_REFRESH_ON_PRELIGHT` тоже принимается. |
| `MEMORY_BOOTSTRAP_CODEX_SANDBOX` | Нет | `inherit` | Зарезервировано для bootstrap. Допустимые значения: `inherit`, `read-only`, `workspace-write` и `danger-full-access`. |
| `OBSERVABILITY_ENABLED` | Нет | `false` | Запускает HTTP-сервер observability Phase 6 для health, readiness, metrics, dashboard API и alerts. |
| `OBSERVABILITY_HOST` | Нет | `127.0.0.1` | Interface для observability server. Используйте `0.0.0.0` только в trusted internal networks или за private proxy. |
| `OBSERVABILITY_PORT` | Нет | `9464` | Порт для всех observability endpoints. `METRICS_PORT` принимается как backward-compatible alias. |
| `OBSERVABILITY_BASE_URL` | Нет | `http://<host>:<port>` | Base URL, используемый HTTP router и alert dashboard links. |
| `OBSERVABILITY_STRICT_STARTUP` | Нет | `true` | Если `true`, ошибка привязки порта приводит к startup failure. Если `false`, воркер логирует warning и продолжает обработку. |
| `OBSERVABILITY_REDACT_MAX_CHARS` | Нет | `4000` | Максимальная длина diagnostic после secret redaction в events, API payloads и alerts. |
| `METRICS_ENABLED` | Нет | `true` | Включает Prometheus text output на observability server. |
| `METRICS_PATH` | Нет | `/metrics` | Path для Prometheus text exposition. |
| `HEALTH_PATH` | Нет | `/healthz` | Path liveness endpoint. |
| `READY_PATH` | Нет | `/readyz` | Path readiness endpoint. |
| `OBSERVABILITY_EVENT_STORE` | Нет | `memory` | Backend event store: `memory` или `file`. |
| `OBSERVABILITY_EVENT_STORE_FILE` | Нет | Не задано | JSONL-файл, используемый при `OBSERVABILITY_EVENT_STORE=file`. |
| `OBSERVABILITY_EVENT_RETENTION` | Нет | `1000` | Ограниченное количество последних событий, сохраняемых в памяти. |
| `DASHBOARD_ENABLED` | Нет | `false` | Включает read-only dashboard и endpoints `/api/*`. |
| `DASHBOARD_PATH` | Нет | `/dashboard` | HTML path dashboard. |
| `DASHBOARD_REFRESH_SECONDS` | Нет | `10` | Browser polling interval для обновления dashboard API. |
| `DASHBOARD_API_PATH` | Нет | `/api` | Read-only dashboard API path prefix. |
| `DASHBOARD_BEARER_TOKEN` | Нет | Не задано | Необязательный bearer token, защищающий `/dashboard` и `/api/*`. |
| `TASK_TRACKER_UI_ENABLED` | Нет | `false` | Включает Angular human UI/API для internal tracker workflows. Может поднять HTTP-сервер даже при `OBSERVABILITY_ENABLED=false`. |
| `TASK_TRACKER_UI_BIND_HOST` | Нет | `127.0.0.1` | Alias для bind host HTTP-сервера при включении task tracker UI. |
| `TASK_TRACKER_UI_PORT` | Нет | `9464` | Alias для порта HTTP-сервера при включении task tracker UI. |
| `TASK_TRACKER_UI_PATH` | Нет | `/tasks` | HTML path для human task UI. |
| `TASK_TRACKER_UI_API_PATH` | Нет | `/api` | JSON API prefix для human task API. |
| `TASK_TRACKER_UI_ASSET_PATH` | Нет | `/tasks/assets` | Path для Angular assets. Должен находиться внутри `TASK_TRACKER_UI_PATH`. |
| `TASK_TRACKER_UI_STATIC_DIR` | Нет | Не задано | Директория built Angular bundle, обычно `web/dist/task-tracker-console/browser`. Если задана, startup проверяет наличие `index.html`. |
| `TASK_TRACKER_HUMAN_AUTH_MODE` | Нет | `trusted_proxy` | Auth mode для UI/API: `trusted_proxy`, `bearer` или local-only `localhost`. |
| `TASK_TRACKER_TRUSTED_USER_HEADER` | Нет | `x-task-tracker-user` | Header с authenticated user от trusted reverse proxy. |
| `TASK_TRACKER_TRUSTED_ROLE_HEADER` | Нет | `x-task-tracker-role` | Header с ролью `viewer`, `developer`, `operator` или `admin`. |
| `TASK_TRACKER_AGENT_TOKEN` | Нет | Не задано | Bearer token для agent/service operational access к human API. |
| `TASK_TRACKER_SYSTEM_TOKEN` | Нет | Не задано | Bearer token для system-created task API и idempotent bulk/create paths. |
| `ALERTS_ENABLED` | Нет | `false` | Включает event-based alert evaluation и notification sinks. |
| `ALERT_CHANNELS` | Нет | Не задано | Channels через запятую: `webhook`, `slack`, `telegram`. |
| `ALERT_WEBHOOK_URL` | Нет | Не задано | Generic JSON webhook URL для `ALERT_CHANNELS=webhook`. |
| `SLACK_WEBHOOK_URL` | Нет | Не задано | Slack incoming webhook URL для `ALERT_CHANNELS=slack`. |
| `TELEGRAM_BOT_TOKEN` | Нет | Не задано | Telegram bot token для `ALERT_CHANNELS=telegram`. |
| `TELEGRAM_CHAT_ID` | Нет | Не задано | Telegram chat id для `ALERT_CHANNELS=telegram`. |
| `ALERT_MIN_SEVERITY` | Нет | `warning` | Минимальная severity для уведомлений: `info`, `warning` или `error`. |
| `ALERT_DEDUP_WINDOW_SECONDS` | Нет | `900` | Подавляет повторяющиеся alerts с одинаковым ключом rule/repository/issue/stage. |
| `ALERT_QUEUE_BLOCKED_CYCLES` | Нет | `3` | Количество queue-blocked cycles перед отправкой warning alert. |
| `ALERT_CODEX_TIMEOUT_WINDOW_SECONDS` | Нет | `3600` | Rolling window для повторяющихся Codex timeout alerts. |
| `ALERT_CODEX_TIMEOUT_THRESHOLD` | Нет | `3` | Количество timeouts, необходимое внутри rolling window. |
| `ALERT_VALIDATION_FAILURE_WINDOW_SECONDS` | Нет | `3600` | Rolling window для повторяющихся validation failure alerts. |
| `ALERT_VALIDATION_FAILURE_THRESHOLD` | Нет | `3` | Количество validation failures, необходимое внутри rolling window. |
| `ALERT_WORKER_STALE_SECONDS` | Нет | `300` | Зарезервированный threshold для worker stale snapshots. |
| `TEST_COMMAND` | Нет | `npm test` | Задайте точную test command, которая должна запускаться внутри смонтированного целевого репозитория. |
| `LINT_COMMAND` | Нет | `npm run lint` | Задайте точную lint command, которая должна запускаться внутри смонтированного целевого репозитория. |
| `TYPE_CHECK_COMMAND` | Нет | Не задано | Необязательный typecheck gate. Если задан, запускается перед lint и tests и блокирует publish при ошибке. |
| `BUILD_COMMAND` | Нет | Не задано | Необязательный build gate. Если задан, запускается после lint/tests и блокирует publish при ошибке. |
| `SECURITY_SCAN_COMMAND` | Нет | Не задано | Необязательный command-based security scan gate, например `npm audit --audit-level=high`. Ненулевой exit блокирует publish. |
| `SAST_COMMAND` | Нет | Не задано | Необязательный command-based SAST gate, например `semgrep ci`. Output сохраняется как generic diagnostic text. |
| `COVERAGE_COMMAND` | Нет | Не задано | Необязательная coverage gate command. Воркер ожидает Istanbul/Vitest-style summary из `COVERAGE_REPORT_FILE` или stdout. |
| `MIN_COVERAGE_PERCENT` | Нет | Не задано | Необязательный threshold общего line coverage от `0` до `100`. Если задан, более низкое coverage блокирует publish. |
| `COVERAGE_REPORT_FILE` | Нет | Не задано | Необязательный path к coverage summary относительно `REPO_PATH`, например `coverage/coverage-summary.json`. Предпочтительнее, чем parsing stdout. |
| `VISUAL_REGRESSION_COMMAND` | Нет | Не задано | Необязательный command-based visual regression gate. Воркер не предполагает наличие Playwright или конкретного frontend stack. |
| `VISUAL_REGRESSION_ARTIFACTS_DIR` | Нет | Не задано | Необязательный artifact path, включаемый в validation summaries и MR notes, когда visual regression gate настроен. |
| `MAX_FIX_ATTEMPTS` | Да | Не задано | Положительное целое число. Выберите, сколько automated fix attempts воркер может выполнить для одной задачи. |
| `MAX_REVIEW_FIX_ATTEMPTS` | Нет | `MAX_FIX_ATTEMPTS` | Положительное целое число. Выберите, сколько validation repair attempts воркер может выполнить при обработке unresolved GitLab review discussions. |
| `WORKER_ID` | Да | Не задано | Стабильный идентификатор этого экземпляра воркера. Используйте уникальное значение для каждого запущенного воркера, например `worker-1` или `gitlab-bot-prod-1`. |
| `WORKER_RUN_ONCE` | Нет | `false` | Установите `true` для single validation cycle или local smoke run. |
| `WORKER_PREFLIGHT_ONLY` | Нет | `false` | Установите `true`, чтобы выполнить только preflight report и выйти без обработки задач Tracker. `npm run preflight` включает этот режим автоматически. |
| `TRACKER_PREFLIGHT_ISSUE_KEY` | Нет | Не задано | Необязательный sandbox Tracker issue key. Если задан, preflight проверяет write permission, добавляя нейтральный комментарий к этой задаче. Если не задан, Tracker write preflight получает статус `WARN`, и запись не выполняется. |
| `GITLAB_PREFLIGHT_SOURCE_BRANCH` | Нет | Не задано | Необязательная sandbox source branch. Если задана, preflight находит или создает draft/test merge request из этой ветки, чтобы проверить MR write permission. Если не задана, GitLab write preflight получает статус `WARN`, и запись не выполняется. |
| `PREFLIGHT_RUN_TARGET_COMMANDS` | Нет | `true` | Управляет тем, запускает ли preflight `TEST_COMMAND` и `LINT_COMMAND` в `REPO_PATH`. Установите `false`, если эти команды слишком дорогие для startup check. |
| `TARGET_ISSUE_KEY` | Нет | Не задано | Режим ручного запуска. Если задан, `WorkerOrchestrator.runOnce()` загружает только эту задачу Tracker, пропускает обычный queue scan и все равно соблюдает structured worker locks. |

## Режим preflight

Запустите безопасный preflight report:

```bash
npm run preflight
```

или:

```bash
WORKER_PREFLIGHT_ONLY=true npm run dev
```

PowerShell:

```powershell
$env:WORKER_PREFLIGHT_ONLY = "true"
npm run dev
```

Report всегда использует такой порядок: загрузка конфигурации, Codex auth, условная проверка Codex image input при `TRACKER_IMAGE_CONTEXT_ENABLED=true`, git repository, Tracker read, Tracker write, GitLab read, GitLab write, target commands. Отсутствие `TRACKER_PREFLIGHT_ISSUE_KEY` или `GITLAB_PREFLIGHT_SOURCE_BRANCH` не проваливает preflight; эти write checks получают статус `WARN`, и production issue или merge request не изменяются.

Для strict sandbox run задайте обе sandbox-переменные:

```env
TRACKER_PREFLIGHT_ISSUE_KEY=FRONTEND-42
GITLAB_PREFLIGHT_SOURCE_BRANCH=preflight/worker-check
```

`PREFLIGHT_RUN_TARGET_COMMANDS=false` пропускает `TEST_COMMAND` и `LINT_COMMAND` и помечает эту проверку как `WARN`.

## Проверки качества

Перед публикацией или обновлением merge request воркер сначала проверяет, что в целевом репозитории есть изменения. Затем он запускает quality gates в таком fail-fast порядке:

```text
typecheck -> lint -> tests -> build -> security_scan -> sast -> coverage -> visual_regression
```

`LINT_COMMAND` и `TEST_COMMAND` сохраняют значения по умолчанию. Остальные gates пропускаются, если соответствующая command environment variable не задана. Любой configured gate с ненулевым exit блокирует publish и передает gate command, stdout и stderr обратно в Codex fix prompt.

Coverage parsing поддерживает такой Istanbul/Vitest-style summary:

```json
{
  "total": {
    "lines": {
      "pct": 82.5
    }
  }
}
```

По возможности задайте `COVERAGE_REPORT_FILE`, чтобы воркер читал стабильный report file из `REPO_PATH`. Если он не задан, воркер пытается разобрать stdout coverage command как JSON той же формы.

## Режим целевой задачи

Используйте этот режим для ручной отладки одной задачи Tracker:

```env
TARGET_ISSUE_KEY=FRONTEND-42
WORKER_RUN_ONCE=true
```

Когда `TARGET_ISSUE_KEY` задан, воркер не вызывает обычный queue/tag candidate search. Он загружает целевую задачу напрямую, проверяет structured `AI STATUS` locks, возобновляет только подходящие `/resume` clarification flows и обрабатывает unresolved GitLab review discussions, если целевая задача уже находится в `review`.

## Phase 4: маршрутизация задач

Перед реализацией Codex теперь должен вернуть одну структурированную строку:

```text
AI_ANALYSIS: {"confidence":82,"taskType":"frontend_ui_fix","recommendedMode":"implement","promptProfileId":"frontend_ui_fix",...}
```

Воркер сохраняет это решение как комментарий Tracker `AI ANALYSIS:` и использует его для маршрутизации и восстановления после перезапуска. Невалидный analysis output безопасно переводит задачу в manual hold.

`TASK_MODE=auto` применяет confidence thresholds. Low-confidence tasks ниже `CONFIDENCE_HUMAN_THRESHOLD` переходят в `waiting_for_answer` с `manual_hold`. Задачи ниже `CONFIDENCE_IMPLEMENT_THRESHOLD` не начинают implementation, если явно не задан `TASK_MODE=implement`.

`TASK_MODE=decompose` или analysis decision с `recommendedMode=decompose` запускает decomposition prompt. `DECOMPOSITION_DRY_RUN=true` записывает предложенный план как комментарий `AI DECOMPOSITION:` без создания задач. Create mode использует Tracker issue creation, а также `TRACKER_PARENT_LINK_TYPE` и `TRACKER_BLOCKED_BY_LINK_TYPE` для parent/dependency links.

Dependency filtering выполняется до получения leases. Воркер читает issue fields `blockedBy` и Tracker links, когда они доступны; blockers должны иметь логический статус `done`, если `DEPENDENCY_UNKNOWN_STATUS_POLICY` не ослаблена.

## Phase 5: MVP memory

Repository memory по умолчанию выключена. Когда `MEMORY_ENABLED=true`, analysis и implementation prompts получают компактную секцию `Repository context`, собранную из approved `prompt-rules.json`, manual `knowledge.json` и similar `failures.jsonl` entries. Fix, review-fix, decomposition, bootstrap и review-learning promotion намеренно не входят в MVP path.

Перед включением memory в production запустите `npm run memory:validate`. Lifecycle, schema examples, approval workflow и cleanup procedure описаны в [docs/MEMORY_LIFECYCLE.md](/C:/Users/gabba/projects/developer/docs/MEMORY_LIFECYCLE.md).

## Phase 6: MVP observability

Observability по умолчанию выключена. Когда `OBSERVABILITY_ENABLED=true`, воркер запускает один HTTP-сервер для `/healthz`, `/readyz`, `/metrics`, optional dashboard/API и optional alerts. Сервер стартует до startup checks, а readiness становится `ok` только после успешных проверок repository и Codex auth.

Рекомендуемый rollout:

```env
OBSERVABILITY_ENABLED=true
METRICS_ENABLED=true
DASHBOARD_ENABLED=false
ALERTS_ENABLED=false
```

Затем включите dashboard на trusted interface:

```env
DASHBOARD_ENABLED=true
DASHBOARD_BEARER_TOKEN=change-me
```

Полные endpoint contracts, Prometheus scrape examples, Docker/Compose snippets и alert setup описаны в [docs/OBSERVABILITY_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/OBSERVABILITY_RUNBOOK.md).

## Phase 8D: Angular internal task UI

При `TASK_TRACKER_PROVIDER=internal` можно включить human UI/API. Angular
console является primary human UI; старый embedded HTML task UI удален.

```env
TASK_TRACKER_UI_ENABLED=true
TASK_TRACKER_UI_BIND_HOST=127.0.0.1
TASK_TRACKER_UI_PORT=9464
TASK_TRACKER_UI_STATIC_DIR=web/dist/task-tracker-console/browser
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy
TASK_TRACKER_SYSTEM_TOKEN=change-me
```

UI доступен на `/tasks`, JSON API - на `/api`, Angular assets - на
`/tasks/assets`. Deep links вроде `/tasks/ready-task` обслуживаются через
Angular `index.html`; `/api`, `/metrics`, `/healthz` и `/readyz` остаются
backend routes. Если `TASK_TRACKER_UI_ENABLED=true`, но
`TASK_TRACKER_UI_STATIC_DIR` не задан, `/tasks` возвращает явный `503` вместо
fallback UI, а JSON API routes продолжают работать.

Angular dev server proxies `/api` к Node.js server:

```bash
npm install --prefix web
npm run web:dev
```

Production bundle build and checks:

```bash
npm run web:typecheck
npm run web:test
npm run web:build
npm run web:e2e
```

Docker builds the Angular bundle into the image and sets
`TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser`.
Self-hosted deployments may still mount a prebuilt bundle at that path or
override the variable.

Mutations require backend authorization. Browser deployments should use
trusted proxy headers or localhost development mode. Bearer mode is intended
for service clients or a reverse proxy that injects `Authorization`; the
Angular app does not store bearer tokens in browser storage.

## Phase 7H: internal tracker hardening

Production internal mode requires PostgreSQL, applied migrations, and passing
preflight:

```bash
npm run tracker:migrate
npm run preflight
```

`TASK_TRACKER_STORAGE=memory` остается только для unit tests и local smoke.
Cleanup, retention, redaction, metrics, backup/restore и rollback описаны в
[docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md).

## Режим fleet

Задайте `WORKER_CONFIG_FILE` с YAML- или JSON-файлом, когда один процесс воркера должен управлять несколькими репозиториями. Config file содержит repository-specific values, такие как `repoPath`, `gitlabProjectId`, queues, tags, base branch и quality gate commands. Global secrets по-прежнему можно ссылать через переменные окружения с полями вроде `tracker.tokenEnv`, `tracker.orgIdEnv`, `gitlab.urlEnv` и `gitlab.tokenEnv`.

Fleet mode использует комментарии Tracker `AI LEASE:` для task и repository leases. Task lease предотвращает duplicate processing одной задачи, а repository lease сериализует mutations одного и того же checkout path. Полные examples и caveats находятся в [docs/FLEET_OPERATIONAL_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/FLEET_OPERATIONAL_RUNBOOK.md).

## Формат `TRACKER_STATUS_MAP_FILE`

Файл должен содержать JSON object со всеми шестью логическими состояниями, которые использует воркер:

- `open`
- `in_progress`
- `waiting_for_answer`
- `review`
- `failed`
- `done`

Пример:

```json
{
  "open": {
    "statuses": ["Open"]
  },
  "in_progress": {
    "statuses": ["In Progress"],
    "transition": "start"
  },
  "waiting_for_answer": {
    "statuses": ["Waiting for answer"],
    "transition": "need-info"
  },
  "review": {
    "statuses": ["In Review"],
    "transition": "review"
  },
  "failed": {
    "statuses": ["Failed"],
    "transition": "fail"
  },
  "done": {
    "statuses": ["Done"],
    "transition": "done"
  }
}
```

`statuses` используются, чтобы распознать текущее состояние задачи. `transition` является подсказкой для выбора одного из transitions, которые Tracker возвращает для этой задачи.

## Дополнительные переменные, используемые вне `src/config.ts`

Они не входят в основной runtime config object, но все равно читаются напрямую кодом репозитория:

| Переменная | Где используется | Назначение |
| --- | --- | --- |
| `HOST_CODEX_HOME` | [compose.yaml](/C:/Users/gabba/projects/developer/compose.yaml) | Host Codex auth directory, смонтированная read-only в `/host-codex`, чтобы Compose мог автоматически bootstrap `/codex-home` при первом старте. |
| `TARGET_REPO_PATH` | [compose.yaml](/C:/Users/gabba/projects/developer/compose.yaml) | Host path, смонтированный в `/workspace/project` при запуске через Docker Compose. |
| `CODEX_API_KEY` | [src/integrations/codex/auth.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/auth.ts) | Если задан, воркер пропускает `codex login status` и предполагает прямую Codex auth по API key. |
| `OPENAI_API_KEY` | Operational setup | Сам по себе не пропускает worker auth preflight. Чтобы использовать его с Codex auth storage, перед запуском воркера выполните `printenv OPENAI_API_KEY \| codex login --with-api-key`. |
| `SOURCE_CODEX_HOME` | [scripts/bootstrap-codex-home.mjs](/C:/Users/gabba/projects/developer/scripts/bootstrap-codex-home.mjs) | Source directory, которую копирует bootstrap script. По умолчанию текущий пользовательский `~/.codex`. |
| `TARGET_CODEX_HOME` | [scripts/bootstrap-codex-home.mjs](/C:/Users/gabba/projects/developer/scripts/bootstrap-codex-home.mjs) | Destination directory, в которую пишет bootstrap script. По умолчанию `.codex-home` в текущем репозитории. |

## Значения GitLab: как быстрее их получить

### `GITLAB_URL`

Возьмите root URL, который уже используете в браузере для GitLab web UI.

Пример:

```env
GITLAB_URL=https://gitlab.example.com
```

### `GITLAB_TOKEN`

Рекомендуемый выбор:

1. Используйте project access token, когда воркер должен работать только с одним репозиторием.
2. Используйте personal access token только когда воркер должен работать с несколькими проектами и project token слишком узкий.
3. Храните token и в `GITLAB_TOKEN`, и в `GIT_REPOSITORY_TOKEN`, если хотите использовать один credential для GitLab API calls и git fetch/push over HTTPS.

Для Git over HTTPS этот воркер по умолчанию использует `oauth2` в `GIT_REPOSITORY_USERNAME`. Оставьте это значение для GitLab PAT, project access token или group access token, если ваш GitLab instance не требует другое непустое username.

### `GITLAB_PROJECT_ID`

Используйте один из этих источников:

1. Project overview page в GitLab, где обычно отображается project ID.
2. Project path, закодированный для GitLab API.
3. Однократный API lookup, если token уже есть:

```bash
curl --header "PRIVATE-TOKEN: <token>" \
  "https://gitlab.example.com/api/v4/projects/<url-encoded-group%2Fproject>"
```

## Пример для `platform/client-application`

Если воркер должен работать с `https://repo.tools-indigolab.ru/platform/client-application.git`, фрагмент `.env` должен выглядеть так:

```env
GITLAB_URL=https://repo.tools-indigolab.ru
GITLAB_TOKEN=your-project-access-token
GITLAB_PROJECT_ID=platform%2Fclient-application
GIT_REMOTE_NAME=origin
GIT_REPOSITORY_TOKEN=your-project-access-token
GIT_REPOSITORY_USERNAME=oauth2
GIT_REPOSITORY_URL=https://repo.tools-indigolab.ru/platform/client-application.git
TARGET_REPO_PATH=C:/Users/gabba/projects/client-application
REPO_PATH=/workspace/project
BASE_BRANCH=main
```

`GITLAB_PROJECT_ID` может быть либо числовым project ID из GitLab UI, либо URL-encoded path `platform%2Fclient-application`.

Затем возьмите `id` из response.

### `GITLAB_TOKEN`

Создайте token для аккаунта или bot, который будет владельцем merge requests. Так как код воркера перечисляет open merge requests и создает новые, token должен иметь право вызывать merge request API для целевого проекта.

Практический чеклист:

- По возможности используйте отдельный bot или service account.
- Выдайте только доступ, необходимый для целевого проекта.
- Проверьте token перед запуском воркера:

```bash
curl --header "PRIVATE-TOKEN: <token>" \
  "https://gitlab.example.com/api/v4/projects/<project-id>/merge_requests?state=opened"
```

Если этот request успешен, такой же token shape должен работать для read path воркера. Также стоит проверить, что он может создать merge request в вашем окружении, прежде чем полагаться на него в production.

## Git commit identity внутри Docker

Воркер может fetch и push с repository credentials, но позже все равно упасть на `git commit`, если git author identity отсутствует в смонтированном checkout. Обычно это выглядит как `Author identity unknown` и fallback host вроде `root@container-id.(none)`.

Используйте один из этих подходов:

1. Настройте сам смонтированный репозиторий:

```bash
git -C /path/to/repo config user.name "AI Worker"
git -C /path/to/repo config user.email "ai-worker@example.com"
```

2. Или передайте identity через окружение воркера:

```env
GIT_AUTHOR_NAME=AI Worker
GIT_AUTHOR_EMAIL=ai-worker@example.com
```

Теперь startup воркера проверяет `git var GIT_AUTHOR_IDENT`, поэтому такая misconfiguration должна fail fast до начала обработки задач.

## Git hooks на commit воркера

Воркер уже проверяет состояние репозитория через `TEST_COMMAND` и `LINT_COMMAND`. Чтобы избежать failures из-за developer-local hook stacks внутри смонтированных репозиториев, commit воркера по умолчанию использует `git commit --no-verify`.

Используйте это значение по умолчанию, если не хотите намеренно запускать repository hooks внутри воркера:

```env
GIT_COMMIT_NO_VERIFY=true
```

Если целевой репозиторий требует hooks даже для automation, задайте:

```env
GIT_COMMIT_NO_VERIFY=false
```

Допустимые значения: `true`, `false`, `1`, `0`, `yes` и `no`.

## Рекомендуемый validation flow

1. Заполните `.env`.
2. Запустите `codex login status` на host, задайте `CODEX_API_KEY` или сохраните `OPENAI_API_KEY` через `printenv OPENAI_API_KEY | codex login --with-api-key`.
3. Запустите воркер один раз с `WORKER_RUN_ONCE=true`.
4. Исправьте missing variable, о которых сообщит startup.

Config loader fails fast при отсутствии обязательных переменных, поэтому startup errors являются самым быстрым способом найти неполный `.env`.
