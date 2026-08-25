# Architecture Overview

Этот документ нужен как карта сопровождения проекта. Runbook-и в `docs/`
описывают отдельные операционные сценарии, а здесь собраны границы модулей,
runtime-потоки и места, которые обычно нужно менять вместе.

## Назначение

`ai-developer-worker` - Node.js/TypeScript процесс, который берет задачу из
Yandex Tracker или внутреннего task tracker, запускает Codex CLI в целевом
репозитории, проверяет результат, публикует ветку и merge request в GitLab и
записывает ход работы обратно в task system.

Проект также содержит:

- внутреннюю task-модель с PostgreSQL-хранилищем;
- Yandex bridge для импорта и зеркалирования задач;
- observability HTTP server с health/readiness/metrics, event timeline и human API;
- Angular human console в `web/`;
- Telegram Assistant как дополнительный Bot API-интерфейс к internal tracker;
- Telegram Digital Twin как перспективное направление для owner-approved
  Business/Secretary sessions поверх Telegram Assistant;
- Project Manager Agent для анализа проекта, целей, предложений задач и replanning.

## Runtime Entry Points

| Файл | Ответственность |
| --- | --- |
| `src/index.ts` | Минимальная точка входа: строит application, запускает preflight-only mode или runtime. |
| `src/app.ts` | Главный composition root: загружает config, создает tracker/git/gitlab/codex adapters, observability, cleanup, Telegram Assistant, Project Manager store и выбирает orchestrator. |
| `src/config.ts` | Единый parser `.env` и fleet YAML. Здесь задаются defaults, validation и compatibility checks. |
| `src/preflight.ts` | CLI wrapper для preflight без обработки очереди. |
| `scripts/internal-tracker-migrate.ts` | Применяет migrations для PostgreSQL internal tracker. |

Запуск `npm run dev` загружает `.env` и стартует `src/index.ts` через `tsx`.
Production bundle собирается в `dist/` командой `npm run build`, а
`npm run start` запускает `dist/index.js`.

## Runtime Modes

| Условие | Orchestrator | Source of truth |
| --- | --- | --- |
| `TASK_TRACKER_PROVIDER=yandex`, без `WORKER_CONFIG_FILE` | `WorkerOrchestrator` | Yandex issue statuses + structured comments. |
| `TASK_TRACKER_PROVIDER=internal`, без `WORKER_CONFIG_FILE` | `InternalWorkerOrchestrator` | Internal task tracker, обычно PostgreSQL. |
| `TASK_TRACKER_PROVIDER=yandex`, с `WORKER_CONFIG_FILE` | `FleetOrchestrator` | Yandex issues/comments, несколько repository profiles. |
| `TASK_TRACKER_PROVIDER=internal`, с `WORKER_CONFIG_FILE` | `InternalWorkerOrchestrator` с несколькими contexts | Internal tracker + repository profiles from fleet YAML. |
| `WORKER_PREFLIGHT_ONLY=true` или `npm run preflight` | `PreflightService` | Проверки окружения без обработки задач. |

`WORKER_RUN_ONCE=true` выполняет один цикл и завершает процесс. В continuous
режиме orchestrator повторяет циклы с `POLL_INTERVAL_MINUTES` и завершает
текущую задачу перед shutdown.

## Task Execution Flow

Упрощенный flow для обычной реализации:

1. Загрузить config и поднять HTTP/observability surface, если он включен.
2. Проверить target repository и Codex auth до изменения задач.
3. Найти или восстановить задачу: Yandex queue/tag, explicit `TARGET_ISSUE_KEY`
   или internal atomic claim queue.
4. Проверить task/repository lease и `blocked_by` зависимости.
5. Подготовить ветку `feature/ai-task-{id}` в target repository.
6. Собрать context: task description, comments, prompt profile, optional
   repository memory и image attachments.
7. Запустить Codex analysis и выбрать режим: implement, decompose, analyze-only
   или human/manual hold.
8. Для implementation: запустить Codex, затем quality gates в порядке
   `typecheck -> lint -> tests -> build -> security_scan -> sast -> coverage -> visual_regression`.
9. Если включен `CODEX_SELF_REVIEW_ENABLED`, выполнить `codex exec review`
   после quality gates и до публикации MR.
