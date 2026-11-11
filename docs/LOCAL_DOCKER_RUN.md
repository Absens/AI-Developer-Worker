# Локальный запуск в Docker

**Для настройки проектов через UI** предусмотрены отдельные `compose.managed.yaml` и [MANAGED_SETTINGS.md](MANAGED_SETTINGS.md). Руководство ниже описывает прежний bind-mount env/fleet запуск.

Этот документ описывает локальный запуск AI Developer Worker. Для Windows-команд см. [PowerShell quickstart](WINDOWS_POWERSHELL_QUICKSTART.md).

**Коротко:** просто собрать образ недостаточно. Нужны авторизованный Codex, реальные git credentials целевого репозитория, корректный `.env` и работающие команды quality gates.

## Перед запуском

1. Node.js ≥22 (для локальной разработки) и установленный Docker.
2. Действительный git checkout проекта, который воркер будет изменять.
3. Доступ к GitLab, задачам Yandex Tracker или внутреннему трекеру.
4. Выделенный writable каталог `CODEX_HOME` с авторизацией внутри контейнера.
5. Команды `TEST_COMMAND`, `LINT_COMMAND` и включённых дополнительных проверок должны существовать в целевом репозитории.
6. У пользователя Git должны быть права `fetch`, `pull` и `push`.

В примерах `.env.example` по умолчанию используются Yandex Tracker и `CODEX_SANDBOX=danger-full-access`. Последнее значение даёт агенту широкие права на выполнение команд: для недоверенных задач сначала организуйте изоляцию файлов, сети и секретов.

## Как устроен старт

При старте воркер читает конфигурацию, проверяет авторизацию через `codex login status` и готовность среды, затем запускает цикл задач. Если авторизации нет, startup прекращается до обработки Tracker. OAuth login автоматически при штатном старте **не выполняется**.

Для одной задачи: полученная задача → анализ → git checkout/ветка → `codex exec` → quality gates → commit/push/MR → запись результата в tracker. Внутренний трекер работает через PostgreSQL и миграции.

## 1. Подготовить образ и окружение

```bash
docker build -t ai-developer-worker .
cp .env.example .env
```

Заполните в `.env` `TRACKER_*` (для direct Yandex), `GITLAB_*`, `TRACKER_STATUS_MAP_FILE`, `WORKER_ID`, `TEST_COMMAND`, `LINT_COMMAND`, `CODEX_CLI_COMMAND` и переменные целевого репозитория. Не помещайте `.env` в Git.

В `TRACKER_STATUS_MAP_FILE` поле `statuses` должно соответствовать реальным статусам, а `transition` служит подсказкой для поиска перехода, не постоянным идентификатором.

