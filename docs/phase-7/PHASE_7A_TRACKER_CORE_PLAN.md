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
  - `TaskMessageKind`;
  - `TaskExternalRef`;
  - `AgentTaskContext`;
  - `TaskPlan`;
  - `TaskStep`;
  - `TaskDecision`;
  - `TaskDependency`;
  - `ArtifactRef`;
  - `ExternalTaskSource` boundary types.
- Define `TaskTrackerClient` for internal task operations.
- Define the external-source boundary as a provider-neutral stub so Yandex and
  future trackers cannot leak into the internal runtime model.
- Add basic status transition validation.
- Add status mapping from internal task statuses to the current logical statuses.
- Add append-only event recording.
- Add the canonical conversation taxonomy for human comments, AI protocol
  messages, commands, status digests, and system events.
- Add task revision recording.
- Add external refs with uniqueness by provider and external key.
- Add a field ownership model that separates human-authored task input,
  external-source snapshots, worker runtime state, GitLab sync metadata, and
  policy/admin decisions.
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
- Implementing any `ExternalTaskSource` provider.
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

Define the provider boundary in this phase, but leave concrete providers to
later phases:

```typescript
export interface ExternalTaskSource {
  importCandidates(input: ImportCandidatesInput): Promise<ExternalIssueSnapshot[]>;
  exportDigest(input: ExportDigestInput): Promise<void>;
  transitionExternal(input: ExternalTransitionInput): Promise<void>;
}
```

The Phase 7A implementation may keep the related input/output types minimal or
schema-only. They must not reference Yandex-specific fields directly; provider
details belong in bridge modules such as Phase 7E.

Canonical message kinds:

```text
comment
question
answer
command
status_digest
system_event
```

`TaskComment` or the equivalent conversation record must preserve the message
kind, author/source, creation time, body or structured payload, and optional
external reference metadata. UI can later merge these into one timeline, but
the API and storage model must not collapse them into untyped free text.

## Field Ownership And Conflicts

The core model must make field ownership explicit enough that later Yandex,
GitLab, UI, worker, and policy integrations do not overwrite each other's
state. This can be implemented as metadata on field groups, task revisions,
events, or adapter-specific ownership records, but the behavior must be
documented and tested at the domain level.

Minimum ownership groups:

| Owner | Owns | Must Not Own |
| --- | --- | --- |
| Human/UI/API | task title, description, acceptance criteria, constraints, comments, manual commands for native tasks | leases, agent runs, validation internals |
| External task source | imported snapshots, external revision metadata, external refs, external business status mirror fields | internal runtime status, leases, active plans, worker decisions |
| Worker/agent | execution status transitions through workflow methods, plan steps, agent runs, questions, decisions, validation records, MR publication events | approved human input revisions |
| GitLab sync | merge request refs, branch metadata, review feedback snapshots, review-fix state | canonical task description or external tracker status policy |
| Policy/admin | autonomy level, approval policy, supervisor decisions, retention/admin settings | raw human task text or worker execution artifacts |

Conflict rule: external changes to human-authored input create a new
`TaskRevision` and audit event. They do not directly rewrite active execution
state. Runtime decisions about reanalysis, cancellation, or continuing work are
made by internal tracker workflow methods in later phases.

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

This is the core schema skeleton, not the complete production schema. Later
phases add or activate `task_leases`, idempotency records, `agent_runs`,
`quality_gate_runs`, merge/review metadata, `sync_cursors`, raw external
snapshots, `task_proposals`, proposal evidence, retention metadata, and
operational tables. Do not mark internal tracker production-ready until those
staged schema additions exist.

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
- preserving conversation message kind instead of parsing protocol messages from
  plain comments;
- enforcing external ref uniqueness;
- exposing the provider-neutral `ExternalTaskSource` boundary without a concrete
  provider implementation;
- building `AgentTaskContext`;
- creating an implicit plan for a new task;
- mapping internal statuses to current logical statuses;
- preserving schema-versioned decision payloads.
- documenting and enforcing the minimum field ownership groups at the domain
  boundary.

## Acceptance Criteria

- A task can be created without any Yandex issue.
- A task can be updated with a new revision.
- A task can be moved to `ready`.
- Human-readable task data and agent context can be read from the same model.
- Timeline events are append-only.
- Conversation records distinguish comments, questions, answers, commands,
  status digests, and system events.
- `ExternalTaskSource` exists as a neutral boundary, but no external provider is
  implemented in this phase.
- The schema skeleton includes plans, steps, decisions, dependencies, and
  artifacts as first-class tables.
- Field ownership is documented so external source updates, human input,
  worker runtime state, and integration metadata cannot silently overwrite each
  other.
- The plan documents which production tables are intentionally staged for later
  phases.
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