10. Создать commit, push, переиспользовать или создать GitLab merge request.
11. Записать результат обратно в Tracker/internal tracker и observability.
12. После merge MR задача не считается принятой автоматически: она переходит в
   review/human testing и ждет человеческого acceptance.

Если Codex возвращает `AI_QUESTION:`, worker сохраняет `threadId`, переводит
задачу в ожидание и возобновляет тот же Codex-сеанс только после явной команды
человека `/resume`, `/skip` или `/cancel`.

## Main Module Boundaries

| Path | Что здесь живет |
| --- | --- |
| `src/domain/orchestrator.ts` | Direct Yandex flow, structured comments protocol, branch/MR lifecycle, review feedback, self-review gate. |
| `src/domain/internalWorkerOrchestrator.ts` | Internal tracker flow: atomic claim, leases, lifecycle events, task records, Yandex bridge sync. |
| `src/domain/fleetOrchestrator.ts` | Multi-repository Yandex routing, repository-level leases and queue/tag matching. |
| `src/domain/taskTracker/` | Provider-neutral internal task domain: statuses, queue eligibility, field ownership, proposals, leases. |
| `src/domain/projectManager/` | Project Manager analysis/replan/strategy prompts, stores and policies. |
| `src/domain/telegramAssistant/` | Telegram intents, write confirmations, notifications, project Q&A, digital twin/profile automation state. |
| `src/domain/promptBuilder.ts` | Prompt contracts for analysis, implementation, resume, fix, decomposition and intake review. |
| `src/domain/qualityGates.ts` | Ordered target-repository validation commands and diagnostics formatting. |
| `src/domain/memoryStore.ts` | File-based repository memory used to enrich prompts. |
| `src/integrations/tracker/` | Yandex Tracker API adapter and structured comment protocol. |
| `src/integrations/internalTracker/` | PostgreSQL implementation, migrations, cleanup and factory for internal tracker. |
| `src/integrations/yandexBridge/` | Import/export bridge between Yandex issues and internal task records. |
| `src/integrations/codex/` | Codex CLI process runner, JSONL parsing, auth checks and resume/review support. |
| `src/integrations/git/` | Target repository branch, diff, commit and push operations. |
| `src/integrations/gitlab/` | GitLab REST API adapter for merge requests and review discussions. |
| `src/integrations/telegram/` | Low-level Telegram Bot API client, polling and webhook transport. |
| `src/observability/` | HTTP server, metrics, events, alerts, redaction and human task API. |
| `web/` | Angular human console for internal tracker workflows. |

Keep business decisions in `src/domain/`. Adapters in `src/integrations/`
should translate external APIs into local contracts and avoid owning workflow
policy.

## Internal Tracker

Internal tracker mode is the production path for structured task state. The
canonical entities live in `src/domain/taskTracker/types.ts`; PostgreSQL storage
lives in `src/integrations/internalTracker/postgresTaskTracker.ts`, with schema
migrations in `src/integrations/internalTracker/migrations/`.

Important invariants:

- PostgreSQL is the production storage adapter; in-memory storage is for tests
  and local smoke scenarios.
- Claiming uses task and repository leases so workers do not mutate the same
  target repository concurrently.
- `TaskRecord` owns lifecycle, decisions, plans, agent runs, validations, merge
  requests, dependencies, comments, artifacts and proposal metadata.
- Field ownership rules protect human/system/agent-owned task fields.
- Yandex sync is optional and only valid for `TASK_INTAKE_MODE=yandex_integration`
  or `hybrid`.

Run migrations with `npm run tracker:migrate` before starting internal provider
against PostgreSQL.

## Human Surfaces

### Observability HTTP Server

`src/observability/server.ts` exposes `/healthz`, `/readyz`, `/metrics`,
event state and optional human task API. The server starts when observability is
enabled, or when the task tracker UI/API is enabled.

The human API implementation is in `src/observability/taskTrackerHumanApi.ts`.
It is workflow-oriented rather than generic CRUD: queue views, task detail,
commands, proposals, goals and Project Manager runs are exposed as explicit
operations.

### Angular Console

`web/` contains the Angular console served under `/tasks` in production when
`TASK_TRACKER_UI_STATIC_DIR` points to the built bundle. JSON requests go to the
Node server under `TASK_TRACKER_UI_API_PATH`, default `/api`.

The browser app does not store bearer tokens. Deployments should use localhost
mode for local development, trusted proxy role headers, or a reverse proxy that
injects `Authorization`.

