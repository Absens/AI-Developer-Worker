import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  codexTimeoutMs: 30 * 60 * 1000,
  codexProgressLogIntervalMs: 30 * 1000,
  codexLogFullEvents: false,
  codexQuestionMarker: "AI_QUESTION:",
  codexSelfReviewEnabled: false,
  codexSelfReviewMaxFixAttempts: 1,
  maxFixAttempts: 2,
  maxReviewFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
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
  it("runs codex exec review against the configured base branch", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-review-runner.cjs");
    const argsPath = join(tempDir, "review-args.json");
    const stdinPath = join(tempDir, "review-stdin.txt");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        `fs.writeFileSync(${JSON.stringify(stdinPath)}, fs.readFileSync(0, 'utf8'), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'AI_SELF_REVIEW: {\"status\":\"pass\",\"summary\":\"No blocking issues.\",\"findings\":[]}\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-review' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexModel: "gpt-5.5",
      },
      new Logger(),
    );

    const execution = await runner.runReview("Review this diff.", undefined, {
      baseBranch: "main",
      title: "[AI] DEV-1 implementation",
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const lastMessageFile = args.at(args.indexOf("--output-last-message") + 1);
    expect(args).toEqual([
      "exec",
      "review",
      "--json",
      "--output-last-message",
      lastMessageFile,
      "--base",
      "main",
      "--uncommitted",
      "--title",
      "[AI] DEV-1 implementation",
      "--model",
      "gpt-5.5",
      "--skip-git-repo-check",
      "--ephemeral",
      "-",
    ]);
    expect(readFileSync(stdinPath, "utf8")).toBe("Review this diff.");
    expect(execution.finalMessage).toContain("AI_SELF_REVIEW:");
    expect(execution.threadId).toBe("thread-review");
  });

  it("passes image paths to initial codex exec runs", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    const firstImagePath = join(tempDir, "first.png");
    const secondImagePath = join(tempDir, "second.png");
    writeFileSync(firstImagePath, "first", "utf8");
    writeFileSync(secondImagePath, "second", "utf8");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-images' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );

    await runner.runInitial("Implement this change.", undefined, {
      imagePaths: [firstImagePath, secondImagePath],
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    expect(args).toEqual(
      expect.arrayContaining(["--image", firstImagePath, "--image", secondImagePath]),
    );
    expect(args.indexOf("--image")).toBeGreaterThan(args.indexOf("exec"));
    expect(args).not.toContain("resume");
  });

  it("writes output schema to a temp file and passes it to codex exec", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    const schemaSnapshotPath = join(tempDir, "schema-snapshot.json");
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["ok"] },
      },
    };
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const schemaIndex = args.indexOf('--output-schema');",
        "if (schemaIndex < 0) { process.exit(2); }",
        `fs.writeFileSync(${JSON.stringify(schemaSnapshotPath)}, fs.readFileSync(args[schemaIndex + 1], 'utf8'), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, '{\"status\":\"ok\"}\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-schema' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );

    await runner.runInitial("Return schema output.", undefined, { outputSchema });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const schemaIndex = args.indexOf("--output-schema");
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(args[schemaIndex + 1]).toContain("output-schema.json");
    expect(JSON.parse(readFileSync(schemaSnapshotPath, "utf8"))).toEqual(outputSchema);
  });

  it("adds per-run web search as one global argument before codex exec", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Research complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-search' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );

    await runner.runInitial("Research this product.", undefined, {
      webSearch: true,
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    expect(args.filter((arg) => arg === "--search")).toHaveLength(1);
    expect(args.indexOf("--search")).toBeLessThan(args.indexOf("exec"));
  });

  it("overrides configured sandbox for initial codex exec runs", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-sandbox' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexSandbox: "workspace-write",
      },
      new Logger(),
    );

    await runner.runInitial("Analyze this change.", undefined, {
      sandbox: "read-only",
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual([
      "--sandbox",
      "read-only",
    ]);
    expect(args).not.toContain("workspace-write");
  });

  it("keeps sandbox override authoritative over configured exec args", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-sandbox-exec-args' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexSandbox: "workspace-write",
        codexExecArgs: ["--sandbox", "danger-full-access"],
      },
      new Logger(),
    );

    await runner.runInitial("Analyze this change.", undefined, {
      sandbox: "read-only",
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const sandboxIndexes = args
      .map((arg, index) => (arg === "--sandbox" ? index : -1))
      .filter((index) => index >= 0);
    const lastSandboxIndex = sandboxIndexes.at(-1);

    if (lastSandboxIndex === undefined) {
      throw new Error("Expected sandbox argument to be present.");
    }
    expect(args.slice(lastSandboxIndex, lastSandboxIndex + 2)).toEqual([
      "--sandbox",
      "read-only",
    ]);
    expect(args.slice(lastSandboxIndex + 2)).not.toContain("--sandbox");
    expect(args).not.toContain("danger-full-access");
  });

  it("strips sandbox-affecting exec args when sandbox is overridden", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-sandbox-variants' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexSandbox: "workspace-write",
        codexExecArgs: [
          "--sandbox=danger-full-access",
          "-s",
          "workspace-write",
          "-s=danger-full-access",
          "--dangerously-bypass-approvals-and-sandbox",
          "--config",
          "sandbox_mode=\"danger-full-access\"",
          "-c=sandbox_mode=\"workspace-write\"",
          "--ignore-rules",
        ],
      },
      new Logger(),
    );

    await runner.runInitial("Analyze this change.", undefined, {
      sandbox: "read-only",
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const sandboxIndexes = args
      .map((arg, index) => (arg === "--sandbox" ? index : -1))
      .filter((index) => index >= 0);

    expect(sandboxIndexes).toHaveLength(1);
    const sandboxIndex = sandboxIndexes[0];
    if (sandboxIndex === undefined) {
      throw new Error("Expected sandbox argument to be present.");
    }
    expect(args.slice(sandboxIndex, sandboxIndex + 2)).toEqual(["--sandbox", "read-only"]);
    expect(args).toContain("--ignore-rules");
    expect(args.join(" ")).not.toContain("danger-full-access");
    expect(args).not.toContain("-s");
    expect(args.some((arg) => arg.startsWith("-s="))).toBe(false);
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("sandbox_mode=\"danger-full-access\"");
    expect(args.some((arg) => arg.includes("sandbox_mode"))).toBe(false);
  });

  it("strips sandbox-affecting global cli args and preserves ordinary config args", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-global-sandbox-args' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [
          scriptPath,
          "--dangerously-bypass-approvals-and-sandbox",
          "--config",
          "sandbox_mode=\"danger-full-access\"",
          "--config",
          "model_provider=\"local\"",
          "--config",
          "model_provider=\"sandboxed-local\"",
        ]),
        codexSandbox: "workspace-write",
        codexExecArgs: [
          "--config",
          "model_reasoning_effort=\"low\"",
          "--config",
          "profile_name=\"sandbox-analysis\"",
          "--sandbox",
          "danger-full-access",
        ],
      },
      new Logger(),
    );

    await runner.runInitial("Analyze this change.", undefined, {
      sandbox: "read-only",
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.join(" ")).not.toContain("danger-full-access");
    expect(args.some((arg) => arg.includes("sandbox_mode"))).toBe(false);
    expect(args).toEqual(
      expect.arrayContaining([
        "--config",
        "model_provider=\"local\"",
        "--config",
        "model_provider=\"sandboxed-local\"",
        "--config",
        "model_reasoning_effort=\"low\"",
        "--config",
        "profile_name=\"sandbox-analysis\"",
        "--sandbox",
        "read-only",
      ]),
    );
  });

  it("passes image paths to resume codex exec runs", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    const imagePath = join(tempDir, "screen.png");
    writeFileSync(imagePath, "image", "utf8");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );

    await runner.runResume("thread-123", "Implement this change.", undefined, {
      imagePaths: [imagePath],
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const resumeIndex = args.indexOf("resume");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(args.slice(resumeIndex)).toEqual(
      expect.arrayContaining(["--image", imagePath, "thread-123"]),
    );
    expect(args.indexOf("--image")).toBeGreaterThan(resumeIndex);
  });

  it("keeps exec-level options before resume and sends resumed prompt through stdin", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    const argsPath = join(tempDir, "args.json");
    const stdinPath = join(tempDir, "stdin.txt");
    const imagePath = join(tempDir, "screen.png");
    writeFileSync(imagePath, "image", "utf8");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "let stdin = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { stdin += chunk; });",
        "process.stdin.on('end', () => {",
        `  fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        `  fs.writeFileSync(${JSON.stringify(stdinPath)}, stdin, 'utf8');`,
        "  const outputIndex = args.indexOf('--output-last-message');",
        "  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "  if (outputPath) {",
        "    fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "  }",
        "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-contract' }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
        "});",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexSandbox: "danger-full-access",
        codexModel: "gpt-5.2",
        codexProfile: "visual-worker",
        codexExecArgs: ["--ignore-rules"],
      },
      new Logger(),
    );

    await runner.runResume("thread-contract", "Resume this exact prompt.", undefined, {
      imagePaths: [imagePath],
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const lastMessageFile = args.at(args.indexOf("--output-last-message") + 1);
    expect(args).toEqual([
      "exec",
      "--json",
      "--output-last-message",
      lastMessageFile,
      "-C",
      tempDir,
      "--skip-git-repo-check",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.2",
      "--profile",
      "visual-worker",
      "--ignore-rules",
      "resume",
      "--image",
      imagePath,
      "thread-contract",
    ]);
    expect(readFileSync(stdinPath, "utf8")).toBe("Resume this exact prompt.");
    expect(args).not.toContain("Resume this exact prompt.");
  });

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

  it("logs top-level JSONL error messages without failing successful runs", async () => {
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
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-reconnect' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'error', message: 'Reconnecting after transient websocket failure' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const logger = new TestLogger();
    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      logger,
    );

    const execution = await runner.runInitial("Implement this change.");

    expect(execution.process.exitCode).toBe(0);
    expect(execution.process.stderr).not.toContain("Reconnecting after transient");
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "WARN" &&
          entry.message === "Codex event." &&
          (entry.context as { type?: string; error?: string } | undefined)?.type === "error" &&
          (entry.context as { error?: string } | undefined)?.error?.includes(
            "Reconnecting after transient",
          ),
      ),
    ).toBe(true);
  });

  it("adds JSONL error messages to stderr only when Codex exits non-zero", async () => {
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
        "  fs.writeFileSync(outputPath, 'Implementation failed\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Model turn failed' } }) + '\\n');",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );

    const execution = await runner.runInitial("Implement this change.");

    expect(execution.process.exitCode).toBe(1);
    expect(execution.process.stderr).toContain("Model turn failed");
  });

  it("truncates noisy Codex stderr diagnostics returned to the orchestrator", async () => {
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
        "  fs.writeFileSync(outputPath, 'Implementation failed\\n', 'utf8');",
        "}",
        "process.stderr.write('x'.repeat(5000));",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new Logger(),
    );

    const execution = await runner.runInitial("Implement this change.");

    expect(execution.process.exitCode).toBe(1);
    expect(execution.process.stderr.length).toBeLessThan(4100);
    expect(execution.process.stderr).toContain("[truncated");
  });

  it("times out long-running Codex commands", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    writeFileSync(
      scriptPath,
      [
        "setInterval(() => {",
        "  process.stdout.write('still running\\n');",
        "}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const logger = new TestLogger();
    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexTimeoutMs: 50,
        codexProgressLogIntervalMs: 60 * 1000,
      },
      logger,
    );

    const execution = await runner.runInitial("Implement this change.");

    expect(execution.process.timedOut).toBe(true);
    expect(execution.process.exitCode).toBe(124);
    expect(execution.process.stderr).toContain("Codex command timed out after 1 second.");
    expect(
      logger.entries.some(
        (entry) => entry.level === "WARN" && entry.message === "Codex command timed out.",
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

  it("emits allowlisted progress events to the observer without raw command output", async () => {
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
        "process.stdout.write(JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'TOKEN=super-secret npm test', status: 'in_progress' } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'TOKEN=super-secret I am checking tests.' } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', status: 'completed', exit_code: 0, aggregated_output: 'TOKEN=super-secret raw output' } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const events: unknown[] = [];
    const runner = new CliCodexRunner(
      createConfig(tempDir, "node", [scriptPath]),
      new TestLogger(),
    );

    await runner.runInitial("Implement this change.", (event) => events.push(event));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "codex_command_started",
          mode: "new",
          type: "item.started",
          itemType: "command_execution",
          itemStatus: "in_progress",
        }),
        expect.objectContaining({
          kind: "codex_agent_message",
          mode: "new",
          type: "item.completed",
          itemType: "agent_message",
          message: "TOKEN=[redacted] I am checking tests.",
        }),
        expect.objectContaining({
          kind: "codex_command_completed",
          mode: "new",
          type: "item.completed",
          itemType: "command_execution",
          itemStatus: "completed",
          exitCode: 0,
        }),
        expect.objectContaining({
          kind: "codex_turn_completed",
          mode: "new",
          type: "turn.completed",
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("super-secret");
    expect(JSON.stringify(events)).not.toContain("aggregated_output");
    expect(JSON.stringify(events)).not.toContain("raw output");
    expect(JSON.stringify(events)).not.toContain("TOKEN=[redacted] npm test");
  });

  it("emits periodic progress heartbeat events while Codex is still running", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-runner.cjs");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "setTimeout(() => {",
        "  if (outputPath) {",
        "    fs.writeFileSync(outputPath, 'Implementation complete\\n', 'utf8');",
        "  }",
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
        "}, 80);",
      ].join("\n"),
      "utf8",
    );

    const events: Array<{ kind?: string; elapsedSeconds?: number }> = [];
    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexProgressLogIntervalMs: 10,
      },
      new TestLogger(),
    );

    await runner.runInitial("Implement this change.", (event) => events.push(event));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "codex_command_progress",
          elapsedSeconds: expect.any(Number),
        }),
      ]),
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
