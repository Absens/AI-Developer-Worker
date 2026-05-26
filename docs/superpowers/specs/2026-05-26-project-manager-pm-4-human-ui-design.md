# Project Manager PM-4 Human UI Design

## Context

Phase PM-4 builds the human-facing Project Manager console on top of the
PM-0 through PM-3 backend now merged to `main`.

The backend already supports:

- `GET /api/project-goals`
- `GET /api/project-goals/:id`
- `POST /api/project-goals/:id/commands/approve`
- `POST /api/project-goals/:id/commands/reject`
- `POST /api/project-goals/:id/commands/propose-tasks`
- `POST /api/project-manager/runs`
- PM goal storage, audit events, analysis/run storage, goal-task links, and
  task proposal generation through `TaskTrackerClient.proposeTask`

The Angular console already supports queue, task detail, create task,
proposals, operations, role-aware sessions, unit tests, and Playwright critical
flows.

## Goal

Give a human operator a dedicated UI to inspect project goals, approve or reject
them, generate bounded task proposals from approved goals, and trace the
relationship between goals, proposals, and executable tasks.

## Non-Goals

PM-4 does not implement automatic replanning, scheduled PM runs, controlled
low-risk auto-approval, roadmap drag/drop editing, sprint planning, capacity
planning, or multi-repository portfolio views. Those remain later roadmap
phases.

PM-4 does not let the UI create executable tasks from a project goal directly.
All goal-derived work must continue through `propose-tasks` and the existing
proposal approval path.

## Product Scope

PM-4 adds a new `/goals` area to the Angular console.

The goals list shows:

- goal title and id
- repository
- lifecycle status
- priority and risk
- linked task count
- suggested task proposal draft count
- source analysis/run ids when available
- compact evidence summary
- last updated time

The goal detail view shows:

- problem statement
- desired outcome
- success metrics
- evidence refs
- suggested task proposal drafts
- linked task ids with task summaries when the task tracker is configured
- audit timeline
- lifecycle metadata such as approved/rejected/stale/completed actors and times
- actions available for the current role and goal status

The proposals page shows parent goal context for PM-created proposals:

- linked goal title
- goal status
- goal risk
- link to the goal detail view

The task detail view shows parent goal context for tasks linked through
`project_goal_tasks`.

## Required Backend Additions

PM-4 needs small API enrichments so the UI does not make N+1 requests or infer
project relationships from raw evidence strings.

### Session Capabilities

Add explicit capabilities:

- `canProposeProjectGoalTasks`: `operator+`, requires project manager store and
  task tracker.
- `canCompleteProjectGoals`: `developer+`, requires project manager store.
- `canMarkProjectGoalsStale`: `developer+`, requires project manager store.

Keep existing capabilities:

- `canReadProjectGoals`: `viewer+`, requires project manager store.
- `canApproveProjectGoals`: `developer+`, requires project manager store.
- `canRunProjectManager`: `operator+`, requires project manager runner.

Reasoning: task proposal fan-out is operationally stronger than approving a
goal, so it remains `operator+`. Completing or marking stale changes only goal
lifecycle metadata and matches the `developer+` approval/rejection role.

### Goal Lifecycle Commands

Expose store lifecycle operations already present in PM-2:

- `POST /api/project-goals/:id/commands/complete`
  - Role: `developer+`
  - Allowed by store only from `active`
  - Response: `{ goal }`
- `POST /api/project-goals/:id/commands/stale`
  - Role: `developer+`
  - Body: `{ "reason": "..." }`
  - Response: `{ goal }`

The UI should not show these actions when the session lacks capability or when
the current goal status cannot transition.

### Goal Link Lookup

Add a batch lookup method to `ProjectManagerStore`:

```typescript
listGoalTaskLinksForTaskIds(taskIds: string[]): Promise<ProjectGoalTaskLink[]>;
```

Implement it for both in-memory and PostgreSQL stores. The method returns an
empty array for an empty input and must not throw for unknown task ids.

This supports proposal list and task detail parent-goal badges without scanning
every goal from the UI.

### API Response Enrichment

Keep the existing response shapes backwards-compatible and add optional fields:

- `GET /api/project-goals`
  - existing: `{ goals, role, generatedAt }`
  - add: `linkedTaskCounts: Record<string, number>`
- `GET /api/project-goals/:id`
  - existing: `{ goal, auditEvents, taskLinks }`
  - add: `linkedTasks: TaskSummary[]`
- `GET /api/proposals`
  - keep existing proposal summaries
  - add optional `projectGoals: ProjectGoalSummary[]` on each proposal summary
- `GET /api/tasks/:id`
  - keep existing task detail response
  - add optional `projectGoals: ProjectGoalSummary[]`

