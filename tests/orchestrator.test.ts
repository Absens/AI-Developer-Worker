import { describe, expect, it } from "vitest";

import { WorkerOrchestrator } from "../src/domain/orchestrator.js";
import { formatStatusComment, parseServiceComment } from "../src/integrations/tracker/commentProtocol.js";
import type {
  AppConfig,
  CodexExecution,
  CodexRunner,
  CommentWithMetadata,
  GitLabService,
  GitService,
  LogicalStatus,
  MergeRequestInfo,
  TrackerClient,
  TrackerIssue,
} from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const createConfig = (repoPath: string): AppConfig => ({
  trackerToken: "tracker-token",
  trackerOrgHeader: "X-Cloud-Org-ID",
  trackerOrgId: "org-id",
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
  repoPath,
  baseBranch: "main",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  codexHome: "/codex-home",
  codexCliCommand: "codex",
  codexCommand: "codex exec",
  codexQuestionMarker: "AI_QUESTION:",
  maxFixAttempts: 2,
  workerId: "worker-1",
  testCommand: `node -e "process.exit(0)"`,
  lintCommand: `node -e "process.exit(0)"`,
  runOnce: false,
});

class FakeTrackerClient implements TrackerClient {
  readonly transitions: Array<{ issueKey: string; target: LogicalStatus }> = [];
  readonly addedComments: Array<{ issueKey: string; text: string }> = [];

  constructor(
    readonly issues: TrackerIssue[],
    readonly commentsByIssue: Record<string, CommentWithMetadata[]>,
  ) {}

  async findCandidateIssues(): Promise<TrackerIssue[]> {
    return this.issues;
  }

  async findOwnedIssues(statuses: LogicalStatus[]): Promise<TrackerIssue[]> {
    return this.issues.filter(
      (issue) => issue.logicalStatus && statuses.includes(issue.logicalStatus),
    );
  }

  async getIssue(issueKey: string): Promise<TrackerIssue> {
    const issue = this.issues.find((entry) => entry.key === issueKey);
    if (!issue) {
      throw new Error(`Unknown issue: ${issueKey}`);
    }
    return issue;
  }

  async getComments(issueKey: string): Promise<CommentWithMetadata[]> {
    return this.commentsByIssue[issueKey] ?? [];
  }

  async addComment(issueKey: string, text: string): Promise<void> {
    this.addedComments.push({ issueKey, text });
    const bucket = this.commentsByIssue[issueKey] ?? [];
    bucket.push({
      id: String(bucket.length + 1),
      text,
      createdAt: new Date(bucket.length + 1).toISOString(),
      isSystem: false,
      metadata: parseServiceComment(text),
    });
    this.commentsByIssue[issueKey] = bucket;
  }

  async transition(issueKey: string, targetStatus: LogicalStatus): Promise<void> {
    this.transitions.push({ issueKey, target: targetStatus });
    const issue = this.issues.find((entry) => entry.key === issueKey);
    if (issue) {
      issue.logicalStatus = targetStatus;
    }
  }

  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined {
    return issue.logicalStatus;
  }
}

class FakeGitService implements GitService {
  currentBranch = "main";
  uncommittedChanges = false;
  diffFromBase = false;
  commits: string[] = [];
  pushes: string[] = [];

  async getCurrentBranch(): Promise<string> {
    return this.currentBranch;
  }

  async hasChanges(): Promise<boolean> {
    return this.uncommittedChanges;
  }

  async hasDiffFromBase(): Promise<boolean> {
    return this.diffFromBase;
  }

  async syncBaseBranch(): Promise<void> {
    this.currentBranch = "main";
  }

  async checkoutTaskBranch(issueKey: string): Promise<string> {
    this.currentBranch = `feature/ai-task-${issueKey}`;
    return this.currentBranch;
  }

  async commit(message: string): Promise<void> {
    this.commits.push(message);
    this.uncommittedChanges = false;
    this.diffFromBase = true;
  }

  async push(branch: string): Promise<void> {
    this.pushes.push(branch);
  }
}

class FakeGitLabService implements GitLabService {
  createCalls: string[] = [];

  async findOpenMergeRequestByBranch(): Promise<MergeRequestInfo | null> {
    return null;
  }

  async createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
  }): Promise<MergeRequestInfo> {
    this.createCalls.push(input.sourceBranch);
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

class FakeCodexRunner implements CodexRunner {
  constructor(
    private readonly onInitial: () => CodexExecution | Promise<CodexExecution>,
  ) {}

  runInitial(): Promise<CodexExecution> {
    return Promise.resolve(this.onInitial());
  }

  runFix(): Promise<CodexExecution> {
    return Promise.resolve({
      process: {
        stdout: "",
        stderr: "",
        exitCode: 0,
      },
    });
  }
}

describe("WorkerOrchestrator", () => {
  it("processes the earliest free open issue and creates a merge request", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-1",
          title: "Busy task",
          description: "Busy",
          createdAt: "2026-03-10T10:00:00.000Z",
          logicalStatus: "open",
        },
        {
          id: "2",
          key: "DEV-2",
          title: "Free task",
          description: "Do the work",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "open",
        },
      ],
      {
        "DEV-1": [
          {
            id: "1",
            text: formatStatusComment("worker-2", "in_progress", "Already processing"),
            createdAt: "2026-03-10T10:00:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment("worker-2", "in_progress", "Already processing"),
            ),
          },
        ],
        "DEV-2": [],
      },
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    const codex = new FakeCodexRunner(() => {
      git.uncommittedChanges = true;
      git.diffFromBase = true;
      return {
        process: {
          stdout: "implemented",
          stderr: "",
          exitCode: 0,
        },
      };
    });
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      git,
      gitlab,
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(tracker.transitions).toEqual([
      { issueKey: "DEV-2", target: "in_progress" },
      { issueKey: "DEV-2", target: "review" },
    ]);
    expect(git.commits).toEqual(["feat: implement DEV-2"]);
    expect(git.pushes).toEqual(["feature/ai-task-DEV-2"]);
    expect(gitlab.createCalls).toEqual(["feature/ai-task-DEV-2"]);
  });

  it("moves a task to waiting_for_answer when Codex asks a question", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-3",
          title: "Need clarification",
          description: "Clarify business rule",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "open",
        },
      ],
      {
        "DEV-3": [],
      },
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    const codex = new FakeCodexRunner(() => ({
      process: {
        stdout: "AI_QUESTION: Which API variant should be used?",
        stderr: "",
        exitCode: 0,
      },
      question: "Which API variant should be used?",
    }));
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      git,
      gitlab,
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("waiting");
    expect(tracker.transitions).toEqual([
      { issueKey: "DEV-3", target: "in_progress" },
      { issueKey: "DEV-3", target: "waiting_for_answer" },
    ]);
    expect(tracker.addedComments.some((entry) => entry.text.startsWith("AI QUESTION:"))).toBe(true);
  });
});
