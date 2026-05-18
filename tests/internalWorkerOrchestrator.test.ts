import { describe, expect, it } from "vitest";

import { InternalWorkerOrchestrator } from "../src/domain/internalWorkerOrchestrator.js";
import {
  InMemoryTaskTrackerClient,
  type CreateTaskInput,
  type TaskActor,
} from "../src/domain/taskTracker/index.js";
import type {
  AppConfig,
  CodexExecution,
  CodexReviewRunOptions,
  CodexRunObserver,
  CodexRunOptions,
  CodexRunner,
  GitLabService,
  GitService,
  GlobalWorkerConfig,
  LogicalStatus,
  MergeRequestDiscussion,
  MergeRequestInfo,
  RepositoryProfile,
} from "../src/models/types.js";
import { TemporaryIntegrationError } from "../src/utils/errors.js";
import { Logger } from "../src/utils/logger.js";

const worker: TaskActor = { owner: "worker_agent", id: "worker-1" };
const human: TaskActor = { owner: "human", id: "user-1" };

const statusMap: AppConfig["trackerStatusMap"] = {
  open: { statuses: ["Open"] },
  in_progress: { statuses: ["In Progress"], transition: "start" },
  waiting_for_answer: { statuses: ["Waiting"], transition: "wait" },
  review: { statuses: ["Review"], transition: "review" },
  failed: { statuses: ["Failed"], transition: "fail" },
  done: { statuses: ["Done"], transition: "done" },
};

const profile: RepositoryProfile = {
  name: "developer",
  repoPath: process.cwd(),
  gitlabProjectId: "1",
  gitRemoteName: "origin",
  baseBranch: "main",
  queues: ["DEV"],
  tags: ["ai_dev"],
  testCommand: `node -e "process.exit(0)"`,
  lintCommand: `node -e "process.exit(0)"`,
};

const createAppConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  trackerToken: "tracker-token",
  trackerOrgHeader: "X-Cloud-Org-ID",
  trackerOrgId: "org-id",
  trackerDefaultQueue: "DEV",
  trackerTag: "ai_dev",
  trackerStatusMap: statusMap,
  trackerApiBaseUrl: "http://localhost:9999/v3",
  gitlabUrl: "https://gitlab.example.com",
  gitlabToken: "gitlab-token",
  gitlabProjectId: "1",
  gitRemoteName: "origin",
  gitRepositoryToken: "gitlab-token",
  gitRepositoryUsername: "oauth2",
  gitCommitNoVerify: true,
  repoPath: process.cwd(),
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
  testCommand: `node -e "process.exit(0)"`,
  lintCommand: `node -e "process.exit(0)"`,
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
  ...overrides,
});

const createGlobalConfig = (): GlobalWorkerConfig => ({
  workerId: "worker-1",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
  maxFixAttempts: 2,
  maxReviewFixAttempts: 2,
  gitRepositoryToken: "gitlab-token",
  gitRepositoryUsername: "oauth2",
  gitCommitNoVerify: true,
  tracker: {
    token: "tracker-token",
    orgHeader: "X-Cloud-Org-ID",
    orgId: "org-id",
    statusMap,
    apiBaseUrl: "http://localhost:9999/v3",
  },
  gitlab: {
    url: "https://gitlab.example.com",
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
    selfReviewEnabled: false,
    selfReviewMaxFixAttempts: 1,
  },
  coordination: {
    lockBackend: "none",
    lockTtlMs: 60_000,
    lockHeartbeatMs: 10_000,
  },
  priorityQueue: {
    manualOverrideTags: [],
    priorityWeights: {},
    tagBoosts: {},
    componentBoosts: {},
    deadlineBoost: { dueToday: 0, overdue: 0 },
    createdAtTieBreaker: "oldest",
  },
  repositories: [profile],
});

const baseTaskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  id: "internal-1",
  title: "Internal task",
  description: "Implement the task.",
  createdBy: human,
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  status: "ready",
  taskType: "unknown",
  acceptanceCriteria: ["Task is handled."],
  ...overrides,
});

const moveReadyTaskToReview = async (
  tracker: InMemoryTaskTrackerClient,
  taskId: string,
): Promise<void> => {
  await tracker.setStatus(taskId, "claimed", "Claimed for setup.");
  await tracker.setStatus(taskId, "analyzing", "Analyzing for setup.");
  await tracker.setStatus(taskId, "implementing", "Implementing for setup.");
  await tracker.setStatus(taskId, "validating", "Validating for setup.");
  await tracker.setStatus(taskId, "review", "Review for setup.");
};

