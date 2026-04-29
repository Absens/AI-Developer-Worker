# Phase 8A - Frontend Foundation Plan

## Goal

Create the Angular/PrimeNG frontend foundation for the internal task tracker
without changing worker behavior.

This phase should establish the frontend workspace, typed API boundary,
application shell, local development workflow, and production static serving
path. It should not attempt to build the full task workflow UI yet.

## What Is In Scope

- Add an Angular application under `web/` named `task-tracker-console`.
- Keep frontend dependencies isolated in `web/package.json` and the `web/`
  lockfile; expose root delegating scripts for common commands.
- Use Angular standalone APIs for new code.
- Add PrimeNG and configure a PrimeNG theme preset.
- Add a restrained operations-console layout shell:
  - top bar;
  - left navigation;
  - main content outlet;
  - global loading/error state;
  - toast/confirm infrastructure.
- Add Angular routes for planned pages:
  - queue;
  - create task;
  - task detail;
  - proposals;
  - operations;
  - not found.
- Add typed API DTOs for the current human API.
- Add Angular API services for:
  - session/auth bootstrap;
  - tasks;
  - task commands;
  - comments/questions/answers;
  - proposals;
  - operations.
- Add a local development proxy to the existing Node.js server.
- Add frontend build/test scripts.
- Add backend static serving for a built Angular bundle on the task UI route.
- Add deep-link fallback for Angular routes without swallowing backend API,
  metrics, health, or readiness routes.
- Keep the old embedded task UI only as a temporary compatibility fallback when
  no Angular static bundle is configured. Document this as temporary; final
  removal belongs to Phase 8D.
- Add or update `docs/phase-8/HUMAN_API_CONTRACT.md` when DTOs or endpoints are
  introduced.
- Document how to run the Angular UI locally.

## What Is Out Of Scope

- Full queue/detail workflow implementation.
- New backend product features.
- Replacing the human API with GraphQL or a separate API gateway.
- WebSockets or server-sent events.
- OIDC implementation.
- Changing `TASK_TRACKER_PROVIDER=yandex` or internal worker behavior.

## Current Code To Touch

- `package.json` for root scripts if the frontend is integrated from the root.
- New `web/` frontend workspace directory.
- `src/observability/server.ts` for static asset serving.
- `src/observability/config.ts` and `src/models/types.ts` if static UI settings
  are added.
- `tests/observabilityServer.test.ts` for static serving behavior.
- `docs/ENV_CONFIGURATION.md`.
- `docs/OBSERVABILITY_RUNBOOK.md`.

## Suggested New Settings

Names can follow existing observability conventions, but the deployment should
support:

```env
TASK_TRACKER_UI_STATIC_DIR=web/dist/task-tracker-console/browser
TASK_TRACKER_UI_ASSET_PATH=/tasks/assets
```

Suggested behavior:

- when `TASK_TRACKER_UI_ENABLED=true` and `TASK_TRACKER_UI_STATIC_DIR` is set,
  the server serves the Angular app from that directory;
- when `TASK_TRACKER_UI_STATIC_DIR` is set, missing Angular assets should fail
  clearly at startup or return a clear HTTP error;
- during Phase 8A only, when `TASK_TRACKER_UI_ENABLED=true` but no static
  directory is configured, the existing embedded UI may remain available as a
  documented fallback;
- when `TASK_TRACKER_UI_ENABLED=false`, no human task UI is served.

Config parsing should reject path conflicts where the UI path, asset path,
human API path, dashboard API path, metrics path, health path, or readiness path
would route ambiguously.

## API Contract Work

Do not make the Angular app consume raw internal types by assumption. Keep
`HUMAN_API_CONTRACT.md` current and introduce or document DTOs that match the
human API response shapes:

```typescript
export interface TaskSummaryDto {
  id: string;
  title: string;
  status: string;
  repositoryName?: string;
  queue?: string;
  priority?: string;
  activeWorker?: string;
  blockerReason?: string;
  latestAiSummary?: string;
  latestValidationSummary?: string;
  mergeRequestUrl?: string;
  branch?: string;
  updatedAt: string;
}
```

Add equivalent DTOs for:

- session/auth bootstrap and capabilities;
- task detail;
- active lease;
- validation summary;
- merge request summary;
- timeline event;
- clarification question;
- proposal summary;
- operations snapshot;
- command response.

Add this endpoint in Phase 8A:

```text
GET /api/session
```

