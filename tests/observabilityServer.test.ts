import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { defaultObservabilityConfig } from "../src/observability/config.js";
import { InMemoryEventStore } from "../src/observability/events.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";
import { ObservabilityHttpServer } from "../src/observability/server.js";
import { InMemoryWorkerStateRegistry } from "../src/observability/state.js";
import { NoopAlertService } from "../src/observability/alerts.js";

const servers: ObservabilityHttpServer[] = [];
const cleanupPaths: string[] = [];

const fetchText = async (baseUrl: string, path: string, token?: string) => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
};

describe("ObservabilityHttpServer", () => {
  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("serves health, readiness, metrics, dashboard, and API endpoints", async () => {
    let ready = false;
    const config = {
      ...defaultObservabilityConfig(),
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://127.0.0.1",
      dashboard: {
        ...defaultObservabilityConfig().dashboard,
        enabled: true,
        bearerToken: "secret",
      },
    };
    const metrics = new InMemoryMetricsRegistry();
    metrics.incrementCounter("ai_developer_tasks_total", {
      repository: "repo",
      status: "success",
    });
    const events = new InMemoryEventStore(config, metrics);
    await events.append({
      workerId: "worker-1",
      repositoryName: "repo",
      issueKey: "DEV-1",
      type: "mr_ready",
      status: "info",
      message: "MR ready",
      mergeRequestUrl: "https://gitlab.example.com/mr/1",
      mergeRequestIid: 1,
    });
    const state = new InMemoryWorkerStateRegistry();
    state.update({
      workerId: "worker-1",
      state: "processing",
      repositoryName: "repo",
      issueKey: "DEV-1",
      stage: "publish",
    });
    state.setQueueDepth("repo", "FRONTEND", 2);
    const server = new ObservabilityHttpServer({
      config,
      metrics,
      events,
      state,
      alerts: new NoopAlertService(),
      readiness: () => ({ ready, reason: ready ? "ready" : "starting" }),
      repositories: () => ["repo"],
    });
    servers.push(server);
    await server.start();
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    expect((await fetchText(baseUrl, "/healthz")).status).toBe(200);
    expect((await fetchText(baseUrl, "/readyz")).status).toBe(503);
    ready = true;
    expect((await fetchText(baseUrl, "/readyz")).status).toBe(200);
    const metricsResponse = await fetchText(baseUrl, "/metrics");
    expect(metricsResponse.contentType).toContain("text/plain");
    expect(metricsResponse.body).toContain("ai_developer_tasks_total");
    expect((await fetchText(baseUrl, "/dashboard")).status).toBe(401);
    expect((await fetchText(baseUrl, "/dashboard", "secret")).body).toContain(
      "AI Developer Worker",
    );
    const api = await fetchText(baseUrl, "/api/tasks/recent?limit=10", "secret");
    expect(api.status).toBe(200);
    expect(JSON.parse(api.body).tasks[0]).toMatchObject({
      repositoryName: "repo",
      issueKey: "DEV-1",
      stage: "mr_ready",
    });
    const summary = await fetchText(baseUrl, "/api/metrics/summary", "secret");
    expect(JSON.parse(summary.body).totals.activeTasks).toBe(1);
  });

  it("returns 405 for unsupported methods", async () => {
    const config = {
      ...defaultObservabilityConfig(),
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://127.0.0.1",
    };
    const metrics = new InMemoryMetricsRegistry();
    const server = new ObservabilityHttpServer({
      config,
      metrics,
      events: new InMemoryEventStore(config, metrics),
      state: new InMemoryWorkerStateRegistry(),
      alerts: new NoopAlertService(),
      readiness: () => ({ ready: true, reason: "ready" }),
      repositories: () => [],
    });
    servers.push(server);
    await server.start();
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
      method: "POST",
    });

    expect(response.status).toBe(405);
  });

  it("serves Angular static UI files and deep links without swallowing backend routes", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "task-console-static-"));
    cleanupPaths.push(staticDir);
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(
      join(staticDir, "index.html"),
      '<!doctype html><html><body><app-root></app-root></body></html>',
      "utf8",
    );
    writeFileSync(join(staticDir, "main.js"), "console.log('task console');", "utf8");
    writeFileSync(
      join(staticDir, "main.abcdef123.js"),
      "console.log('hashed task console');",
      "utf8",
    );
    writeFileSync(join(staticDir, "assets", "logo.txt"), "asset", "utf8");
    const config = {
      ...defaultObservabilityConfig(),
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://127.0.0.1",
      taskTrackerUi: {
        ...defaultObservabilityConfig().taskTrackerUi,
        enabled: true,
        staticDir,
      },
    };
    const metrics = new InMemoryMetricsRegistry();
    const server = new ObservabilityHttpServer({
      config,
      metrics,
      events: new InMemoryEventStore(config, metrics),
      state: new InMemoryWorkerStateRegistry(),
      alerts: new NoopAlertService(),
      readiness: () => ({ ready: true, reason: "ready" }),
      repositories: () => [],
    });
    servers.push(server);
    await server.start();
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const index = await fetchText(baseUrl, "/tasks");
    expect(index.status).toBe(200);
    expect(index.contentType).toContain("text/html");
    expect(index.cacheControl).toBe("no-store");
    expect(index.body).toContain("<app-root>");
    const plainScript = await fetchText(baseUrl, "/tasks/main.js");
    expect(plainScript.body).toContain("task console");
    expect(plainScript.cacheControl).toBe("public, max-age=300");
    const hashedScript = await fetchText(baseUrl, "/tasks/main.abcdef123.js");
    expect(hashedScript.body).toContain("hashed task console");
    expect(hashedScript.cacheControl).toBe("public, max-age=31536000, immutable");
    const asset = await fetchText(baseUrl, "/tasks/assets/logo.txt");
    expect(asset.body).toBe("asset");
    expect(asset.cacheControl).toBe("public, max-age=300");
    const deepLink = await fetchText(baseUrl, "/tasks/task-123");
    expect(deepLink.body).toContain("<app-root>");
    expect(deepLink.cacheControl).toBe("no-store");
    const missingAsset = await fetchText(baseUrl, "/tasks/assets/missing.txt");
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.body).toContain("Angular static asset not found");

    for (const reservedPath of ["/healthz", "/readyz", "/metrics", "/api/session"]) {
      const response = await fetchText(baseUrl, reservedPath);
      expect(response.status).not.toBe(404);
      expect(response.body).not.toContain("<app-root>");
    }
    expect((await fetchText(baseUrl, "/healthz")).status).toBe(200);
    expect((await fetchText(baseUrl, "/readyz")).status).toBe(200);
    expect((await fetchText(baseUrl, "/metrics")).contentType).toContain("text/plain");
    const session = await fetchText(baseUrl, "/api/session");
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toMatchObject({
      role: "viewer",
      apiPath: "/api",
      uiPath: "/tasks",
    });
  });

  it("fails startup clearly when an Angular static directory is configured but missing", async () => {
    const missingStaticDir = join(tmpdir(), "missing-task-console-static");
    const config = {
      ...defaultObservabilityConfig(),
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://127.0.0.1",
      taskTrackerUi: {
        ...defaultObservabilityConfig().taskTrackerUi,
        enabled: true,
        staticDir: missingStaticDir,
      },
    };
    const metrics = new InMemoryMetricsRegistry();
    const server = new ObservabilityHttpServer({
      config,
      metrics,
      events: new InMemoryEventStore(config, metrics),
      state: new InMemoryWorkerStateRegistry(),
      alerts: new NoopAlertService(),
      readiness: () => ({ ready: true, reason: "ready" }),
      repositories: () => [],
    });

    await expect(server.start()).rejects.toThrow(/Angular static bundle is not available/);
  });

  it("does not serve the removed embedded task UI when no static bundle is configured", async () => {
    const config = {
      ...defaultObservabilityConfig(),
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://127.0.0.1",
      taskTrackerUi: {
        ...defaultObservabilityConfig().taskTrackerUi,
        enabled: true,
      },
    };
    const metrics = new InMemoryMetricsRegistry();
    const server = new ObservabilityHttpServer({
      config,
      metrics,
      events: new InMemoryEventStore(config, metrics),
      state: new InMemoryWorkerStateRegistry(),
      alerts: new NoopAlertService(),
      readiness: () => ({ ready: true, reason: "ready" }),
      repositories: () => [],
    });
    servers.push(server);
    await server.start();
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const ui = await fetchText(baseUrl, "/tasks");
    expect(ui.status).toBe(503);
    expect(ui.body).toContain("Angular static bundle is not configured");
    expect(ui.body).not.toContain("Internal Task Tracker");
    const deepLink = await fetchText(baseUrl, "/tasks/task-123");
    expect(deepLink.status).toBe(503);
    expect(deepLink.body).toContain("Angular static bundle is not configured");
  });
});
