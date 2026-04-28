# Phase 7A - Tracker Core Plan

## Goal

Create the internal AI Task Tracker domain and storage foundation without
migrating worker execution yet.

The phase should produce a small, testable core that can create tasks, store
revisions, append timeline events, expose human and agent views, and remain
isolated from the current Yandex direct path.

## What Is In Scope

- Define internal tracker types:
  - `TaskRecord`;
  - `TaskStatus`;
  - `TaskRevision`;
  - `TaskEvent`;
  - `TaskComment`;
  - `TaskExternalRef`;
  - `AgentTaskContext`;
  - `TaskPlan`;
  - `TaskStep`;
  - `TaskDecision`;
  - `TaskDependency`;
  - `ArtifactRef`.
- Define `TaskTrackerClient` for internal task operations.
- Add basic status transition validation.
- Add status mapping from internal task statuses to the current logical statuses.
- Add append-only event recording.
- Add task revision recording.
- Add external refs with uniqueness by provider and external key.
- Add an implicit task plan and step model as a Phase 8 foundation.
- Add schema-only dependency and artifact metadata models so later phases do not
  need to rewrite the storage shape.
- Add an in-memory test implementation.
- Add PostgreSQL migration skeleton or schema files.
- Add tests for the internal domain and in-memory implementation.

## What Is Out Of Scope

- Worker migration.
- Atomic `claimNextTask`.
- DB-backed leases.
- Yandex import/export bridge.
- Human UI.
- AI proposals.
- Decomposition approval UI.
- Full dependency graph behavior.
- Artifact upload or object storage.
- Executing persisted plans through the worker.
- Replacing current `YandexTrackerClient`.

## Current Code To Touch

- `src/models/types.ts`
- New `src/domain/taskTracker/` modules.
- New `src/integrations/internalTracker/` modules if storage adapters are kept
  under integrations.
- New tests in `tests/taskTracker*.test.ts`.
- Optional migration files under `src/integrations/internalTracker/migrations/`
  or a similar local convention.

Avoid changing:

- `src/domain/orchestrator.ts`
- `src/domain/fleetOrchestrator.ts`
- `src/integrations/tracker/client.ts`
- `src/integrations/tracker/commentProtocol.ts`

## New Types And API

Minimum interface:

```typescript
export interface TaskTrackerClient {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  updateTaskRevision(taskId: string, input: TaskRevisionInput): Promise<TaskRecord>;
  markReady(taskId: string, reason?: string): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord>;
  getAgentTaskContext(taskId: string): Promise<AgentTaskContext>;
  appendEvent(taskId: string, input: TaskEventInput): Promise<void>;
  appendComment(taskId: string, input: CommentInput): Promise<void>;
  setStatus(taskId: string, status: TaskStatus, reason?: string): Promise<void>;
}
```

The interface can keep plan, decision, dependency, and artifact methods out of
the public client until later phases, but the types and schema must exist in
this phase. Start every task with one implicit plan so worker migration can
record step transitions without another schema redesign.

Minimum statuses:

```text
new
triage
ready
claimed
analyzing
awaiting_human
decomposing
implementing
validating
review
fixing_review
blocked
done
failed
cancelled
```

Minimum task fields:

- `id`;
- `title`;
- `description`;
- `humanSummary`;
- `source`;
- `createdBy`;
- `repositoryName`;
- `repoPathKey`;
- `baseBranch`;
- `queue`;
- `tags`;
- `components`;
- `priority`;
- `deadline`;
- `status`;
- `businessStatus`;
- `taskType`;
- `promptProfileId`;
- `confidence`;
- `acceptanceCriteria`;
- `constraints`;
- `riskFactors`;
- `missingContext`;
- `externalRefs`;
- `createdAt`;
- `updatedAt`;
- `lastSyncedAt`.

Minimum plan and step fields:

- `TaskPlan.id`;
- `taskId`;
- `status`;
- `schemaVersion`;
- `createdAt`;
- `updatedAt`;
- `TaskStep.id`;
- `kind`: `analyze`, `plan`, `implement`, `validate`, `fix`, `publish`,
  `review_fix`;
- `attempt`;
- `inputContextHash`;
- `outputSummary`;
- `artifacts`;
- `failureKind`;
- `diagnostic`.

Minimum decision fields:

- `id`;
- `taskId`;
- `kind`: `analysis`, `routing`, `decomposition`, `manual`;
- `schemaVersion`;
- `source`;
- `authorId` or `workerId`;
- `payload`;
- `createdAt`.

Minimum dependency fields:

- `id`;
- `fromTaskId`;
- `toTaskId`;
- `kind`: `blocks`, `blocked_by`, `parent_child`, `relates`, `duplicates`,
  `requires_human_input`, `requires_external_change`;
- `reason`;
- `status`;
- `createdAt`;
- `resolvedAt`.

Minimum artifact metadata fields:

- `id`;
- `taskId`;
- `kind`;
- `path` or `uri`;
- `summary`;
- `retentionClass`;
- `createdAt`.

## Storage Shape

Add schema files for at least:

- `tasks`;
- `task_revisions`;
- `task_external_refs`;
- `task_events`;
- `task_comments`;
- `task_decisions`;
- `task_plans`;
- `task_steps`;
- `task_dependencies`;
- `artifacts`.

PostgreSQL should be the production target. SQLite or in-memory storage can be
used only for tests and local smoke paths.

Do not add a runtime dependency on PostgreSQL in the application wiring during
this phase unless it is necessary for tests. The core can remain unused by the
worker until later phases.

## Implementation Order

1. Add domain types and status enums/unions.
2. Add transition validation helper.
3. Add in-memory `TaskTrackerClient`.
4. Add agent context builder that derives the worker-facing view from a task.
5. Add schema/migration files for the core tables.
6. Add unit tests.
7. Run typecheck and tests.

## Tests

Add tests for:

- creating a task with required fields;
- creating a task in `triage` when required execution fields are missing;
- marking a task `ready`;
- rejecting invalid status transitions;
- appending a revision and preserving previous input;
- appending events in chronological order;
- enforcing external ref uniqueness;
- building `AgentTaskContext`;
- creating an implicit plan for a new task;
- mapping internal statuses to current logical statuses;
- preserving schema-versioned decision payloads.

## Acceptance Criteria

- A task can be created without any Yandex issue.
- A task can be updated with a new revision.
- A task can be moved to `ready`.
- Human-readable task data and agent context can be read from the same model.
- Timeline events are append-only.
- The schema skeleton includes plans, steps, decisions, dependencies, and
  artifacts as first-class tables.
- Internal-to-logical status mapping is documented and tested.
- Current Yandex direct mode remains untouched.
- `npm run typecheck` passes.
- `npm test` passes.

## Rollback And Fallback

All new code must be isolated. If the phase has to be rolled back, removing the
new tracker modules and tests should restore the previous behavior.

Runtime fallback remains the current Yandex direct path.

## Open Questions

- Use UUID, ULID, or a custom `task_...` id format?
- Store migrations as raw SQL files, TypeScript migration functions, or a small
  local migration runner?
- Should status transition validation be strict in Phase 7A or permissive with
  audit warnings?
- Should `businessStatus` be nullable until an external source is attached?

## Suggested Codex Task

```text
Implement Phase 7A from docs/phase-7/PHASE_7A_TRACKER_CORE_PLAN.md.
Only add the internal tracker core, storage schema skeleton, and tests.
Do not migrate the worker or change Yandex direct mode.
```
