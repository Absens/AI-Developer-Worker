# Internal Review Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Internal tracker mode must pick `review` tasks with unresolved GitLab MR reviewer discussions, fix the feedback, push a new commit, reply in GitLab, record processed metadata, and return the task to `review`.

**Architecture:** Reuse the existing review-feedback behavior from the Yandex-only `WorkerOrchestrator`, but move shared discussion filtering and reply formatting into a small domain helper. Add an explicit leased review claim path that atomically moves a task from `review` to `fixing_review`, so multiple workers cannot process the same MR thread concurrently. Wire the internal worker reconciliation loop to handle opened MRs with pending feedback before falling through to normal ready-task claiming.

**Tech Stack:** TypeScript ES modules, Vitest, internal task tracker abstractions, PostgreSQL tracker storage, GitLab REST adapter, existing Codex runner and quality gate services.

---

## Current Root Cause

The running container uses `TASK_TRACKER_PROVIDER=internal`. In this mode:

- `InternalWorkerOrchestrator.runOnce()` calls `reconcileReviewTasks()` before normal claiming.
- `reconcileReviewTask()` only handles `merged` and `closed` MRs.
- Opened MRs return `false`; GitLab discussions are never fetched.
- `claimNextTask()` only selects `ready` and `claimed`, so a `review` task is never picked by the normal claim path.

The observed task `yt_FRONTEND-1996` is in `review`, has MR IID `894`, and GitLab has an unresolved reviewer `DiffNote`. The system does not act because internal mode lacks the opened-MR review-fix path.

## File Structure

- Create `src/domain/reviewFeedback.ts`
  - Owns shared review discussion filtering, metadata merging, latest metadata lookup, and GitLab reply body formatting.
  - Has no tracker-specific dependency; accepts `GitLabService`, `ReviewMetadata`, and MR identifiers.

- Create `tests/reviewFeedback.test.ts`
  - Verifies the helper treats discussion-level `resolved` correctly, filters out current-user notes, keeps reviewer notes, skips processed note ids, and formats reply text.

- Modify `src/domain/orchestrator.ts`
  - Replace duplicated private review helpers with imports from `reviewFeedback.ts`.
  - Keep existing Yandex-only behavior unchanged.

- Modify `src/domain/taskTracker/types.ts`
  - Add `ClaimReviewTaskInput`.
  - Add `claimReviewTask(input: ClaimReviewTaskInput): Promise<ClaimedTask | null>` to `TaskTrackerClient`.

- Modify `src/domain/taskTracker/index.ts`
  - Export `ClaimReviewTaskInput` so internal worker code can import it through the existing task tracker barrel.

- Modify `src/domain/taskTracker/status.ts`
  - Allow `fixing_review -> awaiting_human` so Codex clarification requests during review-fix do not fail the task.

- Modify `src/domain/taskTracker/agentWorkflowService.ts`
  - Add `claimReviewTask()` wrapper with validation.

- Modify `src/domain/taskTracker/inMemoryTaskTracker.ts`
  - Implement atomic in-memory review claim: eligible `review` task -> leases -> `fixing_review`.

- Modify `src/integrations/internalTracker/postgresTaskTracker.ts`
  - Implement atomic PostgreSQL review claim inside a transaction using `FOR UPDATE SKIP LOCKED`.

- Modify `tests/taskTrackerQueue.test.ts`
  - Add in-memory and optional PostgreSQL coverage for `claimReviewTask`.

- Modify `tests/taskTrackerCore.test.ts`
  - Add status transition coverage for `fixing_review -> awaiting_human`.

- Modify `src/domain/internalWorkerOrchestrator.ts`
  - Fetch opened-MR discussions during review reconciliation.
  - Claim the review task before running Codex.
  - Recover stale `fixing_review` tasks that no longer have an active task lease.
  - Run `review_fix`, validation, commit, push, GitLab replies, metadata recording, and status transition back to `review`.

- Modify `tests/internalWorkerOrchestrator.test.ts`
  - Add internal-mode review-fix behavior tests.
  - Update the existing opened-MR reconciliation test to expect normal ready-claim fallback only when there are no pending reviewer notes.

- Modify `docs/ENV_CONFIGURATION.md`
  - Document that `MAX_REVIEW_FIX_ATTEMPTS` applies to internal tracker review feedback as well.

## Scope Decisions

- Review feedback is triggered only by unresolved GitLab discussions that contain pending non-system notes from a user other than the GitLab API user. Non-resolvable top-level MR notes are not part of this story unless GitLab reports the whole discussion as unresolved.
- `claimReviewTask` is intentionally not idempotent in this plan. The caller claims by `taskId`; retries are protected by active task/repository leases and stale leases are released before PostgreSQL claim selection.
- Pending review discussions are checked once before claiming only to avoid claiming tasks with no visible work. After a successful claim, the handler must reload the task and re-fetch pending discussions before running Codex, so metadata written by another worker between the first read and the claim cannot cause duplicate GitLab replies.
- `fixing_review` is an active worker-owned state. If the worker dies, a later cycle may recover the task only after its task lease is no longer active.
- Temporary integration errors after a review task has been claimed must not mark the task failed. They should move the task back to `review`, sync the external mirror, release leases through the existing heartbeat wrapper, and let a later cycle retry.

---

### Task 1: Add Shared Review Feedback Helper Tests

**Files:**
- Create: `tests/reviewFeedback.test.ts`

- [ ] **Step 1: Write tests for pending discussion filtering**

Create `tests/reviewFeedback.test.ts` with:

