import { describe, expect, it, vi } from "vitest";

import { InternalWorkerOrchestrator } from "../src/domain/internalWorkerOrchestrator.js";
import {
  InMemoryTaskTrackerClient,
  type CreateTaskInput,
  type TaskActor,
} from "../src/domain/taskTracker/index.js";
import {
  InMemoryYandexBridgeStore,
  YANDEX_TRACKER_PROVIDER,
  YandexBridge,
  type YandexBridgeExternalSource,
} from "../src/integrations/yandexBridge/index.js";
import type {
  AppConfig,
  CodexExecution,
  CodexReviewRunOptions,
  CodexRunObserver,
  CodexRunOptions,
  CodexRunner,
  ExportDigestInput,
  ExternalIssueSnapshot,
  ExternalTransitionInput,
  ImportCandidatesInput,
  GitLabService,
  GitService,
  GlobalWorkerConfig,
  LogicalStatus,
  MergeRequestDiscussion,
  MergeRequestInfo,
  RepositoryProfile,
} from "../src/models/types.js";
import { PermanentTaskError, TemporaryIntegrationError } from "../src/utils/errors.js";
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
  discussionCalls: number[] = [];
  replies: Array<{ iid: number; discussionId: string; body: string }> = [];
  mergeRequestsByIid: Record<number, MergeRequestInfo> = {};
  mergeRequestsByBranch: Record<string, MergeRequestInfo> = {};
  discussionsByIid: Record<number, MergeRequestDiscussion[]> = {};
  discussionResponsesByIid: Record<number, MergeRequestDiscussion[][]> = {};
  temporaryReplyFailures = 0;
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

  async getMergeRequestDiscussions(iid: number): Promise<MergeRequestDiscussion[]> {
    this.discussionCalls.push(iid);
    const queuedResponses = this.discussionResponsesByIid[iid];
    const queued = queuedResponses?.shift();
    if (queued) {
      return queued;
    }
    return this.discussionsByIid[iid] ?? [];
  }

  async replyToDiscussion(iid: number, discussionId: string, body: string): Promise<void> {
    if (this.temporaryReplyFailures > 0) {
      this.temporaryReplyFailures -= 1;
      throw new TemporaryIntegrationError("GitLab reply temporarily unavailable.");
    }
    this.replies.push({ iid, discussionId, body });
  }

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
  checkoutError?: Error;
  commits: string[] = [];
  pushes: string[] = [];

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
    if (this.checkoutError) {
      throw this.checkoutError;
    }
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

  async push(branch: string): Promise<void> {
    this.pushes.push(branch);
  }
}

class FakeCodexRunner implements CodexRunner {
  initialCalls = 0;
  resumeCalls = 0;
  initialPrompts: string[] = [];

  constructor(private readonly git?: FakeGitService) {}

  async runInitial(
    _prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexRunOptions,
  ): Promise<CodexExecution> {
    this.initialCalls += 1;
    this.initialPrompts.push(_prompt);
    if (_prompt.includes("Unresolved reviewer comments:")) {
      if (this.git) {
        this.git.hasUncommittedChanges = true;
      }
      return {
        process: { stdout: "", stderr: "", exitCode: 0 },
        finalMessage: "Fixed max.ru bot link handling.",
        threadId: "thread-internal-review-fix",
      };
    }
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

class FakeYandexSource implements YandexBridgeExternalSource {
  readonly transitions: ExternalTransitionInput[] = [];
  readonly digests: ExportDigestInput[] = [];

  async importCandidates(_input: ImportCandidatesInput): Promise<ExternalIssueSnapshot[]> {
    return [];
  }

  async exportDigest(input: ExportDigestInput): Promise<void> {
    this.digests.push(input);
  }

  async transitionExternal(input: ExternalTransitionInput): Promise<void> {
    this.transitions.push(input);
  }

  async getComments() {
    return [];
  }
}

const createOrchestrator = (
  tracker: InMemoryTaskTrackerClient,
  gitlab: FakeGitLabService,
  codex: FakeCodexRunner = new FakeCodexRunner(),
  git: FakeGitService = new FakeGitService(),
  yandexBridges: YandexBridge[] = [],
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
    undefined,
    undefined,
    yandexBridges,
  );

describe("InternalWorkerOrchestrator polling lifecycle", () => {
  it("continues polling after a transient Yandex import failure", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const importCandidates = vi
      .fn<YandexBridge["importCandidates"]>()
      .mockRejectedValueOnce(new TemporaryIntegrationError("Tracker temporarily unavailable."))
      .mockImplementationOnce(async () => {
        process.emit("SIGTERM", "SIGTERM");
        return { created: 0, updated: 0, commentsImported: 0 };
      });
    const bridge = { importCandidates } as unknown as YandexBridge;
    const orchestrator = new InternalWorkerOrchestrator(
      {
        ...createGlobalConfig(),
        pollIntervalMinutes: 0,
        pollIntervalMs: 1,
      },
      [
        {
          profile,
          config: createAppConfig(),
          git: new FakeGitService(),
          gitlab: new FakeGitLabService(),
          codex: new FakeCodexRunner(),
        },
      ],
      tracker,
      new Logger(),
      undefined,
      undefined,
      [bridge],
    );

    await expect(orchestrator.runForever()).resolves.toBeUndefined();
    expect(importCandidates).toHaveBeenCalledTimes(2);
  });
});

describe("InternalWorkerOrchestrator Yandex bridge status sync", () => {
  it("syncs Yandex-sourced internal tasks to in_progress immediately after claim", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    await tracker.createTask(
      baseTaskInput({
        id: "yt_DEV-START",
        source: {
          kind: "external",
          provider: YANDEX_TRACKER_PROVIDER,
          externalKey: "DEV-START",
        },
        externalRefs: [
          {
            provider: YANDEX_TRACKER_PROVIDER,
            externalKey: "DEV-START",
            businessStatus: "open",
            lastSeenAt: "2026-05-19T00:00:00.000Z",
          },
        ],
      }),
    );
    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    const codex = new FakeCodexRunner(git);
    const source = new FakeYandexSource();
    const bridge = new YandexBridge({
      taskTracker: tracker,
      source,
      store: new InMemoryYandexBridgeStore(),
      repository: {
        repositoryName: "developer",
        repoPathKey: "developer",
        baseBranch: "main",
        queues: ["DEV"],
        tags: ["ai_dev"],
      },
      workerId: "worker-1",
    });
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git, [bridge]);

    const outcome = await orchestrator.runOnce();

    expect(outcome).toBe("processed");
    expect(source.transitions.map((transition) => transition.targetBusinessStatus)).toEqual([
      "in_progress",
      "review",
    ]);
    expect(source.digests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalKey: "DEV-START",
          digest: expect.stringContaining("AI DIGEST:"),
        }),
      ]),
    );
  });
});

