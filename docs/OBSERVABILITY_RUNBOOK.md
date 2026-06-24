# Observability Runbook

Phase 6 adds a process-local observability server for one worker process. It exposes health probes, Prometheus metrics, an in-memory or JSONL-backed recent event store, and optional webhook-style alerts.

Observability is disabled by default. Enable it only on a trusted interface or behind a private reverse proxy.

## Quick Enablement

Start with metrics and probes only:

```env
OBSERVABILITY_ENABLED=true
OBSERVABILITY_HOST=0.0.0.0
OBSERVABILITY_PORT=9464
METRICS_ENABLED=true
ALERTS_ENABLED=false
```

Then verify:

```bash
curl http://localhost:9464/healthz
curl http://localhost:9464/readyz
curl http://localhost:9464/metrics
```

In `WORKER_PREFLIGHT_ONLY=true`, the server is not started. In `WORKER_RUN_ONCE=true`, endpoints exist only while the single run is active and close before process exit.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `/healthz` | Cheap liveness check. Does not call Tracker, GitLab, Git, or Codex. |
| `/readyz` | Readiness check. Returns `503` until startup repository and Codex checks pass, and flips not-ready during shutdown. |
| `/metrics` | Prometheus text exposition when `METRICS_ENABLED=true`. |

Unsupported methods return `405`; unknown paths return `404`.

## Configuration

Core server settings:

```env
OBSERVABILITY_ENABLED=false
OBSERVABILITY_HOST=127.0.0.1
OBSERVABILITY_PORT=9464
OBSERVABILITY_BASE_URL=http://localhost:9464
OBSERVABILITY_STRICT_STARTUP=true
OBSERVABILITY_REDACT_MAX_CHARS=4000
METRICS_ENABLED=true
METRICS_PATH=/metrics
HEALTH_PATH=/healthz
READY_PATH=/readyz
```

Internal task UI/API:

```env
TASK_TRACKER_UI_ENABLED=false
TASK_TRACKER_UI_PATH=/tasks
TASK_TRACKER_UI_API_PATH=/api
TASK_TRACKER_UI_ASSET_PATH=/tasks/assets
TASK_TRACKER_UI_STATIC_DIR=web/dist/task-tracker-console/browser
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy
TASK_TRACKER_TRUSTED_USER_HEADER=x-task-tracker-user
TASK_TRACKER_TRUSTED_ROLE_HEADER=x-task-tracker-role
TASK_TRACKER_AGENT_TOKEN=
TASK_TRACKER_SYSTEM_TOKEN=
```

When enabled with `TASK_TRACKER_PROVIDER=internal`, `/tasks` serves the Angular
console when `TASK_TRACKER_UI_STATIC_DIR` points at a built bundle. The server
validates that directory at startup and serves Angular deep links without
swallowing `/api`, `/metrics`, `/healthz`, or `/readyz`. There is no embedded
task UI fallback after Phase 8D; if the UI is enabled without a static bundle,
`/tasks` returns a clear `503` and JSON API routes keep working.

Static cache behavior:

- `index.html` and Angular route fallbacks use `cache-control: no-store`;
- hashed Angular JS/CSS/media files use long immutable cache headers;
- non-hashed files under `/tasks/assets` use conservative short caching;
- missing assets return `404` rather than `index.html`.

Local Angular development:

```bash
npm install --prefix web
npm run web:dev
```

The Angular dev server runs at `http://127.0.0.1:4200/tasks` and proxies `/api`
to the Node.js observability server on `http://127.0.0.1:9464`.

Production bundle:

```bash
npm run web:typecheck
npm run web:test
npm run web:build
npm run web:e2e
```

Docker builds this bundle into the image and sets
`TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser`.
You can still mount a prebuilt bundle and override `TASK_TRACKER_UI_STATIC_DIR`
for self-hosted deployments.

Writes require backend authorization. In `trusted_proxy` mode, put the server
behind a proxy that injects the trusted user and role headers. In `bearer`
mode, use service clients or a reverse proxy that injects `Authorization`; the
Angular app does not provide a token entry field and does not store bearer
tokens in browser storage. `localhost` mode is development-only.

