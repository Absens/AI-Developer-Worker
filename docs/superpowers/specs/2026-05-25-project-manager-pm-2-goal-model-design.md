# Project Manager PM-2 Goal Model Design

## Goal

Phase PM-2 turns project manager goal candidates into first-class stored objects that humans can review, approve, reject, and audit. This phase still does not create executable tasks or task proposals; that remains PM-3.

## Scope

PM-2 includes:

- `ProjectGoal` domain records with lifecycle state.
- In-memory and PostgreSQL-backed `ProjectManagerStore` support for goals, analyses, runs, goal-task links, and goal audit events.
- Duplicate detection for proposed goals using repository, normalized title, and evidence references.
- Goal lifecycle commands: approve, reject, and mark stale.
- HTTP API endpoints for reading goals, approving/rejecting goals, and manually starting a PM analysis run.
- Tests for lifecycle transitions, duplicate handling, API roles, and migrations.

PM-2 excludes:

- Calling `TaskTrackerClient.proposeTask`.
- Auto-creating executable tasks.
- Dedicated Angular goal UI.
- Cross-repository goal planning.
- Automatic scheduler wiring for `PROJECT_MANAGER_INTERVAL_MINUTES`.

## Domain Model

`ProjectGoal` is derived from a bounded `ProjectGoalDraft` after analysis persistence. Stored goals include:

- identity: `id`, `repositoryName`, `duplicateSignature`
- lifecycle: `status`, `createdAt`, `updatedAt`, approval/rejection/stale metadata
- source: `sourceAnalysisId`, `sourceRunId`
- content: `title`, `problemStatement`, `desiredOutcome`, `successMetrics`, `evidenceRefs`, `priority`, `riskLevel`
- audit trail: `ProjectGoalAuditEvent[]`

Allowed lifecycle transitions:

- `proposed -> approved`
- `proposed -> rejected`
- `proposed -> stale`
- `approved -> active`
- `approved -> stale`
- `active -> completed`
- `active -> stale`

PM-2 API implements only `approve` and `reject`. `mark stale` is store/domain capability for stale analysis results and later phases.

## Policy

`ProjectGoalPolicy` computes a duplicate signature from:

- repository name
- normalized title: lowercase, whitespace-collapsed
- evidence identity list: `kind:lower(ref)`, sorted and deduplicated

A new proposed goal is skipped when a non-terminal goal already exists with the same duplicate signature. Terminal statuses are `rejected`, `stale`, and `completed`.

The PM orchestrator records analysis first, then materializes non-duplicate proposed goals, and finally stores the created goal IDs in the completed run. If goal creation fails, the run fails; it must not silently report success with partially unknown goal state.

## Storage

The existing `ProjectManagerStore` grows from run/analysis storage into the PM persistence boundary. The in-memory implementation remains the default test and memory tracker implementation.

PostgreSQL storage lives beside the internal tracker adapter because it uses the same database operational boundary. The migration adds:

- `project_manager_runs`
- `project_analyses`
- `project_goals`
- `project_goal_audit_events`
- `project_goal_tasks`

`assertInternalTrackerOperational` must include the PM-2 tables and indexes once the migration exists.

## API

The human API accepts an optional project manager dependency:

- store for goal reads and lifecycle commands
- runner/orchestrator for manual PM runs

Routes:

- `GET /api/project-goals`: viewer+
- `GET /api/project-goals/:id`: viewer+
- `POST /api/project-goals/:id/commands/approve`: developer+
- `POST /api/project-goals/:id/commands/reject`: developer+
- `POST /api/project-manager/runs`: operator+

When project manager dependencies are not configured, PM routes return a clear unavailable error instead of affecting task tracker behavior.

## Safety Invariants

- PM-2 never calls `createTask` or `proposeTask`.
- PM-2 never changes Tracker/Yandex/GitLab state.
- PM analysis still uses Codex `sandbox: "read-only"`.
- Untrusted analysis output remains bounded before persistence.
- Duplicate PM runs do not create duplicate non-terminal goals.
- Approval only changes goal state; it does not trigger task proposal generation.

## Testing Strategy

- Unit tests for duplicate signatures and policy decisions.
- Store tests for create/list/get/approve/reject/stale transitions and audit events.
- Orchestrator tests proving proposed goals are materialized and duplicates are skipped.
- Human API tests for read/approve/reject/run roles and unavailable PM dependencies.
- Migration tests for PM-2 table/index registration.
- Existing PM-1 tests remain green.
