# Phase 6 Dashboard and Observability Plan

_Актуально на 2026-04-27._

## Цель

Дать оператору картину состояния worker fleet без чтения stdout JSON logs: метрики, health endpoints, read-only dashboard, failure diagnostics и alerts по критичным событиям.

Источник: `product_roadmap.md`, раздел `Фаза 6 - Dashboard и наблюдаемость`.

## Результат фазы

- Worker отдаёт Prometheus-compatible `/metrics`.
- Есть `/healthz` и `/readyz` endpoints для container/orchestrator probes.
- Runtime события задач попадают в небольшой event store для dashboard и diagnostics.
- Dashboard MVP показывает workers, текущие задачи, recent tasks, MR/status links, failures, duration и success rate.
- Alerts работают для failed task, auth/preflight failure, blocked queue, MR ready, repeated Codex timeouts и repeated validation failures.
- Observability layer не меняет бизнес-логику обработки задач и может быть отключён конфигом.

## Scope

В фазу входят:

- telemetry abstraction и metrics registry;
- HTTP server для `/metrics`, health/readiness и dashboard API;
- read-only web dashboard MVP;
- event store для последних task lifecycle events;
- alert rules и notification sinks для Slack/Telegram/webhook;
- tests и operational runbook;
- `.env.example`, fleet YAML examples и Docker/Compose snippets для безопасного включения observability.

В фазу не входят:

- distributed tracing;
- long-term analytics warehouse;
- full authentication/authorization portal;
- multi-tenant SaaS dashboard;
- replacing JSON stdout logs;
- external monitoring stack provisioning;
- central dashboard aggregator across many worker processes;
- remote task control actions from dashboard.

## Recommended MVP Cut For Next Session

Начинать Phase 6 стоит с observability backbone, без UI и alert channels:

1. Add config and `ObservabilityService` with no-op default.
2. Add in-memory metrics registry and Prometheus text rendering.
3. Start one HTTP server from `src/index.ts`/`src/app.ts` lifecycle and expose `/healthz`, `/readyz`, `/metrics`.
4. Instrument only high-value paths first: worker state, task picked/done/failed, Codex duration, validation gate results, MR created/reused and queue depth.
5. Add in-memory event store and `/api/workers`, `/api/tasks/recent`, `/api/failures/recent`.
6. Add static dashboard after API contracts are stable.
7. Add alert evaluation after events/snapshots exist and are covered by tests.

MVP should not implement central aggregation, distributed tracing, persistent analytics DB, write controls, complex auth portal or per-user permissions.

## Design Principles

- Metrics first: Prometheus format дешевле и полезнее dashboard на раннем этапе.
- Dashboard читает snapshots/events, но не управляет worker state.
- Observability failures must not break task processing.
- Logs, metrics and events share stable ids: `workerId`, `repositoryName`, `issueKey`, `mergeRequestIid`, `threadId`.
- No secrets in metrics labels, logs, dashboard API or alerts.
- Cardinality must stay bounded: avoid raw branch names and long issue titles as metric labels.
- Single-repo `.env` mode and fleet `WORKER_CONFIG_FILE` mode must use the same observability interfaces.
- Dashboard/API payloads may include issue keys and MR URLs, but Prometheus labels must stay low-cardinality.

## Architecture and Ownership

Add a narrow observability layer under `src/observability/`:

```text
src/observability/
  config.ts
  metrics.ts
  events.ts
  server.ts
  state.ts
  redaction.ts
  alerts.ts
  dashboardAssets.ts
```

Suggested high-level contract:

```typescript
interface ObservabilityService {
  metrics: MetricsRegistry;
  events: EventStore;
  state: WorkerStateRegistry;
  alerts: AlertService;
  start(): Promise<void>;
  markReady(): void;
  markNotReady(reason: string): void;
  stop(): Promise<void>;
}
```

`WorkerOrchestrator` and `FleetOrchestrator` should receive a small telemetry facade rather than importing HTTP/server code. The facade should be no-op when observability is disabled, so domain code can emit lifecycle facts without branching on config.

### Process Model

