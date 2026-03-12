import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, parseStatusMap } from "../src/config.js";

const STATUS_MAP = JSON.stringify({
  open: { statuses: ["Open"] },
  in_progress: { statuses: ["In Progress"], transition: "start" },
  waiting_for_answer: {
    statuses: ["Waiting for answer"],
    transition: "need-info",
  },
  review: { statuses: ["Review"], transition: "review" },
  failed: { statuses: ["Failed"], transition: "fail" },
  done: { statuses: ["Done"], transition: "done" },
});

const cleanupPaths: string[] = [];

const createStatusMapFile = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "ai-worker-config-"));
  cleanupPaths.push(directory);
  const path = join(directory, "trackerStatusMap.json");
  writeFileSync(path, STATUS_MAP, "utf8");
  return path;
};

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("config", () => {
  it("parses status map", () => {
    const statusMap = parseStatusMap(STATUS_MAP);
    expect(statusMap.in_progress.transition).toBe("start");
    expect(statusMap.open.statuses).toEqual(["Open"]);
  });

  it("applies defaults", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.trackerTag).toBe("ai_dev");
    expect(config.trackerDefaultQueue).toBe("FRONTEND");
    expect(config.trackerOrgHeader).toBe("X-Cloud-Org-ID");
    expect(config.trackerApiBaseUrl).toBe("https://api.tracker.yandex.net/v3");
    expect(config.repoPath).toBe("/workspace/project");
    expect(config.baseBranch).toBe("main");
    expect(config.pollIntervalMinutes).toBe(30);
    expect(config.gitlabUrl).toBe("https://gitlab.example.com");
      expect(config.gitRemoteName).toBe("origin");
      expect(config.gitRepositoryToken).toBe("gitlab-token");
      expect(config.gitRepositoryUsername).toBe("oauth2");
      expect(config.gitCommitNoVerify).toBe(true);
      expect(config.testCommand).toBe("npm test");
      expect(config.lintCommand).toBe("npm run lint");
      expect(config.runOnce).toBe(false);
    expect(config.codexHome).toBe(join(homedir(), ".codex"));
    expect(config.codexCliCommand).toBe("codex");
    expect(config.codexCliArgs).toEqual([]);
    expect(config.codexSandbox).toBe("danger-full-access");
    expect(config.codexExecArgs).toEqual([]);
  });

  it("accepts explicit CODEX_HOME and CODEX_CLI_COMMAND", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_ORG_HEADER: "x-org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      CODEX_HOME: "/codex-home",
      CODEX_CLI_COMMAND: "/usr/local/bin/codex",
      CODEX_CLI_ARGS_JSON: "[\"--config\",\"foo=bar\"]",
      CODEX_MODEL: "gpt-5-codex",
      CODEX_PROFILE: "ci",
      CODEX_SANDBOX: "danger-full-access",
      CODEX_EXEC_ARGS_JSON: "[\"--search\",\"--add-dir\",\"/tmp/shared\"]",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.codexHome).toBe("/codex-home");
    expect(config.codexCliCommand).toBe("/usr/local/bin/codex");
    expect(config.codexCliArgs).toEqual(["--config", "foo=bar"]);
    expect(config.codexModel).toBe("gpt-5-codex");
    expect(config.codexProfile).toBe("ci");
    expect(config.codexSandbox).toBe("danger-full-access");
    expect(config.codexExecArgs).toEqual(["--search", "--add-dir", "/tmp/shared"]);
    expect(config.trackerDefaultQueue).toBe("FRONTEND");
    expect(config.trackerOrgHeader).toBe("X-Org-ID");
  });

  it("accepts explicit repository auth overrides", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      GIT_REPOSITORY_TOKEN: "repo-token",
      GIT_REPOSITORY_USERNAME: "bot-user",
      GIT_REPOSITORY_URL: "https://gitlab.example.com/group/project.git",
      GIT_REMOTE_NAME: "upstream",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.gitRemoteName).toBe("upstream");
    expect(config.gitRepositoryToken).toBe("repo-token");
    expect(config.gitRepositoryUsername).toBe("bot-user");
    expect(config.gitRepositoryUrl).toBe("https://gitlab.example.com/group/project.git");
  });

  it("accepts explicit git author identity overrides", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      GIT_AUTHOR_NAME: "AI Worker",
      GIT_AUTHOR_EMAIL: "ai-worker@example.com",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.gitAuthorName).toBe("AI Worker");
    expect(config.gitAuthorEmail).toBe("ai-worker@example.com");
  });

  it("accepts explicit GIT_COMMIT_NO_VERIFY=false", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      GIT_COMMIT_NO_VERIFY: "false",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.gitCommitNoVerify).toBe(false);
  });

  it("rejects invalid CODEX_SANDBOX", () => {
    const statusMapFile = createStatusMapFile();
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        CODEX_SANDBOX: "sandboxed",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/CODEX_SANDBOX/);
  });

  it("rejects invalid CODEX_EXEC_ARGS_JSON", () => {
    const statusMapFile = createStatusMapFile();
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        CODEX_EXEC_ARGS_JSON: "{\"bad\":true}",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/CODEX_EXEC_ARGS_JSON/);
  });

  it("rejects invalid GIT_COMMIT_NO_VERIFY", () => {
    const statusMapFile = createStatusMapFile();
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        GIT_COMMIT_NO_VERIFY: "maybe",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/GIT_COMMIT_NO_VERIFY/);
  });

  it("rejects invalid CODEX_CLI_ARGS_JSON", () => {
    const statusMapFile = createStatusMapFile();
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        CODEX_CLI_ARGS_JSON: "{\"bad\":true}",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/CODEX_EXEC_ARGS_JSON|CODEX_CLI_ARGS_JSON/);
  });

  it("rejects missing status map file", () => {
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: join(tmpdir(), "definitely-missing-status-map.json"),
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/TRACKER_STATUS_MAP_FILE/);
  });
});
