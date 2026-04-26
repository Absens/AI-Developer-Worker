import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerOrchestrator } from "../src/domain/orchestrator.js";
import {
  formatMergeRequestComment,
  formatQuestionCommentWithThreadId,
  formatStatusComment,
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
import type {
  AppConfig,
  ClarificationQuestion,
  CodexExecution,
  CodexRunner,
  CommentWithMetadata,
  GitLabService,
  GitService,
  LogicalStatus,
  MergeRequestDiscussion,
  MergeRequestInfo,
  TrackerClient,
  TrackerIssue,
} from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const cleanupPaths: string[] = [];

const clarification: ClarificationQuestion = {
  summary: "Need a decision about the API variant.",
  blockingReason: "Implementation differs depending on the endpoint contract.",
  question: "Which API variant should be used?",
  options: ["A: use v1", "B: use v2"],
  resumeHint: "Reply with /resume A or /resume B.",
};

const createTempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  cleanupPaths.push(path);
  return path;
};

const createConfig = (repoPath: string, overrides: Partial<AppConfig> = {}): AppConfig => ({
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
  repoPath,
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
  maxReviewFixAttempts: 2,
  workerId: "worker-1",
  testCommand: `node -e "process.exit(0)"`,
  lintCommand: `node -e "process.exit(0)"`,
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
  ...overrides,
});

class FakeTrackerClient implements TrackerClient {
  readonly transitions: Array<{ issueKey: string; target: LogicalStatus }> = [];
  readonly addedComments: Array<{ issueKey: string; text: string }> = [];
  candidateIssueLookups = 0;
  ownedIssueLookups = 0;
  getIssueCalls: string[] = [];

  constructor(
    readonly issues: TrackerIssue[],
    readonly commentsByIssue: Record<string, CommentWithMetadata[]>,
  ) {}

  async checkReadAccess(): Promise<void> {
    return;
  }

  async findCandidateIssues(): Promise<TrackerIssue[]> {
    this.candidateIssueLookups += 1;
    return this.issues;
  }

  async findOwnedIssues(statuses: LogicalStatus[]): Promise<TrackerIssue[]> {
    this.ownedIssueLookups += 1;
    return this.issues.filter(
      (issue) => issue.logicalStatus && statuses.includes(issue.logicalStatus),
    );
  }

  async getIssue(issueKey: string): Promise<TrackerIssue> {
    this.getIssueCalls.push(issueKey);
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

  async assertRepositoryReady(): Promise<void> {
    return;
  }

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

  async checkoutBranch(branch: string): Promise<string> {
    this.currentBranch = branch;
    return branch;
  }

  async getDiffFromBase(): Promise<string> {
    return "diff --git a/src/example.ts b/src/example.ts";
  }

  async getChangedFilesFromBase(): Promise<string[]> {
    return ["src/example.ts"];
  }

  async getHeadSha(): Promise<string> {
    return this.commits.length > 0 ? `commit-${this.commits.length}` : "base-commit";
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
  createDescriptions: Array<string | undefined> = [];
  findCalls: string[] = [];
  replies: Array<{ iid: number; discussionId: string; body: string }> = [];
  openMergeRequestsByBranch: Record<string, MergeRequestInfo> = {};
  discussionsByIid: Record<number, MergeRequestDiscussion[]> = {};
  currentUsername = "ai-worker";

  async checkReadAccess(): Promise<void> {
    return;
  }

  async checkMergeRequestWriteAccess(sourceBranch: string): Promise<MergeRequestInfo> {
    return this.createMergeRequest({
      sourceBranch,
      targetBranch: "main",
      title: `[AI Preflight] ${sourceBranch}`,
    });
  }

  async findOpenMergeRequestByBranch(sourceBranch: string): Promise<MergeRequestInfo | null> {
    this.findCalls.push(sourceBranch);
    return this.openMergeRequestsByBranch[sourceBranch] ?? null;
  }

  async createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
  }): Promise<MergeRequestInfo> {
    this.createCalls.push(input.sourceBranch);
    this.createDescriptions.push(input.description);
    return {
      id: 1,
      iid: 1,
      url: "https://gitlab.example.com/project/-/merge_requests/1",
      title: input.title,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
    };
  }

  async getMergeRequestDiscussions(iid: number) {
    return this.discussionsByIid[iid] ?? [];
  }

