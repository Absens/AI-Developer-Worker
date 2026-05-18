# Human Testing Acceptance Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Yandex Tracker tasks in `Тестируется` until a human resolves them, while internal tracker tasks move through a distinct `human_testing` state after the GitLab MR is merged.

**Architecture:** Add `human_testing` as an internal-only task status that maps to logical `review`, so Yandex sync targets the configured review status (`Тестируется`) instead of `done`. GitLab MR merge reconciliation moves internal tasks from `review` to `human_testing`; Yandex import later treats external logical `done` as authoritative acceptance and moves the internal task to `done`. Direct Yandex mode stops marking merged-review issues done and instead records an idempotent "awaiting human testing" status comment.

**Tech Stack:** Node.js, TypeScript, Vitest, Angular console DTOs, Yandex Tracker logical status map, GitLab API v4.

---

## File Structure

- Modify `src/domain/taskTracker/types.ts`
  - Add `human_testing` to the canonical internal status list.
- Modify `src/domain/taskTracker/status.ts`
  - Map `human_testing` to logical `review`.
  - Permit `review -> human_testing` and `human_testing -> done`.
- Modify `src/domain/internalWorkerOrchestrator.ts`
  - Change merged-MR reconciliation from internal `done` to internal `human_testing`.
  - Keep closed/unmerged MR behavior as `awaiting_human`.
- Modify `src/integrations/yandexBridge/bridge.ts`
  - Sync `human_testing` outward as logical `review`.
  - Import external logical `done` back into internal `done`.
  - Keep done digest idempotency.
- Modify `src/domain/orchestrator.ts`
  - In direct Yandex mode, keep merged MR tasks in logical `review` instead of transitioning them to `done`.
  - Add idempotency so repeated polls do not add duplicate "awaiting human testing" comments.
- Modify `src/observability/lifecycleMapping.ts`
  - Map `human_testing` status transitions to waiting/acceptance observability.
- Modify web console status definitions:
  - `web/src/app/models/human-api.dto.ts`
  - `web/src/app/utils/task-ui.ts`
  - `web/src/app/components/task-detail-panel.component.ts`
  - `web/src/app/pages/operations-page.component.ts`
  - `web/e2e/mock-console-server.mjs`
- Modify tests:
  - `tests/taskTrackerCore.test.ts`
  - `tests/internalWorkerOrchestrator.test.ts`
  - `tests/yandexBridge.test.ts`
  - `tests/orchestrator.test.ts`
  - `tests/humanTaskApi.test.ts`
  - `web/src/app/pages/workflow-pages.spec.ts`
- Modify docs:
  - `README.md`
  - `docs/ENV_CONFIGURATION.md`
  - `docs/FLEET_OPERATIONAL_RUNBOOK.md`
  - `config/trackerStatusMap.example.json` only if the `review.statuses` list no longer includes `Тестируется`.

---

### Task 1: Add Internal `human_testing` Status

**Files:**
- Modify: `src/domain/taskTracker/types.ts`
- Modify: `src/domain/taskTracker/status.ts`
- Modify: `src/observability/lifecycleMapping.ts`
- Modify: `tests/taskTrackerCore.test.ts`
- Modify: web console status files listed above

- [ ] **Step 1: Add failing task status tests**

In `tests/taskTrackerCore.test.ts`, extend the imports:

```ts
import {
  FIELD_OWNERSHIP_RULES,
  AgentWorkflowService,
  FieldOwnershipError,
  InMemoryTaskTrackerClient,
  InvalidTaskStatusTransitionError,
  TASK_STATUS_TO_LOGICAL_STATUS,
  canOwnerUpdateFieldGroup,
  canTransitionTaskStatus,
  mapTaskStatusToLogicalStatus,
} from "../src/domain/taskTracker/index.js";
```

Extend the existing `maps internal task statuses to current logical statuses` test:

```ts
it("maps internal task statuses to current logical statuses", () => {
  expect(TASK_STATUS_TO_LOGICAL_STATUS).toMatchObject({
    new: "open",
    triage: "open",
    awaiting_human: "waiting_for_answer",
    implementing: "in_progress",
    review: "review",
    human_testing: "review",
    done: "done",
    failed: "failed",
    cancelled: "failed",
  });
  expect(mapTaskStatusToLogicalStatus("blocked")).toBe("waiting_for_answer");
  expect(mapTaskStatusToLogicalStatus("human_testing")).toBe("review");
});
```

