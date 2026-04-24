import type { AppConfig } from "../../models/types.js";
import { ConfigurationError } from "../../utils/errors.js";
import { Logger } from "../../utils/logger.js";
import { runCommand } from "../../utils/shell.js";

export const getCodexShellEnv = (
  config: AppConfig,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  CODEX_HOME: config.codexHome,
  ...extraEnv,
});

export const assertCodexAuthenticated = async (
  config: AppConfig,
  logger: Logger,
): Promise<void> => {
  if (process.env.CODEX_API_KEY?.trim()) {
    logger.info("Using CODEX_API_KEY authentication for Codex CLI.");
    return;
  }

  const openAiApiKeyPresent = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (openAiApiKeyPresent) {
    logger.info(
      "OPENAI_API_KEY is present; still checking Codex CLI auth preflight.",
    );
  }

  logger.info("Checking Codex authentication status.", {
    codexHome: config.codexHome,
    command: config.codexCliCommand,
    args: [...config.codexCliArgs, "login", "status"],
  });

  const result = await runCommand({
    command: config.codexCliCommand,
    args: [...config.codexCliArgs, "login", "status"],
    cwd: config.repoPath,
    env: getCodexShellEnv(config),
  });

  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();

  if (result.exitCode !== 0) {
    throw new ConfigurationError(
      [
        `Codex CLI is not authenticated for CODEX_HOME=${config.codexHome}.`,
        "Mount or initialize a writable CODEX_HOME with an existing codex login before starting the worker.",
        "Recommended flow: bootstrap a dedicated Docker volume from your existing ~/.codex, then mount that volume into the worker container.",
        openAiApiKeyPresent
          ? "OPENAI_API_KEY alone no longer skips this preflight. To persist API key auth into CODEX_HOME, run: printenv OPENAI_API_KEY | codex login --with-api-key"
          : "",
        combinedOutput ? `codex login status output:\n${combinedOutput}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
};
