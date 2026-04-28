# Phase 7B - Atomic Queue Plan

## Goal

Add the atomic queue and lease mechanism that lets a worker claim a task and a
repository lease transactionally.

This phase turns the internal tracker core into a coordination backend for
worker fleet execution, but it still does not migrate the worker execution path.

## What Is In Scope

- `claimNextTask`.
- Task leases.
- Repository leases.
- Lease heartbeat.
- Lease release.
- Stale lease recovery.
- Idempotency keys for claim, heartbeat, and release.
- Priority ordering in the internal claim path.
- PostgreSQL-backed claim/lease implementation for production runtime.
- In-memory lease implementation only for unit tests and local smoke paths.
- Concurrency tests for double-claim prevention.

## What Is Out Of Scope

- Running Codex from internal tracker tasks.
- Yandex import/export.
- Human UI.
- AI proposals.
- Removing `TrackerCommentLockBackend`.

## Current Code To Touch

- `src/domain/lockBackend.ts`
- `src/domain/priorityQueue.ts` if scoring helpers need reuse.
- `src/models/types.ts`
- New or existing `src/domain/taskTracker/` modules.
- New or existing PostgreSQL storage adapter under
  `src/integrations/internalTracker/`.
- New tests in `tests/taskTrackerQueue.test.ts` or similar.

Avoid changing worker orchestration behavior in:

- `src/domain/orchestrator.ts`
- `src/domain/fleetOrchestrator.ts`

unless the change is a type-only preparation that does not alter runtime flow.

## New Types And API

```typescript
export interface ClaimTaskInput {
  workerId: string;
  repositoryProfiles: ClaimRepositoryProfile[];
  capabilities?: string[];
  maxTasks?: number;
  leaseTtlSeconds: number;
  targetExternalKey?: string;
  idempotencyKey?: string;
}

export interface ClaimedTask {
  task: TaskRecord;
  agentContext: AgentTaskContext;
  taskLease: TaskLeaseRecord;
  repositoryLease: TaskLeaseRecord;
}

export interface TaskLeaseRecord {
  leaseId: string;
  kind: "task" | "repository";
  leaseKey: string;
  taskId: string;
  repositoryName: string;
  workerId: string;
  token: string;
  expiresAt: string;
  heartbeatAt: string;
  releasedAt?: string;
}
```

Extend `TaskTrackerClient` with:

```typescript
claimNextTask(input: ClaimTaskInput): Promise<ClaimedTask | null>;
heartbeatLease(leaseId: string, input: LeaseHeartbeatInput): Promise<TaskLeaseRecord>;
releaseLease(leaseId: string, input: ReleaseLeaseInput): Promise<void>;
```

## Storage Shape

Add:

- `task_leases`;
- `idempotency_keys` or an equivalent persisted idempotency table documented in
  the storage adapter;
- indexes for claim:
  - `tasks(status, repository_name, priority, deadline)`;
  - active task lease by `task_id`;
  - active repository lease by `lease_key`;
  - lease expiry by `expires_at`.

PostgreSQL claim should be designed around row-level locking. The expected
implementation pattern is a transaction that selects an eligible task, locks it,
creates task and repository leases, updates task status, and writes an event.
Do not use the in-memory adapter for `TASK_TRACKER_PROVIDER=internal` outside
tests.

## Claim Rules

Claim should consider:

- task status `ready`;
- optionally resumable statuses in later phases;
- dependencies with no active blockers;
- repository availability;
- priority score;
- deadline;
- stale leases;
- manual target override;
- confidence score.

For this phase, dependency behavior can be limited to active blockers recorded
in `task_dependencies`. Do not block the phase on graph UI or complex
decomposition policy, but claim must not ignore a known active blocker.

## Implementation Order

1. Add lease types and schema.
2. Add in-memory lease implementation for tests.
3. Add PostgreSQL lease and claim implementation.
4. Add claim eligibility helper.
5. Add claim operation to the internal tracker adapter.
6. Add heartbeat and release operations.
7. Add stale lease cleanup or stale lease ignoring logic.
8. Add concurrency tests.
9. Run verification commands.

## Tests

Add tests for:

- two workers cannot claim the same task;
- two workers cannot claim tasks for the same repository lease key;
- expired task lease allows re-claim;
- expired repository lease allows another task to be claimed;
- heartbeat extends expiry only when token/worker matches;
- release is idempotent;
- repeated claim with the same idempotency key returns the same claim result or
  a clearly documented equivalent response;
- priority ordering picks the highest-scored eligible task.
- active blocking dependencies prevent claim.
- PostgreSQL integration tests run when `TASK_TRACKER_TEST_DATABASE_URL` or the
  repo's equivalent test DB setting is available.

## Acceptance Criteria

- `claimNextTask` returns task, agent context, task lease, and repository lease
  as one atomic operation.
- Concurrent claims cannot double-assign a task.
- Concurrent claims cannot double-assign a repository.
- Stale leases do not permanently block the queue.
- Production internal mode has a PostgreSQL-backed claim/lease path.
- The in-memory adapter is not selected silently for production internal mode.
- Known active task dependencies prevent claim.
- Existing `TrackerCommentLockBackend` tests still pass.
- `npm run typecheck` passes.
- `npm test` passes.

## Rollback And Fallback

Keep current lock backends:

- `TrackerCommentLockBackend`;
- `NoopLockBackend`.

If internal queue is disabled, current Yandex/comment lock behavior must remain
available.

## Open Questions

- Should `maxTasks` be implemented now or accepted but limited to one task?
- What is the default lease TTL?
- Should stale lease recovery update rows eagerly or treat expired rows as
  inactive during claim?
- How should repository lease keys be normalized across Windows and Linux paths?
- Should a worker be allowed to renew a lease after task status changes to a
  terminal state?

## Suggested Codex Task

```text
Implement Phase 7B from docs/phase-7/PHASE_7B_ATOMIC_QUEUE_PLAN.md.
Add internal claim/lease operations and concurrency tests.
Do not migrate worker execution and do not remove existing lock backends.
```