```ts
import { describe, expect, it } from "vitest";

import {
  findPendingReviewDiscussions,
  formatReviewReplyBody,
  mergeReviewMetadata,
} from "../src/domain/reviewFeedback.js";
import type {
  GitLabService,
  MergeRequestDiscussion,
  MergeRequestInfo,
} from "../src/models/types.js";

class FakeGitLabService implements Pick<
  GitLabService,
  "getCurrentUser" | "getMergeRequestDiscussions"
> {
  discussions: MergeRequestDiscussion[] = [];

  async getCurrentUser(): Promise<{ username: string }> {
    return { username: "ai-worker" };
  }

  async getMergeRequestDiscussions(_iid: number): Promise<MergeRequestDiscussion[]> {
    return this.discussions;
  }
}

const mergeRequest: MergeRequestInfo = {
  id: 894,
  iid: 894,
  url: "https://gitlab.example.com/project/-/merge_requests/894",
  title: "[AI] implementation",
  sourceBranch: "feature/ai-task-yt_FRONTEND-1996",
  targetBranch: "test",
  state: "opened",
};

describe("review feedback helpers", () => {
  it("keeps unresolved reviewer notes and ignores current-user notes", async () => {
    const gitlab = new FakeGitLabService();
    gitlab.discussions = [
      {
        id: "discussion-1",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24737,
            body: "Please account for max.ru bot links.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:14:12.667Z",
            position: { newPath: "src/example.ts", newLine: 12 },
          },
          {
            id: 24740,
            body: "Worker reply should be ignored.",
            authorUsername: "ai-worker",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:15:12.667Z",
            position: { newPath: "src/example.ts", newLine: 12 },
          },
        ],
      },
    ];

    const pending = await findPendingReviewDiscussions({
      gitlab,
      mergeRequestIid: mergeRequest.iid,
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("discussion-1");
    expect(pending[0]?.notes.map((note) => note.id)).toEqual([24737]);
  });

  it("ignores discussions GitLab already marks as resolved", async () => {
    const gitlab = new FakeGitLabService();
    gitlab.discussions = [
      {
        id: "discussion-resolved",
        individualNote: false,
        resolved: true,
        notes: [
          {
            id: 24741,
            body: "Already resolved in GitLab.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: true,
            createdAt: "2026-05-18T15:16:12.667Z",
          },
        ],
      },
    ];

    const pending = await findPendingReviewDiscussions({
      gitlab,
      mergeRequestIid: mergeRequest.iid,
    });

    expect(pending).toEqual([]);
  });

  it("skips notes already recorded in review metadata", async () => {
    const gitlab = new FakeGitLabService();
    gitlab.discussions = [
      {
        id: "discussion-1",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24737,
            body: "Already fixed.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:14:12.667Z",
          },
        ],
      },
    ];

    const pending = await findPendingReviewDiscussions({
      gitlab,
      mergeRequestIid: mergeRequest.iid,
      previousMetadata: {
        worker: "worker-1",
        issueKey: "yt_FRONTEND-1996",
        mergeRequestIid: 894,
        processedDiscussionIds: ["discussion-1"],
        processedNoteIds: [24737],
      },
    });

    expect(pending).toEqual([]);
  });

  it("merges metadata without duplicates", () => {
    const merged = mergeReviewMetadata({
      worker: "worker-1",
      issueKey: "yt_FRONTEND-1996",
      mergeRequestIid: 894,
      previousMetadata: {
        worker: "worker-1",
        issueKey: "yt_FRONTEND-1996",
        mergeRequestIid: 894,
        processedDiscussionIds: ["discussion-1"],
        processedNoteIds: [24737],
      },
      discussions: [
        {
          id: "discussion-1",
          individualNote: false,
          resolved: false,
          notes: [
            {
              id: 24737,
              body: "Already fixed.",
              authorUsername: "reviewer",
              system: false,
              resolvable: true,
              resolved: false,
              createdAt: "2026-05-18T15:14:12.667Z",
            },
            {
              id: 24739,
              body: "Fix conflicts.",
              authorUsername: "reviewer",
              system: false,
              resolvable: false,
              resolved: false,
              createdAt: "2026-05-18T15:23:51.647Z",
            },
          ],
        },
      ],
      lastFixCommit: "commit-1",
    });

    expect(merged.processedDiscussionIds).toEqual(["discussion-1"]);
    expect(merged.processedNoteIds).toEqual([24737, 24739]);
    expect(merged.lastFixCommit).toBe("commit-1");
  });

  it("formats the GitLab reply body", () => {
    expect(formatReviewReplyBody("commit-1", "- Tests: passed")).toBe(
      [
        "Applied the review feedback in commit commit-1.",
        "",
        "Validation:",
        "- Tests: passed",
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
npm test -- tests/reviewFeedback.test.ts
```

Expected: FAIL because `src/domain/reviewFeedback.ts` does not exist.

---

### Task 2: Implement Shared Review Feedback Helper

**Files:**
- Create: `src/domain/reviewFeedback.ts`
- Modify: `src/domain/orchestrator.ts`
- Test: `tests/reviewFeedback.test.ts`
- Regression Test: `tests/orchestrator.test.ts`

- [ ] **Step 1: Create `src/domain/reviewFeedback.ts`**

Add:

```ts
import type {
  GitLabService,
  MergeRequestDiscussion,
  MergeRequestNote,
  ReviewMetadata,
} from "../models/types.js";

export const mergeUniqueStrings = (
  first: readonly string[],
  second: readonly string[],
): string[] => [...new Set([...first, ...second])];

export const mergeUniqueNumbers = (
  first: readonly number[],
  second: readonly number[],
): number[] => [...new Set([...first, ...second])];

export const latestReviewMetadataForMergeRequest = (
  records: readonly { metadata: ReviewMetadata; createdAt: string }[],
  mergeRequestIid: number,
): ReviewMetadata | undefined =>
  records
    .filter((record) => record.metadata.mergeRequestIid === mergeRequestIid)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.metadata;

export const findPendingReviewDiscussions = async (input: {
  gitlab: Pick<GitLabService, "getCurrentUser" | "getMergeRequestDiscussions">;
  mergeRequestIid: number;
  previousMetadata?: ReviewMetadata;
}): Promise<MergeRequestDiscussion[]> => {
  const [currentUser, discussions] = await Promise.all([
    input.gitlab.getCurrentUser(),
    input.gitlab.getMergeRequestDiscussions(input.mergeRequestIid),
  ]);
  const processedDiscussionIds = new Set(
    input.previousMetadata?.processedDiscussionIds ?? [],
  );
  const processedNoteIds = new Set(input.previousMetadata?.processedNoteIds ?? []);

  return discussions
    .filter((discussion) => !discussion.resolved)
    .map((discussion) =>
      filterPendingReviewNotes(
        discussion,
        currentUser.username,
        processedDiscussionIds,
        processedNoteIds,
      ),
    )
    .filter(
      (discussion): discussion is MergeRequestDiscussion =>
        discussion !== undefined && discussion.notes.length > 0,
    );
};

const filterPendingReviewNotes = (
  discussion: MergeRequestDiscussion,
  currentUsername: string,
  processedDiscussionIds: Set<string>,
  processedNoteIds: Set<number>,
): MergeRequestDiscussion | undefined => {
  if (processedDiscussionIds.has(discussion.id) && processedNoteIds.size === 0) {
    return undefined;
  }

  const anchorPosition = discussion.notes.find((note) => note.position)?.position;
  const notes = discussion.notes
    .filter((note) => isPendingReviewerNote(note, currentUsername, processedNoteIds))
    .map((note) =>
      note.position || !anchorPosition
        ? note
        : {
            ...note,
            position: anchorPosition,
          },
    );

  if (notes.length === 0) {
    return undefined;
  }

  return {
    ...discussion,
    notes,
  };
};

const isPendingReviewerNote = (
  note: MergeRequestNote,
  currentUsername: string,
  processedNoteIds: Set<number>,
): boolean =>
  !note.system &&
  note.authorUsername !== currentUsername &&
  !processedNoteIds.has(note.id);

export const mergeReviewMetadata = (input: {
  worker: string;
  issueKey: string;
  mergeRequestIid: number;
  previousMetadata?: ReviewMetadata;
  discussions: readonly MergeRequestDiscussion[];
  lastFixCommit: string;
}): ReviewMetadata => ({
  worker: input.worker,
  issueKey: input.issueKey,
  mergeRequestIid: input.mergeRequestIid,
  processedDiscussionIds: mergeUniqueStrings(
    input.previousMetadata?.processedDiscussionIds ?? [],
    input.discussions.map((discussion) => discussion.id),
  ),
  processedNoteIds: mergeUniqueNumbers(
    input.previousMetadata?.processedNoteIds ?? [],
    input.discussions.flatMap((discussion) => discussion.notes.map((note) => note.id)),
  ),
  lastFixCommit: input.lastFixCommit,
});

export const formatReviewReplyBody = (
  commitSha: string,
  validationSummary: string,
): string =>
  [
    `Applied the review feedback in commit ${commitSha}.`,
    "",
    "Validation:",
    validationSummary,
  ].join("\n");
```

