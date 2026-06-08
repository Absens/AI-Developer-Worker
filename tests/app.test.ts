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
import { InMemoryTelegramAssistantStore } from "../src/domain/telegramAssistant/index.js";
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
  vi.unstubAllEnvs();
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

  it("overrides the Codex model only for Telegram assistant runs", () => {
    const workerRuntimeConfig = {
      codexTimeoutMs: 30 * 60 * 1000,
      codexModel: "gpt-5.5",
    };
    const telegramConfig = {
      codexTimeoutSeconds: 120,
      codexModel: "gpt-5.3-codex-spark",
    };

    expect(
      buildTelegramAssistantCodexRuntimeConfig(
        workerRuntimeConfig,
        telegramConfig,
      ),
    ).toMatchObject({
      codexTimeoutMs: 120 * 1000,
      codexModel: "gpt-5.3-codex-spark",
    });
    expect(workerRuntimeConfig.codexModel).toBe("gpt-5.5");
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

  it("builds preflight-only mode so Telegram assistant diagnostics can report config failures", () => {
    const app = buildApplication({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      WORKER_PREFLIGHT_ONLY: "true",
      NODE_ENV: "production",
      TASK_TRACKER_LOCAL_SMOKE: "true",
      TELEGRAM_ASSISTANT_ENABLED: "true",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(app.config.telegramAssistant).toMatchObject({
      enabled: true,
      botToken: undefined,
      allowedChatIds: [],
      allowedUserIds: [],
      developerUserIds: [],
      operatorUserIds: [],
      adminUserIds: [],
    });
    expect(app.telegramAssistant.webhook).toBeUndefined();
  });

  it("builds preflight-only production mode so empty Telegram allowlists can be reported as warnings", () => {
    const app = buildApplication({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      WORKER_PREFLIGHT_ONLY: "true",
      NODE_ENV: "production",
      TASK_TRACKER_LOCAL_SMOKE: "true",
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "bot-token",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(app.config.telegramAssistant).toMatchObject({
      enabled: true,
      botToken: "bot-token",
      allowedChatIds: [],
      allowedUserIds: [],
      developerUserIds: [],
      operatorUserIds: [],
      adminUserIds: [],
    });
  });

  it("builds preflight-only webhook mode without an HTTP server so preflight can report it", () => {
    const app = buildApplication({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      WORKER_PREFLIGHT_ONLY: "true",
      NODE_ENV: "test",
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "bot-token",
      TELEGRAM_ASSISTANT_MODE: "webhook",
      TELEGRAM_WEBHOOK_PATH: "/telegram/webhook",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "hook-secret",
      TELEGRAM_ALLOWED_USER_IDS: "101",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(app.config.telegramAssistant).toMatchObject({
      enabled: true,
      mode: "webhook",
      webhook: { path: "/telegram/webhook" },
    });
  });

  it("reports a missing Telegram webhook secret in preflight-only mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-preflight-secret-"));
    cleanupPaths.push(directory);
    vi.stubEnv("CODEX_API_KEY", "codex-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (init?.method === "POST" && url.pathname.endsWith("/merge_requests")) {
          return new Response(
            JSON.stringify({
              id: 1,
              iid: 1,
              web_url: "https://gitlab.example.com/project/-/merge_requests/1",
              title: "[AI Preflight] preflight/worker-1",
              source_branch: "preflight/worker-1",
              target_branch: "main",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const app = buildApplication({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      WORKER_PREFLIGHT_ONLY: "true",
      NODE_ENV: "test",
      PREFLIGHT_RUN_TARGET_COMMANDS: "false",
      TRACKER_IMAGE_CONTEXT_ENABLED: "false",
      REPO_PATH: directory,
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_BASE_URL: "https://worker.example.test",
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "bot-token",
      TELEGRAM_ASSISTANT_MODE: "webhook",
      TELEGRAM_WEBHOOK_PATH: "/telegram/webhook",
      TELEGRAM_ALLOWED_USER_IDS: "101",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    const results = await app.preflight.run();

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram assistant",
        status: "fail",
        details: expect.stringContaining("webhook secret token"),
      }),
    ]));
  });

  it.each([
    ["non-HTTPS", "http://worker.example.test"],
    ["private HTTPS", "https://10.0.0.5"],
    ["CGNAT HTTPS", "https://100.64.0.1"],
    ["ULA IPv6 HTTPS", "https://[fc00::1]"],
  ])("reports %s Telegram webhook base URLs in preflight-only mode", async (_label, baseUrl) => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-preflight-webhook-"));
    cleanupPaths.push(directory);
    vi.stubEnv("CODEX_API_KEY", "codex-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (init?.method === "POST" && url.pathname.endsWith("/merge_requests")) {
          return new Response(
            JSON.stringify({
              id: 1,
              iid: 1,
              web_url: "https://gitlab.example.com/project/-/merge_requests/1",
              title: "[AI Preflight] preflight/worker-1",
              source_branch: "preflight/worker-1",
              target_branch: "main",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const app = buildApplication({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      WORKER_PREFLIGHT_ONLY: "true",
      NODE_ENV: "test",
      PREFLIGHT_RUN_TARGET_COMMANDS: "false",
      TRACKER_IMAGE_CONTEXT_ENABLED: "false",
      REPO_PATH: directory,
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_BASE_URL: baseUrl,
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "bot-token",
      TELEGRAM_ASSISTANT_MODE: "webhook",
      TELEGRAM_WEBHOOK_PATH: "/telegram/webhook",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "hook-secret",
      TELEGRAM_ALLOWED_USER_IDS: "101",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    const results = await app.preflight.run();

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram assistant",
        status: "fail",
        details: expect.stringContaining("public https observability.baseUrl"),
      }),
    ]));
  });

  it("runs Telegram assistant retention cleanup on the task tracker cleanup cadence", async () => {
    vi.useFakeTimers();
    const purgeSpy = vi
      .spyOn(InMemoryTelegramAssistantStore.prototype, "purgeExpiredTelegramAssistantData")
      .mockResolvedValue({
        messageRefs: 0,
        queuedMessages: 0,
        pendingActions: 0,
      });
    try {
      const app = buildApplication({
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_STORAGE: "memory",
        TASK_INTAKE_MODE: "standalone",
        YANDEX_SYNC_ENABLED: "false",
        TASK_TRACKER_CLEANUP_ENABLED: "true",
        TASK_TRACKER_CLEANUP_INTERVAL_SECONDS: "1",
        NODE_ENV: "test",
        TELEGRAM_ASSISTANT_ENABLED: "true",
        TELEGRAM_ASSISTANT_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_USER_IDS: "101",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      });

      app.cleanup.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(purgeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      await app.cleanup.stop();
    } finally {
      purgeSpy.mockRestore();
      vi.useRealTimers();
    }
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

  it("rejects non-HTTPS Telegram webhook base URLs in normal runtime mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-webhook-http-base-"));
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
          baseUrl: "http://worker.example.test",
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

    expect(() =>
      buildApplication({
        WORKER_CONFIG_FILE: configFile,
        NODE_ENV: "test",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
      }),
    ).toThrow(/public https observability\.baseUrl/);
  });

  it.each([
    ["private", "https://10.0.0.5"],
    ["CGNAT", "https://100.64.0.1"],
    ["ULA IPv6", "https://[fc00::1]"],
  ])("rejects %s HTTPS Telegram webhook base URLs in normal runtime mode", (_label, baseUrl) => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-webhook-private-base-"));
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
          baseUrl,
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

    expect(() =>
      buildApplication({
        WORKER_CONFIG_FILE: configFile,
        NODE_ENV: "test",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
      }),
    ).toThrow(/public https observability\.baseUrl/);
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
          incrementCounter: (name, labels, value) =>
            app.observability.incrementCounter(name, labels, value),
          observeHistogram: (name, labels, value) =>
            app.observability.observeHistogram(name, labels, value),
          setGauge: (name, labels, value) =>
            app.observability.setGauge(name, labels, value),
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
