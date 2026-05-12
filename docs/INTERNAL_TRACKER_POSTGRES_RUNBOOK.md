# Internal Tracker PostgreSQL Runbook

Phase 7H makes `TASK_TRACKER_PROVIDER=internal` a PostgreSQL-backed mode for
continuous self-hosted operation. `TASK_TRACKER_PROVIDER=yandex` remains the
rollback path and does not require this database.

## Enable Internal Mode

Use PostgreSQL storage in production:

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_STORAGE=postgres
TASK_TRACKER_DATABASE_URL=postgres://tracker:tracker@postgres:5432/ai_developer_tasks
TASK_INTAKE_MODE=standalone
YANDEX_SYNC_ENABLED=false
```

For Yandex as source/mirror instead of direct runtime state:

```env
TASK_INTAKE_MODE=yandex_integration
YANDEX_SYNC_ENABLED=true
TRACKER_TOKEN=...
TRACKER_ORG_ID=...
TRACKER_STATUS_MAP_FILE=./config/trackerStatusMap.example.json
```

## Migrations

Run migrations before preflight or startup:

```bash
npm run tracker:migrate
npm run preflight
```

Preflight fails if the database is unreachable, migration metadata is missing,
any migration is pending, required tables/indexes are absent, or `SKIP LOCKED`
claim support is unavailable.

## Retention And Cleanup

Defaults:

```env
TASK_TRACKER_RETENTION_RAW_LOG_DAYS=30
TASK_TRACKER_RETENTION_ARTIFACT_DAYS=30
TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS=90
TASK_TRACKER_RETENTION_HISTORY_DAYS=365
TASK_TRACKER_CLEANUP_ENABLED=true
TASK_TRACKER_CLEANUP_INTERVAL_SECONDS=3600
TASK_TRACKER_METRICS_ENABLED=true
TASK_TRACKER_REDACTION_ENABLED=true
```

Cleanup removes expired raw log and validation artifact metadata, old released
leases, and stale proposals. Compact task history remains in `tasks`,
`task_events`, `task_decisions`, revisions, comments, and summaries.

## Auth Alignment

If the task UI/API is bound outside localhost, preflight requires auth:

- `TASK_TRACKER_SYSTEM_TOKEN` and `TASK_TRACKER_AGENT_TOKEN` for the internal
  tracker UI/API.
- Do not use `TASK_TRACKER_HUMAN_AUTH_MODE=localhost` with
  `TASK_TRACKER_UI_BIND_HOST=0.0.0.0`.

## Backup

Use database-native backups. Example from the host or a maintenance container:

```bash
pg_dump "$TASK_TRACKER_DATABASE_URL" \
  --format=custom \
  --file=ai-developer-tasks-$(date +%Y%m%d%H%M%S).dump
```

For Docker Compose:

```bash
docker compose exec postgres pg_dump \
  -U tracker \
  -d ai_developer_tasks \
  --format=custom \
  --file=/tmp/ai-developer-tasks.dump
docker compose cp postgres:/tmp/ai-developer-tasks.dump ./ai-developer-tasks.dump
```

## Restore

Restore into an empty database, then run preflight:

```bash
pg_restore \
  --clean \
  --if-exists \
  --dbname "$TASK_TRACKER_DATABASE_URL" \
  ai-developer-tasks.dump
npm run preflight
```

For Compose:

```bash
docker compose cp ./ai-developer-tasks.dump postgres:/tmp/ai-developer-tasks.dump
docker compose exec postgres pg_restore \
  --clean \
  --if-exists \
  -U tracker \
  -d ai_developer_tasks \
  /tmp/ai-developer-tasks.dump
docker compose run --rm worker npm run preflight
```

## Rollback

Rollback does not require deleting internal tracker data:

```env
TASK_TRACKER_PROVIDER=yandex
TASK_TRACKER_CLEANUP_ENABLED=false
TASK_TRACKER_METRICS_ENABLED=false
```

Keep the PostgreSQL volume intact until you no longer need task audit history.
