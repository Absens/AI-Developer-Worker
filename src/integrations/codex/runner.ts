import type {
  AppConfig,
  ClarificationQuestion,
  CodexExecution,
  CodexRunner,
} from "../../models/types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "../../utils/logger.js";
import { runCommand } from "../../utils/shell.js";
import { getCodexShellEnv } from "./auth.js";

const normalizeClarification = (
  value: unknown,
): ClarificationQuestion | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const payload = value as Record<string, unknown>;
  const summary =
    typeof payload.summary === "string" && payload.summary.trim() !== ""
      ? payload.summary.trim()
      : undefined;
  const blockingReason =
    typeof payload.blockingReason === "string" && payload.blockingReason.trim() !== ""
      ? payload.blockingReason.trim()
      : undefined;
  const question =
    typeof payload.question === "string" && payload.question.trim() !== ""
      ? payload.question.trim()
      : undefined;
  const options = Array.isArray(payload.options)
    ? payload.options
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
  const resumeHint =
    typeof payload.resumeHint === "string" && payload.resumeHint.trim() !== ""
      ? payload.resumeHint.trim()
      : "Reply with /resume <option> or /resume freeform: <your answer>.";

  if (!summary || !blockingReason || !question) {
    return undefined;
  }

  return {
    summary,
    blockingReason,
    question,
    options,
    resumeHint,
  };
};

const extractClarification = (
  message: string,
  marker: string,
): ClarificationQuestion | undefined => {
  const lines = message
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (lines.length !== 1 || !lines[0]?.startsWith(marker)) {
    return undefined;
  }

  const payload = lines[0].slice(marker.length).trim();
  if (!payload.startsWith("{")) {
    return undefined;
  }

  try {
    return normalizeClarification(JSON.parse(payload));
  } catch {
    return undefined;
  }
};

interface CodexEvent {
  type?: string;
  thread_id?: string;
  turn_id?: string;
  item_id?: string;
  call_id?: string;
  error?: { message?: string };
  usage?: Record<string, unknown>;
}

interface CodexJsonlState {
  threadId?: string;
  errors: string[];
  stdoutRemainder: string;
  stderrRemainder: string;
}

const createCodexJsonlState = (): CodexJsonlState => ({
  errors: [],
  stdoutRemainder: "",
  stderrRemainder: "",
});

const summarizeEvent = (
  mode: "new" | "resume",
  event: CodexEvent,
): Record<string, unknown> => ({
  mode,
  type: event.type ?? "unknown",
  ...(event.thread_id ? { threadId: event.thread_id } : {}),
  ...(event.turn_id ? { turnId: event.turn_id } : {}),
  ...(event.item_id ? { itemId: event.item_id } : {}),
  ...(event.call_id ? { callId: event.call_id } : {}),
  ...(event.usage ? { usage: event.usage } : {}),
  ...(event.error?.message ? { error: event.error.message } : {}),
});

const processStdoutLine = (
  line: string,
  state: CodexJsonlState,
  logger: Logger,
  mode: "new" | "resume",
): void => {
  try {
    const event = JSON.parse(line) as CodexEvent;
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      state.threadId = event.thread_id;
    }
    if (
      (event.type === "turn.failed" || event.type === "error") &&
      event.error?.message
    ) {
      state.errors.push(event.error.message);
      logger.warn("Codex event.", summarizeEvent(mode, event));
      return;
    }
    logger.info("Codex event.", summarizeEvent(mode, event));
  } catch {
    const message = `Failed to parse Codex JSONL event: ${line}`;
    state.errors.push(message);
    logger.warn("Failed to parse Codex JSONL event.", {
      mode,
      line,
    });
  }
};

const consumeChunkLines = (
  chunk: string,
  state: CodexJsonlState,
  channel: "stdout" | "stderr",
  onLine: (line: string) => void,
): void => {
  const current = channel === "stdout" ? state.stdoutRemainder : state.stderrRemainder;
  const combined = current + chunk;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? "";

  for (const line of lines.map((entry) => entry.trim()).filter(Boolean)) {
    onLine(line);
  }

  if (channel === "stdout") {
    state.stdoutRemainder = remainder;
    return;
  }
  state.stderrRemainder = remainder;
};

const flushRemainders = (
  state: CodexJsonlState,
  logger: Logger,
  mode: "new" | "resume",
): void => {
  const stdoutLine = state.stdoutRemainder.trim();
  if (stdoutLine) {
    processStdoutLine(stdoutLine, state, logger, mode);
  }
  const stderrLine = state.stderrRemainder.trim();
  if (stderrLine) {
    logger.warn("Codex stderr.", {
      mode,
      line: stderrLine,
    });
  }
  state.stdoutRemainder = "";
  state.stderrRemainder = "";
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
    const startedAt = Date.now();
    const jsonlState = createCodexJsonlState();
    const heartbeat = setInterval(() => {
      this.logger.info("Codex command still running.", {
        mode: input.mode,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        tempDir,
      });
    }, this.config.codexProgressLogIntervalMs);
    heartbeat.unref?.();
    try {
      const args = this.buildBaseArgs(lastMessagePath);
      if (input.mode === "resume" && input.threadId) {
        args.push("resume", input.threadId);
      }
      this.logger.info("Running Codex command.", {
        command: this.config.codexCliCommand,
        args: [...this.config.codexCliArgs, ...args],
        mode: input.mode,
      });

      const process = await runCommand({
        command: this.config.codexCliCommand,
        args: [...this.config.codexCliArgs, ...args],
        cwd: this.config.repoPath,
        stdin: input.prompt,
        env: getCodexShellEnv(this.config),
        onStdoutChunk: (chunk) => {
          consumeChunkLines(chunk, jsonlState, "stdout", (line) => {
            processStdoutLine(line, jsonlState, this.logger, input.mode);
          });
        },
        onStderrChunk: (chunk) => {
          consumeChunkLines(chunk, jsonlState, "stderr", (line) => {
            this.logger.warn("Codex stderr.", {
              mode: input.mode,
              line,
            });
          });
        },
      });
      flushRemainders(jsonlState, this.logger, input.mode);
      this.logger.info("Codex command completed.", {
        mode: input.mode,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        exitCode: process.exitCode,
      });
      const finalMessage = await readFile(lastMessagePath, "utf8").catch(() => "");
      const clarification = extractClarification(
        finalMessage,
        this.config.codexQuestionMarker,
      );

      if (jsonlState.errors.length > 0) {
        this.logger.warn("Codex JSONL stream contained parseable errors.", {
          mode: input.mode,
          errors: jsonlState.errors,
        });
      }

      return {
        process: {
          ...process,
          stderr:
            jsonlState.errors.length > 0
              ? [process.stderr.trim(), ...jsonlState.errors].filter(Boolean).join("\n")
              : process.stderr,
        },
        ...(finalMessage ? { finalMessage } : {}),
        ...(jsonlState.threadId ? { threadId: jsonlState.threadId } : {}),
        ...(clarification
          ? {
              clarification,
              question: clarification.question,
            }
          : {}),
      };
    } finally {
      clearInterval(heartbeat);
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
