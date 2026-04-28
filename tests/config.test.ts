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
    expect(config.taskMode).toBe("auto");
    expect(config.confidenceImplementThreshold).toBe(70);
    expect(config.confidenceHumanThreshold).toBe(40);
    expect(config.decompositionMaxSubtasks).toBe(8);
    expect(config.decompositionCreateIssues).toBe(true);
    expect(config.decompositionDryRun).toBe(false);
    expect(config.trackerParentLinkType).toBe("relates");
    expect(config.trackerBlockedByLinkType).toBe("is blocked by");
    expect(config.dependencyEnforcement).toBe(true);
    expect(config.dependencyUnknownStatusPolicy).toBe("block");
    expect(config.codexHome).toBe(join(homedir(), ".codex"));
    expect(config.codexCliCommand).toBe("codex");
    expect(config.codexCliArgs).toEqual([]);
    expect(config.codexSandbox).toBe("danger-full-access");
    expect(config.codexExecArgs).toEqual([]);
    expect(config.codexTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.codexLogFullEvents).toBe(false);
    expect(config.maxReviewFixAttempts).toBe(2);
    expect(config.memory).toMatchObject({
      enabled: false,
      dir: "/workspace/ai-developer-memory",
      maxContextChars: 6000,
      strict: false,
      includeDraftRules: false,
      similarFailureLimit: 3,
      bootstrapOnStart: false,
      refreshOnPreflight: false,
      bootstrapCodexSandbox: "inherit",
    });
    expect(config.observability).toMatchObject({
      enabled: false,
      host: "127.0.0.1",
      port: 9464,
      strictStartup: true,
      metrics: { enabled: true, path: "/metrics" },
      health: { path: "/healthz", readinessPath: "/readyz" },
      events: { store: "memory", retention: 1000 },
      dashboard: { enabled: false, path: "/dashboard", refreshSeconds: 10, apiPath: "/api" },
      alerts: { enabled: false, minSeverity: "warning" },
    });
  });

  it("defaults task tracker provider to Yandex", () => {
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

    expect(config.taskTracker).toEqual({ provider: "yandex" });
  });

  it("parses internal task tracker PostgreSQL settings without Yandex config", () => {
    const env = {
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost:5432/tasks",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    };
    const config = loadConfig(env);
    const fleetConfig = loadFleetConfig(env);

    expect(config.taskTracker).toEqual({
      provider: "internal",
      internal: {
        storage: "postgres",
        databaseUrl: "postgres://tracker:secret@localhost:5432/tasks",
        intakeMode: "standalone",
        yandexSyncEnabled: false,
      },
    });
    expect(config.trackerToken).toBe("");
    expect(config.trackerStatusMap.open.statuses).toEqual(["open"]);
    expect(fleetConfig.coordination.lockBackend).toBe("none");
  });

  it("parses internal task tracker Yandex integration mode", () => {
    const config = loadConfig({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_DATABASE_URL: "postgresql://tracker:secret@localhost/tasks",
      TASK_INTAKE_MODE: "yandex_integration",
      YANDEX_SYNC_ENABLED: "true",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.taskTracker).toMatchObject({
      provider: "internal",
      internal: {
        storage: "postgres",
        intakeMode: "yandex_integration",
        yandexSyncEnabled: true,
      },
    });
  });

  it("rejects invalid task tracker provider", () => {
    expect(() =>
      loadConfig({
        TASK_TRACKER_PROVIDER: "jira",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/TASK_TRACKER_PROVIDER/);
  });

  it("rejects invalid task intake mode", () => {
    expect(() =>
      loadConfig({
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
        TASK_INTAKE_MODE: "external_only",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/TASK_INTAKE_MODE/);
  });

  it("rejects Yandex sync without Yandex integration intake mode", () => {
    expect(() =>
      loadConfig({
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
        TASK_INTAKE_MODE: "standalone",
        YANDEX_SYNC_ENABLED: "true",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/YANDEX_SYNC_ENABLED=true/);
  });

  it("rejects internal mode without database URL unless memory storage is explicit", () => {
    expect(() =>
      loadConfig({
        TASK_TRACKER_PROVIDER: "internal",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/TASK_TRACKER_DATABASE_URL/);

    const config = loadConfig({
      NODE_ENV: "test",
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.taskTracker).toMatchObject({
      provider: "internal",
      internal: {
        storage: "memory",
        intakeMode: "standalone",
        yandexSyncEnabled: false,
      },
    });
  });

  it("rejects memory task tracker storage outside test or local smoke config", () => {
    expect(() =>
      loadConfig({
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_STORAGE: "memory",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/TASK_TRACKER_STORAGE=memory/);
  });

  it("rejects tracker comment locks in internal provider mode", () => {
    expect(() =>
      loadFleetConfig({
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
        LOCK_BACKEND: "tracker",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/LOCK_BACKEND=tracker/);
  });

  it("accepts explicit observability options", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_HOST: "0.0.0.0",
      OBSERVABILITY_PORT: "9564",
      OBSERVABILITY_BASE_URL: "http://worker.internal:9564/",
      OBSERVABILITY_STRICT_STARTUP: "false",
      OBSERVABILITY_REDACT_MAX_CHARS: "1234",
      OBSERVABILITY_EVENT_STORE: "file",
      OBSERVABILITY_EVENT_STORE_FILE: "/tmp/events.jsonl",
      OBSERVABILITY_EVENT_RETENTION: "25",
      METRICS_ENABLED: "false",
      METRICS_PATH: "/prometheus",
      HEALTH_PATH: "/live",
      READY_PATH: "/ready",
      DASHBOARD_ENABLED: "true",
      DASHBOARD_PATH: "/ops",
      DASHBOARD_REFRESH_SECONDS: "5",
      DASHBOARD_API_PATH: "/ops-api",
      DASHBOARD_BEARER_TOKEN: "dashboard-token",
      ALERTS_ENABLED: "true",
      ALERT_CHANNELS: "webhook",
      ALERT_WEBHOOK_URL: "https://alerts.example.test/webhook",
      ALERT_MIN_SEVERITY: "info",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.observability).toMatchObject({
      enabled: true,
      host: "0.0.0.0",
      port: 9564,
      baseUrl: "http://worker.internal:9564",
      strictStartup: false,
      redactMaxChars: 1234,
      metrics: { enabled: false, path: "/prometheus" },
      health: { path: "/live", readinessPath: "/ready" },
      events: { store: "file", file: "/tmp/events.jsonl", retention: 25 },
      dashboard: {
        enabled: true,
        path: "/ops",
        refreshSeconds: 5,
        apiPath: "/ops-api",
        bearerToken: "dashboard-token",
      },
      alerts: {
        enabled: true,
        minSeverity: "info",
        channels: [{ type: "webhook", url: "https://alerts.example.test/webhook" }],
      },
    });
  });

  it("accepts explicit memory options", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MEMORY_ENABLED: "true",
      MEMORY_DIR: "/memory",
      MEMORY_MAX_CONTEXT_CHARS: "2048",
      MEMORY_STRICT: "true",
      MEMORY_INCLUDE_DRAFT_RULES: "true",
      MEMORY_SIMILAR_FAILURE_LIMIT: "5",
      MEMORY_BOOTSTRAP_ON_START: "true",
      MEMORY_REFRESH_ON_PREFLIGHT: "true",
      MEMORY_BOOTSTRAP_CODEX_SANDBOX: "read-only",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.memory).toMatchObject({
      enabled: true,
      dir: "/memory",
      maxContextChars: 2048,
      strict: true,
      includeDraftRules: true,
      similarFailureLimit: 5,
      bootstrapOnStart: true,
      refreshOnPreflight: true,
      bootstrapCodexSandbox: "read-only",
    });
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
    expect(fleetConfig.priorityQueue.confidencePriorityWeight).toBe(2);
  });

  it("accepts LOCK_BACKEND=none for single-worker runs without Tracker lease comments", () => {
    const statusMapFile = createStatusMapFile();
    const fleetConfig = loadFleetConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      LOCK_BACKEND: "none",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(fleetConfig.coordination.lockBackend).toBe("none");
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
        "  confidencePriorityWeight: 3",
        "observability:",
        "  enabled: true",
        "  host: 0.0.0.0",
        "  port: 9465",
        "  baseUrl: http://worker-yaml:9465",
        "  strictStartup: true",
        "  metrics:",
        "    enabled: true",
        "    path: /metrics",
        "  health:",
        "    path: /healthz",
        "    readinessPath: /readyz",
        "alerts:",
        "  enabled: true",
        "  minSeverity: warning",
        "  channels:",
        "    - type: webhook",
        "      urlEnv: ALERT_WEBHOOK_URL",
        "repositories:",
        "  - name: client-application",
        "    repoPath: /workspace/client-app",
        "    gitlabProjectId: \"42\"",
        "    baseBranch: main",
        "    queues: [FRONTEND]",
        "    tags: [ai_dev]",
        "    testCommand: npm test",
        "    lintCommand: npm run lint",
        "    promptProfiles:",
        "      frontend_ui_fix:",
        "        validationFocus:",
        "          - Check responsive behavior for touched components.",
        "    decomposition:",
        "      defaultSubtaskTag: ai_split",
        "      subtaskTitlePrefix: \"[Split]\"",
        "      maxSubtasks: 5",
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
      ALERT_WEBHOOK_URL: "https://alerts.example.test/fleet",
    });

    expect(config.workerId).toBe("worker-yaml");
    expect(config.runOnce).toBe(true);
    expect(config.pollIntervalMs).toBe(5 * 60 * 1000);
    expect(config.coordination.lockTtlMs).toBe(120 * 1000);
    expect(config.coordination.lockHeartbeatMs).toBe(10 * 1000);
    expect(config.priorityQueue.tagBoosts.urgent).toBe(250);
    expect(config.priorityQueue.confidencePriorityWeight).toBe(3);
    expect(config.observability).toMatchObject({
      enabled: true,
      port: 9465,
      baseUrl: "http://worker-yaml:9465",
      alerts: {
        enabled: true,
        minSeverity: "warning",
        channels: [{ type: "webhook", url: "https://alerts.example.test/fleet" }],
      },
    });
    expect(config.repositories.map((repo) => repo.name)).toEqual([
      "client-application",
      "backend-api",
    ]);
    expect(config.repositories[0]?.promptProfiles?.frontend_ui_fix?.validationFocus).toEqual([
      "Check responsive behavior for touched components.",
    ]);
    expect(config.repositories[0]?.decomposition).toMatchObject({
      defaultSubtaskTag: "ai_split",
      subtaskTitlePrefix: "[Split]",
      maxSubtasks: 5,
    });
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

  it("rejects repository names that collide after memory key sanitization", () => {
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
            name: "Client Application",
            repoPath: "/workspace/api",
            gitlabProjectId: "1",
            queues: ["BACKEND"],
          },
          {
            name: "client-application",
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
    ).toThrow(/same memory key "client-application"/);
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
