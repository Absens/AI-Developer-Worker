import { Pool } from "pg";

import { buildRepositoryRuntimeConfig, loadFleetConfig } from "./config.js";
import { assertCodexAuthenticated } from "./integrations/codex/auth.js";
import { FleetOrchestrator } from "./domain/fleetOrchestrator.js";
import { InternalWorkerOrchestrator } from "./domain/internalWorkerOrchestrator.js";
import { NoopLockBackend, TrackerCommentLockBackend } from "./domain/lockBackend.js";
import { FileMemoryStore } from "./domain/memoryStore.js";
import { WorkerOrchestrator } from "./domain/orchestrator.js";
import { PreflightService } from "./domain/preflight.js";
import {
  InMemoryProjectManagerStore,
  ProjectManagerOrchestrator,
  type ProjectManagerStore,
} from "./domain/projectManager/index.js";
import { buildRepositoryContext } from "./domain/repositoryContext.js";
import {
  InMemoryTelegramAssistantStore,
  PostgresTelegramAssistantStore,
  TelegramAssistantCodexService,
  TelegramAssistantProjectContextSourceProvider,
  TelegramAssistantService,
  TelegramNotificationRouter,
  type TelegramAssistantStore,
} from "./domain/telegramAssistant/index.js";
import { CliCodexRunner } from "./integrations/codex/runner.js";
import { RepositoryGitService } from "./integrations/git/service.js";
import { GitLabApiClient } from "./integrations/gitlab/client.js";
import {
  createInternalTaskTrackerClient,
  PostgresProjectManagerStore,
} from "./integrations/internalTracker/index.js";
import {
  InternalTrackerCleanupRunner,
  InternalTrackerCleanupScheduler,
  type InternalTrackerCleanupResult,
} from "./integrations/internalTracker/cleanup.js";
import {
  assertPublicHttpsTelegramWebhookBaseUrl,
  TelegramApiError,
  TelegramClient,
  TelegramRetryAfterError,
  TelegramUpdatePoller,
} from "./integrations/telegram/index.js";
import { createRuntimeTrackerClient } from "./integrations/tracker/factory.js";
import { YandexTrackerClient } from "./integrations/tracker/client.js";
import { WildberriesProductVerifier } from "./integrations/wildberries/productVerifier.js";
import {
  InMemoryYandexBridgeStore,
  PostgresYandexBridgeStore,
  YandexBridge,
  YandexExternalTaskSource,
  type YandexBridgeStore,
} from "./integrations/yandexBridge/index.js";
import { redactSecrets } from "./observability/redaction.js";
import { createObservabilityService } from "./observability/service.js";
import type { TelegramWebhookRoute } from "./observability/server.js";
import type { ProjectManagerApiDependencies } from "./observability/taskTrackerHumanApi.js";
import { TemporaryIntegrationError } from "./utils/errors.js";
import { Logger } from "./utils/logger.js";
import { withRetry } from "./utils/retry.js";

export interface CleanupController {
  start(): void;
  runOnce(): Promise<InternalTrackerCleanupResult | undefined>;
  stop(): Promise<void>;
}

export interface TelegramAssistantController {
  readonly webhook?: TelegramWebhookRoute;
  start(): Promise<void>;
  runCleanupOnce?(): Promise<void>;
  stop(): Promise<void>;
}

interface RuntimeConfig {
  workerId: string;
  runOnce: boolean;
}

interface RuntimeOrchestrator {
  runOnce(): Promise<unknown>;
  runForever(): Promise<unknown>;
}

interface RuntimeObservability {
  start(): Promise<void>;
  markNotReady(reason: string): void;
  setWorkerState(input: { workerId: string; state: string }): void;
  incrementCounter(name: string, labels: Record<string, string>, value?: number): void;
  observeHistogram(name: string, labels: Record<string, string>, value: number): void;
  setGauge(name: string, labels: Record<string, string>, value: number): void;
  markReady(): void;
  stop(): Promise<void>;
}

type TelegramAssistantTelemetry = Pick<
  RuntimeObservability,
  "incrementCounter" | "observeHistogram" | "setGauge"
>;

