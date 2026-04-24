import { spawn } from "node:child_process";

import type { ProcessResult } from "../models/types.js";
import { TemporaryIntegrationError } from "./errors.js";

export interface ShellOptions {
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface CommandOptions extends ShellOptions {
  command: string;
  args: string[];
}

interface InternalCommandOptions extends ShellOptions {
  command: string;
  args?: string[];
  shell: boolean;
}

const DEFAULT_MAX_BUFFER_BYTES = 512 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;

const trimToLastBytes = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) {
    return "";
  }

  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }

  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
};

const appendLimitedOutput = (
  current: string,
  chunk: string,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
): string => trimToLastBytes(current + chunk, maxBufferBytes);

const runProcess = async (options: InternalCommandOptions): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: options.shell,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, FORCE_KILL_DELAY_MS);
          forceKillTimer.unref?.();
        }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendLimitedOutput(stdout, text, options.maxBufferBytes);
      options.onStdoutChunk?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = appendLimitedOutput(stderr, text, options.maxBufferBytes);
      options.onStderrChunk?.(text);
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(new TemporaryIntegrationError(`Failed to execute: ${options.command}`, error));
    });
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }

      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : code ?? 1,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });

export const runShellCommand = async (
  command: string,
  options: ShellOptions,
): Promise<ProcessResult> =>
  runProcess({
    ...options,
    command,
    shell: true,
  });

export const runCommand = async (
  options: CommandOptions,
): Promise<ProcessResult> =>
  runProcess({
    ...options,
    shell: false,
  });
