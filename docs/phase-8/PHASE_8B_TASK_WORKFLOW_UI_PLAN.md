# Phase 8B - Task Workflow UI Plan

## Goal

Build the first useful Angular task workflow console.

By the end of this phase, a human should be able to perform the core internal
tracker workflow from the Angular UI.

## What Is In Scope

- Queue view with filters.
- Task list grouped by operational status.
- Task detail view.
- Create task view with templates.
- Agent context preview.
- Mark ready workflow.
- Human answer and resume workflow.
- Hold, cancel, retry, and force reanalysis actions.
- Proposal review list.
- Proposal approve and reject actions.
- Simple decomposition child approval list.
- MR and validation summary.
- Timeline and comment/question display.
- Focused empty, loading, and error states.

## What Is Out Of Scope

- Full dependency graph UI.
- Drag-and-drop board.
- Complex workflow customization.
- Rich text editor for task descriptions.
- Attachment binary upload.
- WebSockets or real-time collaboration.
- New backend workflow commands.
- Advanced AI workflow or RAG features.

## Current Code To Touch

- Angular frontend files from Phase 8A.
- Human API DTOs and services from Phase 8A.
- `src/observability/taskTrackerHumanApi.ts` only for additive DTO or response
  improvements if required.
- `tests/humanTaskApi.test.ts` if API response shapes are stabilized.
- `docs/phase-8/HUMAN_API_CONTRACT.md` if workflow DTOs, commands, or response
  examples change.
- Frontend tests.

## Contract Requirements

Before building components, confirm that the Phase 8A DTOs and services match
`HUMAN_API_CONTRACT.md`. The UI must:

- call `GET /api/session` before showing mutation controls;
- use session capabilities for visible/enabled action states;
- use the command matrix from `HUMAN_API_CONTRACT.md` for confirmations,
  reason prompts, and tests;
- map API responses in Angular services before components render data;
- render allowlisted fields instead of raw `TaskRecord` or raw agent context
  JSON dumps;
- reuse the canonical test fixture set from `HUMAN_API_CONTRACT.md`.

## UI Structure

Recommended route structure:

```text
/tasks
/tasks/new
/tasks/:taskId
/tasks/proposals
/tasks/operations
```

The Angular route names can still be `queue`, `create`, `detail`,
`proposals`, and `operations`, but browser-visible URLs should remain under the
configured app path `/tasks`.

The task workflow should use a two-panel console layout on desktop:

- left side: queue groups and filters;
- right side: selected task detail.

On narrow screens, use route navigation rather than squeezing both panels into
an unreadable layout.

Task selection and filters should be encoded in the URL so an operator can
share a queue or task state:

```text
/tasks?status=ready&status=failed&repository=developer&queue=DEV&selected=task-123
/tasks/task-123
```

Do not persist filters to local storage in Phase 8B unless the implementation
also includes a visible reset path and tests. URL state is the required
baseline.

## Queue View

Show grouped tasks:

- `ready`;
- `awaiting_human`;
- `review`;
- `failed`;
- `blocked`.

Filters:

- repository;
- queue;
- status;
- priority;
- worker;
- tag.

Filtering rules:

- debounce text input before calling the API;
- use `status` as a repeated query parameter;
- send a conservative default `limit`, for example 100;
- show a compact "result limited" state if the API returns a full page and
  pagination is not implemented yet;
- keep grouped list heights stable while loading.

Each task row should show:

- title;
- status tag;
- repository and queue;
- priority;
- active worker if any;
- blocker reason or latest diagnostic summary;
- MR indicator when available.

Use PrimeNG components such as:

- `Table` or `DataView`;
- `Tag`;
- `Select`;
- `MultiSelect`;
- `InputText`;
- `Button`;
- `Skeleton` for loading states.

## Create Task View

Support:

- task template;
- title;
- description;
- repository;
- repo path key;
- base branch;
- queue;
- priority;
- acceptance criteria;
- tags;
- save draft;
- create ready;
- preview agent context.

Use Angular reactive forms with explicit validation. Do not let empty title or
description reach the API when the UI can catch it first.

Task templates should cover the current prompt profiles:

- backend endpoint;
- frontend UI fix;
- tests only;
- refactor;
- dependency update;
- documentation.

Draft and ready behavior:

- "Save draft" creates a task with backend default draft status, currently
  `new`, unless the API contract changes.
- "Create ready" sends `status: "ready"` only after client-side validation
  passes.
- Empty title, empty description, invalid tag lists, and malformed acceptance
  criteria must be rejected by Angular form validation before the API call.
- If agent context preview is used before creation, the UI should clearly show
  that it is a preview of the entered form data or disable preview until a task
  exists; do not fake a backend preview response.

## Task Detail View

Show:

- title and status;
- goal and description;
- acceptance criteria;
- repository, branch, queue, priority, tags;
- active worker and lease TTL when available;
- open clarification question;
- latest AI summary;
- latest validation summary;
- MR link and branch;
- current plan/step summary if available;
- timeline;
- comments, questions, and answers.

Actions:

