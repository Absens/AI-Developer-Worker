import { afterEach, expect, it } from "vitest";
import { createPostgresFixture, type PostgresFixture } from "./fixture.js";
import { PostgresSettingsStore } from "../../src/integrations/settings/postgresStore.js";
import { ManagedSettingsService } from "../../src/domain/settings/service.js";
import { TokenCipher } from "../../src/domain/settings/tokenCipher.js";
const fixtures: PostgresFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())); });
async function start() { const f = await createPostgresFixture(); fixtures.push(f); return f; }
function service(store: PostgresSettingsStore) {
  return new ManagedSettingsService(store, new TokenCipher(Buffer.alloc(32, 2).toString("base64")), {
    checkConnection: async () => {}, repositories: async () => ({ repositories: [], nextPage: null }),
    project: async () => ({ id: "42", name: "project", cloneUrl: "https://gitlab.test/a.git", defaultBranch: "main" }),
  }, { pathFor: id => `/tmp/${id}`, prepare: async () => {} }, ["https://gitlab.test"]);
}
it("migrates an empty managed registry and persists ciphertext across fresh connections", async () => {
  const f = await start(); const store = new PostgresSettingsStore(f.newPool()); const settings = service(store);
  expect((await store.read()).projects).toEqual([]);
  await settings.addConnection({ name: "test", origin: "https://gitlab.test", token: "not-a-real-private-token" }, 0, "administrator");
  const raw = await f.db.query("SELECT document FROM managed_settings");
  expect(JSON.stringify(raw.rows)).not.toContain("not-a-real-private-token");
  expect(JSON.stringify(await f.db.query("SELECT * FROM managed_settings_audit"))).not.toContain("not-a-real-private-token");
  await f.closePools();
  const reopened = service(new PostgresSettingsStore(f.newPool()));
  const view = await reopened.view();
  expect(view.connections).toHaveLength(1); expect(view.revision).toBe(1);
  expect(JSON.stringify(view)).not.toContain("encryptedToken");
  expect(await reopened.repositories(view.connections[0]!.id)).toEqual({ repositories: [], nextPage: null });
});
it("accepts only one of two independent concurrent settings revisions", async () => {
  const f = await start(); const a = new PostgresSettingsStore(f.newPool()); const b = new PostgresSettingsStore(f.newPool());
  const attempts = await Promise.allSettled([a.change(0, "a", "attempt_a", () => {}), b.change(0, "b", "attempt_b", () => {})]);
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const failure = attempts.find(result => result.status === "rejected");
  expect(failure).toMatchObject({ status: "rejected", reason: { status: 409 } });
  expect((await a.read()).revision).toBe(1);
  expect((await f.db.query("SELECT * FROM managed_settings_audit")).rows).toHaveLength(1);
});
it("serializes preparation and execution of a project across independent worker connections", async () => {
  const f = await start(); const a = new PostgresSettingsStore(f.newPool()); const b = new PostgresSettingsStore(f.newPool());
  let release!: () => void; let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const first = a.withProjectLock("project-a", async () => { enter(); await new Promise<void>(resolve => { release = resolve; }); });
  await entered;
  try {
    expect(await b.withProjectLock("project-a", async () => { throw new Error("must not execute"); })).toEqual({ acquired: false });
    expect(await b.withProjectLock("project-b", async () => "independent")).toEqual({ acquired: true, result: "independent" });
  } finally { release(); await first; }
  expect(await b.withProjectLock("project-a", async () => "recovered")).toEqual({ acquired: true, result: "recovered" });
});
it("records applied worker revisions without exposing credential values", async () => {
  const f = await start(); const a = new PostgresSettingsStore(f.newPool()); const b = new PostgresSettingsStore(f.newPool());
  await a.recordWorker({ workerId: "worker-a", projectId: "00000000-0000-4000-8000-000000000001", revision: 2, connectionRevision: 3, state: "ready", updatedAt: new Date().toISOString() });
  expect(await b.workers()).toMatchObject([{ revision: 2, connectionRevision: 3, state: "ready" }]);
});
it("rolls back invalid changes without advancing version or audit", async () => {
  const f = await start(); const store = new PostgresSettingsStore(f.newPool());
  await expect(store.change(0, "test", "failed", data => { data.revision = 10; throw new Error("reject"); })).rejects.toThrow("reject");
  expect((await store.read()).revision).toBe(0);
  expect((await f.db.query("SELECT * FROM managed_settings_audit")).rows).toHaveLength(0);
});
