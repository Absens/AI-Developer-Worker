import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTelegramAssistantStore,
  TelegramNotificationRouter,
  TelegramAssistantProjectContextSourceProvider,
  TelegramAssistantService,
  type TelegramAssistantProjectSourceProvider,
  type TelegramAssistantServiceOptions,
  type TelegramPendingAction,
} from "../src/domain/telegramAssistant/index.js";
import { parseCallbackData } from "../src/domain/telegramAssistant/service.js";
import type {
  ProjectAnalysis,
  ProjectGoal,
} from "../src/domain/projectManager/index.js";
import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/index.js";
import {
  TelegramUpdatePoller,
  TelegramRetryAfterError,
  type TelegramUpdate,
} from "../src/integrations/telegram/index.js";
import { runApplicationRuntime } from "../src/app.js";
import type {
  RepositoryKnowledgeBase,
  RepositoryProfile,
  TelegramAssistantConfig,
} from "../src/models/types.js";
import type {
  CreateTaskInput,
  HumanAnswerInput,
  TaskLeaseRecord,
  TaskEventInput,
  TaskRecord,
  TaskTrackerClient,
} from "../src/domain/taskTracker/index.js";

const baseTelegramAssistantConfig = (): TelegramAssistantConfig => ({
  enabled: true,
  botToken: "test-token",
  mode: "polling",
  pollIntervalSeconds: 2,
  confirmWriteActions: true,
  projectQaEnabled: false,
  taskCreationEnabled: true,
  allowedChatIds: ["1"],
  allowedUserIds: ["10"],
  developerUserIds: ["10"],
  operatorUserIds: [],
  adminUserIds: [],
  groupMode: "mentions_and_replies",
  userTaskCreationDailyLimit: 20,
  userCodexQaDailyLimit: 50,
  codexTimeoutSeconds: 120,
  codexMaxContextChars: 12000,
  maxQueuedMessagesPerChat: 20,
  conversationRetentionDays: 14,
  maxInboundMessageAgeSeconds: 0,
  media: {
    enabled: false,
    maxBytes: 10485760,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "text/plain"],
  },
  profileAutomation: {
    enabled: false,
    autoReplyEnabled: false,
    requireOwnerApproval: true,
    projectQaEnabled: false,
    allowedOwnerIds: [],
    allowedChatIds: [],
    maxMessageAgeSeconds: 0,
  },
});

const disabledButAllowedConfig = (): TelegramAssistantConfig => ({
  ...baseTelegramAssistantConfig(),
  enabled: false,
});

const baseTime = "2026-05-30T08:00:00.000Z";

const taskFixture = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: overrides.id ?? "task_1",
  title: overrides.title ?? "Task",
  description: overrides.description ?? "Task description.",
  source: { kind: "native" },
  createdBy: { owner: "human", id: "user-1" },
  repositoryName: overrides.repositoryName ?? "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: overrides.tags ?? [],
  components: overrides.components ?? [],
  priority: "normal",
  status: overrides.status ?? "ready",
  taskType: "backend_endpoint",
  acceptanceCriteria: [],
  constraints: [],
  riskFactors: [],
  missingContext: [],
  externalRefs: [],
  fieldOwners: [],
  revisions: [],
  events: overrides.events ?? [],
  comments: [],
  decisions: [],
  plans: [],
  dependencies: [],
  artifacts: [],
  agentRuns: [],
  qualityGateRuns: [],
  mergeRequests: overrides.mergeRequests ?? [],
  clarificationQuestions: overrides.clarificationQuestions ?? [],
  humanAnswers: [],
  decompositionDecisions: [],
  reviewMetadata: [],
  memoryContextRefs: [],
  createdAt: overrides.createdAt ?? baseTime,
  updatedAt: overrides.updatedAt ?? baseTime,
  ...overrides,
});

const repositoryFixture = (
  overrides: Partial<RepositoryProfile> = {},
): RepositoryProfile => ({
  name: overrides.name ?? "developer",
  repoPath: overrides.repoPath ?? "C:\\repo\\developer",
  gitlabProjectId: overrides.gitlabProjectId ?? "developer/project",
  gitRemoteName: overrides.gitRemoteName ?? "origin",
  baseBranch: overrides.baseBranch ?? "main",
  queues: overrides.queues ?? ["DEV"],
  tags: overrides.tags ?? [],
  testCommand: overrides.testCommand ?? "npm test",
  lintCommand: overrides.lintCommand ?? "npm run typecheck",
  ...overrides,
});

const createTaskDraftPendingAction = (
  overrides: Partial<TelegramPendingAction> = {},
): TelegramPendingAction => ({
  id: "tgpa_pending",
  conversationKey: "bot_private:1",
  chatId: 1,
  userId: 10,
  intent: {
    name: "create_task_draft",
    confidence: 1,
    rawText: "создай задачу починить регистрацию",
    requiresConfirmation: true,
    safetyLevel: "confirm_write",
  },
  payload: {
    chatId: 1,
    messageId: 99,
    userId: 10,
    externalKey: "telegram:1:99",
    draft: {
      title: "починить регистрацию",
      description: "создай задачу починить регистрацию",
      repositoryName: "developer",
      acceptanceCriteria: [
        "Поведение реализовано и покрыто существующими проверками.",
      ],
      tags: ["telegram"],
    },
  },
  status: "pending",
  createdAt: "2026-05-30T08:00:00.000Z",
  updatedAt: "2026-05-30T08:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...overrides,
});

const readonlyTaskTracker = (tasks: TaskRecord[]): TaskTrackerClient => {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const mutatingMethod = vi.fn(() => {
    throw new Error("telegram task status must be read-only");
  });

  return {
    listTasks: vi.fn(async () => tasks),
    listActiveLeases: vi.fn(async (): Promise<TaskLeaseRecord[]> => []),
    createTask: mutatingMethod,
    proposeTask: mutatingMethod,
    approveProposal: mutatingMethod,
    rejectProposal: mutatingMethod,
    cleanupProposals: mutatingMethod,
    updateTaskRevision: mutatingMethod,
    updateExternalTaskFields: mutatingMethod,
    attachExternalRef: mutatingMethod,
    markReady: mutatingMethod,
    getTask: vi.fn(async (taskId: string) => {
      const task = tasksById.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return task;
    }),
    findTaskByExternalRef: mutatingMethod,
    getAgentTaskContext: mutatingMethod,
    appendEvent: mutatingMethod,
    appendEventOnce: mutatingMethod,
    appendComment: mutatingMethod,
    setStatus: mutatingMethod,
    recordDecision: mutatingMethod,
    recordAnalysis: mutatingMethod,
    recordTaskStep: mutatingMethod,
    askClarification: mutatingMethod,
    recordHumanAnswer: mutatingMethod,
    recordAgentRun: mutatingMethod,
    recordValidation: mutatingMethod,
    recordMergeRequest: mutatingMethod,
    recordReviewMetadata: mutatingMethod,
    recordDecomposition: mutatingMethod,
    createChildTasks: mutatingMethod,
    linkDependency: mutatingMethod,
    recordMemoryContext: mutatingMethod,
    addDependency: mutatingMethod,
    claimNextTask: mutatingMethod,
    claimReviewTask: mutatingMethod,
    heartbeatLease: mutatingMethod,
    releaseLease: mutatingMethod,
  } as unknown as TaskTrackerClient;
};

const fakeTaskTracker = (
  task: TaskRecord = taskFixture({
    id: "task_callback_1",
    title: "починить регистрацию",
  }),
): TaskTrackerClient => {
  const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => task);
  const findTaskByExternalRef = vi.fn(async (): Promise<TaskRecord | null> => null);
  return {
    ...readonlyTaskTracker([task]),
    createTask,
    findTaskByExternalRef,
  } as unknown as TaskTrackerClient;
};

const fakeTaskTrackerWithAwaitingHumanTask = (): TaskTrackerClient => {
  const task = taskFixture({
    id: "task_awaiting",
    title: "Нужен ответ по варианту",
    status: "awaiting_human",
    clarificationQuestions: [
      {
        id: "question_old",
        taskId: "task_awaiting",
        workerId: "worker-1",
        question: {
          summary: "Нужен выбор варианта",
          blockingReason: "Не выбран вариант реализации.",
          question: "Выбрать вариант A или B?",
          options: ["A", "B"],
          resumeHint: "Ответьте и попросите продолжить.",
        },
        status: "open",
        createdAt: "2026-05-30T08:00:00.000Z",
      },
      {
        id: "question_latest",
        taskId: "task_awaiting",
        workerId: "worker-1",
        question: {
          summary: "Нужен финальный выбор",
          blockingReason: "AI ждет подтверждения варианта.",
          question: "Можно продолжать с вариантом A?",
          options: ["Да", "Нет"],
          resumeHint: "Ответьте и попросите продолжить.",
        },
        status: "open",
        createdAt: "2026-05-30T08:05:00.000Z",
      },
    ],
  });
  return {
    ...readonlyTaskTracker([task]),
    listTasks: vi.fn(async (): Promise<TaskRecord[]> => [task]),
    recordHumanAnswer: vi.fn(async (): Promise<void> => undefined),
  } as unknown as TaskTrackerClient;
};

const awaitingHumanTaskFixture = (): TaskRecord => taskFixture({
  id: "task_awaiting",
  title: "Нужен ответ по варианту",
  status: "awaiting_human",
  clarificationQuestions: [
    {
      id: "question_latest",
      taskId: "task_awaiting",
      workerId: "worker-1",
      question: {
        summary: "Нужен финальный выбор",
        blockingReason: "AI ждет подтверждения варианта.",
        question: "Можно продолжать с вариантом A?",
        options: ["Да", "Нет"],
        resumeHint: "Ответьте и попросите продолжить.",
      },
      status: "open",
      createdAt: "2026-05-30T08:05:00.000Z",
    },
  ],
});

const fakeMutableTaskTrackerWithAwaitingHumanTask = (
  input: { failRecordHumanAnswerOnce?: boolean } = {},
): TaskTrackerClient => {
  const task = awaitingHumanTaskFixture();
  let shouldFailRecordHumanAnswer = input.failRecordHumanAnswerOnce === true;
  const recordHumanAnswer = vi.fn(
    async (taskId: string, answer: HumanAnswerInput): Promise<void> => {
      if (shouldFailRecordHumanAnswer) {
        shouldFailRecordHumanAnswer = false;
        throw new Error("transient answer write failure");
      }

      task.humanAnswers.push({
        id: `answer_${task.humanAnswers.length + 1}`,
        taskId,
        ...(answer.questionId ? { questionId: answer.questionId } : {}),
        author: answer.author,
        body: answer.body,
        ...(answer.command ? { command: answer.command } : {}),
        createdAt: baseTime,
      });
      const question = task.clarificationQuestions.find(
        (candidate) => candidate.id === answer.questionId,
      );
      if (question) {
        question.status = "answered";
      }
    },
  );

  return {
    ...readonlyTaskTracker([task]),
    listTasks: vi.fn(async (): Promise<TaskRecord[]> => [task]),
    getTask: vi.fn(async (): Promise<TaskRecord> => task),
    recordHumanAnswer,
  } as unknown as TaskTrackerClient;
};

interface BuildAssistantInput {
  store: InMemoryTelegramAssistantStore;
  taskTracker?: TaskTrackerClient;
  assistantCodex?: FakeAssistantCodexService;
  projectSourceProvider?: TelegramAssistantProjectSourceProvider;
  logger?: TelegramAssistantServiceOptions["logger"];
  observability?: FakeTelegramObservability;
  answerCallbackQuery?: TelegramAssistantServiceOptions["telegram"]["answerCallbackQuery"];
  sendMessage?: TelegramAssistantServiceOptions["telegram"]["sendMessage"];
  config?: Partial<TelegramAssistantConfig>;
  repositories?: RepositoryProfile[];
}

interface FakeAssistantCodexService {
  answerProjectQuestion(input: {
    question: string;
    sources: Array<{ id: string; body: string }>;
  }): Promise<{ answer: string; threadId?: string; timedOut?: boolean }>;
}

interface FakeTelegramObservability {
  incrementCounter(name: string, labels?: Record<string, string>, value?: number): void;
  observeHistogram(name: string, labels: Record<string, string>, value: number): void;
  setGauge(name: string, labels: Record<string, string>, value: number): void;
}

const fakeObservability = (): {
  telemetry: FakeTelegramObservability;
  counters: Array<{ name: string; labels: Record<string, string>; value?: number }>;
  histograms: Array<{ name: string; labels: Record<string, string>; value: number }>;
  gauges: Array<{ name: string; labels: Record<string, string>; value: number }>;
} => {
  const counters: Array<{ name: string; labels: Record<string, string>; value?: number }> = [];
  const histograms: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  const gauges: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  return {
    counters,
    histograms,
    gauges,
    telemetry: {
      incrementCounter: vi.fn((name, labels = {}, value) => {
        counters.push({ name, labels, value });
      }),
      observeHistogram: vi.fn((name, labels, value) => {
        histograms.push({ name, labels, value });
      }),
      setGauge: vi.fn((name, labels, value) => {
        gauges.push({ name, labels, value });
      }),
    },
  };
};

const buildAssistant = (input: BuildAssistantInput): TelegramAssistantService =>
  new TelegramAssistantService({
    store: input.store,
    config: {
      ...baseTelegramAssistantConfig(),
      defaultRepository: "developer",
      ...input.config,
    },
    taskTracker: input.taskTracker,
    ...(input.assistantCodex ? { assistantCodex: input.assistantCodex } : {}),
    ...(input.projectSourceProvider
      ? { projectSourceProvider: input.projectSourceProvider }
      : {}),
    repositories: input.repositories ?? [repositoryFixture()],
    telegram: {
      sendMessage: input.sendMessage ?? vi.fn(),
      answerCallbackQuery: input.answerCallbackQuery ?? vi.fn(),
    },
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.observability ? { observability: input.observability } : {}),
  } as TelegramAssistantServiceOptions & { observability?: FakeTelegramObservability });

interface MessageUpdateOverrides {
  updateId?: number;
  messageId?: number;
  chatId?: number;
  userId?: number;
  date?: number;
}

const messageUpdate = (
  text: string,
  overrides: MessageUpdateOverrides = {},
): TelegramUpdate => ({
  update_id: overrides.updateId ?? 100,
  message: {
    message_id: overrides.messageId ?? 99,
    date: overrides.date ?? 1,
    chat: { id: overrides.chatId ?? 1, type: "private" },
    from: {
      id: overrides.userId ?? 10,
      is_bot: false,
      first_name: "User",
    },
    text,
  },
});