Phase 6 observes one Node.js worker process. In fleet mode that process may manage many repositories, so labels and snapshots include `repositoryName`. If operators run several worker processes, each process exposes its own metrics/dashboard port; Prometheus or an external reverse proxy does aggregation. A central multi-process dashboard is out of scope for Phase 6.

### Startup and Shutdown Lifecycle

- Build observability during `buildApplication()` after config is parsed.
- Start the HTTP server before long preflight/startup checks, with readiness initially false.
- Set readiness true only after repository readiness and Codex auth checks pass.
- Set readiness false on graceful shutdown signal before stopping the polling loop.
- Close the HTTP server in `finally` on controlled shutdown.
- If the metrics/dashboard port is already in use, default behavior should fail startup with an actionable error when observability is enabled. A future `OBSERVABILITY_STRICT_STARTUP=false` can downgrade server startup failure to warning for local debugging only.
- In `WORKER_RUN_ONCE=true`, expose endpoints only while the single run is active and close them before process exit.
- In `WORKER_PREFLIGHT_ONLY=true`, either do not start the server or expose `/readyz=false`; choose one behavior and document it in the runbook.

## Milestone 6.1: Prometheus Metrics First

### Configuration

Add optional config:

```env
OBSERVABILITY_ENABLED=true
OBSERVABILITY_HOST=0.0.0.0
OBSERVABILITY_PORT=9464
OBSERVABILITY_BASE_URL=http://localhost:9464
OBSERVABILITY_STRICT_STARTUP=true
OBSERVABILITY_REDACT_MAX_CHARS=4000
METRICS_ENABLED=true
METRICS_PATH=/metrics
HEALTH_PATH=/healthz
READY_PATH=/readyz
```

`METRICS_HOST` and `METRICS_PORT` should not be separate from the HTTP server in the first implementation. If backward-compatible aliases are needed, parse them as aliases for `OBSERVABILITY_HOST` and `OBSERVABILITY_PORT`.

Single-repo `.env` and fleet config should both support these settings. In fleet YAML:

```yaml
observability:
  enabled: true
  host: 0.0.0.0
  port: 9464
  baseUrl: http://worker-1.internal:9464
  strictStartup: true
  metrics:
    enabled: true
    path: /metrics
  health:
    path: /healthz
    readinessPath: /readyz
```

### Metrics Registry

Create `src/observability/metrics.ts`:

```typescript
interface MetricsRegistry {
  incrementCounter(name: string, labels?: MetricLabels, value?: number): void;
  observeHistogram(name: string, labels: MetricLabels, value: number): void;
  setGauge(name: string, labels: MetricLabels, value: number): void;
  renderPrometheus(): string;
}
```

MVP can implement Prometheus text exposition directly to avoid adding a dependency. If a package is preferred later, keep the interface stable.

### Required Metrics

Implement roadmap metrics:

```text
ai_developer_tasks_total{status,repository}
ai_developer_task_duration_seconds_bucket{repository,outcome}
ai_developer_codex_duration_seconds_bucket{repository,stage}
ai_developer_fix_attempts_total{repository,stage,outcome}
ai_developer_mr_created_total{repository}
ai_developer_queue_depth{repository,queue}
ai_developer_clarifications_total{repository,reason}
```

Add operational metrics:

```text
ai_developer_worker_up{worker_id}
ai_developer_worker_state{worker_id,state}
ai_developer_active_task{worker_id,repository}
ai_developer_validation_gate_duration_seconds_bucket{repository,gate}
ai_developer_validation_gate_failures_total{repository,gate}
ai_developer_review_fix_cycles_total{repository,outcome}
ai_developer_lease_acquire_failures_total{repository,kind}
ai_developer_memory_operations_total{repository,operation,outcome}
ai_developer_preflight_checks_total{check,status}
ai_developer_integration_errors_total{integration,kind}
ai_developer_alerts_total{rule,severity,outcome}
ai_developer_observability_dropped_events_total{reason}
ai_developer_build_info{version,commit}
```

Label guardrails:

