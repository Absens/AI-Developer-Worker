import { Pool } from "pg";

import { buildRepositoryRuntimeConfig, loadFleetConfig } from "./config.js";
import { assertCodexAuthenticated } from "./integrations/codex/auth.js";
import { FleetOrchestrator } from "./domain/fleetOrchestrator.js";
import { InternalWorkerOrchestrator } from "./domain/internalWorkerOrchestrator.js";
import { NoopLockBackend, TrackerCommentLockBackend } from "./domain/lockBackend.js";
import { WorkerOrchestrator } from "./domain/orchestrator.js";
import { PreflightService } from "./domain/preflight.js";
import {
  InMemoryProjectManagerStore,
  ProjectManagerOrchestrator,
  type ProjectManagerStore,
} from "./domain/projectManager/index.js";
import { buildRepositoryContext } from "./domain/repositoryContext.js";
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
import { createRuntimeTrackerClient } from "./integrations/tracker/factory.js";
import { YandexTrackerClient } from "./integrations/tracker/client.js";
import {
  InMemoryYandexBridgeStore,
  PostgresYandexBridgeStore,
  YandexBridge,
  YandexExternalTaskSource,
  type YandexBridgeStore,
} from "./integrations/yandexBridge/index.js";
import { createObservabilityService } from "./observability/service.js";
import type { ProjectManagerApiDependencies } from "./observability/taskTrackerHumanApi.js";
import { Logger } from "./utils/logger.js";

interface CleanupController {
  start(): void;
  runOnce(): Promise<InternalTrackerCleanupResult | undefined>;
  stop(): Promise<void>;
}

const noopCleanupController: CleanupController = {
  start(): void {},
  async runOnce(): Promise<undefined> {
    return undefined;
  },
  async stop(): Promise<void> {},
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
  const observability = createObservabilityService(
    fleetConfig.observability,
    logger,
    fleetConfig.repositories,
    internalTaskTracker,
    projectManager.dependencies,
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
  const primaryRepository = fleetConfig.repositories[0];
  if (!primaryRepository) {
    throw new Error("No repository profiles configured.");
  }

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
    projectManager: projectManager.dependencies,
    taskTracker: internalTaskTracker,
    yandexBridges,
    assertRepositoryReady: () => git.assertRepositoryReady(),
    assertCodexAuthenticated: checkCodexAuth,
  };
};
