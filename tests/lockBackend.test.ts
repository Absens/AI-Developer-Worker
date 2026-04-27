import { describe, expect, it } from "vitest";

import {
  NoopLockBackend,
  TrackerCommentLockBackend,
  withLeaseHeartbeat,
} from "../src/domain/lockBackend.js";
import {
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
import type {
  CommentWithMetadata,
  LeaseKind,
  LockBackend,
  LogicalStatus,
  TaskLease,
  TrackerClient,
  TrackerIssue,
} from "../src/models/types.js";

class FakeTrackerClient implements TrackerClient {
  readonly commentsByIssue: Record<string, CommentWithMetadata[]> = {};

  async checkReadAccess(): Promise<void> {
    return;
  }

  async findCandidateIssues(): Promise<TrackerIssue[]> {
    return [];
  }

  async findOwnedIssues(): Promise<TrackerIssue[]> {
    return [];
  }

  async getIssue(issueKey: string): Promise<TrackerIssue> {
    return {
      id: issueKey,
      key: issueKey,
      title: issueKey,
      description: "",
      logicalStatus: "open",
    };
  }

  async getComments(issueKey: string): Promise<CommentWithMetadata[]> {
    return this.commentsByIssue[issueKey] ?? [];
  }

  async addComment(issueKey: string, text: string): Promise<void> {
    const bucket = this.commentsByIssue[issueKey] ?? [];
    bucket.push({
      id: String(bucket.length + 1),
      text,
      createdAt: new Date(Date.UTC(2026, 3, 26, 10, bucket.length, 0)).toISOString(),
      isSystem: false,
      metadata: parseServiceComment(text),
    });
    this.commentsByIssue[issueKey] = bucket;
  }

  async transition(): Promise<void> {
    return;
  }

  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined {
    return issue.logicalStatus;
  }
}

const acquireInput = (overrides: {
  workerId?: string;
  now?: Date;
  ttlMs?: number;
} = {}) => ({
  issueKey: "FRONTEND-1",
  workerId: overrides.workerId ?? "worker-1",
  repositoryName: "frontend",
  repoPath: "/workspace/frontend",
  ttlMs: overrides.ttlMs ?? 15 * 60 * 1000,
  now: overrides.now ?? new Date("2026-04-26T10:00:00.000Z"),
});

describe("TrackerCommentLockBackend", () => {
  it("blocks another worker while a task lease is active", async () => {
    const tracker = new FakeTrackerClient();
    const backend = new TrackerCommentLockBackend(tracker, 15 * 60 * 1000);

    const lease = await backend.acquireTaskLease(acquireInput());
    const blocked = await backend.acquireTaskLease(
      acquireInput({
        workerId: "worker-2",
        now: new Date("2026-04-26T10:01:00.000Z"),
      }),
    );

    expect(lease?.workerId).toBe("worker-1");
    expect(blocked).toBeNull();
  });

  it("allows another worker to acquire an expired task lease", async () => {
    const tracker = new FakeTrackerClient();
    const backend = new TrackerCommentLockBackend(tracker, 60 * 1000);

    await backend.acquireTaskLease(acquireInput({ ttlMs: 60 * 1000 }));
    const lease = await backend.acquireTaskLease(
      acquireInput({
        workerId: "worker-2",
        ttlMs: 60 * 1000,
        now: new Date("2026-04-26T10:02:00.000Z"),
      }),
    );

    expect(lease?.workerId).toBe("worker-2");
  });

  it("renews and releases leases through Tracker comments", async () => {
    const tracker = new FakeTrackerClient();
    const backend = new TrackerCommentLockBackend(tracker, 15 * 60 * 1000);

    const lease = await backend.acquireRepositoryLease(acquireInput({ now: new Date() }));
    expect(lease?.kind).toBe("repository");

    const renewed = await backend.renewTaskLease(lease as TaskLease);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(lease?.expiresAt ?? ""),
    );

    await backend.releaseTaskLease(renewed);
    await expect(
      backend.getActiveLease("FRONTEND-1", {
        kind: "repository",
        leaseKey: renewed.leaseKey,
      }),
    ).resolves.toBeNull();
  });
});

describe("NoopLockBackend", () => {
  it("grants leases without writing Tracker comments", async () => {
    const tracker = new FakeTrackerClient();
    const backend = new NoopLockBackend();

    const taskLease = await backend.acquireTaskLease(acquireInput());
    const repositoryLease = await backend.acquireRepositoryLease(acquireInput());
    await backend.renewTaskLease(taskLease);
    await backend.releaseTaskLease(repositoryLease);

    expect(taskLease.kind).toBe("task");
    expect(repositoryLease.kind).toBe("repository");
    expect(tracker.commentsByIssue["FRONTEND-1"]).toBeUndefined();
    await expect(backend.getActiveLease("FRONTEND-1")).resolves.toBeNull();
  });
});

describe("withLeaseHeartbeat", () => {
  it("renews leases during long-running callbacks and releases them afterwards", async () => {
    const lease: TaskLease = {
      kind: "task",
      leaseKey: "task:FRONTEND-1",
      issueKey: "FRONTEND-1",
      workerId: "worker-1",
      repositoryName: "frontend",
      repoPath: "/workspace/frontend",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      token: "lease-token",
    };
    let renewals = 0;
    let releases = 0;
    const backend: LockBackend = {
      acquireTaskLease: async () => lease,
      acquireRepositoryLease: async () => lease,
      getActiveLease: async () => lease,
      renewTaskLease: async (input) => {
        renewals += 1;
        return {
          ...input,
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      releaseTaskLease: async () => {
        releases += 1;
      },
    };

    const result = await withLeaseHeartbeat(backend, [lease], 5, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "done";
    });

    expect(result).toBe("done");
    expect(renewals).toBeGreaterThan(0);
    expect(releases).toBe(1);
  });
});