export interface ApplicationRuntime {
  config: RuntimeConfig;
  orchestrator: RuntimeOrchestrator;
  logger: Pick<Logger, "info">;
  observability: RuntimeObservability;
  cleanup: CleanupController;
  telegramAssistant: TelegramAssistantController;
  assertRepositoryReady(): Promise<void>;
  assertCodexAuthenticated(): Promise<void>;
}

const noopCleanupController: CleanupController = {
  start(): void {},
  async runOnce(): Promise<undefined> {
    return undefined;
  },
  async stop(): Promise<void> {},
};

const noopTelegramAssistantController: TelegramAssistantController = {
  webhook: undefined,
  async start(): Promise<void> {},
  async stop(): Promise<void> {},
};

const subtractDays = (isoDate: string, days: number): string =>
  new Date(Date.parse(isoDate) - days * 24 * 60 * 60 * 1000).toISOString();

const createTelegramAssistantCleanupController = (
  telegramAssistant: TelegramAssistantController,
  cleanup: { enabled: boolean; intervalSeconds: number } | undefined,
  logger: Logger,
): CleanupController => {
  if (!cleanup || !telegramAssistant.runCleanupOnce) {
    return noopCleanupController;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const runOnce = async (): Promise<undefined> => {
    if (!cleanup.enabled || running) {
      return undefined;
    }
    running = true;
    try {
      await telegramAssistant.runCleanupOnce?.();
    } finally {
      running = false;
    }
    return undefined;
  };

  return {
    start(): void {
      if (!cleanup.enabled || timer) {
        return;
      }
      timer = setInterval(() => {
        runOnce().catch((error) => {
          logger.warn("Telegram assistant retention cleanup failed.", redactSecrets({
            error: errorToMessage(error),
          }));
        });
      }, cleanup.intervalSeconds * 1000);
      timer.unref?.();
    },
    runOnce,
    async stop(): Promise<void> {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
    },
  };
};

const retryTelegramStartupRequest = async <T>(
  method: "setWebhook" | "deleteWebhook",
  operation: () => Promise<T>,
  logger: Logger,
): Promise<T> => {
  try {
    return await withRetry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          if (error instanceof TelegramRetryAfterError) {
            throw new TemporaryIntegrationError(
              error.message,
              error,
              error.retryAfterSeconds * 1000,
            );
          }
          if (
            error instanceof TelegramApiError &&
            (error.status === 0 || error.status >= 500)
          ) {
            throw new TemporaryIntegrationError(error.message, error);
          }
          throw error;
        }
      },
      {
        retries: 3,
        delayMs: 1_000,
        label: `telegram:${method}`,
        logger,
      },
    );
  } catch (error) {
    if (error instanceof TemporaryIntegrationError && error.cause !== undefined) {
      throw error.cause;
    }
    throw error;
  }
};

export const buildTelegramAssistantCodexRuntimeConfig = <
  TConfig extends { codexTimeoutMs: number; codexModel?: string },
>(
  runtimeConfig: TConfig,
  telegramConfig: { codexTimeoutSeconds: number; codexModel?: string },
): TConfig => ({
  ...runtimeConfig,
  codexTimeoutMs: Math.min(
    runtimeConfig.codexTimeoutMs,
    telegramConfig.codexTimeoutSeconds * 1000,
  ),
  ...(telegramConfig.codexModel ? { codexModel: telegramConfig.codexModel } : {}),
});

const buildTelegramWebhookUrl = (baseUrl: string, path: string): string => {
  assertPublicHttpsTelegramWebhookBaseUrl(baseUrl);
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
};

const isObservabilityHttpServerEnabled = (
  config: ReturnType<typeof loadFleetConfig>["observability"],
): boolean => config?.enabled === true || config?.taskTrackerUi.enabled === true;

const normalizeRoutePath = (path: string): string => {
  const trimmed = path.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
};

