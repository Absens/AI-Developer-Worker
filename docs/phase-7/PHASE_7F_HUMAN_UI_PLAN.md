# Phase 7F - Human UI Plan

## Goal

Add a minimal human workflow UI and API for standalone/internal mode.

The UI should be a working operations tool, not a marketing page. It should let
a person create a task, inspect status, answer AI questions, resume execution,
see MR and validation results, and diagnose failures without opening Yandex.

## What Is In Scope

- Human JSON API for task reads and mutations.
- Queue view.
- Create task view.
- Task detail view.
- Answer and resume workflow.
- Retry, cancel, and hold actions.
- Failed task diagnostics.
- MR and validation summary.
- Basic auth guard for writable API/UI.
- Role checks for viewer/developer/operator/admin where feasible.

## What Is Out Of Scope

- Full enterprise workflow customization.
- Full Jira-like board features.
- Complex dependency graph UI.
- Decomposition approval graph UI beyond a simple list.
- AI proposal review UI if Phase 7G has not started.
- Multi-tenant SaaS security.

## Current Code To Touch

- Existing observability server modules if UI is added there:
  - `src/observability/server.ts`;
  - `src/observability/dashboardAssets.ts`;
  - `src/observability/service.ts`.
- Or a new `src/server/` or `src/ui/` module if a cleaner boundary is chosen.
- `src/config.ts` for UI/auth settings.
- `src/models/types.ts`.
- New API/UI tests.

## New Settings

```env
TASK_TRACKER_UI_ENABLED=true
TASK_TRACKER_UI_BIND_HOST=127.0.0.1
TASK_TRACKER_UI_PORT=...
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy
TASK_TRACKER_AGENT_TOKEN=...
```

Exact names can follow existing observability config conventions.

## Human API

Minimum read endpoints:

```http
GET /api/tasks
GET /api/tasks/{taskId}
GET /api/tasks/{taskId}/events
GET /api/tasks/{taskId}/comments
```

Minimum mutation endpoints:

```http
POST /api/tasks
POST /api/tasks/{taskId}/revisions
POST /api/tasks/{taskId}/commands/mark-ready
POST /api/tasks/{taskId}/answers
POST /api/tasks/{taskId}/commands/resume
POST /api/tasks/{taskId}/commands/hold
POST /api/tasks/{taskId}/commands/cancel
POST /api/tasks/{taskId}/commands/retry
```

## UI Views

### Queue View

Show:

- grouped tasks: `ready`, `awaiting_human`, `review`, `failed`, `blocked`;
- filters by repository, status, queue, priority, worker, tag;
- visible blocker reason;
- selected task score breakdown if priority scoring exists.

### Create Task View

Support:

- title;
- description;
- repository or queue;
- priority;
- acceptance criteria;
- optional deadline;
- optional attachments/external links metadata;
- save draft;
- mark ready;
- request human triage.

### Task Detail View

Show:

- goal and description;
- acceptance criteria;
- attachments and external refs;
- current status;
- active worker and lease TTL if any;
- current blocker/question;
- latest AI summary;
- latest validation summary;
- MR link and branch;
- timeline events;
- human comments and AI questions.

Actions:

- answer;
- resume;
- hold;
- cancel;
- retry;
- force reanalysis if supported by previous phases.

## Auth And Roles

Minimum model:

- no anonymous mutations;
- read-only UI can be limited to localhost/trusted network if auth is not ready;
- agent API uses service token;
- human UI uses trusted reverse proxy, session auth, or OIDC before exposure
  outside localhost;
- roles:
  - `viewer`;
  - `developer`;
  - `operator`;
  - `admin`.

Minimum checks:

- `viewer` can read;
- `developer` can mutate tasks;
- `operator` can retry/hold operational states;
- `admin` can change operational settings or integration tokens.

## Implementation Order

1. Add human API read endpoints.
2. Add human mutation endpoints.
3. Add auth guard.
4. Add queue UI.
5. Add create task UI.
6. Add task detail UI.
7. Add answer/resume workflow.
8. Add failed diagnostics and MR summary.
9. Add tests and smoke verification.

## Tests

Add tests for:

- listing tasks;
- reading task detail;
- creating a task;
- marking a task ready;
- answering clarification;
- resuming a task;
- cancelling a task;
- retrying a failed task;
- viewer cannot mutate;
- unauthenticated mutation is rejected.

## Acceptance Criteria

- A human can create a standalone task without Yandex.
- A human can mark a task ready.
- A human can answer an AI question.
- A human can resume execution after answering.
- A human can see MR URL and validation summary.
- Failed task diagnostics are visible without reading raw logs.
- Writable UI/API is not anonymously exposed.
- `npm run typecheck` passes.
- `npm test` passes.

## Rollback And Fallback

UI must be disableable by config.

Internal agent API and worker execution should keep working with UI disabled.
Yandex bridge can remain the human interaction path if UI is disabled.

## Open Questions

- Should the UI be server-rendered HTML, static assets with API calls, or a
  separate frontend app?
- Should it reuse the existing observability server port?
- Should auth be implemented directly or delegated to a reverse proxy first?
- Are attachments uploaded through this UI or only registered as metadata in the
  first version?
- Should `force reanalysis` be included now or postponed?

## Suggested Codex Task

```text
Implement Phase 7F from docs/phase-7/PHASE_7F_HUMAN_UI_PLAN.md.
Build the minimal human API/UI for internal tracker workflows.
Do not add AI proposal functionality unless it already exists from Phase 7G.
```

