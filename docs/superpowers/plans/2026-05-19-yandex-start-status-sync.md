# Yandex Start Status Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a Yandex-sourced internal task from external `open`/`Открыт` to external `in_progress`/`В работе` as soon as the internal worker claims and starts processing it.

**Architecture:** The internal tracker already changes `ready -> claimed -> analyzing`, and `mapTaskStatusToLogicalStatus()` already maps `claimed` and active runtime statuses to logical `in_progress`. The missing piece is timing: `InternalWorkerOrchestrator` currently calls the Yandex bridge only after the whole task processing path finishes, so a fast successful run jumps directly from external `open` to external `review`, and a long run remains externally open while work is active. Add an early bridge sync after `task_picked` and before analysis/Codex work begins; keep the existing final sync for later transitions.

**Tech Stack:** TypeScript ES modules, Vitest, internal task tracker, Yandex bridge, Yandex Tracker transition resolution through `TrackerClient`.

---

## Current Evidence

- Direct Yandex mode already does the correct start transition in `src/domain/orchestrator.ts`: when an issue is `open`, it calls `tracker.transition(issue.key, "in_progress")` before analysis/implementation.
- Internal + Yandex bridge mode has the right status mapping in `src/domain/taskTracker/status.ts`: `claimed`, `analyzing`, `decomposing`, `implementing`, `validating`, and `fixing_review` map to logical `in_progress`.
- `YandexBridge.syncTaskStatus()` in `src/integrations/yandexBridge/bridge.ts` can sync `claimed` to `in_progress`; `tests/yandexBridge.test.ts` already proves that direct bridge call emits `targetBusinessStatus: "in_progress"`.
- `InternalWorkerOrchestrator.processClaimedTask()` in `src/domain/internalWorkerOrchestrator.ts` calls `syncExternalMirror()` only after `processTask()` returns or in failure/reconciliation paths.
- `tests/worker.smoke.test.ts` currently encodes the bug for Yandex-sourced internal tasks by expecting `mockServer.transitions` to equal `["review"]` instead of `["start", "review"]`.

### Task 1: Add a failing orchestrator-level test for start sync

**Files:**
- Modify: `tests/internalWorkerOrchestrator.test.ts`

- [ ] **Step 1: Extend the imports**

Add Yandex bridge imports near the existing imports:

```ts
import {
  InMemoryYandexBridgeStore,
  YANDEX_TRACKER_PROVIDER,
  YandexBridge,
  type YandexBridgeExternalSource,
} from "../src/integrations/yandexBridge/index.js";
import type {
  ExportDigestInput,
  ExternalIssueSnapshot,
  ExternalTransitionInput,
  ImportCandidatesInput,
} from "../src/models/types.js";
```

- [ ] **Step 2: Add a minimal fake Yandex source**

Place this helper near the other fake services:

```ts
class FakeYandexSource implements YandexBridgeExternalSource {
  readonly transitions: ExternalTransitionInput[] = [];
  readonly digests: ExportDigestInput[] = [];

  async importCandidates(_input: ImportCandidatesInput): Promise<ExternalIssueSnapshot[]> {
    return [];
  }

  async exportDigest(input: ExportDigestInput): Promise<void> {
    this.digests.push(input);
  }

  async transitionExternal(input: ExternalTransitionInput): Promise<void> {
    this.transitions.push(input);
  }

  async getComments() {
    return [];
  }
}
```

- [ ] **Step 3: Allow the test orchestrator factory to receive Yandex bridges**

Change the `createOrchestrator` helper signature and constructor call:

```ts
const createOrchestrator = (
  tracker: InMemoryTaskTrackerClient,
  gitlab: FakeGitLabService,
  codex: FakeCodexRunner = new FakeCodexRunner(),
  git: FakeGitService = new FakeGitService(),
  yandexBridges: YandexBridge[] = [],
): InternalWorkerOrchestrator =>
  new InternalWorkerOrchestrator(
    createGlobalConfig(),
    [
      {
        profile,
        config: createAppConfig(),
        git,
        gitlab,
        codex,
      },
    ],
    tracker,
    new Logger(),
    undefined,
    undefined,
    yandexBridges,
  );
```

- [ ] **Step 4: Write the failing test**

Add this test in the normal ready-task processing describe block, or create a small new describe block before review reconciliation:

