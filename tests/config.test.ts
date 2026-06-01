import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRepositoryRuntimeConfig,
  loadConfig,
  loadFleetConfig,
  parseStatusMap,
} from "../src/config.js";

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

const baseFleetEnv = (): NodeJS.ProcessEnv => ({
  TRACKER_TOKEN: "tracker-token",
  TRACKER_ORG_ID: "org-id",
  TRACKER_STATUS_MAP_FILE: createStatusMapFile(),
  GITLAB_URL: "https://gitlab.example.com/",
  GITLAB_TOKEN: "gitlab-token",
  GITLAB_PROJECT_ID: "123",
  MAX_FIX_ATTEMPTS: "2",
  WORKER_ID: "worker-1",
});

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
      alerts: { enabled: false, minSeverity: "warning" },
    });
    expect(config.observability).not.toHaveProperty("dashboard");
    expect(config.autonomy).toMatchObject({
      aiProposalsEnabled: true,
      autoExecuteLowRiskEnabled: false,
      defaultAllowedTaskTypes: ["documentation", "tests_only", "dependency_update"],
    });
    expect(config.projectManager).toEqual({
      enabled: false,
      runOnce: false,
      intervalMinutes: 1440,
      maxGoalsPerRun: 5,
      maxTaskProposalsPerGoal: 5,
      defaultAutonomyLevel: "proposal_only",
      autoApproveLowRisk: false,
      allowedTaskTypes: ["documentation", "tests_only", "dependency_update"],
      repositoryScanEnabled: false,
      repositoryScanMaxFiles: 200,
      requireHumanGoalApproval: true,
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

  it("defaults Telegram assistant to disabled", () => {
    const config = loadFleetConfig(baseFleetEnv());
    expect(config.telegramAssistant).toEqual({
      enabled: false,
      botToken: undefined,
      botUsername: undefined,
      mode: "polling",
      pollIntervalSeconds: 2,
      confirmWriteActions: true,
      projectQaEnabled: false,
      taskCreationEnabled: true,
      profileAutomation: {
        enabled: false,
        autoReplyEnabled: false,
        requireOwnerApproval: true,
        projectQaEnabled: false,
        allowedOwnerIds: [],
        allowedChatIds: [],
      },
      allowedChatIds: [],
      allowedUserIds: [],
      developerUserIds: [],
      operatorUserIds: [],
      adminUserIds: [],
      groupMode: "mentions_and_replies",
      defaultRepository: undefined,
      userTaskCreationDailyLimit: 20,
      userCodexQaDailyLimit: 50,
      codexTimeoutSeconds: 120,
      codexMaxContextChars: 12000,
      maxQueuedMessagesPerChat: 20,
      conversationRetentionDays: 14,
      webhook: undefined,
      media: {
        enabled: false,
        maxBytes: 10485760,
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "text/plain"],
      },
    });
  });

  it("requires a bot token when Telegram assistant is enabled", () => {
    expect(() =>
      loadFleetConfig({
        ...baseFleetEnv(),
        TELEGRAM_ASSISTANT_ENABLED: "true",
      }),
    ).toThrow(/TELEGRAM_ASSISTANT_BOT_TOKEN/);
  });

  it("rejects empty allowlists for enabled production Telegram assistant", () => {
    expect(() =>
      loadFleetConfig({
        ...baseFleetEnv(),
        NODE_ENV: "production",
        TELEGRAM_ASSISTANT_ENABLED: "true",
        TELEGRAM_ASSISTANT_BOT_TOKEN: "secret",
      }),
    ).toThrow(/role-specific Telegram user ids/);
  });

  it("parses profile automation settings separately from the base assistant", () => {
    const config = loadFleetConfig({
      ...baseFleetEnv(),
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "101,202",
      TELEGRAM_DEVELOPER_USER_IDS: "101",
      TELEGRAM_OPERATOR_USER_IDS: "202",
      TELEGRAM_PROFILE_AUTOMATION_ENABLED: "true",
      TELEGRAM_PROFILE_AUTOMATION_ALLOWED_OWNER_IDS: "101",
      TELEGRAM_PROFILE_AUTOMATION_ALLOWED_CHAT_IDS: "-1001,-1002",
    });
    expect(config.telegramAssistant).toMatchObject({
      allowedUserIds: ["101", "202"],
      developerUserIds: ["101"],
      operatorUserIds: ["202"],
    });
    expect(config.telegramAssistant?.profileAutomation).toMatchObject({
      enabled: true,
      allowedOwnerIds: ["101"],
      allowedChatIds: ["-1001", "-1002"],
    });
  });

  it("parses Telegram assistant bot username for group mention routing", () => {
    const config = loadFleetConfig({
      ...baseFleetEnv(),
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "secret",
      TELEGRAM_ASSISTANT_BOT_USERNAME: "assistant_bot",
      TELEGRAM_ALLOWED_USER_IDS: "101",
    });

    expect(config.telegramAssistant?.botUsername).toBe("assistant_bot");
  });

  it("parses Telegram assistant settings from config file values as well as env", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-telegram", pollIntervalMinutes: 1 },
        tracker: { tokenEnv: "TRACKER_TOKEN", orgIdEnv: "TRACKER_ORG_ID", statusMapFile },
        gitlab: { urlEnv: "GITLAB_URL", tokenEnv: "GITLAB_TOKEN" },
        telegramAssistant: {
          enabled: true,
          botToken: "file-secret",
          mode: "webhook",
          allowedUserIds: ["101"],
          developerUserIds: ["101"],
          webhook: { path: "/tg", secretToken: "hook-secret" },
          projectQaEnabled: true,
        },
        repositories: [
          {
            name: "repo",
            repoPath: "/workspace/repo",
            gitlabProjectId: "42",
            queues: ["DEV"],
            tags: ["ai_dev"],
          },
        ],
      }),
      "utf8",
    );
    const config = loadFleetConfig({
      WORKER_CONFIG_FILE: configFile,
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });
    expect(config.telegramAssistant).toMatchObject({
      enabled: true,
      botToken: "file-secret",
      mode: "webhook",
      allowedUserIds: ["101"],
      developerUserIds: ["101"],
      webhook: { path: "/tg", secretToken: "hook-secret" },
      projectQaEnabled: true,
    });
  });

  it("normalizes Telegram webhook paths from environment values", () => {
    const config = loadFleetConfig({
      ...baseFleetEnv(),
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "secret",
      TELEGRAM_ASSISTANT_MODE: "webhook",
      TELEGRAM_ALLOWED_USER_IDS: "101",
      TELEGRAM_WEBHOOK_PATH: "tg/",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "hook-secret",
    });

    expect(config.telegramAssistant?.webhook?.path).toBe("/tg");
  });

  it("rejects Telegram webhook mode without a secret token", () => {
    expect(() =>
      loadFleetConfig({
        ...baseFleetEnv(),
        TELEGRAM_ASSISTANT_ENABLED: "true",
        TELEGRAM_ASSISTANT_BOT_TOKEN: "secret",
        TELEGRAM_ASSISTANT_MODE: "webhook",
        TELEGRAM_ALLOWED_USER_IDS: "101",
        TELEGRAM_WEBHOOK_PATH: "tg/",
      }),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET_TOKEN/);
  });

  it("treats blank Telegram assistant env values as unset over config file values", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-telegram", pollIntervalMinutes: 1 },
        tracker: { tokenEnv: "TRACKER_TOKEN", orgIdEnv: "TRACKER_ORG_ID", statusMapFile },
        gitlab: { urlEnv: "GITLAB_URL", tokenEnv: "GITLAB_TOKEN" },
        telegramAssistant: {
          enabled: true,
          botToken: "file-secret",
          mode: "webhook",
          pollIntervalSeconds: 5,
          confirmWriteActions: false,
          allowedUserIds: ["101"],
          webhook: { path: "/tg", secretToken: "hook-secret" },
          media: {
            enabled: true,
            maxBytes: 2048,
            allowedMimeTypes: ["image/png"],
          },
        },
        repositories: [
          {
            name: "repo",
            repoPath: "/workspace/repo",
            gitlabProjectId: "42",
            queues: ["DEV"],
            tags: ["ai_dev"],
          },
        ],
      }),
      "utf8",
    );

    const config = loadFleetConfig({
      WORKER_CONFIG_FILE: configFile,
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      TELEGRAM_ASSISTANT_ENABLED: "  ",
      TELEGRAM_ASSISTANT_MODE: "  ",
      TELEGRAM_ASSISTANT_POLL_INTERVAL_SECONDS: "  ",
      TELEGRAM_CONFIRM_WRITE_ACTIONS: "  ",
      TELEGRAM_ALLOWED_USER_IDS: "  ",
      TELEGRAM_WEBHOOK_PATH: "  ",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "  ",
      TELEGRAM_MEDIA_ENABLED: "  ",
      TELEGRAM_MEDIA_MAX_BYTES: "  ",
      TELEGRAM_MEDIA_ALLOWED_MIME_TYPES: "  ",
    });

    expect(config.telegramAssistant).toMatchObject({
      enabled: true,
      botToken: "file-secret",
      mode: "webhook",
      pollIntervalSeconds: 5,
      confirmWriteActions: false,
      allowedUserIds: ["101"],
      webhook: { path: "/tg", secretToken: "hook-secret" },
      media: {
        enabled: true,
        maxBytes: 2048,
        allowedMimeTypes: ["image/png"],
      },
    });
  });

  it("lets Telegram assistant env values override config file values", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-telegram", pollIntervalMinutes: 1 },
        tracker: { tokenEnv: "TRACKER_TOKEN", orgIdEnv: "TRACKER_ORG_ID", statusMapFile },
        gitlab: { urlEnv: "GITLAB_URL", tokenEnv: "GITLAB_TOKEN" },
        telegramAssistant: {
          enabled: false,
          botToken: "file-secret",
          mode: "polling",
          allowedUserIds: ["101"],
          media: { enabled: false, allowedMimeTypes: ["text/plain"] },
        },
        repositories: [
          {
            name: "repo",
            repoPath: "/workspace/repo",
            gitlabProjectId: "42",
            queues: ["DEV"],
            tags: ["ai_dev"],
          },
        ],
      }),
      "utf8",
    );

    const config = loadFleetConfig({
      WORKER_CONFIG_FILE: configFile,
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      TELEGRAM_ASSISTANT_ENABLED: "true",
      TELEGRAM_ASSISTANT_BOT_TOKEN: "env-secret",
      TELEGRAM_ALLOWED_USER_IDS: "202,303",
      TELEGRAM_MEDIA_ENABLED: "true",
      TELEGRAM_MEDIA_ALLOWED_MIME_TYPES: "image/png,image/webp",
    });

    expect(config.telegramAssistant).toMatchObject({
      enabled: true,
      botToken: "env-secret",
      allowedUserIds: ["202", "303"],
      media: {
        enabled: true,
        allowedMimeTypes: ["image/png", "image/webp"],
      },
    });
  });

  it("rejects invalid Telegram assistant config file list values", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const invalidAllowedUsersConfig = join(directory, "invalid-allowed-users.json");
    writeFileSync(
      invalidAllowedUsersConfig,
      JSON.stringify({
        worker: { id: "worker-telegram", pollIntervalMinutes: 1 },
        tracker: { tokenEnv: "TRACKER_TOKEN", orgIdEnv: "TRACKER_ORG_ID", statusMapFile },
        gitlab: { urlEnv: "GITLAB_URL", tokenEnv: "GITLAB_TOKEN" },
        telegramAssistant: {
          enabled: true,
          botToken: "file-secret",
          allowedUserIds: "101,202",
        },
        repositories: [
          {
            name: "repo",
            repoPath: "/workspace/repo",
            gitlabProjectId: "42",
            queues: ["DEV"],
            tags: ["ai_dev"],
          },
        ],
      }),
      "utf8",
    );
    const invalidMediaConfig = join(directory, "invalid-media.json");
    writeFileSync(
      invalidMediaConfig,
      JSON.stringify({
        worker: { id: "worker-telegram", pollIntervalMinutes: 1 },
        tracker: { tokenEnv: "TRACKER_TOKEN", orgIdEnv: "TRACKER_ORG_ID", statusMapFile },
        gitlab: { urlEnv: "GITLAB_URL", tokenEnv: "GITLAB_TOKEN" },
        telegramAssistant: {
          enabled: true,
          botToken: "file-secret",
          allowedUserIds: ["101"],
          media: { allowedMimeTypes: "image/png" },
        },
        repositories: [
          {
            name: "repo",
            repoPath: "/workspace/repo",
            gitlabProjectId: "42",
            queues: ["DEV"],
            tags: ["ai_dev"],
          },
        ],
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
      loadFleetConfig({ ...env, WORKER_CONFIG_FILE: invalidAllowedUsersConfig }),
    ).toThrow(/telegramAssistant\.allowedUserIds/);
    expect(() =>
      loadFleetConfig({ ...env, WORKER_CONFIG_FILE: invalidMediaConfig }),
    ).toThrow(/telegramAssistant\.media\.allowedMimeTypes/);
  });

  it("labels Telegram assistant config file enum errors with config paths", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-telegram", pollIntervalMinutes: 1 },
        tracker: { tokenEnv: "TRACKER_TOKEN", orgIdEnv: "TRACKER_ORG_ID", statusMapFile },
        gitlab: { urlEnv: "GITLAB_URL", tokenEnv: "GITLAB_TOKEN" },
        telegramAssistant: {
          enabled: true,
          botToken: "file-secret",
          mode: "long-polling",
          allowedUserIds: ["101"],
        },
        repositories: [
          {
            name: "repo",
            repoPath: "/workspace/repo",
            gitlabProjectId: "42",
            queues: ["DEV"],
            tags: ["ai_dev"],
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
    ).toThrow(/telegramAssistant\.mode/);
  });

  it("ignores undocumented Telegram assistant env aliases", () => {
    const config = loadFleetConfig({
      ...baseFleetEnv(),
      TELEGRAM_ASSISTANT_GROUP_MODE: "private_only",
      TELEGRAM_ASSISTANT_WEBHOOK_PATH: "/tg",
      TELEGRAM_ASSISTANT_MEDIA_ENABLED: "true",
    });

    expect(config.telegramAssistant).toMatchObject({
      groupMode: "mentions_and_replies",
      webhook: undefined,
      media: { enabled: false },
    });
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
        operational: {
          retention: {
            rawLogDays: 30,
            artifactDays: 30,
            failedArtifactDays: 90,
            historyDays: 365,
          },
          cleanup: { enabled: true, intervalSeconds: 3600 },
          metricsEnabled: true,
          redactionEnabled: true,
        },
      },
    });
    expect(config.trackerToken).toBe("");
    expect(config.trackerStatusMap.open.statuses).toEqual(["open"]);
    expect(fleetConfig.coordination.lockBackend).toBe("none");
  });

  it("parses internal task tracker Yandex integration mode", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_DATABASE_URL: "postgresql://tracker:secret@localhost/tasks",
      TASK_INTAKE_MODE: "yandex_integration",
      YANDEX_SYNC_ENABLED: "true",
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
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

  it("parses AI proposal autonomy policy options", () => {
    const config = loadConfig({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      TASK_INTAKE_MODE: "ai_proposed",
      NODE_ENV: "test",
      AI_PROPOSALS_ENABLED: "false",
      AUTO_EXECUTE_LOW_RISK_ENABLED: "true",
      AI_PROPOSAL_ALLOWED_TASK_TYPES_JSON: "[\"documentation\",\"tests_only\"]",
      AI_PROPOSAL_DAILY_LIMIT: "3",
      AI_PROPOSAL_WINDOW_LIMIT: "2",
      AI_PROPOSAL_WINDOW_SECONDS: "600",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.autonomy).toEqual({
      aiProposalsEnabled: false,
      autoExecuteLowRiskEnabled: true,
      defaultAllowedTaskTypes: ["documentation", "tests_only"],
      defaultDailyProposalLimit: 3,
      defaultWindowProposalLimit: 2,
      defaultWindowSeconds: 600,
      repositories: {},
    });
  });

  it("parses project manager environment options for internal memory tracker", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      PROJECT_MANAGER_ENABLED: "true",
      PROJECT_MANAGER_RUN_ONCE: "true",
      PROJECT_MANAGER_INTERVAL_MINUTES: "60",
      PROJECT_MANAGER_FOCUS_AREAS_JSON: "[\"stability\",\"test coverage\"]",
      PROJECT_MANAGER_MAX_GOALS_PER_RUN: "2",
      PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL: "3",
      PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL: "auto_triage",
      PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK: "true",
      PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON: "[\"documentation\",\"tests_only\"]",
      PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED: "true",
      PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES: "50",
      PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL: "false",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.taskTracker).toMatchObject({
      provider: "internal",
      internal: { storage: "memory" },
    });
    expect(config.projectManager).toEqual({
      enabled: true,
      focusAreas: ["stability", "test coverage"],
      runOnce: true,
      intervalMinutes: 60,
      maxGoalsPerRun: 2,
      maxTaskProposalsPerGoal: 3,
      defaultAutonomyLevel: "auto_triage",
      autoApproveLowRisk: true,
      allowedTaskTypes: ["documentation", "tests_only"],
      repositoryScanEnabled: true,
      repositoryScanMaxFiles: 50,
      requireHumanGoalApproval: false,
    });
  });

  it("rejects project manager environment policy limits above hard caps", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_STORAGE: "memory",
        PROJECT_MANAGER_MAX_GOALS_PER_RUN: "21",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/PROJECT_MANAGER_MAX_GOALS_PER_RUN must be at most 20/);

    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_STORAGE: "memory",
        PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL: "21",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL must be at most 20/);
  });

  it("rejects enabled project manager outside internal task tracker mode", () => {
    const statusMapFile = createStatusMapFile();

    expect(() =>
      loadConfig({
        PROJECT_MANAGER_ENABLED: "true",
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/PROJECT_MANAGER_ENABLED=true requires TASK_TRACKER_PROVIDER=internal/);
  });

  it("rejects repository-enabled project manager outside internal task tracker mode", () => {
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
            name: "client-application",
            repoPath: "/workspace/client-app",
            gitlabProjectId: "42",
            queues: ["FRONTEND"],
            projectManager: { enabled: true },
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
    ).toThrow(/PROJECT_MANAGER_ENABLED=true requires TASK_TRACKER_PROVIDER=internal/);
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
        operational: {
          cleanup: { enabled: true, intervalSeconds: 3600 },
          redactionEnabled: true,
        },
      },
    });
  });

  it("parses and validates internal tracker operational hardening options", () => {
    const config = loadConfig({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
      TASK_TRACKER_RETENTION_RAW_LOG_DAYS: "14",
      TASK_TRACKER_RETENTION_ARTIFACT_DAYS: "21",
      TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS: "120",
      TASK_TRACKER_RETENTION_HISTORY_DAYS: "400",
      TASK_TRACKER_CLEANUP_ENABLED: "false",
      TASK_TRACKER_CLEANUP_INTERVAL_SECONDS: "7200",
      TASK_TRACKER_METRICS_ENABLED: "false",
      TASK_TRACKER_REDACTION_ENABLED: "true",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.taskTracker).toMatchObject({
      provider: "internal",
      internal: {
        operational: {
          retention: {
            rawLogDays: 14,
            artifactDays: 21,
            failedArtifactDays: 120,
            historyDays: 400,
          },
          cleanup: { enabled: false, intervalSeconds: 7200 },
          metricsEnabled: false,
          redactionEnabled: true,
        },
      },
    });
  });

  it("rejects invalid internal tracker retention settings", () => {
    expect(() =>
      loadConfig({
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
        TASK_TRACKER_RETENTION_HISTORY_DAYS: "30",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/RETENTION_HISTORY_DAYS/);

    expect(() =>
      loadConfig({
        TASK_TRACKER_PROVIDER: "internal",
        TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
        TASK_TRACKER_RETENTION_ARTIFACT_DAYS: "90",
        TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS: "30",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/FAILED_ARTIFACT_DAYS/);
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
      alerts: {
        enabled: true,
        minSeverity: "info",
        channels: [{ type: "webhook", url: "https://alerts.example.test/webhook" }],
      },
    });
    expect(config.observability).not.toHaveProperty("dashboard");
  });

  it("ignores removed legacy dashboard options", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      TASK_TRACKER_UI_ENABLED: "true",
      DASHBOARD_ENABLED: "true",
      DASHBOARD_PATH: "/ops",
      DASHBOARD_REFRESH_SECONDS: "5",
      DASHBOARD_API_PATH: "/api",
      DASHBOARD_BEARER_TOKEN: "dashboard-token",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    const observability = config.observability;
    expect(observability).toBeDefined();
    expect(observability?.taskTrackerUi.enabled).toBe(true);
    expect(observability?.taskTrackerUi.apiPath).toBe("/api");
    expect(observability).not.toHaveProperty("dashboard");
  });

  it("accepts explicit task tracker UI options", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      TASK_TRACKER_UI_ENABLED: "true",
      TASK_TRACKER_UI_BIND_HOST: "0.0.0.0",
      TASK_TRACKER_UI_PORT: "9666",
      TASK_TRACKER_UI_PATH: "/tracker",
      TASK_TRACKER_UI_API_PATH: "/tracker-api",
      TASK_TRACKER_UI_ASSET_PATH: "/tracker/assets",
      TASK_TRACKER_UI_STATIC_DIR: "/tmp/task-tracker-console",
      TASK_TRACKER_HUMAN_AUTH_MODE: "trusted_proxy",
      TASK_TRACKER_TRUSTED_USER_HEADER: "x-user",
      TASK_TRACKER_TRUSTED_ROLE_HEADER: "x-role",
      TASK_TRACKER_AGENT_TOKEN: "agent-token",
      TASK_TRACKER_SYSTEM_TOKEN: "system-token",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.observability).toMatchObject({
      host: "0.0.0.0",
      port: 9666,
      taskTrackerUi: {
        enabled: true,
        path: "/tracker",
        apiPath: "/tracker-api",
        assetPath: "/tracker/assets",
        staticDir: "/tmp/task-tracker-console",
        authMode: "trusted_proxy",
        trustedUserHeader: "x-user",
        trustedRoleHeader: "x-role",
        agentToken: "agent-token",
        systemToken: "system-token",
      },
    });
  });

  it("rejects ambiguous task tracker UI routes", () => {
    const statusMapFile = createStatusMapFile();
    const baseEnv = {
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      TASK_TRACKER_UI_ENABLED: "true",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    };

    expect(() =>
      loadConfig({
        ...baseEnv,
        TASK_TRACKER_UI_PATH: "/metrics",
      }),
    ).toThrow(/TASK_TRACKER_UI_PATH.*METRICS_PATH|METRICS_PATH.*TASK_TRACKER_UI_PATH/);

    expect(() =>
      loadConfig({
        ...baseEnv,
        TASK_TRACKER_UI_ASSET_PATH: "/assets",
      }),
    ).toThrow(/TASK_TRACKER_UI_ASSET_PATH/);

    expect(() =>
      loadConfig({
        ...baseEnv,
        TASK_TRACKER_UI_API_PATH: "/metrics",
      }),
    ).toThrow(
      /TASK_TRACKER_UI_API_PATH.*METRICS_PATH|METRICS_PATH.*TASK_TRACKER_UI_API_PATH/,
    );
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

  it("parses tracker image context settings from env", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      TRACKER_IMAGE_CONTEXT_ENABLED: "true",
      TRACKER_IMAGE_CONTEXT_MAX_COUNT: "3",
      TRACKER_IMAGE_CONTEXT_MAX_BYTES: "1048576",
      TRACKER_IMAGE_CONTEXT_TEMP_DIR: "/tmp/tracker-images",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.trackerImageContext).toEqual({
      enabled: true,
      maxCount: 3,
      maxBytes: 1048576,
      tempDir: "/tmp/tracker-images",
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

    const runtimeConfig = buildRepositoryRuntimeConfig(
      fleetConfig,
      fleetConfig.repositories[0]!,
    );
    expect(runtimeConfig.trackerImageContext).toEqual(appConfig.trackerImageContext);
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

  it("parses fleet project manager config and repository overrides", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        taskTracker: { provider: "internal", storage: "memory" },
        projectManager: {
          enabled: true,
          focusAreas: ["architecture", "reliability"],
          runOnce: true,
          intervalMinutes: 120,
          maxGoalsPerRun: 4,
          maxTaskProposalsPerGoal: 6,
          defaultAutonomyLevel: "auto_execute_low_risk",
          autoApproveLowRisk: true,
          allowedTaskTypes: ["documentation", "tests_only"],
          repositoryScanEnabled: true,
          repositoryScanMaxFiles: 75,
          requireHumanGoalApproval: false,
        },
        repositories: [
          {
            name: "client-application",
            repoPath: "/workspace/client-app",
            gitlabProjectId: "42",
            queues: ["FRONTEND"],
            projectManager: {
              enabled: false,
              focusAreas: ["accessibility", "test coverage"],
              allowedTaskTypes: ["tests_only"],
              maxGoalsPerRun: 1,
              maxTaskProposalsPerGoal: 2,
            },
          },
        ],
      }),
      "utf8",
    );

    const config = loadFleetConfig({
      WORKER_CONFIG_FILE: configFile,
      NODE_ENV: "test",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });
    const runtimeConfig = buildRepositoryRuntimeConfig(config, config.repositories[0]!);

    expect(config.projectManager).toEqual({
      enabled: true,
      focusAreas: ["architecture", "reliability"],
      runOnce: true,
      intervalMinutes: 120,
      maxGoalsPerRun: 4,
      maxTaskProposalsPerGoal: 6,
      defaultAutonomyLevel: "auto_execute_low_risk",
      autoApproveLowRisk: true,
      allowedTaskTypes: ["documentation", "tests_only"],
      repositoryScanEnabled: true,
      repositoryScanMaxFiles: 75,
      requireHumanGoalApproval: false,
    });
    expect(config.repositories[0]?.projectManager).toEqual({
      enabled: false,
      focusAreas: ["accessibility", "test coverage"],
      allowedTaskTypes: ["tests_only"],
      maxGoalsPerRun: 1,
      maxTaskProposalsPerGoal: 2,
    });
    expect(runtimeConfig.projectManager).toEqual({
      enabled: false,
      focusAreas: ["accessibility", "test coverage"],
      runOnce: true,
      intervalMinutes: 120,
      maxGoalsPerRun: 1,
      maxTaskProposalsPerGoal: 2,
      defaultAutonomyLevel: "auto_execute_low_risk",
      autoApproveLowRisk: true,
      allowedTaskTypes: ["tests_only"],
      repositoryScanEnabled: true,
      repositoryScanMaxFiles: 75,
      requireHumanGoalApproval: false,
    });
  });

  it("rejects fleet project manager root policy limits above hard caps", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        taskTracker: { provider: "internal", storage: "memory" },
        projectManager: {
          enabled: true,
          maxGoalsPerRun: 21,
        },
        repositories: [
          {
            name: "client-application",
            repoPath: "/workspace/client-app",
            gitlabProjectId: "42",
            queues: ["FRONTEND"],
          },
        ],
      }),
      "utf8",
    );

    expect(() =>
      loadFleetConfig({
        WORKER_CONFIG_FILE: configFile,
        NODE_ENV: "test",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
      }),
    ).toThrow(/projectManager.maxGoalsPerRun must be at most 20/);
  });

  it("rejects repository project manager policy limits above hard caps", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-fleet-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        taskTracker: { provider: "internal", storage: "memory" },
        projectManager: { enabled: true },
        repositories: [
          {
            name: "client-application",
            repoPath: "/workspace/client-app",
            gitlabProjectId: "42",
            queues: ["FRONTEND"],
            projectManager: {
              maxTaskProposalsPerGoal: 21,
            },
          },
        ],
      }),
      "utf8",
    );

    expect(() =>
      loadFleetConfig({
        WORKER_CONFIG_FILE: configFile,
        NODE_ENV: "test",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
      }),
    ).toThrow(
      /repositories\[0\]\.projectManager\.maxTaskProposalsPerGoal must be at most 20/,
    );
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

  it("parses Codex self-review settings from environment", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_ORG_HEADER: "x-org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      CODEX_SELF_REVIEW_ENABLED: "true",
      CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS: "3",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.codexSelfReviewEnabled).toBe(true);
    expect(config.codexSelfReviewMaxFixAttempts).toBe(3);
  });

  it("defaults Codex self-review off with one fix attempt", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_ORG_HEADER: "x-org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.codexSelfReviewEnabled).toBe(false);
    expect(config.codexSelfReviewMaxFixAttempts).toBe(1);
  });

  it("rejects invalid Codex self-review max fix attempts", () => {
    const statusMapFile = createStatusMapFile();

    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_ORG_HEADER: "x-org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS: "0",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS/);
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
