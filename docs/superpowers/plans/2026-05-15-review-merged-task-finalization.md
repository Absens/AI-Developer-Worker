# Review Merged Task Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically move tasks out of `review` when their GitLab merge request has already been merged.

**Architecture:** Treat GitLab merge request lifecycle as the source of truth after a task reaches `review`. Extend the GitLab adapter so workers can read merged and closed MRs, then add idempotent reconciliation paths in both Yandex Tracker mode and the internal task tracker mode. A merged MR finalizes the task as `done`; a closed but unmerged MR is held for human action; an opened MR keeps the existing review-fix behavior.

**Tech Stack:** Node.js, TypeScript, Vitest, GitLab API v4, existing Yandex Tracker and internal task tracker adapters.

---

## Current Behavior

- `WorkerOrchestrator` publishes work by creating or reusing an opened GitLab MR, then moves the external Tracker issue to logical `review`.
- When an external issue is already in `review`, `handleReviewFeedback()` calls `resolveReviewMergeRequest()`.
- `resolveReviewMergeRequest()` only calls `gitlab.findOpenMergeRequestByBranch(branch)`.
- If the MR was already merged, GitLab no longer returns it in the opened MR search, so the worker cannot distinguish "merged and done" from "missing MR".
- Internal tracker tasks are moved to `review` after MR publication, but `claimNextTask()` only claims `ready` and `claimed` tasks. Internal `review` tasks therefore need a separate reconciliation pass.
- Internal `merge_request_records` store MR JSON, branch, outcome, and validation summary, but do not persist a normalized MR lifecycle state.

## Design Decisions

- Use polling reconciliation, not GitLab webhooks. This matches the current worker poll model and avoids adding infrastructure.
- A GitLab MR with `state === "merged"` is authoritative evidence that the task is solved.
- A GitLab MR with `state === "closed"` and no merge evidence is not treated as done. Move the task to a human-visible hold state.
- Keep the current opened-MR review-fix behavior unchanged for unresolved reviewer discussions.
- Make finalization idempotent. Re-running the worker after a task is already `done` must not create duplicate work or fail the cycle.
- Do not add a feature flag for the main behavior. A merged MR for a `review` task is a terminal fact, not an optional workflow variant.

## File Structure

- Modify `src/models/types.ts`
  - Add optional MR lifecycle fields to `MergeRequestInfo`.
  - Add GitLab read methods for all-state branch lookup and IID lookup.
- Modify `src/integrations/gitlab/client.ts`
  - Parse MR `state`, `merged_at`, `closed_at`, and `updated_at`.
  - Implement all-state MR lookup by branch.
  - Implement MR lookup by IID.
  - Keep `findOpenMergeRequestByBranch()` as a compatibility wrapper.
- Modify `src/integrations/tracker/commentProtocol.ts`
  - Store optional MR IID in `AI MR` comments.
  - Parse legacy MR URLs to recover IID when structured metadata is missing it.
- Modify `src/domain/orchestrator.ts`
  - Resolve review MRs from IID, legacy URL, then branch.
  - Finalize `review -> done` when the MR is merged.
  - Move closed/unmerged review MRs to `waiting_for_answer` with a clear comment.
- Modify `src/domain/internalWorkerOrchestrator.ts`
  - Add a review reconciliation pass before normal task claiming.
  - Finalize internal `review -> done` when the latest recorded MR is merged.
  - Call existing external mirror sync so Yandex-backed internal tasks move to logical `done`.
- Modify tests:
  - `tests/gitlabClient.test.ts`
  - `tests/commentProtocol.test.ts`
  - `tests/orchestrator.test.ts`
  - `tests/worker.smoke.test.ts` or a new focused internal-worker test file
  - `tests/yandexBridge.test.ts` if the done-sync assertion is broadened
- Modify docs:
  - `docs/ENV_CONFIGURATION.md`
  - `docs/FLEET_OPERATIONAL_RUNBOOK.md`
  - `README.md` if the worker lifecycle section mentions review behavior

---

### Task 1: Extend GitLab MR Lifecycle Reads

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/integrations/gitlab/client.ts`
- Modify: `tests/gitlabClient.test.ts`

- [ ] **Step 1: Add failing GitLab client tests**

Add tests that cover:

```ts
it("finds merged merge requests by source branch", async () => {
  // Mock GET /merge_requests?state=all&source_branch=feature%2F...
  // Return one MR with state: "merged", merged_at, closed_at: null.
  // Expect findMergeRequestByBranch(branch) to return state "merged" and mergedAt.
});

