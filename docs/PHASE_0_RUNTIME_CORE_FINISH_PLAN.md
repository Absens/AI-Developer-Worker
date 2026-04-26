# Phase 0 Runtime Core Finish Plan

_Актуально на 2026-04-26._

## Цель

Закрыть завершающий operational pass для уже поставленного runtime core: добавить безопасный preflight-режим и ручной запуск конкретной Tracker-задачи без изменения основного worker flow.

Источник: `product_roadmap.md`, раздел `Фаза 0 - Runtime Core`.

## Результат фазы

- Есть отдельная команда `npm run preflight` или режим `WORKER_PREFLIGHT_ONLY=true`.
- Preflight проверяет конфигурацию, Codex auth, git repository readiness, Tracker/GitLab доступы и команды в целевом репозитории.
- Preflight не переводит реальные Tracker-задачи между статусами и не создаёт production MR.
- Есть `TARGET_ISSUE_KEY`, который заставляет worker обрабатывать только одну указанную задачу.
- `TARGET_ISSUE_KEY` совместим с `WORKER_RUN_ONCE=true` и уважает текущие worker locks.

## Scope

В фазу входят:

- расширение конфигурации в `src/config.ts` и `src/models/types.ts`;
- отдельный preflight orchestration path в `src/index.ts`, `src/app.ts` или новом `src/domain/preflight.ts`;
- точечное изменение выбора задач в `src/domain/orchestrator.ts`;
- методы интеграций, нужные для non-destructive health checks;
- unit tests и smoke-path assertions.

В фазу не входят:

- review discussions;
- новые quality gates;
- multi-repository config;
- dashboard и metrics.

## Milestone 0.3: Explicit Preflight Mode

### Конфигурация

