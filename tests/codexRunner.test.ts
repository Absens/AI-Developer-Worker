import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliCodexRunner } from "../src/integrations/codex/runner.js";
import type { AppConfig } from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "codex-runner-test-"));
  tempDirs.push(path);
  return path;
};

class TestLogger extends Logger {
  readonly entries: Array<{ level: string; message: string; context?: unknown }> = [];

  override info(message: string, context?: unknown): void {
    this.entries.push({ level: "INFO", message, context });
  }

  override warn(message: string, context?: unknown): void {
    this.entries.push({ level: "WARN", message, context });
  }

  override error(message: string, context?: unknown): void {
    this.entries.push({ level: "ERROR", message, context });
  }
}

const createConfig = (
  repoPath: string,
  codexCliCommand: string,
  codexCliArgs: string[] = [],
): AppConfig => ({
  trackerToken: "tracker-token",
  trackerOrgHeader: "X-Cloud-Org-ID",
  trackerOrgId: "org-id",
  trackerDefaultQueue: "FRONTEND",
  trackerTag: "ai_dev",
  trackerStatusMap: {
    open: { statuses: ["Open"] },
    in_progress: { statuses: ["In Progress"], transition: "start" },
    waiting_for_answer: { statuses: ["Waiting"], transition: "wait" },
    review: { statuses: ["Review"], transition: "review" },
    failed: { statuses: ["Failed"], transition: "fail" },
    done: { statuses: ["Done"], transition: "done" },
  },
  trackerApiBaseUrl: "http://localhost:9999/v3",
  gitlabUrl: "https://gitlab.example.com",
  gitlabToken: "token",
  gitlabProjectId: "1",
  gitRemoteName: "origin",
  gitRepositoryToken: "token",
  gitRepositoryUsername: "oauth2",
  gitCommitNoVerify: true,
  repoPath,
  baseBranch: "main",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  codexHome: "/codex-home",
  codexCliCommand,
  codexCliArgs,
  codexSandbox: "workspace-write",
  codexExecArgs: [],
  codexProgressLogIntervalMs: 30 * 1000,
  codexLogFullEvents: false,
  codexQuestionMarker: "AI_QUESTION:",
  maxFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  runOnce: false,
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("CliCodexRunner", () => {
  it("parses thread id and structured AI clarification from exec output", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'AI_QUESTION: {\"summary\":\"Need API decision\",\"blockingReason\":\"Implementation depends on the endpoint contract\",\"question\":\"Which API variant should be used?\",\"options\":[\"A: use v1\",\"B: use v2\"],\"resumeHint\":\"Reply with /resume A or /resume B.\"}\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );
    const execution = await runner.runInitial("Implement this change.");

    expect(execution.threadId).toBe("thread-123");
    expect(execution.finalMessage).toContain("AI_QUESTION:");
    expect(execution.question).toBe("Which API variant should be used?");
    expect(execution.clarification).toEqual({
      summary: "Need API decision",
      blockingReason: "Implementation depends on the endpoint contract",
      question: "Which API variant should be used?",
      options: ["A: use v1", "B: use v2"],
      resumeHint: "Reply with /resume A or /resume B.",
    });
  });

  it("does not treat stderr noise as an AI question", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-456' }) + '\\n');",
        "process.stderr.write('AI_QUESTION: misleading stderr\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );
    const execution = await runner.runInitial("Implement this change.");

    expect(execution.threadId).toBe("thread-456");
    expect(execution.finalMessage).toContain("Implementation complete");
    expect(execution.question).toBeUndefined();
  });

  it("streams codex events and stderr lines into the logger", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-789' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } }) + '\\n');",
        "process.stderr.write('tool says hello\\n');",
      ].join("\n"),
      "utf8",
    );

    const logger = new TestLogger();
    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      logger,
    );

    await runner.runInitial("Implement this change.");

    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "INFO" &&
          entry.message === "Codex event." &&
          (entry.context as { type?: string } | undefined)?.type === "thread.started",
      ),
    ).toBe(true);
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "INFO" &&
          entry.message === "Codex event." &&
          (entry.context as { type?: string } | undefined)?.type === "turn.completed",
      ),
    ).toBe(true);
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "WARN" &&
          entry.message === "Codex stderr." &&
          (entry.context as { line?: string } | undefined)?.line === "tool says hello",
      ),
    ).toBe(true);
  });

  it("adds a readable preview for nested event content", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Inspecting repository and preparing edits.' }] } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const logger = new TestLogger();
    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      logger,
    );

    await runner.runInitial("Implement this change.");

    const entry = logger.entries.find(
      (candidate) =>
        candidate.level === "INFO" &&
        candidate.message === "Codex event." &&
        (candidate.context as { type?: string } | undefined)?.type === "item.completed",
    );

    expect(entry).toBeDefined();
    expect((entry?.context as { itemType?: string } | undefined)?.itemType).toBe("message");
    expect((entry?.context as { itemRole?: string } | undefined)?.itemRole).toBe("assistant");
    expect((entry?.context as { preview?: string } | undefined)?.preview).toContain(
      "Inspecting repository and preparing edits.",
    );
  });

  it("logs raw codex events when CODEX_LOG_FULL_EVENTS is enabled", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'function_call', name: 'shell' }, call_id: 'call-1' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const logger = new TestLogger();
    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexLogFullEvents: true,
      },
      logger,
    );

    await runner.runInitial("Implement this change.");

    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "INFO" &&
          entry.message === "Codex raw event." &&
          (entry.context as { event?: { call_id?: string } } | undefined)?.event?.call_id ===
            "call-1",
      ),
    ).toBe(true);
  });
});