- [ ] **Step 2: Run helper tests**

Run:

```powershell
npm test -- tests/reviewFeedback.test.ts
```

Expected: PASS.

- [ ] **Step 3: Refactor `WorkerOrchestrator` to use helper**

In `src/domain/orchestrator.ts`, add imports:

```ts
import {
  findPendingReviewDiscussions,
  formatReviewReplyBody,
  mergeReviewMetadata,
} from "./reviewFeedback.js";
```

Replace `findPendingReviewDiscussions()` body with:

```ts
  private async findPendingReviewDiscussions(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
    mergeRequest: MergeRequestInfo,
  ): Promise<MergeRequestDiscussion[]> {
    return findPendingReviewDiscussions({
      gitlab: this.gitlab,
      mergeRequestIid: mergeRequest.iid,
      previousMetadata: findLatestReviewMetadata(
        comments,
        issue.key,
        mergeRequest.iid,
      ),
    });
  }
```

Replace the metadata payload in `handleReviewFeedback()` with:

```ts
      formatReviewMetadataComment(
        mergeReviewMetadata({
          worker: this.config.workerId,
          issueKey: issue.key,
          mergeRequestIid: mergeRequest.iid,
          previousMetadata,
          discussions: pendingDiscussions,
          lastFixCommit: headAfter,
        }),
      ),
```

Replace `this.formatReviewReplyBody(headAfter, validationSummary)` with:

```ts
formatReviewReplyBody(headAfter, validationSummary)
```

Remove the now-unused private methods `filterPendingReviewNotes()`, `isPendingReviewerNote()`, and `formatReviewReplyBody()`. Keep `mergeUniqueStrings()` and `mergeUniqueNumbers()` only if another method still uses them; otherwise remove them too.

- [ ] **Step 4: Run old review regression test**

Run:

```powershell
npm test -- tests/orchestrator.test.ts -t "fixes unresolved review discussions"
```

Expected: PASS.

---

### Task 3: Allow Review-Fix Clarification Status

**Files:**
- Modify: `src/domain/taskTracker/status.ts`
- Test: `tests/taskTrackerCore.test.ts`

- [ ] **Step 1: Add failing status transition test**

In `tests/taskTrackerCore.test.ts`, add this test near the existing status transition tests:

```ts
  it("allows review fixes to pause for human clarification", () => {
    expect(canTransitionTaskStatus("fixing_review", "awaiting_human")).toBe(true);
  });
```

- [ ] **Step 2: Run the focused status test and verify it fails**

Run:

```powershell
npm test -- tests/taskTrackerCore.test.ts -t "allows review fixes"
```

Expected: FAIL because `fixing_review -> awaiting_human` is not allowed yet.

- [ ] **Step 3: Allow the transition**

In `src/domain/taskTracker/status.ts`, change the `fixing_review` row from:

```ts
  fixing_review: ["validating", "review", "failed", "cancelled"],
```

to:

```ts
  fixing_review: ["validating", "review", "awaiting_human", "failed", "cancelled"],
```

- [ ] **Step 4: Run the focused status test**

Run:

```powershell
npm test -- tests/taskTrackerCore.test.ts -t "allows review fixes"
```

Expected: PASS.

---

### Task 4: Add Leased Review Claim API

**Files:**
- Modify: `src/domain/taskTracker/types.ts`
- Modify: `src/domain/taskTracker/index.ts`
- Modify: `src/domain/taskTracker/agentWorkflowService.ts`
- Modify: `src/domain/taskTracker/inMemoryTaskTracker.ts`
- Modify: `src/integrations/internalTracker/postgresTaskTracker.ts`
- Test: `tests/taskTrackerQueue.test.ts`

- [ ] **Step 1: Add queue tests for in-memory review claim**

Append to `describe("internal task tracker queue", ...)` in `tests/taskTrackerQueue.test.ts`:

```ts
  it("claims a review task for review feedback and moves it to fixing_review", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput({ id: "review-task", status: "ready" }));
    await client.setStatus("review-task", "claimed", "Claimed for setup.");
    await client.setStatus("review-task", "analyzing", "Analyzing for setup.");
    await client.setStatus("review-task", "implementing", "Implementing for setup.");
    await client.setStatus("review-task", "validating", "Validating for setup.");
    await client.setStatus("review-task", "review", "Ready for review.");

    const claim = await client.claimReviewTask({
      workerId: "worker-1",
      taskId: "review-task",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });

    const updated = await client.getTask("review-task");
    expect(claim?.task.id).toBe("review-task");
    expect(claim?.task.status).toBe("fixing_review");
    expect(updated.status).toBe("fixing_review");
    expect(claim?.taskLease.kind).toBe("task");
    expect(claim?.repositoryLease.kind).toBe("repository");
  });

  it("does not claim a review task when the repository lease is active", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput({ id: "ready-task", title: "Ready" }));
    await client.createTask(baseTaskInput({ id: "review-task", title: "Review" }));
    await client.setStatus("review-task", "claimed", "Claimed for setup.");
    await client.setStatus("review-task", "analyzing", "Analyzing for setup.");
    await client.setStatus("review-task", "implementing", "Implementing for setup.");
    await client.setStatus("review-task", "validating", "Validating for setup.");
    await client.setStatus("review-task", "review", "Ready for review.");

    await client.claimNextTask(claimInput({ targetExternalKey: "ready-task" }));
    const reviewClaim = await client.claimReviewTask({
      workerId: "worker-2",
      taskId: "review-task",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });

    expect(reviewClaim).toBeNull();
  });

  it("does not claim the same review task twice", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput({ id: "review-task", status: "ready" }));
    await client.setStatus("review-task", "claimed", "Claimed for setup.");
    await client.setStatus("review-task", "analyzing", "Analyzing for setup.");
    await client.setStatus("review-task", "implementing", "Implementing for setup.");
    await client.setStatus("review-task", "validating", "Validating for setup.");
    await client.setStatus("review-task", "review", "Ready for review.");

    const firstClaim = await client.claimReviewTask({
      workerId: "worker-1",
      taskId: "review-task",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });
    const secondClaim = await client.claimReviewTask({
      workerId: "worker-2",
      taskId: "review-task",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });

    expect(firstClaim?.task.status).toBe("fixing_review");
    expect(secondClaim).toBeNull();
  });
```