  async replyToDiscussion(iid: number, discussionId: string, body: string): Promise<void> {
    this.replies.push({ iid, discussionId, body });
  }

  async getCurrentUser(): Promise<{ username: string }> {
    return { username: this.currentUsername };
  }
}

class FakeCodexRunner implements CodexRunner {
  readonly initialCalls: string[] = [];
  readonly fixCalls: string[] = [];
  readonly resumeCalls: Array<{ threadId: string; prompt: string }> = [];

  constructor(
    private readonly initialQueue: Array<() => CodexExecution | Promise<CodexExecution>>,
    private readonly resumeQueue: Array<
      (threadId: string, prompt: string) => CodexExecution | Promise<CodexExecution>
    > = [],
    private readonly fixQueue: Array<() => CodexExecution | Promise<CodexExecution>> = [],
  ) {}

  runInitial(prompt: string): Promise<CodexExecution> {
    this.initialCalls.push(prompt);
    const next = this.initialQueue.shift();
    if (!next) {
      return Promise.resolve({ process: { stdout: "", stderr: "", exitCode: 0 } });
    }
    return Promise.resolve(next());
  }

  runFix(prompt: string): Promise<CodexExecution> {
    this.fixCalls.push(prompt);
    const next = this.fixQueue.shift();
    if (!next) {
      return Promise.resolve({ process: { stdout: "", stderr: "", exitCode: 0 } });
    }
    return Promise.resolve(next());
  }

  runResume(threadId: string, prompt: string): Promise<CodexExecution> {
    this.resumeCalls.push({ threadId, prompt });
    const next = this.resumeQueue.shift();
    if (!next) {
      return Promise.resolve({ process: { stdout: "", stderr: "", exitCode: 0 } });
    }
    return Promise.resolve(next(threadId, prompt));
  }
}

