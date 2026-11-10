import { describe, expect, it } from "vitest";
import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/inMemoryTaskTracker.js";
import type { TaskStatus } from "../src/domain/taskTracker/types.js";

const paths: Record<string, TaskStatus[]> = {
  analyzing: ["analyzing"],
  implementing: ["analyzing", "implementing"],
  validating: ["analyzing", "implementing", "validating"],
  decomposing: ["analyzing", "decomposing"],
  fixing_review: ["analyzing", "implementing", "validating", "review", "fixing_review"],
};
const setup = async (status: string) => {
  let now = new Date("2026-11-10T00:00:00Z");
  const tracker = new InMemoryTaskTrackerClient({ now: () => now });
  for (const [id, repository] of [["orphan", "a"], ["same", "a"], ["other", "b"]]) {
    await tracker.createTask({
      id: id!, title: id!, description: "test", createdBy: { owner: "human", id: "operator" },
      repositoryName: repository!, repoPathKey: repository!, baseBranch: "main", queue: "DEV", status: "ready",
      taskType: "unknown", acceptanceCriteria: ["check"],
    });
  }
  const claim = (id: string, repository = "a") => tracker.claimNextTask({
    workerId: id === "orphan" ? "previous" : "next", targetExternalKey: id,
    repositoryProfiles: [{ name: repository }], leaseTtlSeconds: 10,
  });
  const owned = await claim("orphan");
  if (!owned) throw new Error("Fixture failed to claim");
  for (const step of paths[status]!) await tracker.setStatus("orphan", step);
  return { tracker, owned, claim, expire: () => { now = new Date(now.getTime() + 11_000); } };
};

describe("abandoned execution checkout exclusion", () => {
  it.each(Object.keys(paths))("does not hand off %s or its checkout just because leases expired", async (state) => {
    const f = await setup(state);
    f.expire();
    expect(await f.claim("orphan")).toBeNull();
    expect(await f.claim("same")).toBeNull();
    expect((await f.claim("other", "b"))?.task.id).toBe("other");
    expect((await f.tracker.getTask("orphan")).status).toBe(state);
  });
});

const confirmation = (expectedStatus: TaskStatus) => ({
  actor: { owner: "human" as const, id: "operator" }, expectedStatus,
  previousExecutorStopped: true, reason: "Stopped and verified previous executor and its child processes.",
});

describe("operator-confirmed recovery", () => {
  it.each(Object.keys(paths))("recovers %s only with explicit confirmation after expiry", async (state) => {
    const f = await setup(state);
    await expect(f.tracker.recoverAbandonedTask("orphan", confirmation(state as TaskStatus))).rejects.toThrow(/active leases/);
    f.expire();
    const recovered = await f.tracker.recoverAbandonedTask("orphan", confirmation(state as TaskStatus));
    expect(recovered.status).toBe(state === "fixing_review" ? "review" : "ready");
    expect(recovered.events.at(-1)?.payload).toMatchObject({ recovery: "operator_confirmed", previousExecutorStopped: true });
    await expect(f.tracker.recoverAbandonedTask("orphan", confirmation(state as TaskStatus))).rejects.toThrow(/state changed/);
    await expect(f.tracker.heartbeatLease(f.owned.taskLease.leaseId, {
      workerId: "previous", token: f.owned.taskLease.token, leaseTtlSeconds: 60,
    })).rejects.toThrow();
  });
  it.each([
    { previousExecutorStopped: false },
    { reason: "  " },
    { actor: { owner: "worker_agent" as const, id: "old-worker" } },
    { expectedStatus: "ready" as const },
  ])("rejects invalid recovery confirmation %# without changing the task", async (invalid) => {
    const f = await setup("analyzing");
    f.expire();
    await expect(f.tracker.recoverAbandonedTask("orphan", { ...confirmation("analyzing"), ...invalid })).rejects.toThrow();
    expect((await f.tracker.getTask("orphan")).status).toBe("analyzing");
  });
  it("also excludes review claims while a different task owns an abandoned execution", async () => {
    const f = await setup("analyzing");
    for (const status of ["claimed", "analyzing", "implementing", "validating", "review"] as const) {
      await f.tracker.setStatus("same", status);
    }
    f.expire();
    expect(await f.tracker.claimReviewTask({
      taskId: "same", workerId: "reviewer", repositoryProfiles: [{ name: "a" }], leaseTtlSeconds: 60,
    })).toBeNull();
  });
});
