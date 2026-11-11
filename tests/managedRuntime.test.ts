import { expect, it, vi } from "vitest";
import { loadManagedBootstrap } from "../src/domain/settings/bootstrap.js";
import { ManagedRuntime } from "../src/domain/settings/runtime.js";
import { MemorySettingsStore } from "../src/domain/settings/store.js";
import { ManagedSettingsService } from "../src/domain/settings/service.js";
import { TokenCipher } from "../src/domain/settings/tokenCipher.js";
const key = Buffer.alloc(32, 3).toString("base64");
const env = { SETTINGS_ENCRYPTION_KEY: key, SETTINGS_WORKSPACE_ROOT: "/tmp/managed-runtime", TASK_TRACKER_DATABASE_URL: "postgres://test:test@localhost/test", SETTINGS_GITLAB_ORIGINS: "https://gitlab.test" };
it("starts a managed configuration with zero repositories and no GitLab token", () => {
  const result = loadManagedBootstrap(env);
  expect(result.fleet.repositories).toEqual([]);
  expect(result.fleet.gitlab.token).toBe("");
  expect(result.fleet.taskTracker?.provider).toBe("internal");
  expect(result.fleet.observability?.taskTrackerUi.enabled).toBe(true);
});
it("rejects mixed sources of truth and unsafe public localhost authentication", () => {
  expect(() => loadManagedBootstrap({ ...env, WORKER_CONFIG_FILE: "fleet.yml" })).toThrow();
  expect(() => loadManagedBootstrap({ ...env, TASK_TRACKER_PROVIDER: "yandex" })).toThrow();
  expect(() => loadManagedBootstrap({ ...env, OBSERVABILITY_HOST: "0.0.0.0", TASK_TRACKER_HUMAN_AUTH_MODE: "localhost" })).toThrow();
  expect(() => loadManagedBootstrap({ ...env, SETTINGS_ENCRYPTION_KEY: "" })).toThrow();
});

async function fixture() {
  const store = new MemorySettingsStore();
  const service = new ManagedSettingsService(store, new TokenCipher(key), {
    checkConnection: async () => {}, repositories: async () => ({ repositories: [], nextPage: null }),
    project: async () => ({ id: "42", name: "test", cloneUrl: "https://gitlab.test/test.git", defaultBranch: "main" }),
  }, { pathFor: id => `/tmp/${id}`, prepare: async () => {} }, ["https://gitlab.test"]);
  await service.addConnection({ name: "test", origin: "https://gitlab.test", token: "secret-test-token" }, 0, "admin");
  const connectionId = (await store.read()).connections[0]!.id;
  await service.saveProject(undefined, { name: "project", connectionId, gitlabProjectId: "42", baseBranch: "main", lintCommand: "lint", testCommand: "test" }, 1, "admin");
  const id = (await store.read()).projects[0]!.id;
  await service.setEnabled(id, true, 2, "admin");
  return { service, store, id };
}
it("takes new settings only after the current run, without restarting the process", async () => {
  const f = await fixture(); const seen: string[] = []; let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  const execute = vi.fn(async (snapshot) => {
    seen.push(snapshot.active.definition.testCommand);
    if (seen.length === 1) { started(); await new Promise<void>(r => { finish = r; }); }
    expect(snapshot.active.definition.testCommand).toBe(seen.at(-1));
  });
  const runtime = new ManagedRuntime(f.service, "worker", execute, async () => {}, async () => false);
  const first = runtime.runOnce(); await entered;
  const before = await f.store.read();
  await f.service.saveProject(f.id, { ...before.projects[0]!.desired, testCommand: "new-test" }, before.revision, "admin");
  expect(seen).toEqual(["test"]);
  finish(); await first; await runtime.runOnce();
  expect(seen).toEqual(["test", "new-test"]);
  expect((await f.store.workers())[0]?.revision).toBe(2);
});
it("pauses dispatch without cancelling the current run or deleting checkout", async () => {
  const f = await fixture(); const execute = vi.fn(async () => {});
  const runtime = new ManagedRuntime(f.service, "worker", execute, async () => {}, async () => false);
  await runtime.runOnce();
  await f.service.setEnabled(f.id, false, (await f.store.read()).revision, "admin");
  await runtime.runOnce(); expect(execute).toHaveBeenCalledTimes(1);
});
it("does not prepare or execute a checkout with abandoned execution", async () => {
  const f = await fixture(); const execute = vi.fn(async () => {});
  const runtime = new ManagedRuntime(f.service, "worker", execute, async () => {}, async () => true);
  await runtime.runOnce(); expect(execute).not.toHaveBeenCalled();
  expect((await f.store.read()).projects[0]?.active).toBeUndefined();
});

it("pins configuration for resume/review, while fresh tasks get a newer revision", async () => {
  const { pinManagedTaskConfiguration } = await import("../src/domain/settings/taskSnapshot.js");
  const { InMemoryTaskTrackerClient } = await import("../src/domain/taskTracker/index.js");
  const f = await fixture(); await f.service.applyPending(f.id);
  const tracker = new InMemoryTaskTrackerClient();
  const task = await tracker.createTask({ title: "Pinned task", description: "Resume must keep its original configuration.", createdBy: { owner: "human", id: "admin" }, repositoryName: f.id });
  const original = (await f.service.executionSnapshot(f.id))!;
  await pinManagedTaskConfiguration(tracker, task, original, "worker");
  const document = await f.store.read();
  await f.service.saveProject(f.id, { ...document.projects[0]!.desired, baseBranch: "develop", testCommand: "changed-tests" }, document.revision, "admin");
  await f.service.applyPending(f.id);
  const changed = (await f.service.executionSnapshot(f.id))!;
  const resumed = await pinManagedTaskConfiguration(tracker, await tracker.getTask(task.id), changed, "worker");
  expect(resumed.active.definition.baseBranch).toBe("main");
  expect(resumed.active.definition.testCommand).toBe("test");
  expect(resumed.active.revision).toBe(1);
  expect(JSON.stringify((await tracker.getTask(task.id)).events)).not.toContain("secret-test-token");
  const fresh = await tracker.createTask({ title: "Fresh task", description: "New config", createdBy: { owner: "human", id: "admin" } });
  expect((await pinManagedTaskConfiguration(tracker, fresh, changed, "worker")).active.revision).toBe(2);
});