- use `repository`, not raw `repoPath`;
- use `status`/`outcome`, not arbitrary diagnostics;
- avoid `issueKey` labels in Prometheus metrics to prevent high cardinality;
- issue-level data belongs to event store/dashboard, not metrics labels;
- keep `worker_id` label bounded to configured worker ids;
- never use full command, local file path, raw branch, MR title or error text as a label.

Histogram buckets:

- task duration: `30s`, `60s`, `120s`, `300s`, `600s`, `1200s`, `1800s`, `3600s`, `7200s`;
- Codex duration: `10s`, `30s`, `60s`, `120s`, `300s`, `600s`, `1200s`, `1800s`;
- quality gates: `1s`, `5s`, `10s`, `30s`, `60s`, `120s`, `300s`, `600s`;
- keep bucket config static in MVP; custom buckets can wait until real data shows a need.

### Instrumentation Points

Instrument:

- `FleetOrchestrator.runOnce()` and `WorkerOrchestrator.processSelectedIssue()`;
- task lifecycle transitions: picked, analysis, implementation, validation, review fix, publish, failed, waiting;
- Codex runner duration by stage;
- quality gate duration/failure;
- GitLab MR create/reuse/reply;
- Tracker transitions/comments failures;
- lock acquire/renew/release failures;
- memory bootstrap/load/learning failures.

### Health and Readiness

Add HTTP endpoints:

- `/healthz`: process is alive and event loop can respond;
- `/readyz`: config loaded, repository contexts built, startup checks completed;
- `/metrics`: Prometheus text.

Readiness should fail before startup checks finish and after fatal initialization errors.

Response contracts:

- `/healthz` returns `200` with `{ "status": "ok" }` or plain `ok`.
- `/readyz` returns `200` when ready and `503` when not ready, with a short reason.
- `/metrics` returns `200`, content type `text/plain; version=0.0.4; charset=utf-8`.
- unknown paths return `404`; unsupported methods return `405` where simple to implement.

### Acceptance Criteria

- `/metrics` returns valid Prometheus text.
- Metrics can be disabled without changing worker behavior.
- Queue depth is reported per repository/queue.
- Task duration and Codex duration are observed for successful and failed tasks.
- `/healthz` is cheap and does not call external APIs.
- `/readyz` reflects startup/preflight readiness state.
- HTTP server shuts down cleanly on `SIGINT`/`SIGTERM`.
- Port conflict behavior is covered by config or server tests.

## Milestone 6.2: Event Store and Dashboard API

### Event Store

Create `src/observability/events.ts`:

```typescript
interface TaskEvent {
  id: string;
  timestamp: string;
  workerId: string;
  repositoryName?: string;
  issueKey?: string;
  mergeRequestUrl?: string;
  mergeRequestIid?: number;
  branch?: string;
  type: TaskEventType;
  status: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}

interface EventStore {
  append(event: TaskEvent): Promise<void>;
  listRecent(input: { limit: number; repositoryName?: string }): Promise<TaskEvent[]>;
  getCurrentWorkerStates(): Promise<WorkerStateSnapshot[]>;
}
```

Event types:

```typescript
type TaskEventType =
  | "worker_started"
  | "worker_ready"
  | "worker_stopping"
  | "queue_polled"
  | "task_candidate_found"
  | "task_picked"
  | "task_lease_acquired"
  | "task_lease_blocked"
  | "analysis_started"
  | "analysis_completed"
  | "clarification_requested"
  | "manual_hold"
  | "decomposition_started"
  | "decomposition_completed"
  | "implementation_started"
  | "implementation_completed"
  | "validation_started"
  | "validation_completed"
  | "review_fix_started"
  | "review_fix_completed"
  | "publish_started"
  | "mr_ready"
  | "task_failed"
  | "task_waiting";
```

MVP storage:

- in-memory ring buffer for recent events;
- optional JSONL persistence:

```env
OBSERVABILITY_EVENT_STORE=file
OBSERVABILITY_EVENT_STORE_FILE=/workspace/ai-developer-events/events.jsonl
OBSERVABILITY_EVENT_RETENTION=1000
```

File persistence is useful for process restart diagnostics but should be bounded.