The response must include the authenticated user/service, role, auth mode, UI
path, API path, generated timestamp, and capability booleans for every command
that the Angular UI may show. The frontend should use this endpoint as its
first API call instead of deriving role state from task list responses.

If backend changes are required to stabilize DTOs, keep them additive and
covered by API tests.

Angular services should map backend responses into DTOs before components
consume them. If the backend still returns a raw-compatible `task` object in
detail responses, only the service layer may touch it.

## PrimeNG Foundation

Use PrimeNG for the shell and common controls:

- `Button`;
- `Toolbar`;
- `Menu` or navigation equivalents;
- `Toast`;
- `ConfirmDialog`;
- `ProgressSpinner` or progress indicators;
- `Tag` for statuses;
- `Message` or inline error blocks.

Keep the visual language quiet and utilitarian. Avoid a marketing-style hero,
oversized cards, decorative gradients, or nested card layouts. This is an
operations console.

## Implementation Order

1. Create the Angular workspace and pin Angular/PrimeNG versions.
2. Create `web/package.json`, `web/package-lock.json`, and root delegating
   scripts: `web:dev`, `web:build`, `web:test`, and `web:typecheck`.
3. Configure PrimeNG theme and global styles.
4. Add the application shell and routes.
5. Add typed API DTO files based on `HUMAN_API_CONTRACT.md`.
6. Add `GET /api/session` and backend tests for role/capability output.
7. Add Angular API services with centralized HTTP error handling.
8. Add dev proxy configuration.
9. Add backend static serving for the Angular bundle behind config.
10. Add deep-link fallback for frontend routes while preserving backend route
    precedence.
11. Keep or remove the embedded `renderTaskTrackerUiHtml` route according to
    the fallback rule above; do not leave the behavior implicit.
12. Add tests for static serving, route precedence, session DTO, and config
    parsing.
13. Update runbooks and `HUMAN_API_CONTRACT.md`.

## Tests

Add or update tests for:

- config parsing for Angular static UI settings;
- Angular static index serves when task UI is enabled and built assets exist;
- missing static directory fails clearly or returns a clear error;
- deep links such as `/tasks/task-123` serve the Angular index when static
  serving is configured;
- `/api/...`, `/metrics`, `/healthz`, and `/readyz` are not swallowed by
  frontend fallback routing;
- the old embedded task UI behavior matches the documented Phase 8A fallback
  rule;
- `GET /api/session` returns user, role, auth mode, paths, and capabilities;
- task human API tests still pass unchanged.

Frontend checks should include at least:

- `npm run web:typecheck`;
- `npm run web:build`;
- `npm run web:test` if component tests are generated by Angular tooling;
- lint if configured.

## Acceptance Criteria

- Angular app exists in `web/`.
- `web/` has its own package manifest and lockfile.
- Root scripts exist for `web:dev`, `web:build`, `web:test`, and
  `web:typecheck`.
- PrimeNG is installed and configured.
- The app shell loads locally through Angular dev server.
- The app can call the backend through a dev proxy.
- The backend can serve the built Angular app behind config.
- Static serving handles Angular deep links without stealing backend routes.
- The embedded task UI route is either replaced by Angular static serving or
  remains only as the documented Phase 8A fallback when no static bundle is
  configured.
- `GET /api/session` is implemented and consumed by the frontend service layer.
- `HUMAN_API_CONTRACT.md` matches the implemented DTOs and endpoints.
- Existing human API tests pass.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run web:typecheck` passes.
- `npm run web:test` passes, if tests are generated by Angular tooling.
- `npm run web:build` passes.

## Rollback

Set:

```env
TASK_TRACKER_UI_ENABLED=false
```

to disable the human UI while keeping the worker and internal tracker running.
To return to the old embedded UI, roll back to the previous application version.
Rollback must not require removing task tracker data or changing worker runtime
configuration.

## Open Questions

Resolved for Phase 8A:

- Frontend directory is `web/`.
- Frontend owns its own lockfile.
- Static serving uses `/tasks` for the app and `/tasks/assets` for assets.
- DTOs are hand-written first and kept in sync with
  `HUMAN_API_CONTRACT.md`.

Remaining later question:

- Should an OpenAPI schema be generated from the DTO contract after Phase 8D?

## Suggested Codex Task

```text
Implement Phase 8A from docs/phase-8/PHASE_8A_FRONTEND_FOUNDATION_PLAN.md.
Create the Angular/PrimeNG frontend foundation, typed API services, and static
serving path. Do not implement the full workflow UI yet.
```