describe("WorkerOrchestrator", () => {
  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("analyzes first, then resumes the same thread for implementation and creates a merge request", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-2",
          title: "Free task",
          description: "Do the work",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "open",
        },
      ],
      { "DEV-2": [] },
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    const codex = new FakeCodexRunner(
      [
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage: "READY_FOR_IMPLEMENTATION",
          threadId: "thread-analysis-1",
        }),
      ],
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "implemented", stderr: "", exitCode: 0 },
            finalMessage: "Implementation complete",
            threadId: "thread-analysis-1",
          };
        },
      ],
    );
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
    expect(codex.initialCalls).toHaveLength(1);
    expect(codex.resumeCalls).toHaveLength(1);
    expect(codex.resumeCalls[0]?.threadId).toBe("thread-analysis-1");
    expect(tracker.transitions).toEqual([
      { issueKey: "DEV-2", target: "in_progress" },
      { issueKey: "DEV-2", target: "review" },
    ]);
    expect(git.commits).toEqual(["feat: implement DEV-2"]);
    expect(git.pushes).toEqual(["feature/ai-task-DEV-2"]);
    expect(gitlab.createCalls).toEqual(["feature/ai-task-DEV-2"]);
  });

  it("moves a task to waiting_for_answer when analysis asks for clarification", async () => {
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
      { "DEV-3": [] },
    );
    const codex = new FakeCodexRunner([
      () => ({
        process: { stdout: "", stderr: "", exitCode: 0 },
        clarification,
        question: clarification.question,
        finalMessage: "AI_QUESTION: {}",
        threadId: "thread-123",
      }),
    ]);
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      new FakeGitService(),
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("waiting");
    expect(tracker.transitions).toEqual([
      { issueKey: "DEV-3", target: "in_progress" },
      { issueKey: "DEV-3", target: "waiting_for_answer" },
    ]);
    const questionComment = tracker.addedComments.find((entry) =>
      entry.text.startsWith("AI QUESTION:"),
    );
    expect(questionComment?.text).toContain("/resume A");
    expect(questionComment?.text).toContain("thread-123");
  });

  it("does not resume clarification until an explicit /resume command is present", async () => {
    const questionText = formatQuestionCommentWithThreadId(
      "worker-1",
      clarification,
      "thread-123",
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-4",
          title: "Resume task",
          description: "Continue after answer",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "waiting_for_answer",
        },
      ],
      {
        "DEV-4": [
          {
            id: "1",
            text: questionText,
            createdAt: "2026-03-10T11:00:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(questionText),
          },
          {
            id: "2",
            text: "Use the v2 endpoint.",
            createdAt: "2026-03-10T11:05:00.000Z",
            isSystem: false,
          },
          {
            id: "3",
            text: formatStatusComment(
              "worker-1",
              "waiting_for_answer",
              "Waiting for explicit /resume command after clarification.",
              "clarification",
            ),
            createdAt: "2026-03-10T11:06:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment(
                "worker-1",
                "waiting_for_answer",
                "Waiting for explicit /resume command after clarification.",
                "clarification",
              ),
            ),
          },
        ],
      },
    );
    const codex = new FakeCodexRunner([]);
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      new FakeGitService(),
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("waiting");
    expect(codex.resumeCalls).toHaveLength(0);
  });

  it("resumes the prior Codex session after an explicit /resume command", async () => {
    const questionText = formatQuestionCommentWithThreadId(
      "worker-1",
      clarification,
      "thread-123",
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-5",
          title: "Resume task",
          description: "Continue after answer",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "waiting_for_answer",
        },
      ],
      {
        "DEV-5": [
          {
            id: "1",
            text: questionText,
            createdAt: "2026-03-10T11:00:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(questionText),
          },
          {
            id: "2",
            text: "I think v2 is better because the old endpoint is deprecated.",
            createdAt: "2026-03-10T11:05:00.000Z",
            isSystem: false,
          },
          {
            id: "3",
            text: "/resume B",
            createdAt: "2026-03-10T11:06:00.000Z",
            isSystem: false,
          },
          {
            id: "4",
            text: formatStatusComment(
              "worker-1",
              "waiting_for_answer",
              "Waiting for explicit /resume command after clarification.",
              "clarification",
            ),
            createdAt: "2026-03-10T11:07:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment(
                "worker-1",
                "waiting_for_answer",
                "Waiting for explicit /resume command after clarification.",
                "clarification",
              ),
            ),
          },
        ],
      },
    );
    const git = new FakeGitService();
    const codex = new FakeCodexRunner(
      [],
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "", stderr: "", exitCode: 0 },
            finalMessage: "Resumed successfully",
          };
        },
      ],
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      git,
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(codex.resumeCalls).toHaveLength(1);
    expect(codex.resumeCalls[0]?.threadId).toBe("thread-123");
    expect(codex.resumeCalls[0]?.prompt).toContain("Choice: B");
    expect(codex.resumeCalls[0]?.prompt).toContain("old endpoint is deprecated");
  });

  it("resumes when the human reply quotes the AI question and puts /resume on the last line", async () => {
    const questionText = formatQuestionCommentWithThreadId(
      "worker-1",
      clarification,
      "thread-123",
    );
    const replyText = `> [In reply to](https://tracker.example.test/DEV-5#1){data-quotelink=true}
> 
> AI QUESTION:
>
> Need a decision about the API variant.
>
> Question: Which API variant should be used?
> Blocking reason: Implementation differs depending on the endpoint contract.
>
> Options:
>
> - A: use v1
> - B: use v2
>
> ::: html
> To continue:
Reply with /resume A or /resume B.
> :::

/resume B`;
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-5B",
          title: "Resume quoted reply",
          description: "Continue after a quoted answer",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "waiting_for_answer",
        },
      ],
      {
        "DEV-5B": [
          {
            id: "1",
            text: questionText,
            createdAt: "2026-03-10T11:00:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(questionText),
          },
          {
            id: "2",
            text: replyText,
            createdAt: "2026-03-10T11:06:00.000Z",
            isSystem: false,
          },
          {
            id: "3",
            text: formatStatusComment(
              "worker-1",
              "waiting_for_answer",
              "Waiting for explicit /resume command after clarification.",
              "clarification",
            ),
            createdAt: "2026-03-10T11:07:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment(
                "worker-1",
                "waiting_for_answer",
                "Waiting for explicit /resume command after clarification.",
                "clarification",
              ),
            ),
          },
        ],
      },
    );
    const git = new FakeGitService();
    const codex = new FakeCodexRunner(
      [],
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "", stderr: "", exitCode: 0 },
            finalMessage: "Resumed successfully",
          };
        },
      ],
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      git,
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(codex.resumeCalls).toHaveLength(1);
    expect(codex.resumeCalls[0]?.threadId).toBe("thread-123");
    expect(codex.resumeCalls[0]?.prompt).toContain("Choice: B");
  });

  it("falls back to a fresh implementation session when explicit resume fails", async () => {
    const questionText = formatQuestionCommentWithThreadId(
      "worker-1",
      clarification,
      "thread-123",
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-6",
          title: "Resume fallback task",
          description: "Fallback after resume failure",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "waiting_for_answer",
        },
      ],
      {
        "DEV-6": [
          {
            id: "1",
            text: questionText,
            createdAt: "2026-03-10T11:00:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(questionText),
          },
          {
            id: "2",
            text: "/resume B",
            createdAt: "2026-03-10T11:05:00.000Z",
            isSystem: false,
          },
          {
            id: "3",
            text: formatStatusComment(
              "worker-1",
              "waiting_for_answer",
              "Waiting for explicit /resume command after clarification.",
              "clarification",
            ),
            createdAt: "2026-03-10T11:06:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment(
                "worker-1",
                "waiting_for_answer",
                "Waiting for explicit /resume command after clarification.",
                "clarification",
              ),
            ),
          },
        ],
      },
    );
    const git = new FakeGitService();
    const codex = new FakeCodexRunner(
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "", stderr: "", exitCode: 0 },
            finalMessage: "Fresh session fallback",
          };
        },
      ],
      [
        () => ({
          process: { stdout: "", stderr: "resume failed", exitCode: 1 },
        }),
      ],
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      git,
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(codex.resumeCalls).toHaveLength(1);
    expect(codex.initialCalls).toHaveLength(1);
  });

  it("reuses the current thread for validation fix attempts after analysis", async () => {
    const tempDir = createTempDir();
    const failOnceScriptPath = join(tempDir, "fail-once.cjs");
    const lintScriptPath = join(tempDir, "lint.cjs");
    writeFileSync(
      failOnceScriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const marker = path.join(process.cwd(), '.test-once-marker');",
        "if (!fs.existsSync(marker)) {",
        "  fs.writeFileSync(marker, '1', 'utf8');",
        "  console.error('test failed once');",
        "  process.exit(1);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(lintScriptPath, "process.exit(0);\n", "utf8");

    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-7",
          title: "Fix in same session",
          description: "Keep the same thread while fixing tests",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "open",
        },
      ],
      { "DEV-7": [] },
    );
    const git = new FakeGitService();
    const codex = new FakeCodexRunner(
      [
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage: "READY_FOR_IMPLEMENTATION",
          threadId: "thread-fix-1",
        }),
      ],
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "", stderr: "", exitCode: 0 },
            finalMessage: "Initial implementation",
            threadId: "thread-fix-1",
          };
        },
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage: "Applied fix",
          threadId: "thread-fix-1",
        }),
      ],
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(tempDir, {
        testCommand: `node "${failOnceScriptPath}"`,
        lintCommand: `node "${lintScriptPath}"`,
      }),
      tracker,
      git,
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(codex.resumeCalls).toHaveLength(2);
    expect(codex.resumeCalls[0]?.threadId).toBe("thread-fix-1");
    expect(codex.resumeCalls[1]?.threadId).toBe("thread-fix-1");
    expect(codex.resumeCalls[1]?.prompt).toContain("Quality gate \"Tests\" (tests)");
    expect(codex.resumeCalls[1]?.prompt).toContain(`node "${failOnceScriptPath}"`);
    expect(codex.resumeCalls[1]?.prompt).toContain("test failed once");
  });

  it("does not resume failed tasks parked in waiting state for manual recovery", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-8",
          title: "Failed task",
          description: "Should not resume",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "waiting_for_answer",
        },
      ],
      {
        "DEV-8": [
          {
            id: "1",
            text: formatStatusComment(
              "worker-1",
              "waiting_for_answer",
              "Waiting for manual intervention after automation failure.",
              "failure_recovery",
            ),
            createdAt: "2026-03-10T11:00:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment(
                "worker-1",
                "waiting_for_answer",
                "Waiting for manual intervention after automation failure.",
                "failure_recovery",
              ),
            ),
          },
        ],
      },
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      new FakeGitService(),
      new FakeGitLabService(),
      new FakeCodexRunner([]),
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("idle");
  });

  it("stops the polling loop on SIGTERM without waiting for the poll interval", async () => {
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd(), {
        pollIntervalMinutes: 60,
        pollIntervalMs: 60 * 60 * 1000,
      }),
      new FakeTrackerClient([], {}),
      new FakeGitService(),
      new FakeGitLabService(),
      new FakeCodexRunner([]),
      new Logger(),
    );

    const running = orchestrator.runForever();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.emit("SIGTERM", "SIGTERM");

    await expect(running).resolves.toBeUndefined();
  });

  it("falls back to waiting_for_answer with failure_recovery when failed transition is unavailable", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-9",
          title: "Broken git auth",
          description: "Should move to manual recovery fallback",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "open",
        },
      ],
      { "DEV-9": [] },
    );
    tracker.transition = async (issueKey: string, targetStatus: LogicalStatus): Promise<void> => {
      tracker.transitions.push({ issueKey, target: targetStatus });
      if (targetStatus === "failed") {
        throw new Error("No tracker transition found for logical status failed");
      }
      const issue = tracker.issues.find((entry) => entry.key === issueKey);
      if (issue) {
        issue.logicalStatus = targetStatus;
      }
    };

    const git = new FakeGitService();
    git.checkoutTaskBranch = async () => {
      throw new Error("git auth failed");
    };
    const codex = new FakeCodexRunner([
      () => ({
        process: { stdout: "", stderr: "", exitCode: 0 },
        finalMessage: "READY_FOR_IMPLEMENTATION",
        threadId: "thread-failure-1",
      }),
    ]);
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      git,
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(tracker.transitions).toEqual([
      { issueKey: "DEV-9", target: "in_progress" },
      { issueKey: "DEV-9", target: "failed" },
      { issueKey: "DEV-9", target: "waiting_for_answer" },
    ]);
    expect(
      tracker.addedComments.some((entry) => entry.text.includes("Automation failed for DEV-9")),
    ).toBe(true);
    expect(
      tracker.addedComments.some((entry) => entry.text.includes("failure_recovery")),
    ).toBe(true);
  });

  it("surfaces commit diagnostics when publication fails during git commit", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-10",
          title: "Commit failure",
          description: "Surface commit diagnostics",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "open",
        },
      ],
      { "DEV-10": [] },
    );
    const git = new FakeGitService();
    git.commit = async () => {
      throw new Error(
        "Git commit failed with exit code 1.\n\nRepository hooks were enabled for this worker commit. Set GIT_COMMIT_NO_VERIFY=true to bypass repository hooks and rely on TEST_COMMAND/LINT_COMMAND instead.\n\nhusky - pre-commit script failed",
      );
    };
    const codex = new FakeCodexRunner(
      [
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage: "READY_FOR_IMPLEMENTATION",
          threadId: "thread-commit-failure",
        }),
      ],
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "", stderr: "", exitCode: 0 },
            finalMessage: "Implementation complete",
            threadId: "thread-commit-failure",
          };
        },
      ],
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd(), { gitCommitNoVerify: false }),
      tracker,
      git,
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(tracker.transitions).toEqual([
      { issueKey: "DEV-10", target: "in_progress" },
      { issueKey: "DEV-10", target: "failed" },
    ]);
    expect(
      tracker.addedComments.some((entry) =>
        entry.text.includes("Set GIT_COMMIT_NO_VERIFY=true to bypass repository hooks"),
      ),
    ).toBe(true);
  });

  it("loads the configured target issue instead of scanning the queue", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-TARGET",
          title: "Target task",
          description: "Process only this issue",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "open",
        },
        {
          id: "2",
          key: "DEV-QUEUE",
          title: "Queue task",
          description: "Should not be scanned",
          createdAt: "2026-03-10T10:02:00.000Z",
          logicalStatus: "open",
        },
      ],
      { "DEV-TARGET": [] },
    );
    const git = new FakeGitService();
    const codex = new FakeCodexRunner(
      [
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage: "READY_FOR_IMPLEMENTATION",
          threadId: "thread-target",
        }),
      ],
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "", stderr: "", exitCode: 0 },
            finalMessage: "Implementation complete",
            threadId: "thread-target",
          };
        },
      ],
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd(), {
        targetIssueKey: "DEV-TARGET",
        runOnce: true,
      }),
      tracker,
      git,
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(tracker.getIssueCalls).toEqual(["DEV-TARGET"]);
    expect(tracker.candidateIssueLookups).toBe(0);
    expect(tracker.ownedIssueLookups).toBe(0);
    expect(git.commits).toEqual(["feat: implement DEV-TARGET"]);
  });

  it("does not process a target issue locked by another worker", async () => {
    const lockComment = formatStatusComment(
      "worker-2",
      "in_progress",
      "Started elsewhere.",
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-LOCKED",
          title: "Locked task",
          description: "Should wait",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "in_progress",
        },
      ],
      {
        "DEV-LOCKED": [
          {
            id: "1",
            text: lockComment,
            createdAt: "2026-03-10T10:01:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(lockComment),
          },
        ],
      },
    );
    const codex = new FakeCodexRunner([]);
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd(), { targetIssueKey: "DEV-LOCKED" }),
      tracker,
      new FakeGitService(),
      new FakeGitLabService(),
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("waiting");
    expect(codex.initialCalls).toHaveLength(0);
    expect(tracker.transitions).toEqual([]);
    expect(tracker.candidateIssueLookups).toBe(0);
  });

  it("does not create a duplicate merge request for a target issue already in review", async () => {
    const mrComment = formatMergeRequestComment(
      "worker-1",
      "https://gitlab.example.com/project/-/merge_requests/1",
      "feature/ai-task-DEV-REVIEW",
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-REVIEW",
          title: "Review task",
          description: "Already published",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "review",
        },
      ],
      {
        "DEV-REVIEW": [
          {
            id: "1",
            text: mrComment,
            createdAt: "2026-03-10T10:02:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(mrComment),
          },
        ],
      },
    );
    const gitlab = new FakeGitLabService();
    gitlab.openMergeRequestsByBranch["feature/ai-task-DEV-REVIEW"] = {
      id: 1,
      iid: 1,
      url: "https://gitlab.example.com/project/-/merge_requests/1",
      title: "[AI] DEV-REVIEW implementation",
      sourceBranch: "feature/ai-task-DEV-REVIEW",
      targetBranch: "main",
    };
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd(), { targetIssueKey: "DEV-REVIEW" }),
      tracker,
      new FakeGitService(),
      gitlab,
      new FakeCodexRunner([]),
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("idle");
    expect(gitlab.findCalls).toEqual(["feature/ai-task-DEV-REVIEW"]);
    expect(gitlab.createCalls).toEqual([]);
    expect(tracker.transitions).toEqual([]);
  });

  it("continues queue scanning when an owned review issue has no pending feedback", async () => {
    const reviewBranch = "feature/ai-task-DEV-REVIEW-IDLE";
    const mrComment = formatMergeRequestComment(
      "worker-1",
      "https://gitlab.example.com/project/-/merge_requests/2",
      reviewBranch,
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-REVIEW-IDLE",
          title: "Already in review",
          description: "No feedback yet",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "review",
        },
        {
          id: "2",
          key: "DEV-NEXT",
          title: "Next open task",
          description: "Process after idle review check",
          createdAt: "2026-03-10T10:02:00.000Z",
          logicalStatus: "open",
        },
      ],
      {
        "DEV-REVIEW-IDLE": [
          {
            id: "1",
            text: mrComment,
            createdAt: "2026-03-10T10:02:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(mrComment),
          },
        ],
        "DEV-NEXT": [],
      },
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    gitlab.openMergeRequestsByBranch[reviewBranch] = {
      id: 2,
      iid: 2,
      url: "https://gitlab.example.com/project/-/merge_requests/2",
      title: "[AI] DEV-REVIEW-IDLE implementation",
      sourceBranch: reviewBranch,
      targetBranch: "main",
    };
    const codex = new FakeCodexRunner(
      [
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage: "READY_FOR_IMPLEMENTATION",
          threadId: "thread-next",
        }),
      ],
      [
        () => {
          git.uncommittedChanges = true;
          git.diffFromBase = true;
          return {
            process: { stdout: "", stderr: "", exitCode: 0 },
            finalMessage: "Implementation complete",
            threadId: "thread-next",
          };
        },
      ],
    );
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
      { issueKey: "DEV-NEXT", target: "in_progress" },
      { issueKey: "DEV-NEXT", target: "review" },
    ]);
    expect(gitlab.findCalls).toContain(reviewBranch);
    expect(git.commits).toEqual(["feat: implement DEV-NEXT"]);
  });

  it("fixes unresolved review discussions, replies, and records processed metadata", async () => {
    const branch = "feature/ai-task-DEV-REVIEW-FIX";
    const mrComment = formatMergeRequestComment(
      "worker-1",
      "https://gitlab.example.com/project/-/merge_requests/17",
      branch,
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-REVIEW-FIX",
          title: "Fix review feedback",
          description: "Address the reviewer note",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "review",
        },
      ],
      {
        "DEV-REVIEW-FIX": [
          {
            id: "1",
            text: mrComment,
            createdAt: "2026-03-10T10:02:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(mrComment),
          },
        ],
      },
    );
    const git = new FakeGitService();
    git.currentBranch = branch;
    git.diffFromBase = true;
    const gitlab = new FakeGitLabService();
    gitlab.openMergeRequestsByBranch[branch] = {
      id: 17,
      iid: 17,
      url: "https://gitlab.example.com/project/-/merge_requests/17",
      title: "[AI] DEV-REVIEW-FIX implementation",
      sourceBranch: branch,
      targetBranch: "main",
    };
    gitlab.discussionsByIid[17] = [
      {
        id: "discussion-1",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 101,
            body: "Fix the null crash before merge.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-03-10T10:05:00.000Z",
            position: {
              newPath: "src/example.ts",
              newLine: 12,
            },
          },
          {
            id: 102,
            body: "Worker follow-up should be ignored.",
            authorUsername: "ai-worker",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-03-10T10:06:00.000Z",
            position: {
              newPath: "src/example.ts",
              newLine: 12,
            },
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner([
      () => {
        git.uncommittedChanges = true;
        return {
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage: "Handle null review feedback",
          threadId: "thread-review-fix",
        };
      },
    ]);
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd()),
      tracker,
      git,
      gitlab,
      codex,
      new Logger(),
    );

    const firstOutcome = await orchestrator.runOnce();
    const secondOutcome = await orchestrator.runOnce();

    expect(firstOutcome).toBe("processed");
    expect(secondOutcome).toBe("idle");
    expect(codex.initialCalls[0]).toContain("Fix the null crash before merge.");
    expect(codex.initialCalls[0]).not.toContain("Worker follow-up should be ignored.");
    expect(git.commits).toEqual(["fix: handle null review feedback DEV-REVIEW-FIX"]);
    expect(git.pushes).toEqual([branch]);
    expect(gitlab.replies).toHaveLength(1);
    expect(gitlab.replies[0]).toMatchObject({
      iid: 17,
      discussionId: "discussion-1",
    });
    expect(gitlab.replies[0]?.body).toContain("commit-1");
    expect(tracker.transitions).toEqual([
      { issueKey: "DEV-REVIEW-FIX", target: "in_progress" },
      { issueKey: "DEV-REVIEW-FIX", target: "review" },
    ]);
    expect(
      tracker.addedComments.some(
        (entry) =>
          entry.text.startsWith("AI REVIEW:") &&
          entry.text.includes('"processedDiscussionIds"') &&
          entry.text.includes("discussion-1") &&
          entry.text.includes("101") &&
          !entry.text.includes("102"),
      ),
    ).toBe(true);
  });

  it("surfaces missing target issues as a controlled failure", async () => {
    const tracker = new FakeTrackerClient([], {});
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd(), { targetIssueKey: "DEV-MISSING" }),
      tracker,
      new FakeGitService(),
      new FakeGitLabService(),
      new FakeCodexRunner([]),
      new Logger(),
    );

    await expect(orchestrator.runOnce()).rejects.toThrow(
      /Unable to load target issue DEV-MISSING/,
    );
    expect(tracker.candidateIssueLookups).toBe(0);
  });

  it("rejects target issues with unsupported statuses", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-DONE",
          title: "Done task",
          description: "Should not process",
          createdAt: "2026-03-10T10:01:00.000Z",
          logicalStatus: "done",
        },
      ],
      { "DEV-DONE": [] },
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(process.cwd(), { targetIssueKey: "DEV-DONE" }),
      tracker,
      new FakeGitService(),
      new FakeGitLabService(),
      new FakeCodexRunner([]),
      new Logger(),
    );

    await expect(orchestrator.runOnce()).rejects.toThrow(
      /unsupported logical status: done/,
    );
  });
});
