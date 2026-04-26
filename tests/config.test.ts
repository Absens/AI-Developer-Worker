import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, loadFleetConfig, parseStatusMap } from "../src/config.js";

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
    expect(config.typeCheckCommand).toBeUndefined();
    expect(config.buildCommand).toBeUndefined();
    expect(config.securityScanCommand).toBeUndefined();
    expect(config.sastCommand).toBeUndefined();
    expect(config.coverageCommand).toBeUndefined();
    expect(config.minCoveragePercent).toBeUndefined();
    expect(config.coverageReportFile).toBeUndefined();
    expect(config.visualRegressionCommand).toBeUndefined();
    expect(config.visualRegressionArtifactsDir).toBeUndefined();
    expect(config.runOnce).toBe(false);
    expect(config.preflightOnly).toBe(false);
    expect(config.preflightRunTargetCommands).toBe(true);
    expect(config.trackerPreflightIssueKey).toBeUndefined();
    expect(config.gitlabPreflightSourceBranch).toBeUndefined();
    expect(config.targetIssueKey).toBeUndefined();
    expect(config.codexHome).toBe(join(homedir(), ".codex"));
    expect(config.codexCliCommand).toBe("codex");
    expect(config.codexCliArgs).toEqual([]);
    expect(config.codexSandbox).toBe("danger-full-access");
    expect(config.codexExecArgs).toEqual([]);
    expect(config.codexTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.codexLogFullEvents).toBe(false);
    expect(config.maxReviewFixAttempts).toBe(2);
  });

  it("bridges .env mode into a single repository fleet config", () => {
    const statusMapFile = createStatusMapFile();
    const env = {
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      TRACKER_DEFAULT_QUEUE: "BACKEND",
      TRACKER_TAG: "ai_dev",
      REPO_PATH: "/workspace/backend",
      BASE_BRANCH: "develop",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    };

    const appConfig = loadConfig(env);
    const fleetConfig = loadFleetConfig(env);

    expect(fleetConfig.workerId).toBe(appConfig.workerId);
    expect(fleetConfig.repositories).toHaveLength(1);
    expect(fleetConfig.repositories[0]).toMatchObject({
      name: "default",
      repoPath: "/workspace/backend",
      gitlabProjectId: "123",
      baseBranch: "develop",
      queues: ["BACKEND"],
      tags: ["ai_dev"],
    });
    expect(fleetConfig.coordination.lockBackend).toBe("tracker");
    expect(fleetConfig.priorityQueue.priorityWeights.high).toBe(400);
  });

  it("parses YAML fleet config with multiple repository profiles", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.yaml");
    writeFileSync(
      configFile,
      [
        "worker:",
        "  id: worker-yaml",
        "  pollIntervalMinutes: 5",
        "  runOnce: true",
        "tracker:",
        "  tokenEnv: TRACKER_TOKEN",
        "  orgIdEnv: TRACKER_ORG_ID",
        `  statusMapFile: ${JSON.stringify(statusMapFile)}`,
        "gitlab:",
        "  urlEnv: GITLAB_URL",
        "  tokenEnv: GITLAB_TOKEN",
        "coordination:",
        "  lockBackend: tracker",
        "  ttlSeconds: 120",
        "  heartbeatSeconds: 10",
        "priorityQueue:",
        "  manualOverrideTags: [ai_priority]",
        "  tagBoosts:",
        "    urgent: 250",
        "repositories:",
        "  - name: client-application",
        "    repoPath: /workspace/client-app",
        "    gitlabProjectId: \"42\"",
        "    baseBranch: main",
        "    queues: [FRONTEND]",
        "    tags: [ai_dev]",
        "    testCommand: npm test",
        "    lintCommand: npm run lint",
        "  - name: backend-api",
        "    repoPath: /workspace/backend",
        "    gitlabProjectId: \"43\"",
        "    baseBranch: develop",
        "    queues: [BACKEND]",
        "    tags: [ai_dev]",
        "    testCommand: go test ./...",
        "    lintCommand: golangci-lint run",
      ].join("\n"),
      "utf8",
    );

    const config = loadFleetConfig({
      WORKER_CONFIG_FILE: configFile,
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });

    expect(config.workerId).toBe("worker-yaml");
    expect(config.runOnce).toBe(true);
    expect(config.pollIntervalMs).toBe(5 * 60 * 1000);
    expect(config.coordination.lockTtlMs).toBe(120 * 1000);
    expect(config.coordination.lockHeartbeatMs).toBe(10 * 1000);
    expect(config.priorityQueue.tagBoosts.urgent).toBe(250);
    expect(config.repositories.map((repo) => repo.name)).toEqual([
      "client-application",
      "backend-api",
    ]);
    expect(config.repositories[1]).toMatchObject({
      gitlabProjectId: "43",
      queues: ["BACKEND"],
      baseBranch: "develop",
    });
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
      CODEX_TIMEOUT_SECONDS: "45",
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
    expect(config.codexTimeoutMs).toBe(45 * 1000);
    expect(config.codexLogFullEvents).toBe(false);
    expect(config.trackerDefaultQueue).toBe("FRONTEND");
    expect(config.trackerOrgHeader).toBe("X-Org-ID");
  });

  it("accepts explicit CODEX_LOG_FULL_EVENTS=true", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      CODEX_LOG_FULL_EVENTS: "true",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.codexLogFullEvents).toBe(true);
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

  it("accepts explicit preflight and target issue options", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      WORKER_PREFLIGHT_ONLY: "yes",
      TRACKER_PREFLIGHT_ISSUE_KEY: "DEV-1",
      GITLAB_PREFLIGHT_SOURCE_BRANCH: "preflight/dev-1",
      PREFLIGHT_RUN_TARGET_COMMANDS: "no",
      TARGET_ISSUE_KEY: "DEV-2",
      WORKER_RUN_ONCE: "1",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.preflightOnly).toBe(true);
    expect(config.trackerPreflightIssueKey).toBe("DEV-1");
    expect(config.gitlabPreflightSourceBranch).toBe("preflight/dev-1");
    expect(config.preflightRunTargetCommands).toBe(false);
    expect(config.targetIssueKey).toBe("DEV-2");
    expect(config.runOnce).toBe(true);
  });

  it("accepts explicit MAX_REVIEW_FIX_ATTEMPTS", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      MAX_REVIEW_FIX_ATTEMPTS: "4",
      WORKER_ID: "worker-1",
    });

    expect(config.maxFixAttempts).toBe(2);
    expect(config.maxReviewFixAttempts).toBe(4);
  });

  it("accepts explicit quality gate options", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      TYPE_CHECK_COMMAND: "npm run typecheck",
      BUILD_COMMAND: "npm run build",
      SECURITY_SCAN_COMMAND: "npm audit --audit-level=high",
      SAST_COMMAND: "semgrep ci",
      COVERAGE_COMMAND: "npm run test:coverage -- --reporter=json",
      MIN_COVERAGE_PERCENT: "82.5",
      COVERAGE_REPORT_FILE: "coverage/coverage-summary.json",
      VISUAL_REGRESSION_COMMAND: "npm run test:visual",
      VISUAL_REGRESSION_ARTIFACTS_DIR: "playwright-report",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.typeCheckCommand).toBe("npm run typecheck");
    expect(config.buildCommand).toBe("npm run build");
    expect(config.securityScanCommand).toBe("npm audit --audit-level=high");
    expect(config.sastCommand).toBe("semgrep ci");
    expect(config.coverageCommand).toBe("npm run test:coverage -- --reporter=json");
    expect(config.minCoveragePercent).toBe(82.5);
    expect(config.coverageReportFile).toBe("coverage/coverage-summary.json");
    expect(config.visualRegressionCommand).toBe("npm run test:visual");
    expect(config.visualRegressionArtifactsDir).toBe("playwright-report");
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

  it("rejects duplicate repository names in fleet config", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        tracker: { statusMapFile },
        repositories: [
          {
            name: "api",
            repoPath: "/workspace/api",
            gitlabProjectId: "1",
            queues: ["BACKEND"],
          },
          {
            name: "api",
            repoPath: "/workspace/api-2",
            gitlabProjectId: "2",
            queues: ["BACKEND"],
          },
        ],
      }),
      "utf8",
    );

    expect(() =>
      loadFleetConfig({
        WORKER_CONFIG_FILE: configFile,
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
      }),
    ).toThrow(/Duplicate repository name: api/);
  });

  it("rejects missing repository path or GitLab project id in fleet config", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const missingPathConfig = join(directory, "missing-path.json");
    writeFileSync(
      missingPathConfig,
      JSON.stringify({
        worker: { id: "worker-1" },
        tracker: { statusMapFile },
        repositories: [{ name: "api", gitlabProjectId: "1", queues: ["BACKEND"] }],
      }),
      "utf8",
    );
    const missingProjectConfig = join(directory, "missing-project.json");
    writeFileSync(
      missingProjectConfig,
      JSON.stringify({
        worker: { id: "worker-1" },
        tracker: { statusMapFile },
        repositories: [{ name: "api", repoPath: "/workspace/api", queues: ["BACKEND"] }],
      }),
      "utf8",
    );
    const env = {
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    };

    expect(() =>
      loadFleetConfig({ ...env, WORKER_CONFIG_FILE: missingPathConfig }),
    ).toThrow(/repositories\[0\]\.repoPath/);
    expect(() =>
      loadFleetConfig({ ...env, WORKER_CONFIG_FILE: missingProjectConfig }),
    ).toThrow(/repositories\[0\]\.gitlabProjectId/);
  });

  it("rejects invalid MIN_COVERAGE_PERCENT", () => {
    const statusMapFile = createStatusMapFile();
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MIN_COVERAGE_PERCENT: "101",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/MIN_COVERAGE_PERCENT/);
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

  it("rejects invalid CODEX_TIMEOUT_SECONDS", () => {
    const statusMapFile = createStatusMapFile();
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        CODEX_TIMEOUT_SECONDS: "0",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/CODEX_TIMEOUT_SECONDS/);
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

  it("rejects invalid WORKER_PREFLIGHT_ONLY", () => {
    const statusMapFile = createStatusMapFile();
    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        WORKER_PREFLIGHT_ONLY: "maybe",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/WORKER_PREFLIGHT_ONLY/);
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
