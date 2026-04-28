# Phase 7C - Provider Flag Plan

## Goal

Wire the internal tracker into application configuration behind a feature flag
while preserving the current Yandex direct mode.

This phase makes the new tracker selectable, but it should not yet require the
worker to complete tasks through the internal tracker.

## What Is In Scope

- Add `TASK_TRACKER_PROVIDER=yandex|internal`.
- Add internal tracker configuration parsing.
- Add provider factory or application wiring.
- Add DB preflight placeholder for internal mode.
- Add storage-adapter validation so production internal mode requires
  PostgreSQL-backed storage.
- Keep Yandex as the default provider.
- Add tests for valid and invalid config combinations.

## What Is Out Of Scope

- Full worker migration.
- Yandex bridge.
- Human UI.
- AI proposals.
- Removing `YandexTrackerClient`.

## Current Code To Touch

- `src/config.ts`
- `src/app.ts`
- `src/domain/repositoryContext.ts`
- `src/domain/preflight.ts` if internal DB checks are introduced.
- `src/models/types.ts`
- `tests/config.test.ts`
- Additional tests for application wiring if useful.

## New Settings

```env
TASK_TRACKER_PROVIDER=yandex
```

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_DATABASE_URL=postgres://...
TASK_INTAKE_MODE=standalone
YANDEX_SYNC_ENABLED=false
```

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_DATABASE_URL=postgres://...
TASK_INTAKE_MODE=yandex_integration
YANDEX_SYNC_ENABLED=true
```

Accepted intake modes:

```text
standalone
yandex_integration
hybrid
system_only
ai_proposed
```

Optional test-only adapter setting, if the implementation needs one:

```env
TASK_TRACKER_STORAGE=memory
```

`TASK_TRACKER_STORAGE=memory` must be accepted only under test/local smoke
configuration. Production internal mode must fail fast unless it has a
PostgreSQL database URL and a PostgreSQL adapter.

For this phase, unsupported runtime combinations may be parsed but fail with a
clear preflight/config error.

## Implementation Order

1. Add config types and parsing.
2. Add validation for provider and intake combinations.
3. Add validation for storage adapter and database URL requirements.
4. Add internal tracker factory placeholder or PostgreSQL-backed factory if
   Phase 7B already added it.
5. Wire application construction so Yandex remains default.
6. Add preflight result for internal tracker DB configuration.
7. Add tests.
8. Run verification commands.

## Config Validation Rules

- Missing `TASK_TRACKER_PROVIDER` means `yandex`.
- `TASK_TRACKER_PROVIDER=yandex` should preserve current required Yandex config.
- `TASK_TRACKER_PROVIDER=internal` requires `TASK_TRACKER_DATABASE_URL` unless an
  explicit local test adapter is configured.
- Explicit local test adapters must be disabled by default and must not be
  selected implicitly in production.
- `YANDEX_SYNC_ENABLED=true` requires `TASK_INTAKE_MODE=yandex_integration` or
  `hybrid`.
- `YANDEX_SYNC_ENABLED=false` is valid for `standalone`, `system_only`, and
  `ai_proposed`.
- Invalid enum values fail fast with a useful message.

## Tests

Add tests for:

- default provider is Yandex;
- internal mode parses required settings;
- invalid provider is rejected;
- invalid intake mode is rejected;
- Yandex sync without Yandex integration mode is rejected;
- internal mode without DB config is rejected unless a test adapter is enabled;
- memory/test adapter is rejected outside explicit test/local smoke mode;
- current Yandex configuration tests still pass.

## Acceptance Criteria

- The app can start in current Yandex mode exactly as before.
- The app can be configured for internal mode without referencing Yandex as the
  primary runtime provider.
- Internal production mode requires PostgreSQL-backed storage and cannot
  silently fall back to in-memory state.
- Invalid config combinations fail before worker execution starts.
- Current tests for Yandex direct mode pass.
- `npm run typecheck` passes.
- `npm test` passes.

## Rollback And Fallback

Set:

```env
TASK_TRACKER_PROVIDER=yandex
```

or remove `TASK_TRACKER_PROVIDER` entirely to use the current behavior.

## Open Questions

- Should internal mode be supported first in single-repo mode, fleet mode, or
  both?
- Should a local in-memory provider be available through config for smoke tests?
- Should DB preflight connect immediately or only validate URL shape in this
  phase?
- Should `TASK_INTAKE_MODE=ai_proposed` be a mode or a source under other modes?

## Suggested Codex Task

```text
Implement Phase 7C from docs/phase-7/PHASE_7C_PROVIDER_FLAG_PLAN.md.
Add provider config and application wiring only.
Do not migrate worker execution and keep Yandex direct mode as default.
```
