import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InMemoryTaskTrackerClient,
  LeaseOwnershipError,
} from "../src/domain/taskTracker/index.js";
import { PostgresTaskTrackerClient } from "../src/integrations/internalTracker/index.js";
import type {
  ClaimTaskInput,
  CreateTaskInput,
  TaskActor,
} from "../src/domain/taskTracker/index.js";

const human: TaskActor = {
  owner: "human",
  id: "user-1",
};

const createMutableClock = (initial = "2026-04-28T10:00:00.000Z") => {
  let current = new Date(initial);
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
};

const baseTaskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  id: "task-1",
  title: "Implement queue",
  description: "Claim an internal tracker task.",
  createdBy: human,
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  components: ["worker"],
  priority: "normal",
  status: "ready",
  taskType: "backend_endpoint",
  acceptanceCriteria: ["Task can be claimed."],
  ...overrides,
});

const claimInput = (overrides: Partial<ClaimTaskInput> = {}): ClaimTaskInput => ({
  workerId: "worker-1",
  repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
  leaseTtlSeconds: 60,
  ...overrides,
});

describe("internal task tracker queue", () => {
  it("prevents two workers from claiming the same task", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput());

    const claims = await Promise.all([
      client.claimNextTask(claimInput({ workerId: "worker-1" })),
      client.claimNextTask(claimInput({ workerId: "worker-2" })),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter(Boolean).map((claim) => claim?.task.id)).toEqual(["task-1"]);
  });

  it("prevents two active claims for the same repository lease key", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput({ id: "task-1", title: "First" }));
    await client.createTask(baseTaskInput({ id: "task-2", title: "Second" }));

    const first = await client.claimNextTask(claimInput({ workerId: "worker-1" }));
    const second = await client.claimNextTask(claimInput({ workerId: "worker-2" }));

    expect(first?.task.id).toBe("task-1");
    expect(second).toBeNull();
  });

  it("allows another worker to reclaim a task after its task lease expires", async () => {
    const clock = createMutableClock();
    const client = new InMemoryTaskTrackerClient({ now: clock.now });
    await client.createTask(baseTaskInput());

    const first = await client.claimNextTask(claimInput({ leaseTtlSeconds: 10 }));
    clock.advance(11_000);
    const second = await client.claimNextTask(
      claimInput({ workerId: "worker-2", leaseTtlSeconds: 10 }),
    );

    expect(first?.taskLease.workerId).toBe("worker-1");
    expect(second?.task.id).toBe("task-1");
    expect(second?.taskLease.workerId).toBe("worker-2");
    expect(second?.taskLease.leaseId).not.toBe(first?.taskLease.leaseId);
  });

  it("allows another task to be claimed after the repository lease expires", async () => {
    const clock = createMutableClock();
    const client = new InMemoryTaskTrackerClient({ now: clock.now });
    await client.createTask(baseTaskInput({ id: "task-1", title: "First" }));
    await client.createTask(baseTaskInput({ id: "task-2", title: "Second" }));

    const first = await client.claimNextTask(claimInput({ leaseTtlSeconds: 10 }));
    clock.advance(11_000);
    const second = await client.claimNextTask(
      claimInput({
        workerId: "worker-2",
        targetExternalKey: "task-2",
        leaseTtlSeconds: 10,
      }),
    );

    expect(first?.repositoryLease.workerId).toBe("worker-1");
    expect(second?.task.id).toBe("task-2");
    expect(second?.repositoryLease.workerId).toBe("worker-2");
  });

  it("extends heartbeat expiry only for the matching worker and token", async () => {
    const clock = createMutableClock();
    const client = new InMemoryTaskTrackerClient({ now: clock.now });
    await client.createTask(baseTaskInput());
    const claim = await client.claimNextTask(claimInput({ leaseTtlSeconds: 10 }));

    await expect(
      client.heartbeatLease(claim?.taskLease.leaseId ?? "", {
        workerId: "worker-2",
        token: claim?.taskLease.token ?? "",
        leaseTtlSeconds: 30,
      }),
    ).rejects.toThrow(LeaseOwnershipError);

    const originalExpiry = claim?.taskLease.expiresAt ?? "";
    clock.advance(5_000);
    const renewed = await client.heartbeatLease(claim?.taskLease.leaseId ?? "", {
      workerId: "worker-1",
      token: claim?.taskLease.token ?? "",
      leaseTtlSeconds: 30,
    });

    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(originalExpiry));
  });

  it("releases leases idempotently", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput({ id: "task-1", title: "First" }));
    await client.createTask(baseTaskInput({ id: "task-2", title: "Second" }));
    const claim = await client.claimNextTask(claimInput());

    await client.releaseLease(claim?.repositoryLease.leaseId ?? "", {
      workerId: "worker-1",
      token: claim?.repositoryLease.token ?? "",
      idempotencyKey: "release-repo",
    });
    await client.releaseLease(claim?.repositoryLease.leaseId ?? "", {
      workerId: "worker-1",
      token: claim?.repositoryLease.token ?? "",
      idempotencyKey: "release-repo",
    });

    const next = await client.claimNextTask(
      claimInput({ workerId: "worker-2", targetExternalKey: "task-2" }),
    );
    expect(next?.task.id).toBe("task-2");
  });

  it("returns the same claim response for a repeated idempotency key", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput());

    const first = await client.claimNextTask(
      claimInput({ workerId: "worker-1", idempotencyKey: "claim-once" }),
    );
    const repeated = await client.claimNextTask(
      claimInput({ workerId: "worker-2", idempotencyKey: "claim-once" }),
    );

    expect(repeated?.task.id).toBe(first?.task.id);
    expect(repeated?.taskLease.leaseId).toBe(first?.taskLease.leaseId);
    expect(repeated?.repositoryLease.leaseId).toBe(first?.repositoryLease.leaseId);
  });

  it("claims the highest scored eligible task first", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(
      baseTaskInput({
        id: "low",
        priority: "low",
        createdAt: "2026-04-01T10:00:00.000Z",
      }),
    );
    await client.createTask(
      baseTaskInput({
        id: "high",
        priority: "high",
        createdAt: "2026-04-20T10:00:00.000Z",
      }),
    );

    const claim = await client.claimNextTask(claimInput());

    expect(claim?.task.id).toBe("high");
  });

  it("does not claim tasks outside the worker repository tag profile", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput({ id: "old", tags: ["ai_dev"] }));
    await client.createTask(baseTaskInput({ id: "live", tags: ["ai_dev_docker_test"] }));

    const claim = await client.claimNextTask(
      claimInput({
        repositoryProfiles: [
          {
            name: "developer",
            repoPathKey: "developer",
            queues: ["DEV"],
            tags: ["ai_dev_docker_test"],
          },
        ],
      }),
    );

    expect(claim?.task.id).toBe("live");
  });

  it("does not claim a task with an active blocking dependency", async () => {
    const client = new InMemoryTaskTrackerClient();
    await client.createTask(baseTaskInput({ id: "blocked" }));
    await client.createTask(
      baseTaskInput({
        id: "blocker",
        repositoryName: "docs",
        repoPathKey: "docs",
        queue: "DOCS",
        status: "new",
      }),
    );
    await client.addDependency({
      fromTaskId: "blocked",
      toTaskId: "blocker",
      kind: "blocked_by",
      reason: "Blocker must finish first.",
    });

    await expect(client.claimNextTask(claimInput())).resolves.toBeNull();
  });

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
});