Event store:

```env
OBSERVABILITY_EVENT_STORE=memory
OBSERVABILITY_EVENT_RETENTION=1000
# OBSERVABILITY_EVENT_STORE=file
# OBSERVABILITY_EVENT_STORE_FILE=/workspace/ai-developer-events/events.jsonl
```

File store writes a bounded JSONL snapshot and reloads it on restart. Persistence failures are counted in `ai_developer_observability_dropped_events_total` and do not fail task processing.

Alerts:

```env
ALERTS_ENABLED=false
ALERT_CHANNELS=webhook
ALERT_WEBHOOK_URL=https://alerts.example.test/webhook
ALERT_MIN_SEVERITY=warning
ALERT_DEDUP_WINDOW_SECONDS=900
ALERT_QUEUE_BLOCKED_CYCLES=3
ALERT_CODEX_TIMEOUT_WINDOW_SECONDS=3600
ALERT_CODEX_TIMEOUT_THRESHOLD=3
ALERT_VALIDATION_FAILURE_WINDOW_SECONDS=3600
ALERT_VALIDATION_FAILURE_THRESHOLD=3
```

Supported channels are `webhook`, `slack`, and `telegram`. Slack uses `SLACK_WEBHOOK_URL`; Telegram uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Alert Telegram delivery is not Telegram Assistant. Alert channels send one-way
operator notifications and use `TELEGRAM_BOT_TOKEN`. Telegram Assistant uses
`TELEGRAM_ASSISTANT_BOT_TOKEN`, stores conversation references with retention,
and can create internal tracker writes only after role/confirmation checks.

## Fleet YAML

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
alerts:
  enabled: true
  minSeverity: warning
  channels:
    - type: webhook
      urlEnv: ALERT_WEBHOOK_URL
```

## Prometheus

Scrape example:

```yaml
scrape_configs:
  - job_name: ai-developer
    static_configs:
      - targets:
          - worker-1:9464
          - worker-2:9464
```

Recommended first panels:

- `ai_developer_worker_state`
- `ai_developer_active_task`
- `ai_developer_tasks_total`
- `ai_developer_task_duration_seconds_bucket`
- `ai_developer_codex_duration_seconds_bucket`
- `ai_developer_validation_gate_failures_total`
- `ai_developer_queue_depth`
- `ai_developer_alerts_total`
- `ai_developer_task_tracker_queue_depth`
- `ai_developer_task_tracker_claim_latency_seconds_bucket`
- `ai_developer_task_tracker_lease_conflicts_total`
- `ai_developer_task_tracker_sync_lag_seconds`
- `ai_developer_task_tracker_cleanup_deleted_total`
- `ai_developer_task_tracker_proposals`

Telegram Assistant metrics are emitted without raw message text, issue keys, or
chat content in labels:

- `telegram_updates_received_total`
- `telegram_updates_processed_total{outcome}`
- `telegram_messages_sent_total{outcome}`
- `telegram_intents_total{intent,outcome}`
- `telegram_codex_turns_total{intent,outcome}`
- `telegram_pending_actions_total{state}`
- `telegram_rate_limited_total{direction}`
- `telegram_processing_duration_seconds{intent}`
- `telegram_queued_messages_total{outcome}`
- `telegram_notification_delivery_total{outcome}`
- `telegram_polling_lease_skipped_total`

Use `telegram_updates_processed_total{outcome="failure"}` and
`telegram_rate_limited_total` for Bot API health, and
`telegram_pending_actions_total{state="pending"}` for stale confirmation
backlog. `direction="inbound"` means getUpdates/webhook processing or user daily
limits; `direction="outbound"` means sendMessage/callback delivery hit Telegram
`retry_after`.

Prometheus labels intentionally exclude issue keys, branch names, commands, local paths, and diagnostics.

## Task Timeline Mapping

The internal task timeline is the audit-grade history for one task. The
observability event store remains optimized for fleet telemetry. When both
stores describe the same lifecycle transition, the shared mapper in
[src/observability/lifecycleMapping.ts](/C:/Users/gabba/projects/developer/src/observability/lifecycleMapping.ts)
preserves task id, worker id, repository, lease ids, status transition, and
failure classification. Do not introduce new lifecycle names
without updating that mapper and its tests.

## Docker and Probes

Compose snippet:

```yaml
ports:
  - "9464:9464"
