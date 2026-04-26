import { describe, expect, it } from "vitest";

import { FleetOrchestrator } from "../src/domain/fleetOrchestrator.js";
import { normalizeRepoPathForLease } from "../src/domain/lockBackend.js";
import {
  formatLeaseComment,
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
import type {
  CommentWithMetadata,
  GlobalWorkerConfig,
  LockBackend,
  LogicalStatus,
  RepositoryProfile,
  TaskLease,
  TrackerClient,
  TrackerIssue,
} from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";
import type { RepositoryWorkerContext } from "../src/domain/repositoryContext.js";

const repository = (
  name: string,
  queue: string,
  overrides: Partial<RepositoryProfile> = {},
): RepositoryProfile => ({
  name,
  repoPath: `/workspace/${name}`,
  gitlabProjectId: name,
  gitRemoteName: "origin",
  baseBranch: "main",
  queues: [queue],
  tags: ["ai_dev"],
  testCommand: "npm test",
  lintCommand: "npm run lint",
  ...overrides,
});

const issue = (key: string, overrides: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: key,
  key,
  title: key,
  description: "",
  queue: key.split("-")[0],
  createdAt: "2026-04-26T10:00:00.000Z",
  logicalStatus: "open",
  tags: ["ai_dev"],
  ...overrides,
});

const config = (repositories: RepositoryProfile[]): GlobalWorkerConfig => ({
  workerId: "worker-1",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  runOnce: true,
  preflightOnly: false,
  preflightRunTargetCommands: true,
  maxFixAttempts: 2,
  maxReviewFixAttempts: 2,
  gitRepositoryToken: "token",
  gitRepositoryUsername: "oauth2",
  gitCommitNoVerify: true,
  tracker: {
    token: "tracker-token",
    orgHeader: "X-Cloud-Org-ID",
    orgId: "org-id",
    statusMap: {
      open: { statuses: ["Open"] },
      in_progress: { statuses: ["In Progress"] },
      waiting_for_answer: { statuses: ["Waiting"] },
      review: { statuses: ["Review"] },
      failed: { statuses: ["Failed"] },
      done: { statuses: ["Done"] },
    },
    apiBaseUrl: "http://tracker",
  },
  gitlab: {
    url: "http://gitlab",
    token: "gitlab-token",
  },
  codex: {
    home: "/codex-home",
    cliCommand: "codex",
    cliArgs: [],
    sandbox: "workspace-write",
    execArgs: [],
    timeoutMs: 30 * 60 * 1000,
    progressLogIntervalMs: 30 * 1000,
    logFullEvents: false,
    questionMarker: "AI_QUESTION:",
  },
  coordination: {
    lockBackend: "tracker",
    lockTtlMs: 15 * 60 * 1000,
    lockHeartbeatMs: 60 * 1000,
  },
  priorityQueue: {
    manualOverrideTags: ["ai_priority"],
    priorityWeights: {
      high: 400,
      normal: 100,
      low: 0,
    },
    tagBoosts: {},
    componentBoosts: {},
    deadlineBoost: {
      dueToday: 300,
      overdue: 600,
    },
    createdAtTieBreaker: "oldest",
  },
  repositories,
});

class FakeTrackerClient implements TrackerClient {
  constructor(
    private readonly issues: TrackerIssue[],
    private readonly commentsByIssue: Record<string, CommentWithMetadata[]> = {},
  ) {}

  async checkReadAccess(): Promise<void> {
    return;
  }

  async findCandidateIssues(input: { queue?: string } = {}): Promise<TrackerIssue[]> {
    return this.issues.filter((candidate) => candidate.queue === input.queue);
  }

  async findOwnedIssues(): Promise<TrackerIssue[]> {
    return [];
  }

  async getIssue(issueKey: string): Promise<TrackerIssue> {
    const found = this.issues.find((candidate) => candidate.key === issueKey);
    if (!found) {
      throw new Error(`Unknown issue ${issueKey}`);
    }
    return found;
  }

  async getComments(issueKey: string): Promise<CommentWithMetadata[]> {
    return this.commentsByIssue[issueKey] ?? [];
  }

  async addComment(): Promise<void> {
    return;
  }

  async transition(): Promise<void> {
    return;
  }

  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined {
    return issue.logicalStatus;
  }
}

class FakeLockBackend implements LockBackend {
  constructor(private readonly blockedIssueKeys = new Set<string>()) {}

  async acquireTaskLease(input: {
    issueKey: string;
    workerId: string;
    repositoryName: string;
    repoPath: string;
  }): Promise<TaskLease | null> {
    if (this.blockedIssueKeys.has(input.issueKey)) {
      return null;
    }
    return this.lease("task", input);
  }

  async acquireRepositoryLease(input: {
    issueKey: string;
    workerId: string;
    repositoryName: string;
    repoPath: string;
  }): Promise<TaskLease | null> {
    return this.lease("repository", input);
  }

  async renewTaskLease(lease: TaskLease): Promise<TaskLease> {
    return lease;
  }

