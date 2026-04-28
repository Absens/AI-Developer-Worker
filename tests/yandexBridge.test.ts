import { describe, expect, it } from "vitest";

import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/index.js";
import {
  InMemoryYandexBridgeStore,
  YANDEX_TRACKER_PROVIDER,
  YandexBridge,
  issueToSnapshot,
  type YandexBridgeExternalSource,
} from "../src/integrations/yandexBridge/index.js";
import {
  formatDigestComment,
  formatQuestionComment,
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
import type {
  CommentWithMetadata,
  CreateTrackerIssueInput,
  ExportDigestInput,
  ExternalIssueSnapshot,
  ExternalTransitionInput,
  ImportCandidatesInput,
  LinkTrackerIssueInput,
  LogicalStatus,
  TrackerIssue,
} from "../src/models/types.js";

const repository = {
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queues: ["DEV"],
  tags: ["ai_dev"],
};

const createClock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 3, 28, 10, tick++, 0));
};

const issue = (overrides: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: "1",
  key: "DEV-1",
  title: "Yandex task",
  description: "Original description.",
  queue: "DEV",
  statusKey: "open",
  statusDisplay: "Open",
  logicalStatus: "open",
  priority: "normal",
  deadline: "2026-05-01T00:00:00.000Z",
  tags: ["ai_dev"],
  components: ["worker"],
  createdAt: "2026-04-28T09:00:00.000Z",
  updatedAt: "2026-04-28T09:00:00.000Z",
  ...overrides,
});

class FakeYandexSource implements YandexBridgeExternalSource {
  snapshots: ExternalIssueSnapshot[];
  comments = new Map<string, CommentWithMetadata[]>();
  digests: ExportDigestInput[] = [];
  transitions: ExternalTransitionInput[] = [];
  createdIssues: CreateTrackerIssueInput[] = [];
  links: LinkTrackerIssueInput[] = [];

  constructor(issues: TrackerIssue[]) {
    this.snapshots = issues.map((entry) =>
      issueToSnapshot(entry, "2026-04-28T10:00:00.000Z"),
    );
  }

  async importCandidates(_input: ImportCandidatesInput) {
    return this.snapshots;
  }

  async exportDigest(input: ExportDigestInput) {
    this.digests.push(input);
  }

  async transitionExternal(input: ExternalTransitionInput) {
    this.transitions.push(input);
  }

  async getComments(externalKey: string) {
    return this.comments.get(externalKey) ?? [];
  }

  async createIssue(input: CreateTrackerIssueInput) {
    this.createdIssues.push(input);
    const key = `DEV-${100 + this.createdIssues.length}`;
    return issue({
      id: key,
      key,
      title: input.title,
      description: input.description,
      tags: input.tags,
      logicalStatus: "open",
    });
  }

  async linkIssue(input: LinkTrackerIssueInput) {
    this.links.push(input);
  }
}

const createBridge = (source: FakeYandexSource, tracker = new InMemoryTaskTrackerClient({
  now: createClock(),
})) => {
  const store = new InMemoryYandexBridgeStore();
  const bridge = new YandexBridge({
    taskTracker: tracker,
    source,
    store,
    repository,
    workerId: "worker-1",
    now: createClock(),
  });

  return { bridge, tracker, store };
};

