# Phase 7H - Operational Hardening Plan

## Goal

Make the internal AI Task Tracker safe to run continuously in a self-hosted
production deployment.

Earlier phases make the tracker usable. This phase closes production gaps:
database operations, restart recovery, retention, redaction, metrics, auth
alignment, and runbooks.

## What Is In Scope

- PostgreSQL migration runner and migration status preflight.
- DB preflight checks for connection, schema version, required indexes, and
  transactional claim support.
- Backup and restore runbook.
- Retention settings for raw Codex logs, validation artifacts, and compact task
  history.
- Cleanup jobs for expired artifacts, stale proposals, released leases, and old
  raw logs.
- Secret redaction for task events, comments, logs, validation diagnostics, and
  exported digests.
- Metrics for sync lag, claim latency, lease conflicts, task lifecycle duration,
  failed tasks, waiting-for-human duration, proposal volume, and cleanup jobs.
- Observability convergence between the existing event/dashboard storage and
  the internal task timeline, including documented ownership of which system is
  used for operational dashboards versus task audit history.
- Dashboard/auth alignment for tracker UI, observability UI, agent API, and
  system API.
- Preflight checks for Yandex sync, GitLab sync, worker API, and configured
  notification sinks.
- Restart recovery smoke test using persisted DB state.
- Docker Compose and Windows/PowerShell runbook updates for PostgreSQL-backed
  internal mode.

## What Is Out Of Scope

- New tracker product features.
- New external task providers.
- Replacing GitLab review workflows.
- SaaS or multi-tenant security.
- Removing `TASK_TRACKER_PROVIDER=yandex` fallback.

## Current Code To Touch

- `src/config.ts`
- `src/domain/preflight.ts`
- `src/domain/taskTracker/`
- `src/integrations/internalTracker/`
- `src/observability/`
- `src/utils/logger.ts` or the repo's current logging helpers.
- `scripts/`
- `docs/`
- New operational tests in `tests/*hardening*.test.ts` or similar.

## New Settings

Names can follow existing config conventions, but the deployment must support:

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

Defaults should match the concept:

- raw Codex logs: 30 days;
- validation artifacts: 30 days;
- validation artifacts for failed tasks: 90 days;
- compact summaries, events, decisions, and task history: at least 1 year.

## Preflight Requirements

Internal production mode must fail fast when:

- the PostgreSQL URL is missing or unreachable;
- migrations are not applied;
- required tables or indexes are missing;
- the active storage adapter is in-memory;
- agent/system tokens are missing for writable APIs;
- human UI is exposed outside localhost without an auth mode;
- Yandex sync is enabled without Yandex credentials;
- GitLab sync is enabled without GitLab credentials;
- retention settings are invalid.

## Metrics

Expose or record at least:

- queue depth by repository, queue, status, and priority;
- claim latency;
- lease conflict count;
- stale lease recovery count;
- task lifecycle duration by status;
- sync lag for Yandex bridge;
- digest export failures;
- validation failure counts;
- tasks waiting for human over threshold;
- proposal count, rejection count, auto-approval count;
- cleanup job duration and deleted artifact/log counts.

## Observability Convergence

By this phase, task execution events should not exist as two unrelated
vocabularies. Keep the task timeline as the audit-grade history for a task, and
keep observability/dashboard storage optimized for fleet and operations views.
Where both stores receive the same lifecycle event, use a shared event mapper or
documented schema mapping so status names, task ids, worker ids, repository
keys, lease ids, and failure classifications stay consistent.

## Redaction

Redaction must apply before data is written to:

- task events;
- comments and AI protocol messages;
- validation diagnostics;
- raw log summaries;
- exported Yandex digests;
- observability dashboard responses.

Raw artifact storage may keep full logs only when explicitly configured, and
retention must still apply. Integration tokens must never be stored in task
payloads.

## Implementation Order

1. Add migration runner and migration-status preflight.
2. Add DB/index/storage-adapter preflight checks.
3. Add retention config parsing and validation.
4. Add cleanup jobs.
5. Add redaction helpers and apply them to tracker writes and digest exports.
6. Add metrics for queue, leases, sync, lifecycle, proposals, and cleanup.
7. Align task timeline and observability event schemas so dashboard data and
   task audit history remain consistent.
8. Align auth checks across tracker UI, observability UI, agent API, and system
   API.
9. Add backup/restore and PostgreSQL deployment runbooks.
10. Add restart recovery smoke test.
11. Run verification commands.

## Tests

Add tests for:

- internal production mode rejects in-memory storage;
- preflight fails when migrations are missing;
- preflight fails when required indexes are missing, if index inspection is
  implemented;
- invalid retention settings are rejected;
- cleanup deletes expired raw logs and artifacts but preserves compact history;
- redaction removes known token/secret patterns from events, diagnostics, and
  digest exports;
- unauthenticated writable APIs are rejected;
- metrics are emitted for claim latency, lease conflicts, sync lag, and cleanup;
- task timeline and observability event mappings preserve consistent task,
  worker, repository, lease, status, and failure identifiers;
- restart recovery can resume from persisted DB task state after process
  restart.

## Acceptance Criteria

- Production internal mode requires PostgreSQL and applied migrations.
- Backup/restore and PostgreSQL deployment runbooks exist.
- Retention defaults match the concept and are configurable.
- Raw logs and artifacts are cleaned up according to retention policy.
- Compact events, decisions, task history, and summaries are retained for at
  least 1 year by default.
- Secrets are redacted before tracker timeline, diagnostics, UI/API responses,
  and Yandex digest export.
- Metrics cover sync lag, claim latency, lease conflicts, lifecycle duration,
  proposal volume, and cleanup jobs.
- Existing observability outputs and the task timeline use a documented shared
  lifecycle mapping instead of diverging event semantics.
- Writable UI/API and agent/system APIs are not anonymously exposed.
- Restart recovery is verified against persisted DB state.
- Current Yandex direct fallback remains available.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run test:smoke` passes or the reason it cannot run is documented.

## Rollback And Fallback

Operational features should be controlled by config where possible:

```env
TASK_TRACKER_PROVIDER=yandex
TASK_TRACKER_CLEANUP_ENABLED=false
TASK_TRACKER_METRICS_ENABLED=false
```

Rollback must not require deleting task data. If a migration is not reversible,
document the manual recovery path in the runbook.

## Open Questions

- Should metrics be Prometheus-compatible, dashboard-only, or both?
- Should cleanup jobs run in the worker process or a separate command?
- Should backup/restore scripts be included or documented as database-native
  commands only?
- Which secret patterns should be redacted in the first release?
- Should raw artifacts be stored on local filesystem only, or should the storage
  interface support object storage now?

## Suggested Codex Task

```text
Implement Phase 7H from docs/phase-7/PHASE_7H_OPERATIONAL_HARDENING_PLAN.md.
Harden the internal tracker for self-hosted production: DB preflight,
migrations, retention, redaction, metrics, restart recovery, and runbooks.
Do not add new product features or remove Yandex direct fallback.
```