Добавить переменные:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WORKER_PREFLIGHT_ONLY` | No | `false` | Запускает только preflight и завершает процесс. |
| `TRACKER_PREFLIGHT_ISSUE_KEY` | No | None | Опциональная sandbox-задача для проверки comment write permission. |
| `GITLAB_PREFLIGHT_SOURCE_BRANCH` | No | None | Опциональная sandbox-ветка для строгой проверки MR write permission. |
| `PREFLIGHT_RUN_TARGET_COMMANDS` | No | `true` | Разрешает запуск `TEST_COMMAND` и `LINT_COMMAND` в target repo. |

Правило безопасности: без `TRACKER_PREFLIGHT_ISSUE_KEY` и `GITLAB_PREFLIGHT_SOURCE_BRANCH` preflight делает только read-only проверки соответствующих write scopes и выводит `WARN`, а не имитирует write мутациями в реальных задачах.

### Проверки

Preflight должен вернуть единый отчёт с `PASS`, `WARN`, `FAIL`:

| Check | Expected behavior |
| --- | --- |
| Config load | Проверить обязательные env vars и `TRACKER_STATUS_MAP_FILE`. |
| Codex auth | Переиспользовать `assertCodexAuthenticated`. |
| Git repository | Переиспользовать `git.assertRepositoryReady`, включая remote/fetch/commit identity. |
| Tracker read | Проверить доступ к queue/tag candidate search или к `TRACKER_PREFLIGHT_ISSUE_KEY`. |
| Tracker write | Если задан `TRACKER_PREFLIGHT_ISSUE_KEY`, добавить нейтральный preflight comment без смены статуса. |
| GitLab read | Проверить доступ к project MR list и текущему project id. |
| GitLab write | Если задана sandbox source branch, проверить возможность создать или найти draft/test MR по этой ветке; иначе `WARN`. |
| Target commands | Если `PREFLIGHT_RUN_TARGET_COMMANDS=true`, выполнить `TEST_COMMAND` и `LINT_COMMAND` в `REPO_PATH`. |

### Implementation Steps

1. Добавить `preflightOnly`, `trackerPreflightIssueKey`, `gitlabPreflightSourceBranch`, `preflightRunTargetCommands` в `AppConfig`.
2. Создать `PreflightService` в `src/domain/preflight.ts` с моделью:

```typescript
interface PreflightCheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  details: string;
}
```

3. Добавить методы в интеграции:
   - `TrackerClient.checkReadAccess()` или переиспользовать безопасный query;
   - `TrackerClient.addComment()` для sandbox issue;
   - `GitLabService.checkReadAccess()`;
   - опциональный `GitLabService.checkMergeRequestWriteAccess()`.
4. В `src/index.ts` после startup checks ветвиться на preflight и завершать процесс с exit code `1`, если есть хотя бы один `FAIL`.
5. Добавить `npm run preflight` в `package.json`.
6. Документировать режим в `docs/ENV_CONFIGURATION.md` и `.env.example`.

### Acceptance Criteria

- `npm run preflight` завершается без обработки Tracker-задач.
- Отчёт показывает все проверки в стабильном порядке.
- Отсутствие optional sandbox-параметров не падает, а даёт понятный `WARN`.
- Ошибка любой обязательной проверки даёт exit code `1`.
- Успешный preflight даёт exit code `0`.

## Milestone 0.4: Target Issue Mode

### Конфигурация

Добавить:

```env
TARGET_ISSUE_KEY=FRONTEND-42
```

### Behavior

- Если `TARGET_ISSUE_KEY` задан, `WorkerOrchestrator.runOnce()` не вызывает обычный queue scan.
- Worker загружает только указанную задачу через `TrackerClient.getIssue()`.
- Worker определяет logical status через `TrackerClient.determineLogicalStatus()`.
- Если задача занята другим worker по structured comment lock, текущий worker не начинает обработку.
- Если задача в `waiting_for_answer`, resume разрешён только при корректном `/resume` и matching worker metadata.
- Если задача уже в `review` и MR существует, worker не создаёт дубликаты.

### Implementation Steps

1. Добавить `targetIssueKey?: string` в `AppConfig`.
2. Вынести выбор задачи в отдельный метод оркестратора, например `pickTargetIssue()` и `pickNextQueueIssue()`.
3. Для target mode переиспользовать существующие проверки lock ownership из `isBusyByAnotherWorker`.
4. Добавить логирование target mode с issue key и current logical status.
5. Добавить unit tests в `tests/orchestrator.test.ts`:
   - target issue берётся вместо queue scan;
   - lock другого worker блокирует обработку;
   - `WORKER_RUN_ONCE=true` завершает процесс после target issue cycle;
   - missing issue или unsupported status даёт controlled failure.
6. Обновить `docs/ENV_CONFIGURATION.md` и `.env.example`.

### Acceptance Criteria

- `TARGET_ISSUE_KEY=FRONTEND-42 WORKER_RUN_ONCE=true npm run dev` обрабатывает только `FRONTEND-42`.
- При заданном target issue обычные candidate issues не запрашиваются.
- Worker не перехватывает задачу с активным lock другого worker.
- Повторный запуск target mode не создаёт дубликат MR для уже опубликованной ветки.

## Verification

Минимальный набор команд перед завершением фазы:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

Для preflight дополнительно выполнить один read-only прогон без sandbox-параметров и один строгий прогон с `TRACKER_PREFLIGHT_ISSUE_KEY`.

## Risks

| Risk | Mitigation |
| --- | --- |
| Невозможно проверить write permissions без мутаций | Делать строгую проверку только на явно указанной sandbox-задаче или sandbox-ветке. |
| Target mode случайно обходит worker lock | Переиспользовать один lock predicate для queue и target режимов. |
| Preflight начинает запускать дорогие target repo команды | Оставить `PREFLIGHT_RUN_TARGET_COMMANDS` отключаемым флагом. |
| Новый config ломает существующие `.env` | Все новые переменные должны быть optional с безопасными defaults. |

## Definition of Done

- Документация и `.env.example` описывают оба режима.
- Unit tests покрывают config parsing, preflight report и target issue selection.
- Smoke test подтверждает, что обычный queue flow не изменился.
- Roadmap items `0.3 Startup preflight` и `0.4 Target issue mode` можно отметить как completed.