### Telegram Assistant

Telegram Assistant is optional and disabled by default. It uses the internal
`TaskTrackerClient` directly instead of calling the human HTTP API. It can read
task status, create task drafts with confirmation, answer AI questions,
subscribe users to notifications and run project Q&A through Codex.

Telegram state is separate from task state. The store keeps offsets, processed
updates, locks, pending actions, subscriptions and retention-limited audit data;
the task source of truth remains internal tracker.

Confirmed Telegram task drafts currently create internal task records for
triage/review. They do not automatically become executable worker queue items:
the task must also have execution fields such as `repoPathKey`, `baseBranch` and
`queue`, then move to `ready` before `InternalWorkerOrchestrator` can claim it.
See `docs/TELEGRAM_TASK_INTAKE.md` for the current intake boundary and the
missing end-to-end work.

### Telegram competitor research and source verification

Marketplace competitor research reuses the Telegram Assistant turn lifecycle but
has a stricter data-quality boundary than project Q&A. `compose.yaml` runs the
official Playwright MCP server as an internal isolated Chromium sidecar. At
worker startup, `scripts/configure-playwright-mcp.mjs` owns only a delimited
Playwright section in writable `CODEX_HOME/config.toml`; all other Codex settings
remain user-owned. The managed server is disabled by default. Only
`researchMarketplaceCompetitors()` opts its Codex run in through a CLI config
override; project Q&A, implementation, review and Digital Twin runs remain
browser-free.

Before starting Codex, the worker resolves the current Wildberries media shard
from `https://cdn.wbbasket.ru/api/v3/upstreams` and reads the product's public
`card.json`. The adapter accepts only `basket-NN.wbbasket.ru` hosts, verifies
that `nm_id` exactly equals the article from the Telegram URL, and passes the
bounded title, brand, category, description and attributes to the research
prompt. This path is independent of `detail.aspx`, which Wildberries may answer
with anti-bot HTTP 403/498 for an isolated browser.

For a regular Ozon `/product/<slug>-<sku>/` URL, `OzonProductResearch` calls a
bounded internal `ozon-research` HTTP service. That broker is the only service on
both the application network and the private `ozon-browser` network; it uses the
dedicated Playwright MCP sidecar with a shared browser context. It
navigates to the exact card and extracts bounded read-only page data with a
fixed browser evaluation: final URL, Product JSON-LD, breadcrumbs,
characteristics and Ozon product links. Verification requires the requested SKU
to match the final canonical URL, JSON-LD `sku` and JSON-LD offer URL. A redirect
to search, missing title, absent JSON-LD or any SKU mismatch fails closed. Short
Ozon `/t/` links are outside the initial contract.

Ozon can reject a fresh automation context with an anti-bot challenge or HTTP
403. The dedicated sidecar may load a pre-warmed anonymous Playwright storage
state mounted read-only from an absolute host directory outside the repository.
The local headed bootstrap starts a new Chrome context, never a user profile, and
saves state only after a browser-side composer API canary returns HTTP 200 and
the page's primary Product JSON-LD contains the exact requested SKU. Account-like
cookie or local-storage names reject the state. As an alternative, the local
unpacked Chrome extension can export only bounded Ozon cookies and Ozon local
storage from a signed-out trusted profile. A separate importer validates the
candidate outside the repository, opens it in a fresh context, runs the same exact
SKU canary and atomically promotes only the resulting sanitized state. The extension
does not call the network, the importer never logs values, and neither path exposes
browser state to the worker. The raw MCP endpoint is not on
the worker/Codex network; only field-whitelisted, count/string/byte-bounded public
inspection data crosses the broker. The dedicated browser network permits egress
to Ozon but worker is not attached to it.
The verifier never trusts a
search snippet or model-declared identity; a missing, expired or fingerprint-bound
state still fails closed before Codex.

If CDN verification is unavailable or inconsistent, the flow falls back to the
original browser-first gate. Codex must navigate to the exact card URL, wait for
dynamic loading, and derive the requested article and product title from an
accessibility snapshot or a network response before using web search.
`CliCodexRunner` captures completed MCP calls from `codex exec --json`, and the
fallback accepts a model-declared verification only when successful Playwright
calls include `browser_navigate` plus either `browser_snapshot` or
`browser_network_request`.