interface CallbackUpdateOverrides {
  updateId?: number;
  callbackQueryId?: string;
  messageId?: number;
  chatId?: number;
  userId?: number;
  date?: number;
  hasMessage?: boolean;
}

const callbackUpdate = (
  data: string | undefined,
  overrides: CallbackUpdateOverrides = {},
): TelegramUpdate => ({
  update_id: overrides.updateId ?? 101,
  callback_query: {
    id: overrides.callbackQueryId ?? "cb_1",
    from: {
      id: overrides.userId ?? 10,
      is_bot: false,
      first_name: "User",
    },
    ...(overrides.hasMessage === false
      ? {}
      : {
          message: {
            message_id: overrides.messageId ?? 100,
            date: overrides.date ?? 2,
            chat: { id: overrides.chatId ?? 1, type: "private" },
            text: "Создать задачу?",
          },
        }),
    chat_instance: "chat_instance_1",
    ...(data !== undefined ? { data } : {}),
  },
});

const isSymlinkUnavailableError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(String(
    (error as { code?: unknown }).code,
  ));

const errorToTestMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const waitForCondition = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const promiseStateAfter = async <T>(
  promise: Promise<T>,
  timeoutMs = 25,
): Promise<"settled" | "pending"> =>
  Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), timeoutMs);
    }),
  ]);

describe("parseCallbackData", () => {
  it("parses valid compact callback forms", () => {
    expect(parseCallbackData("c:id")).toEqual({
      kind: "confirm",
      actionKind: "create_task",
      id: "id",
    });
    expect(parseCallbackData("confirm:create_task:id")).toEqual({
      kind: "confirm",
      actionKind: "create_task",
      id: "id",
    });
    expect(parseCallbackData("cancel:id")).toEqual({
      kind: "cancel",
      id: "id",
    });
    expect(parseCallbackData("select_task:task_1")).toEqual({
      kind: "select_task",
      taskId: "task_1",
    });
  });

  it("rejects missing callback fields", () => {
    expect(parseCallbackData(undefined)).toBeUndefined();
    expect(parseCallbackData("")).toBeUndefined();
    expect(parseCallbackData("c")).toBeUndefined();
    expect(parseCallbackData("c:")).toBeUndefined();
    expect(parseCallbackData("confirm:create_task")).toBeUndefined();
    expect(parseCallbackData("confirm:create_task:")).toBeUndefined();
    expect(parseCallbackData("cancel")).toBeUndefined();
    expect(parseCallbackData("cancel:")).toBeUndefined();
    expect(parseCallbackData("select_task")).toBeUndefined();
    expect(parseCallbackData("select_task:")).toBeUndefined();
  });

  it("rejects callback data with extra fields", () => {
    expect(parseCallbackData("c:id:extra")).toBeUndefined();
    expect(parseCallbackData("confirm:create_task:id:extra")).toBeUndefined();
    expect(parseCallbackData("cancel:id:extra")).toBeUndefined();
    expect(parseCallbackData("select_task:task_1:extra")).toBeUndefined();
  });

  it("rejects callback data longer than 64 UTF-8 bytes", () => {
    expect(parseCallbackData("x".repeat(65))).toBeUndefined();
    expect(parseCallbackData(`c:${"ж".repeat(32)}`)).toBeUndefined();
  });
});