`ProjectGoalSummary` should be compact:

```typescript
interface ProjectGoalSummary {
  id: string;
  title: string;
  status: ProjectGoalStatus;
  priority: ProjectGoalPriority;
  riskLevel: ProjectGoalRiskLevel;
  repositoryName: string;
}
```

If the project manager store is not configured, the optional fields are omitted
or empty and existing task/proposal UI behavior is unchanged.

## Angular Architecture

Add project-goal DTOs and mappers beside existing human API DTOs:

- `ProjectGoalDto`
- `ProjectGoalSummaryDto`
- `ProjectGoalAuditEventDto`
- `ProjectGoalTaskLinkDto`
- `ProjectGoalListResponseDto`
- `ProjectGoalDetailResponseDto`
- `ProjectGoalCommandResponseDto`
- `ProjectGoalProposeTasksResponseDto`

Add `ProjectGoalService` beside `ProposalService` and `TaskApiService`.

Routes:

- `/goals` -> `GoalsPageComponent`
- `/goals/:goalId` -> `GoalDetailPageComponent`

Navigation:

- Add "Цели" with `pi pi-sitemap`
- Show it only when `canReadProjectGoals` is true

The UI should keep the current console style: dense operational layouts,
compact cards/rows, PrimeNG buttons/tags/selects/dialogs, no marketing hero
sections, and no nested decorative card layouts.

## User Workflows

### Review Proposed Goals

1. Open `/goals`.
2. Filter to status `proposed`.
3. Open a goal detail.
4. Inspect evidence, success metrics, suggested task drafts, and audit events.
5. Approve or reject the goal with an explicit reason for rejection.

### Generate Task Proposals

1. Open an `approved` or `active` goal.
2. Click "Создать предложения задач".
3. UI calls `POST /api/project-goals/:id/commands/propose-tasks`.
4. UI shows the returned tasks and links.
5. User can open `/proposals` and see the proposals with parent goal context.

### Reanalysis

1. Operator clicks "Запустить анализ" from `/goals` or a goal detail page.
2. UI calls `POST /api/project-manager/runs` with the selected repository.
3. UI shows the run id/status returned by the backend and refreshes the goals
   list after completion or on manual refresh.

### Goal Completion/Staleness

1. Developer opens an active goal and marks it completed after linked work is
   done.
2. Developer marks a non-terminal goal stale with a reason when the goal is no
   longer relevant.
3. The audit timeline immediately reflects the lifecycle event after refresh.

## Error Handling

The UI must surface API errors through existing message/toast patterns.

Expected cases:

- project manager API not configured: goals nav hidden; direct `/goals` route
  shows a 503-style empty/error state.
- user lacks role: action hidden; direct action attempts show a 403 toast.
- invalid lifecycle transition: API returns conflict/error; detail view keeps
  the latest known state and shows the message.
- repeated `propose-tasks`: response may contain existing idempotent proposals;
  UI treats this as a successful safe repeat and refreshes links.

## Testing Requirements

Backend tests:

- session capabilities include new project goal action capabilities by role
- complete/stale routes enforce method, role, and lifecycle constraints
- project goal list includes linked task counts
- project goal detail includes linked task summaries when tracker is available
- proposal list and task detail include linked project goal summaries
- PM-3 safety invariant remains: UI/API path still never calls `createTask`

Angular unit tests:

- nav displays "Цели" only with `canReadProjectGoals`
- goals list renders filters, status/risk/priority, linked task counts, and
  empty/error states
- goal detail renders evidence, drafts, audit events, linked tasks, and
  role/status-gated actions
- approve/reject/propose/complete/stale call the expected endpoints and refresh
  state
- proposals page renders parent goal badges
- task detail renders parent goal links

Playwright tests:

- operator/developer flow: open goals, approve goal, create task proposals,
  see linked proposal, approve proposal, see task in queue
- viewer flow: viewer can read goals but cannot see mutation actions

## Acceptance Criteria

- A viewer can navigate to `/goals`, inspect goals and goal details, and follow
  links to related proposals/tasks.
- A developer can approve/reject goals and mark active goals completed.
- An operator can run project analysis and generate task proposals from approved
  or active goals.
- PM-generated proposals show their parent goal on the proposals page.
- Linked executable or proposal tasks show their parent goal on task detail.
- Existing queue, proposals, operations, and task detail flows remain green.
- `npm run typecheck`, `npm test`, `npm run web:typecheck`,
  `npm run web:test`, and `npm run web:e2e` pass.

## Implementation Notes

Do not build a broad roadmap editor in PM-4. Keep the first UI focused on
review, approval, proposal generation, and traceability. The implementation
should preserve the existing backend as the source of truth and use additive
response fields so older UI consumers keep working.