Add this test next to the mapping test:

```ts
it("allows merged review tasks to wait for human testing before completion", () => {
  expect(canTransitionTaskStatus("review", "human_testing")).toBe(true);
  expect(canTransitionTaskStatus("human_testing", "done")).toBe(true);
  expect(canTransitionTaskStatus("human_testing", "awaiting_human")).toBe(true);
  expect(canTransitionTaskStatus("human_testing", "review")).toBe(false);
});
```

- [ ] **Step 2: Run status tests and confirm the red state**

Run:

```powershell
npx vitest run tests/taskTrackerCore.test.ts -t "human testing|logical statuses"
```

Expected: TypeScript or Vitest fails because `human_testing` is not part of `TaskStatus`.

- [ ] **Step 3: Add `human_testing` to the internal status type**

In `src/domain/taskTracker/types.ts`, replace the `TASK_STATUSES` array with:

```ts
export const TASK_STATUSES = [
  "new",
  "triage",
  "ready",
  "claimed",
  "analyzing",
  "awaiting_human",
  "decomposing",
  "implementing",
  "validating",
  "review",
  "human_testing",
  "fixing_review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;
```

- [ ] **Step 4: Map and allow the new status**

In `src/domain/taskTracker/status.ts`, add `human_testing` to `TASK_STATUS_TO_LOGICAL_STATUS`:

```ts
  review: "review",
  human_testing: "review",
  fixing_review: "in_progress",
```

Replace the relevant transition entries with:

```ts
  validating: ["review", "fixing_review", "implementing", "done", "failed", "cancelled"],
  review: ["fixing_review", "human_testing", "done", "awaiting_human", "failed", "cancelled"],
  human_testing: ["done", "awaiting_human", "failed", "cancelled"],
  fixing_review: ["validating", "review", "failed", "cancelled"],
```

- [ ] **Step 5: Map lifecycle observability for `human_testing`**

In `src/observability/lifecycleMapping.ts`, update `typeForStatusTransition`:

```ts
  if (to === "awaiting_human" || to === "blocked" || to === "human_testing") {
    return { observabilityType: "task_waiting", status: to === "human_testing" ? "info" : "warning" };
  }
```

- [ ] **Step 6: Update web DTO and labels**

In `web/src/app/models/human-api.dto.ts`, add the status after `'review'`:

```ts
  | 'review'
  | 'human_testing'
  | 'fixing_review'
```

In `web/src/app/utils/task-ui.ts`, add `human_testing` to `TASK_STATUSES` after `review`:

```ts
  'review',
  'human_testing',
  'fixing_review',
```

Add the Russian label:

```ts
  human_testing: 'Тестируется человеком',
```

Update active/running queue groups by adding `human_testing` wherever `review` is grouped as active:

```ts
statuses: ['ready', 'claimed', 'analyzing', 'awaiting_human', 'implementing', 'validating', 'review', 'human_testing'],
```

Update `statusSeverity` so `human_testing` gets the same non-terminal severity as `review`:

```ts
  if (status === 'ready' || status === 'review' || status === 'human_testing') {
    return 'info';
  }
```

In `web/src/app/components/task-detail-panel.component.ts`, add `human_testing` to `ACTIVE_DETAIL_STATUSES`:

```ts
  'review',
  'human_testing',
  'fixing_review',
```

In `web/src/app/pages/operations-page.component.ts`, add `human_testing` to the visible active status set next to `review`:

```ts
  'review',
  'human_testing',
```

In `web/e2e/mock-console-server.mjs`, include `human_testing` in any hardcoded status arrays that mirror `TASK_STATUSES`.

- [ ] **Step 7: Add a web label test**

In `web/src/app/pages/workflow-pages.spec.ts`, extend the status label test:

```ts
expect(statusLabel('human_testing')).toBe('Тестируется человеком');
```

- [ ] **Step 8: Run focused status checks**

Run:

```powershell
npx vitest run tests/taskTrackerCore.test.ts tests/humanTaskApi.test.ts
npm --prefix web run typecheck
npm --prefix web run test -- --include web/src/app/pages/workflow-pages.spec.ts
```

Expected: all commands exit 0.

---

### Task 2: Change Internal MR Merge Reconciliation To `human_testing`