**Если используете internal tracker**, задайте:

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_STORAGE=postgres
TASK_TRACKER_DATABASE_URL=postgres://tracker:YOUR_PASSWORD@postgres:5432/ai_developer_tasks
TASK_TRACKER_UI_ENABLED=true
TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy
```

Это пример production-параметров, а не работающая настройка авторизации «из коробки»: доверенный reverse proxy должен проверять пользователя и подставлять разрешённые заголовки. Для локальной разработки можно ограничиться доступом на localhost. Сначала выполните миграции и preflight:

```bash
npm run tracker:migrate
npm run preflight
```

При работе через Compose сначала запустите PostgreSQL и обеспечьте доступ к БД; `docker compose up --build` включает отдельный `migrate` сервис. Прочитайте [runbook PostgreSQL](INTERNAL_TRACKER_POSTGRES_RUNBOOK.md).

## 2. Авторизовать Codex в отдельном томе

Проверьте Codex на хосте: `codex login status`. Но **не делите `auth.json` с хостом** при длительном запуске.

```bash
docker volume create codex-home
```

После сборки образа выполните вход в выделенный том. Для PowerShell:

```powershell
docker run --rm -it --entrypoint codex -e CODEX_HOME=/codex-home -v "codex-home:/codex-home" ai-developer-worker login --device-auth
docker run --rm --entrypoint codex -e CODEX_HOME=/codex-home -v "codex-home:/codex-home" ai-developer-worker login status
```

Для Compose том `codex-home` создаётся автоматически (имя с префиксом Compose project). Авторизуйте именно его:

```bash
docker compose run --rm --entrypoint codex worker login --device-auth
docker compose run --rm --entrypoint codex worker login status
```

`scripts/docker-entrypoint.sh` может первоначально скопировать auth из `HOST_CODEX_HOME`, если нет `/codex-home/auth.json`. Это допустимо для короткой локальной отладки, но при параллельной работе хостового Codex может вызвать `refresh_token_reused`. См. [диагностику](CODEX_AUTH_TROUBLESHOOTING.md).

## 3. Подключить целевой репозиторий

Стандартный контейнер ожидает реальный checkout в `/workspace/project`.

В `.env` для Compose укажите абсолютные пути хоста:

```env
HOST_CODEX_HOME=C:/Users/YOUR_USER/.codex
TARGET_REPO_PATH=C:/work/target-repository
REPO_PATH=/workspace/project
CODEX_HOME=/codex-home
```

`compose.yaml` монтирует checkout и отдельный Codex volume. Если Git remote настроен по SSH, при необходимости задайте `GIT_REPOSITORY_URL` и отдельный `GIT_REPOSITORY_TOKEN` для HTTPS. Проверяйте Git push **из контейнера**, а не только с хоста.

## 4. Первый запуск: один цикл

Временно установите `WORKER_RUN_ONCE=true` в `.env`.

```bash
docker compose up --build
```

Либо запустите собранный образ напрямую, задав путь к checkout:

```bash
docker run --rm --env-file .env -e WORKER_RUN_ONCE=true -e CODEX_HOME=/codex-home -v codex-home:/codex-home -v /absolute/path/to/project:/workspace/project ai-developer-worker
```

Проверьте логи, корректность Codex auth, git fetch/push, статусы задач и проверки качества. После успешного one-shot включите непрерывную обработку `WORKER_RUN_ONCE=false`.

## UI и Telegram

Docker-образ содержит Angular-сборку в `/workspace/web/dist/task-tracker-console/browser`. При `TASK_TRACKER_UI_ENABLED=true` UI обслуживается по `/tasks`, JSON API — по `/api`. Без собранных assets маршрут UI возвращает ошибку, а не старый встроенный интерфейс.

Telegram Assistant доступен только при включении соответствующих настроек и с `TASK_TRACKER_PROVIDER=internal`:

```env
TELEGRAM_ASSISTANT_ENABLED=true
TELEGRAM_ASSISTANT_BOT_TOKEN=SET_SECURELY
TELEGRAM_ASSISTANT_MODE=polling
TELEGRAM_ALLOWED_USER_IDS=111111111
TELEGRAM_DEVELOPER_USER_IDS=111111111
TELEGRAM_TASK_CREATION_ENABLED=true
TELEGRAM_PROJECT_QA_ENABLED=false
```

Webhook требует публичный HTTPS base URL, отдельный секрет, включённый observability server и права на приём запросов. Telegram-бот уведомлений использует отдельный ключ `TELEGRAM_BOT_TOKEN`. Не включайте Digital Twin или обработку всех групповых сообщений без согласия и политики хранения данных.

Подробнее — [Telegram intake](TELEGRAM_TASK_INTAKE.md) и [наблюдаемость](OBSERVABILITY_RUNBOOK.md).

## Типичные проблемы

| Симптом | Что проверить |
| --- | --- |
| `codex login status` не проходит | Выделенный том, `CODEX_HOME` и повторная авторизация |
| `refresh_token_reused` | Раздельность auth state хоста и контейнера |
| `git push` / `pull` падает | Remote, токен, доступ из контейнера |
| Ошибка Tracker/GitLab | URL, токены, очередь, карта статусов |
| Test/lint сразу завершается | Команды в целевом checkout и зависимости |
| Git hooks падают | `GIT_COMMIT_NO_VERIFY` и окружение hooks |
| `/tasks` недоступен | `OBSERVABILITY_ENABLED`, `TASK_TRACKER_UI_ENABLED` и статические assets |

**Важно:** демонстрационный Compose использует bind mount хостового репозитория и простые локальные учётные данные PostgreSQL. Это не готовое защищённое production-развёртывание. Серверное целевое решение отдельно описано в [плане](DOCKER_ONLY_SERVER_PLAN.md).