- [ ] **Step 2: Add optional PostgreSQL review claim test**

Append to `describePostgres("PostgresTaskTrackerClient queue", ...)`:

```ts
  it("claims a review task through PostgreSQL storage", async () => {
    const client = new PostgresTaskTrackerClient(pg);
    await client.createTask(baseTaskInput({ id: "pg-review-task", status: "ready" }));
    await client.setStatus("pg-review-task", "claimed", "Claimed for setup.");
    await client.setStatus("pg-review-task", "analyzing", "Analyzing for setup.");
    await client.setStatus("pg-review-task", "implementing", "Implementing for setup.");
    await client.setStatus("pg-review-task", "validating", "Validating for setup.");
    await client.setStatus("pg-review-task", "review", "Ready for review.");

    const claim = await client.claimReviewTask({
      workerId: "worker-1",
      taskId: "pg-review-task",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });

    const updated = await client.getTask("pg-review-task");
    expect(claim?.task.id).toBe("pg-review-task");
    expect(updated.status).toBe("fixing_review");
  });
```

- [ ] **Step 3: Run queue tests and verify failure**

Run:

```powershell
npm test -- tests/taskTrackerQueue.test.ts
```

Expected: FAIL because `claimReviewTask` is not defined.

- [ ] **Step 4: Add task tracker types**

In `src/domain/taskTracker/types.ts`, add after `ClaimTaskInput`:

```ts
export interface ClaimReviewTaskInput {
  workerId: string;
  taskId: string;
  repositoryProfiles: ClaimRepositoryProfile[];
  leaseTtlSeconds: number;
}
```

Add to `TaskTrackerClient`:

```ts
  claimReviewTask(input: ClaimReviewTaskInput): Promise<ClaimedTask | null>;
```

In `src/domain/taskTracker/index.ts`, add `ClaimReviewTaskInput` to the exported type list:

```ts
  ClaimReviewTaskInput,
```

- [ ] **Step 5: Add workflow wrapper**

In `src/domain/taskTracker/agentWorkflowService.ts`, import `ClaimReviewTaskInput` and add:

```ts
  async claimReviewTask(input: ClaimReviewTaskInput): Promise<ClaimedTask | null> {
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.taskId, "taskId");
    requireArray(input.repositoryProfiles, "repositoryProfiles");
    if (!Number.isFinite(input.leaseTtlSeconds) || input.leaseTtlSeconds <= 0) {
      throw new Error("leaseTtlSeconds must be a positive number.");
    }
    return this.tracker.claimReviewTask(input);
  }
```

- [ ] **Step 6: Implement in-memory review claim**

In `src/domain/taskTracker/inMemoryTaskTracker.ts`, import `ClaimReviewTaskInput` and add:

```ts
  async claimReviewTask(input: ClaimReviewTaskInput): Promise<ClaimedTask | null> {
    this.assertClaimInput(input);
    const now = this.now();
    const task = this.tasks.get(input.taskId);
    if (!task || task.status !== "review") {
      return null;
    }
    if (!this.isEligibleReviewClaimCandidate(task, input, now)) {
      return null;
    }

    const timestamp = now.toISOString();
    const taskLease = this.createLeaseRecord("task", taskLeaseKeyForTask(task.id), task, input, now);
    const repositoryLease = this.createLeaseRecord(
      "repository",
      repositoryLeaseKeyForTask(task),
      task,
      input,
      now,
    );

    this.leases.set(taskLease.leaseId, taskLease);
    this.leases.set(repositoryLease.leaseId, repositoryLease);
    task.status = "fixing_review";
    task.updatedAt = timestamp;
    task.events.push({
      id: `evt_${randomUUID()}`,
      taskId: task.id,
      kind: "task_claimed",
      source: "worker_agent",
      actor: { owner: "worker_agent", id: input.workerId },
      payload: {
        fromStatus: "review",
        toStatus: "fixing_review",
        taskLeaseId: taskLease.leaseId,
        repositoryLeaseId: repositoryLease.leaseId,
        repositoryLeaseKey: repositoryLease.leaseKey,
      },
      createdAt: timestamp,
    });

    return {
      task: clone(task),
      agentContext: buildAgentTaskContext(task),
      taskLease: clone(taskLease),
      repositoryLease: clone(repositoryLease),
    };
  }
```

Add:

```ts
  private isEligibleReviewClaimCandidate(
    task: TaskRecord,
    input: ClaimReviewTaskInput,
    now: Date,
  ): boolean {
    if (task.status !== "review") {
      return false;
    }
    if (!task.repositoryName || !task.repoPathKey) {
      return false;
    }
    if (!taskMatchesRepositoryProfile(task, input.repositoryProfiles)) {
      return false;
    }
    if (activeBlockingDependenciesForTask(task.id, this.allDependencies()).length > 0) {
      return false;
    }

    const activeLeases = [...this.leases.values()].filter((lease) =>
      isLeaseActiveAt(lease, now),
    );
    const taskLeaseKey = taskLeaseKeyForTask(task.id);
    if (activeLeases.some((lease) => lease.kind === "task" && lease.leaseKey === taskLeaseKey)) {
      return false;
    }

    const repositoryLeaseKey = repositoryLeaseKeyForTask(task);
    return !activeLeases.some(
      (lease) => lease.kind === "repository" && lease.leaseKey === repositoryLeaseKey,
    );
  }
```

- [ ] **Step 7: Implement PostgreSQL review claim**

In `src/integrations/internalTracker/postgresTaskTracker.ts`, import `ClaimReviewTaskInput` and add a public method:

```ts
  async claimReviewTask(input: ClaimReviewTaskInput): Promise<ClaimedTask | null> {
    this.assertClaimInput(input);
    const now = this.now();
    const nowIso = now.toISOString();

    return this.withTransaction(async (client) => {
      await client.query(
        `
          UPDATE task_leases
          SET released_at = $1
          WHERE released_at IS NULL AND expires_at <= $1
        `,
        [nowIso],
      );

      const taskId = await this.selectReviewClaimCandidate(client, input, nowIso);
      if (!taskId) {
        return null;
      }

      const task = await this.getTaskUsing(client, taskId);
      const taskLease = this.createLeaseRecord(
        "task",
        taskLeaseKeyForTask(task.id),
        task,
        input.workerId,
        now,
        input.leaseTtlSeconds,
      );
      const repositoryLease = this.createLeaseRecord(
        "repository",
        repositoryLeaseKeyForTask(task),
        task,
        input.workerId,
        now,
        input.leaseTtlSeconds,
      );

      const repositoryInserted = await this.insertLeaseIfAvailable(client, repositoryLease);
      if (!repositoryInserted) {
        return null;
      }

      const taskInserted = await this.insertLeaseIfAvailable(client, taskLease);
      if (!taskInserted) {
        await client.query("DELETE FROM task_leases WHERE lease_id = $1", [
          repositoryLease.leaseId,
        ]);
        return null;
      }

      await client.query(
        "UPDATE tasks SET status = 'fixing_review', updated_at = $2 WHERE id = $1",
        [task.id, nowIso],
      );
      await this.insertEvent(client, {
        id: `evt_${randomUUID()}`,
        taskId: task.id,
        kind: "task_claimed",
        source: "worker_agent",
        actor: { owner: "worker_agent", id: input.workerId },
        payload: {
          fromStatus: "review",
          toStatus: "fixing_review",
          taskLeaseId: taskLease.leaseId,
          repositoryLeaseId: repositoryLease.leaseId,
          repositoryLeaseKey: repositoryLease.leaseKey,
        },
        createdAt: nowIso,
      });

      const claimedTask = await this.getTaskUsing(client, task.id);
      return {
        task: claimedTask,
        agentContext: buildAgentTaskContext(claimedTask),
        taskLease,
        repositoryLease,
      };
    });
  }
```