**Files:**
- Modify: `src/domain/internalWorkerOrchestrator.ts`
- Modify: `tests/internalWorkerOrchestrator.test.ts`

- [ ] **Step 1: Update the failing internal reconciliation test**

In `tests/internalWorkerOrchestrator.test.ts`, rename the merged-MR test:

```ts
it("moves review tasks to human_testing when the latest merge request is merged", async () => {
```

Change the status expectation:

```ts
expect(updated.status).toBe("human_testing");
```

Change the event expectation:

```ts
expect(updated.events).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      kind: "human_testing_started",
      source: "gitlab_sync",
      message: "Merge request is merged; task is waiting for human testing.",
      payload: expect.objectContaining({
        mergeRequestIid: 17,
        mergeRequestUrl: "https://gitlab.example.com/project/-/merge_requests/17",
      }),
    }),
  ]),
);
```

Keep the assertion that Codex does not run:

```ts
expect(codex.initialRuns).toHaveLength(0);
```

- [ ] **Step 2: Run the test and confirm the red state**

Run:

```powershell
npx vitest run tests/internalWorkerOrchestrator.test.ts -t "human_testing|merged"
```

Expected: the merged-MR test fails because the implementation still sets `done` and records `task_completed`.

- [ ] **Step 3: Change merged-MR reconciliation**

In `src/domain/internalWorkerOrchestrator.ts`, replace the merged branch inside `reconcileReviewTask()` with:

```ts
    if (mergeRequest.state === "merged" || mergeRequest.mergedAt) {
      await this.taskTracker.setStatus(
        task.id,
        "human_testing",
        `Merge Request merged; awaiting human testing: ${mergeRequest.url}`,
      );
      await this.workflow.recordLifecycleEvent(task.id, {
        kind: "human_testing_started",
        source: "gitlab_sync",
        actor: { owner: "worker_agent", id: this.config.workerId },
        message: "Merge request is merged; task is waiting for human testing.",
        payload: {
          mergeRequestIid: mergeRequest.iid,
          mergeRequestUrl: mergeRequest.url,
          ...(mergeRequest.mergedAt ? { mergedAt: mergeRequest.mergedAt } : {}),
        },
      });
      await this.syncExternalMirror(task.id);
      return true;
    }
```

Do not change the closed/unmerged branch; it must keep setting `awaiting_human`.

- [ ] **Step 4: Run focused internal tests**

Run:

```powershell
npx vitest run tests/internalWorkerOrchestrator.test.ts
```

Expected: internal reconciliation tests pass, including closed/unmerged MR behavior.

---

### Task 3: Sync `human_testing` To Yandex `Тестируется` And Import Yandex `Решено` Back To Internal `done`

**Files:**
- Modify: `src/integrations/yandexBridge/bridge.ts`
- Modify: `tests/yandexBridge.test.ts`

- [ ] **Step 1: Add a failing sync test for `human_testing`**

In `tests/yandexBridge.test.ts`, add this test near the existing status sync test:

```ts
it("syncs human_testing to external review instead of external done", async () => {
  const source = new FakeYandexSource([issue()]);
  const { bridge, tracker } = createBridge(source);

  await bridge.importCandidates();
  const task = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
  if (!task) {
    throw new Error("Expected imported task.");
  }

  await tracker.setStatus(task.id, "claimed", "Claimed.");
  await tracker.setStatus(task.id, "analyzing", "Analysis started.");
  await tracker.setStatus(task.id, "implementing", "Implementation started.");
  await tracker.setStatus(task.id, "validating", "Validation passed.");
  await tracker.setStatus(task.id, "review", "Merge Request ready.");
  await tracker.setStatus(task.id, "human_testing", "Merge Request merged; awaiting human testing.");

  await bridge.syncTaskStatus(task.id);
  await bridge.syncTaskStatus(task.id);

  expect(source.transitions).toEqual([
    expect.objectContaining({
      externalKey: "DEV-1",
      targetBusinessStatus: "review" satisfies LogicalStatus,
    }),
  ]);
});
```

- [ ] **Step 2: Add a failing import test for external acceptance**

Add this test after the sync test:

