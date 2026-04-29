# Phase 8C - Operations Console Plan

## Goal

Make fleet and runtime operations visible and actionable from the Angular
console.

Phase 8B focuses on task workflow. Phase 8C focuses on operators: workers,
leases, queue pressure, repeated failures, waiting-for-human states, metrics
summaries, and diagnostic drill-downs.

## What Is In Scope

- Operations overview page.
- Worker list and heartbeat status.
- Active task and repository leases.
- Queue depth by repository, queue, status, and priority where available.
- Failed task list.
- Repeated validation failure list.
- Waiting-for-human duration list.
- Recent lifecycle event stream.
- Metrics summary cards or compact counters.
- Failure diagnostic drawer or detail panel.
- Links from operations rows to task detail.
- Polling refresh controls.
- Role-aware display of operator actions.

## What Is Out Of Scope

- Full Prometheus UI replacement.
- Alert manager replacement.
- WebSockets or server-sent events.
- Editing worker configuration from the UI.
- Managing secrets or integration tokens.
- Multi-tenant admin console.
- Database backup/restore UI.

## Current Code To Touch

- Angular frontend files from Phase 8A/8B.
- `src/observability/taskTrackerHumanApi.ts` for additive operations DTO
  improvements if needed.
- `src/observability/server.ts` only if existing observability API data needs a
  frontend-safe route.
- `src/observability/lifecycleMapping.ts` only if operations UI reveals mapping
  gaps.
- `docs/phase-8/HUMAN_API_CONTRACT.md` if operations DTOs, refresh behavior, or
  role capabilities change.
- Frontend tests.
- Existing observability tests if response shapes are adjusted.

## Contract Requirements

The operations page should consume `GET /api/operations` through the DTO in
`HUMAN_API_CONTRACT.md`. Do not stitch together multiple dashboard endpoints in
the Angular component layer unless the contract is updated to make that
composition explicit.

Minimum DTO expectations:

- workers;
- leases;
- repositories;
- queue depth rows;
- failed task summaries;
- repeated failure task summaries;
- waiting-for-human task summaries;
- generated timestamp.

If the UI needs richer repeated-failure or waiting-duration fields, add them to
the backend operations DTO first and cover them with backend tests. Repeated
failure grouping should be backend-owned, not inferred from raw logs in the
browser.

## Operations Overview

Show compact, scan-friendly summaries:

- active workers;
- ready queue depth;
- failed tasks;
- tasks waiting for human;
- active leases;
- repeated failures;
- average task duration if available;
- latest generated timestamp.

Counters should be derived from the operations DTO response, not independently
recomputed from different API calls in each component.

Use PrimeNG components such as:

- `Table`;
- `Tag`;
- `Badge`;
- `Panel` or simple sections;
- `ProgressBar` or `MeterGroup` only when the metric benefits from it;
- `Button` for refresh and row actions.

Avoid decorative dashboard cards. Operational counters should be compact and
easy to compare.

## Worker View

Show:

- worker id;
- state;
- repository;
- current task;
- current stage;
- heartbeat age;
- last error summary.

Classify heartbeat age:

- healthy;
- stale warning;
- stale error.

Thresholds can start as frontend constants if the backend does not expose them,
but they should be documented and kept conservative.

Baseline frontend thresholds:

- healthy: heartbeat age under 60 seconds;
- stale warning: 60-300 seconds;
- stale error: over 300 seconds.

If backend config exposes `ALERT_WORKER_STALE_SECONDS`, prefer returning it in
the operations DTO in a later additive change rather than duplicating long-term
configuration in Angular.

## Lease View

Show:

- lease id;
- kind;
- task id;
- repository name;
- worker id;
- expiry time;
- heartbeat time;
- released state.

Link task leases to task detail.

Do not add force-release controls in this phase unless the backend already has
a safe operator command for it.

## Failure Diagnostics

For failed or repeatedly failing tasks, show:

- task title;
- repository;
- status;
- latest failed agent run;
- latest validation diagnostic;
- repeated validation failure count;
- MR link if any;
- latest timeline events.

