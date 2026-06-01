import { describe, expect, it } from "vitest";

import {
  formatPreflightReport,
  hasPreflightFailures,
  PreflightService,
} from "../src/domain/preflight.js";
import type {
  AppConfig,
  CommentWithMetadata,
  GitLabService,
  GitService,
  LogicalStatus,
  MergeRequestInfo,
  ProcessResult,
  TrackerClient,
  TrackerIssue,
} from "../src/models/types.js";
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
  repoPath: "/workspace/project",
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
  codexSelfReviewEnabled: false,
  codexSelfReviewMaxFixAttempts: 1,
  maxFixAttempts: 2,
  maxReviewFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
  ...overrides,
});

class FakeTrackerClient implements TrackerClient {
  readChecks = 0;
  comments: Array<{ issueKey: string; text: string }> = [];
  getIssueCalls: string[] = [];

  async checkReadAccess(): Promise<void> {
    this.readChecks += 1;
  }

  async findCandidateIssues(): Promise<TrackerIssue[]> {
    return [];
  }

  async findOwnedIssues(): Promise<TrackerIssue[]> {
    return [];
  }

  async getIssue(issueKey: string): Promise<TrackerIssue> {
    this.getIssueCalls.push(issueKey);
    return {
      id: "1",
      key: issueKey,
      title: issueKey,
      description: "",
      logicalStatus: "open",
    };
  }

  async getComments(): Promise<CommentWithMetadata[]> {
    return [];
  }

  async addComment(issueKey: string, text: string): Promise<void> {
    this.comments.push({ issueKey, text });
  }

  async transition(): Promise<void> {
    return;
  }

  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined {
    return issue.logicalStatus;
  }
}

class FakeGitService implements GitService {
  readyChecks = 0;

  async assertRepositoryReady(): Promise<void> {
    this.readyChecks += 1;
  }

  async getCurrentBranch(): Promise<string> {
    return "main";
  }

  async hasChanges(): Promise<boolean> {
    return false;
  }

  async hasDiffFromBase(): Promise<boolean> {
    return false;
  }

  async syncBaseBranch(): Promise<void> {
    return;
  }

  async checkoutBranch(branch: string): Promise<string> {
    return branch;
  }

  async checkoutTaskBranch(issueKey: string): Promise<string> {
    return `feature/ai-task-${issueKey}`;
  }

  async getDiffFromBase(): Promise<string> {
    return "";
  }

  async getChangedFilesFromBase(): Promise<string[]> {
    return [];
  }

  async getHeadSha(): Promise<string> {
    return "HEAD";
  }

  async commit(): Promise<void> {
    return;
  }

  async push(): Promise<void> {
    return;
  }
}

class FakeGitLabService implements GitLabService {
  readChecks = 0;
  writeChecks: string[] = [];

  async checkReadAccess(): Promise<void> {
    this.readChecks += 1;
  }

  async checkMergeRequestWriteAccess(sourceBranch: string): Promise<MergeRequestInfo> {
    this.writeChecks.push(sourceBranch);
    return {
      id: 1,
      iid: 1,
      url: "https://gitlab.example.com/project/-/merge_requests/1",
      title: `[AI Preflight] ${sourceBranch}`,
      sourceBranch,
      targetBranch: "main",
    };
  }

  async findOpenMergeRequestByBranch(): Promise<MergeRequestInfo | null> {
    return null;
  }

  async findMergeRequestByBranch(): Promise<MergeRequestInfo | null> {
    return null;
  }

  async getMergeRequest(): Promise<MergeRequestInfo | null> {
    return null;
  }

  async createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
  }): Promise<MergeRequestInfo> {
    return {
      id: 1,
      iid: 1,
      url: "https://gitlab.example.com/project/-/merge_requests/1",
      title: input.title,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
    };
  }

  async getMergeRequestDiscussions() {
    return [];
  }

  async replyToDiscussion(): Promise<void> {
    return;
  }

  async getCurrentUser(): Promise<{ username: string }> {
    return { username: "ai-worker" };
  }
}

