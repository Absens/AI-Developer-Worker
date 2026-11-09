import { afterEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/utils/shell.js", () => ({ runShellCommand: shell.run }));

import { RepositoryGitService } from "../src/integrations/git/service.js";
import type { AppConfig } from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

afterEach(() => { vi.unstubAllEnvs(); shell.run.mockReset(); });

const config = {
  repoPath: "/repo", baseBranch: "main", gitRemoteName: "origin",
  gitRepositoryUsername: "oauth2", gitRepositoryToken: "test-repository-token",
  gitCommitNoVerify: true, gitAuthorName: "AI Worker", gitAuthorEmail: "worker@example.test",
} as AppConfig;

const successfulCommands = (remote: string): void => {
  shell.run.mockImplementation(async (command: string) => ({
    stdout: command.startsWith("git remote get-url") ? `${remote}\n` : command === "git rev-parse --abbrev-ref HEAD" ? "main\n" : "",
    stderr: "", exitCode: 0,
  }));
};

describe("Git execution environment boundary", () => {
  it("sends scoped auth to network operations, not to local Git commands or commit hooks", async () => {
    vi.stubEnv("GITLAB_TOKEN", "unrelated-worker-secret");
    vi.stubEnv("TELEGRAM_ASSISTANT_BOT_TOKEN", "unrelated-telegram-secret");
    vi.stubEnv("OPENAI_API_KEY", "unrelated-model-secret");
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "untrusted-parent-config");
    vi.stubEnv("WORKER_GIT_ENV_ALLOWLIST", "");
    successfulCommands("https://gitlab.example.test/team/repo.git");
    const git = new RepositoryGitService(config, new Logger());
    await git.assertRepositoryReady();
    await git.checkoutBranch("feature/security-test");
    await git.getDiffFromBase();
    await git.getChangedFilesFromBase();
    await git.getHeadSha();
    await git.commit("test: safe local environment");
    await git.push("feature/security-test");

    const networkNames = new Set<string>();
    let localCount = 0;
    for (const [command, options] of shell.run.mock.calls) {
      const env = options.env as NodeJS.ProcessEnv;
      expect(env.GITLAB_TOKEN).toBeUndefined();
      expect(env.TELEGRAM_ASSISTANT_BOT_TOKEN).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env.GIT_AUTHOR_EMAIL).toBe("worker@example.test");
      const network = String(command).match(/^git (fetch|pull|push|ls-remote)(?:\s|$)/);
      if (network) {
        networkNames.add(network[1]);
        expect(env.GIT_CONFIG_COUNT).toBe("1");
        expect(env.GIT_CONFIG_KEY_0).toBe("http.https://gitlab.example.test/.extraheader");
        expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: Basic ${Buffer.from("oauth2:test-repository-token").toString("base64")}`);
      } else {
        localCount++;
        expect(Object.keys(env).filter((key) => key.startsWith("GIT_CONFIG"))).toEqual([]);
      }
    }
    expect([...networkNames].sort()).toEqual(["fetch", "ls-remote", "pull", "push"]);
    expect(localCount).toBeGreaterThan(10);
  });

  it("does not add HTTP credentials to local remotes", async () => {
    vi.stubEnv("WORKER_GIT_ENV_ALLOWLIST", "");
    successfulCommands("/tmp/test-remote.git");
    const git = new RepositoryGitService(config, new Logger());
    await git.assertRepositoryReady();
    await git.push("feature/local-test");
    for (const [, options] of shell.run.mock.calls) {
      expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(options.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    }
  });

  it("permits an explicitly allowed Git-only tool variable without applying project allowlists", async () => {
    vi.stubEnv("WORKER_GIT_ENV_ALLOWLIST", "GIT_TEST_TOOL_SETTING");
    vi.stubEnv("GIT_TEST_TOOL_SETTING", "allowed");
    vi.stubEnv("WORKER_PROJECT_ENV_ALLOWLIST", "PROJECT_TEST_SECRET");
    vi.stubEnv("PROJECT_TEST_SECRET", "not-for-git");
    successfulCommands("/tmp/test-remote.git");
    await new RepositoryGitService(config, new Logger()).hasChanges();
    const env = shell.run.mock.calls[0][1].env;
    expect(env.GIT_TEST_TOOL_SETTING).toBe("allowed");
    expect(env.PROJECT_TEST_SECRET).toBeUndefined();
  });
});