```ts
it("marks an internal human_testing task done when Yandex becomes resolved", async () => {
  const source = new FakeYandexSource([issue()]);
  const { bridge, tracker } = createBridge(source);

  await bridge.importCandidates();
  const task = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
  if (!task) {
    throw new Error("Expected imported task.");
  }

  await tracker.setStatus(task.id, "claimed", "Claimed.");
  await tracker.setStatus(task.id, "analyzing", "Analysis started.");
  await tracker.setStatus(task.id, "implementing", "Implementation started.");
  await tracker.setStatus(task.id, "validating", "Validation passed.");
  await tracker.setStatus(task.id, "review", "Merge Request ready.");
  await tracker.setStatus(task.id, "human_testing", "Merge Request merged; awaiting human testing.");

  source.snapshots = [
    issueToSnapshot(
      issue({
        logicalStatus: "done",
        statusKey: "resolved",
        statusDisplay: "Решено",
        updatedAt: "2026-04-28T11:00:00.000Z",
      }),
      "2026-04-28T11:00:00.000Z",
    ),
  ];

  await bridge.importCandidates();

  const updated = await tracker.getTask(task.id);
  expect(updated.status).toBe("done");
  expect(updated.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "task_completed",
        source: "external_source",
        message: "External Yandex task is resolved; internal task marked done.",
        payload: expect.objectContaining({
          provider: YANDEX_TRACKER_PROVIDER,
          externalKey: "DEV-1",
          externalBusinessStatus: "done",
        }),
      }),
    ]),
  );
});
```

- [ ] **Step 3: Run Yandex bridge tests and confirm the red state**

Run:

```powershell
npx vitest run tests/yandexBridge.test.ts -t "human_testing|resolved"
```

Expected: tests fail until `human_testing` exists and external `done` import updates internal status.

- [ ] **Step 4: Keep status sync generic through logical mapping**

After Task 1, `syncTaskStatus()` already computes:

```ts
const targetBusinessStatus = mapTaskStatusToLogicalStatus(task.status);
```

No special case is needed for outbound `human_testing`; the `TaskStatus -> LogicalStatus` mapping must be the only source of truth.

- [ ] **Step 5: Add external done reconciliation to imports**

In `src/integrations/yandexBridge/bridge.ts`, add this helper near `applySnapshotUpdates()`:

```ts
  private async applyExternalAcceptance(
    task: TaskRecord,
    snapshot: ExternalIssueSnapshot,
  ): Promise<TaskRecord> {
    if (
      snapshot.businessStatus !== "done" ||
      task.status === "done" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      return task;
    }

    await this.options.taskTracker.setStatus(
      task.id,
      "done",
      "External Yandex task is resolved; internal task marked done.",
    );
    await this.options.taskTracker.appendEvent(task.id, {
      kind: "task_completed",
      source: "external_source",
      actor: EXTERNAL_ACTOR,
      message: "External Yandex task is resolved; internal task marked done.",
      payload: {
        provider: snapshot.provider,
        externalKey: snapshot.externalKey,
        externalBusinessStatus: snapshot.businessStatus,
      },
      createdAt: this.now().toISOString(),
    });
    return this.options.taskTracker.getTask(task.id);
  }
```

At the end of `applySnapshotUpdates()`, replace:

```ts
    return updated;
```

with:

```ts
    return this.applyExternalAcceptance(updated, snapshot);
```

- [ ] **Step 6: Update the existing done idempotency test**

In `tests/yandexBridge.test.ts`, keep the existing done idempotency test, but drive the new flow through `human_testing` before `done`:

```ts
await tracker.setStatus(claim.task.id, "review", "Merge Request ready.");
await tracker.setStatus(claim.task.id, "human_testing", "Merge Request merged; awaiting human testing.");
await tracker.setStatus(claim.task.id, "done", "External Yandex task is resolved; internal task marked done.");
```

Expected assertions remain:

```ts
expect(doneDigests).toHaveLength(1);
expect(doneTransitions).toEqual([
  expect.objectContaining({
    externalKey: "DEV-1",
    targetBusinessStatus: "done" satisfies LogicalStatus,
  }),
]);
```

- [ ] **Step 7: Run Yandex bridge tests**

Run:

```powershell
npx vitest run tests/yandexBridge.test.ts
```

Expected: Yandex bridge tests pass and there is no duplicate done digest.

---

### Task 4: Keep Direct Yandex Review Tasks In `Тестируется` After MR Merge