it("keeps opened lookup limited to opened merge requests", async () => {
  // Mock GET /merge_requests?state=opened&source_branch=feature%2F...
  // Expect findOpenMergeRequestByBranch(branch) to keep current behavior.
});

it("loads a merge request by iid", async () => {
  // Mock GET /merge_requests/17.
  // Expect getMergeRequest(17) to return iid, sourceBranch, targetBranch, state.
});
```

Run:

```powershell
npx vitest run tests/gitlabClient.test.ts
```

Expected: tests fail until the adapter methods and lifecycle fields exist.

- [ ] **Step 2: Extend shared MR types**

In `src/models/types.ts`, extend `MergeRequestInfo` with optional lifecycle fields:

```ts
export type MergeRequestState = "opened" | "merged" | "closed" | (string & {});

export interface MergeRequestInfo {
  id: number;
  iid: number;
  url: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state?: MergeRequestState;
  mergedAt?: string;
  closedAt?: string;
  updatedAt?: string;
}
```

Extend `GitLabService` without breaking current callers:

```ts
findMergeRequestByBranch(sourceBranch: string): Promise<MergeRequestInfo | null>;
getMergeRequest(iid: number): Promise<MergeRequestInfo | null>;
```

- [ ] **Step 3: Parse lifecycle fields in GitLab adapter**

In `src/integrations/gitlab/client.ts`, add these optional fields to `GitLabMergeRequestResponse`:

```ts
state?: string;
merged_at?: string | null;
closed_at?: string | null;
updated_at?: string;
```

Update `toMergeRequestInfo()` so it copies non-empty lifecycle fields into `MergeRequestInfo`.

- [ ] **Step 4: Add all-state and IID lookup methods**

Implement `findMergeRequestByBranch(sourceBranch)` with:

```ts
query: {
  state: "all",
  source_branch: sourceBranch,
  order_by: "updated_at",
  sort: "desc",
}
```

Keep `findOpenMergeRequestByBranch(sourceBranch)` using `state: "opened"`.

Implement `getMergeRequest(iid)` using:

```ts
`/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests/${iid}`
```

Return `null` only for a GitLab `404`. Keep other non-OK responses as errors.

- [ ] **Step 5: Run GitLab tests**

Run:

```powershell
npx vitest run tests/gitlabClient.test.ts
```

Expected: GitLab client tests pass.

---

### Task 2: Persist And Recover MR IID In Tracker Metadata

**Files:**
- Modify: `src/integrations/tracker/commentProtocol.ts`
- Modify: `src/domain/orchestrator.ts`
- Modify: `tests/commentProtocol.test.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Add failing comment protocol tests**

Add tests for:

```ts
formatMergeRequestComment("worker-1", "https://gitlab/project/-/merge_requests/17", "feature/x", 17)
```

Expected parsed metadata:

```ts
{
  kind: "AI MR",
  worker: "worker-1",
  url: "https://gitlab/project/-/merge_requests/17",
  branch: "feature/x",
  mergeRequestIid: 17
}
```

Also add a legacy parser test where the JSON has only `url` and `branch`, and the parser recovers `mergeRequestIid: 17` from `/merge_requests/17`.

- [ ] **Step 2: Extend `AI MR` payload**

Update `formatMergeRequestComment()` to accept an optional `mergeRequestIid?: number` and include it in the structured JSON when available.

Update `parseStructuredServiceComment()` for `AI MR`:

- Read `mergeRequestIid` from JSON when present.
- If missing, parse it from URL patterns:

```text
/-/merge_requests/17
/merge_requests/17
```

- Keep comments without an IID valid for backward compatibility.

- [ ] **Step 3: Store IID when publishing**

In `WorkerOrchestrator.finalizeSuccess()`, call:

```ts
formatMergeRequestComment(
  this.config.workerId,
  mergeRequest.url,
  branch,
  mergeRequest.iid,
)
```

Update any tests expecting the exact comment shape.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npx vitest run tests/commentProtocol.test.ts tests/orchestrator.test.ts
```

Expected: tests pass after metadata is backward compatible.

---

### Task 3: Finalize Merged Review Tasks In Yandex Tracker Mode

**Files:**
- Modify: `src/domain/orchestrator.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Add failing orchestrator tests**

Add a test for a `review` issue with an `AI MR` comment and a GitLab MR whose state is `merged`.

Expected behavior:

- `runOnce()` returns `"processed"`.
- No Codex run starts.
- No review discussion lookup is required after merged state is known.
- Tracker transitions include `{ target: "done" }`.
- Added comments include `AI STATUS` with state `"done"` and the MR URL.
- Telemetry terminal outcome is success, not failure.

