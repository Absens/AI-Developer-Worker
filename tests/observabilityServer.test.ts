import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { defaultObservabilityConfig } from "../src/observability/config.js";
import { InMemoryEventStore } from "../src/observability/events.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";
import { ObservabilityHttpServer } from "../src/observability/server.js";
import { InMemoryWorkerStateRegistry } from "../src/observability/state.js";
import { NoopAlertService } from "../src/observability/alerts.js";

const servers: ObservabilityHttpServer[] = [];

const fetchText = async (baseUrl: string, path: string, token?: string) => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
};

describe("ObservabilityHttpServer", () => {
  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
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
});