environment:
  OBSERVABILITY_ENABLED: "true"
  OBSERVABILITY_HOST: "0.0.0.0"
  OBSERVABILITY_PORT: "9464"
  METRICS_ENABLED: "true"
```

Kubernetes-style probes:

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

## Security Notes

- Keep `OBSERVABILITY_HOST=127.0.0.1` unless the worker runs on a private network.
- The Angular task tracker console is the primary human workflow UI for
  creating, answering, approving, retrying, and supervising internal tracker
  tasks.
- The backend human API remains the authorization boundary; Angular role-aware
  controls are only usability hints.
- Event messages and details pass through secret redaction and diagnostic truncation.
- Human API responses may show issue keys and MR URLs; metrics labels do not.
- Telegram Assistant must use allowlists. Chat/user allowlists grant read access;
  write actions require developer/operator/admin user IDs and confirmation.
- Assistant conversation refs, queued messages, and pending actions are retained
  for `TELEGRAM_CONVERSATION_RETENTION_DAYS` and purged on the assistant cleanup
  cadence. Admin maintenance can purge those records plus assistant turns for one
  conversation without deleting internal tracker tasks.
- Profile automation must not expose internal project data to business chats
  unless owner consent, `can_reply`, read rights, and project Q&A policy are all
  configured. Keep `TELEGRAM_PROFILE_AUTOMATION_REQUIRE_OWNER_APPROVAL=true`
  unless a production owner has approved auto-replies.

## Telegram Assistant Operations

Preflight adds a `telegram assistant` check when the assistant is enabled. It
fails for missing assistant token, task creation without the internal tracker,
webhook mode without an HTTP route, webhook mode without a public absolute
`OBSERVABILITY_BASE_URL`, and accidental use of alert-only `TELEGRAM_BOT_TOKEN`.
It warns for empty production allowlists, write-enabled configs with no
developer/operator/admin users, `groupMode=all_messages`, profile automation
auto-reply, project Q&A without readable repository docs/source roots, and
profile Q&A without owner approval.

Digital Twin mode is the long-running Business/Secretary-chat path behind
`TELEGRAM_DIGITAL_TWIN_*`. Operationally it should be monitored separately from
ordinary task commands because it creates durable per-contact Codex sessions,
stores delivery/audit state, and may auto-reply on behalf of the owner. Before
enabling it in production, document owner consent, allowed owner/chat/user IDs,
persona profile versioning, session reset policy, and whether encrypted full
text retention is allowed. Cleanup uses the same Telegram Assistant retention
cadence and prunes redacted/full-text Digital Twin audit according to
`TELEGRAM_DIGITAL_TWIN_REDACTED_RETENTION_DAYS` and
`TELEGRAM_DIGITAL_TWIN_FULL_TEXT_RETENTION_DAYS`.

Bot API references:

- [getUpdates](https://core.telegram.org/bots/api#getupdates) for polling.
- [setWebhook](https://core.telegram.org/bots/api#setwebhook) for webhook mode.
- [sendMessage](https://core.telegram.org/bots/api#sendmessage) for replies and notifications.
- [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery) for inline-button acknowledgements.
- [Privacy mode](https://core.telegram.org/bots/features#privacy-mode) for group chats; prefer `mentions_and_replies`.
- [Business/Secretary bot features](https://core.telegram.org/bots/features#business-users) for profile automation consent and `can_reply` behavior.

## Rollback

Rollback is config-only:

```env
ALERTS_ENABLED=false
OBSERVABILITY_ENABLED=false
```
