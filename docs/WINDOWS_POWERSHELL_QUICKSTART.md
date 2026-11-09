# Быстрый запуск в Windows PowerShell

Это практическое дополнение к [Docker runbook](LOCAL_DOCKER_RUN.md). Команды выполняются из корня репозитория `AI-Developer-Worker`, где лежат `Dockerfile` и `compose.yaml`.

## 1. Предварительная проверка

Проверьте Docker Desktop и Codex на хосте:

```powershell
docker version
codex login status
```

Результат `Logged in` на хосте **не заменяет** отдельную авторизацию контейнера. Репозиторий, с которым будет работать агент, должен быть реальным git clone с fetch/push доступом.

## 2. Подготовьте рабочую директорию и образ

```powershell
Set-Location C:\work\AI-Developer-Worker
docker build -t ai-developer-worker .
```

Замените путь на фактический. Docker-образ собирает backend и Angular-консоль.

## 3. Отдельный Codex auth volume

```powershell
docker volume create codex-home
docker run --rm -it --entrypoint codex -e CODEX_HOME=/codex-home -v "codex-home:/codex-home" ai-developer-worker login --device-auth
docker run --rm --entrypoint codex -e CODEX_HOME=/codex-home -v "codex-home:/codex-home" ai-developer-worker login status
```

Авторизация должна происходить в **томе воркера**, а не через совместное использование хостового `auth.json`.

## 4. Настройте окружение

```powershell
Copy-Item .env.example .env
notepad .env
```

Для режима Yandex проверьте `TRACKER_TOKEN`, `TRACKER_ORG_ID`, `TRACKER_STATUS_MAP_FILE`, `TRACKER_DEFAULT_QUEUE`. Для GitLab — `GITLAB_URL`, `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`. Также задайте `WORKER_ID`, `TEST_COMMAND`, `LINT_COMMAND` и `CODEX_CLI_COMMAND`.

Путь к целевому репозиторию:

```powershell
$TargetRepo = "C:\work\my-target-repository"
```

Если его remote использует SSH и воркер должен переключиться на HTTPS, задайте в `.env` `GIT_REPOSITORY_URL`, `GIT_REPOSITORY_USERNAME=oauth2` и `GIT_REPOSITORY_TOKEN`. Не добавляйте реальный token в README, скриншоты или историю команд.

**Предупреждение:** значение `CODEX_SANDBOX=danger-full-access` в шаблоне разрешает очень широкий набор действий. Для корпоративной среды необходимы отдельные права, изоляция и ограничения секретов.

## 5. Первый запуск одним циклом

```powershell
docker run --rm `
  --env-file .env `
  -e WORKER_RUN_ONCE=true `
  -e CODEX_HOME=/codex-home `
  -v "codex-home:/codex-home" `
  -v "$($TargetRepo):/workspace/project" `
  ai-developer-worker
```

В этом примере символ переноса строки PowerShell — обратная кавычка, а не `\`. Проверяйте, что после символа переноса нет пробелов.

Убедитесь, что контейнер может читать checkout, выполнить `codex login status` и работать с GitLab/Tracker. Только после успешного one-shot переходите на непрерывный запуск.

## 6. Постоянный запуск

```powershell
docker run --rm `
  --env-file .env `
  -e WORKER_RUN_ONCE=false `
  -e CODEX_HOME=/codex-home `
  -v "codex-home:/codex-home" `
  -v "$($TargetRepo):/workspace/project" `
  ai-developer-worker
```

## Альтернатива: Docker Compose

В `.env` обязательно заполните:

```env
HOST_CODEX_HOME=C:/Users/YOUR_USER/.codex
TARGET_REPO_PATH=C:/work/my-target-repository
REPO_PATH=/workspace/project
```

```powershell
docker compose build
docker compose run --rm --entrypoint codex worker login --device-auth
docker compose run --rm --entrypoint codex worker login status
docker compose up --build
```

Для внутреннего PostgreSQL-трекера `compose.yaml` содержит `postgres` и `migrate`. Если включён `TASK_TRACKER_PROVIDER=internal`, убедитесь в доступности БД и корректной конфигурации UI/auth. При `OBSERVABILITY_ENABLED=true` и включённой консоли локальный интерфейс может быть доступен по `http://localhost:9464/tasks`.

## Что делать при ошибке

- `Codex CLI is not authenticated` → проверить auth внутри выделенного тома.
- `refresh_token_reused` → не использовать скопированное состояние параллельно с хостом; см. [инструкцию](CODEX_AUTH_TROUBLESHOOTING.md).
- `git pull`/`git push` → проверить токен GitLab и HTTPS remote.
- `npm test`/`lint` → проверить команду и зависимости в *целевом* репозитории.
- `husky`/`lint-staged` → проверить `GIT_COMMIT_NO_VERIFY`, не выключать hooks вслепую.
- `/tasks` возвращает ошибку → проверить observability, UI config, прокси и assets.

Подробный перечень переменных — [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md).

