import { Pool } from "pg";

import { buildRepositoryRuntimeConfig, loadFleetConfig } from "./config.js";
import { assertCodexAuthenticated } from "./integrations/codex/auth.js";
import { FleetOrchestrator } from "./domain/fleetOrchestrator.js";
import { InternalWorkerOrchestrator } from "./domain/internalWorkerOrchestrator.js";
import { NoopLockBackend, TrackerCommentLockBackend } from "./domain/lockBackend.js";
import { WorkerOrchestrator } from "./domain/orchestrator.js";
import { PreflightService } from "./domain/preflight.js";
import { buildRepositoryContext } from "./domain/repositoryContext.js";
import { CliCodexRunner } from "./integrations/codex/runner.js";
import { RepositoryGitService } from "./integrations/git/service.js";
import { GitLabApiClient } from "./integrations/gitlab/client.js";
import { createInternalTaskTrackerClient } from "./integrations/internalTracker/index.js";
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
import { Logger } from "./utils/logger.js";

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

export const buildApplication = (env: NodeJS.ProcessEnv = process.env) => {
  const logger = new Logger();
  const fleetConfig = loadFleetConfig(env);
  const internalTaskTracker = createInternalTaskTrackerClient(fleetConfig.taskTracker);
  const observability = createObservabilityService(
    fleetConfig.observability,
    logger,
    fleetConfig.repositories,
    internalTaskTracker,
  );
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
  const yandexBridges =
    internalConfig?.yandexSyncEnabled && internalTaskTracker
      ? fleetConfig.repositories.map((profile) => {
          const config = buildRepositoryRuntimeConfig(fleetConfig, profile);
          return new YandexBridge({
            taskTracker: internalTaskTracker,
            source: new YandexExternalTaskSource(
              new YandexTrackerClient(config, logger),
              config.trackerTag,
            ),
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
    const contexts = fleetConfig.repositories.map((profile) =>
      buildRepositoryContext(
        fleetConfig,
        profile,
        logger,
        lockBackend,
        observability,
        internalTaskTracker,
      ),
    );
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
    taskTracker: internalTaskTracker,
    yandexBridges,
    assertRepositoryReady: () => git.assertRepositoryReady(),
    assertCodexAuthenticated: checkCodexAuth,
  };
};
