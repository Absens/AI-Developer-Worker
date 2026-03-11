import { spawn } from "node:child_process";

import type { ProcessResult } from "../models/types.js";
import { TemporaryIntegrationError } from "./errors.js";

export interface ShellOptions {
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface CommandOptions extends ShellOptions {
  command: string;
  args: string[];
}

export const runShellCommand = async (
  command: string,
  options: ShellOptions,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdoutChunk?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderrChunk?.(text);
    });
    child.on("error", (error) => {
      reject(new TemporaryIntegrationError(`Failed to execute: ${command}`, error));
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });

export const runCommand = async (
  options: CommandOptions,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdoutChunk?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderrChunk?.(text);
    });
    child.on("error", (error) => {
      reject(new TemporaryIntegrationError(`Failed to execute: ${options.command}`, error));
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