class FakeGitLabService implements GitLabService {
  readonly getCalls: number[] = [];
  readonly findAllCalls: string[] = [];
  readonly findOpenCalls: string[] = [];
  readonly createCalls: string[] = [];
  mergeRequestsByIid: Record<number, MergeRequestInfo> = {};
  mergeRequestsByBranch: Record<string, MergeRequestInfo> = {};
  throwTemporary = false;

  async checkReadAccess(): Promise<void> {}

  async checkMergeRequestWriteAccess(sourceBranch: string): Promise<MergeRequestInfo> {
    return this.createMergeRequest({
      sourceBranch,
      targetBranch: "main",
      title: `[AI Preflight] ${sourceBranch}`,
    });
  }

  async findMergeRequestByBranch(sourceBranch: string): Promise<MergeRequestInfo | null> {
    this.findAllCalls.push(sourceBranch);
    if (this.throwTemporary) {
      throw new TemporaryIntegrationError("GitLab temporarily unavailable.");
    }
    return this.mergeRequestsByBranch[sourceBranch] ?? null;
  }

  async getMergeRequest(iid: number): Promise<MergeRequestInfo | null> {
    this.getCalls.push(iid);
    if (this.throwTemporary) {
      throw new TemporaryIntegrationError("GitLab temporarily unavailable.");
    }
    return this.mergeRequestsByIid[iid] ?? null;
  }

  async findOpenMergeRequestByBranch(sourceBranch: string): Promise<MergeRequestInfo | null> {
    this.findOpenCalls.push(sourceBranch);
    return null;
  }

  async getMergeRequestDiscussions(_iid: number): Promise<MergeRequestDiscussion[]> {
    return [];
  }

  async replyToDiscussion(_iid: number, _discussionId: string, _body: string): Promise<void> {}

  async getCurrentUser(): Promise<{ username: string }> {
    return { username: "ai-worker" };
  }

  async createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
  }): Promise<MergeRequestInfo> {
    this.createCalls.push(input.sourceBranch);
    return {
      id: 100,
      iid: 100,
      url: "https://gitlab.example.com/project/-/merge_requests/100",
      title: input.title,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      state: "opened",
    };
  }
}

class FakeGitService implements GitService {
  currentBranch = "main";
  hasUncommittedChanges = false;
  hasCommittedDiff = false;
  commits: string[] = [];

  async assertRepositoryReady(): Promise<void> {}

  async getCurrentBranch(): Promise<string> {
    return this.currentBranch;
  }

  async hasChanges(): Promise<boolean> {
    return this.hasUncommittedChanges;
  }

  async hasDiffFromBase(): Promise<boolean> {
    return this.hasCommittedDiff;
  }

  async syncBaseBranch(): Promise<void> {
    this.currentBranch = "main";
  }

  async checkoutBranch(branch: string): Promise<string> {
    this.currentBranch = branch;
    return branch;
  }

  async checkoutTaskBranch(issueKey: string): Promise<string> {
    this.currentBranch = `feature/ai-task-${issueKey}`;
    return this.currentBranch;
  }

  async getDiffFromBase(): Promise<string> {
    return "diff";
  }

  async getChangedFilesFromBase(): Promise<string[]> {
    return ["src/example.ts"];
  }

  async getHeadSha(): Promise<string> {
    return this.commits.length > 0 ? `commit-${this.commits.length}` : "base";
  }

  async commit(message: string): Promise<void> {
    this.commits.push(message);
    this.hasUncommittedChanges = false;
    this.hasCommittedDiff = true;
  }

  async push(_branch: string): Promise<void> {}
}

class FakeCodexRunner implements CodexRunner {
  initialCalls = 0;
  resumeCalls = 0;

  constructor(private readonly git?: FakeGitService) {}

  async runInitial(
    _prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexRunOptions,
  ): Promise<CodexExecution> {
    this.initialCalls += 1;
    return {
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage: "READY_FOR_IMPLEMENTATION",
      threadId: "thread-internal",
    };
  }

  async runFix(
    _prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexRunOptions,
  ): Promise<CodexExecution> {
    return { process: { stdout: "", stderr: "", exitCode: 0 } };
  }

