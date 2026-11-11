# AI Developer Worker

**Self-hosted платформа для выполнения задач разработки с помощью ИИ.** Система объединяет AI-исполнителя на базе Codex CLI, собственный трекер задач, GitLab workflow, управление целями проекта, Telegram-интерфейс, веб-консоль и инструменты эксплуатации.

В отличие от простого запуска Codex по промпту, AI Developer Worker управляет **полным жизненным циклом инженерной задачи**: получает её из очереди, анализирует, проверяет зависимости, выполняет изменения в Git, запускает проверки, создаёт Merge Request, обрабатывает замечания и передаёт результат человеку на приёмку. Состояние задачи сохраняется между запусками.

**Важно о границах:** сейчас это платформа **AI-assisted software engineering**, а не полностью автономный DevOps-контур. Слияние MR, production-деплой и бизнес-приёмка не выполняются автоматически одним только воркером. Встроенного корпоративного MCP-шлюза и автоматического BugLens/Sentry → проверенный баг → деплой тоже пока нет.

[Быстрый старт](#быстрый-старт) · [Возможности](#возможности) · [Архитектура](#архитектура) · [Веб-консоль](#веб-консоль) · [Документация](#документация)

> **Опциональный managed-режим:** подключение GitLab и проектов через интерфейс, версии настроек и применение между задачами. Первый rollout и ограничения: [docs/MANAGED_SETTINGS.md](docs/MANAGED_SETTINGS.md). Прежний env/fleet режим сохранён.

## Для каких задач подходит

- **Автоматизация разработки:** дать агенту задачу на исправление бага, доработку интерфейса, API, рефакторинг, документацию или тесты — получить код и MR, а не только рекомендацию.
- **Управление потоком задач:** принимать задания от людей, Yandex Tracker, Telegram или внутренних систем, контролировать очередь, блокировки, вопросы, ошибки и повторные попытки.
- **Работа с несколькими проектами:** выбирать репозиторий и команды проверки по профилю, не позволять нескольким воркерам одновременно менять один checkout.
- **Контроль AI-изменений:** хранить решения, историю запусков, проверок и MR, оставляя людям точки подтверждения и приёмки.
- **Анализ и планирование развития:** запускать Project Manager для анализа состояния проекта, постановки целей, предложения задач и перепланирования.

Проект ориентирован на команды, у которых уже есть Git-репозитории, GitLab и реальный процесс постановки задач. Для автономной работы с недоверенным кодом нужна дополнительная изоляция.

## Возможности

Состояние в таблице относится к **реализации в `main`**, а не к историческим планам в `docs/superpowers/`.

| Подсистема | Что реализовано | По умолчанию / ограничения |
| --- | --- | --- |
| **AI-исполнитель** | Анализ задачи, выбор сценария, Codex `exec` / `resume`, внесение изменений, доработки после ошибок | Нужны Codex CLI, доступ к репозиторию и конфигурация |
| **Git и GitLab** | Ветки, commit/push, создание и повторное использование MR, обработка review discussions, отслеживание merge/close | Merge выполняется отдельно |
| **Проверки качества** | Typecheck, lint, tests, build, security scan, SAST, coverage, visual regression; цикл исправлений | Выполняются только настроенные команды; необязательные gates могут быть пропущены |
| **Внутренний Task Tracker** | Задачи и ревизии, статусы, планы и шаги, зависимости, вопросы, события, `agent_runs`, `quality_gate_runs`, MR records, proposals | Для production нужен PostgreSQL; в памяти — для тестов |
| **Очередь и координация** | Приоритеты, атомарный claim и lease, heartbeat, защита одного checkout, восстановление обработки | Механизмы различаются для internal и прямого Yandex |
| **Yandex Tracker** | Прямой источник задач либо синхронизация через Yandex bridge | Внутренний трекер может работать без Yandex |
| **Веб-консоль** | Очередь, создание/просмотр задач, команды человека, proposals, operations, цели проекта | Angular UI и human API включаются отдельно |
| **Project Manager** | Анализ сигналов, цели, стратегия, перепланирование, предложения задач, подтверждения | Только internal tracker; выключен по умолчанию, `proposal_only` |
| **Telegram Assistant** | Статусы, вопросы по проекту, создание задач с подтверждениями, уведомления, ответы на вопросы агента | Требует internal tracker; выключен по умолчанию |
| **Telegram Digital Twin** | Опциональные Business/Secretary-сессии, контекст по контактам, согласование явных заявок | Нужны согласие владельца, allowlists и контроль хранения данных |
| **Память репозиториев** | Локальные знания о коде, утверждённые prompt rules, похожие ошибки, результаты review learning | Файловое хранилище, выключено по умолчанию |
| **Fleet mode** | Несколько профилей репозиториев, маршрутизация по очередям и тегам, блокировки и приоритеты | Не означает автоматическое клонирование URL в пустой volume |
| **Наблюдаемость** | Health/readiness, Prometheus-метрики, timeline событий, alerts, redaction, cleanup/retention | Выключена по умолчанию; внешний доступ требует защиты |

### Как выглядит работа над одной задачей

Например, сотрудник создаёт задачу «исправить некорректный расчёт суммы заказа» через веб-консоль или доверенный Telegram-чат.

1. **Постановка.** Система сохраняет описание, критерии приёмки, проект, приоритет и источник задачи. Для Telegram проверяются права и необходимость согласования.
2. **Выбор задачи.** Worker получает её из очереди с учётом приоритета, зависимостей и lease репозитория.
3. **Анализ.** Codex определяет тип задачи, сложность, режим обработки и необходимый контекст. Если данных недостаточно — задаёт вопрос, не продолжая работу вслепую.
4. **Реализация.** Codex работает в целевом checkout, изменяет файлы и при необходимости возобновляет сохранённую сессию.
5. **Валидация.** Запускаются настроенные проверки. Ошибки могут возвращаться Codex для исправления в пределах лимита попыток.
6. **Публикация.** Worker создаёт ветку и GitLab MR, записывает ссылку, результаты и события в трекер.
7. **Ревью и приёмка.** При наличии замечаний в GitLab worker может продолжить цикл исправлений. После merge внутренняя задача переходит в `human_testing`; закрывается как `done` после приёмки человеком.

Это пример предусмотренного процесса, **не обещание**, что любая задача будет выполнена корректно или что система сама воспроизведёт любой баг.

## Архитектура

```mermaid
flowchart TD
    A["Веб-консоль / Human API"] --> T["Internal Task Tracker"]
    B["Telegram Assistant"] --> T
    C["Yandex Tracker через bridge"] <--> T
    Y["Yandex Tracker (прямой режим)"] --> WY["WorkerOrchestrator / FleetOrchestrator"]
    T --> WI["InternalWorkerOrchestrator"]
    WI --> E["Codex CLI + Git checkout"]
    WY --> E
    E --> Q["Quality gates / fix loop"]
    Q --> G["GitLab: branch, MR, review"]
    G --> T
    G --> Y
    PM["Project Manager"] <--> T
    M["Repository memory"] -.-> E
    O["Observability / metrics / alerts"] -.-> WI
    O -.-> WY
```

Основные технологии: **Node.js 22+, TypeScript, Codex CLI, PostgreSQL, Git/GitLab, Angular 20 + PrimeNG, Vitest**. Playwright используется в браузерных E2E-тестах веб-консоли. В `Dockerfile` зафиксирован `@openai/codex@0.167.0`.

### Режимы источников задач

| Режим | Источник истины | Когда использовать |
| --- | --- | --- |
| `TASK_TRACKER_PROVIDER=yandex` | Задачи, статусы и структурированные комментарии Yandex Tracker | Уже работаете в Yandex и не хотите переносить задачи |
| `TASK_TRACKER_PROVIDER=internal` + `TASK_INTAKE_MODE=standalone` | Собственный трекер, обычно PostgreSQL | Хотите управлять задачами через встроенные API и UI |
| `TASK_INTAKE_MODE=yandex_integration` | Internal tracker, Yandex — источник/зеркало | Нужна внутренняя модель исполнения с Yandex-интеграцией |
| `TASK_INTAKE_MODE=hybrid` | Internal tracker и несколько источников intake | Совместная работа native и импортированных задач |
| `TASK_INTAKE_MODE=system_only` | Internal tracker | Постановка через сервисные интеграции |
| `TASK_INTAKE_MODE=ai_proposed` | Internal tracker с политикой предложений | Управляемое создание задач ИИ |

`YANDEX_SYNC_ENABLED=true` предназначен для `yandex_integration` или `hybrid`. Параметры конкретного режима — в [настройке окружения](docs/ENV_CONFIGURATION.md).

### Жизненный цикл внутренней задачи

У задачи есть полноценная state machine, не только «ожидает / выполняется / готово».

```text
new → triage → ready → claimed → analyzing
                                    ├─ implementing → validating → review → human_testing → done
                                    ├─ decomposing
                                    └─ awaiting_human → resume

Дополнительные состояния: fixing_review, blocked, failed, cancelled.
```

В PostgreSQL хранятся ревизии задания и критерии приёмки, события и сообщения, планы и шаги, решения ИИ, записи запусков, результаты проверок, связи с MR и внешними источниками. Есть идемпотентность, ограничения переходов состояний и разделение полей по владельцу (human / external source / worker / policy).

Вызовы для работы с задачами инкапсулированы в `TaskTrackerClient` / `AgentWorkflowService`. Реализация PostgreSQL использует атомарный claim/lease; вместо этого в прямом Yandex-режиме есть механизм `AI LEASE:` на основе комментариев. Эти механизмы не тождественны.

Подробнее: [архитектура](docs/ARCHITECTURE.md) · [PostgreSQL и миграции](docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md).

## Подсистемы крупным планом

### 1. AI-исполнитель и GitLab workflow

Оркестраторы поддерживают анализ задачи, декомпозицию, реализацию, ожидание ответа, повторные попытки исправления, публикацию MR и работу с review feedback.

Режим `TASK_MODE`:
- `auto` — решение по результату структурированного `AI_ANALYSIS:` с проверкой уверенности;
- `implement` — принудительная реализация после анализа;
- `decompose` — разбиение задачи на подзадачи;
- `analyze_only` — сохранить анализ, не менять код;
- `human` — передать решение человеку.

При недостатке сведений агент возвращает `AI_QUESTION:` и сохраняет `threadId`. Продолжение запускается явным действием человека: `/resume`, `/resume A`, `/resume freeform: ...`, `/skip` или `/cancel`. Обычный комментарий не должен случайно возобновлять работу.

**Предварительный intake review** (`TASK_INTAKE_REVIEW_ENABLED`) оценивает качество постановки задачи и может вернуть `ready`, `needs_clarification`, `needs_decomposition` или `reject_as_invalid`. Это **не полноценная автоматическая проверка реальности бага по Sentry/браузеру**.

**Quality gates:** `typecheck → lint → tests → build → security_scan → sast → coverage → visual_regression`. Вы задаёте команды целевого проекта; если команда gate не сконфигурирована, соответствующий этап может быть пропущен. Самопроверка `CODEX_SELF_REVIEW_ENABLED` существует в поддерживающем её (direct Yandex) конвейере и по умолчанию выключена; она не заменяет независимое ревью всех MR.

### 2. Внутренний трекер и операции человека

Собственная доменная модель задач позволяет не зависеть от статусов внешнего трекера. Встроенный API поддерживает задачи, массовое создание, комментарии, историю, команды на изменение состояния, предложения ИИ, операции и цели.

В зависимости от роли и состояния доступны действия вроде `mark-ready`, `resume`, `hold`, `cancel`, `retry`, `force-reanalysis`, `approve-decomposition`, `approve-proposal` и `reject-proposal`. У API есть роли `viewer`, `developer`, `operator` и `admin`. Для production необходимо отдельно обеспечить корректную аутентификацию и проектные ограничения доступа.

### 3. Project Manager Agent

Это **не отдельный Codex, который самовольно создаёт задачи**, а подсистема управляемого планирования поверх внутреннего трекера. Она собирает сигналы о состоянии проекта, запускает структурированный анализ Codex, сохраняет результаты и формирует:

- **Цели:** проблема, ожидаемый результат, метрики успеха, приоритет, риск и evidence.
- **Предложения задач:** проект, тип работы, критерии приёмки, основания и связь с целью.
- **Replanning:** продолжить, разделить, приостановить, завершить, создать follow-up или запросить решение человека.
- **Strategy:** анализ продукта и техники, альтернативные направления, риски, возможности и вопросы для руководителя.

Цели имеют состояния `proposed / approved / active / completed / rejected / stale`. Запуски анализа, replanning и strategy сохраняются. Подсистема работает с internal tracker и по умолчанию выключена (`PROJECT_MANAGER_ENABLED=false`). Базовый уровень автономности — `proposal_only`; автоматическое выполнение low-risk задач требует отдельно разрешённой политики.

[Устройство Project Manager](docs/ARCHITECTURE.md#project-manager-agent) · [Исторический план](docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md).

### 4. Telegram Assistant и Digital Twin

Telegram — дополнительный способ работать с платформой, а не отдельный executor:

- уточнить статус задачи и получить уведомления;
- задать вопрос о проекте через Codex при включённом Q&A;
- сформировать черновик задачи и подтвердить его;
- согласовать high-risk задачу через owner/admin;
- ответить на вопрос ИИ для задачи в `awaiting_human`;
- при отдельном включении Business/Digital Twin поддерживать контекст общения по контактам.

Telegram-задача получает `repositoryName`, `repoPathKey`, `baseBranch`, `queue`. Доверенные low/medium-risk заявки после подтверждения могут перейти в `ready` и попасть в обычную очередь; high-risk и внешние Business-заявки требуют согласования. Оценка риска в Telegram **эвристическая и не гарантирует безопасность изменений**.

Digital Twin использует долговременные Codex-сессии, персональные настройки и audit/retention. Держите его выключенным, пока нет согласия владельца, корректных allowlists, ограничений прав и политики хранения переписки.

[Telegram: сценарии и права](docs/TELEGRAM_TASK_INTAKE.md) · [Метрики и эксплуатация](docs/OBSERVABILITY_RUNBOOK.md).

### 5. Fleet, память и наблюдаемость

**Fleet mode.** Конфигурация `WORKER_CONFIG_FILE` задаёт профили репозиториев: checkout, base branch, GitLab project ID, очереди, теги и команды проверки. Есть приоритеты, coordination/lease и recovery. Текущий стандартный Compose всё ещё предполагает заранее существующий checkout — «clone только по URL в пустой volume» описан в [плане](docs/DOCKER_ONLY_SERVER_PLAN.md), но не готов как штатный режим.

**Repository memory.** При `MEMORY_ENABLED=true` анализ и реализация используют компактные проектные знания из `knowledge.json`, утверждённые правила `prompt-rules.json` и похожие ошибки из `failures.jsonl`. Память локальная, файловая и рекомендательная: текущий код и новые человеческие инструкции важнее. Проверка — `npm run memory:validate`.

**Observability.** Опциональный HTTP-сервер предоставляет `/healthz`, `/readyz`, `/metrics`, события и алерты. Поддерживаются Prometheus и уведомления через webhook, Slack или Telegram. В internal mode есть retention/cleanup для истории, логов и артефактов, а также runbook резервного копирования PostgreSQL.

## Веб-консоль

В `web/` находится интерфейс на **Angular + PrimeNG**, который используется для управления задачами и процессами с участием человека.

| Раздел | Что можно делать |
| --- | --- |
| **Очередь** (`/tasks`) | Просматривать и фильтровать задачи, переходить к деталям |
| **Новая задача** (`/tasks/new`) | Создавать задачу через human API |
| **Карточка задачи** (`/tasks/:taskId`) | Смотреть ревизии, события, результаты работы и выполнять разрешённые команды |
| **Предложения** (`/tasks/proposals`) | Смотреть, утверждать или отклонять AI proposals |
| **Операции** (`/tasks/operations`) | Следить за состоянием воркеров, очередей и leases |
| **Цели** (`/tasks/goals`) | Просматривать и согласовывать цели Project Manager |
| **Детали цели** (`/tasks/goals/:goalId`) | Работа с выбранной целью и связанными задачами |

Для работы с API и UI требуются включённый internal tracker и правильно настроенная авторизация. В development Angular проксирует `/api` к Node.js HTTP-серверу.

[README веб-консоли](web/README.md) · [Авторизация и observability](docs/OBSERVABILITY_RUNBOOK.md).

## Быстрый старт

Ниже — **локальный** сценарий. Для полноценной настройки Docker, токенов и серверного развёртывания используйте [операционные руководства](docs/README.md).

### Требования

- Node.js **22+**, npm, Git и доступный Codex CLI;
- доступ к GitLab и права на чтение/публикацию изменений целевого репозитория;
- авторизация Codex (проверка: `codex login status` либо поддерживаемый API-key режим);
- Yandex Tracker **или** внутренний PostgreSQL task tracker;
- рабочие команды проверок именно для **целевого** репозитория.

### 1. Подготовьте зависимости и конфигурацию

```bash
npm ci
cp .env.example .env
```

В `.env` настройте GitLab (`GITLAB_URL`, `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`), checkout (`REPO_PATH`, `BASE_BRANCH`), Codex (`CODEX_HOME`, `CODEX_CLI_COMMAND`), рабочие команды (`TEST_COMMAND`, `LINT_COMMAND`) и ID воркера. Убедитесь, что Git внутри среды исполнения умеет делать `fetch` и `push`.

При использовании прямого Yandex-режима настройте `TRACKER_TOKEN`, `TRACKER_ORG_ID`, `TRACKER_DEFAULT_QUEUE` и `TRACKER_STATUS_MAP_FILE`. Пример карты — [config/trackerStatusMap.example.json](config/trackerStatusMap.example.json).

### 2. Выберите источник задач

**Вариант A: прямой Yandex Tracker.** Оставьте `TASK_TRACKER_PROVIDER=yandex` (значение примера конфигурации), задайте credentials и проверьте статусы/переходы.

**Вариант B: собственный трекер.** Для production с PostgreSQL задайте:

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_STORAGE=postgres
TASK_INTAKE_MODE=standalone
YANDEX_SYNC_ENABLED=false
TASK_TRACKER_DATABASE_URL=postgres://tracker:YOUR_PASSWORD@localhost:5432/ai_developer_tasks
```

`YOUR_PASSWORD` и URL здесь — **пример**, создайте пользователя и базу в своём PostgreSQL. Демо-Compose использует другой адрес внутри сети контейнеров. Перед обработкой задач:

```bash
npm run tracker:migrate
npm run preflight
```

Внутренние задачи затем создаются через API/UI, Telegram или разрешённые системные источники. Не нужно обязательно подключать Yandex, если выбран `standalone`.

### 3. Выполните preflight и один безопасный цикл

```bash
npm run preflight
```

Для первого запуска задайте в `.env` `WORKER_RUN_ONCE=true` и запустите:

```bash
npm run dev
```

`npm run preflight` не берёт задачи из очереди. Однако если заданы `TRACKER_PREFLIGHT_ISSUE_KEY` или `GITLAB_PREFLIGHT_SOURCE_BRANCH`, preflight может выполнить специально настроенные проверки **записи в тестовые сущности**. Не направляйте их на реальные рабочие задачи или ветки.

Убедитесь, что preflight не сообщает блокирующих ошибок, затем проверьте GitLab MR, логи, статус задачи и результаты gates. После этого можно установить `WORKER_RUN_ONCE=false` для непрерывного polling.

**Внимание:** `WORKER_RUN_ONCE=true` означает один рабочий цикл, а не dry-run: если в очереди есть подходящая задача, воркер может изменить код, сделать push и создать MR. Для проверки **без исполнения** используйте только `npm run preflight`.

### Docker Compose

В репозитории есть `compose.yaml` с `postgres`, `migrate` и `worker`. Он ориентирован на локальное окружение: требуются `HOST_CODEX_HOME` и `TARGET_REPO_PATH` (bind mount checkout). Перед `docker compose up --build` подготовьте `.env`, отдельную авторизацию Codex внутри тома и данные GitLab.

```bash
docker compose config
docker compose up --build
```

**Демо-конфигурация не является защищённым production-шаблоном:** в ней есть простые учётные данные PostgreSQL и прямой проброс порта. Для постоянной эксплуатации необходимы корректные секреты, ограничение сети, изоляция executor и закрытый reverse proxy. Инструкция: [локальный Docker](docs/LOCAL_DOCKER_RUN.md) · [Windows PowerShell](docs/WINDOWS_POWERSHELL_QUICKSTART.md) · [план server-only режима](docs/DOCKER_ONLY_SERVER_PLAN.md).

## Основные команды

| Команда | Назначение |
| --- | --- |
| `npm ci` | Зависимости backend из lockfile |
| `npm run dev` / `npm run start` | Запуск из TypeScript / сборки `dist/` |
| `npm run preflight` | Проверка конфигурации и интеграций без обработки очереди |
| `npm run tracker:migrate` | Применить миграции PostgreSQL |
| `npm run typecheck` | Проверка типов backend |
| `npm test` | Vitest backend |
| `npm run test:smoke` | Smoke-проверки task/Git workflow с mock integrations |
| `npm run build` | Сборка backend |
| `npm run verify:codex-cli` | Проверка CLI-контракта Codex |
| `npm run memory:validate` | Проверка данных repository memory |
| `npm --prefix web ci` | Установить зависимости Angular из отдельного lockfile |
| `npm run web:dev` | Запуск Angular dev server |
| `npm run web:typecheck` / `npm run web:test` | Типы и тесты Angular |
| `npm run web:build` / `npm run web:e2e` | Сборка UI и браузерные E2E-тесты |

При изменении интеграций запускать только `npm run build` недостаточно: выполняйте целевые тесты и smoke.

## Структура репозитория

```text
src/
  app.ts, config.ts, index.ts       # запуск и конфигурация
  domain/
    orchestrator.ts                 # прямой Yandex runtime
    internalWorkerOrchestrator.ts   # internal task runtime
    fleetOrchestrator.ts            # multi-repository Yandex runtime
    taskTracker/                    # статусы, планы, leases, proposals, policy
    projectManager/                 # анализ, цели, strategy, replanning
    telegramAssistant/              # intents, task intake, Digital Twin
    qualityGates.ts                 # проверки целевого проекта
    memoryStore.ts                  # локальная память репозиториев
  integrations/
    codex/, git/, gitlab/, tracker/
    internalTracker/                # PostgreSQL, миграции, cleanup
    yandexBridge/, telegram/
  observability/                    # HTTP, metrics, timeline, human API
web/                                # Angular/PrimeNG console
tests/                              # Vitest unit и smoke
scripts/                            # миграции и Codex utilities
config/                             # пример карты статусов Yandex
docs/                               # руководства по архитектуре и эксплуатации
```

## Безопасность и текущие ограничения

**Это важная часть оценки готовности платформы к корпоративному развёртыванию.**

1. **Sandbox:** в текущем шаблоне используется `CODEX_SANDBOX=danger-full-access`. Для выполнения недоверенных задач это не безопасное значение по умолчанию. Команды Codex должны работать в изолированной среде, без доступа к лишним файлам, сети и хосту.
2. **Секреты:** запуск дочерних процессов через shell может наследовать переменные окружения воркера. Не допускайте доступа агента к production-токенам GitLab, Tracker, БД и секретам окружения без отдельного разграничения полномочий.
3. **Доступ к UI/API:** есть роли `viewer/developer/operator/admin`, но права и project scope должны быть проверены для вашего сценария. Trusted proxy headers безопасны только если backend недоступен напрямую и proxy удаляет подставленные клиентом заголовки.
4. **MR и проверки:** обязательность quality gates зависит от конфигурации целевого проекта. Self-review опционален и не заменяет независимое ревью. Merge — отдельное человеческое или внешнее действие; после merge требуется приёмка.
5. **Нет встроенного автодеплоя:** merge MR сам по себе не вызывает deployment controller, health checks или revert через AI-Developer Worker.
6. **Нет корпоративного MCP gateway и проверенного BugLens/Sentry intake:** это отдельные расширения, а не функции текущего `main`.
7. **AI runtime:** рабочий executor связан с **Codex CLI**; произвольное переключение Codex ↔ Claude с переносимой execution-сессией не реализовано.
8. **Инфраструктура:** текущий Compose локально ориентирован; полнофункциональное server-only развёртывание с URL-first clone, SSO/TLS и отдельными executor containers описано как план.
9. **Локальная память:** `MEMORY_ENABLED` не заменяет единую корпоративную базу знаний и может содержать устаревший контекст.

Эти ограничения не отменяют уже реализованные функции, но определяют необходимый уровень контроля при использовании в production.

## Документация

Единый каталог: **[docs/README.md](docs/README.md)**. Основные разделы:

| Что нужно | Куда перейти |
| --- | --- |
| Разобраться в runtime и модулях | [Архитектура](docs/ARCHITECTURE.md) |
| Настроить переменные окружения | [Полный справочник конфигурации](docs/ENV_CONFIGURATION.md) |
| Развернуть PostgreSQL-трекер | [PostgreSQL runbook](docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md) |
| Запустить несколько репозиториев | [Fleet](docs/FLEET_OPERATIONAL_RUNBOOK.md) |
| Использовать Telegram intake | [Telegram](docs/TELEGRAM_TASK_INTAKE.md) |
| Понять хранение контекста | [Repository memory](docs/MEMORY_LIFECYCLE.md) |
| Настроить HTTP, метрики и alerts | [Observability](docs/OBSERVABILITY_RUNBOOK.md) |
| Настроить локальный Docker и Windows | [Docker](docs/LOCAL_DOCKER_RUN.md) · [PowerShell](docs/WINDOWS_POWERSHELL_QUICKSTART.md) |
| Решить проблему авторизации Codex | [Auth troubleshooting](docs/CODEX_AUTH_TROUBLESHOOTING.md) |
| Обновить Codex CLI | [CLI update runbook](docs/CODEX_CLI_UPDATE_RUNBOOK.md) |
| Разрабатывать UI | [Angular console](web/README.md) |
| Понять планы развития | [Дорожная карта](product_roadmap.md) · [архив исторических планов](docs/superpowers/README.md) |

## Область проекта и история

В `main` сохранено универсальное ядро AI-разработки. Эксперименты по поиску конкурентов Wildberries/Ozon вынесены в ветку [`archive/competitor-research-2026`](https://github.com/Absens/AI-Developer-Worker/tree/archive/competitor-research-2026), чтобы не связывать движок инженерных задач с конкретным маркетплейсным продуктом.

Новые функции желательно добавлять как отдельные доменные компоненты и интеграции, с явной политикой доступа, тестами и документированными эксплуатационными последствиями. Требования к изменениям кода — в [AGENTS.md](AGENTS.md).