Redaction contract:

- event messages are short summaries, not raw stdout/stderr dumps;
- `details` must pass through `redactSecrets()` before storing;
- truncate diagnostic strings to `OBSERVABILITY_REDACT_MAX_CHARS`;
- redact env var values, bearer tokens, Git remote credentials, local Codex auth paths and webhook URLs;
- store branch names in events/dashboard only when useful, never as metric labels.

If event persistence fails, increment `ai_developer_observability_dropped_events_total{reason="persistence_error"}` and keep the in-memory buffer alive.

### Dashboard API

Add read-only JSON endpoints:

```text
GET /api/workers
GET /api/tasks/recent?limit=50&repository=client-application
GET /api/repositories
GET /api/failures/recent
GET /api/metrics/summary
```

Responses should be small, stable and secret-free. Dashboard API can run on the same HTTP server as metrics.

Suggested API shapes:

```typescript
interface WorkersResponse {
  workers: WorkerStateSnapshot[];
  generatedAt: string;
}

interface RecentTasksResponse {
  tasks: TaskSummary[];
  nextCursor?: string;
  generatedAt: string;
}

interface MetricsSummaryResponse {
  repositories: RepositorySummary[];
  totals: {
    activeTasks: number;
    successRatePercent: number;
    failedTasks24h: number;
    averageTaskDurationSeconds?: number;
  };
}
```

Use `limit` with a hard maximum, for example `200`, and default to `50`. Cursor pagination can be added later; MVP may return only the latest bounded slice.

### State Snapshots

Track worker state:

```typescript
type WorkerRuntimeState =
  | "starting"
  | "idle"
  | "polling"
  | "processing"
  | "waiting"
  | "error"
  | "shutting_down";
```

Snapshot fields:

- worker id;
- state;
- repository;
- current issue key;
- current stage;
- startedAt;
- lastHeartbeatAt;
- lastErrorSummary;
- active lease token hash or lease age, not raw token.

Repository summary fields:

- repository name;
- configured queues;
- active task count;
- current queue depth if known;
- tasks completed in last 24h;
- failures in last 24h;
- success rate over recent bounded window;
- average and p95 task duration when enough samples exist.

### Acceptance Criteria

- Task lifecycle events are emitted for all major stages.
- Recent events survive restart when file store is enabled.
- Dashboard API returns bounded results and does not expose tokens/env values.
- Worker state changes are visible through `/api/workers`.
- Event store failures degrade to logging warnings, not task failure.
- API endpoints use the same bearer-token protection as `/dashboard` when dashboard auth is configured.
- API response schemas are covered by tests with representative success, empty and failure states.

## Milestone 6.3: Web Dashboard MVP

### UI Scope

Build a small read-only operational dashboard. It should be dense and utilitarian:

- workers table: state, current task, repository, stage, heartbeat age, last error;
- repositories table: queue depth, active tasks, recent success/failure counts;
- recent tasks: Tracker issue -> branch -> MR -> status;
- failures panel: latest diagnostics with repository/issue/stage;
- trends summary: average task duration, success rate, validation failure count.

No task mutation controls in MVP.

### Implementation Options

Preferred MVP:

- serve static HTML/CSS/JS from `src/observability/dashboardAssets.ts` or `public/dashboard`;
- no frontend build pipeline;
- fetch read-only dashboard API;
- render tables and simple sparklines with plain browser APIs.

If the project already adds a frontend build system later, keep dashboard API independent.

### Configuration

```env
DASHBOARD_ENABLED=true
DASHBOARD_PATH=/dashboard
DASHBOARD_REFRESH_SECONDS=10
DASHBOARD_API_PATH=/api
```

Dashboard should be disabled by default if this worker is exposed outside a private network. If enabled, docs must state that it is intended for trusted internal networks unless auth is added.

### Security

MVP options:

- bind to internal interface by default;
- optional bearer token:

```env
DASHBOARD_BEARER_TOKEN=
```

