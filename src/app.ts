import { buildRepositoryRuntimeConfig, loadFleetConfig } from "./config.js";
import { assertCodexAuthenticated } from "./integrations/codex/auth.js";
import { FleetOrchestrator } from "./domain/fleetOrchestrator.js";
import { TrackerCommentLockBackend } from "./domain/lockBackend.js";
import { WorkerOrchestrator } from "./domain/orchestrator.js";
import { PreflightService } from "./domain/preflight.js";
import { buildRepositoryContext } from "./domain/repositoryContext.js";
import { CliCodexRunner } from "./integrations/codex/runner.js";
import { RepositoryGitService } from "./integrations/git/service.js";
import { GitLabApiClient } from "./integrations/gitlab/client.js";
import { YandexTrackerClient } from "./integrations/tracker/client.js";
import { Logger } from "./utils/logger.js";

export const buildApplication = (env: NodeJS.ProcessEnv = process.env) => {
  const logger = new Logger();
  const fleetConfig = loadFleetConfig(env);
  const primaryRepository = fleetConfig.repositories[0];
  if (!primaryRepository) {
    throw new Error("No repository profiles configured.");
  }

  const primaryConfig = buildRepositoryRuntimeConfig(fleetConfig, primaryRepository);
  const lockTracker = new YandexTrackerClient(primaryConfig, logger);
  const lockBackend = new TrackerCommentLockBackend(
    lockTracker,
    fleetConfig.coordination.lockTtlMs,
  );

  if (env.WORKER_CONFIG_FILE?.trim()) {
    const contexts = fleetConfig.repositories.map((profile) =>
      buildRepositoryContext(fleetConfig, profile, logger, lockBackend),
    );
    const orchestrator = new FleetOrchestrator(
      fleetConfig,
      contexts,
      lockBackend,
      logger,
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
      assertRepositoryReady: async () => {
        await Promise.all(contexts.map((context) => context.assertRepositoryReady()));
      },
      assertCodexAuthenticated: async () => {
        await Promise.all(contexts.map((context) => context.assertCodexAuthenticated()));
      },
    };
  }

  const config = primaryConfig;
  const tracker = new YandexTrackerClient(config, logger);
  const git = new RepositoryGitService(config, logger);
  const gitlab = new GitLabApiClient(config, logger);
  const codex = new CliCodexRunner(config, logger);
  const checkCodexAuth = () => assertCodexAuthenticated(config, logger);
  const orchestrator = new WorkerOrchestrator(
    config,
    tracker,
    git,
    gitlab,
    codex,
    logger,
    lockBackend,
    fleetConfig.coordination,
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
    assertRepositoryReady: () => git.assertRepositoryReady(),
    assertCodexAuthenticated: checkCodexAuth,
  };
};
