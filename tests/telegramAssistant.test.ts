import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTelegramAssistantStore,
  TelegramAssistantService,
} from "../src/domain/telegramAssistant/index.js";
import { TelegramUpdatePoller } from "../src/integrations/telegram/index.js";
import { runApplicationRuntime } from "../src/app.js";
import type { TelegramAssistantConfig } from "../src/models/types.js";
import type {
  TaskLeaseRecord,
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
