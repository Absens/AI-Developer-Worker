import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildQualityGates,
  collectQualityGateNotes,
  formatQualityGateDiagnostics,
  formatQualityGateSummary,
  runQualityGates,
  type QualityGateCommandRunner,
} from "../src/domain/qualityGates.js";
import type { AppConfig, ProcessResult } from "../src/models/types.js";

const cleanupPaths: string[] = [];

const createTempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "quality-gates-test-"));
  cleanupPaths.push(path);
  return path;
};

const createConfig = (repoPath: string, overrides: Partial<AppConfig> = {}): AppConfig => ({
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
  codexCliCommand: "codex",
  codexCliArgs: [],
  codexSandbox: "workspace-write",
  codexExecArgs: [],
  codexTimeoutMs: 30 * 60 * 1000,
  codexProgressLogIntervalMs: 30 * 1000,
  codexLogFullEvents: false,
  codexQuestionMarker: "AI_QUESTION:",
  maxFixAttempts: 2,
  maxReviewFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "test-command",
  lintCommand: "lint-command",
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
  ...overrides,
});

const successfulRunner =
  (commands: string[] = []): QualityGateCommandRunner =>
  async (command: string): Promise<ProcessResult> => {
    commands.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  };

describe("quality gates", () => {
  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("builds gates in fail-fast order", () => {
    const config = createConfig(process.cwd(), {
      typeCheckCommand: "typecheck-command",
      buildCommand: "build-command",
      securityScanCommand: "security-command",
      sastCommand: "sast-command",
      coverageCommand: "coverage-command",
      visualRegressionCommand: "visual-command",
    });

    expect(buildQualityGates(config).map((gate) => gate.id)).toEqual([
      "typecheck",
      "lint",
      "tests",
      "build",
      "security_scan",
      "sast",
      "coverage",
      "visual_regression",
    ]);
  });

  it("skips unconfigured optional gates and keeps lint/tests compatible", async () => {
    const commands: string[] = [];
    const results = await runQualityGates(createConfig(process.cwd()), {
      cwd: process.cwd(),
      commandRunner: successfulRunner(commands),
    });

    expect(commands).toEqual(["lint-command", "test-command"]);
    expect(results.find((result) => result.id === "typecheck")?.status).toBe("skipped");
    expect(results.find((result) => result.id === "lint")?.status).toBe("passed");
    expect(results.find((result) => result.id === "tests")?.status).toBe("passed");
    expect(results.find((result) => result.id === "build")?.status).toBe("skipped");
    expect(formatQualityGateSummary(results)).toContain("Build: skipped");
  });

  it("fails fast after a failing typecheck gate and preserves diagnostics", async () => {
    const commands: string[] = [];
    const results = await runQualityGates(
      createConfig(process.cwd(), {
        typeCheckCommand: "typecheck-command",
      }),
      {
        cwd: process.cwd(),
        commandRunner: async (command) => {
          commands.push(command);
          return command === "typecheck-command"
            ? { stdout: "type mismatch", stderr: "TS2322", exitCode: 1 }
            : { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );

    expect(commands).toEqual(["typecheck-command"]);
    expect(results.find((result) => result.id === "typecheck")?.status).toBe("failed");
    expect(results.find((result) => result.id === "lint")?.status).toBe("skipped");
    expect(results.find((result) => result.id === "tests")?.status).toBe("skipped");
    expect(formatQualityGateDiagnostics(results)).toContain("typecheck-command");
    expect(formatQualityGateDiagnostics(results)).toContain("type mismatch");
    expect(formatQualityGateDiagnostics(results)).toContain("TS2322");
  });

  it("blocks on generic security scanner failures without parsing scanner output", async () => {
    const commands: string[] = [];
    const results = await runQualityGates(
      createConfig(process.cwd(), {
        securityScanCommand: "security-command",
      }),
      {
        cwd: process.cwd(),
        commandRunner: async (command) => {
          commands.push(command);
          return command === "security-command"
            ? { stdout: "scanner-specific text", stderr: "", exitCode: 2 }
            : { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );

    expect(commands).toEqual(["lint-command", "test-command", "security-command"]);
    expect(results.find((result) => result.id === "security_scan")?.status).toBe(
      "failed",
    );
    expect(formatQualityGateDiagnostics(results)).toContain("scanner-specific text");
  });

  it("passes coverage when the report meets the configured threshold", async () => {
    const repoPath = createTempDir();
    const coverageDir = join(repoPath, "coverage");
    mkdirSync(coverageDir);
    writeFileSync(
      join(coverageDir, "coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: 82.5 } } }),
      "utf8",
    );

    const results = await runQualityGates(
      createConfig(repoPath, {
        coverageCommand: "coverage-command",
        minCoveragePercent: 80,
        coverageReportFile: "coverage/coverage-summary.json",
      }),
      {
        cwd: repoPath,
        commandRunner: successfulRunner(),
      },
    );

    const coverage = results.find((result) => result.id === "coverage");
    expect(coverage?.status).toBe("passed");
    expect(coverage?.coveragePercent).toBe(82.5);
    expect(formatQualityGateSummary(results)).toContain("82.5% >= 80%");
  });

  it("fails coverage below the configured threshold", async () => {
    const repoPath = createTempDir();
    const results = await runQualityGates(
      createConfig(repoPath, {
        coverageCommand: "coverage-command",
        minCoveragePercent: 80,
      }),
      {
        cwd: repoPath,
        commandRunner: async () => ({
          stdout: JSON.stringify({ total: { lines: { pct: 79.9 } } }),
          stderr: "",
          exitCode: 0,
        }),
      },
    );

    const coverage = results.find((result) => result.id === "coverage");
    expect(coverage?.status).toBe("failed");
    expect(formatQualityGateDiagnostics(results)).toContain("79.9% is below");
  });

  it("fails coverage with an actionable diagnostic when the report is missing", async () => {
    const repoPath = createTempDir();
    const results = await runQualityGates(
      createConfig(repoPath, {
        coverageCommand: "coverage-command",
        minCoveragePercent: 80,
        coverageReportFile: "coverage/coverage-summary.json",
      }),
      {
        cwd: repoPath,
        commandRunner: successfulRunner(),
      },
    );

    expect(results.find((result) => result.id === "coverage")?.status).toBe("failed");
    expect(formatQualityGateDiagnostics(results)).toContain(
      "Coverage report file was not found",
    );
  });

  it("includes visual regression artifact paths in summaries and notes", async () => {
    const commands: string[] = [];
    const results = await runQualityGates(
      createConfig(process.cwd(), {
        visualRegressionCommand: "visual-command",
        visualRegressionArtifactsDir: "playwright-report",
      }),
      {
        cwd: process.cwd(),
        commandRunner: successfulRunner(commands),
      },
    );

    expect(commands).toEqual(["lint-command", "test-command", "visual-command"]);
    expect(results.find((result) => result.id === "visual_regression")?.status).toBe(
      "passed",
    );
    expect(formatQualityGateSummary(results)).toContain(
      "artifacts: `playwright-report`",
    );
    expect(collectQualityGateNotes(results)).toEqual([
      "Visual Regression artifacts: `playwright-report` (passed).",
    ]);
  });
});
