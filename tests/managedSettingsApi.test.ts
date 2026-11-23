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
const setup = async (authMode: "trusted_proxy" | "bearer" = "trusted_proxy") => {
  const store = new MemorySettingsStore(); const tracker = new InMemoryTaskTrackerClient();
  const settings = new ManagedSettingsService(store, new TokenCipher(Buffer.alloc(32, 1).toString("base64")), {
    checkConnection: async () => {}, repositories: async () => ({ repositories: [], nextPage: null }),
    project: async (origin, _token, id) => {
      const name = id === "42" ? "team/platform/console" : "team/worker";
      return { id, name, cloneUrl: `${origin}/${name}.git`, defaultBranch: "main" };
    },
  }, { prepare: async () => {}, pathFor: id => `/tmp/${id}` }, ["https://gitlab.test", "https://gitlab.test:8443"]);
  const config = defaultObservabilityConfig(); config.port = 0; config.host = "127.0.0.1";
  config.taskTrackerUi = { ...config.taskTrackerUi, enabled: true, authMode, systemToken: "system-token", agentToken: "agent-token" };
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

const enableProject = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  connectionId: string,
  gitlabProjectId: string,
  baseBranch: string,
  headers: Record<string, string> = {},
) => {
  const definition = {
    name: "Demo", connectionId, gitlabProjectId, baseBranch,
    testCommand: "private-test-command", lintCommand: "private-lint-command",
  };
  const draft = await fixture.request("/api/settings/projects", "admin", "POST", {
    expectedRevision: (await fixture.store.read()).revision, definition,
  }, headers);
  expect(draft.status).toBe(201);
  const { id } = draft.body.projects.at(-1);
  const enabled = await fixture.request(`/api/settings/projects/${id}/state`, "admin", "POST", {
    expectedRevision: draft.body.revision, enabled: true,
  }, headers);
  expect(enabled.status).toBe(200);
  return { id, definition };
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
it("validates, stores and applies optional project checks through the settings API", async () => {
  const f = await setup();
  const connection = await f.request("/api/settings/connections", "admin", "POST", {
    expectedRevision: 0, name: "GitLab", origin: "https://gitlab.test", token: "fixture-token",
  });
  const project = await enableProject(f, connection.body.connections[0].id, "42", "main");
  await f.settings.applyPending(project.id);
  const projectPath = `/api/settings/projects/${project.id}`;
  const expectedRevision = (await f.store.read()).revision;
  const invalid = await f.request(projectPath, "admin", "PUT", {
    expectedRevision, definition: { ...project.definition, coverageCommand: "coverage", coverageReportFile: "../summary.json" },
  });
  expect(invalid).toMatchObject({ status: 400, body: { error: expect.stringContaining("относительный путь") } });
  expect((await f.store.read()).revision).toBe(expectedRevision);

  const options = {
    securityScanCommand: "scan",
    sastCommand: "sast",
    coverageCommand: "coverage",
    coverageReportFile: "coverage/summary.json",
    minCoveragePercent: 78.5,
    visualRegressionCommand: "visual",
    maxReviewFixAttempts: 0,
  };
  const saved = await f.request(projectPath, "admin", "PUT", { expectedRevision, definition: { ...project.definition, ...options } });
  expect(saved).toMatchObject({
    status: 200, body: { projects: [{
      id: project.id, desired: options, active: { revision: 1 }, status: "pending",
    }] },
  });
  await f.settings.applyPending(project.id);
  expect((await f.settings.executionSnapshot(project.id))?.active).toMatchObject({ revision: 2, definition: options });
});
it("lists and routes two distinct active repositories, observes applied changes and rejects paused projects", async () => {
  const f = await setup();
  const connection = await f.request("/api/settings/connections", "admin", "POST", {
    expectedRevision: 0, name: "GitLab", origin: "https://gitlab.test:8443", token: "secret-not-a-real-token",
  });
  expect(connection.status).toBe(201);
  const connectionId = connection.body.connections[0].id;
  const consoleProject = await enableProject(f, connectionId, "42", "main");
  const workerProject = await enableProject(f, connectionId, "43", "develop");
  expect((await f.request("/api/project-catalog", "viewer")).body.projects).toEqual([]);
  await f.settings.applyPending(consoleProject.id);
  await f.settings.applyPending(workerProject.id);

  const catalog = await f.request("/api/project-catalog", "viewer");
  expect(catalog).toEqual({
    status: 200, body: { managed: true, projects: [
      { id: consoleProject.id, name: "Demo", repositoryName: consoleProject.id, repoPathKey: consoleProject.id,
        repositoryPath: "team/platform/console", gitlabHost: "gitlab.test:8443", baseBranch: "main", queue: "MANAGED", tags: ["ai_dev"] },
      { id: workerProject.id, name: "Demo", repositoryName: workerProject.id, repoPathKey: workerProject.id,
        repositoryPath: "team/worker", gitlabHost: "gitlab.test:8443", baseBranch: "develop", queue: "MANAGED", tags: ["ai_dev"] },
    ] },
  });

  for (const project of [consoleProject, workerProject]) {
    const result = await f.request("/api/tasks", "developer", "POST", {
      title: "Route safely", description: "Registered repository only", repositoryName: project.id,
      repoPathKey: "/etc", baseBranch: "other", queue: "OTHER",
    });
    expect(result.status).toBe(201);
    expect(result.body.task).toMatchObject({
      repositoryName: project.id, repoPathKey: project.id, baseBranch: project.definition.baseBranch, queue: "MANAGED",
    });
  }

  const edited = await f.request(`/api/settings/projects/${workerProject.id}`, "admin", "PUT", {
    expectedRevision: (await f.store.read()).revision, definition: { ...workerProject.definition, baseBranch: "release" },
  });
  expect(edited.status).toBe(200);
  expect((await f.request("/api/project-catalog", "viewer")).body.projects[1].baseBranch).toBe("develop");
  await f.settings.applyPending(workerProject.id);
  expect((await f.request("/api/project-catalog", "viewer")).body.projects[1].baseBranch).toBe("release");

  const paused = await f.request(`/api/settings/projects/${consoleProject.id}/state`, "admin", "POST", {
    expectedRevision: (await f.store.read()).revision, enabled: false,
  });
  expect(paused.status).toBe(200);
  expect((await f.request("/api/project-catalog", "viewer")).body.projects.map((project: { id: string }) => project.id))
    .toEqual([workerProject.id]);
  expect((await f.request("/api/repository-directory", "viewer")).body.repositories).toEqual([
    { id: consoleProject.id, name: "Demo", repositoryPath: "team/platform/console", gitlabHost: "gitlab.test:8443" },
    { id: workerProject.id, name: "Demo", repositoryPath: "team/worker", gitlabHost: "gitlab.test:8443" },
  ]);
  await Promise.all(Array.from({ length: 102 }, (_, index) => f.tracker.createTask({
    id: `newer-${String(index).padStart(3, "0")}`,
    title: "Recent work", description: "Fixture", createdBy: { id: "test", owner: "human" },
    repositoryName: workerProject.id, createdAt: "2099-01-01T00:00:00.000Z",
  })));
  const firstPage = await f.request("/api/tasks", "viewer");
  expect(firstPage.body.tasks).toHaveLength(100);
  expect(firstPage.body.tasks.every(({ repositoryName }: { repositoryName: string }) => repositoryName === workerProject.id)).toBe(true);
  const secondPage = await f.request(`/api/tasks?cursor=${firstPage.body.nextCursor}`, "viewer");
  expect(secondPage.body.tasks).toHaveLength(4);
  expect(secondPage.body.nextCursor).toBeUndefined();
  const byGitLabPath = await f.request("/api/tasks?search=team%2Fplatform%2Fconsole", "viewer");
  expect(byGitLabPath.body.tasks).toHaveLength(1);
  expect(byGitLabPath.body.tasks[0].repositoryName).toBe(consoleProject.id);
  expect((await f.request("/api/tasks", "developer", "POST", {
    title: "Paused project", description: "Cannot route a new task", repositoryName: consoleProject.id,
  })).status).toBe(400);
});
it("omits repository display metadata for invalid or missing legacy clone URLs", async () => {
  const f = await setup();
  const connection = await f.request("/api/settings/connections", "admin", "POST", {
    expectedRevision: 0, name: "GitLab", origin: "https://gitlab.test", token: "legacy-token",
  });
  const project = await enableProject(f, connection.body.connections[0].id, "42", "main");
  await f.settings.applyPending(project.id);

  for (const cloneUrl of [undefined, "invalid", "https://user:secret@gitlab.test/team/repo.git?key=secret",
    "https://unconfigured.test/team/repo.git"]) {
    await f.store.change(undefined, "fixture", "legacy_clone_url", (document) => {
      const active = document.projects[0]!.active!;
      if (cloneUrl === undefined) {
        Reflect.deleteProperty(active, "cloneUrl");
      } else {
        active.cloneUrl = cloneUrl;
      }
    });
    expect(await f.request("/api/project-catalog", "viewer")).toEqual({
      status: 200, body: { managed: true, projects: [
        { id: project.id, name: "Demo", repositoryName: project.id, repoPathKey: project.id,
          baseBranch: "main", queue: "MANAGED", tags: ["ai_dev"] },
      ] },
    });
  }
});
it("routes a bearer admin's idempotent task to the selected managed repository", async () => {
  const f = await setup("bearer");
  const headers = { authorization: "Bearer system-token" };
  const connection = await f.request("/api/settings/connections", "admin", "POST", {
    expectedRevision: 0, name: "GitLab", origin: "https://gitlab.test", token: "private-connection-token",
  }, headers);
  expect(connection.status).toBe(201);
  const project = await enableProject(f, connection.body.connections[0].id, "42", "main", headers);
  await f.settings.applyPending(project.id);

  const body = { title: "Create from console", description: "Fixture task", repositoryName: project.id,
    idempotencyKey: "console-submission-1", status: "ready" };
  const first = await f.request("/api/tasks", "admin", "POST", body, headers);
  expect(first).toMatchObject({
    status: 201, body: { idempotent: false, task: {
      repositoryName: project.id, repoPathKey: project.id, baseBranch: "main", queue: "MANAGED", status: "ready",
    } },
  });
  const repeated = await f.request("/api/tasks", "admin", "POST", body, headers);
  expect(repeated).toMatchObject({ status: 200, body: { idempotent: true, task: first.body.task } });
});
it("never echoes malformed JSON containing credentials", async () => {
  const f = await setup();
  const response = await fetch(f.base + "/api/settings/connections", { method: "POST", headers: { "content-type": "application/json", "x-task-tracker-user": "admin", "x-task-tracker-role": "admin" }, body: 'AbcDEfGh987654321' });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("AbcDEfGh987654321");
});
