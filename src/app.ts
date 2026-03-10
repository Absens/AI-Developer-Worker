import { loadConfig } from "./config.js";
import { assertCodexAuthenticated } from "./integrations/codex/auth.js";
import { WorkerOrchestrator } from "./domain/orchestrator.js";
import { CliCodexRunner } from "./integrations/codex/runner.js";
import { RepositoryGitService } from "./integrations/git/service.js";
import { GitLabApiClient } from "./integrations/gitlab/client.js";
import { YandexTrackerClient } from "./integrations/tracker/client.js";
import { Logger } from "./utils/logger.js";

export const buildApplication = (env: NodeJS.ProcessEnv = process.env) => {
  const logger = new Logger();
  const config = loadConfig(env);
  const tracker = new YandexTrackerClient(config, logger);
  const git = new RepositoryGitService(config, logger);
  const gitlab = new GitLabApiClient(config, logger);
  const codex = new CliCodexRunner(config, logger);
  const orchestrator = new WorkerOrchestrator(
    config,
    tracker,
    git,
    gitlab,
    codex,
    logger,
  );

  return {
    logger,
    config,
    orchestrator,
    assertCodexAuthenticated: () => assertCodexAuthenticated(config, logger),
  };
};
