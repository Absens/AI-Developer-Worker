# Запуск нескольких репозиториев (fleet mode)

Режим fleet включается через `WORKER_CONFIG_FILE`. Если переменная не задана, используется профиль одного репозитория из `.env`. Для каждого репозитория можно настроить отдельную очередь, целевую ветку, GitLab project ID и команды проверок.

## Пример YAML-конфигурации

```yaml
worker:
  id: worker-1
  pollIntervalMinutes: 10
  runOnce: false

tracker:
  tokenEnv: TRACKER_TOKEN
  orgIdEnv: TRACKER_ORG_ID
  orgHeader: X-Cloud-Org-ID
  apiBaseUrl: https://api.tracker.yandex.net/v3
  statusMapFile: config/trackerStatusMap.example.json

gitlab:
  urlEnv: GITLAB_URL
  tokenEnv: GITLAB_TOKEN

codex:
  homeEnv: CODEX_HOME
  cliCommand: codex
  timeoutSeconds: 1800

coordination:
  lockBackend: tracker
  ttlSeconds: 900
  heartbeatSeconds: 60

priorityQueue:
  manualOverrideTags: [ai_priority]
  priorityWeights:
    blocker: 1000
    critical: 700
    high: 400
    normal: 100
    low: 0
  tagBoosts:
    urgent: 250
  componentBoosts:
    payments: 300
  deadlineBoost:
    dueToday: 300
    overdue: 600
  createdAtTieBreaker: oldest

repositories:
  - name: client-application
    repoPath: /workspace/client-app
    gitlabProjectId: "42"
    gitRemoteName: origin
    baseBranch: main
    queues: [FRONTEND]
    tags: [ai_dev]
    testCommand: npm test
    lintCommand: npm run lint
    typeCheckCommand: npm run typecheck
    buildCommand: npm run build

  - name: backend-api
    repoPath: /workspace/backend
    gitlabProjectId: "43"
    gitRemoteName: origin
    baseBranch: develop
    queues: [BACKEND]
    tags: [ai_dev]
    testCommand: go test ./...
    lintCommand: golangci-lint run
```

Это **пример**, не готовый файл для реальных сервисов: названия очередей, пути и команды должны соответствовать вашей инфраструктуре. `compose.yaml` из репозитория монтирует один target checkout — для нескольких профилей обеспечьте доступность всех `repoPath`.

Запуск:

```bash
WORKER_CONFIG_FILE=/workspace/worker.config.yaml npm run dev
```

PowerShell:

```powershell
$env:WORKER_CONFIG_FILE = "C:\workspace\worker.config.yaml"
npm run dev
```

## Маршрутизация и приоритет

Воркер запрашивает кандидатов по `queues` и `tags` каждого профиля. Если подходит несколько задач, оценка учитывает приоритет Tracker, просрочку и дедлайн, boost по компонентам/тегам и ручные `manualOverrideTags`. При равенстве по умолчанию выбирается более старая задача. Если lease получить не удаётся, выбирается следующий кандидат.

## Блокировки и координация

В режиме прямого Yandex Tracker используется механизм комментариев `AI LEASE:` с токеном, `worker id`, задачей, репозиторием, `expiresAt` и `heartbeatAt`.

```env
LOCK_BACKEND=tracker
LOCK_TTL_SECONDS=900
LOCK_HEARTBEAT_SECONDS=60
```

`LOCK_BACKEND=none` подходит только для одного воркера без конкурирующего доступа к checkout. `redis` и `postgres` в этом legacy-механизме зарезервированы и не реализованы. **Не путайте** их с атомарными PostgreSQL lease внутреннего task tracker.

- Каждый запущенный воркер должен иметь уникальный `WORKER_ID` / `worker.id`.
- Для каждого checkout задавайте стабильный `repoPath`; общий путь требует сериализации.
- Блокировки через комментарии Tracker не равны атомарной транзакции; контролируйте TTL и heartbeat.
- Просроченный lease перестаёт блокировать работу; released lease считается неактивным.

## Восстановление из статуса review

После merge MR внутренняя задача переходит в `human_testing`, а не сразу в `done`. Для принятия нужен человеческий сигнал. Если задача застряла в `review`, проверьте запись `AI MR` / `merge_request_records`, права токена на чтение closed/merged MR, привязку source branch/IID, работающий polling и соответствие статуса `Тестируется` карте `TRACKER_STATUS_MAP_FILE`.

## Проверка изменений

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

См. также [архитектуру](ARCHITECTURE.md) и [переменные окружения](ENV_CONFIGURATION.md).