  async releaseTaskLease(): Promise<void> {
    return;
  }

  async getActiveLease(): Promise<TaskLease | null> {
    return null;
  }

  private lease(
    kind: "task" | "repository",
    input: {
      issueKey: string;
      workerId: string;
      repositoryName: string;
      repoPath: string;
    },
  ): TaskLease {
    const now = new Date("2026-04-26T10:00:00.000Z").toISOString();
    return {
      kind,
      leaseKey: `${kind}:${input.issueKey}`,
      issueKey: input.issueKey,
      workerId: input.workerId,
      repositoryName: input.repositoryName,
      repoPath: input.repoPath,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date("2026-04-26T10:15:00.000Z").toISOString(),
      token: `${kind}-token`,
    };
  }
}

const context = (
  profile: RepositoryProfile,
  issues: TrackerIssue[],
  processed: string[],
  commentsByIssue: Record<string, CommentWithMetadata[]> = {},
): RepositoryWorkerContext =>
  ({
    profile,
    tracker: new FakeTrackerClient(issues, commentsByIssue),
    orchestrator: {
      processSelectedIssue: async (selectedIssue: TrackerIssue) => {
        processed.push(`${profile.name}:${selectedIssue.key}`);
        return "processed";
      },
    },
  }) as unknown as RepositoryWorkerContext;

describe("FleetOrchestrator", () => {
  it("routes candidates to matching repository profiles and uses priority ordering", async () => {
    const frontend = repository("client-application", "FRONTEND");
    const backend = repository("backend-api", "BACKEND");
    const processed: string[] = [];
    const orchestrator = new FleetOrchestrator(
      config([frontend, backend]),
      [
        context(frontend, [issue("FRONTEND-1", { priority: "normal" })], processed),
        context(backend, [issue("BACKEND-1", { priority: "high" })], processed),
      ],
      new FakeLockBackend(),
      new Logger(),
    );

    await expect(orchestrator.runOnce()).resolves.toBe("processed");
    expect(processed).toEqual(["backend-api:BACKEND-1"]);
  });

  it("tries the next scored candidate when the top candidate lease cannot be acquired", async () => {
    const frontend = repository("client-application", "FRONTEND");
    const processed: string[] = [];
    const orchestrator = new FleetOrchestrator(
      config([frontend]),
      [
        context(
          frontend,
          [
            issue("FRONTEND-1", { priority: "high" }),
            issue("FRONTEND-2", { priority: "normal" }),
          ],
          processed,
        ),
      ],
      new FakeLockBackend(new Set(["FRONTEND-1"])),
      new Logger(),
    );

    await expect(orchestrator.runOnce()).resolves.toBe("processed");
    expect(processed).toEqual(["client-application:FRONTEND-2"]);
  });

  it("skips a candidate when another issue holds the same repository path lease", async () => {
    const frontend = repository("client-application", "FRONTEND");
    const backend = repository("backend-api", "BACKEND");
    const activeLease = {
      kind: "repository" as const,
      leaseKey: `repo:${normalizeRepoPathForLease("/workspace/client-application")}`,
      issueKey: "FRONTEND-0",
      workerId: "worker-2",
      repositoryName: "client-application",
      repoPath: "/workspace/client-application",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      token: "repo-token",
    };
    const leaseText = formatLeaseComment(activeLease);
    const processed: string[] = [];
    const orchestrator = new FleetOrchestrator(
      config([frontend, backend]),
      [
        context(
          frontend,
          [
            issue("FRONTEND-0", { logicalStatus: "in_progress" }),
            issue("FRONTEND-1", { priority: "high" }),
          ],
          processed,
          {
            "FRONTEND-0": [
              {
                id: "1",
                text: leaseText,
                createdAt: "2026-04-26T10:01:00.000Z",
                isSystem: false,
                metadata: parseServiceComment(leaseText),
              },
            ],
          },
        ),
        context(backend, [issue("BACKEND-1", { priority: "normal" })], processed),
      ],
      new FakeLockBackend(),
      new Logger(),
    );

    await expect(orchestrator.runOnce()).resolves.toBe("processed");
    expect(processed).toEqual(["backend-api:BACKEND-1"]);
  });

  it("skips open tasks whose blockers are not done", async () => {
    const frontend = repository("client-application", "FRONTEND");
    const processed: string[] = [];
    const orchestrator = new FleetOrchestrator(
      config([frontend]),
      [
        context(
          frontend,
          [
            issue("FRONTEND-0", { logicalStatus: "in_progress" }),
            issue("FRONTEND-1", {
              priority: "high",
              blockedBy: ["FRONTEND-0"],
            }),
            issue("FRONTEND-2", { priority: "normal" }),
          ],
          processed,
        ),
      ],
      new FakeLockBackend(),
      new Logger(),
    );

    await expect(orchestrator.runOnce()).resolves.toBe("processed");
    expect(processed).toEqual(["client-application:FRONTEND-2"]);
  });
});