`TelegramAssistantService` keeps the final fail-closed source gate. If the
requested and resolved articles differ, title/evidence is missing, a failure
reason remains, or the marketplace-specific verifier cannot establish the exact
card, the turn is completed as `failed` with metric outcome `unverified`. Ozon
does not use the model-declared browser fallback; it requires the worker-owned
Playwright inspection described above. No
competitor summary or HTML artifact is emitted. This prevents a search-engine
inference from silently becoming the identity of the source product.

After the source passes that gate, `WildberriesCompetitorDiscovery` queries the
Wildberries catalog using the verified source category. The worker resolves the
bounded article pool through the existing `card.json` verifier and retains only
cards whose verified category matches the source. These trusted candidates are
provided to Codex and also seed the post-processing result, so WB `detail.aspx`
`403/498` responses cannot erase otherwise valid competitors. The structured
Codex output still accepts only unique numeric articles with exact canonical
`https://www.wildberries.ru/catalog/<article>/detail.aspx` URLs and rejects the
source article. The worker then verifies every remaining article through the
same Wildberries `card.json` adapter. Telegram and HTML narratives are rebuilt
from that verified set, so free-form model text and rejected external products
cannot become delivered competitors. When fewer than five cards are confirmed,
the result stays partial and states the limitation instead of filling the gap
from another marketplace or a search snippet.

For Ozon, candidates come only from Ozon product links on the verified source
card. Each candidate is opened and verified in a separate bounded Playwright MCP
session; same-SKU, cross-marketplace, malformed, unverified and
category-mismatched cards are discarded. Ozon browser verification runs
sequentially in both discovery and final-result gates to avoid an unbounded group
of Chromium sessions. Failed or undefined inspections are evicted immediately;
successful page inspections have a bounded TTL so one Telegram turn can reuse
the source data without making a transient challenge permanent. One deadline
derived from `TELEGRAM_CODEX_TIMEOUT_SECONDS` covers source verification,
discovery, Codex and final verification. The output schema
is selected per source marketplace, and the final parser and verification
boundary independently enforce that every delivered competitor belongs to that
same marketplace.

The delivery DTO also carries a bounded structured comparison for every accepted
card: similarities, differences, strengths, weaknesses and one opportunity for
the source card. The verifier, rather than Codex, supplies the delivered title,
brand, category, attributes and canonical URL. Telegram renders a short decision
summary plus named links to confirmed cards. The self-contained HTML renderer
separates trusted card metadata from analytical conclusions, adds a compact
competitor matrix, human-readable UTC timestamps, explicit verification/partial
result badges and collapsible comparison/evidence details. Unsupported model
claims about price, rating, reviews, sales, stock or photo/video counts are
discarded at the structured-output boundary. The renderer does not parse the
model's free-form `summary` or `report` into trusted HTML.

### Telegram Digital Twin

Telegram Digital Twin is the forward-looking Telegram Assistant direction for
Telegram Business/Secretary chats. Unlike one-shot project Q&A or task commands,
it keeps durable per-contact sessions, continues Codex threads with `runResume`,
records inbound/outbound delivery state, and can answer on behalf of the owner
when Telegram business rights, local allowlists and owner consent all pass.

The feature is configured by `telegramAssistant.digitalTwin` in fleet config or
`TELEGRAM_DIGITAL_TWIN_*` env vars. Keep `TELEGRAM_DIGITAL_TWIN_ENABLED=false`
unless the deployment has a documented consent model, clear owner/admin control
paths, and retention decisions for redacted audit and optional encrypted full
text. The current design deliberately separates Digital Twin state from worker
implementation threads and from internal task state:

- session state stores persona version, Codex thread id, status and summary
  refresh markers;
- message/turn state handles idempotency, queued messages, sent Telegram
  message ids and one-running-turn-per-session guards;
- audit retention is handled by Telegram Assistant cleanup using
  `TELEGRAM_DIGITAL_TWIN_REDACTED_RETENTION_DAYS`,
  `TELEGRAM_DIGITAL_TWIN_FULL_TEXT_RETENTION_DAYS` and optional
  `TELEGRAM_DIGITAL_TWIN_AUDIT_ENCRYPTION_KEY_ENV`;
- future product work should evolve this boundary instead of mixing Digital
  Twin behavior into task execution or Project Manager flows.