- preview context;
- mark ready;
- answer;
- answer and resume;
- resume;
- hold;
- cancel;
- retry;
- force reanalysis.

Risky actions should use a confirmation dialog and require a reason where the
backend supports it.

Use this UI command policy, matching `HUMAN_API_CONTRACT.md`:

| Action | Min role | Confirmation | Reason in UI |
| --- | --- | --- | --- |
| mark ready | developer | yes | recommended |
| answer | developer | no, unless also resuming | no |
| answer and resume | developer | yes | recommended |
| resume | developer | yes | recommended |
| cancel | developer | yes | required |
| approve decomposition | developer | yes | required |
| approve proposal | developer | yes | required |
| reject proposal | developer | yes | required |
| hold | operator | yes | required |
| retry | operator | yes | required |
| force reanalysis | operator | yes | required |

If a command is not supported by the current task state, hide it when that is
obvious from DTOs; otherwise disable it with a short reason. Backend errors must
still be surfaced because the backend remains authoritative.

Agent context preview:

- opens in a dialog or side panel with a max height and copy-safe text wrapping;
- truncates very long fields in the visible preview;
- never renders raw secret-bearing environment or unredacted command output;
- links back to the task detail instead of expanding nested logs inline.

## Proposal Review

Show:

- proposal title;
- repository;
- proposed by;
- autonomy level;
- policy decision;
- policy reason;
- evidence refs;
- suggested acceptance criteria;
- supervisor status.

Actions:

- approve;
- reject.

Approval should not be a silent state change. The dialog should capture a
short reason for audit history.

Proposal rows should use the backend proposal DTO. Do not infer proposal state
from task status alone; `proposal.supervisorStatus` is the source of truth for
approve/reject visibility.

## Decomposition Approval List

Show child tasks:

- title;
- status;
- dependency reason;
- external mirror status;
- approve child mirroring where supported.

Do not build a graph view in this phase.

## Implementation Order

1. Verify and, if needed, update `HUMAN_API_CONTRACT.md`.
2. Add shared status, priority, role capability, and date formatting helpers.
3. Add URL-backed queue filters and task list.
4. Add task detail page.
5. Add create task page with templates and validation.
6. Add agent context preview dialog/panel.
7. Add task command actions with confirmation, reason capture, and error
   handling.
8. Add answer/resume workflow.
9. Add proposal list and approve/reject actions.
10. Add decomposition approval list.
11. Add MR, validation, and timeline sections.
12. Add canonical fixtures for frontend tests.
13. Add tests.
14. Run verification commands.

## Tests

Add frontend tests for:

- session capabilities drive action visibility;
- task queue renders grouped data;
- filters call the expected API query;
- URL query params restore filters and selected task;
- task detail renders MR and validation summaries;
- create task validates required fields;
- create ready sends expected payload;
- agent context preview renders returned data;
- answer plus resume sends answer and resume operations;
- retry/hold/cancel/force-reanalysis actions require confirmation and reason;
- proposal approval and rejection call expected endpoints;
- command buttons are hidden or disabled for insufficient roles.

Add or keep backend tests for:

- API response shapes consumed by the Angular UI;
- command endpoints still enforce roles;
- proposal endpoints still enforce roles;
- command responses continue to match `HUMAN_API_CONTRACT.md`.

## Acceptance Criteria

- `HUMAN_API_CONTRACT.md` matches every workflow endpoint and DTO consumed by
  the Angular UI.
- A human can list and filter tasks from Angular.
- Queue filters and task selection are shareable through the URL.
- A human can create a draft task.
- A human can create a ready task.
- A human can preview agent context.
- A human can open task detail.
- A human can answer an AI question.
- A human can resume execution after answering.
- A human can hold, cancel, retry, and force reanalysis where supported.
- A human can approve or reject AI proposals.
- A human can see MR and validation summaries.
- A human can inspect the recent timeline without opening raw logs.
- Role/capability state from `/api/session` controls visible and enabled
  mutation controls.
- Risky actions use confirmation dialogs and reason capture according to the
  command matrix.
- Agent context and diagnostics use allowlisted, truncated rendering.
- Backend tests pass.
- `npm run web:typecheck` passes.
- `npm run web:test` passes.
- `npm run web:build` passes.

## Rollback

Set:

```env
TASK_TRACKER_UI_ENABLED=false
```

to disable the human UI while keeping worker execution available. If the old
embedded UI is needed again, roll back to the previous application version.

## Open Questions

Resolved for Phase 8B:

- Task list selection and filters are encoded in the URL.
- Filters are not persisted to local storage in the baseline implementation.
- Force reanalysis remains visible only to operator/admin roles and must say in
  the UI that it records a reanalysis request rather than guaranteeing an
  immediate restart.

Remaining later question:

- Should task detail auto-refresh while a task is running, or should polling
  remain operations-page only until a later phase?

## Suggested Codex Task

```text
Implement Phase 8B from docs/phase-8/PHASE_8B_TASK_WORKFLOW_UI_PLAN.md.
Build the Angular/PrimeNG task workflow UI on top of the existing human API.
Do not add new backend product features unless an additive DTO fix is required.
```