```ts
it("syncs Yandex-sourced internal tasks to in_progress immediately after claim", async () => {
  const tracker = new InMemoryTaskTrackerClient();
  await tracker.createTask(
    baseTaskInput({
      id: "yt_DEV-START",
      source: {
        kind: "external",
        provider: YANDEX_TRACKER_PROVIDER,
        externalKey: "DEV-START",
      },
      externalRefs: [
        {
          provider: YANDEX_TRACKER_PROVIDER,
          externalKey: "DEV-START",
          businessStatus: "open",
          lastSeenAt: "2026-05-19T00:00:00.000Z",
        },
      ],
    }),
  );
  const git = new FakeGitService();
  const gitlab = new FakeGitLabService();
  const codex = new FakeCodexRunner(git);
  const source = new FakeYandexSource();
  const bridge = new YandexBridge({
    taskTracker: tracker,
    source,
    store: new InMemoryYandexBridgeStore(),
    repository: {
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queues: ["DEV"],
      tags: ["ai_dev"],
    },
    workerId: "worker-1",
  });
  const orchestrator = createOrchestrator(tracker, gitlab, codex, git, [bridge]);

  const outcome = await orchestrator.runOnce();

  expect(outcome).toBe("processed");
  expect(source.transitions.map((transition) => transition.targetBusinessStatus)).toEqual([
    "in_progress",
    "review",
  ]);
  expect(source.digests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        externalKey: "DEV-START",
        digest: expect.stringContaining("AI DIGEST:"),
      }),
    ]),
  );
});
```

- [ ] **Step 5: Run the test and confirm it fails before implementation**

Run:

```bash
npm test -- tests/internalWorkerOrchestrator.test.ts
```

Expected before the fix: the new test fails because `source.transitions.map(...)` is `["review"]`, not `["in_progress", "review"]`.

### Task 2: Sync the Yandex mirror at the start of internal processing

**Files:**
- Modify: `src/domain/internalWorkerOrchestrator.ts`

- [ ] **Step 1: Add the early sync inside `processClaimedTask()`**

In `processClaimedTask()`, add the start sync as the first statement inside the existing `try` block, before `processTask(context, claim)`:

```ts
    await this.syncExternalMirror(claim.task.id);
```

The relevant block should become:

```ts
    await this.recordWorkflowEvent(context, claim.task.id, {
      type: "task_picked",
      status: "info",
      message: "Internal task picked for processing.",
    });

    try {
      await this.syncExternalMirror(claim.task.id);
      const outcome = await this.processTask(context, claim);
```

This uses the already-recorded `task_claimed` event and the current internal status `claimed`, which maps to logical `in_progress`.

- [ ] **Step 2: Keep the existing final sync unchanged**

Do not remove the later call after `processTask()`:

```ts
      await this.syncExternalMirror(claim.task.id);
```

That final call is still required for `review`, `waiting_for_answer`, `failed`, and `done` transitions.

- [ ] **Step 3: Run the focused orchestrator tests**

Run:

```bash
npm test -- tests/internalWorkerOrchestrator.test.ts
```

Expected after the fix: all tests pass, including the new start-sync test.

### Task 3: Update the Yandex integration smoke expectation

**Files:**
- Modify: `tests/worker.smoke.test.ts`

- [ ] **Step 1: Change the Yandex-sourced internal task expectation**

In the test named `processes a Yandex-sourced internal task and exports compact Yandex digests`, change:

```ts
      expect(mockServer.transitions).toEqual(["review"]);
```

to:

```ts
      expect(mockServer.transitions).toEqual(["start", "review"]);
```

- [ ] **Step 2: Run the smoke test**

Run:

```bash
npm run test:smoke
```

Expected after the fix: the direct Yandex smoke test still emits `["start", "review"]`, and the Yandex-sourced internal smoke test now also emits `["start", "review"]`.

### Task 4: Verify status-map behavior remains unchanged

**Files:**
- Modify only if tests reveal a real regression: `src/integrations/tracker/client.ts`
- Modify only if documentation needs clarification: `docs/ENV_CONFIGURATION.md`

- [ ] **Step 1: Run tracker client tests**

Run:

```bash
npm test -- tests/trackerClient.test.ts tests/yandexBridge.test.ts
```

Expected: transition resolution still uses `TRACKER_STATUS_MAP_FILE` hints and target statuses; `YandexBridge.syncTaskStatus()` stays idempotent.

- [ ] **Step 2: Do not change `config/trackerStatusMap.example.json` unless production status names differ**

The existing example already includes:

```json
{
  "in_progress": {
    "statuses": ["inProgress", "В работе"],
    "transition": "inProgress"
  }
}
```

If production Yandex Tracker uses a different transition key/display/id for "В работе", update the deployed `TRACKER_STATUS_MAP_FILE`, not the start-sync code.

### Task 5: Full verification

**Files:**
- No source edits expected in this task.

- [ ] **Step 1: Run strict TypeScript checks**

Run:

```bash
npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 3: Run the production build**

Run:

```bash
npm run build
```

Expected: `dist/` is generated successfully.

## Rollout Notes

- This change intentionally makes Yandex transition failure happen before Codex work starts in internal Yandex mode, matching direct Yandex mode's behavior more closely.
- If production still remains in `Открыт` after this fix, inspect the runtime `TRACKER_STATUS_MAP_FILE`: `in_progress.statuses` must match the actual status key/display, and `in_progress.transition` must match one of the available Yandex transition id/key/display/to.key/to.display values.
- Check logs for `No tracker transition found for logical status in_progress`; that indicates configuration/workflow mismatch, not the orchestration timing bug fixed by this plan.
