# План серверного развёртывания только в Docker

**Дополнение:** первый ограниченный вариант без host checkout реализован в opt-in managed mode: [MANAGED_SETTINGS.md](MANAGED_SETTINGS.md). Этот исторический план шире реализации; SSO, изолированные executor containers и полный перенос интеграций по-прежнему не следует считать готовыми.

> **Статус: проектное предложение, не реализованный runbook.** В текущем `main` основной `compose.yaml` требует `HOST_CODEX_HOME` и `TARGET_REPO_PATH` и монтирует локальный checkout. Описанные ниже `compose.server.yaml`, `RepositoryWorkspaceService` и URL-first fleet config **пока не считаются доступными функциями**. Для действующего запуска используйте [локальный Docker runbook](LOCAL_DOCKER_RUN.md).

## Цель

Получить серверный AI-Developer, которому для работы не нужен checkout репозитория на хосте. Администратор указывает URL GitLab, credentials, параметры модели и quality gates; воркер сам клонирует репозитории в Docker volume, запускает Codex, публикует MR, а web-консоль доступна по HTTPS-домену через защищённый reverse proxy.

Желаемые свойства:

- Нет обязательного `TARGET_REPO_PATH` и bind mount хостового checkout.
- Нет копирования `HOST_CODEX_HOME` из рабочей машины администратора.
- Состояние — в Docker volumes или отдельных managed хранилищах.
- `/tasks` и `/api` доступны только через TLS + проверенную авторизацию.
- GitLab, Codex и PostgreSQL учётные данные изолированы от команд агента.

## Что есть сейчас

- Docker-образ собирает Node.js worker и Angular console.
- `compose.yaml` содержит `postgres`, `migrate`, `worker`.
- Поддерживаются `GIT_REPOSITORY_URL`, `GIT_REPOSITORY_TOKEN` и переписывание remote на HTTPS **для уже существующего checkout**.
- Доступны `CODEX_API_KEY` или вход `codex login --device-auth` в выделенном томе.
- Внутренний task tracker работает с PostgreSQL, UI — по `/tasks`, API — по `/api`, наблюдаемость — по `/healthz`, `/readyz` и `/metrics`.

Что отсутствует в полном серверном сценарии:

- Штатное клонирование репозитория в новый пустой Docker volume перед `assertRepositoryReady()`.
- URL-first конфигурация fleet без `repositories[].repoPath`.
- Стабильный логический repository key для leases вместо привязки к абсолютному пути.
- Готовый production Compose с TLS/SSO и без host checkout.
- Стратегия toolchains для разных репозиториев: Node/pnpm, Python, Go, Java, browsers и т. д.
- Достаточно строгая изоляция секретов и среды выполнения Codex.

## Предлагаемая схема

```text
Internet
   │ HTTPS, auth
   ▼
Reverse proxy (Caddy / Traefik / Nginx)
   │ internal Docker network
   ▼
AI-Developer control plane
   ├─ /tasks /api /healthz /readyz /metrics
   ├─ task orchestration / project manager
   ├─ repository workspaces → volume
   ├─ Codex executor → отдельная изолированная среда
   ├─ memory / events → volumes
   └─ PostgreSQL → managed service или отдельный container
```

Публичные порты принадлежат только reverse proxy. Базовый воркер, БД, внутренние токены и метрики доступны по приватной сети.

Рекомендуемые volumes:

- `tracker-postgres` — данные задач.
- `repo-workspaces` — клонированные репозитории.
- `codex-home-worker-1` — Codex auth (только при OAuth/device auth).
- `ai-developer-memory` — локальная память.
- `ai-developer-events` — события наблюдаемости.

## Этап 1. Загрузка репозитория по URL

**Предлагаемая, ещё не реализованная конфигурация:**

```env
REPOSITORY_WORKSPACE_ROOT=/workspace/repos
REPOSITORY_NAME=client-application
GIT_REPOSITORY_URL=https://gitlab.example.com/platform/client-application.git
BASE_BRANCH=main
```

Для fleet в будущем:

```yaml
repositories:
  - name: client-application
    gitRepositoryUrl: https://gitlab.example.com/platform/client-application.git
    checkoutPath: /workspace/repos/client-application
    gitlabProjectId: "42"
    baseBranch: main
    queues: [FRONTEND]
    tags: [ai_dev]
    testCommand: npm test
    lintCommand: npm run lint
```

Создать `RepositoryWorkspaceService` до проверки `RepositoryGitService.assertRepositoryReady()`. Он должен:

1. Создать workspace root, разрешить стабильный путь по repository key.
2. Если `.git` отсутствует — безопасно выполнить `git clone` с нужной веткой и GitLab credentials.
3. При существующем checkout проверить remote URL и готовность ветки.
4. Настроить Git commit identity и допустимый `safe.directory` только для конкретного checkout.
5. Обновить refs (`git fetch --all --prune`), проверить отсутствие конфликтующего dirty state.
6. Сохранить task branches для возобновления после рестарта.