Detailed product and implementation notes live in
`docs/superpowers/specs/2026-06-15-telegram-digital-twin-sessions-design.md`
and `docs/superpowers/plans/2026-06-15-telegram-digital-twin-sessions.md`.
The task-creation path for Digital Twin is not implemented yet; the current
Digital Twin branch is conversational and must gain an explicit owner-approved
task tool/action boundary before it can create executable tasks.

## Project Manager Agent

Project Manager is disabled by default and requires internal tracker mode. It
uses repository/task signals to produce strategy analysis, goals, task proposals
and replanning decisions. It should not bypass task/proposal policy:

- proposal generation is controlled by autonomy policy;
- low-risk auto execution is opt-in and limited by task type and repository
  policy;
- human approval remains required for goals when
  `PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL=true`.

Core files are under `src/domain/projectManager/`, with PostgreSQL persistence
in `src/integrations/internalTracker/postgresProjectManagerStore.ts`.

## Configuration Rules

When adding or changing configuration, update these together:

- `src/config.ts` parser/default/validation;
- `src/models/types.ts` config types;
- `.env.example` operator-facing defaults;
- `docs/ENV_CONFIGURATION.md` full variable table;
- `tests/config.test.ts` focused parser coverage;
- fleet YAML docs/runbooks if the option is also supported in `WORKER_CONFIG_FILE`.

For operational behavior changes, also check:

- `README.md` for the quick overview;
- `docs/LOCAL_DOCKER_RUN.md` and `docs/WINDOWS_POWERSHELL_QUICKSTART.md` for local run impact;
- `docs/OBSERVABILITY_RUNBOOK.md` for metrics, alerts, UI/API and Telegram surfaces;
- `docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md` for schema, cleanup or backup implications.

## Test Map

| Change area | Typical verification |
| --- | --- |
| TypeScript/domain/config | `npm run typecheck`, `npm test` or focused `vitest run tests/<name>.test.ts`. |
| Direct worker flow | `npm run test:smoke`, targeted orchestrator tests. |
| Internal tracker/PostgreSQL | `npm run tracker:migrate`, internal tracker tests, `npm run preflight` in real env. |
| Codex CLI contract | `npm run verify:codex-cli`; use `CODEX_CONTRACT_LIVE=1` only in an environment with safe live auth. |
| Angular console | `npm run web:typecheck`, `npm run web:test`, `npm run web:build`, `npm run web:e2e`. |
| Docker/local ops docs | `docker compose up --build` in one-shot mode where credentials are available. |

Documentation-only changes normally do not require the full test suite, but
links, script names and env var names should still be checked against
`package.json`, `.env.example` and `src/config.ts`.

## Common Change Recipes

- New worker behavior: start in `src/domain/orchestrator.ts` and
  `src/domain/internalWorkerOrchestrator.ts`; keep direct Yandex and internal
  tracker semantics aligned unless the difference is intentional.
- New task field or status: update `src/domain/taskTracker/types.ts`,
  `status.ts`, field ownership rules, storage adapters, human API DTOs and web
  mappers.
- New external API behavior: keep retry/redaction/normalization in the relevant
  `src/integrations/*` adapter and expose a small domain-facing method.
- New prompt contract: update `src/domain/promptBuilder.ts`, parser/validator
  tests and any docs that describe the AI marker.
- New human UI workflow: update `src/observability/taskTrackerHumanApi.ts`,
  `web/src/app/models/`, `web/src/app/services/`, page/component tests and
  `web/e2e` when it affects critical flows.
- New Telegram Digital Twin behavior: update `src/domain/telegramAssistant/`
  session/store/service boundaries, PostgreSQL migration or retention behavior
  when persistence changes, `docs/ENV_CONFIGURATION.md`, and
  `docs/OBSERVABILITY_RUNBOOK.md`. Do not route Digital Twin writes through the
  human HTTP API.
- New environment variable: follow the configuration rules above and include a
  preflight or parser test when the variable affects startup safety.

## Operational Guardrails

- Run `npm run preflight` before a continuous worker run in a new environment.
- Use `WORKER_RUN_ONCE=true` for the first real task in any new setup.
- Do not share a writable OAuth `CODEX_HOME` across active workers; use API key
  auth or one auth volume per worker.
- Keep `.env`, `.codex-home/` and Codex auth state out of git.
- Treat merged GitLab MRs as code-delivery evidence, not human acceptance.
- Keep target repository credentials and validation commands aligned with the
  actual repository mounted at `REPO_PATH`.
