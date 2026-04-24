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
  [key: string]: unknown;
  type?: string;
  thread_id?: string;
  turn_id?: string;
  item_id?: string;
  call_id?: string;
  message?: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_LOG_LINE_LENGTH = 1_000;
const MAX_DIAGNOSTIC_LENGTH = 4_000;

const truncateForLog = (value: string, maxLength = 240): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;

const formatSeconds = (milliseconds: number): string => {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

const truncateForDiagnostic = (
  value: string,
  maxLength = MAX_DIAGNOSTIC_LENGTH,
): string => {
  if (value.length <= maxLength) {
    return value;
  }

  const omittedCharacters = value.length - maxLength;
  return `${value.slice(0, maxLength)}\n[truncated ${omittedCharacters} characters]`;
};

const collectPreviewSnippets = (
  value: unknown,
  snippets: string[],
  parentKey?: string,
  depth = 0,
): void => {
  if (snippets.length >= 3 || depth > 6) {
    return;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (
      normalized &&
      parentKey &&
      ["text", "delta", "arguments", "message", "command", "summary", "output"].includes(
        parentKey,
      )
    ) {
      snippets.push(truncateForLog(normalized));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPreviewSnippets(entry, snippets, parentKey, depth + 1);
      if (snippets.length >= 3) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    collectPreviewSnippets(entry, snippets, key, depth + 1);
    if (snippets.length >= 3) {
      return;
    }
  }
};

const extractEventPreview = (event: CodexEvent): string | undefined => {
  const snippets: string[] = [];
  collectPreviewSnippets(event, snippets);
  return snippets.length > 0 ? snippets.join(" | ") : undefined;
};

const extractEventErrorMessage = (event: CodexEvent): string | undefined => {
  const message =
    typeof event.error?.message === "string" && event.error.message.trim() !== ""
      ? event.error.message
      : typeof event.message === "string" && event.message.trim() !== ""
        ? event.message
        : undefined;

  return message ? truncateForDiagnostic(message.trim()) : undefined;
};

const summarizeEvent = (
  mode: "new" | "resume",
  event: CodexEvent,
): Record<string, unknown> => {
  const item = isRecord(event.item) ? event.item : undefined;
  const errorMessage = extractEventErrorMessage(event);
  const summary = {
    mode,
    type: event.type ?? "unknown",
    ...(event.thread_id ? { threadId: event.thread_id } : {}),
    ...(event.turn_id ? { turnId: event.turn_id } : {}),
    ...(event.item_id ? { itemId: event.item_id } : {}),
    ...(event.call_id ? { callId: event.call_id } : {}),
    ...(item && typeof item.type === "string" ? { itemType: item.type } : {}),
    ...(item && typeof item.role === "string" ? { itemRole: item.role } : {}),
    ...(item && typeof item.status === "string" ? { itemStatus: item.status } : {}),
    ...(item && typeof item.name === "string" ? { itemName: item.name } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(errorMessage ? { error: truncateForLog(errorMessage, MAX_LOG_LINE_LENGTH) } : {}),
  } satisfies Record<string, unknown>;
  const preview = extractEventPreview(event);

  return {
    ...summary,
    ...(preview ? { preview } : {}),
  };
};

const logParsedStdoutEvent = (
  event: CodexEvent,
  state: CodexJsonlState,
  logger: Logger,
  mode: "new" | "resume",
  includeRawEvents: boolean,
): void => {
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    state.threadId = event.thread_id;
  }

  if (event.type === "turn.failed" || event.type === "error") {
    const errorMessage = extractEventErrorMessage(event);
    if (errorMessage) {
      state.errors.push(errorMessage);
    }
    logger.warn("Codex event.", summarizeEvent(mode, event));
  } else {
    logger.info("Codex event.", summarizeEvent(mode, event));
  }

  if (includeRawEvents) {
    logger.info("Codex raw event.", {
      mode,
      event,
    });
  }
};

const processStdoutLine = (
  line: string,
  state: CodexJsonlState,
  logger: Logger,
  mode: "new" | "resume",
  includeRawEvents: boolean,
): void => {
  try {
    const event = JSON.parse(line) as CodexEvent;
    logParsedStdoutEvent(event, state, logger, mode, includeRawEvents);
  } catch {
    const message = truncateForDiagnostic(`Failed to parse Codex JSONL event: ${line}`);
    state.errors.push(message);
    logger.warn("Failed to parse Codex JSONL event.", {
      mode,
      line: truncateForLog(line, MAX_LOG_LINE_LENGTH),
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
  includeRawEvents: boolean,
): void => {
  const stdoutLine = state.stdoutRemainder.trim();
  if (stdoutLine) {
    processStdoutLine(stdoutLine, state, logger, mode, includeRawEvents);
  }
  const stderrLine = state.stderrRemainder.trim();
  if (stderrLine) {
    logger.warn("Codex stderr.", {
      mode,
      line: truncateForLog(stderrLine, MAX_LOG_LINE_LENGTH),
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
        timeoutMs: this.config.codexTimeoutMs,
        onStdoutChunk: (chunk) => {
          consumeChunkLines(chunk, jsonlState, "stdout", (line) => {
            processStdoutLine(
              line,
              jsonlState,
              this.logger,
              input.mode,
              this.config.codexLogFullEvents,
            );
          });
        },
        onStderrChunk: (chunk) => {
          consumeChunkLines(chunk, jsonlState, "stderr", (line) => {
            this.logger.warn("Codex stderr.", {
              mode: input.mode,
              line: truncateForLog(line, MAX_LOG_LINE_LENGTH),
            });
          });
        },
      });
      flushRemainders(
        jsonlState,
        this.logger,
        input.mode,
        this.config.codexLogFullEvents,
      );
      this.logger.info("Codex command completed.", {
        mode: input.mode,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        exitCode: process.exitCode,
        ...(process.timedOut ? { timedOut: true } : {}),
      });
      if (process.timedOut) {
        this.logger.warn("Codex command timed out.", {
          mode: input.mode,
          timeout: formatSeconds(this.config.codexTimeoutMs),
        });
      }
      const finalMessage = await readFile(lastMessagePath, "utf8").catch(() => "");
      const clarification = extractClarification(
        finalMessage,
        this.config.codexQuestionMarker,
      );

      if (jsonlState.errors.length > 0) {
        this.logger.warn("Codex JSONL stream contained parseable errors.", {
          mode: input.mode,
          errors: jsonlState.errors.map((error) =>
            truncateForLog(error, MAX_LOG_LINE_LENGTH),
          ),
        });
      }

      const timeoutDiagnostic = process.timedOut
        ? `Codex command timed out after ${formatSeconds(this.config.codexTimeoutMs)}.`
        : "";
      const stderr = truncateForDiagnostic(
        [timeoutDiagnostic, process.stderr].filter(Boolean).join("\n"),
      );
      const returnedStderr =
        process.exitCode !== 0 && jsonlState.errors.length > 0
          ? [...jsonlState.errors, stderr.trim()].filter(Boolean).join("\n")
          : stderr;

      return {
        process: {
          ...process,
          stderr: truncateForDiagnostic(returnedStderr),
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