**Нельзя автоматически удалять или делать hard reset существующего checkout.** Для восстановления повреждённого workspace нужен отдельный явный maintenance action.

Приёмочные критерии: новый пустой volume получает clone без checkout на хосте; после рестарта используется тот же clone; прямой режим с `REPO_PATH` продолжает работать.

## Этап 2. Воспроизводимый runtime целевых проектов

Клонировать Git — недостаточно. Для проверок нужно окружение проекта: `pnpm`, Go, Python, JDK, браузеры и т. д.

Для MVP допускается расширяемый Dockerfile под целевой стек. Дальше предпочтительнее `executorImage` для каждого профиля и короткоживущие изолированные исполнители.

Не монтируйте Docker socket в основной воркер без отдельного security review: это фактически может дать доступ к хосту. Сохраняйте logs/artifacts отдельно от checkout.

## Этап 3. Авторизация Codex и секреты

Серверный вариант не должен копировать `~/.codex` администратора при старте.

- API credential из vault/secret manager или Docker secret — один из вариантов для headless.
- OAuth/device auth допускается через отдельный `CODEX_HOME` на один активный воркер.
- При использовании `OPENAI_API_KEY` проверьте поддерживаемый процесс `codex login --with-api-key`.
- Preflight должен проверять не только наличие ключа, но и реальную способность CLI совершить безопасный запрос.
- **Не передавайте GitLab, Tracker и другие инфраструктурные секреты в окружение, доступное командам Codex**. Требуются минимальные полномочия, изоляция executor и доставка секретов только нужным инструментам.

## Этап 4. Production Compose и домен

Целевой `compose.server.yaml` должен включать: PostgreSQL, миграции, воркер, рабочие volumes и reverse proxy с TLS. Он не должен требовать `HOST_CODEX_HOME` и `TARGET_REPO_PATH`.

Runtime-параметры после реализации:

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_STORAGE=postgres
TASK_TRACKER_UI_ENABLED=true
TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy
OBSERVABILITY_ENABLED=true
OBSERVABILITY_HOST=0.0.0.0
OBSERVABILITY_PORT=9464
```

Backend в этом примере не должен публиковать `9464` напрямую во внешнюю сеть. Reverse proxy проверяет вход, удаляет клиентские `x-task-tracker-user` / `x-task-tracker-role` и добавляет **свои подтверждённые** identity headers. `/metrics` оставьте приватным.

Тест приёмки: админка на `https://admin.example.com/tasks`, worker ready, миграции выполнены, поддельные клиентские заголовки не позволяют получить чужую роль.

## Этап 5. Fleet и координация

Для URL-first fleet нужно:

- Разрешить конфигурацию без обязательного `repoPath`, если задан `gitRepositoryUrl`.
- Использовать стабильный `repositoryKey` или нормализованное имя для memory/leases.
- Не допускать двух разных профилей, случайно резолвящихся в один checkout.
- Поддерживать отдельные token refs для разных GitLab проектов.
- Проверить две очереди и два репозитория в одном `repo-workspaces` volume.

## План реализации и проверки

| Очерёдность | Основные файлы и тесты |
| --- | --- |
| Workspace bootstrap | `src/config.ts`, `src/models/types.ts`, новый git workspace adapter, `src/app.ts`, preflight, тесты git/конфигурации |
| Server Compose | `compose.server.yaml`, `deploy/Caddyfile.example`, Docker runbook-и |
| Auth hardening | Reverse proxy, серверный preflight, API auth и role mapping |
| Multi-repo | Fleet config, repository context/lock backend, integration/smoke tests |
| Executor isolation | Контракт runtime toolchains, ephemeral executor, log/artifact paths |

Перед запуском в production: test/typecheck/build, Docker build, контейнерный preflight, одноразовый task run, проверка backup/restore и ручная проверка ролей. Rollback должен оставлять PostgreSQL volume и архивы задач нетронутыми.

## Основные риски

1. Codex credentials могут формально присутствовать, но не работать в runtime.
2. В образе нет нужного runtime/toolchain для тестов чужого репозитория.
3. Dirty checkout блокирует выполнение или может быть повреждён автоматическим reset.
4. Незащищённый `/api` позволит изменять задачи; доверенные заголовки без proxy boundary небезопасны.
5. Общий OAuth `CODEX_HOME` даёт конфликты refresh token.
6. Наследование переменных окружения и слишком широкие sandbox-права создают риск утечки секретов.

**Рекомендуемый MVP:** один репозиторий, URL-first clone, безопасная авторизация, отдельный исполнитель, миграции и приватный proxy. Мульти-репозиторный fleet — после проверки первого сквозного сценария.