- never display raw command stdout/stderr beyond truncated diagnostics;
- redact tokens, URLs with credentials and local auth paths;
- protect `/dashboard` and `/api/*` together when `DASHBOARD_BEARER_TOKEN` is set;
- disable CORS by default; if CORS is added later, allow only explicit origins.

### UI Details

Dashboard should prioritize fast scanning:

- top status strip: ready state, active tasks, failed tasks in last 24h, queue depth, latest alert;
- workers table sorted by state severity and heartbeat age;
- repository table sorted by active work and failures;
- recent tasks table with issue key, repository, stage, elapsed time, MR link and outcome;
- failures panel grouped by repository and stage;
- small trend area with success rate and duration windows, no heavy chart dependency.

Links:

- Tracker issue URL can be added only if a safe base URL is available in config.
- MR URL may be shown because it is already generated by GitLab integration.
- Local file paths should not be links in the dashboard.

### Acceptance Criteria

- `/dashboard` loads without a build step.
- Dashboard updates from API polling.
- Empty states are readable when no tasks have run.
- Failed tasks show enough diagnostic context to act.
- Dashboard does not expose secrets in rendered HTML or API payloads.
- Dashboard remains usable with JavaScript polling errors and shows stale-data state.
- Dashboard assets are served with conservative cache headers during MVP.

## Milestone 6.4: Alerts

### Configuration

```env
ALERTS_ENABLED=true
ALERT_CHANNELS=slack,telegram,webhook
SLACK_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ALERT_WEBHOOK_URL=
ALERT_MIN_SEVERITY=warning
ALERT_DEDUP_WINDOW_SECONDS=900
ALERT_QUEUE_BLOCKED_CYCLES=3
ALERT_CODEX_TIMEOUT_WINDOW_SECONDS=3600
ALERT_CODEX_TIMEOUT_THRESHOLD=3
ALERT_VALIDATION_FAILURE_WINDOW_SECONDS=3600
ALERT_VALIDATION_FAILURE_THRESHOLD=3
ALERT_WORKER_STALE_SECONDS=300
```

Fleet YAML:

```yaml
alerts:
  enabled: true
  minSeverity: warning
  dedupWindowSeconds: 900
  channels:
    - type: webhook
      urlEnv: ALERT_WEBHOOK_URL
```

### Alert Rules

MVP rules:

| Rule | Severity | Trigger |
| --- | --- | --- |
| `task_failed` | error | issue moved to `failed` or permanent task error. |
| `auth_failure` | error | Codex/Tracker/GitLab startup or preflight auth failure. |
| `queue_blocked` | warning | candidates exist but all blocked by leases/dependencies for N cycles. |
| `mr_ready` | info | MR created or reused and issue moved to review. |
| `codex_timeouts_repeated` | warning/error | N timeouts in a rolling window. |
| `validation_failures_repeated` | warning | repeated same gate failures in a rolling window. |
| `worker_stale` | error | no heartbeat/state update for threshold. |
| `clarification_waiting_sla` | warning | task waits for human answer longer than configured SLA. |

### Alert Service

Create `src/observability/alerts.ts`:

```typescript
interface AlertRule {
  id: string;
  evaluate(snapshot: ObservabilitySnapshot): Alert[];
}

interface NotificationSink {
  send(alert: Alert): Promise<void>;
}
```

Dedup:

- key by rule id + repository + issue key when present;
- suppress repeats within `ALERT_DEDUP_WINDOW_SECONDS`;
- still increment alert metrics.

State required for rules should come from `ObservabilitySnapshot`, not from ad hoc calls to Tracker/GitLab. Alerts must not call external APIs in MVP.

### Message Format

Keep alerts short:

- severity;
- repository;
- issue key;
- stage;
- MR URL if present;
- one-line diagnostic;
- dashboard link if enabled.

### Daily Digest

Roadmap mentions daily digest for managers. Treat it as Phase 6.4b or post-MVP:

- send one summary per configured local time window;
- include tasks completed, failed tasks, open review MRs, queue depth and average duration;
- do not include raw diagnostics unless severity is error;
- implement only after immediate alert rules are stable.

### Acceptance Criteria