describe("Yandex bridge", () => {
  it("imports Yandex issues idempotently into internal tasks", async () => {
    const source = new FakeYandexSource([issue()]);
    const { bridge, tracker } = createBridge(source);

    await bridge.importCandidates();
    await bridge.importCandidates();

    const task = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
    expect(task).toMatchObject({
      id: "yt_DEV-1",
      title: "Yandex task",
      source: {
        kind: "external",
        provider: YANDEX_TRACKER_PROVIDER,
        externalKey: "DEV-1",
      },
      status: "ready",
      repositoryName: "developer",
    });
    expect(task?.revisions).toHaveLength(1);
  });

  it("does not create ready internal tasks for non-open Yandex issues", async () => {
    const source = new FakeYandexSource([
      issue({
        statusKey: "testing",
        statusDisplay: "Тестируется",
        logicalStatus: "review",
      }),
    ]);
    const { bridge, tracker } = createBridge(source);

    const result = await bridge.importCandidates();

    expect(result).toMatchObject({ created: 0, updated: 0, commentsImported: 0 });
    await expect(
      tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1"),
    ).resolves.toBeNull();
  });

  it("does not create ready internal tasks when Yandex status is unmapped", async () => {
    const source = new FakeYandexSource([
      issue({
        statusKey: "customTesting",
        statusDisplay: "Custom testing status",
        logicalStatus: undefined,
      }),
    ]);
    const { bridge, tracker } = createBridge(source);

    const result = await bridge.importCandidates();

    expect(result).toMatchObject({ created: 0, updated: 0, commentsImported: 0 });
    await expect(
      tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1"),
    ).resolves.toBeNull();
  });

  it("creates a reanalysis revision for changed Yandex human input during active work", async () => {
    const source = new FakeYandexSource([issue()]);
    const { bridge, tracker } = createBridge(source);

    await bridge.importCandidates();
    const task = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
    if (!task) {
      throw new Error("Expected imported task.");
    }
    await tracker.claimNextTask({
      workerId: "worker-1",
      repositoryProfiles: [{ name: "developer", queues: ["DEV"], tags: ["ai_dev"] }],
      leaseTtlSeconds: 60,
    });
    source.snapshots = [
      issueToSnapshot(
        issue({
          description: "Updated description.",
          updatedAt: "2026-04-28T09:30:00.000Z",
        }),
        "2026-04-28T10:05:00.000Z",
      ),
    ];

    await bridge.importCandidates();

    const updated = await tracker.getTask(task.id);
    expect(updated.status).toBe("claimed");
    expect(updated.revisions).toHaveLength(2);
    expect(updated.revisions[1]).toMatchObject({
      owner: "external_source",
      description: "Updated description.",
      requiresReanalysis: true,
    });
    expect(updated.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "context_changed",
          payload: expect.objectContaining({ requiresReanalysis: true }),
        }),
      ]),
    );
  });

  it("updates Yandex-owned derived fields without replacing runtime records", async () => {
    const source = new FakeYandexSource([issue()]);
    const { bridge, tracker } = createBridge(source);

    await bridge.importCandidates();
    const task = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
    if (!task) {
      throw new Error("Expected imported task.");
    }
    await tracker.recordDecision(task.id, {
      kind: "analysis",
      schemaVersion: 1,
      source: "worker_agent",
      payload: { confidence: 80 },
    });
    await tracker.recordTaskStep(task.id, { kind: "analyze", status: "done" });
    source.snapshots = [
      issueToSnapshot(
        issue({
          priority: "critical",
          deadline: "2026-04-29T00:00:00.000Z",
          tags: ["ai_dev", "urgent"],
          components: ["bridge"],
        }),
        "2026-04-28T10:05:00.000Z",
      ),
    ];

    await bridge.importCandidates();

    const updated = await tracker.getTask(task.id);
    expect(updated).toMatchObject({
      priority: "critical",
      deadline: "2026-04-29T00:00:00.000Z",
      components: ["bridge"],
    });
    expect(updated.tags.sort()).toEqual(["ai_dev", "urgent"]);
    expect(updated.decisions).toHaveLength(1);
    expect(updated.plans[0]?.steps).toEqual([
      expect.objectContaining({ kind: "analyze", status: "done" }),
    ]);
  });

  it("imports slash commands and ignores its own digest comments", async () => {
    const source = new FakeYandexSource([issue()]);
    source.comments.set("DEV-1", [
      {
        id: "digest-1",
        text: formatDigestComment("worker-1", {
          taskId: "yt_DEV-1",
          digestKind: "task_started",
          details: "Started.",
          externalKey: "DEV-1",
        }),
        createdAt: "2026-04-28T10:01:00.000Z",
        isSystem: false,
        metadata: parseServiceComment(
          formatDigestComment("worker-1", {
            taskId: "yt_DEV-1",
            digestKind: "task_started",
            details: "Started.",
            externalKey: "DEV-1",
          }),
        ),
      },
      {
        id: "human-1",
        text: "/resume A",
        createdAt: "2026-04-28T10:02:00.000Z",
        author: "User",
        isSystem: false,
      },
    ]);
    const { bridge, tracker } = createBridge(source);

    await bridge.importCandidates();

    const task = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
    expect(task?.humanAnswers).toEqual([
      expect.objectContaining({
        body: "/resume A",
        command: { type: "resume", rawText: "/resume A", choice: "A" },
      }),
    ]);
    expect(task?.comments.some((comment) => comment.body?.startsWith("AI DIGEST"))).toBe(
      false,
    );
  });

  it("imports a direct human answer after the latest AI question", async () => {
    const source = new FakeYandexSource([issue()]);
    const { bridge, tracker } = createBridge(source);

    await bridge.importCandidates();
    const task = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
    if (!task) {
      throw new Error("Expected imported task.");
    }
    await tracker.askClarification(task.id, {
      workerId: "worker-1",
      summary: "Need choice.",
      blockingReason: "Ambiguous.",
      question: "Use API v1 or v2?",
      options: ["v1", "v2"],
      resumeHint: "Reply with /resume.",
    });
    source.comments.set("DEV-1", [
      {
        id: "answer-1",
        text: "Use v2.",
        createdAt: "2026-04-28T10:30:00.000Z",
        author: "User",
        isSystem: false,
      },
    ]);

    await bridge.importCandidates();

    const updated = await tracker.getTask(task.id);
    expect(updated.humanAnswers).toEqual([
      expect.objectContaining({
        body: "Use v2.",
        questionId: updated.comments.find((comment) => comment.kind === "question")?.id,
      }),
    ]);
  });

  it("exports digest comments idempotently and syncs status", async () => {
    const source = new FakeYandexSource([issue()]);
    const { bridge, tracker } = createBridge(source);

    await bridge.importCandidates();
    const claim = await tracker.claimNextTask({
      workerId: "worker-1",
      repositoryProfiles: [{ name: "developer", queues: ["DEV"], tags: ["ai_dev"] }],
      leaseTtlSeconds: 60,
    });
    if (!claim) {
      throw new Error("Expected claim.");
    }
    await tracker.askClarification(claim.task.id, {
      workerId: "worker-1",
      summary: "Need choice.",
      blockingReason: "Ambiguous.",
      question: "Use API v1 or v2?",
      options: ["v1", "v2"],
      resumeHint: "Reply with /resume.",
    });

    await bridge.exportTaskDigests(claim.task.id);
    await bridge.exportTaskDigests(claim.task.id);
    await bridge.syncTaskStatus(claim.task.id);
    await bridge.syncTaskStatus(claim.task.id);

    expect(source.digests).toHaveLength(2);
    expect(source.digests.map((digest) => digest.digest)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("AI DIGEST:"),
        expect.stringContaining("Use API v1 or v2?"),
      ]),
    );
    expect(source.transitions).toEqual([
      expect.objectContaining({
        externalKey: "DEV-1",
        targetBusinessStatus: "in_progress" satisfies LogicalStatus,
      }),
    ]);
  });

  it("does not mirror child tasks by default, but mirrors approved children", async () => {
    const source = new FakeYandexSource([issue()]);
    const { bridge, tracker } = createBridge(source);

    await bridge.importCandidates();
    const parent = await tracker.findTaskByExternalRef(YANDEX_TRACKER_PROVIDER, "DEV-1");
    if (!parent) {
      throw new Error("Expected imported parent.");
    }
    const child = await tracker.createTask({
      id: "child-1",
      title: "Child task",
      description: "Do child work.",
      createdBy: { owner: "human", id: "approver" },
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queue: "DEV",
      tags: ["ai_dev"],
      status: "ready",
      acceptanceCriteria: ["Done."],
    });
    await tracker.linkDependency({
      fromTaskId: parent.id,
      toTaskId: child.id,
      kind: "parent_child",
      reason: "Split.",
    });

    expect(await bridge.mirrorApprovedChildTasks(parent.id)).toBe(0);
    expect(source.createdIssues).toHaveLength(0);

    await tracker.recordDecision(parent.id, {
      kind: "manual",
      schemaVersion: 1,
      source: "human",
      payload: { yandexBridge: { approveChildMirroring: true } },
    });
    expect(await bridge.mirrorApprovedChildTasks(parent.id)).toBe(1);

    const mirrored = await tracker.getTask(child.id);
    expect(mirrored.externalRefs).toEqual([
      expect.objectContaining({
        provider: YANDEX_TRACKER_PROVIDER,
        externalKey: "DEV-101",
      }),
    ]);
    expect(source.links).toEqual([
      expect.objectContaining({
        sourceIssueKey: "DEV-1",
        targetIssueKey: "DEV-101",
      }),
    ]);
  });

  it("parses bridge digest comments as service comments", () => {
    const digest = formatDigestComment("worker-1", {
      taskId: "yt_DEV-1",
      digestKind: "mr_ready",
      details: "Merge Request ready.",
      externalKey: "DEV-1",
    });

    expect(parseServiceComment(digest)).toMatchObject({
      kind: "AI DIGEST",
      worker: "worker-1",
      taskId: "yt_DEV-1",
      digestKind: "mr_ready",
      externalKey: "DEV-1",
    });
    expect(parseServiceComment(formatQuestionComment("worker-1", "Question?"))).toMatchObject({
      kind: "AI QUESTION",
    });
  });
});