Add a private selector next to `selectClaimCandidate()`:

```ts
  private async selectReviewClaimCandidate(
    client: PostgresQueryable,
    input: ClaimReviewTaskInput,
    nowIso: string,
  ): Promise<string | null> {
    const params: unknown[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const repositoryWhere = buildRepositoryProfileWhere(input.repositoryProfiles, addParam);
    const taskRef = addParam(input.taskId);
    const nowRef = addParam(nowIso);

    const result = await client.query<{ id: string }>(
      `
        SELECT t.id
        FROM tasks t
        WHERE t.id = ${taskRef}
          AND (${repositoryWhere})
          AND t.status = 'review'
          AND t.repository_name IS NOT NULL
          AND t.repo_path_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies dep
            WHERE dep.status = 'active'
              AND (
                (dep.kind = 'blocks' AND dep.to_task_id = t.id)
                OR (
                  dep.kind IN (
                    'blocked_by',
                    'requires_human_input',
                    'requires_external_change'
                  )
                  AND dep.from_task_id = t.id
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM task_leases lease
            WHERE lease.kind = 'task'
              AND lease.task_id = t.id
              AND lease.released_at IS NULL
              AND lease.expires_at > ${nowRef}::timestamptz
          )
          AND NOT EXISTS (
            SELECT 1
            FROM task_leases lease
            WHERE lease.kind = 'repository'
              AND lease.lease_key = 'repo:' || lower(replace(coalesce(t.repo_path_key, t.repository_name), chr(92), '/'))
              AND lease.released_at IS NULL
              AND lease.expires_at > ${nowRef}::timestamptz
          )
        FOR UPDATE OF t SKIP LOCKED
        LIMIT 1
      `,
      params,
    );

    return result.rows[0]?.id ?? null;
  }
```

- [ ] **Step 8: Run queue tests**

Run:

```powershell
npm test -- tests/taskTrackerQueue.test.ts
```

Expected: PASS. PostgreSQL block is skipped unless `TASK_TRACKER_TEST_DATABASE_URL` is set.

---

### Task 5: Add Internal Worker Review-Fix Tests

**Files:**
- Modify: `tests/internalWorkerOrchestrator.test.ts`

- [ ] **Step 1: Extend fake GitLab service**

In `FakeGitLabService`, add:

```ts
  discussionCalls: number[] = [];
  replies: Array<{ iid: number; discussionId: string; body: string }> = [];
  discussionsByIid: Record<number, MergeRequestDiscussion[]> = {};
  discussionResponsesByIid: Record<number, MergeRequestDiscussion[][]> = {};
  temporaryReplyFailures = 0;
```

Replace `getMergeRequestDiscussions()` and `replyToDiscussion()` with:

```ts
  async getMergeRequestDiscussions(iid: number): Promise<MergeRequestDiscussion[]> {
    this.discussionCalls.push(iid);
    const queuedResponses = this.discussionResponsesByIid[iid];
    const queued = queuedResponses?.shift();
    if (queued) {
      return queued;
    }
    return this.discussionsByIid[iid] ?? [];
  }

  async replyToDiscussion(iid: number, discussionId: string, body: string): Promise<void> {
    if (this.temporaryReplyFailures > 0) {
      this.temporaryReplyFailures -= 1;
      throw new TemporaryIntegrationError("GitLab reply temporarily unavailable.");
    }
    this.replies.push({ iid, discussionId, body });
  }
```

- [ ] **Step 2: Extend fake git service**

In `FakeGitService`, add:

```ts
  pushes: string[] = [];
```

Replace `push()` with:

```ts
  async push(branch: string): Promise<void> {
    this.pushes.push(branch);
  }
```

- [ ] **Step 3: Extend fake Codex runner to capture review-fix prompts and repository changes**

In `FakeCodexRunner`, add:

```ts
  initialPrompts: string[] = [];
```

Replace `runInitial()` with:

```ts
  async runInitial(
    _prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexRunOptions,
  ): Promise<CodexExecution> {
    this.initialCalls += 1;
    this.initialPrompts.push(_prompt);
    if (_prompt.includes("Unresolved reviewer comments:")) {
      if (this.git) {
        this.git.hasUncommittedChanges = true;
      }
      return {
        process: { stdout: "", stderr: "", exitCode: 0 },
        finalMessage: "Fixed max.ru bot link handling.",
        threadId: "thread-internal-review-fix",
      };
    }
    return {
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage: "READY_FOR_IMPLEMENTATION",
      threadId: "thread-internal",
    };
  }
```

- [ ] **Step 4: Add failing review-fix test**

Append to `describe("InternalWorkerOrchestrator review reconciliation", ...)`:

```ts
  it("fixes unresolved GitLab review discussions for internal review tasks", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-review-fix" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-review-fix",
      outcome: "created",
      mergeRequest: {
        id: 104,
        iid: 20,
        url: "https://gitlab.example.com/project/-/merge_requests/20",
        title: "[AI] internal-review-fix implementation",
        sourceBranch: "feature/ai-task-internal-review-fix",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);

    const git = new FakeGitService();
    git.hasCommittedDiff = true;
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[20] = {
      id: 104,
      iid: 20,
      url: "https://gitlab.example.com/project/-/merge_requests/20",
      title: "[AI] internal-review-fix implementation",
      sourceBranch: "feature/ai-task-internal-review-fix",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionsByIid[20] = [
      {
        id: "discussion-1",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24737,
            body: "Please account for max.ru bot links.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:14:12.667Z",
            position: { newPath: "src/example.ts", newLine: 12 },
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(codex.initialPrompts.at(-1)).toContain("Please account for max.ru bot links.");
    expect(codex.initialPrompts.at(-1)).toContain("Unresolved reviewer comments:");
    expect(git.commits).toEqual(["fix: fixed max.ru bot link handling internal-review-fix"]);
    expect(git.pushes).toEqual(["feature/ai-task-internal-review-fix"]);
    expect(gitlab.discussionCalls).toEqual([20, 20]);
    expect(gitlab.replies).toHaveLength(1);
    expect(gitlab.replies[0]).toMatchObject({
      iid: 20,
      discussionId: "discussion-1",
    });
    expect(gitlab.replies[0]?.body).toContain("commit-1");
    expect(updated.reviewMetadata.at(-1)?.metadata).toMatchObject({
      mergeRequestIid: 20,
      processedDiscussionIds: ["discussion-1"],
      processedNoteIds: [24737],
      lastFixCommit: "commit-1",
    });
    expect(updated.agentRuns.some((run) => run.stage === "review_fix")).toBe(true);
  });
```

If the expected commit message differs after running the implementation, keep the assertion tied to `buildCommitMessage()` output by updating the expected string to the exact actual message. Do not weaken the assertion to only check that a commit happened.

- [ ] **Step 5: Add post-claim race regression test**

Append to `describe("InternalWorkerOrchestrator review reconciliation", ...)`:

```ts
  it("does not run Codex when pending feedback disappears after the review claim", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-review-race" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-review-race",
      outcome: "created",
      mergeRequest: {
        id: 107,
        iid: 23,
        url: "https://gitlab.example.com/project/-/merge_requests/23",
        title: "[AI] internal-review-race implementation",
        sourceBranch: "feature/ai-task-internal-review-race",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);

    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[23] = {
      id: 107,
      iid: 23,
      url: "https://gitlab.example.com/project/-/merge_requests/23",
      title: "[AI] internal-review-race implementation",
      sourceBranch: "feature/ai-task-internal-review-race",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionResponsesByIid[23] = [
      [
        {
          id: "discussion-race",
          individualNote: false,
          resolved: false,
          notes: [
            {
              id: 24770,
              body: "This feedback was fixed by another worker.",
              authorUsername: "reviewer",
              system: false,
              resolvable: true,
              resolved: false,
              createdAt: "2026-05-18T15:40:00.000Z",
            },
          ],
        },
      ],
      [],
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("idle");
    expect(updated.status).toBe("review");
    expect(codex.initialCalls).toBe(0);
    expect(gitlab.discussionCalls).toEqual([23, 23]);
    expect(gitlab.replies).toEqual([]);
    expect(updated.reviewMetadata).toHaveLength(0);
  });
```

- [ ] **Step 6: Add no-pending-feedback regression test**

Modify the existing test named `continues normal ready task claiming when review reconciliation has no terminal MR` so that:

```ts
    gitlab.discussionsByIid[19] = [];
```

Keep these expectations:

```ts
    expect(reviewUpdated.status).toBe("review");
    expect(readyUpdated.status).toBe("review");
    expect(codex.initialCalls).toBe(1);
    expect(codex.resumeCalls).toBe(1);
```

Add:

```ts
    expect(gitlab.discussionCalls).toEqual([19]);
```

- [ ] **Step 7: Add stale `fixing_review` recovery test**

Append to `describe("InternalWorkerOrchestrator review reconciliation", ...)`:

```ts
  it("recovers stale fixing_review tasks without an active lease", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-stale-review-fix" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-stale-review-fix",
      outcome: "created",
      mergeRequest: {
        id: 105,
        iid: 21,
        url: "https://gitlab.example.com/project/-/merge_requests/21",
        title: "[AI] internal-stale-review-fix implementation",
        sourceBranch: "feature/ai-task-internal-stale-review-fix",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);
    await tracker.setStatus(task.id, "fixing_review", "Simulate crashed review fix.");

    const git = new FakeGitService();
    git.hasCommittedDiff = true;
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[21] = {
      id: 105,
      iid: 21,
      url: "https://gitlab.example.com/project/-/merge_requests/21",
      title: "[AI] internal-stale-review-fix implementation",
      sourceBranch: "feature/ai-task-internal-stale-review-fix",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionsByIid[21] = [
      {
        id: "discussion-stale",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24750,
            body: "Retry stale review feedback.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:30:00.000Z",
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(gitlab.replies).toHaveLength(1);
    expect(updated.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_status_changed",
          payload: expect.objectContaining({ from: "fixing_review", to: "review" }),
        }),
      ]),
    );
  });
```

- [ ] **Step 8: Add temporary GitLab reply failure test**

Append to `describe("InternalWorkerOrchestrator review reconciliation", ...)`:

```ts
  it("keeps internal review tasks retryable when replying to GitLab temporarily fails", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-review-retry" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-review-retry",
      outcome: "created",
      mergeRequest: {
        id: 106,
        iid: 22,
        url: "https://gitlab.example.com/project/-/merge_requests/22",
        title: "[AI] internal-review-retry implementation",
        sourceBranch: "feature/ai-task-internal-review-retry",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);

    const git = new FakeGitService();
    git.hasCommittedDiff = true;
    const gitlab = new FakeGitLabService();
    gitlab.temporaryReplyFailures = 1;
    gitlab.mergeRequestsByIid[22] = {
      id: 106,
      iid: 22,
      url: "https://gitlab.example.com/project/-/merge_requests/22",
      title: "[AI] internal-review-retry implementation",
      sourceBranch: "feature/ai-task-internal-review-retry",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionsByIid[22] = [
      {
        id: "discussion-retry",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24760,
            body: "Retry after temporary GitLab failure.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:35:00.000Z",
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(gitlab.replies).toEqual([]);
    expect(updated.reviewMetadata).toHaveLength(0);
    expect(updated.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_status_changed",
          payload: expect.objectContaining({ to: "failed" }),
        }),
      ]),
    );
  });
```

- [ ] **Step 9: Run internal worker tests and verify failure**

Run:

```powershell
npm test -- tests/internalWorkerOrchestrator.test.ts
```

Expected: FAIL because opened-MR discussion processing is not implemented.

---

### Task 6: Implement Internal Review-Fix Flow

**Files:**
- Modify: `src/domain/internalWorkerOrchestrator.ts`
- Test: `tests/internalWorkerOrchestrator.test.ts`

- [ ] **Step 1: Import shared helpers**

Add:

```ts
import {
  findPendingReviewDiscussions,
  formatReviewReplyBody,
  latestReviewMetadataForMergeRequest,
  mergeReviewMetadata,
} from "./reviewFeedback.js";
```

- [ ] **Step 2: Update review reconciliation selection and stale `fixing_review` recovery**

Replace `reconcileReviewTasks()` in `src/domain/internalWorkerOrchestrator.ts` with:

```ts
  private async reconcileReviewTasks(): Promise<number> {
    const reviewTasks = await this.taskTracker.listTasks({
      statuses: ["review", "fixing_review"],
      limit: 50,
    });
    const activeTaskLeaseTaskIds = new Set(
      (await this.taskTracker.listActiveLeases())
        .filter((lease) => lease.kind === "task")
        .map((lease) => lease.taskId),
    );
    let reconciled = 0;

    for (const candidate of reviewTasks) {
      let task = candidate;
      try {
        if (task.status === "fixing_review") {
          if (activeTaskLeaseTaskIds.has(task.id)) {
            this.logger.info("Skipping active internal review fix reconciliation.", {
              taskId: task.id,
            });
            continue;
          }
          await this.taskTracker.setStatus(
            task.id,
            "review",
            "Recovering stale review fix after inactive lease.",
          );
          task = await this.taskTracker.getTask(task.id);
        }

        if (await this.reconcileReviewTask(task)) {
          reconciled += 1;
        }
      } catch (error) {
        if (error instanceof TemporaryIntegrationError) {
          this.logger.warn("Skipping internal review reconciliation after transient GitLab error.", {
            taskId: task.id,
            error: error.message,
          });
          continue;
        }
        throw error;
      }
    }

    return reconciled;
  }
```

- [ ] **Step 3: Update `reconcileReviewTask()` opened-MR branch**

After the existing `closed` block, replace the final `return false;` with:

```ts
    return this.reconcileOpenedReviewTask(context, task, latest.branch, mergeRequest);
```

- [ ] **Step 4: Add opened review reconciliation method**

Add near `reconcileReviewTask()`:

```ts
  private async reconcileOpenedReviewTask(
    context: InternalExecutionContext,
    task: TaskRecord,
    branch: string,
    mergeRequest: MergeRequestInfo,
  ): Promise<boolean> {
    const initialMetadata = latestReviewMetadataForMergeRequest(
      task.reviewMetadata,
      mergeRequest.iid,
    );
    const initialPendingDiscussions = await findPendingReviewDiscussions({
      gitlab: context.gitlab,
      mergeRequestIid: mergeRequest.iid,
      previousMetadata: initialMetadata,
    });

    if (initialPendingDiscussions.length === 0) {
      this.logger.info("Internal review task has no pending unresolved reviewer comments.", {
        taskId: task.id,
        mergeRequestIid: mergeRequest.iid,
      });
      return false;
    }

    const claim = await this.workflow.claimReviewTask({
      workerId: this.config.workerId,
      taskId: task.id,
      repositoryProfiles: this.contexts.map((candidate) => ({
        name: candidate.profile.name,
        queues: candidate.profile.queues,
        tags: candidate.profile.tags,
      })),
      leaseTtlSeconds: Math.max(1, Math.floor(this.config.coordination.lockTtlMs / 1000)),
    });
    if (!claim) {
      this.logger.info("Internal review task was not claimed for review feedback.", {
        taskId: task.id,
        mergeRequestIid: mergeRequest.iid,
      });
      return false;
    }

    return this.withLeaseHeartbeat(claim, async () => {
      try {
        const handled = await this.handleInternalReviewFeedback(context, claim, branch, mergeRequest);
        await this.syncExternalMirror(claim.task.id);
        return handled;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TemporaryIntegrationError) {
          this.logger.warn("Temporary integration error during internal review feedback fix.", {
            taskId: claim.task.id,
            mergeRequestIid: mergeRequest.iid,
            error: message,
          });
          await this.taskTracker.setStatus(
            claim.task.id,
            "review",
            `Temporary review feedback error; will retry: ${message}`,
          );
          await this.syncExternalMirror(claim.task.id);
          return true;
        }

        await this.finalizeFailure(context, claim.task.id, message);
        await this.syncExternalMirror(claim.task.id);
        return true;
      }
    });
  }
```

- [ ] **Step 5: Add internal review feedback handler**

Add near `processTaskWithContext()`:

```ts
  private async handleInternalReviewFeedback(
    context: InternalExecutionContext,
    claim: ClaimedTask,
    branch: string,
    mergeRequest: MergeRequestInfo,
  ): Promise<boolean> {
    const task = await this.taskTracker.getTask(claim.task.id);
    const previousMetadata = latestReviewMetadataForMergeRequest(
      task.reviewMetadata,
      mergeRequest.iid,
    );
    const pendingDiscussions = await findPendingReviewDiscussions({
      gitlab: context.gitlab,
      mergeRequestIid: mergeRequest.iid,
      previousMetadata,
    });

    if (pendingDiscussions.length === 0) {
      this.logger.info("Internal review feedback disappeared after claim.", {
        taskId: task.id,
        mergeRequestIid: mergeRequest.iid,
      });
      await this.taskTracker.setStatus(
        task.id,
        "review",
        "Review feedback already addressed before this worker started fixing it.",
      );
      return false;
    }

    const imageContext = await this.prepareImageContext(context, task);
    try {
      const issue = taskToIssue(task);
      const comments = commentsForPrompt(task.comments);
      const analysisDecision = latestAnalysisDecision(task.decisions);
      const promptProfile = this.selectProfile(context.config, issue, analysisDecision);
      const codexOptions: CodexRunOptions = { imagePaths: imageContext?.imagePaths ?? [] };

      await this.workflow.recordTaskStep(task.id, {
        kind: "review_fix",
        status: "running",
        outputSummary: "Fixing unresolved GitLab review discussions.",
      });
      await this.recordWorkflowEvent(context, task.id, {
        type: "review_fix_started",
        status: "info",
        message: "Fixing unresolved GitLab review discussions.",
        details: {
          mergeRequestIid: mergeRequest.iid,
          discussionIds: pendingDiscussions.map((discussion) => discussion.id),
        },
      });

      const checkedOutBranch = await context.git.checkoutBranch(branch);
      const headBefore = await context.git.getHeadSha();
      const diffFromBase = await context.git.getDiffFromBase();
      const changedFiles = await context.git.getChangedFilesFromBase();
      const prompt = buildReviewFixPrompt(
        issue,
        comments,
        {
          mergeRequest,
          discussions: pendingDiscussions,
          changedFiles,
          diffFromBase,
        },
        promptProfile,
        analysisDecision,
        imageContext,
      );

      let execution = await this.runCodexStage(context, task.id, "review_fix", (observer) =>
        context.codex.runInitial(prompt, observer, codexOptions),
      );
      let reviewThreadId = execution.threadId;
      let reviewFixSummary = execution.finalMessage?.trim();
      if (execution.clarification) {
        await this.pauseForClarification(context, task.id, execution.clarification, reviewThreadId);
        return true;
      }
      if (execution.process.exitCode !== 0) {
        this.logger.warn("Codex internal review fix run exited with non-zero code.", {
          taskId: task.id,
          exitCode: execution.process.exitCode,
        });
      }

      await this.taskTracker.setStatus(task.id, "validating", "Internal review fix validation started.");
      await this.workflow.recordTaskStep(task.id, { kind: "validate", status: "running" });
      let validation = await this.validateRepositoryState(context, task.id);
      let attempt = 0;
      while (!isValidationSuccessful(validation) && attempt < context.config.maxReviewFixAttempts) {
        attempt += 1;
        await this.taskTracker.setStatus(task.id, "fixing_review", "Applying review validation fix.");
        await this.workflow.recordTaskStep(task.id, {
          kind: "review_fix",
          attempt,
          status: "running",
          diagnostic: validation.diagnostic,
        });
        execution = await this.runCodexStage(context, task.id, "review_fix", (observer) =>
          reviewThreadId
            ? context.codex.runResume(
                reviewThreadId,
                buildFixPrompt(
                  issue,
                  validation.diagnostic,
                  promptProfile,
                  analysisDecision,
                  imageContext,
                ),
                observer,
                codexOptions,
              )
            : context.codex.runFix(
                buildFixPrompt(
                  issue,
                  validation.diagnostic,
                  promptProfile,
                  analysisDecision,
                  imageContext,
                ),
                observer,
                codexOptions,
              ),
        );
        reviewThreadId = execution.threadId ?? reviewThreadId;
        reviewFixSummary = execution.finalMessage?.trim() ?? reviewFixSummary;
        if (execution.clarification) {
          await this.pauseForClarification(context, task.id, execution.clarification, reviewThreadId);
          return true;
        }
        await this.taskTracker.setStatus(task.id, "validating", "Re-running validation after review fix.");
        validation = await this.validateRepositoryState(context, task.id);
      }

      if (!isValidationSuccessful(validation)) {
        await this.recordFailureMemory(context, {
          issue,
          failureKind: "review_validation_exhausted",
          diagnostic: validation.diagnostic,
          promptProfile,
          analysisDecision,
        });
        await this.workflow.recordTaskStep(task.id, {
          kind: "validate",
          status: "failed",
          failureKind: "review_validation_exhausted",
          diagnostic: validation.diagnostic,
        });
        throw new PermanentTaskError(validation.diagnostic);
      }

      await this.workflow.recordTaskStep(task.id, {
        kind: "validate",
        status: "done",
        outputSummary: this.formatValidationSummary(validation),
      });

      if (await context.git.hasChanges()) {
        const commitChangedFiles = await context.git.getChangedFilesFromBase();
        await context.git.commit(
          buildCommitMessage({
            issue,
            changedFiles: commitChangedFiles,
            summary: reviewFixSummary,
          }),
        );
      }

      const headAfter = await context.git.getHeadSha();
      if (headAfter === headBefore) {
        throw new PermanentTaskError(
          "Codex completed the internal review fix without producing a new commit.",
        );
      }

      await context.git.push(checkedOutBranch);
      const validationSummary = this.formatValidationSummary(validation);
      const replyBody = formatReviewReplyBody(headAfter, validationSummary);
      for (const discussion of pendingDiscussions) {
        await context.gitlab.replyToDiscussion(mergeRequest.iid, discussion.id, replyBody);
      }

      await this.workflow.recordReviewMetadata(task.id, {
        metadata: mergeReviewMetadata({
          worker: this.config.workerId,
          issueKey: task.id,
          mergeRequestIid: mergeRequest.iid,
          previousMetadata,
          discussions: pendingDiscussions,
          lastFixCommit: headAfter,
        }),
      });
      await this.workflow.recordTaskStep(task.id, {
        kind: "review_fix",
        status: "done",
        outputSummary: reviewFixSummary,
      });
      await this.taskTracker.setStatus(
        task.id,
        "review",
        `Review feedback addressed and pushed: ${mergeRequest.url}`,
      );
      await this.recordWorkflowEvent(context, task.id, {
        type: "review_fix_completed",
        status: "info",
        message: "Review feedback addressed.",
        details: {
          mergeRequestIid: mergeRequest.iid,
          mergeRequestUrl: mergeRequest.url,
          lastFixCommit: headAfter,
        },
      });
      return true;
    } finally {
      await imageContext?.cleanup();
    }
  }
```

In `src/domain/internalWorkerOrchestrator.ts`, update the existing `./promptBuilder.js` import to include `buildReviewFixPrompt`:

```ts
import {
  buildAnalysisPrompt,
  buildDecompositionPrompt,
  buildFixPrompt,
  buildImplementationPrompt,
  buildResumePrompt,
  buildReviewFixPrompt,
} from "./promptBuilder.js";
```

- [ ] **Step 6: Run TypeScript verification**

Run:

```powershell
npm run typecheck
```

Expected: PASS. `TaskEventType` already includes `review_fix_started` and `review_fix_completed`, so keep those exact event names.

- [ ] **Step 7: Run internal worker tests**

Run:

```powershell
npm test -- tests/internalWorkerOrchestrator.test.ts
```

Expected: PASS.

---

### Task 7: Documentation and Verification

**Files:**
- Modify: `docs/ENV_CONFIGURATION.md`

- [ ] **Step 1: Update review feedback documentation**

In `docs/ENV_CONFIGURATION.md`, update the `MAX_REVIEW_FIX_ATTEMPTS` row or nearby review section to state:

```md
`MAX_REVIEW_FIX_ATTEMPTS` applies to both direct Yandex mode review discussions and internal tracker `review -> fixing_review -> review` cycles. In internal tracker mode, opened GitLab MRs are checked during review reconciliation before normal ready-task claiming.
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm test -- tests/reviewFeedback.test.ts tests/taskTrackerCore.test.ts tests/taskTrackerQueue.test.ts tests/internalWorkerOrchestrator.test.ts tests/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository verification**

Run:

```powershell
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 4: Manual local validation against the observed MR**

After deploying the built worker locally, keep `TASK_TRACKER_PROVIDER=internal` and confirm the next worker cycle logs include:

```text
Fixing unresolved GitLab review discussions.
Codex review_fix started.
Review feedback addressed.
```

For MR `894`, verify:

```powershell
docker logs --timestamps --tail 300 developer-worker-1
```

Expected outcome:

- task `yt_FRONTEND-1996` moves `review -> fixing_review -> review`;
- a new commit is pushed to `feature/ai-task-yt_FRONTEND-1996`;
- GitLab discussion `24737` receives an AI reply with the commit SHA and validation summary;
- `review_metadata_records` contains processed discussion and note ids for MR `894`.

---

## Self-Review

- Spec coverage: The plan covers the root cause, discussion detection, metadata idempotency, post-claim re-fetching to avoid duplicate replies, worker concurrency, stale `fixing_review` recovery, temporary integration retry behavior, Codex clarification pauses, Codex execution, validation, GitLab replies, internal status transitions, and documentation.
- Placeholder scan: No task relies on deferred unspecified behavior; every code-changing step includes concrete file paths, code, imports, exports, and expected verification output.
- Type consistency: The plan uses existing `ClaimedTask`, `TaskTrackerClient`, `AgentWorkflowService`, `TaskStatus`, `GitLabService`, and `MergeRequestInfo` names. New `ClaimReviewTaskInput` is introduced before use and exported through `src/domain/taskTracker/index.ts`.

## Execution Options

1. Subagent-Driven (recommended): dispatch a fresh worker per task, review between tasks, faster iteration.
2. Inline Execution: execute this plan in the current session with review checkpoints.