- Alerts can be disabled globally.
- Missing channel credentials fail preflight with warning or fail based on strict config.
- Repeated identical alerts are deduplicated.
- Notification failures are logged and counted but do not fail task processing.
- `mr_ready` alerts can be configured as info-only or disabled.
- Alert evaluation is deterministic in tests with injected clock/time windows.
- Daily digest is either implemented or explicitly marked post-MVP in roadmap status.

## Redaction and Data Safety

Add `src/observability/redaction.ts` and use it before storing events, serving API responses or sending alerts.

Minimum redaction patterns:

- environment variable-like tokens: `*_TOKEN`, `*_KEY`, `PASSWORD`, `SECRET`;
- HTTP auth headers and bearer tokens;
- Git URLs with credentials, for example `https://user:token@host/path.git`;
- Slack/Telegram/webhook URLs;
- `CODEX_HOME` and local auth state paths;
- long stdout/stderr blocks beyond configured truncation.

Redaction should be tested directly. A redaction failure should prefer hiding too much over leaking a secret.

## Implementation File Map

Suggested implementation order and ownership:

| Area | Files |
| --- | --- |
| Config/types | `src/models/types.ts`, `src/config.ts`, `.env.example` |
| Service wiring | `src/app.ts`, `src/index.ts`, `src/domain/repositoryContext.ts` |
| Metrics | `src/observability/metrics.ts`, `tests/metrics.test.ts` |
| HTTP server | `src/observability/server.ts`, `tests/observabilityServer.test.ts` |
| State/events | `src/observability/state.ts`, `src/observability/events.ts`, `tests/eventStore.test.ts` |
| Instrumentation | `src/domain/orchestrator.ts`, `src/domain/fleetOrchestrator.ts`, `src/domain/qualityGates.ts`, `src/integrations/codex/runner.ts` |
| Dashboard | `src/observability/dashboardAssets.ts`, `tests/observabilityServer.test.ts` |
| Alerts | `src/observability/alerts.ts`, `tests/alerts.test.ts` |
| Docs | `docs/OBSERVABILITY_RUNBOOK.md`, `docs/ENV_CONFIGURATION.md`, `docs/LOCAL_DOCKER_RUN.md` |

Keep `src/observability/server.ts` free of business decisions; it should serialize data already prepared by registries/services.

## Operational Runbook

Add `docs/OBSERVABILITY_RUNBOOK.md`:

- configuration variables;
- Docker/Compose port exposure;
- Prometheus scrape example;
- health/readiness probe examples;
- dashboard access and security notes;
- alert channel setup;
- metric names and recommended panels;
- common diagnostics;
- rollback instructions for disabling dashboard, alerts or all observability.

Example Compose snippet:

```yaml
ports:
  - "9464:9464"
environment:
  OBSERVABILITY_ENABLED: "true"
  OBSERVABILITY_HOST: "0.0.0.0"
  OBSERVABILITY_PORT: "9464"
  METRICS_ENABLED: "true"
  DASHBOARD_ENABLED: "true"
```

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: ai-developer
    static_configs:
      - targets:
          - worker-1:9464
          - worker-2:9464
```

Kubernetes-style probe examples should be included even if Kubernetes manifests are not part of this repo:

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 9464
readinessProbe:
  httpGet:
    path: /readyz
    port: 9464
```

## Migration Plan

1. Add observability config with all features disabled by default except cheap in-process no-op telemetry.
2. Add `NoopTelemetry` and `InMemoryMetricsRegistry`.
3. Instrument lifecycle events without changing orchestration outcomes.
4. Add HTTP server for health/readiness/metrics.
5. Add event store and dashboard API.
6. Add static dashboard.
7. Add alert service and sinks.
8. Add runbook and `.env.example` updates.
9. Add smoke tests for metrics and dashboard endpoints.

## Rollout Plan

Recommended rollout:

