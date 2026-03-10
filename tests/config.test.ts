import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

describe("config", () => {
  it("parses status map", () => {
    const statusMap = parseStatusMap(STATUS_MAP);
    expect(statusMap.in_progress.transition).toBe("start");
    expect(statusMap.open.statuses).toEqual(["Open"]);
  });

  it("applies defaults", () => {
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP: STATUS_MAP,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.trackerTag).toBe("ai_dev");
    expect(config.trackerOrgHeader).toBe("X-Cloud-Org-ID");
    expect(config.trackerApiBaseUrl).toBe("https://api.tracker.yandex.net/v3");
    expect(config.repoPath).toBe("/workspace/project");
    expect(config.baseBranch).toBe("main");
    expect(config.pollIntervalMinutes).toBe(30);
    expect(config.gitlabUrl).toBe("https://gitlab.example.com");
    expect(config.testCommand).toBe("npm test");
    expect(config.lintCommand).toBe("npm run lint");
    expect(config.runOnce).toBe(false);
    expect(config.codexHome).toBe(join(homedir(), ".codex"));
    expect(config.codexCliCommand).toBe("codex");
    expect(config.codexSandbox).toBe("workspace-write");
    expect(config.codexExecArgs).toEqual([]);
  });

  it("accepts explicit CODEX_HOME and CODEX_CLI_COMMAND", () => {
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_ORG_HEADER: "x-org-id",
      TRACKER_STATUS_MAP: STATUS_MAP,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      CODEX_HOME: "/codex-home",
      CODEX_CLI_COMMAND: "/usr/local/bin/codex",
      CODEX_MODEL: "gpt-5-codex",
      CODEX_PROFILE: "ci",
      CODEX_SANDBOX: "danger-full-access",
      CODEX_EXEC_ARGS_JSON: "[\"--search\",\"--add-dir\",\"/tmp/shared\"]",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.codexHome).toBe("/codex-home");
    expect(config.codexCliCommand).toBe("/usr/local/bin/codex");
    expect(config.codexModel).toBe("gpt-5-codex");
    expect(config.codexProfile).toBe("ci");
    expect(config.codexSandbox).toBe("danger-full-access");
    expect(config.codexExecArgs).toEqual(["--search", "--add-dir", "/tmp/shared"]);
    expect(config.trackerOrgHeader).toBe("X-Org-ID");
  });

  it("rejects invalid CODEX_SANDBOX", () => {
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP: STATUS_MAP,
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
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP: STATUS_MAP,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        CODEX_EXEC_ARGS_JSON: "{\"bad\":true}",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/CODEX_EXEC_ARGS_JSON/);
  });
});