const successfulCommand = async (): Promise<ProcessResult> => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});

const buildPreflightWithConfig = (overrides: Partial<AppConfig>): PreflightService =>
  new PreflightService(
    createConfig(overrides),
    new FakeTrackerClient(),
    new FakeGitService(),
    new FakeGitLabService(),
    async () => undefined,
    new Logger(),
    successfulCommand,
  );

describe("PreflightService", () => {
  it("returns a stable read-only report with warnings for omitted sandbox writes", async () => {
    const tracker = new FakeTrackerClient();
    const gitlab = new FakeGitLabService();
    const service = new PreflightService(
      createConfig(),
      tracker,
      new FakeGitService(),
      gitlab,
      async () => undefined,
      new Logger(),
      successfulCommand,
    );

    const checks = await service.run();

    expect(checks.map((check) => `${check.status}:${check.name}`)).toEqual([
      "pass:Config load",
      "pass:Codex auth",
      "pass:Git repository",
      "pass:Tracker read",
      "warn:Tracker write",
      "pass:GitLab read",
      "warn:GitLab write",
      "pass:Target commands",
    ]);
    expect(tracker.readChecks).toBe(1);
    expect(tracker.comments).toEqual([]);
    expect(gitlab.writeChecks).toEqual([]);
    expect(hasPreflightFailures(checks)).toBe(false);
    expect(formatPreflightReport(checks)).toContain("WARN Tracker write");
  });

  it("uses explicit sandbox issue and branch for write checks", async () => {
    const tracker = new FakeTrackerClient();
    const gitlab = new FakeGitLabService();
    const service = new PreflightService(
      createConfig({
        trackerPreflightIssueKey: "DEV-1",
        gitlabPreflightSourceBranch: "preflight/dev-1",
      }),
      tracker,
      new FakeGitService(),
      gitlab,
      async () => undefined,
      new Logger(),
      successfulCommand,
    );

    const checks = await service.run();

    expect(checks.filter((check) => check.status === "warn")).toEqual([]);
    expect(tracker.getIssueCalls).toEqual(["DEV-1"]);
    expect(tracker.comments[0]?.issueKey).toBe("DEV-1");
    expect(gitlab.writeChecks).toEqual(["preflight/dev-1"]);
  });

  it("marks failing target commands as preflight failures", async () => {
    const service = new PreflightService(
      createConfig(),
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) => ({
        stdout: "",
        stderr: command === "npm test" ? "test failed" : "",
        exitCode: command === "npm test" ? 1 : 0,
      }),
    );

    const checks = await service.run();

    expect(hasPreflightFailures(checks)).toBe(true);
    expect(checks.at(-1)).toMatchObject({
      name: "Target commands",
      status: "fail",
    });
    expect(checks.at(-1)?.details).toContain("TEST_COMMAND failed");
  });

  it("fails preflight when image context is enabled and Codex CLI lacks --image", async () => {
    const commands: string[] = [];
    const service = new PreflightService(
      createConfig({
        trackerImageContext: {
          enabled: true,
          maxCount: 5,
          maxBytes: 10_485_760,
        },
      }),
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) => {
        commands.push(command);
        return command.includes("codex exec --help")
          ? { stdout: "Usage: codex exec", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    const checks = await service.run();

    expect(commands).toContain("codex exec --help");
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex image input",
          status: "fail",
        }),
      ]),
    );
  });

  it("passes preflight when image context is enabled and Codex CLI supports images for new and resumed sessions", async () => {
    const commands: string[] = [];
    const service = new PreflightService(
      createConfig({
        codexCliCommand: "codex launcher",
        codexCliArgs: ["--profile", "visual worker"],
        trackerImageContext: {
          enabled: true,
          maxCount: 5,
          maxBytes: 10_485_760,
        },
      }),
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) => {
        commands.push(command);
        return command.includes("exec resume --help")
          ? { stdout: "Usage: codex exec resume\n  --image <path>", stderr: "", exitCode: 0 }
          : command.includes("exec --help")
          ? { stdout: "Usage: codex exec\n  --image <path>", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    const checks = await service.run();

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exec --help"),
        expect.stringContaining("exec resume --help"),
      ]),
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex image input",
          status: "pass",
          details: "Codex CLI supports image inputs through codex exec --image and codex exec resume --image.",
        }),
      ]),
    );
  });

  it("fails preflight when resume image support is missing", async () => {
    const service = new PreflightService(
      createConfig({
        trackerImageContext: {
          enabled: true,
          maxCount: 5,
          maxBytes: 10_485_760,
        },
      }),
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) =>
        command.includes("exec resume --help")
          ? { stdout: "Usage: codex exec resume", stderr: "", exitCode: 0 }
          : command.includes("exec --help")
            ? { stdout: "Usage: codex exec\n  --image <path>", stderr: "", exitCode: 0 }
            : { stdout: "", stderr: "", exitCode: 0 },
    );

    const checks = await service.run();

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex image input",
          status: "fail",
          details: expect.stringContaining("codex exec resume --help"),
        }),
      ]),
    );
  });

  it("does not check resume image support when image context is disabled", async () => {
    const commands: string[] = [];
    const service = new PreflightService(
      createConfig({
        trackerImageContext: {
          enabled: false,
          maxCount: 5,
          maxBytes: 10_485_760,
        },
      }),
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    await service.run();

    expect(commands.some((command) => command.includes("exec resume --help"))).toBe(false);
  });

  it("reports Telegram assistant config failures when enabled without internal tracker", async () => {
    const service = buildPreflightWithConfig({
      telegramAssistant: {
        enabled: true,
        botToken: "secret",
        taskCreationEnabled: true,
        allowedUserIds: ["1"],
        allowedChatIds: [],
      },
      taskTracker: { provider: "yandex" },
    } as any);

    const results = await service.run();

    expect(results.some((result) => result.name === "telegram assistant" && result.status === "fail")).toBe(true);
  });

  it("fails Telegram assistant preflight for non-HTTPS public webhook URLs", async () => {
    const service = buildPreflightWithConfig({
      telegramAssistant: {
        enabled: true,
        botToken: "secret",
        mode: "webhook",
        taskCreationEnabled: false,
        allowedUserIds: ["1"],
        allowedChatIds: [],
        webhook: { path: "/telegram/webhook", secretToken: "hook-secret" },
      },
      observability: {
        enabled: true,
        host: "127.0.0.1",
        port: 9464,
        baseUrl: "http://worker.example.test",
        metrics: { enabled: true, path: "/metrics" },
        health: { path: "/healthz", readinessPath: "/readyz" },
        taskTrackerUi: {
          enabled: false,
          authMode: "localhost",
        },
      },
    } as any);

    const results = await service.run();

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram assistant",
        status: "fail",
        details: expect.stringContaining("https"),
      }),
    ]));
  });

  it.each([
    ["private IPv4", "https://10.0.0.5"],
    ["CGNAT IPv4", "https://100.64.0.1"],
    ["ULA IPv6", "https://[fc00::1]"],
  ])("fails Telegram assistant preflight for %s webhook URLs", async (_label, baseUrl) => {
    const service = buildPreflightWithConfig({
      telegramAssistant: {
        enabled: true,
        botToken: "secret",
        mode: "webhook",
        taskCreationEnabled: false,
        allowedUserIds: ["1"],
        allowedChatIds: [],
        webhook: { path: "/telegram/webhook", secretToken: "hook-secret" },
      },
      observability: {
        enabled: true,
        host: "127.0.0.1",
        port: 9464,
        baseUrl,
        metrics: { enabled: true, path: "/metrics" },
        health: { path: "/healthz", readinessPath: "/readyz" },
        taskTrackerUi: {
          enabled: false,
          authMode: "localhost",
        },
      },
    } as any);

    const results = await service.run();

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram assistant",
        status: "fail",
        details: expect.stringContaining("public https observability.baseUrl"),
      }),
    ]));
  });

  it("fails Telegram assistant preflight for webhook mode without a secret token", async () => {
    const service = buildPreflightWithConfig({
      telegramAssistant: {
        enabled: true,
        botToken: "secret",
        mode: "webhook",
        taskCreationEnabled: false,
        allowedUserIds: ["1"],
        allowedChatIds: [],
        webhook: { path: "/telegram/webhook" },
      },
      observability: {
        enabled: true,
        host: "127.0.0.1",
        port: 9464,
        baseUrl: "https://worker.example.test",
        metrics: { enabled: true, path: "/metrics" },
        health: { path: "/healthz", readinessPath: "/readyz" },
        taskTrackerUi: {
          enabled: false,
          authMode: "localhost",
        },
      },
    } as any);

    const results = await service.run();

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram assistant",
        status: "fail",
        details: expect.stringContaining("webhook secret token"),
      }),
    ]));
  });

  it("checks codex exec review help when Codex self-review is enabled", async () => {
    const commands: string[] = [];
    const service = new PreflightService(
      {
        ...createConfig(),
        codexSelfReviewEnabled: true,
      },
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) => {
        commands.push(command);
        if (command.includes("exec review --help")) {
          return {
            stdout:
              "Usage: codex exec review\n  --base <BRANCH>\n  --uncommitted\n  --json\n  --output-last-message <FILE>\n  --skip-git-repo-check\n  --ephemeral",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    const checks = await service.run();

    expect(commands).toEqual(expect.arrayContaining([expect.stringContaining("exec review --help")]));
    expect(checks).toEqual(
      expect.arrayContaining([
        {
          name: "Codex self-review",
          status: "pass",
          details: "Codex CLI supports self-review through codex exec review.",
        },
      ]),
    );
  });

  it("fails preflight when Codex self-review support is missing", async () => {
    const service = new PreflightService(
      {
        ...createConfig(),
        codexSelfReviewEnabled: true,
      },
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) =>
        command.includes("exec review --help")
          ? { stdout: "Usage: codex exec review\n  --base <BRANCH>", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 },
    );

    const checks = await service.run();

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex self-review",
          status: "fail",
          details: expect.stringContaining("--output-last-message"),
        }),
      ]),
    );
  });

  it("fails preflight when Codex self-review cannot include uncommitted changes", async () => {
    const service = new PreflightService(
      {
        ...createConfig(),
        codexSelfReviewEnabled: true,
      },
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) =>
        command.includes("exec review --help")
          ? {
              stdout:
                "Usage: codex exec review\n  --base <BRANCH>\n  --json\n  --output-last-message <FILE>\n  --skip-git-repo-check\n  --ephemeral",
              stderr: "",
              exitCode: 0,
            }
          : { stdout: "", stderr: "", exitCode: 0 },
    );

    const checks = await service.run();

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex self-review",
          status: "fail",
          details: expect.stringContaining("--uncommitted"),
        }),
      ]),
    );
  });

  it("checks internal tracker storage without calling Yandex tracker", async () => {
    const tracker = new FakeTrackerClient();
    const service = new PreflightService(
      createConfig({
        taskTracker: {
          provider: "internal",
          internal: {
            storage: "postgres",
            databaseUrl: "postgres://tracker:secret@localhost/tasks",
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
        },
      }),
      tracker,
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      successfulCommand,
      async () => undefined,
    );

    const checks = await service.run();

    expect(checks.map((check) => check.name)).toEqual([
      "Config load",
      "Internal tracker storage",
      "Internal tracker migrations",
      "Codex auth",
      "Git repository",
      "GitLab read",
      "GitLab write",
      "Target commands",
    ]);
    expect(checks.find((check) => check.name === "Internal tracker storage")).toMatchObject({
      status: "pass",
    });
    expect(tracker.readChecks).toBe(0);
    expect(tracker.comments).toEqual([]);
  });
});