Actions:

- open task detail;
- retry if role allows it and the backend supports it;
- hold if role allows it.

Diagnostics must use allowlisted summary fields. Do not render full raw command
output, environment, or unbounded agent logs. Long summaries should be
truncated in tables and expanded only in a bounded drawer.

## Waiting For Human

Show:

- task;
- repository;
- question/blocker summary;
- time waiting;
- active worker if any;
- link to answer flow.

This view should make stuck tasks obvious without requiring Yandex.

Waiting duration should be backend-provided when available. Until then, the UI
may compute a display-only duration from `updatedAt` or the latest relevant
timeline event, but it must label the value as approximate in tests and avoid
using it for backend decisions.

## Refresh Behavior

Start with polling:

- manual refresh button;
- default frontend refresh interval of 15 seconds;
- configurable frontend refresh interval in the 10-30 second range if a setting
  is introduced;
- pause polling when browser tab is hidden if simple to implement.

Do not add WebSockets until there is a clear need.

Refresh failures should not clear the last successful snapshot. Show the last
generated timestamp and an inline error state so operators can tell whether
they are looking at stale data.

## Implementation Order

1. Verify and, if needed, update the operations DTO in
   `HUMAN_API_CONTRACT.md`.
2. Stabilize operations DTOs in the backend if needed.
3. Add operations summary service methods.
4. Build operations overview.
5. Add worker table with heartbeat classification.
6. Add active leases table.
7. Add queue depth table.
8. Add failed and repeated failure panels.
9. Add waiting-for-human panel.
10. Add diagnostic drill-down with allowlisted fields.
11. Add polling refresh controls and stale-data handling.
12. Add role-aware action visibility using `/api/session` capabilities.
13. Add canonical operations fixtures.
14. Add tests.

## Tests

Add frontend tests for:

- operations overview renders counters;
- worker heartbeat age is classified correctly;
- leases link to task detail;
- failed task diagnostic panel renders validation and agent run summaries;
- waiting-for-human list links to task detail;
- polling can be refreshed manually;
- polling failure preserves the last successful snapshot and shows an error;
- retry/hold actions are hidden or disabled for insufficient roles.

Backend tests should cover:

- any new or changed operations DTOs;
- repeated failure grouping if enriched beyond task summaries;
- no raw secret-bearing diagnostics in operations responses.

## Acceptance Criteria

- `HUMAN_API_CONTRACT.md` matches every operations DTO consumed by Angular.
- Operators can see active workers and heartbeat state.
- Operators can see active leases.
- Operators can see queue depth by repository/status.
- Operators can see failed and repeatedly failing tasks.
- Operators can identify tasks waiting for humans.
- Operators can navigate from operations rows to task detail.
- Retry/hold actions are role-aware.
- Polling refresh uses the documented interval and keeps stale data visible
  when refresh fails.
- No raw secret-bearing diagnostics are shown.
- Existing metrics and dashboard APIs continue to work.
- Backend tests pass.
- `npm run web:typecheck` passes.
- `npm run web:test` passes.
- `npm run web:build` passes.

## Rollback And Fallback

The task workflow UI from Phase 8B remains usable if the operations page is
disabled or hidden.

The existing observability dashboard remains available as a separate diagnostic
surface until Phase 8D documents the final relationship between the Angular
console and the older dashboard.

## Open Questions

Resolved for Phase 8C:

- Operations counters use the human task API `GET /api/operations`.
- Heartbeat thresholds start as documented frontend constants.
- Repeated failure grouping is backend-owned.

Remaining later questions:

- Should heartbeat thresholds be returned from backend config?
- Should operators be able to force-release stale leases from the UI in a later
  phase?

## Suggested Codex Task

```text
Implement Phase 8C from docs/phase-8/PHASE_8C_OPERATIONS_CONSOLE_PLAN.md.
Add Angular/PrimeNG operations views for workers, leases, queue depth, failures,
and waiting-for-human diagnostics. Keep backend changes additive.
```
