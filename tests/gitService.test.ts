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
  gitCommitNoVerify: true,
  repoPath: "/workspace/project",
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
      .mockResolvedValueOnce({
        stdout: "AI Worker <worker@example.com> 1 +0000\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "AI Worker <worker@example.com> 1 +0000\n",
        stderr: "",
        exitCode: 0,
      })
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
      8,
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
      .mockResolvedValueOnce({
        stdout: "AI Worker <worker@example.com> 1 +0000\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "AI Worker <worker@example.com> 1 +0000\n",
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

  it("fails fast when git author identity is missing", async () => {
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
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Author identity unknown",
        exitCode: 128,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Committer identity unknown",
        exitCode: 128,
      });

    const service = new RepositoryGitService(createConfig(), new Logger());

    await expect(service.assertRepositoryReady()).rejects.toThrow(
      /GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL|git user\.name and user\.email/,
    );
  });

  it("uses configured git author identity for readiness checks and commits", async () => {
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
      .mockResolvedValueOnce({
        stdout: "AI Worker <ai-worker@example.com> 1 +0000\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "AI Worker <ai-worker@example.com> 1 +0000\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const service = new RepositoryGitService(
      createConfig({
        gitAuthorName: "AI Worker",
        gitAuthorEmail: "ai-worker@example.com",
      }),
      new Logger(),
    );

    await service.assertRepositoryReady();
    await service.commit("feat: configured identity");

    expect(hoisted.runShellCommand).toHaveBeenNthCalledWith(
      3,
      "git var GIT_AUTHOR_IDENT",
      expect.objectContaining({
        cwd: "/workspace/project",
        env: expect.objectContaining({
          GIT_AUTHOR_NAME: "AI Worker",
          GIT_AUTHOR_EMAIL: "ai-worker@example.com",
          GIT_COMMITTER_NAME: "AI Worker",
          GIT_COMMITTER_EMAIL: "ai-worker@example.com",
        }),
      }),
    );
    expect(hoisted.runShellCommand).toHaveBeenNthCalledWith(
      8,
      'git commit --no-verify -m "feat: configured identity"',
      expect.objectContaining({
        cwd: "/workspace/project",
        env: expect.objectContaining({
          GIT_AUTHOR_NAME: "AI Worker",
          GIT_AUTHOR_EMAIL: "ai-worker@example.com",
          GIT_COMMITTER_NAME: "AI Worker",
          GIT_COMMITTER_EMAIL: "ai-worker@example.com",
        }),
      }),
    );
  });

  it("commits with --no-verify by default", async () => {
    hoisted.runShellCommand
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const service = new RepositoryGitService(createConfig(), new Logger());

    await service.commit('feat: "quoted" message');

    expect(hoisted.runShellCommand).toHaveBeenNthCalledWith(
      1,
      "git add -A",
      expect.objectContaining({ cwd: "/workspace/project" }),
    );
    expect(hoisted.runShellCommand).toHaveBeenNthCalledWith(
      2,
      'git commit --no-verify -m "feat: \\"quoted\\" message"',
      expect.objectContaining({ cwd: "/workspace/project" }),
    );
  });

  it("can enforce repository hooks for commits", async () => {
    hoisted.runShellCommand
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const service = new RepositoryGitService(
      createConfig({ gitCommitNoVerify: false }),
      new Logger(),
    );

    await service.commit("feat: enforce hooks");

    expect(hoisted.runShellCommand).toHaveBeenNthCalledWith(
      2,
      'git commit -m "feat: enforce hooks"',
      expect.objectContaining({ cwd: "/workspace/project" }),
    );
  });

  it("surfaces hook guidance when commit fails with hooks enabled", async () => {
    hoisted.runShellCommand
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "husky - pre-commit script failed",
        exitCode: 1,
      });

    const service = new RepositoryGitService(
      createConfig({ gitCommitNoVerify: false }),
      new Logger(),
    );

    await expect(service.commit("feat: enforce hooks")).rejects.toThrow(
      /GIT_COMMIT_NO_VERIFY=true|Repository hooks were enabled/,
    );
  });
});