const pathIsAtOrInside = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}/`);

const validateTelegramWebhookRouteConfig = (
  fleetConfig: ReturnType<typeof loadFleetConfig>,
): void => {
  const webhook = fleetConfig.telegramAssistant?.webhook;
  if (fleetConfig.telegramAssistant?.enabled !== true || !webhook) {
    return;
  }
  if (fleetConfig.preflightOnly) {
    return;
  }

  const webhookPath = normalizeRoutePath(webhook.path);
  if (webhookPath === "/") {
    throw new Error("Telegram webhook path must be a non-root path.");
  }

  const { observability } = fleetConfig;
  if (!observability) {
    throw new Error("Telegram assistant webhook mode requires an enabled HTTP server.");
  }
  assertPublicHttpsTelegramWebhookBaseUrl(observability.baseUrl);

  const exactRoutes = [
    { label: "health route", path: observability.health.path },
    { label: "readiness route", path: observability.health.readinessPath },
    ...(observability.metrics.enabled
      ? [{ label: "metrics route", path: observability.metrics.path }]
      : []),
  ];

  for (const route of exactRoutes) {
    if (webhookPath === normalizeRoutePath(route.path)) {
      throw new Error(
        `Telegram webhook path ${webhookPath} conflicts with ${route.label} ${route.path}.`,
      );
    }
  }

  if (observability.taskTrackerUi.enabled) {
    const taskUiPath = normalizeRoutePath(observability.taskTrackerUi.path);
    if (
      pathIsAtOrInside(taskUiPath, webhookPath) ||
      pathIsAtOrInside(webhookPath, taskUiPath)
    ) {
      throw new Error(
        `Telegram webhook path ${webhookPath} conflicts with task tracker ui route ${taskUiPath}.`,
      );
    }

    const taskApiPath = normalizeRoutePath(observability.taskTrackerUi.apiPath);
    if (
      pathIsAtOrInside(taskApiPath, webhookPath) ||
      pathIsAtOrInside(webhookPath, taskApiPath)
    ) {
      throw new Error(
        `Telegram webhook path ${webhookPath} conflicts with task tracker api route ${taskApiPath}.`,
      );
    }
  }
};

export const runApplicationRuntime = async (
  runtime: ApplicationRuntime,
): Promise<void> => {
  const {
    config,
    orchestrator,
    logger,
    observability,
    cleanup,
    telegramAssistant,
    assertCodexAuthenticated,
    assertRepositoryReady,
  } = runtime;

  await observability.start();
  const markStopping = (): void => {
    observability.markNotReady("shutting down");
    observability.setWorkerState({
      workerId: config.workerId,
      state: "shutting_down",
    });
  };

  try {
    observability.markNotReady("startup checks pending");
    process.on("SIGINT", markStopping);
    process.on("SIGTERM", markStopping);
    await telegramAssistant.start();
    observability.setWorkerState({
      workerId: config.workerId,
      state: "starting",
    });
    await assertRepositoryReady();
    observability.incrementCounter("ai_developer_preflight_checks_total", {
      check: "repository_ready",
      status: "pass",
    });
    await assertCodexAuthenticated();
    observability.incrementCounter("ai_developer_preflight_checks_total", {
      check: "codex_auth",
      status: "pass",
    });
    cleanup.start();
    observability.markReady();
    if (config.runOnce) {
      await orchestrator.runOnce();
      logger.info("Worker completed a single run.");
      return;
    }

    await orchestrator.runForever();
  } catch (error) {
    observability.markNotReady(error instanceof Error ? error.message : String(error));
    observability.incrementCounter("ai_developer_preflight_checks_total", {
      check: "startup",
      status: "fail",
    });
    throw error;
  } finally {
    process.off("SIGINT", markStopping);
    process.off("SIGTERM", markStopping);
    await telegramAssistant.stop();
    await observability.stop();
    await cleanup.stop();
  }
};

const createYandexBridgeStore = (
  taskTracker: ReturnType<typeof loadFleetConfig>["taskTracker"],
): YandexBridgeStore => {
  if (taskTracker?.provider !== "internal") {
    return new InMemoryYandexBridgeStore();
  }
  if (!taskTracker.internal.yandexSyncEnabled || taskTracker.internal.storage === "memory") {
    return new InMemoryYandexBridgeStore();
  }

  return new PostgresYandexBridgeStore(
    new Pool({ connectionString: taskTracker.internal.databaseUrl }),
  );
};

interface ProjectManagerStoreController {
  dependencies?: ProjectManagerApiDependencies;
  stop(): Promise<void>;
}

const createProjectManagerStoreController = (
  fleetConfig: ReturnType<typeof loadFleetConfig>,
  internalTaskTracker: ReturnType<typeof createInternalTaskTrackerClient>,
  logger: Logger,
): ProjectManagerStoreController => {
  const projectManagerEnabled =
    fleetConfig.projectManager?.enabled === true ||
    fleetConfig.repositories.some(
      (repository) => repository.projectManager?.enabled === true,
    );

  if (!projectManagerEnabled || fleetConfig.taskTracker?.provider !== "internal") {
    return {
      async stop(): Promise<void> {},
    };
  }

  if (!internalTaskTracker) {
    return {
      async stop(): Promise<void> {},
    };
  }

  const buildDependencies = (store: ProjectManagerStore): ProjectManagerApiDependencies => ({
    store,
    configForRepository: (repositoryName) => {
      const repository = fleetConfig.repositories.find(
        (candidate) => candidate.name === repositoryName,
      );
      if (!repository) {
        throw new Error(`Project manager repository not found: ${repositoryName}`);
      }

      const runtimeConfig = buildRepositoryRuntimeConfig(fleetConfig, repository);
      if (!runtimeConfig.projectManager?.enabled) {
        throw new Error(
          `Project manager is not enabled for repository: ${repositoryName}`,
        );
      }
      return runtimeConfig.projectManager;
    },
    executionProfileForRepository: (repositoryName) => {
      const repository = fleetConfig.repositories.find(
        (candidate) => candidate.name === repositoryName,
      );
      if (!repository) {
        throw new Error(`Project manager repository not found: ${repositoryName}`);
      }
      return {
        repoPathKey: repository.name,
        baseBranch: repository.baseBranch,
        queue: repository.queues[0],
        tags: [...repository.tags],
      };
    },
    runner: {
      runAnalysisOnce: async (input) => {
        const repository = fleetConfig.repositories.find(
          (candidate) => candidate.name === input.repositoryName,
        );
        if (!repository) {
          throw new Error(`Project manager repository not found: ${input.repositoryName}`);
        }

        const runtimeConfig = buildRepositoryRuntimeConfig(fleetConfig, repository);
        if (!runtimeConfig.projectManager?.enabled) {
          throw new Error(
            `Project manager is not enabled for repository: ${input.repositoryName}`,
          );
        }

        const codex = new CliCodexRunner(runtimeConfig, logger);
        const orchestrator = new ProjectManagerOrchestrator({
          taskTracker: internalTaskTracker,
          codex,
          store,
          config: runtimeConfig.projectManager,
        });
        return orchestrator.runAnalysisOnce(input);
      },
      runReplanOnce: async (input) => {
        const repository = fleetConfig.repositories.find(
          (candidate) => candidate.name === input.repositoryName,
        );
        if (!repository) {
          throw new Error(`Project manager repository not found: ${input.repositoryName}`);
        }

        const runtimeConfig = buildRepositoryRuntimeConfig(fleetConfig, repository);
        if (!runtimeConfig.projectManager?.enabled) {
          throw new Error(
            `Project manager is not enabled for repository: ${input.repositoryName}`,
          );
        }

        const codex = new CliCodexRunner(runtimeConfig, logger);
        const orchestrator = new ProjectManagerOrchestrator({
          taskTracker: internalTaskTracker,
          codex,
          store,
          config: runtimeConfig.projectManager,
        });
        return orchestrator.runReplanOnce(input);
      },
      runStrategyOnce: async (input) => {
        const repository = fleetConfig.repositories.find(
          (candidate) => candidate.name === input.repositoryName,
        );
        if (!repository) {
          throw new Error(`Project manager repository not found: ${input.repositoryName}`);
        }

        const runtimeConfig = buildRepositoryRuntimeConfig(fleetConfig, repository);
        if (!runtimeConfig.projectManager?.enabled) {
          throw new Error(
            `Project manager is not enabled for repository: ${input.repositoryName}`,
          );
        }

        const codex = new CliCodexRunner(runtimeConfig, logger);
        const orchestrator = new ProjectManagerOrchestrator({
          taskTracker: internalTaskTracker,
          codex,
          store,
          config: runtimeConfig.projectManager,
        });
        return orchestrator.runStrategyOnce({
          ...input,
          repositoryProfile: input.repositoryProfile ?? {
            baseBranch: repository.baseBranch,
            queue: repository.queues[0],
            tags: [...repository.tags],
          },
        });
      },
    },
  });

  if (fleetConfig.taskTracker.internal.storage === "memory") {
    return {
      dependencies: buildDependencies(new InMemoryProjectManagerStore()),
      async stop(): Promise<void> {},
    };
  }

  const pool = new Pool({
    connectionString: fleetConfig.taskTracker.internal.databaseUrl,
  });
  const store: ProjectManagerStore = new PostgresProjectManagerStore(pool);
  return {
    dependencies: buildDependencies(store),
    stop: () => pool.end(),
  };
};

const createTelegramAssistantController = (
  fleetConfig: ReturnType<typeof loadFleetConfig>,
  internalTaskTracker: ReturnType<typeof createInternalTaskTrackerClient>,
  logger: Logger,
  projectManager?: ProjectManagerApiDependencies,
  observability?: TelegramAssistantTelemetry,
): TelegramAssistantController => {
  const config = fleetConfig.telegramAssistant;
  if (config?.enabled !== true) {
    return noopTelegramAssistantController;
  }
  if (fleetConfig.preflightOnly && !config.botToken) {
    return noopTelegramAssistantController;
  }
  if (!config.botToken) {
    throw new Error("Telegram assistant requires a bot token when enabled.");
  }
  const webhook = config.mode === "webhook" ? config.webhook : undefined;
  if (fleetConfig.preflightOnly && config.mode === "webhook" && !webhook) {
    return noopTelegramAssistantController;
  }
  if (config.mode === "webhook" && !webhook) {
    throw new Error("Telegram assistant webhook mode requires webhook config.");
  }
  const webhookUrl = webhook && !fleetConfig.preflightOnly
    ? buildTelegramWebhookUrl(fleetConfig.observability?.baseUrl ?? "", webhook.path)
    : undefined;

  let pool: Pool | undefined;
  const store: TelegramAssistantStore =
    fleetConfig.taskTracker?.provider === "internal" &&
    fleetConfig.taskTracker.internal.storage === "postgres"
      ? (() => {
          pool = new Pool({
            connectionString: fleetConfig.taskTracker.internal.databaseUrl,
          });
          return new PostgresTelegramAssistantStore(pool);
        })()
      : new InMemoryTelegramAssistantStore();

  const telegramClient = new TelegramClient({ botToken: config.botToken });
  const primaryRepository = fleetConfig.repositories[0];
  const assistantCodex = primaryRepository
    ? new TelegramAssistantCodexService({
        codex: new CliCodexRunner(
          buildTelegramAssistantCodexRuntimeConfig(
            buildRepositoryRuntimeConfig(fleetConfig, primaryRepository),
            config,
          ),
          logger,
        ),
        maxContextChars: config.codexMaxContextChars,
        timeoutSeconds: config.codexTimeoutSeconds,
        productVerifier: new WildberriesProductVerifier(),
      })
    : undefined;
  const memoryStore = fleetConfig.memory?.enabled
    ? new FileMemoryStore(fleetConfig.memory, logger)
    : undefined;
  const projectSourceProvider =
    projectManager || memoryStore
      ? new TelegramAssistantProjectContextSourceProvider({
          ...(projectManager ? { projectManager: projectManager.store } : {}),
          ...(memoryStore ? { memoryStore } : {}),
          logger,
        })
      : undefined;
  const notificationRouter = internalTaskTracker
    ? new TelegramNotificationRouter({
        store,
        telegram: telegramClient,
        taskTracker: internalTaskTracker,
        logger,
        ...(observability ? { observability } : {}),
      })
    : undefined;
  const service = new TelegramAssistantService({
    store,
    config,
    taskTracker: internalTaskTracker,
    ...(assistantCodex ? { assistantCodex } : {}),
    ...(projectSourceProvider ? { projectSourceProvider } : {}),
    repositories: fleetConfig.repositories,
    telegram: telegramClient,
    ...(notificationRouter ? { notificationRouter } : {}),
    ...(observability ? { observability } : {}),
    logger,
    botUsername: config.botUsername,
  });

  const poller = config.mode === "polling"
    ? new TelegramUpdatePoller({
        client: telegramClient,
        getOffset: () => store.getOffset("default"),
        handler: service,
        intervalSeconds: config.pollIntervalSeconds,
        withPollingLease: (operation) => store.withPollingLease("default", operation),
        logger,
        ...(observability ? { observability } : {}),
      })
    : undefined;
  const notificationIntervalMs = Math.max(
    config.pollIntervalSeconds * 1000,
    30_000,
  );
  let notificationInterval: ReturnType<typeof setInterval> | undefined;
  let notificationScanRunning = false;
  let cleanupRunning = false;
  let started = false;
  let webhookRegistered = false;

  const runNotificationScan = (): void => {
    if (!notificationRouter || notificationScanRunning) {
      return;
    }
    notificationScanRunning = true;
    service.scanNotifications()
      .catch((error) => {
        logger.warn("Telegram assistant notification scan failed.", redactSecrets({
          error: errorToMessage(error),
        }));
      })
      .finally(() => {
        notificationScanRunning = false;
      });
  };

  const startNotificationInterval = (): void => {
    if (!notificationRouter || notificationInterval) {
      return;
    }
    notificationInterval = setInterval(runNotificationScan, notificationIntervalMs);
    notificationInterval.unref?.();
  };

  const stopNotificationInterval = (): void => {
    if (!notificationInterval) {
      return;
    }
    clearInterval(notificationInterval);
    notificationInterval = undefined;
  };

  const runCleanup = async (): Promise<void> => {
    if (cleanupRunning) {
      return;
    }
    cleanupRunning = true;
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiredAssistantData = await store.purgeExpiredTelegramAssistantData({
        now: nowIso,
      });
      const digitalTwinAudit = config.digitalTwin.enabled
        ? await store.pruneDigitalTwinAuditData({
            redactedBefore: subtractDays(
              nowIso,
              config.digitalTwin.redactedRetentionDays,
            ),
            ...(config.digitalTwin.fullTextRetentionDays > 0
              ? {
                  fullTextBefore: subtractDays(
                    nowIso,
                    config.digitalTwin.fullTextRetentionDays,
                  ),
                }
              : {}),
          })
        : { redactedTextsCleared: 0, fullTextsCleared: 0 };
      logger.info("Telegram assistant retention cleanup completed.", {
        ...expiredAssistantData,
        digitalTwinAudit,
      });
    } finally {
      cleanupRunning = false;
    }
  };

  return {
    webhook: webhook
      ? {
          path: webhook.path,
          ...(webhook.secretToken !== undefined
            ? { secretToken: webhook.secretToken }
            : {}),
          handler: service,
        }
      : undefined,
    async start(): Promise<void> {
      if (started) {
        return;
      }
      if (poller) {
        await retryTelegramStartupRequest(
          "deleteWebhook",
          () => telegramClient.deleteWebhook({ dropPendingUpdates: false }),
          logger,
        );
        poller.start();
      } else if (webhookUrl) {
        await retryTelegramStartupRequest(
          "setWebhook",
          () => telegramClient.setWebhook({
            url: webhookUrl,
            ...(webhook?.secretToken !== undefined
              ? { secretToken: webhook.secretToken }
              : {}),
          }),
          logger,
        );
        webhookRegistered = true;
      }
      startNotificationInterval();
      started = true;
    },
    async runCleanupOnce(): Promise<void> {
      await runCleanup();
    },
    async stop(): Promise<void> {
      try {
        await poller?.stop();
        if (webhookRegistered) {
          await telegramClient.deleteWebhook({ dropPendingUpdates: false });
          webhookRegistered = false;
        }
      } finally {
        stopNotificationInterval();
        started = false;
        await pool?.end();
      }
    },
  };
};

export const buildApplication = (env: NodeJS.ProcessEnv = process.env) => {
  const logger = new Logger();
  const fleetConfig = loadFleetConfig(env);
  const internalTaskTracker = createInternalTaskTrackerClient(
    fleetConfig.taskTracker,
    fleetConfig.autonomy,
  );
  const projectManager = createProjectManagerStoreController(
    fleetConfig,
    internalTaskTracker,
    logger,
  );
  const primaryRepository = fleetConfig.repositories[0];
  if (!primaryRepository) {
    throw new Error("No repository profiles configured.");
  }
  if (
    !fleetConfig.preflightOnly &&
    fleetConfig.telegramAssistant?.enabled === true &&
    fleetConfig.telegramAssistant.mode === "webhook" &&
    !isObservabilityHttpServerEnabled(fleetConfig.observability)
  ) {
    throw new Error(
      "Telegram assistant webhook mode requires an enabled HTTP server.",
    );
  }
  validateTelegramWebhookRouteConfig(fleetConfig);
  let observability: ReturnType<typeof createObservabilityService> | undefined;
  const telegramAssistantTelemetry: TelegramAssistantTelemetry = {
    incrementCounter: (name, labels, value) => {
      observability?.incrementCounter(name, labels, value);
    },
    observeHistogram: (name, labels, value) => {
      observability?.observeHistogram(name, labels, value);
    },
    setGauge: (name, labels, value) => {
      observability?.setGauge(name, labels, value);
    },
  };
  const telegramAssistant = createTelegramAssistantController(
    fleetConfig,
    internalTaskTracker,
    logger,
    projectManager.dependencies,
    telegramAssistantTelemetry,
  );
  observability = createObservabilityService(
    fleetConfig.observability,
    logger,
    fleetConfig.repositories,
    internalTaskTracker,
    projectManager.dependencies,
    telegramAssistant.webhook,
  );
  const internalCleanup =
    fleetConfig.taskTracker?.provider === "internal" &&
    fleetConfig.taskTracker.internal.storage === "postgres" &&
    internalTaskTracker
      ? (() => {
          const pool = new Pool({
            connectionString: fleetConfig.taskTracker.internal.databaseUrl,
          });
          const scheduler = new InternalTrackerCleanupScheduler(
            new InternalTrackerCleanupRunner({
              db: pool,
              taskTracker: internalTaskTracker,
              operational: fleetConfig.taskTracker.internal.operational,
              metrics: fleetConfig.taskTracker.internal.operational.metricsEnabled
                ? observability.metrics
                : undefined,
              logger,
            }),
            fleetConfig.taskTracker.internal.operational,
            logger,
          );
          return {
            start: () => scheduler.start(),
            runOnce: () => scheduler.runOnce(),
            stop: async () => {
              scheduler.stop();
              await pool.end();
            },
          } satisfies CleanupController;
        })()
      : noopCleanupController;
  const telegramRetentionCleanup = createTelegramAssistantCleanupController(
    telegramAssistant,
    fleetConfig.taskTracker?.provider === "internal"
      ? fleetConfig.taskTracker.internal.operational.cleanup
      : undefined,
    logger,
  );
  const cleanup: CleanupController = {
    start: () => {
      internalCleanup.start();
      telegramRetentionCleanup.start();
    },
    runOnce: async () => {
      const result = await internalCleanup.runOnce();
      await telegramRetentionCleanup.runOnce();
      return result;
    },
    stop: async () => {
      try {
        await telegramRetentionCleanup.stop();
        await internalCleanup.stop();
      } finally {
        await projectManager.stop();
      }
    },
  };
  const internalMode = fleetConfig.taskTracker?.provider === "internal";
  const internalConfig =
    fleetConfig.taskTracker?.provider === "internal"
      ? fleetConfig.taskTracker.internal
      : undefined;
  if (internalMode && !internalTaskTracker) {
    throw new Error("TASK_TRACKER_PROVIDER=internal requires an internal task tracker client.");
  }
  const primaryConfig = buildRepositoryRuntimeConfig(fleetConfig, primaryRepository);
  const yandexBridgeStore = createYandexBridgeStore(fleetConfig.taskTracker);
  const yandexBridgeSources =
    internalConfig?.yandexSyncEnabled && internalTaskTracker
      ? new Map(
          fleetConfig.repositories.map((profile) => {
            const config = buildRepositoryRuntimeConfig(fleetConfig, profile);
            return [
              profile.name,
              new YandexExternalTaskSource(
                new YandexTrackerClient(config, logger),
                config.trackerTag,
              ),
            ] as const;
          }),
        )
      : new Map<string, YandexExternalTaskSource>();
  const yandexBridges =
    internalConfig?.yandexSyncEnabled && internalTaskTracker
      ? fleetConfig.repositories.map((profile) => {
          const source = yandexBridgeSources.get(profile.name);
          if (!source) {
            throw new Error(`Missing Yandex source for repository profile ${profile.name}.`);
          }
          return new YandexBridge({
            taskTracker: internalTaskTracker,
            source,
            store: yandexBridgeStore,
            repository: {
              repositoryName: profile.name,
              repoPathKey: profile.name,
              baseBranch: profile.baseBranch,
              queues: profile.queues,
              tags: profile.tags,
            },
            workerId: fleetConfig.workerId,
            logger,
          });
        })
      : [];
  const lockBackend =
    fleetConfig.coordination.lockBackend === "none"
      ? new NoopLockBackend()
      : new TrackerCommentLockBackend(
          new YandexTrackerClient(primaryConfig, logger),
          fleetConfig.coordination.lockTtlMs,
        );

  if (env.WORKER_CONFIG_FILE?.trim()) {
    const contexts = fleetConfig.repositories.map((profile) => {
      const context = buildRepositoryContext(
        fleetConfig,
        profile,
        logger,
        lockBackend,
        observability,
        internalTaskTracker,
      );
      const attachmentSource = yandexBridgeSources.get(profile.name);
      return attachmentSource ? { ...context, attachmentSource } : context;
    });
    const orchestrator = internalMode
      ? new InternalWorkerOrchestrator(
          fleetConfig,
          contexts,
          internalTaskTracker!,
          logger,
          undefined,
          observability,
          yandexBridges,
        )
      : new FleetOrchestrator(
          fleetConfig,
          contexts,
          lockBackend,
          logger,
          observability,
        );
    const preflight = {
      run: async () => {
        const results = await Promise.all(contexts.map((context) => context.preflight.run()));
        return results.flat();
      },
    };

    return {
      logger,
      config: fleetConfig,
      orchestrator,
      preflight,
      observability,
      cleanup,
      telegramAssistant,
      projectManager: projectManager.dependencies,
      taskTracker: internalTaskTracker,
      yandexBridges,
      assertRepositoryReady: async () => {
        await Promise.all(contexts.map((context) => context.assertRepositoryReady()));
      },
      assertCodexAuthenticated: async () => {
        await Promise.all(contexts.map((context) => context.assertCodexAuthenticated()));
      },
    };
  }

  const config = primaryConfig;
  const tracker = createRuntimeTrackerClient(config, logger, internalTaskTracker);
  const git = new RepositoryGitService(config, logger);
  const gitlab = new GitLabApiClient(config, logger);
  const codex = new CliCodexRunner(config, logger);
  const checkCodexAuth = () => assertCodexAuthenticated(config, logger);
  const primaryAttachmentSource = yandexBridgeSources.get(primaryRepository.name);
  const orchestrator = internalMode
    ? new InternalWorkerOrchestrator(
        fleetConfig,
        [
          {
            profile: primaryRepository,
            config,
            git,
            gitlab,
            codex,
            ...(primaryAttachmentSource
              ? { attachmentSource: primaryAttachmentSource }
              : {}),
          },
        ],
        internalTaskTracker!,
        logger,
        undefined,
        observability,
        yandexBridges,
      )
    : new WorkerOrchestrator(
        config,
        tracker,
        git,
        gitlab,
        codex,
        logger,
        lockBackend,
        fleetConfig.coordination,
        undefined,
        observability,
      );
  const preflight = new PreflightService(
    config,
    tracker,
    git,
    gitlab,
    checkCodexAuth,
    logger,
  );

  return {
    logger,
    config,
    orchestrator,
    preflight,
    observability,
    cleanup,
    telegramAssistant,
    projectManager: projectManager.dependencies,
    taskTracker: internalTaskTracker,
    yandexBridges,
    assertRepositoryReady: () => git.assertRepositoryReady(),
    assertCodexAuthenticated: checkCodexAuth,
  };
};

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