**Files:**
- Modify: `src/domain/orchestrator.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Update merged-review orchestrator expectations**

In `tests/orchestrator.test.ts`, update the merged MR review test so no external transition to `done` is expected. The issue is already in logical `review`, so the worker should leave the Yandex status unchanged and add a single status comment.

Use assertions with this shape:

```ts
expect(tracker.transitions).not.toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      issueKey: "DEV-MERGED",
      target: "done",
    }),
  ]),
);
expect(tracker.comments.at(-1)?.text).toContain("awaiting human testing");
expect(tracker.comments.at(-1)?.text).toContain(mrUrl);
expect(codex.initialRuns).toHaveLength(0);
expect(gitlab.discussionLookups).toBe(0);
```

Add an idempotency assertion by running `runOnce()` a second time with the status comment present:

```ts
const secondOutcome = await orchestrator.runOnce();
expect(secondOutcome).toBe("idle");
expect(tracker.comments.filter((comment) => comment.text.includes("awaiting human testing"))).toHaveLength(1);
```

- [ ] **Step 2: Run the focused review test and confirm the red state**

Run:

```powershell
npx vitest run tests/orchestrator.test.ts -t "merged"
```

Expected: test fails because `finalizeMergedReview()` still transitions external Yandex issues to `done`.

- [ ] **Step 3: Add an idempotency helper**

In `src/domain/orchestrator.ts`, add this method near `finalizeMergedReview()`:

```ts
  private hasMergedReviewAwaitingHumanTestingComment(
    comments: CommentWithMetadata[],
    mergeRequest: MergeRequestInfo,
  ): boolean {
    return comments.some((comment) => {
      const metadata = comment.metadata;
      return (
        metadata?.kind === "AI STATUS" &&
        metadata.worker === this.config.workerId &&
        metadata.state === "review" &&
        typeof metadata.details === "string" &&
        metadata.details.includes("awaiting human testing") &&
        metadata.details.includes(mergeRequest.url)
      );
    });
  }
```

- [ ] **Step 4: Replace external merged-review finalization**

Replace `finalizeMergedReview()` with:

```ts
  private async finalizeMergedReview(
    issue: TrackerIssue,
    branch: string,
    mergeRequest: MergeRequestInfo,
    comments: CommentWithMetadata[],
  ): Promise<"processed" | "idle"> {
    if (this.hasMergedReviewAwaitingHumanTestingComment(comments, mergeRequest)) {
      return "idle";
    }

    await this.tracker.addComment(
      issue.key,
      formatStatusComment(
        this.config.workerId,
        "review",
        `Merge Request merged; awaiting human testing in Yandex: ${mergeRequest.url}`,
      ),
    );
    this.telemetry.recordEvent({
      workerId: this.config.workerId,
      repositoryName: this.repositoryName(),
      issueKey: issue.key,
      branch,
      mergeRequestUrl: mergeRequest.url,
      mergeRequestIid: mergeRequest.iid,
      type: "task_waiting",
      status: "info",
      message: "Merge request is merged; task is waiting for human testing.",
      details: {
        mergeRequestState: mergeRequest.state,
        mergedAt: mergeRequest.mergedAt,
      },
    });
    this.terminalOutcomes.set(issue.key, {
      outcome: "waiting",
      message: "Merge request is merged; task is waiting for human testing.",
      branch,
      mergeRequestUrl: mergeRequest.url,
      mergeRequestIid: mergeRequest.iid,
    });
    return "processed";
  }
```

Update the merged branch in `handleReviewFeedback()`:

```ts
    if (resolution.outcome === "merged") {
      return this.finalizeMergedReview(
        issue,
        resolution.branch,
        resolution.mergeRequest,
        comments,
      );
    }
```

- [ ] **Step 5: Run direct orchestrator tests**

Run:

```powershell
npx vitest run tests/orchestrator.test.ts -t "review|merged|closed"
npx vitest run tests/orchestrator.test.ts
```

Expected: merged MR issues stay in their existing logical `review` status, closed MRs still go to `waiting_for_answer`, and opened MR review-fix behavior remains unchanged.

---

### Task 5: Update Documentation And Configuration Guidance

**Files:**
- Modify: `README.md`
- Modify: `docs/ENV_CONFIGURATION.md`
- Modify: `docs/FLEET_OPERATIONAL_RUNBOOK.md`
- Inspect: `config/trackerStatusMap.example.json`

- [ ] **Step 1: Update review lifecycle docs**

Replace the existing review finalization wording in `README.md` and `docs/ENV_CONFIGURATION.md` with:

```md
### Review task finalization