  async runResume(
    _threadId: string,
    _prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexRunOptions,
  ): Promise<CodexExecution> {
    this.resumeCalls += 1;
    if (this.git) {
      this.git.hasUncommittedChanges = true;
    }
    return {
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage: "Implementation complete.",
      threadId: "thread-internal",
    };
  }

  async runReview(
    _prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexReviewRunOptions,
  ): Promise<CodexExecution> {
    return {
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage:
        'AI_SELF_REVIEW: {"status":"pass","summary":"No blocking issues.","findings":[]}',
    };
  }
}

const createOrchestrator = (
  tracker: InMemoryTaskTrackerClient,
  gitlab: FakeGitLabService,
  codex: FakeCodexRunner = new FakeCodexRunner(),
  git: FakeGitService = new FakeGitService(),
): InternalWorkerOrchestrator =>
  new InternalWorkerOrchestrator(
    createGlobalConfig(),
    [
      {
        profile,
        config: createAppConfig(),
        git,
        gitlab,
        codex,
      },
    ],
    tracker,
    new Logger(),
  );

describe("InternalWorkerOrchestrator review reconciliation", () => {
  it("marks review tasks done when the latest merge request is merged", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-merged" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-merged",
      outcome: "created",
      mergeRequest: {
        id: 101,
        iid: 17,
        url: "https://gitlab.example.com/project/-/merge_requests/17",
        title: "[AI] internal-merged implementation",
        sourceBranch: "feature/ai-task-internal-merged",
        targetBranch: "main",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[17] = {
      id: 101,
      iid: 17,
      url: "https://gitlab.example.com/project/-/merge_requests/17",
      title: "[AI] internal-merged implementation",
      sourceBranch: "feature/ai-task-internal-merged",
      targetBranch: "main",
      state: "merged",
      mergedAt: "2026-05-15T10:30:00.000Z",
    };
    const codex = new FakeCodexRunner();
    const orchestrator = createOrchestrator(tracker, gitlab, codex);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("done");
    expect(updated.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_completed",
          source: "gitlab_sync",
          message: "Merge request is merged; task marked done.",
        }),
      ]),
    );
    expect(codex.initialCalls).toBe(0);
    expect(gitlab.getCalls).toEqual([17]);
  });

  it("moves review tasks to awaiting_human when the merge request was closed without merge", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-closed" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-closed",
      outcome: "created",
      mergeRequest: {
        id: 102,
        iid: 18,
        url: "https://gitlab.example.com/project/-/merge_requests/18",
        title: "[AI] internal-closed implementation",
        sourceBranch: "feature/ai-task-internal-closed",
        targetBranch: "main",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[18] = {
      id: 102,
      iid: 18,
      url: "https://gitlab.example.com/project/-/merge_requests/18",
      title: "[AI] internal-closed implementation",
      sourceBranch: "feature/ai-task-internal-closed",
      targetBranch: "main",
      state: "closed",
      closedAt: "2026-05-15T10:30:00.000Z",
    };
    const orchestrator = createOrchestrator(tracker, gitlab);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("awaiting_human");
    expect(updated.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "manual_hold",
          source: "gitlab_sync",
          message: "Merge request was closed without merge; human decision required.",
        }),
      ]),
    );
  });

  it("continues normal ready task claiming when review reconciliation has no terminal MR", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const reviewTask = await tracker.createTask(baseTaskInput({ id: "internal-open" }));
    await tracker.recordMergeRequest(reviewTask.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-open",
      outcome: "created",
      mergeRequest: {
        id: 103,
        iid: 19,
        url: "https://gitlab.example.com/project/-/merge_requests/19",
        title: "[AI] internal-open implementation",
        sourceBranch: "feature/ai-task-internal-open",
        targetBranch: "main",
      },
    });
    await moveReadyTaskToReview(tracker, reviewTask.id);
    await tracker.createTask(baseTaskInput({ id: "internal-ready" }));

    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[19] = {
      id: 103,
      iid: 19,
      url: "https://gitlab.example.com/project/-/merge_requests/19",
      title: "[AI] internal-open implementation",
      sourceBranch: "feature/ai-task-internal-open",
      targetBranch: "main",
      state: "opened",
    };
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const reviewUpdated = await tracker.getTask(reviewTask.id);
    const readyUpdated = await tracker.getTask("internal-ready");

    expect(outcome).toBe("processed");
    expect(reviewUpdated.status).toBe("review");
    expect(readyUpdated.status).toBe("review");
    expect(codex.initialCalls).toBe(1);
    expect(codex.resumeCalls).toBe(1);
  });
});
