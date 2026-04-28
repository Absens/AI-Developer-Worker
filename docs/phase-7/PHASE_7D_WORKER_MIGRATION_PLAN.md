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
- Record validation runs.
- Record merge request metadata.
- Record review-fix metadata.
- Keep `commentProtocol.ts` only for Yandex direct mode and bridge
  compatibility.
- Add smoke or integration test for internal task execution.

## What Is Out Of Scope

- Yandex import/export bridge.
- Human UI.
- AI proposals.
- Full decomposition approval UI.
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
askClarification(taskId: string, question: ClarificationQuestion): Promise<void>;
recordHumanAnswer(taskId: string, input: HumanAnswerInput): Promise<void>;
recordAgentRun(taskId: string, input: AgentRunInput): Promise<void>;
recordValidation(taskId: string, input: ValidationRecordInput): Promise<void>;
recordMergeRequest(taskId: string, input: MergeRequestRecordInput): Promise<void>;
recordReviewMetadata(taskId: string, input: ReviewMetadataRecordInput): Promise<void>;
```

Add:

- `AgentRun`;
- `TaskDecision`;
- `QualityGateRun`;
- `MergeRequestRecord`;
- `ClarificationQuestionRecord`;
- `HumanAnswerRecord`.

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
3. Add internal state writer methods for analysis, clarification, validation,
   MR publish, and review fix.
4. Implement internal execution path behind `TASK_TRACKER_PROVIDER=internal`.
5. Keep Yandex path unchanged.
6. Add tests for internal execution.
7. Run typecheck, unit tests, and smoke tests.

## Tests

Add tests for:

- internal task starts from `ready` and moves through execution statuses;
- analysis decision is stored structurally;
- clarification sets `awaiting_human`;
- human answer plus resume continues execution;
- validation failure writes diagnostic and failure status;
- successful publish records MR URL, branch, and validation summary;
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
- Current Yandex direct mode remains functional.
- Restart recovery uses internal DB/task state for internal mode.
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