describe("InternalWorkerOrchestrator review reconciliation", () => {
  it("moves review tasks to human_testing when the latest merge request is merged", async () => {
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
    expect(updated.status).toBe("human_testing");
    expect(updated.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "human_testing_started",
          source: "gitlab_sync",
          message: "Merge request is merged; task is waiting for human testing.",
          payload: expect.objectContaining({
            mergeRequestIid: 17,
            mergeRequestUrl: "https://gitlab.example.com/project/-/merge_requests/17",
          }),
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
    gitlab.discussionsByIid[19] = [];
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
    expect(gitlab.discussionCalls).toEqual([19]);
  });

  it("fixes unresolved GitLab review discussions for internal review tasks", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-review-fix" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-review-fix",
      outcome: "created",
      mergeRequest: {
        id: 104,
        iid: 20,
        url: "https://gitlab.example.com/project/-/merge_requests/20",
        title: "[AI] internal-review-fix implementation",
        sourceBranch: "feature/ai-task-internal-review-fix",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);

    const git = new FakeGitService();
    git.hasCommittedDiff = true;
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[20] = {
      id: 104,
      iid: 20,
      url: "https://gitlab.example.com/project/-/merge_requests/20",
      title: "[AI] internal-review-fix implementation",
      sourceBranch: "feature/ai-task-internal-review-fix",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionsByIid[20] = [
      {
        id: "discussion-1",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24737,
            body: "Please account for max.ru bot links.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:14:12.667Z",
            position: { newPath: "src/example.ts", newLine: 12 },
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(codex.initialPrompts.at(-1)).toContain("Please account for max.ru bot links.");
    expect(codex.initialPrompts.at(-1)).toContain("Unresolved reviewer comments:");
    expect(git.commits).toEqual(["feat: fixed max.ru bot link handling internal-review-fix"]);
    expect(git.pushes).toEqual(["feature/ai-task-internal-review-fix"]);
    expect(gitlab.discussionCalls).toEqual([20, 20]);
    expect(gitlab.replies).toHaveLength(1);
    expect(gitlab.replies[0]).toMatchObject({
      iid: 20,
      discussionId: "discussion-1",
    });
    expect(gitlab.replies[0]?.body).toContain("commit-1");
    expect(updated.reviewMetadata.at(-1)?.metadata).toMatchObject({
      mergeRequestIid: 20,
      processedDiscussionIds: ["discussion-1"],
      processedNoteIds: [24737],
      lastFixCommit: "commit-1",
    });
    expect(updated.agentRuns.some((run) => run.stage === "review_fix")).toBe(true);
  });

  it("does not run Codex when pending feedback disappears after the review claim", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-review-race" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-review-race",
      outcome: "created",
      mergeRequest: {
        id: 107,
        iid: 23,
        url: "https://gitlab.example.com/project/-/merge_requests/23",
        title: "[AI] internal-review-race implementation",
        sourceBranch: "feature/ai-task-internal-review-race",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);

    const git = new FakeGitService();
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[23] = {
      id: 107,
      iid: 23,
      url: "https://gitlab.example.com/project/-/merge_requests/23",
      title: "[AI] internal-review-race implementation",
      sourceBranch: "feature/ai-task-internal-review-race",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionResponsesByIid[23] = [
      [
        {
          id: "discussion-race",
          individualNote: false,
          resolved: false,
          notes: [
            {
              id: 24770,
              body: "This feedback was fixed by another worker.",
              authorUsername: "reviewer",
              system: false,
              resolvable: true,
              resolved: false,
              createdAt: "2026-05-18T15:40:00.000Z",
            },
          ],
        },
      ],
      [],
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("idle");
    expect(updated.status).toBe("review");
    expect(codex.initialCalls).toBe(0);
    expect(gitlab.discussionCalls).toEqual([23, 23]);
    expect(gitlab.replies).toEqual([]);
    expect(updated.reviewMetadata).toHaveLength(0);
  });

  it("recovers stale fixing_review tasks without an active lease", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-stale-review-fix" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-stale-review-fix",
      outcome: "created",
      mergeRequest: {
        id: 105,
        iid: 21,
        url: "https://gitlab.example.com/project/-/merge_requests/21",
        title: "[AI] internal-stale-review-fix implementation",
        sourceBranch: "feature/ai-task-internal-stale-review-fix",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);
    await tracker.setStatus(task.id, "fixing_review", "Simulate crashed review fix.");

    const git = new FakeGitService();
    git.hasCommittedDiff = true;
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[21] = {
      id: 105,
      iid: 21,
      url: "https://gitlab.example.com/project/-/merge_requests/21",
      title: "[AI] internal-stale-review-fix implementation",
      sourceBranch: "feature/ai-task-internal-stale-review-fix",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionsByIid[21] = [
      {
        id: "discussion-stale",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24750,
            body: "Retry stale review feedback.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:30:00.000Z",
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(gitlab.replies).toHaveLength(1);
    expect(updated.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_status_changed",
          payload: expect.objectContaining({ from: "fixing_review", to: "review" }),
        }),
      ]),
    );
  });

  it("keeps internal review tasks retryable when replying to GitLab temporarily fails", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-review-retry" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-review-retry",
      outcome: "created",
      mergeRequest: {
        id: 106,
        iid: 22,
        url: "https://gitlab.example.com/project/-/merge_requests/22",
        title: "[AI] internal-review-retry implementation",
        sourceBranch: "feature/ai-task-internal-review-retry",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);

    const git = new FakeGitService();
    git.hasCommittedDiff = true;
    const gitlab = new FakeGitLabService();
    gitlab.temporaryReplyFailures = 1;
    gitlab.mergeRequestsByIid[22] = {
      id: 106,
      iid: 22,
      url: "https://gitlab.example.com/project/-/merge_requests/22",
      title: "[AI] internal-review-retry implementation",
      sourceBranch: "feature/ai-task-internal-review-retry",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionsByIid[22] = [
      {
        id: "discussion-retry",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24760,
            body: "Retry after temporary GitLab failure.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:35:00.000Z",
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(gitlab.replies).toEqual([]);
    expect(updated.reviewMetadata).toHaveLength(0);
    expect(updated.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_status_changed",
          payload: expect.objectContaining({ to: "failed" }),
        }),
      ]),
    );
  });

  it("keeps internal review tasks retryable when checkout is blocked by another dirty branch", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "internal-review-dirty-branch" }));
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-internal-review-dirty-branch",
      outcome: "created",
      mergeRequest: {
        id: 108,
        iid: 24,
        url: "https://gitlab.example.com/project/-/merge_requests/24",
        title: "[AI] internal-review-dirty-branch implementation",
        sourceBranch: "feature/ai-task-internal-review-dirty-branch",
        targetBranch: "main",
        state: "opened",
      },
    });
    await moveReadyTaskToReview(tracker, task.id);

    const git = new FakeGitService();
    git.hasCommittedDiff = true;
    git.checkoutError = new PermanentTaskError(
      "Repository has uncommitted changes on ai/lazy-ai-agent-session; refusing to switch tasks.",
    );
    const gitlab = new FakeGitLabService();
    gitlab.mergeRequestsByIid[24] = {
      id: 108,
      iid: 24,
      url: "https://gitlab.example.com/project/-/merge_requests/24",
      title: "[AI] internal-review-dirty-branch implementation",
      sourceBranch: "feature/ai-task-internal-review-dirty-branch",
      targetBranch: "main",
      state: "opened",
    };
    gitlab.discussionsByIid[24] = [
      {
        id: "discussion-dirty-branch",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24780,
            body: "Retry after repository working tree is available.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:45:00.000Z",
          },
        ],
      },
    ];
    const codex = new FakeCodexRunner(git);
    const orchestrator = createOrchestrator(tracker, gitlab, codex, git);

    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(codex.initialCalls).toBe(0);
    expect(gitlab.replies).toEqual([]);
    expect(updated.reviewMetadata).toHaveLength(0);
    expect(updated.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_status_changed",
          payload: expect.objectContaining({ from: "fixing_review", to: "review" }),
        }),
      ]),
    );
    expect(updated.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_status_changed",
          payload: expect.objectContaining({ to: "failed" }),
        }),
      ]),
    );
  });
});
