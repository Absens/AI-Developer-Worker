import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildApplication,
  buildTelegramAssistantCodexRuntimeConfig,
  runApplicationRuntime,
} from "../src/app.js";
import { TELEGRAM_ALLOWED_UPDATES } from "../src/integrations/telegram/index.js";

const cleanupPaths: string[] = [];
const blockingServers: Server[] = [];

const listenOnEphemeralPort = async (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

afterEach(async () => {
  vi.unstubAllGlobals();
  while (blockingServers.length > 0) {
    const server = blockingServers.pop();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("application wiring", () => {
  it("clamps Telegram assistant Codex process timeout to the Telegram timeout", () => {
    const workerRuntimeConfig = { codexTimeoutMs: 30 * 60 * 1000 };
    const telegramConfig = { codexTimeoutSeconds: 120 };

    expect(
      buildTelegramAssistantCodexRuntimeConfig(
        workerRuntimeConfig,
        telegramConfig,
      ).codexTimeoutMs,
    ).toBe(120 * 1000);
    expect(workerRuntimeConfig.codexTimeoutMs).toBe(30 * 60 * 1000);
    expect(
      buildTelegramAssistantCodexRuntimeConfig(
        { codexTimeoutMs: 45 * 1000 },
        telegramConfig,
      ).codexTimeoutMs,
    ).toBe(45 * 1000);
  });

  it("builds internal task tracker mode without Yandex direct config", () => {
    const app = buildApplication({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(app.config.taskTracker).toMatchObject({
      provider: "internal",
      internal: {
        storage: "postgres",
        intakeMode: "standalone",
        yandexSyncEnabled: false,
      },
    });
    expect(app.taskTracker).toBeDefined();
  });

  it("wires project manager API dependencies when only a repository enables project manager", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        taskTracker: { provider: "internal", storage: "memory" },
        repositories: [
          {
            name: "developer",
            repoPath: "/workspace/developer",
            gitlabProjectId: "123",
            queues: ["DEV"],
            projectManager: { enabled: true },
          },
          {
            name: "disabled",
            repoPath: "/workspace/disabled",
            gitlabProjectId: "456",
            queues: ["DEV"],
            projectManager: { enabled: false },
          },
        ],
      }),
      "utf8",
    );

    const app = buildApplication({
      WORKER_CONFIG_FILE: configFile,
      NODE_ENV: "test",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });

    expect(app.config.projectManager?.enabled).toBe(false);
    expect("repositories" in app.config).toBe(true);
    if (!("repositories" in app.config)) {
      throw new Error("Expected fleet config.");
    }
    expect(app.config.repositories[0]?.projectManager?.enabled).toBe(true);
    expect(app.projectManager?.store).toBeDefined();
    expect(app.projectManager?.runner).toBeDefined();
    await expect(
      app.projectManager?.runner?.runAnalysisOnce({
        repositoryName: "missing",
        trigger: "manual",
      }),
    ).rejects.toThrow(/Project manager repository not found: missing/);
    await expect(
      app.projectManager?.runner?.runAnalysisOnce({
        repositoryName: "disabled",
        trigger: "manual",
      }),
    ).rejects.toThrow(/Project manager is not enabled for repository: disabled/);
  });

  it("sets and deletes the Telegram webhook in webhook mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-webhook-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        taskTracker: { provider: "internal", storage: "memory" },
        observability: {
          enabled: true,
          host: "127.0.0.1",
          port: 9464,
          baseUrl: "https://worker.example.test",
        },
        telegramAssistant: {
          enabled: true,
          botToken: "bot-token",
          mode: "webhook",
          allowedUserIds: ["101"],
          webhook: { path: "tg/", secretToken: "hook-secret" },
        },
        repositories: [
          {
            name: "developer",
            repoPath: "/workspace/developer",
            gitlabProjectId: "123",
            queues: ["DEV"],
          },
        ],
      }),
      "utf8",
    );
    const telegramRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        telegramRequests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const app = buildApplication({
      WORKER_CONFIG_FILE: configFile,
      NODE_ENV: "test",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });

    await app.telegramAssistant.start();
    await app.telegramAssistant.stop();

    expect(telegramRequests).toEqual([
      {
        url: "https://api.telegram.org/botbot-token/setWebhook",
        body: {
          url: "https://worker.example.test/tg",
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          secret_token: "hook-secret",
        },
      },
      {
        url: "https://api.telegram.org/botbot-token/deleteWebhook",
        body: {
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          drop_pending_updates: false,
        },
      },
    ]);
  });

  it.each([
    ["/healthz", /health/i],
    ["/readyz", /ready/i],
    ["/metrics", /metrics/i],
    ["/tasks/task-1", /task tracker ui/i],
    ["/api/tasks", /task tracker api/i],
  ])(
    "rejects Telegram webhook path conflicts before startup: %s",
    (webhookPath, expectedMessage) => {
      const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-webhook-conflict-"));
      cleanupPaths.push(directory);
      const configFile = join(directory, "worker.config.json");
      writeFileSync(
        configFile,
        JSON.stringify({
          worker: { id: "worker-1" },
          taskTracker: { provider: "internal", storage: "memory" },
          observability: {
            enabled: true,
            host: "127.0.0.1",
            port: 9464,
            baseUrl: "https://worker.example.test",
            taskTrackerUi: { enabled: true },
          },
          telegramAssistant: {
            enabled: true,
            botToken: "bot-token",
            mode: "webhook",
            allowedUserIds: ["101"],
            webhook: { path: webhookPath, secretToken: "hook-secret" },
          },
          repositories: [
            {
              name: "developer",
              repoPath: "/workspace/developer",
              gitlabProjectId: "123",
              queues: ["DEV"],
            },
          ],
        }),
        "utf8",
      );

      expect(() =>
        buildApplication({
          WORKER_CONFIG_FILE: configFile,
          NODE_ENV: "test",
          GITLAB_URL: "https://gitlab.example.com/",
          GITLAB_TOKEN: "gitlab-token",
        }),
      ).toThrow(expectedMessage);
    },
  );

  it("rejects Telegram webhook mode when no HTTP server is enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-webhook-disabled-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        taskTracker: { provider: "internal", storage: "memory" },
        observability: { enabled: false },
        telegramAssistant: {
          enabled: true,
          botToken: "bot-token",
          mode: "webhook",
          allowedUserIds: ["101"],
          webhook: { path: "/telegram/webhook", secretToken: "hook-secret" },
        },
        repositories: [
          {
            name: "developer",
            repoPath: "/workspace/developer",
            gitlabProjectId: "123",
            queues: ["DEV"],
          },
        ],
      }),
      "utf8",
    );

    expect(() =>
      buildApplication({
        WORKER_CONFIG_FILE: configFile,
        NODE_ENV: "test",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
      }),
    ).toThrow(/Telegram assistant webhook mode requires an enabled HTTP server/);
  });

  it("treats webhook HTTP server startup failure as fatal when observability startup is non-strict", async () => {
    const blocker = createServer((_request, response) => {
      response.end("busy");
    });
    const blockedPort = await listenOnEphemeralPort(blocker);
    blockingServers.push(blocker);
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-webhook-bind-failure-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1", runOnce: true },
        taskTracker: { provider: "internal", storage: "memory" },
        observability: {
          enabled: true,
          host: "127.0.0.1",
          port: blockedPort,
          baseUrl: "https://worker.example.test",
          strictStartup: false,
        },
        telegramAssistant: {
          enabled: true,
          botToken: "bot-token",
          mode: "webhook",
          allowedUserIds: ["101"],
          webhook: { path: "/telegram/webhook", secretToken: "hook-secret" },
        },
        repositories: [
          {
            name: "developer",
            repoPath: "/workspace/developer",
            gitlabProjectId: "123",
            queues: ["DEV"],
          },
        ],
      }),
      "utf8",
    );
    const telegramRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        telegramRequests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const app = buildApplication({
      WORKER_CONFIG_FILE: configFile,
      NODE_ENV: "test",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });
    let startupError: unknown;

    try {
      await runApplicationRuntime({
        ...app,
        orchestrator: {
          runOnce: vi.fn(),
          runForever: vi.fn(),
        },
        observability: {
          start: () => app.observability.start(),
          markNotReady: (reason) => app.observability.markNotReady(reason),
          setWorkerState: (input) =>
            app.observability.setWorkerState(
              input as Parameters<typeof app.observability.setWorkerState>[0],
            ),
          incrementCounter: (name, labels) =>
            app.observability.incrementCounter(name, labels),
          markReady: () => app.observability.markReady(),
          stop: vi.fn(async () => {}),
        },
        assertRepositoryReady: vi.fn(),
        assertCodexAuthenticated: vi.fn(),
      });
    } catch (error) {
      startupError = error;
    }

    expect({
      error: startupError instanceof Error ? startupError.message : undefined,
      telegramRequests,
    }).toMatchObject({
      error: expect.stringMatching(/Observability server failed to start/),
      telegramRequests: [],
    });
  });
});
