import { describe, expect, it, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  runShellCommand: vi.fn(),
}));

vi.mock("../src/utils/shell.js", () => ({
  runShellCommand: hoisted.runShellCommand,
}));

import { RepositoryGitService } from "../src/integrations/git/service.js";
import type { AppConfig } from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const createConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
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
    failed: { statuses: ["Failed"] },
    done: { statuses: ["Done"], transition: "done" },
  },
  trackerApiBaseUrl: "http://localhost:9999/v3",
  gitlabUrl: "https://repo.tools-indigolab.ru",
  gitlabToken: "api-token",
  gitlabProjectId: "1",
  gitRemoteName: "origin",
  gitRepositoryToken: "repo-token",
  gitRepositoryUsername: "oauth2",
  repoPath: "/workspace/project",
  baseBranch: "main",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  codexHome: "/codex-home",
  codexCliCommand: "codex",
  codexCliArgs: [],
  codexSandbox: "workspace-write",
  codexExecArgs: [],
  codexQuestionMarker: "AI_QUESTION:",
  maxFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  runOnce: false,
  ...overrides,
});

describe("RepositoryGitService", () => {
  beforeEach(() => {
    hoisted.runShellCommand.mockReset();
  });

  it("rewrites ssh remotes to https and injects auth headers for fetch", async () => {
    hoisted.runShellCommand
      .mockResolvedValueOnce({
        stdout: "git@repo.tools-indigolab.ru:platform/other-project.git\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "git@repo.tools-indigolab.ru:platform/other-project.git\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const service = new RepositoryGitService(createConfig(), new Logger());

    await service.assertRepositoryReady();

    expect(hoisted.runShellCommand).toHaveBeenNthCalledWith(
      3,
      'git remote set-url origin "https://repo.tools-indigolab.ru/platform/other-project.git"',
      expect.objectContaining({ cwd: "/workspace/project" }),
    );
    expect(hoisted.runShellCommand).toHaveBeenNthCalledWith(
      6,
      "git fetch --all --prune",
      expect.objectContaining({
        cwd: "/workspace/project",
        env: expect.objectContaining({
          GIT_CONFIG_KEY_0: "http.https://repo.tools-indigolab.ru/.extraheader",
        }),
      }),
    );
  });

  it("does not rewrite local remotes", async () => {
    hoisted.runShellCommand
      .mockResolvedValueOnce({
        stdout: "/tmp/remote.git\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "/tmp/remote.git\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const service = new RepositoryGitService(createConfig(), new Logger());

    await service.assertRepositoryReady();

    expect(hoisted.runShellCommand).not.toHaveBeenCalledWith(
      expect.stringContaining("git remote set-url origin"),
      expect.anything(),
    );
  });
});
