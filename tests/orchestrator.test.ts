import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerOrchestrator } from "../src/domain/orchestrator.js";
import {
  formatQuestionCommentWithThreadId,
  formatStatusComment,
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
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

const cleanupPaths: string[] = [];

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
  repoPath,
  baseBranch: "main",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  codexHome: "/codex-home",
  codexCliCommand: "codex",
  codexCliArgs: [],
  codexSandbox: "workspace-write",
  codexExecArgs: [],
  codexQuestionMarker: "AI_QUESTION:",
  maxFixAttempts: 2,
  workerId: "worker-1",
  testCommand: `node -e "process.exit(0)"`,
  lintCommand: `node -e "process.exit(0)"`,
  runOnce: false,
  ...overrides,
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
  readonly resumeCalls: Array<{ threadId: string; prompt: string }> = [];

  constructor(
    private readonly onInitial: () => CodexExecution | Promise<CodexExecution>,
    private readonly onResume: (
      threadId: string,
      prompt: string,
    ) => CodexExecution | Promise<CodexExecution> = () => ({
      process: {
        stdout: "",
        stderr: "",
        exitCode: 1,
      },
    }),
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

  runResume(threadId: string, prompt: string): Promise<CodexExecution> {
    this.resumeCalls.push({ threadId, prompt });
    return Promise.resolve(this.onResume(threadId, prompt));
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
        stdout: "",
        stderr: "",
        exitCode: 0,
      },
      finalMessage: "AI_QUESTION: Which API variant should be used?",
      question: "Which API variant should be used?",
      threadId: "thread-123",
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
    expect(
      tracker.addedComments.some((entry) => entry.text.includes("threadId=thread-123")),
    ).toBe(true);
  });

  it("resumes the prior Codex session after a human answer", async () => {
    const questionText = formatQuestionCommentWithThreadId(
      "worker-1",
      "Which API variant should be used?",
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
              "Waiting for human clarification.",
            ),
            createdAt: "2026-03-10T11:06:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment(
                "worker-1",
                "waiting_for_answer",
                "Waiting for human clarification.",
              ),
            ),
          },
        ],
      },
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    const codex = new FakeCodexRunner(
      () => ({
        process: {
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
      }),
      () => {
        git.uncommittedChanges = true;
        git.diffFromBase = true;
        return {
          process: {
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
          finalMessage: "Resumed successfully",
        };
      },
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
    expect(codex.resumeCalls).toHaveLength(1);
    expect(codex.resumeCalls[0]?.threadId).toBe("thread-123");
    expect(codex.resumeCalls[0]?.prompt).toContain("Use the v2 endpoint.");
  });

  it("falls back to a fresh Codex session when resume fails", async () => {
    const questionText = formatQuestionCommentWithThreadId(
      "worker-1",
      "Which API variant should be used?",
      "thread-123",
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-5",
          title: "Resume fallback task",
          description: "Fallback after resume failure",
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
            text: "Use the v2 endpoint.",
            createdAt: "2026-03-10T11:05:00.000Z",
            isSystem: false,
          },
          {
            id: "3",
            text: formatStatusComment(
              "worker-1",
              "waiting_for_answer",
              "Waiting for human clarification.",
            ),
            createdAt: "2026-03-10T11:06:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(
              formatStatusComment(
                "worker-1",
                "waiting_for_answer",
                "Waiting for human clarification.",
              ),
            ),
          },
        ],
      },
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    let initialCalls = 0;
    const codex = new FakeCodexRunner(
      () => {
        initialCalls += 1;
        git.uncommittedChanges = true;
        git.diffFromBase = true;
        return {
          process: {
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
          finalMessage: "Fresh session fallback",
        };
      },
      () => ({
        process: {
          stdout: "",
          stderr: "resume failed",
          exitCode: 1,
        },
      }),
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
    expect(codex.resumeCalls).toHaveLength(1);
    expect(initialCalls).toBe(1);
  });

  it("reuses the current thread for validation fix attempts", async () => {
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
        "  process.exit(1);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      lintScriptPath,
      "process.exit(0);\n",
      "utf8",
    );
    const tracker = new FakeTrackerClient(
      [
        {
          id: "1",
          key: "DEV-6",
          title: "Fix in same session",
          description: "Keep the same thread while fixing tests",
          createdAt: "2026-03-10T11:00:00.000Z",
          logicalStatus: "open",
        },
      ],
      {
        "DEV-6": [],
      },
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    let fixAttempt = 0;
    const codex = new FakeCodexRunner(
      () => {
        git.uncommittedChanges = true;
        git.diffFromBase = true;
        return {
          process: {
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
          finalMessage: "Initial implementation",
          threadId: "thread-fix-1",
        };
      },
      () => {
        fixAttempt += 1;
        if (fixAttempt === 1) {
          return {
            process: {
              stdout: "",
              stderr: "",
              exitCode: 0,
            },
            finalMessage: "Applied fix",
            threadId: "thread-fix-1",
          };
        }

        return {
          process: {
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
        };
      },
    );
    const orchestrator = new WorkerOrchestrator(
      createConfig(tempDir, {
        testCommand: `node "${failOnceScriptPath}"`,
        lintCommand: `node "${lintScriptPath}"`,
      }),
      tracker,
      git,
      gitlab,
      codex,
      new Logger(),
    );

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(codex.resumeCalls).toHaveLength(1);
    expect(codex.resumeCalls[0]?.threadId).toBe("thread-fix-1");
  });
});
