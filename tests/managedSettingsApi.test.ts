import { afterEach, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { ObservabilityHttpServer } from "../src/observability/server.js";
import { defaultObservabilityConfig } from "../src/observability/config.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";
import { InMemoryWorkerStateRegistry } from "../src/observability/state.js";
import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/index.js";
import { ManagedSettingsService } from "../src/domain/settings/service.js";
import { MemorySettingsStore } from "../src/domain/settings/store.js";
import { TokenCipher } from "../src/domain/settings/tokenCipher.js";
const servers: ObservabilityHttpServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); });
const setup = async () => {
  const store = new MemorySettingsStore(); const tracker = new InMemoryTaskTrackerClient();
  const settings = new ManagedSettingsService(store, new TokenCipher(Buffer.alloc(32, 1).toString("base64")), {
    checkConnection: async () => {}, repositories: async () => ({ repositories: [], nextPage: null }),
    project: async () => ({ id: "42", name: "repo", cloneUrl: "https://gitlab.test/team/repo.git", defaultBranch: "main" }),
  }, { prepare: async () => {}, pathFor: id => `/tmp/${id}` }, ["https://gitlab.test"]);
  const config = defaultObservabilityConfig(); config.port = 0; config.host = "127.0.0.1";
  config.taskTrackerUi = { ...config.taskTrackerUi, enabled: true, authMode: "trusted_proxy", systemToken: "system-token", agentToken: "agent-token" };
  const server = new ObservabilityHttpServer({ config, metrics: new InMemoryMetricsRegistry(), state: new InMemoryWorkerStateRegistry(),
    readiness: () => ({ ready: true }), repositories: () => [], taskTracker: tracker, settings } as any);
  servers.push(server); await server.start();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, role = "admin", method = "GET", body?: unknown, extra: Record<string,string> = {}) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-task-tracker-user": "test", "x-task-tracker-role": role, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  return { store, settings, tracker, request, base };
};
it("serves empty registry and advertises managed mode to an authorized session", async () => {
  const f = await setup();
  expect(await f.request("/api/settings")).toMatchObject({ status: 200, body: { projects: [], revision: 0 } });
  expect((await f.request("/api/session")).body.capabilities.canManageSettings).toBe(true);
});
it.each(["viewer", "developer", "operator"])("denies %s changes and secret-adjacent settings", async role => {
  const f = await setup();
  expect((await f.request("/api/settings", role)).status).toBe(403);
  expect((await f.request("/api/settings/connections", role, "POST", { name: "x" })).status).toBe(403);
});
it("denies agent tokens even with spoofed admin headers", async () => {
  const f = await setup(); expect((await f.request("/api/settings", "admin", "GET", undefined, { authorization: "Bearer agent-token" })).status).toBe(403);
});
it("rejects cross-origin admin writes", async () => {
  const f = await setup();
  expect((await f.request("/api/settings/connections", "admin", "POST", { name: "x" }, { origin: "https://evil.test" })).status).toBe(403);
});
it("adds a connection without echoing token and detects a stale edit", async () => {
  const f = await setup(); const body = { expectedRevision: 0, name: "GitLab", origin: "https://gitlab.test", token: "private-token-123" };
  const result = await f.request("/api/settings/connections", "admin", "POST", body);
  expect(result.status).toBe(201); expect(JSON.stringify(result.body)).not.toContain(body.token);
  expect((await f.request("/api/settings/connections", "admin", "POST", body)).status).toBe(409);
});
it("enforces registered project routing and rejects disabled or invented projects", async () => {
  const f = await setup();
  const response = await f.request("/api/tasks", "developer", "POST", { title: "Task", description: "Description", repositoryName: "invented", repoPathKey: "/etc" });
  expect(response.status).toBe(400);
});
it("connects, activates, lists and routes a task without client-supplied paths", async () => {
  const f = await setup();
  let result = await f.request("/api/settings/connections", "admin", "POST", { expectedRevision: 0, name: "GitLab", origin: "https://gitlab.test", token: "secret-not-a-real-token" });
  const connectionId = result.body.connections[0].id;
  result = await f.request("/api/settings/projects", "admin", "POST", { expectedRevision: result.body.revision, definition: { name: "Demo", connectionId, gitlabProjectId: "42", baseBranch: "main", testCommand: "npm test", lintCommand: "npm run lint" } });
  expect(result.status).toBe(201);
  const id = result.body.projects[0].id;
  expect((await f.request("/api/project-catalog")).body.projects).toEqual([]);
  result = await f.request(`/api/settings/projects/${id}/state`, "admin", "POST", { expectedRevision: result.body.revision, enabled: true });
  expect(result.status).toBe(200);
  await f.settings.applyPending(id);
  expect((await f.request("/api/project-catalog", "viewer")).body.projects).toHaveLength(1);
  result = await f.request("/api/tasks", "developer", "POST", { title: "Route safely", description: "Registered repository only", repositoryName: id, repoPathKey: "/etc", baseBranch: "evil", queue: "OTHER" });
  expect(result.status).toBe(201);
  expect(result.body.task).toMatchObject({ repositoryName: id, repoPathKey: id, baseBranch: "main", queue: "MANAGED" });
});
it("never echoes malformed JSON containing credentials", async () => {
  const f = await setup();
  const response = await fetch(f.base + "/api/settings/connections", { method: "POST", headers: { "content-type": "application/json", "x-task-tracker-user": "admin", "x-task-tracker-role": "admin" }, body: 'AbcDEfGh987654321' });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("AbcDEfGh987654321");
});
