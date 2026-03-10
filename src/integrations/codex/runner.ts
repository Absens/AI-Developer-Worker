import type { AppConfig, CodexExecution, CodexRunner } from "../../models/types.js";
import { Logger } from "../../utils/logger.js";
import { runShellCommand } from "../../utils/shell.js";
import { getCodexShellEnv } from "./auth.js";

const extractQuestion = (output: string, marker: string): string | undefined => {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(marker));

  if (!line) {
    return undefined;
  }

  return line.slice(marker.length).trim();
};

export class CliCodexRunner implements CodexRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  runInitial(prompt: string): Promise<CodexExecution> {
    return this.run(prompt);
  }

  runFix(prompt: string): Promise<CodexExecution> {
    return this.run(prompt);
  }

  private async run(prompt: string): Promise<CodexExecution> {
    this.logger.info("Running Codex command.");
    const process = await runShellCommand(this.config.codexCommand, {
      cwd: this.config.repoPath,
      stdin: prompt,
      env: getCodexShellEnv(this.config),
    });
    const combinedOutput = `${process.stdout}\n${process.stderr}`;
    const question = extractQuestion(combinedOutput, this.config.codexQuestionMarker);

    return {
      process,
      ...(question ? { question } : {}),
    };
  }
}
