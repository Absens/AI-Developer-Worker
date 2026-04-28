# Phase 7F - Human UI Plan

## Goal

Add a minimal human workflow UI and API for standalone/internal mode.

The UI should be a working operations tool, not a marketing page. It should let
a person create a task, inspect status, answer AI questions, resume execution,
see MR and validation results, and diagnose failures without opening Yandex.

## What Is In Scope

- Human JSON API for task reads and mutations.
- System/service-account JSON API for task creation with idempotency and audit
  trail.
- Queue view.
- Create task view.
- Task templates for common AI work types.
- Agent context preview before marking a task ready.
- Task detail view.
- Answer and resume workflow.
- Retry, cancel, and hold actions.
- Failed task diagnostics.
- MR and validation summary.
- Simple decomposition approval list for child tasks, without graph UI.
- Operations view for workers, leases, queue depth, and repeated failures.
- Basic auth guard for writable API/UI.
- Role checks for viewer/developer/operator/admin where feasible.

## What Is Out Of Scope

- Full enterprise workflow customization.
- Full Jira-like board features.
- Complex dependency graph UI.
- Decomposition approval graph UI beyond a simple approval list.
- AI proposal review UI if Phase 7G has not started.
- Multi-tenant SaaS security.

## MVP Cut Lines

Phase 7F deliberately ships a simple decomposition approval list instead of the
full dependency graph view described in the concept. The dependency graph must
already exist in the tracker model, but graph visualization and advanced graph
editing are deferred until after the MVP unless a later plan explicitly pulls
them forward.

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
TASK_TRACKER_SYSTEM_TOKEN=...
```

Exact names can follow existing observability config conventions.

## Human API

These endpoints are for humans and service accounts. They complement the
workflow-first agent API from Phase 7D and must not become the worker runtime
contract.

Minimum read endpoints:

```http
GET /api/tasks
GET /api/tasks/{taskId}
GET /api/tasks/{taskId}/events
GET /api/tasks/{taskId}/comments
GET /api/tasks/{taskId}/agent-context-preview
```

Minimum mutation endpoints:

```http
POST /api/tasks
POST /api/tasks:bulk-create
POST /api/tasks/{taskId}/revisions
POST /api/tasks/{taskId}/attachments
POST /api/tasks/{taskId}/commands/mark-ready
POST /api/tasks/{taskId}/answers
POST /api/tasks/{taskId}/commands/resume
POST /api/tasks/{taskId}/commands/hold
POST /api/tasks/{taskId}/commands/cancel
POST /api/tasks/{taskId}/commands/retry
POST /api/tasks/{taskId}/commands/force-reanalysis
POST /api/tasks/{taskId}/commands/approve-decomposition
```

System-created tasks can use `POST /api/tasks` or `POST /api/tasks:bulk-create`
with service-token auth. They must include `source`, `createdBy`,
`idempotencyKey`, and enough raw source metadata or artifact refs to audit why
the task exists.

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
- task template selection;
- preview of the derived `AgentTaskContext`;
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
- implicit plan and latest step status;
- timeline events;
- human comments and AI questions.

Actions:

- answer;
- resume;
- hold;
- cancel;
- retry;
- force reanalysis if supported by previous phases.

### Decomposition Approval List

Show internal child tasks created by decomposition:

- title and summary;
- parent/child dependency reason;
- current status;
- external mirror status;
- approve or reject Yandex mirroring when the bridge supports it.

### Operations View

Show:

- workers and heartbeats;
- active task and repository leases;
- queue depth by repository and status;
- failed tasks;
- repeated validation failures;
- tasks waiting for human longer than threshold.

## Auth And Roles

Minimum model:

- no anonymous mutations;
- read-only UI can be limited to localhost/trusted network if auth is not ready;
- agent API uses service token;
- system-created task API uses service token and idempotency key;
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
3. Add system/service-account task creation path with idempotency.
4. Add auth guard.
5. Add queue UI.
6. Add create task UI with templates and agent context preview.
7. Add task detail UI.
8. Add answer/resume workflow.
9. Add simple decomposition approval list.
10. Add operations view.
11. Add failed diagnostics and MR summary.
12. Add tests and smoke verification.

## Tests

Add tests for:

- listing tasks;
- reading task detail;
- creating a task;
- creating a system task with idempotency key;
- repeated system task creation with the same idempotency key does not create a
  duplicate;
- marking a task ready;
- previewing derived agent context before mark-ready;
- answering clarification;
- resuming a task;
- cancelling a task;
- retrying a failed task;
- approving decomposition child mirroring where supported;
- decomposition approval works through the simple list while preserving graph
  data in the underlying task dependency model;
- viewer cannot mutate;
- unauthenticated mutation is rejected.

## Acceptance Criteria

- A human can create a standalone task without Yandex.
- A system/service account can create a task with idempotency key and audit
  trail.
- A human can mark a task ready.
- A human can preview agent context before marking a task ready.
- A human can answer an AI question.
- A human can resume execution after answering.
- A human can see MR URL and validation summary.
- Failed task diagnostics are visible without reading raw logs.
- Basic operations state is visible without reading raw logs or DB rows.
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
