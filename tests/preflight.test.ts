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
  maxFixAttempts: 2,
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

  async checkoutTaskBranch(issueKey: string): Promise<string> {
    return `feature/ai-task-${issueKey}`;
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

  async createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
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
}

const successfulCommand = async (): Promise<ProcessResult> => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});

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
});