Add a second test for `state === "closed"` without `mergedAt`.

Expected behavior:

- Tracker transitions to `waiting_for_answer`.
- Comment explains that the MR was closed without being merged.
- Task is not marked `done`.

- [ ] **Step 2: Replace open-only review resolution**

Replace `resolveReviewMergeRequest()` with a lifecycle-aware resolver that returns a union:

```ts
type ReviewMergeRequestResolution =
  | { outcome: "opened"; branch: string; mergeRequest: MergeRequestInfo }
  | { outcome: "merged"; branch: string; mergeRequest: MergeRequestInfo }
  | { outcome: "closed"; branch: string; mergeRequest: MergeRequestInfo }
  | { outcome: "missing"; branch: string };
```

Resolve in this order:

1. Latest `AI MR` metadata IID, if present: `gitlab.getMergeRequest(iid)`.
2. Latest `AI MR` branch: `gitlab.findMergeRequestByBranch(branch)`.
3. Default branch name: `feature/ai-task-${issue.key}`.

Treat `mergeRequest.state === "merged"` or non-empty `mergeRequest.mergedAt` as `merged`.
Treat `mergeRequest.state === "closed"` with no merge evidence as `closed`.
Treat missing `state` as `opened` only when the MR came from `findOpenMergeRequestByBranch()` or the API response lacks lifecycle fields.

- [ ] **Step 3: Add finalization helpers**

Add `finalizeMergedReview()`:

```ts
private async finalizeMergedReview(
  issue: TrackerIssue,
  branch: string,
  mergeRequest: MergeRequestInfo,
): Promise<void> {
  await this.tracker.transition(issue.key, "done");
  await this.tracker.addComment(
    issue.key,
    formatStatusComment(
      this.config.workerId,
      "done",
      `Merge Request merged: ${mergeRequest.url}`,
    ),
  );
  this.telemetry.recordEvent({
    workerId: this.config.workerId,
    repositoryName: this.repositoryName(),
    issueKey: issue.key,
    branch,
    mergeRequestUrl: mergeRequest.url,
    mergeRequestIid: mergeRequest.iid,
    type: "task_completed",
    status: "info",
    message: "Merge request is merged; task marked done.",
    details: {
      mergeRequestState: mergeRequest.state,
      mergedAt: mergeRequest.mergedAt,
    },
  });
  this.terminalOutcomes.set(issue.key, {
    outcome: "success",
    message: "Merge request is merged; task marked done.",
    branch,
    mergeRequestUrl: mergeRequest.url,
    mergeRequestIid: mergeRequest.iid,
  });
}
```

Add `pauseClosedReview()` that transitions to `waiting_for_answer` with a status comment explaining the closed/unmerged MR.

- [ ] **Step 4: Route review handling by lifecycle**

At the start of `handleReviewFeedback()`:

```ts
const resolution = await this.resolveReviewMergeRequest(issue, comments);
if (resolution.outcome === "merged") {
  await this.finalizeMergedReview(issue, resolution.branch, resolution.mergeRequest);
  return "processed";
}
if (resolution.outcome === "closed" || resolution.outcome === "missing") {
  await this.pauseReviewForHuman(issue, resolution);
  return "waiting";
}
```

Only call `findPendingReviewDiscussions()` for `outcome === "opened"`.

- [ ] **Step 5: Run orchestrator tests**

Run:

```powershell
npx vitest run tests/orchestrator.test.ts -t "review"
npx vitest run tests/orchestrator.test.ts
```

Expected: merged review finalization passes and existing review-fix behavior remains unchanged.

---

### Task 4: Reconcile Internal Tracker Review Tasks

**Files:**
- Modify: `src/domain/internalWorkerOrchestrator.ts`
- Modify: `src/domain/taskTracker/types.ts` only if a new event kind/type is needed
- Add or modify: `tests/internalWorkerOrchestrator.test.ts`
- Modify: `tests/worker.smoke.test.ts` if smoke coverage is preferred over a new unit test

- [ ] **Step 1: Add focused internal reconciliation tests**

Create a test with:

- Internal task in `review`.
- Latest `mergeRequests` record with branch and `mergeRequest.iid`.
- Fake GitLab service returns the MR as `state: "merged"`.

Expected behavior:

- `InternalWorkerOrchestrator.runOnce()` returns `"processed"`.
- Task status becomes `done`.
- Task event list contains a clear completion event.
- No Codex implementation run starts.
- Normal `ready` task claiming still works when no review task can be finalized.

Add a closed/unmerged test:

