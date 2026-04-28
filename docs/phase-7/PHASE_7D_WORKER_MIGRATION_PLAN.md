# Phase 7D - Worker Migration Plan

## Goal

Migrate worker execution to use the internal tracker structured task API.

By the end of this phase, a standalone internal task should be executable
end-to-end without Yandex comments:

```text
internal task -> claim -> analysis -> implementation -> validation -> MR publish
```

## What Is In Scope

- Use `AgentTaskContext` instead of `TrackerIssue + comments` for the internal
  execution path.
- Record analysis decisions in the internal tracker.
- Record clarification questions and human answers in the internal tracker.
- Record agent runs.
- Record task plan and step transitions for the implicit plan.
- Record validation runs.
- Record validation artifact refs and compact diagnostics.
- Record merge request metadata.
- Record review-fix metadata.
- Record decomposition decisions, create internal child tasks, and link typed
  dependencies when the existing decomposition path is used.
- Record memory context snapshot refs when memory context is added to a prompt.
- Keep `commentProtocol.ts` only for Yandex direct mode and bridge
  compatibility.
- Define and, where the application exposes tracker operations over HTTP,
  implement the workflow-first agent API surface that maps to the internal
  tracker contract.
- Add smoke or integration test for internal task execution.

## What Is Out Of Scope

- Yandex import/export bridge.
- Human UI.
- AI proposals.
- Full decomposition approval UI.
- Yandex mirroring of child tasks created through decomposition.
- Full public API gateway, human UI, or browser workflow.
- Removing Yandex direct worker path.

## Current Code To Touch

- `src/domain/orchestrator.ts`
- `src/domain/fleetOrchestrator.ts`
- `src/domain/promptBuilder.ts`
- `src/domain/promptContext.ts`
- `src/domain/qualityGates.ts` if validation recording needs structured output.
- `src/domain/repositoryContext.ts`
- `src/models/types.ts`
- New internal worker tests.

Be careful with:

- `src/integrations/tracker/commentProtocol.ts`
- existing tests in `tests/orchestrator.test.ts`;
- existing tests in `tests/fleetOrchestrator.test.ts`;
- `tests/worker.smoke.test.ts`.

## New Types And API

Extend the internal tracker contract with:

```typescript
recordAnalysis(taskId: string, decision: TaskAnalysisDecision): Promise<void>;
recordTaskStep(taskId: string, input: TaskStepRecordInput): Promise<void>;
askClarification(taskId: string, question: ClarificationQuestion): Promise<void>;
recordHumanAnswer(taskId: string, input: HumanAnswerInput): Promise<void>;
recordAgentRun(taskId: string, input: AgentRunInput): Promise<void>;
recordValidation(taskId: string, input: ValidationRecordInput): Promise<void>;
recordMergeRequest(taskId: string, input: MergeRequestRecordInput): Promise<void>;
recordReviewMetadata(taskId: string, input: ReviewMetadataRecordInput): Promise<void>;
recordDecomposition(taskId: string, plan: DecompositionPlan): Promise<void>;
createChildTasks(taskId: string, subtasks: SubtaskDraft[]): Promise<TaskRecord[]>;
linkDependency(input: LinkTaskDependencyInput): Promise<void>;
recordMemoryContext(taskId: string, input: MemoryContextRecordInput): Promise<void>;
```

Add:

- `AgentRun`;
- `TaskDecision`;
- `TaskPlan`;
- `TaskStep`;
- `QualityGateRun`;
- `MergeRequestRecord`;
- `ClarificationQuestionRecord`;
- `HumanAnswerRecord`;
- `DecompositionDecisionRecord`;
- `TaskDependencyRecord`;
- `ArtifactRef`;
- `MemoryContextRef`.

## Worker Workflow API Surface

The worker-facing API must remain workflow-first and mirror the internal
`TaskTrackerClient` operations. Do not introduce generic CRUD routes as the main
agent contract.

Minimum HTTP contract for internal mode:

```http
POST /api/agent/tasks:claim
POST /api/agent/tasks/{taskId}/events
POST /api/agent/tasks/{taskId}/decisions/analysis
POST /api/agent/tasks/{taskId}/decisions/decomposition
POST /api/agent/tasks/{taskId}/questions
POST /api/agent/tasks/{taskId}/validation-runs
POST /api/agent/tasks/{taskId}/merge-requests
POST /api/agent/leases/{leaseId}:heartbeat
POST /api/agent/leases/{leaseId}:release
```