1. Enable `OBSERVABILITY_ENABLED=true`, `METRICS_ENABLED=true`, `DASHBOARD_ENABLED=false`, `ALERTS_ENABLED=false` in a local `WORKER_RUN_ONCE=true` scenario.
2. Enable metrics in a long-running dev worker and verify Prometheus scrape.
3. Enable event store in memory-only mode and inspect API responses.
4. Enable dashboard on an internal interface with bearer token.
5. Enable file event store with low retention, then increase retention after disk usage is observed.
6. Enable alerts with webhook sink in a non-production channel.
7. Promote Slack/Telegram production alerts after dedup thresholds are tuned.

Rollback is config-only:

- `ALERTS_ENABLED=false` disables notifications;
- `DASHBOARD_ENABLED=false` keeps metrics/health but removes UI/API exposure if API is dashboard-scoped;
- `OBSERVABILITY_ENABLED=false` returns to no-op telemetry and no HTTP server.

## Testing Plan

Add or update:

- `tests/metrics.test.ts`: counters, gauges, histograms and Prometheus rendering.
- `tests/observabilityServer.test.ts`: `/healthz`, `/readyz`, `/metrics`, API endpoints.
- `tests/eventStore.test.ts`: ring buffer, JSONL persistence and retention.
- `tests/alerts.test.ts`: rule evaluation, dedup and sink failures.
- `tests/orchestrator.test.ts`: task lifecycle emits metrics/events.
- `tests/fleetOrchestrator.test.ts`: queue depth, blocked queue and worker state.
- `tests/worker.smoke.test.ts`: observability-enabled worker exposes endpoints.
- `tests/redaction.test.ts`: secret patterns, URL credentials and diagnostic truncation.
- `tests/config.test.ts`: env and fleet YAML observability defaults/overrides.

Test fixtures should include:

- single-repo `.env` config with observability disabled;
- fleet config with two repositories sharing one observability server;
- events containing secret-like diagnostics to verify redaction;
- alert snapshot fixtures with injected clocks for rolling-window rules.

## Verification

Minimum commands:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

Manual scenarios:

1. Start worker with `OBSERVABILITY_ENABLED=true`; `/healthz` returns `200`.
2. Before startup checks complete, `/readyz` reports not ready; after startup, ready.
3. Run one successful task; metrics show task count, duration and MR count.
4. Force validation failure; dashboard shows failure diagnostic and alert rule fires.
5. Run with dashboard disabled; metrics and worker behavior still work.
6. Configure invalid Slack webhook; alert failure is counted and logged without breaking task processing.
7. Start two worker processes with the same port; documented port conflict behavior occurs.
8. Send `SIGTERM`; `/readyz` flips not-ready before shutdown completes.
9. Trigger a diagnostic containing token-like text; API/dashboard/alert output is redacted.

## Risks

| Risk | Mitigation |
| --- | --- |
| High-cardinality metrics overload Prometheus | Keep issue keys and branches out of metric labels; put them in events/dashboard. |
| Dashboard exposes secrets | Redact diagnostics, never return env values, optional bearer token, internal bind by default. |
| Observability code changes worker behavior | Use no-op interfaces and catch/log telemetry failures. |
| Event store grows unbounded | Ring buffer and JSONL retention limits. |
| Alerts become noisy | Dedup window, severity threshold and per-rule enablement. |
| HTTP server conflicts with existing port | Configurable host/port and clear startup error. |
| Multiple worker processes need a single dashboard | Keep Phase 6 process-local; aggregate through Prometheus/reverse proxy later. |
| Event/alert processing adds latency | Use in-memory append, bounded data, no external API calls in alert evaluation. |
| Dashboard API becomes an accidental control plane | Keep all endpoints read-only and reject non-GET methods. |

## Definition of Done

- Prometheus `/metrics`, `/healthz` and `/readyz` are implemented and documented.
- Task lifecycle, Codex, validation, queue, lock, memory and integration events are instrumented.
- Dashboard MVP exposes worker state, current task, recent tasks, failures and summary metrics.
- Alerts support at least one webhook-style sink plus Slack or Telegram.
- Observability can be disabled without changing Phase 5 behavior.
- `docs/OBSERVABILITY_RUNBOOK.md` and `.env.example` document all new settings.
- Roadmap items `6.1`, `6.2` and `6.3` can be marked completed or MVP-completed.