const testDatabaseUrl = process.env.TASK_TRACKER_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("PostgresTaskTrackerClient queue", () => {
  let pg: Client;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `phase7b_${randomUUID().replace(/-/g, "")}`;
    pg = new Client({ connectionString: testDatabaseUrl });
    await pg.connect();
    await pg.query(`CREATE SCHEMA ${schemaName}`);
    await pg.query(`SET search_path TO ${schemaName}`);

    const migrationDir = new URL(
      "../src/integrations/internalTracker/migrations/",
      import.meta.url,
    );
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
      await pg.query(readFileSync(new URL(file, migrationDir), "utf8"));
    }
  });

  afterEach(async () => {
    await pg.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    await pg.end().catch(() => undefined);
  });

  it("claims, heartbeats, and releases through PostgreSQL storage", async () => {
    const clock = createMutableClock();
    const client = new PostgresTaskTrackerClient(pg, { now: clock.now });
    await client.createTask(baseTaskInput({ id: "pg-task", priority: "high" }));

    const claim = await client.claimNextTask(
      claimInput({ idempotencyKey: "pg-claim", leaseTtlSeconds: 10 }),
    );
    const repeated = await client.claimNextTask(
      claimInput({ workerId: "worker-2", idempotencyKey: "pg-claim" }),
    );

    expect(claim?.task.id).toBe("pg-task");
    expect(repeated?.taskLease.leaseId).toBe(claim?.taskLease.leaseId);

    clock.advance(5_000);
    const renewed = await client.heartbeatLease(claim?.taskLease.leaseId ?? "", {
      workerId: "worker-1",
      token: claim?.taskLease.token ?? "",
      leaseTtlSeconds: 30,
    });
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(
      Date.parse(claim?.taskLease.expiresAt ?? ""),
    );

    await client.releaseLease(claim?.repositoryLease.leaseId ?? "", {
      workerId: "worker-1",
      token: claim?.repositoryLease.token ?? "",
    });
    await client.releaseLease(claim?.repositoryLease.leaseId ?? "", {
      workerId: "worker-1",
      token: claim?.repositoryLease.token ?? "",
    });
  });

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
});