- GitLab returns `state: "closed"`, no `mergedAt`.
- Task moves from `review` to `awaiting_human`.
- Message explains that the MR was closed without merge.

- [ ] **Step 2: Add reconciliation before claiming work**

In `InternalWorkerOrchestrator.runOnce()` after `importExternalTasks()` and before `recordInternalQueueMetrics()` or before `claimTask()`, call:

```ts
const reconciled = await this.reconcileReviewTasks();
if (reconciled > 0) {
  return "processed";
}
```

Use a small batch limit, for example:

```ts
await this.taskTracker.listTasks({ statuses: ["review"], limit: 50 })
```

- [ ] **Step 3: Resolve latest internal MR**

For each `review` task:

1. Find the latest `task.mergeRequests` by `createdAt`.
2. Match `task.repositoryName` to `InternalExecutionContext`.
3. Call `context.gitlab.getMergeRequest(latest.mergeRequest.iid)` when IID is available.
4. Fallback to `context.gitlab.findMergeRequestByBranch(latest.branch)`.
5. Skip the task if GitLab still reports `opened`.

- [ ] **Step 4: Mark merged internal tasks done**

When MR is merged:

```ts
await this.taskTracker.setStatus(
  task.id,
  "done",
  `Merge Request merged: ${mergeRequest.url}`,
);
await this.workflow.recordLifecycleEvent(task.id, {
  kind: "task_completed",
  source: "gitlab_sync",
  actor: { owner: "worker_agent", id: this.config.workerId },
  message: "Merge request is merged; task marked done.",
  payload: {
    mergeRequestIid: mergeRequest.iid,
    mergeRequestUrl: mergeRequest.url,
    mergedAt: mergeRequest.mergedAt,
  },
});
await this.syncExternalMirror(task.id);
```

This reuses existing Yandex bridge behavior: `exportTaskDigests()` emits a `done` digest and `syncTaskStatus()` maps internal `done` to external logical `done`.

- [ ] **Step 5: Hold closed/unmerged internal tasks**

When MR is closed without merge:

```ts
await this.taskTracker.setStatus(
  task.id,
  "awaiting_human",
  `Merge Request was closed without merge: ${mergeRequest.url}`,
);
await this.workflow.recordLifecycleEvent(task.id, {
  kind: "manual_hold",
  source: "gitlab_sync",
  actor: { owner: "worker_agent", id: this.config.workerId },
  message: "Merge request was closed without merge; human decision required.",
  payload: {
    mergeRequestIid: mergeRequest.iid,
    mergeRequestUrl: mergeRequest.url,
    closedAt: mergeRequest.closedAt,
  },
});
await this.syncExternalMirror(task.id);
```

This uses the existing allowed transition `review -> awaiting_human`.

- [ ] **Step 6: Avoid blocking normal work on transient GitLab errors**

If a reconciliation lookup throws `TemporaryIntegrationError`, log it and leave the task in `review`. Do not fail unrelated ready tasks in the same poll cycle.

If all review tasks fail lookup due temporary errors, continue to normal claim processing.

- [ ] **Step 7: Run internal tests**

Run:

```powershell
npx vitest run tests/internalWorkerOrchestrator.test.ts
npx vitest run tests/worker.smoke.test.ts
```

Expected: review reconciliation passes and existing smoke tests still publish MRs to `review`.

---

### Task 5: Keep External Yandex Sync Idempotent

**Files:**
- Modify: `tests/yandexBridge.test.ts` if coverage is missing
- Modify: `src/integrations/yandexBridge/bridge.ts` only if tests reveal a gap

- [ ] **Step 1: Add or extend done-sync coverage**

Extend the existing `exports digest comments idempotently and syncs status` test or add a new test:

```ts
await tracker.setStatus(claim.task.id, "validating", "Validation passed.");
await tracker.setStatus(claim.task.id, "review", "Merge Request ready.");
await tracker.setStatus(claim.task.id, "done", "Merge Request merged.");
await bridge.exportTaskDigests(claim.task.id);
await bridge.syncTaskStatus(claim.task.id);
await bridge.exportTaskDigests(claim.task.id);
await bridge.syncTaskStatus(claim.task.id);
```

Expected:

- Exactly one `done` digest is exported for the task update.
- Exactly one external status transition to logical `done` is recorded for the same target status.

- [ ] **Step 2: Fix only if needed**

If the test fails, adjust `YandexBridge.exportTaskDigests()` or `syncTaskStatus()` so `done` export and status sync remain idempotent through the existing store keys.

- [ ] **Step 3: Run Yandex bridge tests**

Run:

```powershell
npx vitest run tests/yandexBridge.test.ts
```

