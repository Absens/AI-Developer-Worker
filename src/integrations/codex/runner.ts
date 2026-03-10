import type { AppConfig, CodexExecution, CodexRunner } from "../../models/types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "../../utils/logger.js";
import { runCommand } from "../../utils/shell.js";
import { getCodexShellEnv } from "./auth.js";

const extractQuestion = (message: string, marker: string): string | undefined => {
  const lines = message
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (lines.length !== 1 || !lines[0]?.startsWith(marker)) {
    return undefined;
  }

  return lines[0].slice(marker.length).trim();
};

interface CodexEvent {
  type?: string;
  thread_id?: string;
  error?: { message?: string };
}

const parseCommandTokens = (command: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const parseJsonlOutput = (stdout: string): { threadId?: string; errors: string[] } => {
  const errors: string[] = [];
  let threadId: string | undefined;

  for (const line of stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as CodexEvent;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (
        (event.type === "turn.failed" || event.type === "error") &&
        event.error?.message
      ) {
        errors.push(event.error.message);
      }
    } catch {
      errors.push(`Failed to parse Codex JSONL event: ${line}`);
    }
  }

  return { threadId, errors };
};

export class CliCodexRunner implements CodexRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  runInitial(prompt: string): Promise<CodexExecution> {
    return this.run({
      prompt,
      mode: "new",
    });
  }

  runFix(prompt: string): Promise<CodexExecution> {
    return this.run({
      prompt,
      mode: "new",
    });
  }

  runResume(threadId: string, prompt: string): Promise<CodexExecution> {
    return this.run({
      prompt,
      mode: "resume",
      threadId,
    });
  }

  private buildBaseArgs(lastMessagePath: string): string[] {
    const args = [
      "exec",
      "--json",
      "--output-last-message",
      lastMessagePath,
      "-C",
      this.config.repoPath,
      "--skip-git-repo-check",
      "--sandbox",
      this.config.codexSandbox,
    ];

    if (this.config.codexModel) {
      args.push("--model", this.config.codexModel);
    }
    if (this.config.codexProfile) {
      args.push("--profile", this.config.codexProfile);
    }
    args.push(...this.config.codexExecArgs);
    return args;
  }

  private async run(input: {
    prompt: string;
    mode: "new" | "resume";
    threadId?: string;
  }): Promise<CodexExecution> {
    const tempDir = await mkdtemp(join(tmpdir(), "codex-runner-"));
    const lastMessagePath = join(tempDir, "last-message.txt");
    try {
      const args = this.buildBaseArgs(lastMessagePath);
      if (input.mode === "resume" && input.threadId) {
        args.push("resume", input.threadId);
      }
      const commandTokens = parseCommandTokens(this.config.codexCliCommand);
      const [command, ...prefixArgs] = commandTokens;

      if (!command) {
        throw new Error("CODEX_CLI_COMMAND must not be empty.");
      }

      this.logger.info("Running Codex command.", {
        command,
        args: [...prefixArgs, ...args],
        mode: input.mode,
      });

      const process = await runCommand({
        command,
        args: [...prefixArgs, ...args],
        cwd: this.config.repoPath,
        stdin: input.prompt,
        env: getCodexShellEnv(this.config),
      });
      const { threadId, errors } = parseJsonlOutput(process.stdout);
      const finalMessage = await readFile(lastMessagePath, "utf8").catch(() => "");
      const question = extractQuestion(finalMessage, this.config.codexQuestionMarker);

      if (errors.length > 0) {
        this.logger.warn("Codex JSONL stream contained parseable errors.", {
          mode: input.mode,
          errors,
        });
      }

      return {
        process: {
          ...process,
          stderr:
            errors.length > 0
              ? [process.stderr.trim(), ...errors].filter(Boolean).join("\n")
              : process.stderr,
        },
        ...(finalMessage ? { finalMessage } : {}),
        ...(threadId ? { threadId } : {}),
        ...(question ? { question } : {}),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
