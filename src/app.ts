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
import { createObservabilityService } from "./observability/service.js";
import { Logger } from "./utils/logger.js";

export const buildApplication = (env: NodeJS.ProcessEnv = process.env) => {
  const logger = new Logger();
  const fleetConfig = loadFleetConfig(env);
  const observability = createObservabilityService(
    fleetConfig.observability,
    logger,
    fleetConfig.repositories,
  );
  const primaryRepository = fleetConfig.repositories[0];
  if (!primaryRepository) {
    throw new Error("No repository profiles configured.");
  }

  const internalTaskTracker = createInternalTaskTrackerClient(fleetConfig.taskTracker);
  const internalMode = fleetConfig.taskTracker?.provider === "internal";
  if (internalMode && !internalTaskTracker) {
    throw new Error("TASK_TRACKER_PROVIDER=internal requires an internal task tracker client.");
  }
  const primaryConfig = buildRepositoryRuntimeConfig(fleetConfig, primaryRepository);
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
    assertRepositoryReady: () => git.assertRepositoryReady(),
    assertCodexAuthenticated: checkCodexAuth,
  };
};