When a task is in logical `review`, the worker periodically checks the associated GitLab merge request. If GitLab reports the MR as merged, the worker treats that as code-delivery evidence, not human acceptance. In direct Yandex mode, the external issue remains in logical `review`; configure that logical status to the Yandex status `Тестируется`. In internal-tracker mode, the task moves to `human_testing`, which also syncs to external logical `review`. The internal task moves to `done` only after the external Yandex task is manually resolved.

If the MR is closed without merge, the task moves to a human hold state instead of being marked complete. Open MRs keep the existing unresolved review discussion handling.
```

- [ ] **Step 2: Update operational recovery docs**

In `docs/FLEET_OPERATIONAL_RUNBOOK.md`, replace the review recovery paragraph with:

```md
When a task is in logical `review`, the worker reconciles the stored GitLab merge request before claiming new implementation work. A merged MR moves internal tasks to `human_testing` and keeps Yandex in `Тестируется`; it does not mark the task resolved. A human resolving the Yandex task is the acceptance signal that moves the internal task to `done`.
```

Keep the checklist, and add this item:

```md
5. The `review` logical status in `TRACKER_STATUS_MAP_FILE` includes the Yandex status `Тестируется`.
```

- [ ] **Step 3: Verify tracker status map guidance**

Inspect `config/trackerStatusMap.example.json`. The `review.statuses` array must include `Тестируется`:

```json
"review": {
  "statuses": ["inReview", "Ревью", "testing", "test", "Тестируется", "На тестировании"],
  "transition": "inReview"
}
```

If the entry is already present, do not modify the file.

- [ ] **Step 4: Run docs search**

Run:

```powershell
rg -n "human_testing|Тестируется|Review task finalization|closed without merge|AI MR" README.md docs config/trackerStatusMap.example.json
```

Expected: docs mention that `review` maps to `Тестируется`, `human_testing` waits for human acceptance, and closed/unmerged MRs are not done.

---

### Task 6: Final Verification

**Files:**
- Read: all modified files

- [ ] **Step 1: Run focused backend tests**

Run:

```powershell
npx vitest run tests/taskTrackerCore.test.ts tests/internalWorkerOrchestrator.test.ts tests/yandexBridge.test.ts tests/orchestrator.test.ts tests/humanTaskApi.test.ts
```

Expected: all focused backend tests pass.

- [ ] **Step 2: Run web type and label checks**

Run:

```powershell
npm --prefix web run typecheck
npm --prefix web run test -- --include web/src/app/pages/workflow-pages.spec.ts
```

Expected: Angular typecheck passes and workflow page status-label tests pass.

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

- [ ] **Step 4: Manual smoke with Yandex `Тестируется` and `Решено`**

Use a sandbox Yandex issue and GitLab MR:

1. Let the worker publish a task and sync it to Yandex logical `review`.
2. Confirm the Yandex issue status is `Тестируется`.
3. Merge the GitLab MR.
4. Run one worker cycle.
5. Confirm the Yandex issue remains `Тестируется`.
6. Confirm the internal task is `human_testing` when using internal tracker mode.
7. Manually move the Yandex issue to `Решено`.
8. Run one worker import/sync cycle.
9. Confirm the internal task becomes `done`.
10. Confirm no Codex implementation run starts during the acceptance sync cycle.

Expected: Yandex never moves to `Решено` automatically after MR merge; internal `done` follows the human resolution in Yandex.

---

## Acceptance Criteria

- [ ] A merged GitLab MR no longer moves a Yandex Tracker task directly to `done`.
- [ ] Yandex Tracker remains in logical `review`, configured as `Тестируется`, after MR merge.
- [ ] Internal review tasks move to `human_testing` after MR merge.
- [ ] `human_testing` syncs to external logical `review`, not external logical `done`.
- [ ] External Yandex logical `done` (`Решено`) moves the internal task to `done`.
- [ ] Closed but unmerged MRs still move tasks to human hold.
- [ ] Open MRs keep the existing unresolved-review-discussion behavior.
- [ ] Repeated worker cycles do not duplicate "awaiting human testing" comments or done digests.
- [ ] Human API and web console understand and display `human_testing`.
- [ ] Full verification passes with backend tests, web typecheck, `npm run typecheck`, `npm test`, and `npm run build`.