Expected: Yandex bridge idempotency tests pass.

---

### Task 6: Observability And Human API Surface

**Files:**
- Modify: `src/observability/taskTrackerHumanApi.ts` only if MR lifecycle fields should be exposed in summaries
- Modify: `web/src/app/services/task-mappers.ts` only if API summary adds fields
- Modify: `web/src/app/models/human-api.dto.ts` only if API summary adds fields
- Modify: `docs/OBSERVABILITY_RUNBOOK.md` if runbook mentions terminal task states

- [ ] **Step 1: Decide API exposure**

For the first implementation, keep UI changes minimal:

- Existing status label already renders `done` as `Завершена`.
- Existing summary already exposes `mergeRequestUrl`.
- Lifecycle details can be visible through task events.

Add `mergeRequestState`, `mergedAt`, and `closedAt` to task summaries only if operators need to filter or audit these values in the queue page.

- [ ] **Step 2: Add task events**

Use existing event kinds where possible:

- `task_completed` for merged MR finalization.
- `manual_hold` for closed/unmerged MR.
- `external_status_synced` is already emitted by Yandex bridge.

Avoid adding new event kinds unless tests or UI code require a narrow `mr_merged` event.

- [ ] **Step 3: Run API/UI tests if changed**

Run only when API or web DTOs changed:

```powershell
npx vitest run tests/humanTaskApi.test.ts
npm --prefix web run test
npm --prefix web run typecheck
```

Expected: human API and web type checks pass.

---

### Task 7: Documentation

**Files:**
- Modify: `docs/ENV_CONFIGURATION.md`
- Modify: `docs/FLEET_OPERATIONAL_RUNBOOK.md`
- Modify: `README.md`

- [ ] **Step 1: Document the review lifecycle**

Add a concise section:

```md
### Review task finalization

When a task is in logical `review`, the worker periodically checks the associated GitLab merge request. If GitLab reports the MR as merged, the worker treats that as authoritative completion evidence and moves the task to `done`. If the MR is closed without merge, the task moves to a human hold state instead of being marked complete.
```

- [ ] **Step 2: Document operational recovery**

In the operational runbook, add:

```md
If tasks remain in `review` after humans merge their MRs, check:

1. The task has an `AI MR` comment or internal `merge_request_records` entry.
2. The GitLab token can read merged and closed MRs, not only opened MRs.
3. The MR source branch or IID still matches the stored task metadata.
4. The worker poll loop is running for the repository profile that owns the task.
```

- [ ] **Step 3: Run docs search**

Run:

```powershell
rg -n "review task finalization|merged|closed without merge|AI MR" README.md docs
```

Expected: the behavior is discoverable from docs and runbooks.

---

### Task 8: Final Verification

**Files:**
- Read: all modified files

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npx vitest run tests/gitlabClient.test.ts tests/commentProtocol.test.ts tests/orchestrator.test.ts tests/yandexBridge.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run internal tracker tests**

Run:

```powershell
npx vitest run tests/taskTrackerCore.test.ts tests/taskTrackerQueue.test.ts tests/humanTaskApi.test.ts tests/worker.smoke.test.ts
```

Expected: internal tracker behavior and smoke paths pass.

- [ ] **Step 3: Run full repository verification**

Run:

```powershell
npm run typecheck
npm test
npm run build
```

Expected:

```text
typecheck exits 0
vitest exits 0
build exits 0
```

- [ ] **Step 4: Manual smoke with a merged MR**

Use a sandbox task and MR:

1. Let the worker publish a task to `review`.
2. Merge the MR in GitLab.
3. Run one worker cycle.
4. Confirm the Tracker or internal task status becomes `done`.
5. Confirm no Codex implementation run starts during the finalization cycle.

Expected: the worker only reconciles status and records completion evidence.

---

## Acceptance Criteria

- [ ] A Yandex Tracker task in logical `review` with a merged GitLab MR moves to logical `done`.
- [ ] An internal task in `review` with a merged GitLab MR moves to `done`.
- [ ] Closed but unmerged MRs do not mark tasks done; they move to a human-visible hold state.
- [ ] Open MRs keep the existing unresolved-review-discussion handling.
- [ ] Legacy `AI MR` comments without structured IID still work through URL or branch fallback.
- [ ] New `AI MR` comments include MR IID for reliable future lookup.
- [ ] Reconciliation is idempotent across repeated poll cycles.
- [ ] Yandex-backed internal tasks export a done digest and sync external status to logical `done`.
- [ ] Full verification passes with `npm run typecheck`, `npm test`, and `npm run build`.
