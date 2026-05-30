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
import { TelegramClient, TelegramUpdatePoller } from "./integrations/telegram/index.js";
import { createRuntimeTrackerClient } from "./integrations/tracker/factory.js";
import { YandexTrackerClient } from "./integrations/tracker/client.js";
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
import { Logger } from "./utils/logger.js";

export interface CleanupController {
  start(): void;
  runOnce(): Promise<InternalTrackerCleanupResult | undefined>;
  stop(): Promise<void>;
}

export interface TelegramAssistantController {
  readonly webhook?: TelegramWebhookRoute;
  start(): Promise<void>;
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
  incrementCounter(name: string, labels: Record<string, string>): void;
  markReady(): void;
  stop(): Promise<void>;
}

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

export const buildTelegramAssistantCodexRuntimeConfig = <
  TConfig extends { codexTimeoutMs: number },
>(
  runtimeConfig: TConfig,
  telegramConfig: { codexTimeoutSeconds: number },
): TConfig => ({
  ...runtimeConfig,
  codexTimeoutMs: Math.min(
    runtimeConfig.codexTimeoutMs,
    telegramConfig.codexTimeoutSeconds * 1000,
  ),
});

const buildTelegramWebhookUrl = (baseUrl: string, path: string): string =>
  new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();

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

  const webhookPath = normalizeRoutePath(webhook.path);
  if (webhookPath === "/") {
    throw new Error("Telegram webhook path must be a non-root path.");
  }

  const { observability } = fleetConfig;
  if (!observability) {
    throw new Error("Telegram assistant webhook mode requires an enabled HTTP server.");
  }

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
): TelegramAssistantController => {
  const config = fleetConfig.telegramAssistant;
  if (config?.enabled !== true) {
    return noopTelegramAssistantController;
  }
  if (!config.botToken) {
    throw new Error("Telegram assistant requires a bot token when enabled.");
  }
  const webhook = config.mode === "webhook" ? config.webhook : undefined;
  if (config.mode === "webhook" && !webhook) {
    throw new Error("Telegram assistant webhook mode requires webhook config.");
  }
  const webhookUrl = webhook
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
      })
    : undefined;
  const notificationIntervalMs = Math.max(
    config.pollIntervalSeconds * 1000,
    30_000,
  );
  let notificationInterval: ReturnType<typeof setInterval> | undefined;
  let notificationScanRunning = false;
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
        await telegramClient.deleteWebhook({ dropPendingUpdates: false });
        poller.start();
      } else if (webhookUrl) {
        await telegramClient.setWebhook({
          url: webhookUrl,
          ...(webhook?.secretToken !== undefined
            ? { secretToken: webhook.secretToken }
            : {}),
        });
        webhookRegistered = true;
      }
      startNotificationInterval();
      started = true;
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
    fleetConfig.telegramAssistant?.enabled === true &&
    fleetConfig.telegramAssistant.mode === "webhook" &&
    !isObservabilityHttpServerEnabled(fleetConfig.observability)
  ) {
    throw new Error(
      "Telegram assistant webhook mode requires an enabled HTTP server.",
    );
  }
  validateTelegramWebhookRouteConfig(fleetConfig);
  const telegramAssistant = createTelegramAssistantController(
    fleetConfig,
    internalTaskTracker,
    logger,
    projectManager.dependencies,
  );
  const observability = createObservabilityService(
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
  const cleanup: CleanupController = {
    start: () => internalCleanup.start(),
    runOnce: () => internalCleanup.runOnce(),
    stop: async () => {
      try {
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