If the current worker uses an in-process tracker client during this phase, the
same service methods must still be organized so these endpoints can call them
without duplicating orchestration logic. Handler-level tests or contract tests
should verify request validation and idempotency for claim, heartbeat, release,
validation, and publish paths.

## Storage Shape

Add or activate persisted storage for:

- `agent_runs`;
- `quality_gate_runs`;
- merge request metadata, either as `artifacts`/external refs or a dedicated
  `merge_requests` table if the implementation needs queryable MR fields;
- review metadata for unresolved GitLab discussions imported at `review` and
  before `review_fix`;
- memory context refs attached to the task, run, or prompt snapshot.

Use the Phase 7A `task_plans`, `task_steps`, `task_decisions`,
`task_dependencies`, and `artifacts` tables instead of creating parallel
runtime-only structures.

## Migration Strategy

Prefer a provider-specific orchestration boundary over scattered conditionals.
Two acceptable approaches:

1. Add `InternalWorkerOrchestrator` and keep `WorkerOrchestrator` for Yandex.
2. Refactor shared execution logic into provider-neutral helpers and keep thin
   provider adapters around state reads/writes.

Avoid mixing internal tracker writes and Yandex comment writes in the same code
path unless the path is explicitly a compatibility bridge.

## Implementation Order

1. Define provider-neutral `ExecutableTaskContext`.
2. Adapt prompt builder to accept `AgentTaskContext` or a normalized context.
3. Add internal state writer methods for analysis, plan steps, clarification,
   validation, MR publish, review fix, decomposition, dependencies, artifacts,
   and memory context refs.
4. Add the workflow-first agent API service/route boundary, or an explicitly
   tested in-process equivalent that can be exposed through those routes.
5. Implement internal execution path behind `TASK_TRACKER_PROVIDER=internal`.
6. Keep Yandex path unchanged.
7. Ensure decomposition creates internal child tasks first and does not mirror
   them to Yandex in internal mode.
8. Add tests for internal execution.
9. Run typecheck, unit tests, and smoke tests.

## Tests

Add tests for:

- internal task starts from `ready` and moves through execution statuses;
- analysis decision is stored structurally;
- clarification sets `awaiting_human`;
- human answer plus resume continues execution;
- validation failure writes diagnostic and failure status;
- successful publish records MR URL, branch, and validation summary;
- agent workflow endpoints or their route-ready service boundary validate
  claim, lifecycle events, decisions, questions, validation, publish, heartbeat,
  and release inputs;
- implicit plan steps are updated across analysis, implementation, validation,
  publish, and review fix;
- decomposition stores a decision, creates internal child tasks, and links
  parent/child dependencies;
- memory context refs are stored when memory context is used;
- Yandex direct mode tests still pass.

Add or adapt a smoke test:

```text
internal tracker -> mock GitLab -> worker -> MR ready
```

## Acceptance Criteria

- Worker can process a standalone internal task end-to-end.
- Worker does not require Yandex comments in internal mode.
- `AI STATUS`, `AI MR`, `AI REVIEW`, `AI ANALYSIS`, and `AI LEASE` comments are
  not written in internal mode.
- Internal worker operations are exposed through, or cleanly mappable to, the
  workflow-first agent API surface without introducing a CRUD-first worker
  contract.
- Current Yandex direct mode remains functional.
- Restart recovery uses internal DB/task state for internal mode.
- Internal mode records an implicit plan, step state, agent runs, decisions,
  quality gates, MR metadata, and artifact refs.
- Decomposition creates internal child tasks first and leaves Yandex mirroring to
  the bridge policy.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run test:smoke` passes or the reason it cannot run is documented.

## Rollback And Fallback

Use:

```env
TASK_TRACKER_PROVIDER=yandex
```

to return to the current direct Yandex runtime.

Do not remove Yandex tests in this phase.

## Open Questions

- Should review feedback processing be migrated in the first internal path or
  follow immediately after implementation publish?
- Should internal mode reuse existing branch naming based on issue key, or use
  internal `taskId`?
- How should `threadId` be restored after process restart?
- Should `AgentRun.finalMessage` be stored raw, redacted, or summarized?
- Where should memory context snapshot references be attached?

## Suggested Codex Task

```text
Implement Phase 7D from docs/phase-7/PHASE_7D_WORKER_MIGRATION_PLAN.md.
Make internal tracker mode execute tasks end-to-end without Yandex comments.
Keep Yandex direct mode passing.
```
