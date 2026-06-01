import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultObservabilityConfig } from "../src/observability/config.js";
import {
  isPublicHttpsTelegramWebhookBaseUrl,
  type TelegramUpdateHandler,
} from "../src/integrations/telegram/index.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";
import { ObservabilityHttpServer } from "../src/observability/server.js";
import { InMemoryWorkerStateRegistry } from "../src/observability/state.js";

const servers: ObservabilityHttpServer[] = [];

const createServer = (
  handler: TelegramUpdateHandler,
  path = "/telegram/webhook",
): ObservabilityHttpServer => {
  const server = new ObservabilityHttpServer({
    config: {
      ...defaultObservabilityConfig(),
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://127.0.0.1",
    },
    telegramWebhook: { path, secretToken: "secret", handler },
    metrics: new InMemoryMetricsRegistry(),
    state: new InMemoryWorkerStateRegistry(),
    readiness: () => ({ ready: true, reason: "ready" }),
    repositories: () => [],
  });
  servers.push(server);
  return server;
};

const urlFor = (server: ObservabilityHttpServer, path = "/telegram/webhook"): string => {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${path}`;
};

describe("Telegram webhook route", () => {
  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
  });

  it("requires the configured secret token", async () => {
    const handler = { handleUpdate: vi.fn() };
    const server = createServer(handler);
    await server.start();

    const response = await fetch(urlFor(server), {
      method: "POST",
      body: JSON.stringify({ update_id: 1 }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(401);
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });

  it("passes valid webhook updates to the Telegram handler", async () => {
    const handler = { handleUpdate: vi.fn().mockResolvedValue(undefined) };
    const server = createServer(handler);
    await server.start();

    const response = await fetch(urlFor(server), {
      method: "POST",
      body: JSON.stringify({ update_id: 1 }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "secret",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(handler.handleUpdate).toHaveBeenCalledWith({ update_id: 1 });
  });

  it("matches webhook routes configured without a leading slash", async () => {
    const handler = { handleUpdate: vi.fn().mockResolvedValue(undefined) };
    const server = createServer(handler, "tg");
    await server.start();

    const response = await fetch(urlFor(server, "/tg"), {
      method: "POST",
      body: JSON.stringify({ update_id: 1 }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "secret",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(handler.handleUpdate).toHaveBeenCalledWith({ update_id: 1 });
  });

  it("rejects invalid webhook request methods and bodies", async () => {
    const handler = { handleUpdate: vi.fn().mockResolvedValue(undefined) };
    const server = createServer(handler);
    await server.start();

    const getResponse = await fetch(urlFor(server), {
      method: "GET",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
    });
    const invalidJsonResponse = await fetch(urlFor(server), {
      method: "POST",
      body: "{",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
    });
    const oversizedResponse = await fetch(urlFor(server), {
      method: "POST",
      body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "secret",
      },
    });

    expect(getResponse.status).toBe(405);
    expect(invalidJsonResponse.status).toBe(400);
    expect(oversizedResponse.status).toBe(413);
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });

  it("rejects webhook payloads without an integer update id", async () => {
    const handler = { handleUpdate: vi.fn().mockResolvedValue(undefined) };
    const server = createServer(handler);
    await server.start();

    const missingUpdateIdResponse = await fetch(urlFor(server), {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "secret",
      },
    });
    const invalidUpdateIdResponse = await fetch(urlFor(server), {
      method: "POST",
      body: JSON.stringify({ update_id: "bad" }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "secret",
      },
    });

    expect(missingUpdateIdResponse.status).toBe(400);
    expect(invalidUpdateIdResponse.status).toBe(400);
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });
});

describe("Telegram webhook public URL validation", () => {
  it.each([
    ["http://worker.example.test"],
    ["https://localhost"],
    ["https://127.0.0.1"],
    ["https://0.0.0.0"],
    ["https://10.0.0.5"],
    ["https://172.16.0.5"],
    ["https://172.31.255.255"],
    ["https://192.168.1.5"],
    ["https://169.254.10.20"],
    ["https://100.64.0.1"],
    ["https://198.18.0.1"],
    ["https://192.0.0.1"],
    ["https://192.0.2.1"],
    ["https://192.88.99.1"],
    ["https://198.51.100.1"],
    ["https://203.0.113.1"],
    ["https://224.0.0.1"],
    ["https://240.0.0.1"],
    ["https://255.255.255.255"],
    ["https://[::]"],
    ["https://[::1]"],
    ["https://[100::1]"],
    ["https://[2001:2::1]"],
    ["https://[2001:db8::1]"],
    ["https://[fc00::1]"],
    ["https://[fd00::1]"],
    ["https://[fe80::1]"],
    ["https://[ff02::1]"],
    ["https://[::ffff:10.0.0.5]"],
    ["https://[::ffff:100.64.0.1]"],
  ])("rejects non-public webhook base URL %s", (baseUrl) => {
    expect(isPublicHttpsTelegramWebhookBaseUrl(baseUrl)).toBe(false);
  });

  it("accepts HTTPS DNS names because privacy cannot be determined without DNS resolution", () => {
    expect(isPublicHttpsTelegramWebhookBaseUrl("https://worker.example.test")).toBe(true);
  });

  it.each([
    ["https://8.8.8.8"],
    ["https://[2001:4860:4860::8888]"],
  ])("accepts globally routable IP literal webhook base URL %s", (baseUrl) => {
    expect(isPublicHttpsTelegramWebhookBaseUrl(baseUrl)).toBe(true);
  });
});
