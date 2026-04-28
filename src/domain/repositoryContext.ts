import { buildRepositoryRuntimeConfig } from "../config.js";
import { assertCodexAuthenticated } from "../integrations/codex/auth.js";
import { CliCodexRunner } from "../integrations/codex/runner.js";
import { RepositoryGitService } from "../integrations/git/service.js";
import { GitLabApiClient } from "../integrations/gitlab/client.js";
import { createRuntimeTrackerClient } from "../integrations/tracker/factory.js";
import type {
  GlobalWorkerConfig,
  LockBackend,
  RepositoryProfile,
  RepositoryRuntimeConfig,
  TrackerClient,
} from "../models/types.js";
import type { TaskTrackerClient } from "./taskTracker/index.js";
import type { ObservabilityTelemetry } from "../observability/service.js";
import { Logger } from "../utils/logger.js";
import { WorkerOrchestrator } from "./orchestrator.js";
import { PreflightService } from "./preflight.js";

export interface RepositoryWorkerContext {
  profile: RepositoryProfile;
  config: RepositoryRuntimeConfig;
  tracker: TrackerClient;
  git: RepositoryGitService;
  gitlab: GitLabApiClient;
  codex: CliCodexRunner;
  orchestrator: WorkerOrchestrator;
  preflight: PreflightService;
  assertRepositoryReady(): Promise<void>;
  assertCodexAuthenticated(): Promise<void>;
}

export const buildRepositoryContext = (
  globalConfig: GlobalWorkerConfig,
  profile: RepositoryProfile,
  logger: Logger,
  lockBackend?: LockBackend,
  telemetry?: ObservabilityTelemetry,
  internalTaskTracker?: TaskTrackerClient,
): RepositoryWorkerContext => {
  const config = buildRepositoryRuntimeConfig(globalConfig, profile);
  const tracker = createRuntimeTrackerClient(config, logger, internalTaskTracker);
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
    globalConfig.coordination,
    undefined,
    telemetry,
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
    profile,
    config,
    tracker,
    git,
    gitlab,
    codex,
    orchestrator,
    preflight,
    assertRepositoryReady: () => git.assertRepositoryReady(),
    assertCodexAuthenticated: checkCodexAuth,
  };
};