describe("TelegramAssistantService", () => {
  it("ignores updates without a supported message shape and advances offset", async () => {
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: disabledButAllowedConfig(),
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage: vi.fn(), answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({ update_id: 5 });

    expect(await store.isUpdateProcessed(5)).toBe(true);
    expect(await store.getOffset("default")).toBe(6);
  });

  it("rejects unauthorized messages with no task action", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: {
        ...disabledButAllowedConfig(),
        enabled: true,
        allowedChatIds: ["2"],
        allowedUserIds: ["99"],
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 6,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "что там",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "1" }));
    expect(await store.isUpdateProcessed(6)).toBe(true);
    expect(await store.getOffset("default")).toBe(7);
    expect(await store.listPendingActions()).toEqual([]);
  });

  it("serializes duplicate webhook deliveries by update id", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: {
        ...disabledButAllowedConfig(),
        enabled: true,
        allowedChatIds: ["2"],
        allowedUserIds: ["99"],
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });
    const update = messageUpdate("что там", { updateId: 106, messageId: 2 });

    await Promise.all([
      service.handleUpdate(update),
      service.handleUpdate(update),
    ]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await store.isUpdateProcessed(106)).toBe(true);
    expect(await store.getOffset("default")).toBe(107);
  });

  it("ignores Telegram photos when the media mime allowlist excludes images", async () => {
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const createdTask = taskFixture({ id: "task_without_photo" });
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => (
      createdTask
    ));
    const appendEventOnce = vi.fn(async (): Promise<boolean> => true);
    const taskTracker = {
      ...readonlyTaskTracker([]),
      createTask,
      findTaskByExternalRef: vi.fn(async (): Promise<TaskRecord | null> => null),
      appendEventOnce,
    } as unknown as TaskTrackerClient;
    const service = buildAssistant({
      store,
      taskTracker,
      config: {
        media: {
          enabled: true,
          maxBytes: 2000,
          allowedMimeTypes: ["text/plain"],
        },
      },
    });

    await service.handleUpdate({
      ...messageUpdate("создай задачу проверить фото"),
      message: {
        ...messageUpdate("создай задачу проверить фото").message!,
        photo: [
          {
            file_id: "photo_small",
            file_unique_id: "photo_unique_small",
            width: 64,
            height: 64,
            file_size: 500,
          },
          {
            file_id: "photo_large",
            file_unique_id: "photo_unique_large",
            width: 128,
            height: 128,
            file_size: 1000,
          },
        ],
      },
    });

    const pendingActions = await store.listPendingActions();
    expect(pendingActions).toHaveLength(1);
    expect(pendingActions[0]?.payload.attachments).toBeUndefined();

    await service.handleUpdate(callbackUpdate(`c:${pendingActions[0]?.id}`));

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      externalSnapshot: expect.not.objectContaining({
        attachments: expect.any(Array),
      }),
    }));
    expect(appendEventOnce).not.toHaveBeenCalledWith(
      "task_without_photo",
      expect.objectContaining({ kind: "attachments_registered" }),
    );
  });

  it("records Telegram photo metadata with inferred jpeg mime when images are allowed", async () => {
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const createdTask = taskFixture({ id: "task_with_photo" });
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => (
      createdTask
    ));
    const appendEventOnce = vi.fn(async (): Promise<boolean> => true);
    const taskTracker = {
      ...readonlyTaskTracker([]),
      createTask,
      findTaskByExternalRef: vi.fn(async (): Promise<TaskRecord | null> => null),
      appendEventOnce,
    } as unknown as TaskTrackerClient;
    const service = buildAssistant({
      store,
      taskTracker,
      config: {
        media: {
          enabled: true,
          maxBytes: 2000,
          allowedMimeTypes: ["image/jpeg"],
        },
      },
    });

    await service.handleUpdate({
      ...messageUpdate("создай задачу проверить фото"),
      message: {
        ...messageUpdate("создай задачу проверить фото").message!,
        photo: [
          {
            file_id: "photo_small",
            file_unique_id: "photo_unique_small",
            width: 64,
            height: 64,
            file_size: 500,
          },
          {
            file_id: "photo_large",
            file_unique_id: "photo_unique_large",
            width: 128,
            height: 128,
            file_size: 1000,
          },
        ],
      },
    });

    const pendingActions = await store.listPendingActions();
    expect(pendingActions).toHaveLength(1);
    expect(pendingActions[0]?.payload.attachments).toEqual([
      {
        type: "photo",
        fileId: "photo_large",
        mimeType: "image/jpeg",
        size: 1000,
        width: 128,
        height: 128,
      },
    ]);

    await service.handleUpdate(callbackUpdate(`c:${pendingActions[0]?.id}`));

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      externalSnapshot: expect.objectContaining({
        attachments: [
          {
            type: "photo",
            fileId: "photo_large",
            mimeType: "image/jpeg",
            size: 1000,
            width: 128,
            height: 128,
          },
        ],
      }),
    }));
    expect(appendEventOnce).toHaveBeenCalledWith("task_with_photo", expect.objectContaining({
      kind: "attachments_registered",
      payload: expect.objectContaining({
        attachments: [
          {
            type: "photo",
            fileId: "photo_large",
            mimeType: "image/jpeg",
            size: 1000,
            width: 128,
            height: 128,
          },
        ],
      }),
    }));
  });

  it("does not let non-business project Q&A bypass global Telegram allowlists", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "must not run" })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          allowedChatIds: [],
          allowedUserIds: [],
          developerUserIds: [],
          operatorUserIds: [],
          adminUserIds: [],
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate(messageUpdate("Какие цели проекта?", {
        updateId: 84,
        messageId: 88,
        userId: 999,
      }));

      expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "У меня нет доступа к этому чату/пользователю.",
      }));
      expect(await store.getOffset("default")).toBe(85);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("queues messages when the conversation already has an active assistant turn", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    await store.startAssistantTurn({
      id: "turn-1",
      conversationKey: "group:-100:42",
      status: "running",
      startedAt: "2026-05-30T08:00:00.000Z",
    });
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        allowedChatIds: ["-100"],
        allowedUserIds: ["10"],
        groupMode: "all_messages",
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 7,
      message: {
        message_id: 12,
        message_thread_id: 42,
        date: 1,
        chat: { id: -100, type: "supergroup" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "next question",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.listQueuedMessages("group:-100:42")).resolves.toEqual([
      expect.objectContaining({
        id: "queued:7",
        chatId: -100,
        userId: 10,
        message: expect.objectContaining({
          conversationKey: "group:-100:42",
          text: "next question",
        }),
      }),
    ]);
    expect(await store.getOffset("default")).toBe(8);
  });

  it("queues viewer write-like messages when the conversation already has an active assistant turn", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    await store.startAssistantTurn({
      id: "turn-2",
      conversationKey: "bot_private:1",
      status: "running",
      startedAt: "2026-05-30T08:00:00.000Z",
    });
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        developerUserIds: [],
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 19,
      message: {
        message_id: 24,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "Viewer" },
        text: "создай задачу починить регистрацию",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.listQueuedMessages("bot_private:1")).resolves.toEqual([
      expect.objectContaining({
        id: "queued:19",
        chatId: 1,
        userId: 10,
        message: expect.objectContaining({
          conversationKey: "bot_private:1",
          text: "создай задачу починить регистрацию",
        }),
      }),
    ]);
    expect(await store.getOffset("default")).toBe(20);
  });

  it("does not overwrite a completed assistant turn when cancellation loses the running transition", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    await store.startAssistantTurn({
      id: "turn-cancel-race",
      conversationKey: "bot_private:1",
      status: "running",
      startedAt: "2026-05-30T08:00:00.000Z",
    });
    const completeAssistantTurn = vi.spyOn(store, "completeAssistantTurn");
    const originalGetActiveAssistantTurn = store.getActiveAssistantTurn.bind(store);
    let completedBeforeCancel = false;
    vi.spyOn(store, "getActiveAssistantTurn").mockImplementation(
      async (conversationKey) => {
        const activeTurn = await originalGetActiveAssistantTurn(conversationKey);
        if (!completedBeforeCancel && activeTurn?.id === "turn-cancel-race") {
          completedBeforeCancel = true;
          await store.completeAssistantTurnIfRunning("turn-cancel-race", {
            status: "completed",
            completedAt: "2026-05-30T08:00:01.000Z",
          });
        }
        return activeTurn;
      },
    );
    const service = buildAssistant({
      store,
      sendMessage,
      config: { projectQaEnabled: true },
    });

    await service.handleUpdate(messageUpdate("отмена", {
      updateId: 95,
      messageId: 99,
    }));

    expect(completedBeforeCancel).toBe(true);
    expect(completeAssistantTurn).not.toHaveBeenCalledWith(
      "turn-cancel-race",
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      text: "Действие отменено.",
    }));
    await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toBeUndefined();
    expect(await store.getOffset("default")).toBe(96);
  });

  it("answers project questions through assistant Codex and completes the turn", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(
        join(repoDir, "README.md"),
        "Telegram assistant answers project questions. TOKEN=secret",
      );
      let sawRunningTurn = false;
      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion: vi.fn(async (
          input: Parameters<FakeAssistantCodexService["answerProjectQuestion"]>[0],
        ) => {
          expect(input.question).toBe("Какие цели проекта?");
          expect(input.sources).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: expect.stringContaining("README.md"),
                body: expect.stringContaining("Telegram assistant answers"),
              }),
            ]),
          );
          expect(input.sources.map((source) => source.body).join("\n")).not.toContain(
            "TOKEN=secret",
          );
          await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toEqual(
            expect.objectContaining({
              id: "assistant-turn:21:25",
              status: "running",
              input: expect.objectContaining({ text: "Какие цели проекта?" }),
            }),
          );
          sawRunningTurn = true;
          return { answer: "Ответ из Codex.", threadId: "thread_qa_1" };
        }),
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          codexMaxContextChars: 4000,
          codexTimeoutSeconds: 30,
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate(messageUpdate("Какие цели проекта?", {
        updateId: 73,
        messageId: 77,
      }));

      await waitForCondition(() => sawRunningTurn);
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Ответ из Codex.",
      ));
      expect(sawRunningTurn).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "Ответ из Codex.",
        replyToMessageId: 77,
      }));
      await waitForCondition(async () =>
        (await store.getActiveAssistantTurn("bot_private:1")) === undefined,
      );
      expect(await store.getOffset("default")).toBe(74);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("does not pass outside-root symlinked docs to assistant Codex sources", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "telegram-assistant-outside-"));
    const sentinel = "OUTSIDE_ROOT_SYMLINK_SECRET";
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const outsideDocsDir = join(outsideDir, "docs");
      await mkdir(outsideDocsDir);
      const outsideSecretPath = join(outsideDocsDir, "secret.md");
      await writeFile(outsideSecretPath, sentinel);
      try {
        await symlink(outsideDocsDir, join(repoDir, "docs"), "junction");
      } catch (error) {
        if (isSymlinkUnavailableError(error)) {
          console.warn(
            `Skipping junction escape regression: ${errorToTestMessage(error)}`,
          );
          return;
        }
        throw error;
      }

      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion: vi.fn(async (
          input: Parameters<FakeAssistantCodexService["answerProjectQuestion"]>[0],
        ) => {
          expect(input.sources.map((source) => source.body).join("\n")).not.toContain(
            sentinel,
          );
          return { answer: "Ответ без внешних источников." };
        }),
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: { projectQaEnabled: true },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate(messageUpdate("Что в документации?", {
        updateId: 76,
        messageId: 80,
      }));

      await waitForCondition(() =>
        vi.mocked(assistantCodex.answerProjectQuestion).mock.calls.length === 1,
      );
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Ответ без внешних источников.",
      ));
      expect(assistantCodex.answerProjectQuestion).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "Ответ без внешних источников.",
      }));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("drains one queued project question after the active project turn completes", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      let resolveFirstAnswer: ((value: { answer: string }) => void) | undefined;
      const firstAnswer = new Promise<{ answer: string }>((resolve) => {
        resolveFirstAnswer = resolve;
      });
      const answerProjectQuestion = vi.fn(async (
        input: Parameters<FakeAssistantCodexService["answerProjectQuestion"]>[0],
      ) => {
        if (input.question === "Первый вопрос?") {
          return firstAnswer;
        }
        return { answer: `Очередь: ${input.question}` };
      });
      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion,
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: { projectQaEnabled: true },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      const firstUpdate = service.handleUpdate(messageUpdate("Первый вопрос?", {
        updateId: 77,
        messageId: 81,
      }));
      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 1);
      await firstUpdate;

      await service.handleUpdate(messageUpdate("Второй вопрос?", {
        updateId: 78,
        messageId: 82,
      }));
      await expect(store.listQueuedMessages("bot_private:1")).resolves.toEqual([
        expect.objectContaining({
          id: "queued:78",
          message: expect.objectContaining({ text: "Второй вопрос?" }),
        }),
      ]);

      resolveFirstAnswer?.({ answer: "Первый ответ." });

      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 2);
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Очередь: Второй вопрос?",
      ));
      expect(answerProjectQuestion).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "Первый ответ.",
        replyToMessageId: 81,
      }));
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "Очередь: Второй вопрос?",
        replyToMessageId: 82,
      }));
      await waitForCondition(async () =>
        (await store.listQueuedMessages("bot_private:1")).length === 0,
      );
      await waitForCondition(async () =>
        (await store.getActiveAssistantTurn("bot_private:1")) === undefined,
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("drops stale queued project questions instead of draining them", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const answerProjectQuestion = vi.fn(async (
        input: Parameters<FakeAssistantCodexService["answerProjectQuestion"]>[0],
      ) => {
        if (input.question === "Первый вопрос?") {
          return { answer: "Первый ответ." };
        }
        return { answer: `Очередь: ${input.question}` };
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex: { answerProjectQuestion },
        config: {
          projectQaEnabled: true,
          maxInboundMessageAgeSeconds: 300,
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });
      const staleReceivedAt = new Date(Date.now() - 600_000).toISOString();

      await store.enqueueMessage({
        id: "queued:old",
        conversationKey: "bot_private:1",
        chatId: 1,
        userId: 10,
        message: {
          id: "telegram:old:message:82",
          updateId: 78,
          conversationKey: "bot_private:1",
          source: "bot_private",
          chatId: 1,
          userId: 10,
          messageId: 82,
          text: "Старый вопрос?",
          redactedText: "Старый вопрос?",
          actor: {
            role: "developer",
            telegramUserId: 10,
            displayName: "User",
          },
          receivedAt: staleReceivedAt,
        },
        status: "queued",
        createdAt: staleReceivedAt,
        expiresAt: "2099-01-13T07:50:00.000Z",
      });

      await service.handleUpdate(messageUpdate("Первый вопрос?", {
        updateId: 77,
        messageId: 81,
        date: Math.floor(Date.now() / 1000),
      }));

      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 1);
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Первый ответ.",
      ));
      await waitForCondition(async () =>
        (await store.listQueuedMessages("bot_private:1")).length === 0,
      );
      await expect(
        waitForCondition(() => answerProjectQuestion.mock.calls.length > 1, 200),
      ).rejects.toThrow("Timed out waiting for condition.");
      expect(answerProjectQuestion).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "Первый ответ.",
      }));
      expect(sendMessage.mock.calls).toEqual(
        expect.not.arrayContaining([
          [expect.objectContaining({ text: "Очередь: Старый вопрос?" })],
        ]),
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("persists redacted project Q&A turn inputs and queued messages while still answering", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const connectionTime = new Date().toISOString();
      await store.upsertBusinessConnection({
        id: "business-redaction",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: connectionTime,
        updatedAt: connectionTime,
        lastSeenAt: connectionTime,
      });

      let resolveBusinessAnswer: ((value: { answer: string }) => void) | undefined;
      const businessAnswer = new Promise<{ answer: string }>((resolve) => {
        resolveBusinessAnswer = resolve;
      });
      let resolvePrivateAnswer: ((value: { answer: string }) => void) | undefined;
      const privateAnswer = new Promise<{ answer: string }>((resolve) => {
        resolvePrivateAnswer = resolve;
      });
      const answerProjectQuestion = vi.fn(async (
        input: Parameters<FakeAssistantCodexService["answerProjectQuestion"]>[0],
      ) => {
        if (input.question.startsWith("Какие цели проекта?")) {
          return businessAnswer;
        }
        if (input.question === "Первый вопрос?") {
          return privateAnswer;
        }
        return { answer: `Очередь: ${input.question}` };
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex: { answerProjectQuestion },
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 91,
        business_message: {
          message_id: 95,
          date: 1,
          business_connection_id: "business-redaction",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта? TOKEN=business-secret",
        },
      });
      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 1);

      const businessTurn = await store.getActiveAssistantTurn(
        "business:business-redaction:1",
      );
      expect(JSON.stringify(businessTurn?.input)).not.toContain("business-secret");
      expect(businessTurn?.input).toEqual(expect.objectContaining({
        text: "Какие цели проекта? TOKEN=[redacted]",
        redactedText: "Какие цели проекта? TOKEN=[redacted]",
      }));

      resolveBusinessAnswer?.({ answer: "Business answer." });
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Business answer.",
      ));

      const firstUpdate = service.handleUpdate(messageUpdate("Первый вопрос?", {
        updateId: 92,
        messageId: 96,
      }));
      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 2);
      await firstUpdate;

      await service.handleUpdate(messageUpdate("Второй вопрос TOKEN=queued-secret", {
        updateId: 93,
        messageId: 97,
      }));
      const queuedMessages = await store.listQueuedMessages("bot_private:1");
      expect(queuedMessages).toHaveLength(1);
      expect(JSON.stringify(queuedMessages[0]?.message)).not.toContain(
        "queued-secret",
      );
      expect(queuedMessages[0]?.message).toEqual(expect.objectContaining({
        text: "Второй вопрос TOKEN=[redacted]",
        redactedText: "Второй вопрос TOKEN=[redacted]",
      }));

      resolvePrivateAnswer?.({ answer: "Первый ответ." });
      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 3);
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Очередь: Второй вопрос TOKEN=[redacted]",
      ));
      expect(answerProjectQuestion).toHaveBeenCalledWith(expect.objectContaining({
        question: "Какие цели проекта? TOKEN=[redacted]",
      }));
      expect(answerProjectQuestion).toHaveBeenCalledWith(expect.objectContaining({
        question: "Второй вопрос TOKEN=[redacted]",
      }));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("returns and advances offset while a project question answer is still running so cancellation can win", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    let resolveAnswer: ((value: { answer: string }) => void) | undefined;
    let answerPromiseResolved = false;
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const pendingAnswer = new Promise<{ answer: string }>((resolve) => {
        resolveAnswer = resolve;
      });
      const answerProjectQuestion = vi.fn(async () => {
        const result = await pendingAnswer;
        answerPromiseResolved = true;
        return result;
      });
      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion,
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: { projectQaEnabled: true },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      const firstUpdate = service.handleUpdate(messageUpdate("Первый вопрос?", {
        updateId: 85,
        messageId: 89,
      }));
      try {
        await waitForCondition(() => answerProjectQuestion.mock.calls.length === 1);
        await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toEqual(
          expect.objectContaining({ status: "running" }),
        );
        await expect(promiseStateAfter(firstUpdate)).resolves.toBe("settled");
        await firstUpdate;
        expect(await store.getOffset("default")).toBe(86);

        await service.handleUpdate(messageUpdate("отмена", {
          updateId: 86,
          messageId: 90,
        }));

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
          chatId: "1",
          text: "Действие отменено.",
          replyToMessageId: 90,
        }));
        await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toBeUndefined();
        resolveAnswer?.({ answer: "Late Codex answer." });
        await waitForCondition(() => answerPromiseResolved);
        await Promise.resolve();
        expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
          text: "Late Codex answer.",
        }));
        expect(await store.getOffset("default")).toBe(87);
      } finally {
        resolveAnswer?.({ answer: "Late Codex answer." });
        await firstUpdate.catch(() => undefined);
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("does not send a late project answer when completing from running loses to cancellation", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    let resolveAnswer: ((value: { answer: string }) => void) | undefined;
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const pendingAnswer = new Promise<{ answer: string }>((resolve) => {
        resolveAnswer = resolve;
      });
      const answerProjectQuestion = vi.fn(async () => pendingAnswer);
      const completeAssistantTurn = vi.spyOn(store, "completeAssistantTurn");
      const finishFromRunning = vi.fn(async (turnId: string) => {
        await store.completeAssistantTurn(turnId, {
          status: "cancelled",
          completedAt: "2026-05-30T08:00:01.000Z",
        });
        return undefined;
      });
      (
        store as unknown as {
          completeAssistantTurnIfRunning: typeof finishFromRunning;
        }
      ).completeAssistantTurnIfRunning = finishFromRunning;
      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion,
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: { projectQaEnabled: true },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate(messageUpdate("Первый вопрос?", {
        updateId: 93,
        messageId: 97,
      }));
      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 1);

      resolveAnswer?.({ answer: "Late Codex answer." });
      await waitForCondition(() =>
        finishFromRunning.mock.calls.length > 0 ||
          sendMessage.mock.calls.some(([input]) => input.text === "Late Codex answer."),
      );

      expect(finishFromRunning).toHaveBeenCalledWith(
        "assistant-turn:2l:2p",
        expect.objectContaining({ status: "completed" }),
      );
      expect(completeAssistantTurn).toHaveBeenCalledWith(
        "assistant-turn:2l:2p",
        expect.objectContaining({ status: "cancelled" }),
      );
      expect(completeAssistantTurn).not.toHaveBeenCalledWith(
        "assistant-turn:2l:2p",
        expect.objectContaining({ status: "completed" }),
      );
      expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        text: "Late Codex answer.",
      }));
      await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toBeUndefined();
    } finally {
      resolveAnswer?.({ answer: "Late Codex answer." });
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("marks failed background project question turns without rejecting the update", async () => {
    const sendMessage = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const completeAssistantTurn = vi.spyOn(store, "completeAssistantTurnIfRunning");
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion: vi.fn(async () => {
          throw new Error("codex failed");
        }),
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        logger,
        config: { projectQaEnabled: true },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await expect(service.handleUpdate(messageUpdate("Почему упало?", {
        updateId: 87,
        messageId: 91,
      }))).resolves.toBeUndefined();

      await waitForCondition(() =>
        completeAssistantTurn.mock.calls.some((call) => call[1].status === "failed"),
      );
      expect(await store.getOffset("default")).toBe(88);
      expect(logger.warn).toHaveBeenCalledWith(
        "Telegram assistant background operation failed.",
        expect.objectContaining({
          updateId: 87,
          error: "codex failed",
        }),
      );
      await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toBeUndefined();
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("marks a timed out project question turn as failed", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const completeAssistantTurn = vi.spyOn(store, "completeAssistantTurnIfRunning");
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion: vi.fn(async () => ({
          answer: "Codex не успел ответить за отведенное время. Попробуй сузить вопрос.",
          timedOut: true,
        })),
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: { projectQaEnabled: true },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate(messageUpdate("Слишком широкий вопрос?", {
        updateId: 79,
        messageId: 83,
      }));

      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text ===
          "Codex не успел ответить за отведенное время. Попробуй сузить вопрос.",
      ));
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "Codex не успел ответить за отведенное время. Попробуй сузить вопрос.",
        replyToMessageId: 83,
      }));
      await waitForCondition(() =>
        completeAssistantTurn.mock.calls.some((call) => call[1].status === "failed"),
      );
      expect(completeAssistantTurn).toHaveBeenCalledWith(
        "assistant-turn:27:2b",
        expect.objectContaining({ status: "failed" }),
      );
      await waitForCondition(async () =>
        (await store.getActiveAssistantTurn("bot_private:1")) === undefined,
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("passes project manager and memory sources from the project source provider", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      await mkdir(join(repoDir, "docs"));
      await Promise.all(Array.from({ length: 24 }, (_, index) =>
        writeFile(join(repoDir, "docs", `doc-${index}.md`), `Doc ${index}`),
      ));
      const goal: ProjectGoal = {
        id: "goal-telegram-qa",
        sourceAnalysisId: "analysis-telegram",
        repositoryName: "developer",
        status: "active",
        title: "Improve Telegram Q&A",
        problemStatement: "Project Q&A misses manager context.",
        desiredOutcome: "Assistant answers include project manager context.",
        successMetrics: ["Project answers cite goals."],
        evidenceRefs: [],
        priority: "high",
        riskLevel: "medium",
        suggestedTaskProposals: [],
        duplicateSignature: "goal-telegram-qa",
        createdAt: baseTime,
        updatedAt: baseTime,
      };
      const analysis: ProjectAnalysis = {
        id: "analysis-telegram",
        repositoryName: "developer",
        analysisKind: "analysis",
        summary: "Recent manager analysis prioritizes profile-safe Q&A.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        goalReplans: [],
        strategyAnalysisLenses: [],
        strategyOpportunities: [],
        strategyGoalLinks: [],
        strategyQuestions: [],
        createdAt: baseTime,
      };
      const knowledge: RepositoryKnowledgeBase = {
        repositoryName: "developer",
        schemaVersion: 1,
        updatedAt: baseTime,
        architectureMap: [
          {
            id: "memory-queue",
            title: "Telegram queue handling",
            body: "Queue drains one message under the conversation lock.",
            source: "manual",
            sourceRefs: ["tests/telegramAssistant.test.ts"],
            tags: ["telegram"],
            taskTypes: ["unknown"],
            confidence: 90,
            updatedAt: baseTime,
          },
        ],
        entryPoints: [],
        codePatterns: [],
        testStrategy: [],
        knownPitfalls: [],
        conventions: [],
      };
      const projectManager = {
        listGoals: vi.fn(async (): Promise<ProjectGoal[]> => [goal]),
        listAnalyses: vi.fn(async (): Promise<ProjectAnalysis[]> => [analysis]),
      };
      const memoryStore = {
        loadKnowledge: vi.fn(async (): Promise<RepositoryKnowledgeBase> => knowledge),
      };
      const projectSourceProvider = new TelegramAssistantProjectContextSourceProvider({
        projectManager,
        memoryStore,
      });
      const assistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion: vi.fn(async (
          input: Parameters<FakeAssistantCodexService["answerProjectQuestion"]>[0],
        ) => {
          const body = input.sources.map((source) => source.body).join("\n");
          expect(body).toContain("Improve Telegram Q&A");
          expect(body).toContain("Recent manager analysis prioritizes profile-safe Q&A");
          expect(body).toContain("Queue drains one message under the conversation lock");
          return { answer: "Ответ с контекстом проекта." };
        }),
      };
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        projectSourceProvider,
        config: { projectQaEnabled: true },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate(messageUpdate("Что важно по проекту?", {
        updateId: 82,
        messageId: 86,
      }));

      await waitForCondition(() =>
        vi.mocked(assistantCodex.answerProjectQuestion).mock.calls.length === 1,
      );
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Ответ с контекстом проекта.",
      ));
      expect(projectManager.listGoals).toHaveBeenCalledOnce();
      expect(projectManager.listAnalyses).toHaveBeenCalledOnce();
      expect(memoryStore.loadKnowledge).toHaveBeenCalledWith("developer");
      expect(assistantCodex.answerProjectQuestion).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        text: "Ответ с контекстом проекта.",
      }));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("cancels an active assistant project turn instead of queuing cancellation", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    await store.startAssistantTurn({
      id: "assistant-turn-active",
      conversationKey: "bot_private:1",
      status: "running",
      startedAt: "2026-05-30T08:00:00.000Z",
    });
    await store.enqueueMessage({
      id: "queued:old",
      conversationKey: "bot_private:1",
      chatId: 1,
      userId: 10,
      message: {
        id: "telegram:old",
        updateId: 70,
        conversationKey: "bot_private:1",
        source: "bot_private",
        chatId: 1,
        userId: 10,
        messageId: 74,
        text: "еще вопрос",
        redactedText: "еще вопрос",
        receivedAt: "1970-01-01T00:00:01.000Z",
      },
      status: "queued",
      createdAt: "2026-05-30T08:00:00.000Z",
      expiresAt: "2099-01-13T08:00:00.000Z",
    });
    const service = buildAssistant({
      store,
      sendMessage,
      config: { projectQaEnabled: true },
    });

    await service.handleUpdate(messageUpdate("отмена", {
      updateId: 74,
      messageId: 78,
    }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Действие отменено.",
      replyToMessageId: 78,
    }));
    await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toBeUndefined();
    await expect(store.listQueuedMessages("bot_private:1")).resolves.toEqual([]);
    expect(await store.getOffset("default")).toBe(75);
  });

  it("does not run project Q&A for business messages unless profile automation allows it", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "must not run" })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      sendMessage,
      assistantCodex,
      config: {
        projectQaEnabled: true,
        profileAutomation: {
          ...baseTelegramAssistantConfig().profileAutomation,
          projectQaEnabled: false,
        },
      },
    });

    await service.handleUpdate({
      update_id: 75,
      business_message: {
        message_id: 79,
        date: 1,
        business_connection_id: "business-1",
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "Business User" },
        text: "Какие цели проекта?",
      },
    });

    expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.getOffset("default")).toBe(76);
  });

  it("denies business project Q&A when only the external sender id is owner-allowlisted", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "must not run" })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 80,
        business_message: {
          message_id: 84,
          date: 1,
          business_connection_id: "business-unverified-owner",
          chat: { id: 1, type: "private" },
          from: { id: 10, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await store.getOffset("default")).toBe(81);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("allows business project Q&A when the stored connection owner is allowlisted", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "Business Q&A answer." })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const disabledEventDate = Math.floor(Date.now() / 1000);
      const freshConnectionTime = new Date(
        (disabledEventDate - 1) * 1000,
      ).toISOString();
      await store.upsertBusinessConnection({
        id: "business-verified-owner",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 81,
        business_message: {
          message_id: 85,
          date: 1,
          business_connection_id: "business-verified-owner",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      await waitForCondition(() =>
        vi.mocked(assistantCodex.answerProjectQuestion).mock.calls.length === 1,
      );
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Business Q&A answer.",
      ));
      expect(assistantCodex.answerProjectQuestion).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        businessConnectionId: "business-verified-owner",
        text: "Business Q&A answer.",
      }));
      expect(await store.getOffset("default")).toBe(82);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("answers business task status from the internal task tracker", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const freshConnectionTime = new Date().toISOString();
    await store.upsertBusinessConnection({
      id: "business-task-status",
      userId: 10,
      userChatId: 1000,
      rights: { can_reply: true, can_read_messages: true },
      isEnabled: true,
      createdAt: freshConnectionTime,
      updatedAt: freshConnectionTime,
      lastSeenAt: freshConnectionTime,
    });
    const taskTracker = readonlyTaskTracker([
      taskFixture({
        id: "task_123",
        title: "Планы на неделю",
        status: "review",
        events: [
          {
            id: "event-business-status",
            taskId: "task_123",
            kind: "status_changed",
            source: "worker_agent",
            message: "Открыт MR и идет review",
            createdAt: "2026-05-30T08:10:00.000Z",
          },
        ],
      }),
    ]);
    const service = buildAssistant({
      store,
      sendMessage,
      taskTracker,
      config: {
        profileAutomation: {
          ...baseTelegramAssistantConfig().profileAutomation,
          enabled: true,
          autoReplyEnabled: true,
          allowedOwnerIds: ["10"],
          allowedChatIds: ["1"],
        },
      },
    });

    await service.handleUpdate({
      update_id: 82,
      business_message: {
        message_id: 86,
        date: 1,
        business_connection_id: "business-task-status",
        chat: { id: 1, type: "private" },
        from: { id: 999, is_bot: false, first_name: "External User" },
        text: "что там task_123",
      },
    });

    expect(taskTracker.listTasks).toHaveBeenCalledWith({ limit: 500 });
    expect(taskTracker.getTask).toHaveBeenCalledWith("task_123");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      businessConnectionId: "business-task-status",
      parseMode: "HTML",
      disableWebPagePreview: true,
      replyToMessageId: 86,
      text: expect.stringContaining("<b>task_123: Планы на неделю</b>"),
    }));
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      text: "Intent: task_status",
    }));
    expect(await store.getOffset("default")).toBe(83);
  });

  it("queues a second business project Q&A while one is running using redacted payloads", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    let resolveFirstAnswer: ((value: { answer: string }) => void) | undefined;
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const freshConnectionTime = new Date().toISOString();
      await store.upsertBusinessConnection({
        id: "business-queue",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const firstAnswer = new Promise<{ answer: string }>((resolve) => {
        resolveFirstAnswer = resolve;
      });
      const answerProjectQuestion = vi.fn(async (
        input: Parameters<FakeAssistantCodexService["answerProjectQuestion"]>[0],
      ) => {
        if (input.question === "Какие цели проекта?") {
          return firstAnswer;
        }
        return { answer: "Second business answer must not start." };
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex: { answerProjectQuestion },
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      const firstUpdate = service.handleUpdate({
        update_id: 141,
        business_message: {
          message_id: 145,
          date: 1,
          business_connection_id: "business-queue",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });
      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 1);
      await firstUpdate;

      await service.handleUpdate({
        update_id: 142,
        business_message: {
          message_id: 146,
          date: 2,
          business_connection_id: "business-queue",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Второй вопрос TOKEN=business-queued-secret",
        },
      });

      expect(answerProjectQuestion).toHaveBeenCalledTimes(1);
      await expect(store.listQueuedMessages("business:business-queue:1")).resolves.toEqual([
        expect.objectContaining({
          id: "queued:142",
          message: expect.objectContaining({
            businessConnectionId: "business-queue",
            conversationKey: "business:business-queue:1",
            text: "Второй вопрос TOKEN=[redacted]",
            redactedText: "Второй вопрос TOKEN=[redacted]",
          }),
        }),
      ]);
      const queuedMessages = await store.listQueuedMessages("business:business-queue:1");
      expect(JSON.stringify(queuedMessages[0]?.message)).not.toContain(
        "business-queued-secret",
      );
      resolveFirstAnswer?.({ answer: "First business answer." });
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "First business answer.",
      ));
    } finally {
      resolveFirstAnswer?.({ answer: "First business answer." });
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("cancels a running business project Q&A and suppresses late answers", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    let resolveAnswer: ((value: { answer: string }) => void) | undefined;
    let answerPromiseResolved = false;
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const freshConnectionTime = new Date().toISOString();
      await store.upsertBusinessConnection({
        id: "business-cancel",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const pendingAnswer = new Promise<{ answer: string }>((resolve) => {
        resolveAnswer = resolve;
      });
      const answerProjectQuestion = vi.fn(async () => {
        const result = await pendingAnswer;
        answerPromiseResolved = true;
        return result;
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex: { answerProjectQuestion },
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      const firstUpdate = service.handleUpdate({
        update_id: 143,
        business_message: {
          message_id: 147,
          date: 1,
          business_connection_id: "business-cancel",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });
      await waitForCondition(() => answerProjectQuestion.mock.calls.length === 1);
      await firstUpdate;
      await store.enqueueMessage({
        id: "queued:business-cancel",
        conversationKey: "business:business-cancel:1",
        chatId: 1,
        userId: 999,
        message: {
          id: "telegram:queued-business",
          updateId: 140,
          conversationKey: "business:business-cancel:1",
          source: "business",
          chatId: 1,
          userId: 999,
          messageId: 144,
          text: "Следующий вопрос",
          redactedText: "Следующий вопрос",
          businessConnectionId: "business-cancel",
          receivedAt: "1970-01-01T00:00:02.000Z",
        },
        status: "queued",
        createdAt: "2026-05-30T08:00:00.000Z",
        expiresAt: "2099-01-13T08:00:00.000Z",
      });

      await service.handleUpdate({
        update_id: 144,
        business_message: {
          message_id: 148,
          date: 2,
          business_connection_id: "business-cancel",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "отмена",
        },
      });

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        businessConnectionId: "business-cancel",
        text: "Действие отменено.",
        replyToMessageId: 148,
      }));
      await expect(
        store.getActiveAssistantTurn("business:business-cancel:1"),
      ).resolves.toBeUndefined();
      await expect(
        store.listQueuedMessages("business:business-cancel:1"),
      ).resolves.toEqual([]);

      resolveAnswer?.({ answer: "Late business answer." });
      await waitForCondition(() => answerPromiseResolved);
      expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        text: "Late business answer.",
      }));
    } finally {
      resolveAnswer?.({ answer: "Late business answer." });
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("denies business project Q&A when profile automation is disabled", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "Internal Q&A answer." })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const freshConnectionTime = new Date().toISOString();
      await store.upsertBusinessConnection({
        id: "business-profile-disabled",
        userId: 10,
        userChatId: 1000,
        canReply: true,
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: false,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 82,
        business_message: {
          message_id: 86,
          date: 1,
          business_connection_id: "business-profile-disabled",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await store.getOffset("default")).toBe(83);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("denies business project Q&A when the stored connection cannot reply", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "Internal Q&A answer." })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const freshConnectionTime = new Date().toISOString();
      await store.upsertBusinessConnection({
        id: "business-cannot-reply",
        userId: 10,
        userChatId: 1000,
        canReply: false,
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 84,
        business_message: {
          message_id: 88,
          date: 1,
          business_connection_id: "business-cannot-reply",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        businessConnectionId: "business-cannot-reply",
      }));
      expect(await store.getOffset("default")).toBe(85);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("denies business project Q&A when read rights are omitted", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "Internal Q&A answer." })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const freshConnectionTime = new Date().toISOString();
      await store.upsertBusinessConnection({
        id: "business-missing-read-rights",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true },
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 85,
        business_message: {
          message_id: 89,
          date: 1,
          business_connection_id: "business-missing-read-rights",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        businessConnectionId: "business-missing-read-rights",
      }));
      expect(await store.getOffset("default")).toBe(86);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("answers fresh business project Q&A when the stored connection update is old", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "Internal Q&A answer." })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const oldConnectionTime = "2000-01-01T00:00:00.000Z";
      await store.upsertBusinessConnection({
        id: "business-stale",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: oldConnectionTime,
        updatedAt: oldConnectionTime,
        lastSeenAt: oldConnectionTime,
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 86,
        business_message: {
          message_id: 90,
          date: Math.floor(Date.now() / 1000),
          business_connection_id: "business-stale",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      await waitForCondition(() =>
        vi.mocked(assistantCodex.answerProjectQuestion).mock.calls.length === 1,
      );
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Internal Q&A answer.",
      ));
      expect(assistantCodex.answerProjectQuestion).toHaveBeenCalledWith(
        expect.objectContaining({ question: "Какие цели проекта?" }),
      );
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        businessConnectionId: "business-stale",
        chatId: "1",
        text: "Internal Q&A answer.",
      }));
      expect(await store.getOffset("default")).toBe(87);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("disables stored business project Q&A access after a business connection update", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "Internal Q&A answer." })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const disabledEventDate = Math.floor(Date.now() / 1000);
      const freshConnectionTime = new Date(
        (disabledEventDate - 1) * 1000,
      ).toISOString();
      await store.upsertBusinessConnection({
        id: "business-revoked",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 88,
        business_message: {
          message_id: 92,
          date: 1,
          business_connection_id: "business-revoked",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });
      await waitForCondition(() =>
        vi.mocked(assistantCodex.answerProjectQuestion).mock.calls.length === 1,
      );
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Internal Q&A answer.",
      ));
      await waitForCondition(async () =>
        (await store.getActiveAssistantTurn("business:business-revoked:1")) ===
          undefined,
      );
      sendMessage.mockClear();

      await service.handleUpdate({
        update_id: 89,
        business_connection: {
          id: "business-revoked",
          user: { id: 11, is_bot: false, first_name: "New Business Owner" },
          user_chat_id: 1000,
          date: disabledEventDate,
          can_reply: false,
          is_enabled: false,
        },
      });

      await service.handleUpdate({
        update_id: 90,
        business_message: {
          message_id: 93,
          date: 3,
          business_connection_id: "business-revoked",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      expect(assistantCodex.answerProjectQuestion).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
      await expect(store.getBusinessConnection("business-revoked")).resolves.toEqual(
        expect.objectContaining({
          userId: 11,
          userChatId: 1000,
          canReply: false,
          isEnabled: false,
          updateId: 89,
        }),
      );
      expect(await store.getOffset("default")).toBe(91);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("allows business project Q&A through profile automation when global Telegram allowlists are empty", async () => {
    const sendMessage = vi.fn();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({
        answer: "Business profile Q&A answer.",
      })),
    };
    const store = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const freshConnectionTime = new Date().toISOString();
      await store.upsertBusinessConnection({
        id: "business-profile-qa",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const service = buildAssistant({
        store,
        sendMessage,
        assistantCodex,
        config: {
          projectQaEnabled: true,
          allowedChatIds: [],
          allowedUserIds: [],
          developerUserIds: [],
          operatorUserIds: [],
          adminUserIds: [],
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await service.handleUpdate({
        update_id: 83,
        business_message: {
          message_id: 87,
          date: 1,
          business_connection_id: "business-profile-qa",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      await waitForCondition(() =>
        vi.mocked(assistantCodex.answerProjectQuestion).mock.calls.length === 1,
      );
      await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
        input.text === "Business profile Q&A answer.",
      ));
      expect(assistantCodex.answerProjectQuestion).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        businessConnectionId: "business-profile-qa",
        text: "Business profile Q&A answer.",
      }));
      expect(await store.getOffset("default")).toBe(84);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("allows profile automation project Q&A when global project Q&A is disabled but keeps private Q&A disabled", async () => {
    const businessSendMessage = vi.fn();
    const businessAssistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({
        answer: "Business profile-only Q&A answer.",
      })),
    };
    const businessStore = new InMemoryTelegramAssistantStore();
    const repoDir = await mkdtemp(join(tmpdir(), "telegram-assistant-repo-"));
    try {
      await writeFile(join(repoDir, "README.md"), "Project overview.");
      const freshConnectionTime = new Date().toISOString();
      await businessStore.upsertBusinessConnection({
        id: "business-profile-only-qa",
        userId: 10,
        userChatId: 1000,
        rights: { can_reply: true, can_read_messages: true },
        isEnabled: true,
        createdAt: freshConnectionTime,
        updatedAt: freshConnectionTime,
        lastSeenAt: freshConnectionTime,
      });
      const businessService = buildAssistant({
        store: businessStore,
        sendMessage: businessSendMessage,
        assistantCodex: businessAssistantCodex,
        config: {
          projectQaEnabled: false,
          allowedChatIds: [],
          allowedUserIds: [],
          developerUserIds: [],
          operatorUserIds: [],
          adminUserIds: [],
          profileAutomation: {
            ...baseTelegramAssistantConfig().profileAutomation,
            enabled: true,
            autoReplyEnabled: true,
            projectQaEnabled: true,
            allowedOwnerIds: ["10"],
            allowedChatIds: ["1"],
          },
        },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await businessService.handleUpdate({
        update_id: 94,
        business_message: {
          message_id: 98,
          date: 1,
          business_connection_id: "business-profile-only-qa",
          chat: { id: 1, type: "private" },
          from: { id: 999, is_bot: false, first_name: "External User" },
          text: "Какие цели проекта?",
        },
      });

      await waitForCondition(() =>
        vi.mocked(businessAssistantCodex.answerProjectQuestion).mock.calls.length === 1,
      );
      await waitForCondition(() => businessSendMessage.mock.calls.some(([input]) =>
        input.text === "Business profile-only Q&A answer.",
      ));
      expect(businessSendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "1",
        businessConnectionId: "business-profile-only-qa",
        text: "Business profile-only Q&A answer.",
      }));

      const privateSendMessage = vi.fn();
      const privateAssistantCodex: FakeAssistantCodexService = {
        answerProjectQuestion: vi.fn(async () => ({
          answer: "Private Q&A must not run.",
        })),
      };
      const privateStore = new InMemoryTelegramAssistantStore();
      const privateService = buildAssistant({
        store: privateStore,
        sendMessage: privateSendMessage,
        assistantCodex: privateAssistantCodex,
        config: { projectQaEnabled: false },
        repositories: [repositoryFixture({ repoPath: repoDir })],
      });

      await privateService.handleUpdate(messageUpdate("Какие цели проекта?", {
        updateId: 95,
        messageId: 99,
      }));

      expect(privateAssistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
      expect(privateSendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        text: "Private Q&A must not run.",
      }));
      await expect(
        privateStore.getActiveAssistantTurn("bot_private:1"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("ignores unmentioned group chatter in mentions-and-replies mode", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        allowedChatIds: ["-100"],
        allowedUserIds: ["10"],
        groupMode: "mentions_and_replies",
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
      botUsername: "assistant_bot",
    });

    await service.handleUpdate({
      update_id: 10,
      message: {
        message_id: 15,
        date: 1,
        chat: { id: -100, type: "supergroup" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "что там по проекту",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.isUpdateProcessed(10)).toBe(true);
    expect(await store.getOffset("default")).toBe(11);
  });

  it("silently ignores unmentioned group chatter before access control denial", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        allowedChatIds: ["-200"],
        allowedUserIds: ["99"],
        developerUserIds: [],
        operatorUserIds: [],
        adminUserIds: [],
        groupMode: "mentions_and_replies",
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
      botUsername: "assistant_bot",
    });

    await service.handleUpdate({
      update_id: 15,
      message: {
        message_id: 20,
        date: 1,
        chat: { id: -100, type: "supergroup" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "что там по проекту",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.isUpdateProcessed(15)).toBe(true);
    expect(await store.getOffset("default")).toBe(16);
  });

  it("ignores group replies to a different bot in mentions-and-replies mode", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        allowedChatIds: ["-100"],
        allowedUserIds: ["10"],
        groupMode: "mentions_and_replies",
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
      botUsername: "assistant_bot",
    });

    await service.handleUpdate({
      update_id: 13,
      message: {
        message_id: 18,
        date: 1,
        chat: { id: -100, type: "supergroup" },
        from: { id: 10, is_bot: false, first_name: "User" },
        reply_to_message: {
          message_id: 17,
          date: 1,
          chat: { id: -100, type: "supergroup" },
          from: {
            id: 777,
            is_bot: true,
            first_name: "Other",
            username: "other_bot",
          },
          text: "previous bot answer",
        },
        text: "статус task_123",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.isUpdateProcessed(13)).toBe(true);
    expect(await store.getOffset("default")).toBe(14);
  });

  it("processes group replies to the assistant bot username case-insensitively", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        allowedChatIds: ["-100"],
        allowedUserIds: ["10"],
        groupMode: "mentions_and_replies",
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
      botUsername: "assistant_bot",
    });

    await service.handleUpdate({
      update_id: 14,
      message: {
        message_id: 19,
        date: 1,
        chat: { id: -100, type: "supergroup" },
        from: { id: 10, is_bot: false, first_name: "User" },
        reply_to_message: {
          message_id: 18,
          date: 1,
          chat: { id: -100, type: "supergroup" },
          from: {
            id: 778,
            is_bot: true,
            first_name: "Assistant",
            username: "Assistant_Bot",
          },
          text: "previous assistant answer",
        },
        text: "статус task_123",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "-100",
      text: "Не могу проверить статус задачи: task tracker недоступен.",
    }));
    expect(await store.getOffset("default")).toBe(15);
  });

  it("requires a write-capable actor for write intents", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        allowedChatIds: ["1"],
        allowedUserIds: [],
        developerUserIds: [],
      },
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 11,
      message: {
        message_id: 16,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 99, is_bot: false, first_name: "Viewer" },
        text: "создай задачу починить регистрацию",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Для действий записи нужен allowlist developer/operator/admin пользователя.",
    }));
    expect(await store.listPendingActions()).toEqual([]);
    expect(await store.getOffset("default")).toBe(12);
  });

  it("creates a task draft pending action and waits for confirmation", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        defaultRepository: "developer",
      },
      taskTracker: readonlyTaskTracker([]),
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 35,
      message: {
        message_id: 99,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "создай задачу починить регистрацию",
      },
    });

    const [action] = await store.listPendingActions({
      conversationKey: "bot_private:1",
      status: "pending",
    });
    expect(action).toMatchObject({
      id: "tgpa_z_2r",
      conversationKey: "bot_private:1",
      chatId: 1,
      userId: 10,
      intent: expect.objectContaining({ name: "create_task_draft" }),
      status: "pending",
      payload: {
        chatId: 1,
        messageId: 99,
        userId: 10,
        externalKey: "telegram:1:99",
        draft: {
          title: "починить регистрацию",
          description: "создай задачу починить регистрацию",
          repositoryName: "developer",
          acceptanceCriteria: [
            "Поведение реализовано и покрыто существующими проверками.",
          ],
          tags: ["telegram"],
        },
      },
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      parseMode: "HTML",
      replyToMessageId: 99,
      text: expect.stringContaining("Создать задачу"),
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "Создать", callback_data: "c:tgpa_z_2r" },
            { text: "Отмена", callback_data: "cancel:tgpa_z_2r" },
          ],
        ],
      },
    }));
    expect(await store.getOffset("default")).toBe(36);
  });

  it("records a human answer for the latest open AI question after confirmation", async () => {
    const taskTracker = fakeTaskTrackerWithAwaitingHumanTask();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = buildAssistant({ store, taskTracker });

    await service.handleUpdate(messageUpdate(
      "ответь что можно продолжать с вариантом А",
      { updateId: 43, messageId: 105 },
    ));
    await service.handleUpdate(messageUpdate("да", {
      updateId: 44,
      messageId: 106,
      date: 2,
    }));

    expect(taskTracker.listTasks).toHaveBeenCalledWith({
      statuses: ["awaiting_human"],
      limit: 500,
    });
    expect(taskTracker.recordHumanAnswer).toHaveBeenCalledOnce();
    expect(taskTracker.recordHumanAnswer).toHaveBeenCalledWith(
      "task_awaiting",
      expect.objectContaining({
        questionId: "question_latest",
        body: expect.stringContaining("вариантом А"),
        command: expect.objectContaining({
          type: "resume",
          rawText: expect.stringContaining("вариантом А"),
        }),
      }),
    );
    await expect(store.listPendingActions({
      conversationKey: "bot_private:1",
      status: "completed",
    })).resolves.toHaveLength(1);
    expect(await store.getOffset("default")).toBe(45);
  });

  it("retries an answer callback from an executing action after answer write failure", async () => {
    const answerCallbackQuery = vi.fn();
    const taskTracker = fakeMutableTaskTrackerWithAwaitingHumanTask({
      failRecordHumanAnswerOnce: true,
    });
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = buildAssistant({
      store,
      taskTracker,
      answerCallbackQuery,
    });

    await service.handleUpdate(messageUpdate(
      "ответь что можно продолжать с вариантом А",
      { updateId: 43, messageId: 105 },
    ));
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:1",
      status: "pending",
    });
    if (!pending) {
      throw new Error("Expected pending telegram answer action.");
    }
    const confirmUpdate = callbackUpdate(
      `confirm:answer_question:${pending.id}`,
      { updateId: 44, callbackQueryId: "cb_answer_1", messageId: 106 },
    );

    await expect(service.handleUpdate(confirmUpdate)).rejects.toThrow(
      "transient answer write failure",
    );

    expect(taskTracker.recordHumanAnswer).toHaveBeenCalledOnce();
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "executing",
    });
    expect(await store.isUpdateProcessed(44)).toBe(false);
    expect(await store.getOffset("default")).toBe(44);

    await service.handleUpdate(confirmUpdate);

    expect(taskTracker.recordHumanAnswer).toHaveBeenCalledTimes(2);
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "completed",
    });
    expect(await store.isUpdateProcessed(44)).toBe(true);
    expect(await store.getOffset("default")).toBe(45);
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_answer_1",
      text: "Записываю ответ...",
    }));
  });

  it("does not record an answer twice when callback retry follows completion failure", async () => {
    const taskTracker = fakeMutableTaskTrackerWithAwaitingHumanTask();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const originalCompletePendingAction = store.completePendingAction.bind(store);
    const completePendingAction = vi.spyOn(store, "completePendingAction")
      .mockRejectedValueOnce(new Error("complete pending action failed"))
      .mockImplementation(originalCompletePendingAction);
    const service = buildAssistant({ store, taskTracker });

    await service.handleUpdate(messageUpdate(
      "ответь что можно продолжать с вариантом А",
      { updateId: 43, messageId: 105 },
    ));
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:1",
      status: "pending",
    });
    if (!pending) {
      throw new Error("Expected pending telegram answer action.");
    }
    const confirmUpdate = callbackUpdate(
      `confirm:answer_question:${pending.id}`,
      { updateId: 44, callbackQueryId: "cb_answer_2", messageId: 106 },
    );

    await expect(service.handleUpdate(confirmUpdate)).rejects.toThrow(
      "complete pending action failed",
    );

    expect(taskTracker.recordHumanAnswer).toHaveBeenCalledOnce();
    expect(completePendingAction).toHaveBeenCalledOnce();
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "executing",
    });
    expect(await store.isUpdateProcessed(44)).toBe(false);
    expect(await store.getOffset("default")).toBe(44);

    await service.handleUpdate(confirmUpdate);

    expect(taskTracker.recordHumanAnswer).toHaveBeenCalledOnce();
    expect(completePendingAction).toHaveBeenCalledTimes(2);
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "completed",
    });
    expect(await store.isUpdateProcessed(44)).toBe(true);
    expect(await store.getOffset("default")).toBe(45);
  });

  it("creates an internal task from a confirmed draft without idempotencyKey", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const taskTracker = new InMemoryTaskTrackerClient({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const createTaskSpy = vi.spyOn(taskTracker, "createTask");
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        defaultRepository: "developer",
      },
      taskTracker,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 36,
      message: {
        message_id: 99,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "создай задачу починить регистрацию",
      },
    });
    await service.handleUpdate({
      update_id: 37,
      message: {
        message_id: 100,
        date: 2,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    });

    expect(createTaskSpy).toHaveBeenCalledOnce();
    const createdInput = createTaskSpy.mock.calls[0]?.[0];
    expect(createdInput).toBeDefined();
    expect(createdInput).toEqual({
      title: "починить регистрацию",
      description: "создай задачу починить регистрацию",
      source: {
        kind: "system",
        provider: "telegram",
        externalKey: "telegram:1:99",
      },
      createdBy: {
        owner: "external_source",
        id: "telegram",
        displayName: "Telegram Assistant",
      },
      repositoryName: "developer",
      tags: ["telegram"],
      acceptanceCriteria: [
        "Поведение реализовано и покрыто существующими проверками.",
      ],
      externalRefs: [{ provider: "telegram", externalKey: "telegram:1:99" }],
      externalSnapshot: { chatId: 1, messageId: 99, userId: 10 },
    });
    expect(createdInput as unknown as Record<string, unknown>).not.toHaveProperty(
      "idempotencyKey",
    );

    const [action] = await store.listPendingActions({
      conversationKey: "bot_private:1",
    });
    expect(action).toMatchObject({ status: "completed" });

    const [subscription] = await store.listTaskSubscriptions("bot_private:1");
    expect(subscription).toMatchObject({
      conversationKey: "bot_private:1",
      chatId: 1,
      userId: 10,
    });
    const taskId = subscription?.taskId;
    expect(taskId).toMatch(/^task_/);
    if (taskId === undefined) {
      throw new Error("Expected telegram task subscription task id.");
    }
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "1",
      replyToMessageId: 100,
      text: expect.stringContaining(taskId),
    }));
    expect(await store.getOffset("default")).toBe(38);
  });

  it("retries text approval from an executing draft after tracker write failure", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const createdTask = taskFixture({
      id: "task_retry_1",
      title: "починить регистрацию",
      source: {
        kind: "system",
        provider: "telegram",
        externalKey: "telegram:1:99",
      },
      createdBy: {
        owner: "external_source",
        id: "telegram",
        displayName: "Telegram Assistant",
      },
      externalRefs: [
        {
          id: "ref-retry-1",
          taskId: "task_retry_1",
          provider: "telegram",
          externalKey: "telegram:1:99",
          createdAt: baseTime,
        },
      ],
    });
    let storedTask: TaskRecord | null = null;
    const findTaskByExternalRef = vi.fn(
      async (provider: string, externalKey: string): Promise<TaskRecord | null> => {
        if (provider === "telegram" && externalKey === "telegram:1:99") {
          return storedTask;
        }
        return null;
      },
    );
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => {
      storedTask = createdTask;
      throw new Error("transient tracker write failure");
    });
    const taskTracker = {
      ...readonlyTaskTracker([]),
      createTask,
      findTaskByExternalRef,
    } as unknown as TaskTrackerClient;
    const service = buildAssistant({ store, taskTracker, sendMessage });

    await service.handleUpdate(messageUpdate("создай задачу починить регистрацию", {
      updateId: 36,
      messageId: 99,
    }));
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:1",
      status: "pending",
    });
    if (!pending) {
      throw new Error("Expected pending telegram action.");
    }

    const approvalUpdate = messageUpdate("да", {
      updateId: 37,
      messageId: 100,
      date: 2,
    });
    await expect(service.handleUpdate(approvalUpdate)).rejects.toThrow(
      "transient tracker write failure",
    );

    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "executing",
    });
    expect(await store.isUpdateProcessed(37)).toBe(false);
    expect(await store.getOffset("default")).toBe(37);

    await service.handleUpdate(approvalUpdate);

    expect(findTaskByExternalRef).toHaveBeenCalledTimes(2);
    expect(createTask).toHaveBeenCalledOnce();
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(store.listPendingActions({
      conversationKey: "bot_private:1",
    })).resolves.toHaveLength(1);
    await expect(store.listTaskSubscriptions("bot_private:1")).resolves.toEqual([
      expect.objectContaining({ taskId: "task_retry_1" }),
    ]);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "1",
      replyToMessageId: 100,
      text: "Задача создана: task_retry_1",
    }));
    expect(await store.isUpdateProcessed(37)).toBe(true);
    expect(await store.getOffset("default")).toBe(38);
  });

  it("handles confirm create-task callback and answers callback query", async () => {
    const answerCallbackQuery = vi.fn();
    const taskTracker = fakeTaskTracker();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = buildAssistant({ store, taskTracker, answerCallbackQuery });

    await service.handleUpdate(messageUpdate("создай задачу починить регистрацию"));
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:1",
    });
    if (!pending) {
      throw new Error("Expected pending telegram action.");
    }

    await service.handleUpdate(callbackUpdate(`c:${pending.id}`));

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_1",
    }));
    expect(taskTracker.createTask).toHaveBeenCalled();
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("answers expired or already consumed callbacks without executing the action", async () => {
    const answerCallbackQuery = vi.fn();
    const taskTracker = fakeTaskTracker();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = buildAssistant({ store, taskTracker, answerCallbackQuery });

    await service.handleUpdate(messageUpdate("создай задачу починить регистрацию"));
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:1",
    });
    if (!pending) {
      throw new Error("Expected pending telegram action.");
    }
    await store.completePendingAction(pending.id, { status: "cancelled" });

    await service.handleUpdate(callbackUpdate(`c:${pending.id}`));

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_1",
      text: expect.stringContaining("уже"),
    }));
    expect(taskTracker.createTask).not.toHaveBeenCalled();
  });

  it("answers user mismatch callbacks without mutating or writing", async () => {
    const answerCallbackQuery = vi.fn();
    const taskTracker = fakeTaskTracker();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = buildAssistant({
      store,
      taskTracker,
      answerCallbackQuery,
      config: {
        allowedUserIds: ["10", "99"],
        developerUserIds: ["10", "99"],
      },
    });

    await service.handleUpdate(messageUpdate("создай задачу починить регистрацию"));
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:1",
    });
    if (!pending) {
      throw new Error("Expected pending telegram action.");
    }

    await service.handleUpdate(callbackUpdate(`c:${pending.id}`, { userId: 99 }));

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_1",
      text: "Это действие создано для другого пользователя.",
    }));
    expect(taskTracker.createTask).not.toHaveBeenCalled();
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("answers overlong callback data without executing an action", async () => {
    const answerCallbackQuery = vi.fn();
    const taskTracker = fakeTaskTracker();
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({ store, taskTracker, answerCallbackQuery });

    await service.handleUpdate(callbackUpdate("x".repeat(65)));

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_1",
    }));
    expect(taskTracker.createTask).not.toHaveBeenCalled();
    expect(await store.isUpdateProcessed(101)).toBe(true);
    expect(await store.getOffset("default")).toBe(102);
  });

  it("cancels create-task callbacks and clears queued messages", async () => {
    const answerCallbackQuery = vi.fn();
    const taskTracker = fakeTaskTracker();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = buildAssistant({ store, taskTracker, answerCallbackQuery });

    await service.handleUpdate(messageUpdate("создай задачу починить регистрацию"));
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:1",
    });
    if (!pending) {
      throw new Error("Expected pending telegram action.");
    }
    await store.enqueueMessage({
      id: "queued-follow-up",
      conversationKey: "bot_private:1",
      chatId: 1,
      userId: 10,
      message: {
        id: "telegram:queued",
        updateId: 500,
        conversationKey: "bot_private:1",
        source: "bot_private",
        chatId: 1,
        userId: 10,
        messageId: 501,
        text: "еще вопрос",
        redactedText: "еще вопрос",
        receivedAt: "2026-05-30T08:00:00.000Z",
      },
      status: "queued",
      createdAt: "2026-05-30T08:00:00.000Z",
      expiresAt: "2099-01-13T08:00:00.000Z",
    });
    const cancelQueuedMessages = vi.spyOn(store, "cancelQueuedMessages");

    await service.handleUpdate(callbackUpdate(`cancel:${pending.id}`));

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_1",
      text: expect.stringContaining("отмен"),
    }));
    expect(cancelQueuedMessages).toHaveBeenCalledWith("bot_private:1", {
      cancelledAt: expect.any(String),
    });
    expect(taskTracker.createTask).not.toHaveBeenCalled();
    await expect(store.listQueuedMessages("bot_private:1")).resolves.toHaveLength(0);
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("refreshes pending action gauges after cancelling a create-task callback", async () => {
    const metrics = fakeObservability();
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      observability: metrics.telemetry,
    });

    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "tgpa_cancel_gauge",
    }));

    await service.handleUpdate(callbackUpdate("cancel:tgpa_cancel_gauge", {
      updateId: 49,
      callbackQueryId: "cb_cancel_gauge",
    }));

    expect(metrics.gauges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram_pending_actions_total",
        labels: { state: "pending" },
        value: 0,
      }),
      expect.objectContaining({
        name: "telegram_pending_actions_total",
        labels: { state: "cancelled" },
        value: 1,
      }),
    ]));
  });

  it("handles select task callbacks and answers callback query", async () => {
    const answerCallbackQuery = vi.fn();
    const sendMessage = vi.fn();
    const taskTracker = readonlyTaskTracker([
      taskFixture({
        id: "task_123",
        title: "Починить регистрацию",
        status: "review",
      }),
    ]);
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      taskTracker,
      sendMessage,
      answerCallbackQuery,
    });

    await service.handleUpdate(callbackUpdate("select_task:task_123"));

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_1",
    }));
    expect(taskTracker.getTask).toHaveBeenCalledWith("task_123");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      parseMode: "HTML",
      text: expect.stringContaining("<b>task_123: Починить регистрацию</b>"),
    }));
  });

  it("does not create a duplicate task for repeated approvals with the same external ref", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const createdTask = taskFixture({
      id: "task_telegram_1",
      title: "починить регистрацию",
      source: {
        kind: "system",
        provider: "telegram",
        externalKey: "telegram:1:99",
      },
      createdBy: {
        owner: "external_source",
        id: "telegram",
        displayName: "Telegram Assistant",
      },
      externalRefs: [
        {
          id: "ref-1",
          taskId: "task_telegram_1",
          provider: "telegram",
          externalKey: "telegram:1:99",
          createdAt: baseTime,
        },
      ],
    });
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => (
      createdTask
    ));
    const findTaskByExternalRef = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdTask);
    const taskTracker = {
      ...readonlyTaskTracker([]),
      createTask,
      findTaskByExternalRef,
    } as unknown as TaskTrackerClient;
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await store.upsertPendingAction({
      id: "tgpa_duplicate_first",
      conversationKey: "bot_private:1",
      chatId: 1,
      userId: 10,
      intent: {
        name: "create_task_draft",
        confidence: 1,
        rawText: "создай задачу починить регистрацию",
        requiresConfirmation: true,
        safetyLevel: "confirm_write",
      },
      payload: {
        chatId: 1,
        messageId: 99,
        userId: 10,
        externalKey: "telegram:1:99",
        draft: {
          title: "починить регистрацию",
          description: "создай задачу починить регистрацию",
          repositoryName: "developer",
          acceptanceCriteria: [
            "Поведение реализовано и покрыто существующими проверками.",
          ],
          tags: ["telegram"],
        },
      },
      status: "pending",
      createdAt: "2026-05-30T08:00:00.000Z",
      updatedAt: "2026-05-30T08:00:00.000Z",
      expiresAt: "2099-01-13T08:00:00.000Z",
    });
    await service.handleUpdate({
      update_id: 38,
      message: {
        message_id: 100,
        date: 2,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    });

    await store.upsertPendingAction({
      id: "tgpa_duplicate_second",
      conversationKey: "bot_private:1",
      chatId: 1,
      userId: 10,
      intent: {
        name: "create_task_draft",
        confidence: 1,
        rawText: "создай задачу починить регистрацию",
        requiresConfirmation: true,
        safetyLevel: "confirm_write",
      },
      payload: {
        chatId: 1,
        messageId: 99,
        userId: 10,
        externalKey: "telegram:1:99",
        draft: {
          title: "починить регистрацию",
          description: "создай задачу починить регистрацию",
          repositoryName: "developer",
          acceptanceCriteria: [
            "Поведение реализовано и покрыто существующими проверками.",
          ],
          tags: ["telegram"],
        },
      },
      status: "pending",
      createdAt: "2026-05-30T08:01:00.000Z",
      updatedAt: "2026-05-30T08:01:00.000Z",
      expiresAt: "2099-01-13T08:01:00.000Z",
    });
    await service.handleUpdate({
      update_id: 39,
      message: {
        message_id: 101,
        date: 3,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    });

    expect(findTaskByExternalRef).toHaveBeenCalledTimes(2);
    expect(findTaskByExternalRef).toHaveBeenCalledWith("telegram", "telegram:1:99");
    expect(createTask).toHaveBeenCalledOnce();
    await expect(store.listTaskSubscriptions("bot_private:1")).resolves.toEqual([
      expect.objectContaining({ taskId: "task_telegram_1" }),
    ]);
    await expect(store.listPendingActions({
      conversationKey: "bot_private:1",
      status: "completed",
    })).resolves.toHaveLength(2);
  });

  it("registers Telegram attachments when approval resolves an existing external ref", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const existingTask = taskFixture({
      id: "task_existing_attachment",
      title: "починить регистрацию",
      source: {
        kind: "system",
        provider: "telegram",
        externalKey: "telegram:1:99",
      },
      createdBy: {
        owner: "external_source",
        id: "telegram",
        displayName: "Telegram Assistant",
      },
      externalRefs: [
        {
          id: "ref-1",
          taskId: "task_existing_attachment",
          provider: "telegram",
          externalKey: "telegram:1:99",
          createdAt: baseTime,
        },
      ],
    });
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => {
      throw new Error("createTask should not be called");
    });
    const appendEventOnce = vi.fn(async (): Promise<boolean> => true);
    const findTaskByExternalRef = vi.fn(async (): Promise<TaskRecord | null> => (
      existingTask
    ));
    const taskTracker = {
      ...readonlyTaskTracker([existingTask]),
      createTask,
      findTaskByExternalRef,
      appendEventOnce,
    } as unknown as TaskTrackerClient;
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });
    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "tgpa_existing_attachment",
      payload: {
        chatId: 1,
        messageId: 99,
        userId: 10,
        externalKey: "telegram:1:99",
        draft: {
          title: "починить регистрацию",
          description: "создай задачу починить регистрацию",
          repositoryName: "developer",
          acceptanceCriteria: [
            "Поведение реализовано и покрыто существующими проверками.",
          ],
          tags: ["telegram"],
        },
        attachments: [
          {
            type: "document",
            fileId: "file_1",
            fileName: "screen.png",
            mimeType: "image/png",
            size: 1000,
          },
        ],
      },
    }));

    await service.handleUpdate({
      update_id: 40,
      message: {
        message_id: 102,
        date: 2,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    });

    expect(createTask).not.toHaveBeenCalled();
    expect(appendEventOnce).toHaveBeenCalledOnce();
    expect(appendEventOnce).toHaveBeenCalledWith("task_existing_attachment", expect.objectContaining({
      kind: "attachments_registered",
      payload: expect.objectContaining({
        provider: "telegram",
        externalKey: "telegram:1:99",
        registrationKey: "telegram:telegram:1:99:attachments_registered",
      }),
    }));
    await expect(store.getPendingAction("tgpa_existing_attachment")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("retries Telegram attachment registration after task creation succeeds but event append fails", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const createdTask = taskFixture({
      id: "task_retry_attachment",
      title: "починить регистрацию",
      source: {
        kind: "system",
        provider: "telegram",
        externalKey: "telegram:1:99",
      },
      createdBy: {
        owner: "external_source",
        id: "telegram",
        displayName: "Telegram Assistant",
      },
      externalRefs: [
        {
          id: "ref-1",
          taskId: "task_retry_attachment",
          provider: "telegram",
          externalKey: "telegram:1:99",
          createdAt: baseTime,
        },
      ],
    });
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => (
      createdTask
    ));
    const appendEventOnce = vi.fn()
      .mockRejectedValueOnce(new Error("append failed"))
      .mockResolvedValueOnce(true);
    const findTaskByExternalRef = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdTask);
    const taskTracker = {
      ...readonlyTaskTracker([createdTask]),
      createTask,
      findTaskByExternalRef,
      appendEventOnce,
    } as unknown as TaskTrackerClient;
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });
    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "tgpa_retry_attachment",
      payload: {
        chatId: 1,
        messageId: 99,
        userId: 10,
        externalKey: "telegram:1:99",
        draft: {
          title: "починить регистрацию",
          description: "создай задачу починить регистрацию",
          repositoryName: "developer",
          acceptanceCriteria: [
            "Поведение реализовано и покрыто существующими проверками.",
          ],
          tags: ["telegram"],
        },
        attachments: [
          {
            type: "document",
            fileId: "file_1",
            fileName: "screen.png",
            mimeType: "image/png",
            size: 1000,
          },
        ],
      },
    }));

    await expect(service.handleUpdate({
      update_id: 43,
      message: {
        message_id: 105,
        date: 2,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    })).rejects.toThrow("append failed");

    await expect(store.getPendingAction("tgpa_retry_attachment")).resolves.toMatchObject({
      status: "executing",
    });

    await service.handleUpdate({
      update_id: 44,
      message: {
        message_id: 106,
        date: 3,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    });

    expect(createTask).toHaveBeenCalledOnce();
    expect(appendEventOnce).toHaveBeenCalledTimes(2);
    expect(appendEventOnce).toHaveBeenLastCalledWith("task_retry_attachment", expect.objectContaining({
      kind: "attachments_registered",
      payload: expect.objectContaining({
        provider: "telegram",
        externalKey: "telegram:1:99",
        registrationKey: "telegram:telegram:1:99:attachments_registered",
      }),
    }));
    await expect(store.getPendingAction("tgpa_retry_attachment")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("deduplicates duplicate Telegram attachment registration callbacks with a stale task snapshot", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const storedEvents: TaskEventInput[] = [];
    const existingTask = taskFixture({
      id: "task_concurrent_attachment",
      title: "починить регистрацию",
      source: {
        kind: "system",
        provider: "telegram",
        externalKey: "telegram:1:99",
      },
      createdBy: {
        owner: "external_source",
        id: "telegram",
        displayName: "Telegram Assistant",
      },
      externalRefs: [
        {
          id: "ref-1",
          taskId: "task_concurrent_attachment",
          provider: "telegram",
          externalKey: "telegram:1:99",
          createdAt: baseTime,
        },
      ],
    });
    const appendEvent = vi.fn(async (_taskId: string, input: TaskEventInput): Promise<void> => {
      storedEvents.push(input);
    });
    const appendEventOnce = vi.fn(async (
      _taskId: string,
      input: TaskEventInput,
    ): Promise<boolean> => {
      const registrationKey = input.payload?.registrationKey;
      if (typeof registrationKey === "string" && storedEvents.some((event) => (
        event.kind === input.kind &&
        event.payload?.registrationKey === registrationKey
      ))) {
        return false;
      }
      storedEvents.push(input);
      return true;
    });
    const findTaskByExternalRef = vi.fn(async (): Promise<TaskRecord | null> => {
      return {
        ...existingTask,
        events: [],
      };
    });
    const taskTracker = {
      ...readonlyTaskTracker([existingTask]),
      findTaskByExternalRef,
      appendEvent,
      appendEventOnce,
    } as unknown as TaskTrackerClient;
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });
    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "tgpa_concurrent_attachment",
      status: "executing",
      payload: {
        chatId: 1,
        messageId: 99,
        userId: 10,
        externalKey: "telegram:1:99",
        draft: {
          title: "починить регистрацию",
          description: "создай задачу починить регистрацию",
          repositoryName: "developer",
          acceptanceCriteria: [
            "Поведение реализовано и покрыто существующими проверками.",
          ],
          tags: ["telegram"],
        },
        attachments: [
          {
            type: "document",
            fileId: "file_1",
            fileName: "screen.png",
            mimeType: "image/png",
            size: 1000,
          },
        ],
      },
    }));

    await service.handleUpdate(callbackUpdate("c:tgpa_concurrent_attachment", {
      updateId: 45,
      callbackQueryId: "cb_duplicate_1",
    }));
    await store.upsertPendingAction({
      ...(await store.getPendingAction("tgpa_concurrent_attachment"))!,
      status: "executing",
    });
    await service.handleUpdate(callbackUpdate("c:tgpa_concurrent_attachment", {
      updateId: 46,
      callbackQueryId: "cb_duplicate_2",
    }));

    expect(storedEvents.filter((event) => event.kind === "attachments_registered"))
      .toHaveLength(1);
    expect(storedEvents[0]).toMatchObject({
      kind: "attachments_registered",
      payload: expect.objectContaining({
        provider: "telegram",
        externalKey: "telegram:1:99",
        registrationKey: "telegram:telegram:1:99:attachments_registered",
      }),
    });
  });

  it("uses an older valid pending draft when the newest matching draft is expired", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:10:00.000Z"),
    });
    const createdTask = taskFixture({
      id: "task_valid_draft",
      title: "починить регистрацию",
    });
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => (
      createdTask
    ));
    const findTaskByExternalRef = vi.fn(async (): Promise<TaskRecord | null> => null);
    const taskTracker = {
      ...readonlyTaskTracker([]),
      createTask,
      findTaskByExternalRef,
    } as unknown as TaskTrackerClient;
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "tgpa_valid_older",
      payload: {
        chatId: 1,
        messageId: 98,
        userId: 10,
        externalKey: "telegram:1:98",
        draft: {
          title: "починить регистрацию",
          description: "создай задачу починить регистрацию",
          repositoryName: "developer",
          acceptanceCriteria: [
            "Поведение реализовано и покрыто существующими проверками.",
          ],
          tags: ["telegram"],
        },
      },
      createdAt: "2026-05-30T08:00:00.000Z",
      updatedAt: "2026-05-30T08:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "tgpa_expired_newer",
      createdAt: "2026-05-30T08:05:00.000Z",
      updatedAt: "2026-05-30T08:05:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    }));

    await service.handleUpdate({
      update_id: 41,
      message: {
        message_id: 103,
        date: 2,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    });

    expect(findTaskByExternalRef).toHaveBeenCalledOnce();
    expect(findTaskByExternalRef).toHaveBeenCalledWith("telegram", "telegram:1:98");
    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({
      externalRefs: [{ provider: "telegram", externalKey: "telegram:1:98" }],
      externalSnapshot: { chatId: 1, messageId: 98, userId: 10 },
    });
    await expect(store.getPendingAction("tgpa_valid_older")).resolves.toMatchObject({
      status: "completed",
    });
    await expect(store.getPendingAction("tgpa_expired_newer")).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("does not resolve or create a task from an expired executing draft", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:10:00.000Z"),
    });
    const findTaskByExternalRef = vi.fn(async (): Promise<TaskRecord | null> => (
      taskFixture({ id: "task_expired" })
    ));
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => (
      taskFixture({ id: "task_expired" })
    ));
    const taskTracker = {
      ...readonlyTaskTracker([]),
      createTask,
      findTaskByExternalRef,
    } as unknown as TaskTrackerClient;
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });
    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "tgpa_expired_executing",
      status: "executing",
      consumedAt: "2026-05-30T08:00:00.000Z",
      createdAt: "2026-05-30T08:00:00.000Z",
      updatedAt: "2026-05-30T08:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    }));

    await service.handleUpdate({
      update_id: 42,
      message: {
        message_id: 104,
        date: 2,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "да",
      },
    });

    expect(findTaskByExternalRef).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Нет ожидающего действия для подтверждения.",
    }));
    await expect(store.listTaskSubscriptions("bot_private:1")).resolves.toEqual([]);
  });

  it("does not save a task draft when the task tracker is unavailable", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker: undefined,
      repositories: [repositoryFixture()],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 40,
      message: {
        message_id: 102,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "создай задачу починить регистрацию",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Не могу создать задачу: task tracker недоступен.",
    }));
    expect(await store.listPendingActions()).toEqual([]);
    expect(await store.getOffset("default")).toBe(41);
  });

  it("reports task status as unavailable when no task tracker is configured", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 12,
      message: {
        message_id: 17,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "статус task_123",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Не могу проверить статус задачи: task tracker недоступен.",
    }));
    expect(await store.isUpdateProcessed(12)).toBe(true);
    expect(await store.getOffset("default")).toBe(13);
  });

  it("answers task status from the internal task tracker for viewer users", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const taskTracker = readonlyTaskTracker([
      taskFixture({
        id: "task_123",
        title: "Починить регистрацию",
        status: "review",
        events: [
          {
            id: "event-1",
            taskId: "task_123",
            kind: "status_changed",
            source: "worker_agent",
            message: "Открыт MR и идет review",
            createdAt: "2026-05-30T08:10:00.000Z",
          },
        ],
      }),
    ]);
    const service = new TelegramAssistantService({
      store,
      config: {
        ...baseTelegramAssistantConfig(),
        developerUserIds: [],
      },
      taskTracker,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 16,
      message: {
        message_id: 21,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "Viewer" },
        text: "что там task_123",
      },
    });

    expect(taskTracker.listTasks).toHaveBeenCalledWith({ limit: 500 });
    expect(taskTracker.getTask).toHaveBeenCalledWith("task_123");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      parseMode: "HTML",
      disableWebPagePreview: true,
      replyToMessageId: 21,
      text: expect.stringContaining("<b>task_123: Починить регистрацию</b>"),
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Статус: <code>review</code>"),
    }));
    expect(await store.getOffset("default")).toBe(17);
  });

  it("asks the user to choose when task status has multiple candidates", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const taskTracker = readonlyTaskTracker([
      taskFixture({ id: "task_1", title: "Починить регистрацию через email" }),
      taskFixture({ id: "task_2", title: "Починить регистрацию через SSO" }),
    ]);
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 17,
      message: {
        message_id: 22,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "что там по регистрации",
      },
    });

    expect(taskTracker.getTask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      parseMode: "HTML",
      replyMarkup: {
        inline_keyboard: [
          [{ text: "task_1: Починить регистрацию через email", callback_data: "select_task:task_1" }],
          [{ text: "task_2: Починить регистрацию через SSO", callback_data: "select_task:task_2" }],
        ],
      },
    }));
  });

  it("asks for clarification when no task status candidate is found", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const taskTracker = readonlyTaskTracker([
      taskFixture({ id: "task_1", title: "Починить регистрацию" }),
    ]);
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [],
      telegram: { sendMessage, answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 18,
      message: {
        message_id: 23,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "что там по биллингу",
      },
    });

    expect(taskTracker.getTask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Не нашел задачу. Можешь уточнить тему или task id?",
    }));
  });

  it("records a redacted user message reference before sending the intent response", async () => {
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker: undefined,
      repositories: [],
      telegram: { sendMessage: vi.fn(), answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate({
      update_id: 9,
      message: {
        message_id: 14,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 10, is_bot: false, first_name: "User" },
        text: "TOKEN=secret",
      },
    });

    await expect(store.listMessageRefs("bot_private:1")).resolves.toEqual([
      expect.objectContaining({
        id: "message-ref:9:14",
        chatId: 1,
        messageId: 14,
        source: "user",
        redactedText: "TOKEN=[redacted]",
        createdAt: "1970-01-01T00:00:01.000Z",
        expiresAt: "1970-01-15T00:00:01.000Z",
      }),
    ]);
  });

  it("records Telegram assistant metrics without raw message text labels", async () => {
    const metrics = fakeObservability();
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      taskTracker: fakeTaskTracker(),
      observability: metrics.telemetry,
    });

    await service.handleUpdate(messageUpdate("создай задачу TOKEN=secret", {
      updateId: 950,
      messageId: 950,
    }));

    expect(metrics.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "telegram_updates_received_total" }),
      expect.objectContaining({
        name: "telegram_updates_processed_total",
        labels: { outcome: "success" },
      }),
      expect.objectContaining({
        name: "telegram_intents_total",
        labels: { intent: "create_task_draft", outcome: "success" },
      }),
      expect.objectContaining({
        name: "telegram_messages_sent_total",
        labels: { outcome: "success" },
      }),
    ]));
    expect(metrics.histograms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram_processing_duration_seconds",
        labels: { intent: "create_task_draft" },
      }),
    ]));
    expect(metrics.gauges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram_pending_actions_total",
        labels: { state: "pending" },
        value: 1,
      }),
    ]));
    expect(JSON.stringify({
      counters: metrics.counters,
      histograms: metrics.histograms,
      gauges: metrics.gauges,
    })).not.toContain("TOKEN=secret");
  });

  it("enforces the daily task creation limit before creating pending actions", async () => {
    const sendMessage = vi.fn();
    const metrics = fakeObservability();
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      sendMessage,
      taskTracker: fakeTaskTracker(),
      observability: metrics.telemetry,
      config: { userTaskCreationDailyLimit: 1 },
    });

    await service.handleUpdate(messageUpdate("создай задачу первую", {
      updateId: 960,
      messageId: 960,
    }));
    await service.handleUpdate(messageUpdate("создай задачу вторую", {
      updateId: 961,
      messageId: 961,
    }));

    await expect(store.listPendingActions()).resolves.toHaveLength(1);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Дневной лимит создания задач исчерпан.",
    }));
    expect(metrics.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram_rate_limited_total",
        labels: { direction: "inbound" },
      }),
    ]));
  });

  it("enforces the daily task creation limit for business owner-approval pending actions", async () => {
    const sendMessage = vi.fn();
    const metrics = fakeObservability();
    const store = new InMemoryTelegramAssistantStore();
    const connectionTime = new Date().toISOString();
    await store.upsertBusinessConnection({
      id: "business-task-limit",
      userId: 10,
      userChatId: 1000,
      rights: { can_reply: true, can_read_messages: true },
      isEnabled: true,
      createdAt: connectionTime,
      updatedAt: connectionTime,
      lastSeenAt: connectionTime,
    });
    const service = buildAssistant({
      store,
      sendMessage,
      taskTracker: fakeTaskTracker(),
      observability: metrics.telemetry,
      config: {
        userTaskCreationDailyLimit: 1,
        profileAutomation: {
          ...baseTelegramAssistantConfig().profileAutomation,
          enabled: true,
          requireOwnerApproval: true,
          allowedOwnerIds: ["10"],
          allowedChatIds: ["1"],
        },
      },
    });

    await service.handleUpdate({
      update_id: 982,
      business_message: {
        message_id: 982,
        date: 1,
        business_connection_id: "business-task-limit",
        chat: { id: 1, type: "private" },
        from: { id: 999, is_bot: false, first_name: "External User" },
        text: "создай задачу первую",
      },
    });
    await service.handleUpdate({
      update_id: 983,
      business_message: {
        message_id: 983,
        date: 2,
        business_connection_id: "business-task-limit",
        chat: { id: 1, type: "private" },
        from: { id: 999, is_bot: false, first_name: "External User" },
        text: "создай задачу вторую",
      },
    });

    await expect(store.listPendingActions()).resolves.toHaveLength(1);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "1000",
      text: "Дневной лимит создания задач исчерпан.",
    }));
    expect(metrics.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram_rate_limited_total",
        labels: { direction: "inbound" },
      }),
    ]));
  });

  it("enforces the daily Assistant Codex Q&A limit before starting a turn", async () => {
    const sendMessage = vi.fn();
    const metrics = fakeObservability();
    const store = new InMemoryTelegramAssistantStore();
    const assistantCodex: FakeAssistantCodexService = {
      answerProjectQuestion: vi.fn(async () => ({ answer: "Ответ проекта." })),
    };
    const projectSourceProvider: TelegramAssistantProjectSourceProvider = {
      collectProjectSources: vi.fn(async () => [
        { id: "README.md", body: "Project docs." },
      ]),
    };
    const service = buildAssistant({
      store,
      sendMessage,
      assistantCodex,
      projectSourceProvider,
      observability: metrics.telemetry,
      config: {
        projectQaEnabled: true,
        taskCreationEnabled: false,
        userCodexQaDailyLimit: 1,
      },
    });

    await service.handleUpdate(messageUpdate("как устроен проект?", {
      updateId: 970,
      messageId: 970,
    }));
    await waitForCondition(() => sendMessage.mock.calls.some(([input]) =>
      input.text === "Ответ проекта.",
    ));
    await service.handleUpdate(messageUpdate("а как запускать тесты?", {
      updateId: 971,
      messageId: 971,
    }));

    expect(assistantCodex.answerProjectQuestion).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "1",
      text: "Дневной лимит проектного Q&A исчерпан.",
    }));
    await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toBeUndefined();
  });

  it("backs off outbound Telegram retry_after before failing an assistant send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));
    try {
      const metrics = fakeObservability();
      const store = new InMemoryTelegramAssistantStore();
      const retryAfter = new TelegramRetryAfterError("sendMessage", 2);
      const service = buildAssistant({
        store,
        observability: metrics.telemetry,
        sendMessage: vi.fn().mockRejectedValue(retryAfter),
        config: {
          allowedChatIds: ["2"],
          allowedUserIds: ["99"],
        },
      });
      let settled = false;
      let rejection: unknown;

      const handled = service.handleUpdate(messageUpdate("hello", {
        updateId: 980,
        messageId: 980,
      })).catch((error) => {
        rejection = error;
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      expect(await store.isUpdateProcessed(980)).toBe(false);
      expect(metrics.counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "telegram_rate_limited_total",
          labels: { direction: "outbound" },
        }),
      ]));

      await vi.advanceTimersByTimeAsync(1);
      await handled;

      expect(settled).toBe(true);
      expect(rejection).toBe(retryAfter);
      expect(await store.isUpdateProcessed(980)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off outbound Telegram retry_after before failing a callback answer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));
    try {
      const metrics = fakeObservability();
      const store = new InMemoryTelegramAssistantStore();
      const retryAfter = new TelegramRetryAfterError("answerCallbackQuery", 2);
      const service = buildAssistant({
        store,
        observability: metrics.telemetry,
        answerCallbackQuery: vi.fn().mockRejectedValue(retryAfter),
      });
      let settled = false;
      let rejection: unknown;

      const handled = service.handleUpdate(callbackUpdate("invalid", {
        updateId: 981,
        callbackQueryId: "callback_retry_after",
      })).catch((error) => {
        rejection = error;
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      expect(await store.isUpdateProcessed(981)).toBe(false);
      expect(metrics.counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "telegram_rate_limited_total",
          labels: { direction: "outbound" },
        }),
      ]));

      await vi.advanceTimersByTimeAsync(1);
      await handled;

      expect(settled).toBe(true);
      expect(rejection).toBe(retryAfter);
      expect(await store.isUpdateProcessed(981)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("purges Telegram conversation data through an admin-only maintenance helper", async () => {
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      config: {
        adminUserIds: ["10"],
      },
    });
    await store.recordMessageRef({
      id: "message-ref:purge",
      conversationKey: "bot_private:1",
      chatId: 1,
      messageId: 10,
      source: "user",
      redactedText: "redacted",
      createdAt: baseTime,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store.enqueueMessage({
      id: "queued:purge",
      conversationKey: "bot_private:1",
      chatId: 1,
      userId: 10,
      message: messageUpdate("queued").message as any,
      status: "queued",
      createdAt: baseTime,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store.startAssistantTurn({
      id: "assistant-turn:purge",
      conversationKey: "bot_private:1",
      status: "running",
      startedAt: baseTime,
    });
    await store.upsertPendingAction(createTaskDraftPendingAction({
      id: "pending-action:purge",
      conversationKey: "bot_private:1",
    }));

    const purged = await (service as TelegramAssistantService & {
      purgeConversationData(input: {
        conversationKey: string;
        requestedByUserId: number;
      }): Promise<{
        messageRefs: number;
        queuedMessages: number;
        assistantTurns: number;
        pendingActions: number;
      }>;
    }).purgeConversationData({
      conversationKey: "bot_private:1",
      requestedByUserId: 10,
    });

    expect(purged).toEqual({
      messageRefs: 1,
      queuedMessages: 1,
      assistantTurns: 1,
      pendingActions: 1,
    });
    await expect(store.listMessageRefs("bot_private:1")).resolves.toEqual([]);
    await expect(store.listQueuedMessages("bot_private:1")).resolves.toEqual([]);
    await expect(store.getActiveAssistantTurn("bot_private:1")).resolves.toBeUndefined();
    await expect(store.listPendingActions({ conversationKey: "bot_private:1" })).resolves.toEqual([]);
  });

  it("does not mark an update processed or advance offset when handling fails", async () => {
    const store = new InMemoryTelegramAssistantStore();
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker: undefined,
      repositories: [],
      telegram: {
        sendMessage: vi.fn().mockRejectedValue(new Error("telegram down")),
        answerCallbackQuery: vi.fn(),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      service.handleUpdate({
        update_id: 8,
        message: {
          message_id: 13,
          date: 1,
          chat: { id: 1, type: "private" },
          from: { id: 10, is_bot: false, first_name: "User" },
          text: "hello",
        },
      }),
    ).rejects.toThrow("telegram down");

    expect(await store.isUpdateProcessed(8)).toBe(false);
    expect(await store.getOffset("default")).toBeUndefined();
  });
});

describe("TelegramUpdatePoller", () => {
  it("polls under a lease from the stored offset and handles updates sequentially", async () => {
    const calls: string[] = [];
    const getUpdates = vi.fn().mockResolvedValue([{ update_id: 40 }, { update_id: 41 }]);
    const getOffset = vi.fn().mockResolvedValue(40);
    const withPollingLease = async <T>(
      operation: () => Promise<T>,
    ): Promise<T | undefined> => {
      calls.push("lease:start");
      const result = await operation();
      calls.push("lease:end");
      return result;
    };
    const handler = {
      handleUpdate: vi.fn(async (update: { update_id: number }) => {
        calls.push(`handle:${update.update_id}`);
      }),
    };
    const poller = new TelegramUpdatePoller({
      client: { getUpdates },
      getOffset,
      handler,
      intervalSeconds: 3,
      withPollingLease,
    });

    await poller.runOnce();

    expect(getOffset).toHaveBeenCalledOnce();
    expect(getUpdates).toHaveBeenCalledWith({ offset: 40, timeoutSeconds: 3 });
    expect(handler.handleUpdate).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["lease:start", "handle:40", "handle:41", "lease:end"]);
  });

  it("records skipped polling leases and inbound rate limits without advancing updates", async () => {
    const metrics = fakeObservability();
    const handler = { handleUpdate: vi.fn(async () => undefined) };
    const getUpdates = vi.fn()
      .mockRejectedValueOnce(new TelegramRetryAfterError("getUpdates", 0))
      .mockResolvedValueOnce([{ update_id: 55 }]);
    const poller = new TelegramUpdatePoller({
      client: { getUpdates },
      getOffset: vi.fn(async () => 55),
      handler,
      intervalSeconds: 1,
      withPollingLease: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async (operation: () => Promise<void>) => operation())
        .mockImplementationOnce(async (operation: () => Promise<void>) => operation()),
      observability: metrics.telemetry,
    } as any);

    await poller.runOnce();
    await poller.runOnce();
    await poller.runOnce();

    expect(handler.handleUpdate).toHaveBeenCalledWith({ update_id: 55 });
    expect(metrics.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "telegram_polling_lease_skipped_total",
        labels: {},
      }),
      expect.objectContaining({
        name: "telegram_rate_limited_total",
        labels: { direction: "inbound" },
      }),
    ]));
  });

  it("does not classify outbound handler retry_after as inbound polling rate limit", async () => {
    vi.useFakeTimers();
    try {
      const metrics = fakeObservability();
      const outboundRetryAfter = new TelegramRetryAfterError("sendMessage", 2);
      const poller = new TelegramUpdatePoller({
        client: {
          getUpdates: vi.fn(async () => [{ update_id: 56 }]),
        },
        getOffset: vi.fn(async () => 56),
        handler: {
          handleUpdate: vi.fn(async () => {
            throw outboundRetryAfter;
          }),
        },
        intervalSeconds: 1,
        withPollingLease: async <T>(operation: () => Promise<T>) => operation(),
        observability: metrics.telemetry,
      } as any);
      let settled = false;

      const handled = poller.runOnce().finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      expect(metrics.counters).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "telegram_rate_limited_total",
          labels: { direction: "inbound" },
        }),
      ]));

      await handled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TelegramNotificationRouter", () => {
  it("backs off outbound Telegram retry_after and records metrics during notification delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));
    try {
      const metrics = fakeObservability();
      const store = new InMemoryTelegramAssistantStore();
      await store.upsertTaskSubscription({
        id: "subscription_retry_after",
        taskId: "task_notify",
        conversationKey: "bot_private:1",
        chatId: 1,
        userId: 10,
        createdAt: baseTime,
        updatedAt: baseTime,
      });
      const retryAfter = new TelegramRetryAfterError("sendMessage", 2);
      const router = new TelegramNotificationRouter({
        store,
        telegram: { sendMessage: vi.fn().mockRejectedValue(retryAfter) },
        taskTracker: {
          getTask: vi.fn(async () => taskFixture({
            id: "task_notify",
            events: [
              {
                id: "event_retry_after",
                taskId: "task_notify",
                kind: "status_changed",
                source: "worker_agent",
                message: "Task moved forward.",
                createdAt: baseTime,
              },
            ],
          })),
        },
        observability: metrics.telemetry,
        logger: { warn: vi.fn() },
        clock: () => new Date(Date.now()),
      });
      let settled = false;
      let rejection: unknown;

      const handled = router.scanSubscribedTasks().catch((error) => {
        rejection = error;
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      expect(metrics.counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "telegram_rate_limited_total",
          labels: { direction: "outbound" },
        }),
        expect.objectContaining({
          name: "telegram_notification_delivery_total",
          labels: { outcome: "failed" },
        }),
      ]));

      await vi.advanceTimersByTimeAsync(1);
      await handled;

      expect(settled).toBe(true);
      expect(rejection).toBe(retryAfter);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Telegram assistant runtime lifecycle", () => {
  it("stops already-started components when assistant startup fails", async () => {
    const events: string[] = [];
    const startupError = new Error("deleteWebhook failed");
    const runtime = {
      config: {
        workerId: "worker-1",
        runOnce: true,
      },
      orchestrator: {
        runOnce: vi.fn(async () => {
          events.push("orchestrator:runOnce");
        }),
        runForever: vi.fn(async () => {
          events.push("orchestrator:runForever");
        }),
      },
      logger: {
        info: vi.fn(),
      },
      observability: {
        start: vi.fn(async () => {
          events.push("observability:start");
        }),
        markNotReady: vi.fn((reason: string) => {
          events.push(`observability:not-ready:${reason}`);
        }),
        setWorkerState: vi.fn((state: { state: string }) => {
          events.push(`observability:state:${state.state}`);
        }),
        incrementCounter: vi.fn((name: string, labels: Record<string, string>) => {
          events.push(`observability:counter:${name}:${labels.status}`);
        }),
        observeHistogram: vi.fn(),
        setGauge: vi.fn(),
        markReady: vi.fn(() => {
          events.push("observability:ready");
        }),
        stop: vi.fn(async () => {
          events.push("observability:stop");
        }),
      },
      cleanup: {
        start: vi.fn(() => {
          events.push("cleanup:start");
        }),
        runOnce: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          events.push("cleanup:stop");
        }),
      },
      telegramAssistant: {
        start: vi.fn(async () => {
          events.push("telegram:start");
          throw startupError;
        }),
        stop: vi.fn(async () => {
          events.push("telegram:stop");
        }),
      },
      assertRepositoryReady: vi.fn(async () => {
        events.push("repository:ready");
      }),
      assertCodexAuthenticated: vi.fn(async () => {
        events.push("codex:ready");
      }),
    };

    await expect(runApplicationRuntime(runtime)).rejects.toThrow("deleteWebhook failed");

    expect(events).toEqual([
      "observability:start",
      "observability:not-ready:startup checks pending",
      "telegram:start",
      "observability:not-ready:deleteWebhook failed",
      "observability:counter:ai_developer_preflight_checks_total:fail",
      "telegram:stop",
      "observability:stop",
      "cleanup:stop",
    ]);
    expect(runtime.cleanup.start).not.toHaveBeenCalled();
    expect(runtime.orchestrator.runOnce).not.toHaveBeenCalled();
    expect(runtime.observability.markReady).not.toHaveBeenCalled();
  });
});
