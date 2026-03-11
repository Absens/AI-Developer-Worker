import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertCodexAuthenticated, getCodexShellEnv } from "../src/integrations/codex/auth.js";
import type { AppConfig } from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
  tempDirs.push(path);
  return path;
};

const createBaseConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
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
  repoPath: process.cwd(),
  baseBranch: "main",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  codexHome: "/codex-home",
  codexCliCommand: "codex",
  codexCliArgs: [],
  codexSandbox: "workspace-write",
  codexExecArgs: [],
  codexProgressLogIntervalMs: 30 * 1000,
  codexQuestionMarker: "AI_QUESTION:",
  maxFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  runOnce: false,
  ...overrides,
});

describe("codex auth", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("injects CODEX_HOME into Codex shell env", () => {
    const env = getCodexShellEnv(createBaseConfig({ codexHome: "/dedicated-codex-home" }));
    expect(env.CODEX_HOME).toBe("/dedicated-codex-home");
  });

  it("passes preflight when codex login status succeeds", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-status.cjs");
    writeFileSync(
      scriptPath,
      [
        "if (process.argv[2] === 'login' && process.argv[3] === 'status' && process.env.CODEX_HOME === '/dedicated-codex-home') {",
        "  console.log('Logged in using ChatGPT');",
        "  process.exit(0);",
        "}",
        "console.error('unexpected invocation');",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );

    await expect(
      assertCodexAuthenticated(
        createBaseConfig({
          codexHome: "/dedicated-codex-home",
          codexCliCommand: "node",
          codexCliArgs: [scriptPath],
        }),
        new Logger(),
      ),
    ).resolves.toBeUndefined();
  });

  it("fails preflight when codex login status reports missing auth", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-status.cjs");
    writeFileSync(
      scriptPath,
      [
        "console.log('Not logged in');",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );

    await expect(
      assertCodexAuthenticated(
        createBaseConfig({
          codexCliCommand: "node",
          codexCliArgs: [scriptPath],
        }),
        new Logger(),
      ),
    ).rejects.toThrow(/Codex CLI is not authenticated/);
  });

  it("passes preflight when OPENAI_API_KEY is present", async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      await expect(
        assertCodexAuthenticated(createBaseConfig(), new Logger()),
      ).resolves.toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });
});
