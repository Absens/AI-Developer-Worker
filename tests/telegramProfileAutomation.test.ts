import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptTelegramAuditText,
  InMemoryTelegramAssistantStore,
  TelegramAssistantService,
  type TelegramAssistantServiceOptions,
} from "../src/domain/telegramAssistant/index.js";
import type {
  TelegramMessage,
  TelegramUpdate,
} from "../src/integrations/telegram/index.js";
import type {
  RepositoryProfile,
  TelegramAssistantConfig,
} from "../src/models/types.js";
import type {
  CreateTaskInput,
  TaskRecord,
  TaskTrackerClient,
} from "../src/domain/taskTracker/index.js";

const baseTime = new Date().toISOString();

type ProfileAutomationConfigOverrides =
  Partial<TelegramAssistantConfig["profileAutomation"]> & {
    digitalTwin?: Partial<TelegramAssistantConfig["digitalTwin"]>;
  };

const profileAutomationConfig = (
  overrides: ProfileAutomationConfigOverrides = {},
): TelegramAssistantConfig => {
  const { digitalTwin, ...profileAutomationOverrides } = overrides;

  return {
  enabled: true,
  botToken: "test-token",
  mode: "polling",
  pollIntervalSeconds: 2,
  confirmWriteActions: true,
  projectQaEnabled: true,
  taskCreationEnabled: true,
  allowedChatIds: [],
  allowedUserIds: [],
  developerUserIds: [],
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
  digitalTwin: {
    enabled: false,
    autoReplyEnabled: true,
    fullAccess: true,
    sessionTtlDays: 0,
    summaryRefreshMessageInterval: 20,
    maxRecentMessages: 20,
    codexTimeoutSeconds: 120,
    redactedRetentionDays: 30,
    fullTextRetentionDays: 0,
    personaProfileVersion: "default",
    ownerStylePrompt: "",
    ...digitalTwin,
  },
  profileAutomation: {
    enabled: false,
    autoReplyEnabled: false,
    requireOwnerApproval: true,
    projectQaEnabled: false,
    allowedOwnerIds: [],
    allowedChatIds: [],
    maxMessageAgeSeconds: 0,
    ...profileAutomationOverrides,
  },
  };
};

const telegramMessage = (messageId: number, chatId = 777): TelegramMessage => ({
  message_id: messageId,
  date: 2,
  chat: { id: chatId, type: "private" },
  text: "sent",
});

const waitForExpect = async (
  assertion: () => void | Promise<void>,
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
};

const deferred = <T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

interface BuildAssistantInput {
  store: InMemoryTelegramAssistantStore;
  config?: TelegramAssistantConfig;
  sendMessage?: TelegramAssistantServiceOptions["telegram"]["sendMessage"];
  answerCallbackQuery?: TelegramAssistantServiceOptions["telegram"]["answerCallbackQuery"];
  assistantCodex?: TelegramAssistantServiceOptions["assistantCodex"];
  taskTracker?: TaskTrackerClient;
  repositories?: RepositoryProfile[];
  logger?: TelegramAssistantServiceOptions["logger"];
}

const repositoryFixture = (): RepositoryProfile => ({
  name: "developer",
  repoPath: "C:\\repo\\developer",
  gitlabProjectId: "developer/project",
  gitRemoteName: "origin",
  baseBranch: "main",
  queues: ["DEV"],
  tags: [],
  testCommand: "npm test",
  lintCommand: "npm run typecheck",
});

const buildAssistant = (input: BuildAssistantInput): TelegramAssistantService =>
  new TelegramAssistantService({
    store: input.store,
    config: input.config ?? profileAutomationConfig(),
    ...(input.taskTracker ? { taskTracker: input.taskTracker } : {}),
    ...(input.assistantCodex ? { assistantCodex: input.assistantCodex } : {}),
    repositories: input.repositories ?? [repositoryFixture()],
    telegram: {
      sendMessage: input.sendMessage ?? vi.fn(),
      answerCallbackQuery: input.answerCallbackQuery ?? vi.fn(),
    },
    ...(input.logger ? { logger: input.logger } : {}),
  });

const businessMessageUpdate = (
  input: {
    updateId?: number;
    messageId?: number;
    chatId?: number;
    userId?: number;
  senderIsBot?: boolean;
  businessConnectionId?: string;
  date?: number;
  text: string;
  },
): TelegramUpdate => ({
  update_id: input.updateId ?? 2,
  business_message: {
    message_id: input.messageId ?? 10,
    date: input.date ?? 1,
    business_connection_id: input.businessConnectionId ?? "bc_1",
    chat: { id: input.chatId ?? 777, type: "private" },
    from: {
      id: input.userId ?? 500,
      is_bot: input.senderIsBot ?? false,
      first_name: "External",
    },
    text: input.text,
  },
});

const callbackUpdate = (
  data: string,
  input: {
    updateId?: number;
    callbackQueryId?: string;
    messageId?: number;
    chatId?: number;
    userId?: number;
  } = {},
): TelegramUpdate => ({
  update_id: input.updateId ?? 100,
  callback_query: {
    id: input.callbackQueryId ?? "cb_1",
    from: {
      id: input.userId ?? 10,
      is_bot: false,
      first_name: "User",
    },
    message: {
      message_id: input.messageId ?? 90,
      date: 2,
      chat: { id: input.chatId ?? 99, type: "private" },
      text: "Создать задачу?",
    },
    chat_instance: "chat_instance_1",
    data,
  },
});

const upsertBusinessConnection = async (
  store: InMemoryTelegramAssistantStore,
  input: {
    businessConnectionId?: string;
    ownerUserId?: string;
    ownerChatId?: string;
    canReply?: boolean;
    canReadMessages?: boolean;
    isEnabled?: boolean;
  } = {},
): Promise<void> => {
  await store.upsertBusinessConnection({
    businessConnectionId: input.businessConnectionId ?? "bc_1",
    ownerUserId: input.ownerUserId ?? "10",
    ownerChatId: input.ownerChatId ?? "99",
    isEnabled: input.isEnabled ?? true,
    rights: {
      can_reply: input.canReply ?? true,
      can_read_messages: input.canReadMessages ?? true,
    },
    lastSeenAt: baseTime,
    createdAt: baseTime,
    updatedAt: baseTime,
  });
};

const taskFixture = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: overrides.id ?? "task_business_1",
  title: overrides.title ?? "Business task",
  description: overrides.description ?? "Business task description.",
  source: { kind: "native" },
  createdBy: { owner: "human", id: "user-1" },
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: [],
  components: [],
  priority: "normal",
  status: "ready",
  taskType: "backend_endpoint",
  acceptanceCriteria: [],
  constraints: [],
  riskFactors: [],
  missingContext: [],
  externalRefs: [],
  fieldOwners: [],
  revisions: [],
  events: [],
  comments: [],
  decisions: [],
  plans: [],
  dependencies: [],
  artifacts: [],
  agentRuns: [],
  qualityGateRuns: [],
  mergeRequests: [],
  clarificationQuestions: [],
  humanAnswers: [],
  decompositionDecisions: [],
  reviewMetadata: [],
  memoryContextRefs: [],
  createdAt: baseTime,
  updatedAt: baseTime,
  ...overrides,
});

describe("profile automation", () => {
  afterEach(() => {
    delete process.env.TG_DIGITAL_TWIN_AUDIT_KEY;
  });

  it("persists business connections", async () => {
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({ store, config: profileAutomationConfig() });

    await service.handleUpdate({
      update_id: 1,
      business_connection: {
        id: "bc_1",
        user: { id: 10, is_bot: false, first_name: "Owner" },
        user_chat_id: 99,
        date: 0,
        is_enabled: true,
        rights: { can_reply: true, can_read_messages: true },
      },
    } as TelegramUpdate);

    await expect(store.getBusinessConnection("bc_1")).resolves.toMatchObject({
      businessConnectionId: "bc_1",
      ownerUserId: "10",
      ownerChatId: "99",
      isEnabled: true,
      rights: { can_reply: true, can_read_messages: true },
    });
  });

  it("does not auto-reply to non-allowlisted business chats", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["123"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, text: "что там по проекту" }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.getOffset("default")).toBe(3);
  });

  it("allows business messages from any chat when the profile chat allowlist is empty", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store, { canReply: false, ownerChatId: "99" });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: [],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, text: "привет" }),
    );

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "99",
      text: expect.any(String),
    }));
  });

  it("does not automate business messages sent by bots", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({
        chatId: 777,
        userId: 500,
        senderIsBot: true,
        text: "Привет",
      }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.getOffset("default")).toBe(3);
  });

  it("does not automate outbound business messages sent by the profile owner", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store, { ownerUserId: "10" });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, userId: 10, text: "Привет" }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.getOffset("default")).toBe(3);
  });

  it("acks stale business messages without auto-replying or starting project Q&A", async () => {
    const sendMessage = vi.fn();
    const assistantCodex = { answerProjectQuestion: vi.fn() };
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const config = profileAutomationConfig({
      enabled: true,
      autoReplyEnabled: true,
      projectQaEnabled: true,
      allowedOwnerIds: ["10"],
      allowedChatIds: ["777"],
      maxMessageAgeSeconds: 300,
    });
    const service = buildAssistant({
      store,
      config,
      sendMessage,
      assistantCodex,
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 44,
        chatId: 777,
        date: Math.floor(Date.now() / 1000) - 600,
        text: "как устроена авторизация в проекте?",
      }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
    expect(await store.getActiveAssistantTurn("business:bc_1:777")).toBeUndefined();
    expect(await store.getOffset("default")).toBe(45);
  });

  it("uses the business connection in the conversation key", async () => {
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, text: "привет" }),
    );

    await expect(store.listMessageRefs("business:bc_1:777")).resolves.toEqual([
      expect.objectContaining({
        conversationKey: "business:bc_1:777",
        chatId: 777,
        messageId: 10,
      }),
    ]);
  });

  it("does not send internal project Q&A to business chats by default", async () => {
    const assistantCodex = { answerProjectQuestion: vi.fn() };
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      config: profileAutomationConfig(),
      sendMessage,
      assistantCodex,
    });

    await service.handleUpdate(
      businessMessageUpdate({
        chatId: 777,
        text: "как устроена авторизация в проекте?",
      }),
    );

    expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not reply when business connection cannot reply", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store, { canReply: false });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, text: "привет" }),
    );

    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      businessConnectionId: "bc_1",
    }));
  });

  it("does not automate business messages when read rights are omitted", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await store.upsertBusinessConnection({
      businessConnectionId: "bc_1",
      ownerUserId: "10",
      ownerChatId: "99",
      isEnabled: true,
      rights: { can_reply: true },
      lastSeenAt: baseTime,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, text: "привет" }),
    );

    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      businessConnectionId: "bc_1",
    }));
    expect(await store.getOffset("default")).toBe(3);
  });

  it("notifies the owner privately when an allowed business chat cannot be replied to", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store, { canReply: false, ownerChatId: "99" });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, text: "привет" }),
    );

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "99",
      text: expect.any(String),
    }));
    expect(sendMessage.mock.calls).toEqual(
      expect.not.arrayContaining([
        [expect.objectContaining({ businessConnectionId: "bc_1" })],
      ]),
    );
  });

  it("does not notify the owner that can_reply is missing when only auto replies are disabled", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store, { canReply: true, ownerChatId: "99" });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: false,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({ chatId: 777, text: "привет" }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.getOffset("default")).toBe(3);
  });

  it.each([
    { label: "false", rights: { can_reply: false, can_read_messages: true } },
    { label: "missing", rights: { can_read_messages: true } },
  ])(
    "does not notify the owner when can_reply is $label but auto replies are disabled",
    async ({ rights }) => {
      const sendMessage = vi.fn();
      const store = new InMemoryTelegramAssistantStore();
      await store.upsertBusinessConnection({
        businessConnectionId: "bc_1",
        ownerUserId: "10",
        ownerChatId: "99",
        isEnabled: true,
        rights,
        lastSeenAt: baseTime,
        createdAt: baseTime,
        updatedAt: baseTime,
      });
      const service = buildAssistant({
        store,
        config: profileAutomationConfig({
          enabled: true,
          autoReplyEnabled: false,
          projectQaEnabled: true,
          allowedOwnerIds: ["10"],
          allowedChatIds: ["777"],
        }),
        sendMessage,
      });

      await service.handleUpdate(
        businessMessageUpdate({
          chatId: 777,
          text: "как устроена авторизация в проекте?",
        }),
      );

      expect(sendMessage).not.toHaveBeenCalled();
      expect(await store.getOffset("default")).toBe(3);
    },
  );

  it("notifies the owner when can_reply is false and auto replies are enabled", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store, { canReply: false, ownerChatId: "99" });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        projectQaEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({
        chatId: 777,
        text: "как устроена авторизация в проекте?",
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "99",
      text: expect.any(String),
    }));
    expect(sendMessage.mock.calls).toEqual(
      expect.not.arrayContaining([
        [expect.objectContaining({ businessConnectionId: "bc_1" })],
      ]),
    );
  });

  it("notifies the owner privately for business task drafts when replies are unavailable", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store, { canReply: false, ownerChatId: "99" });
    const service = buildAssistant({
      store,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        requireOwnerApproval: false,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
      sendMessage,
    });

    await service.handleUpdate(
      businessMessageUpdate({
        chatId: 777,
        text: "создай задачу проверить оплату",
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "99",
      text: expect.any(String),
    }));
    expect(sendMessage.mock.calls).toEqual(
      expect.not.arrayContaining([
        [expect.objectContaining({ businessConnectionId: "bc_1" })],
      ]),
    );
  });

  it("routes business write actions to the owner for approval before creating tasks", async () => {
    const createdTask = taskFixture();
    const createTask = vi.fn(
      async (_input: CreateTaskInput): Promise<TaskRecord> => createdTask,
    );
    const taskTracker = {
      createTask,
      findTaskByExternalRef: vi.fn(async () => null),
    } as unknown as TaskTrackerClient;
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      taskTracker,
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: false,
        requireOwnerApproval: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 4,
        messageId: 12,
        chatId: 777,
        text: "создай задачу проверить оплату",
      }),
    );

    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "99",
      text: expect.stringContaining("Создать задачу?"),
    }));

    await service.handleUpdate({
      update_id: 5,
      message: {
        message_id: 13,
        date: 2,
        chat: { id: 99, type: "private" },
        from: { id: 10, is_bot: false, first_name: "Owner" },
        text: "да",
      },
    });

    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({
      externalRefs: [{ provider: "telegram", externalKey: "telegram:777:12" }],
      externalSnapshot: { chatId: 777, messageId: 12, userId: 500 },
    });
  });

  it("lets a read-only globally allowed profile owner confirm a business task draft callback", async () => {
    const createdTask = taskFixture();
    const createTask = vi.fn(
      async (_input: CreateTaskInput): Promise<TaskRecord> => createdTask,
    );
    const taskTracker = {
      createTask,
      findTaskByExternalRef: vi.fn(async () => null),
    } as unknown as TaskTrackerClient;
    const sendMessage = vi.fn();
    const answerCallbackQuery = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const config = profileAutomationConfig({
      enabled: true,
      autoReplyEnabled: false,
      requireOwnerApproval: true,
      allowedOwnerIds: ["10"],
      allowedChatIds: ["777"],
    });
    config.allowedUserIds = ["10"];
    const service = buildAssistant({
      store,
      taskTracker,
      sendMessage,
      answerCallbackQuery,
      config,
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 20,
        messageId: 12,
        chatId: 777,
        userId: 500,
        text: "создай задачу проверить оплату",
      }),
    );
    const [pending] = await store.listPendingActions({
      conversationKey: "bot_private:99",
      status: "pending",
    });
    if (!pending) {
      throw new Error("Expected pending owner approval action.");
    }

    await service.handleUpdate(callbackUpdate(`c:${pending.id}`, {
      updateId: 21,
      callbackQueryId: "cb_external",
      chatId: 777,
      userId: 500,
    }));

    expect(createTask).not.toHaveBeenCalled();
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "pending",
    });

    await service.handleUpdate(callbackUpdate(`c:${pending.id}`, {
      updateId: 22,
      callbackQueryId: "cb_owner",
      chatId: 99,
      userId: 10,
    }));
    await service.handleUpdate(callbackUpdate(`c:${pending.id}`, {
      updateId: 23,
      callbackQueryId: "cb_owner_repeat",
      chatId: 99,
      userId: 10,
    }));

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      callbackQueryId: "cb_external",
    }));
    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({
      externalRefs: [{ provider: "telegram", externalKey: "telegram:777:12" }],
      externalSnapshot: { chatId: 777, messageId: 12, userId: 500 },
    });
    await expect(store.getPendingAction(pending.id)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("records deleted business messages without replying", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      config: profileAutomationConfig(),
      sendMessage,
    });

    await service.handleUpdate({
      update_id: 3,
      deleted_business_messages: {
        business_connection_id: "bc_1",
        chat: { id: 777, type: "private" },
        message_ids: [10, 11],
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.listMessageRefs("business:bc_1:777")).resolves.toEqual([
      expect.objectContaining({
        messageId: 10,
        redactedText: "[deleted business message]",
      }),
      expect.objectContaining({
        messageId: 11,
        redactedText: "[deleted business message]",
      }),
    ]);
  });

  it("records edited business messages without crashing or auto-replying when disabled", async () => {
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    const service = buildAssistant({
      store,
      config: profileAutomationConfig(),
      sendMessage,
    });

    await service.handleUpdate({
      update_id: 6,
      edited_business_message: {
        message_id: 14,
        date: 3,
        business_connection_id: "bc_1",
        chat: { id: 777, type: "private" },
        from: { id: 500, is_bot: false, first_name: "External" },
        text: "обновленный текст",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.listMessageRefs("business:bc_1:777")).resolves.toEqual([
      expect.objectContaining({
        messageId: 14,
        redactedText: "[edited] обновленный текст",
      }),
    ]);
  });

  it("records edited business messages as audit-only when profile automation is enabled", async () => {
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> =>
      taskFixture(),
    );
    const taskTracker = {
      createTask,
      findTaskByExternalRef: vi.fn(async () => null),
    } as unknown as TaskTrackerClient;
    const assistantCodex = { answerProjectQuestion: vi.fn() };
    const sendMessage = vi.fn();
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      taskTracker,
      assistantCodex,
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        requireOwnerApproval: true,
        projectQaEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
      }),
    });

    await service.handleUpdate({
      update_id: 7,
      edited_business_message: {
        message_id: 15,
        date: 4,
        business_connection_id: "bc_1",
        chat: { id: 777, type: "private" },
        from: { id: 500, is_bot: false, first_name: "External" },
        text: "создай задачу проверить оплату",
      },
    });
    await service.handleUpdate({
      update_id: 8,
      edited_business_message: {
        message_id: 16,
        date: 5,
        business_connection_id: "bc_1",
        chat: { id: 777, type: "private" },
        from: { id: 500, is_bot: false, first_name: "External" },
        text: "как устроена авторизация в проекте?",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(assistantCodex.answerProjectQuestion).not.toHaveBeenCalled();
    await expect(store.listPendingActions()).resolves.toEqual([]);
    await expect(store.listMessageRefs("business:bc_1:777")).resolves.toEqual([
      expect.objectContaining({
        messageId: 15,
        redactedText: "[edited] создай задачу проверить оплату",
      }),
      expect.objectContaining({
        messageId: 16,
        redactedText: "[edited] как устроена авторизация в проекте?",
      }),
    ]);
    expect(await store.getOffset("default")).toBe(9);
  });

  it("auto-replies to allowed business chats through a durable digital twin session", async () => {
    const answerAsDigitalTwin = vi.fn(async () => ({
      answer: "Да, беру в работу.",
      threadId: "thread-dt-1",
      startedNewThread: true,
    }));
    const sendMessage = vi.fn(async () => telegramMessage(9001));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 1,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v1",
          ownerStylePrompt: "Answer in the owner's concise style.",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 101,
        messageId: 21,
        chatId: 777,
        text: "Привет, есть новости?",
      }),
    );

    await waitForExpect(() => expect(sendMessage).toHaveBeenCalledOnce());

    expect(answerAsDigitalTwin).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "business:bc_1:777",
      inboundText: "Привет, есть новости?",
      ownerStylePrompt: "Answer in the owner's concise style.",
      personaProfileVersion: "v1",
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "777",
      text: "Да, беру в работу.",
      replyToMessageId: 21,
      businessConnectionId: "bc_1",
    }));
    await expect(store.getDigitalTwinSession("business:bc_1:777")).resolves.toMatchObject({
      codexThreadId: "thread-dt-1",
      summaryNeedsRefresh: true,
      status: "active",
    });
    await expect(store.listDigitalTwinMessages("business:bc_1:777")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "inbound",
          messageKey: "telegram-business:bc_1:777:21",
          deliveryStatus: "received",
        }),
        expect.objectContaining({
          direction: "outbound",
          messageKey: "telegram-business-reply:bc_1:777:21",
          deliveryStatus: "sent",
          sentTelegramMessageId: 9001,
        }),
      ]),
    );
  });

  it("does not generate or send a second digital twin reply for a duplicate business message", async () => {
    const answerAsDigitalTwin = vi.fn(async () => ({
      answer: "Первый ответ.",
      threadId: "thread-dup",
      startedNewThread: true,
    }));
    const sendMessage = vi.fn(async () => telegramMessage(9002));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 110,
        messageId: 30,
        chatId: 777,
        text: "Повтори статус",
      }),
    );
    await waitForExpect(() => expect(sendMessage).toHaveBeenCalledOnce());

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 111,
        messageId: 30,
        chatId: 777,
        text: "Повтори статус",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(answerAsDigitalTwin).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    const messages = await store.listDigitalTwinMessages("business:bc_1:777");
    expect(messages.filter((message) => message.direction === "outbound")).toHaveLength(1);
  });

  it("queues a second digital twin message while a turn is running and audits it only when drained", async () => {
    const firstAnswer = deferred<{
      answer: string;
      threadId: string;
      startedNewThread: boolean;
    }>();
    const answerAsDigitalTwin = vi.fn()
      .mockReturnValueOnce(firstAnswer.promise)
      .mockResolvedValueOnce({
        answer: "Второй ответ.",
        threadId: "thread-queue",
        startedNewThread: false,
      });
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(telegramMessage(9101))
      .mockResolvedValueOnce(telegramMessage(9102));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 120,
        messageId: 40,
        chatId: 777,
        text: "Первое сообщение",
      }),
    );
    await waitForExpect(() => expect(answerAsDigitalTwin).toHaveBeenCalledOnce());

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 121,
        messageId: 41,
        chatId: 777,
        text: "Второе сообщение",
      }),
    );

    expect(answerAsDigitalTwin).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.listQueuedMessages("business:bc_1:777")).resolves.toHaveLength(1);
    expect(
      (await store.listDigitalTwinMessages("business:bc_1:777"))
        .map((message) => message.messageKey),
    ).not.toContain("telegram-business:bc_1:777:41");

    firstAnswer.resolve({
      answer: "Первый ответ.",
      threadId: "thread-queue",
      startedNewThread: true,
    });

    await waitForExpect(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    await expect(store.listQueuedMessages("business:bc_1:777")).resolves.toHaveLength(0);
    expect(
      (await store.listDigitalTwinMessages("business:bc_1:777"))
        .map((message) => message.messageKey),
    ).toEqual(expect.arrayContaining([
      "telegram-business:bc_1:777:40",
      "telegram-business:bc_1:777:41",
    ]));
  });

  it("queues digital twin business messages behind an existing assistant turn", async () => {
    const answerAsDigitalTwin = vi.fn();
    const sendMessage = vi.fn(async () => telegramMessage(9151));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    await store.startAssistantTurn({
      id: "assistant-turn-running",
      conversationKey: "business:bc_1:777",
      status: "running",
      startedAt: baseTime,
    });
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 122,
        messageId: 42,
        chatId: 777,
        text: "Пока не отвечай",
      }),
    );

    expect(answerAsDigitalTwin).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.getActiveDigitalTwinTurn("business:bc_1:777"))
      .resolves.toBeUndefined();
    await expect(store.listDigitalTwinMessages("business:bc_1:777"))
      .resolves.toEqual([]);
    await expect(store.listQueuedMessages("business:bc_1:777")).resolves.toEqual([
      expect.objectContaining({
        id: "queued:122",
        message: expect.objectContaining({
          conversationKey: "business:bc_1:777",
          text: "Пока не отвечай",
        }),
      }),
    ]);
  });

  it("does not leave a running digital twin turn when inbound audit encryption fails", async () => {
    const answerAsDigitalTwin = vi.fn();
    const sendMessage = vi.fn(async () => telegramMessage(9152));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 7,
          auditEncryptionKeyEnv: "TG_DIGITAL_TWIN_AUDIT_KEY",
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await expect(service.handleUpdate(
      businessMessageUpdate({
        updateId: 123,
        messageId: 43,
        chatId: 777,
        text: "Сохрани полный аудит",
      }),
    )).rejects.toThrow(
      "Telegram audit encryption key env var is missing: TG_DIGITAL_TWIN_AUDIT_KEY",
    );

    expect(answerAsDigitalTwin).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.getActiveDigitalTwinTurn("business:bc_1:777"))
      .resolves.toBeUndefined();
    await expect(store.listQueuedMessages("business:bc_1:777"))
      .resolves.toHaveLength(0);
  });

  it("keeps sent delivery state when draining a queued digital twin message fails", async () => {
    const firstAnswer = deferred<{
      answer: string;
      threadId: string;
      startedNewThread: boolean;
    }>();
    const answerAsDigitalTwin = vi.fn()
      .mockReturnValueOnce(firstAnswer.promise)
      .mockRejectedValueOnce(new Error("queued digital twin failed"));
    const sendMessage = vi.fn(async () => telegramMessage(9153));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      logger,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 124,
        messageId: 44,
        chatId: 777,
        text: "Первый ответ",
      }),
    );
    await waitForExpect(() => expect(answerAsDigitalTwin).toHaveBeenCalledOnce());

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 125,
        messageId: 45,
        chatId: 777,
        text: "Второй ответ падает",
      }),
    );

    firstAnswer.resolve({
      answer: "Первый отправлен.",
      threadId: "thread-drain-failure",
      startedNewThread: true,
    });

    await waitForExpect(() => expect(logger.warn).toHaveBeenCalledWith(
      "Telegram assistant background operation failed.",
      expect.objectContaining({
        updateId: 124,
        error: "queued digital twin failed",
      }),
    ));

    const messages = await store.listDigitalTwinMessages("business:bc_1:777");
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageKey: "telegram-business-reply:bc_1:777:44",
        deliveryStatus: "sent",
        sentTelegramMessageId: 9153,
      }),
      expect.objectContaining({
        messageKey: "telegram-business-reply:bc_1:777:45",
        deliveryStatus: "send_failed",
        deliveryError: "queued digital twin failed",
      }),
    ]));
  });

  it("records only inbound digital twin audit for a paused session", async () => {
    const answerAsDigitalTwin = vi.fn();
    const sendMessage = vi.fn(async () => telegramMessage(9201));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    await store.upsertDigitalTwinSession({
      sessionKey: "business:bc_1:777",
      source: "business",
      chatId: 777,
      businessConnectionId: "bc_1",
      ownerUserId: "10",
      ownerChatId: "99",
      status: "paused",
      statusReason: "manual_pause",
      personaProfileVersion: "v1",
      summaryNeedsRefresh: false,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 130,
        messageId: 50,
        chatId: 777,
        text: "Пауза?",
      }),
    );

    expect(answerAsDigitalTwin).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.listDigitalTwinMessages("business:bc_1:777")).resolves.toEqual([
      expect.objectContaining({
        id: "dtm_in_3m_1e",
        direction: "inbound",
        deliveryStatus: "received",
        metadata: { paused: true },
      }),
    ]);
  });

  it("keeps paused digital twin sessions audit-only across TTL and persona changes", async () => {
    const answerAsDigitalTwin = vi.fn(async () => ({
      answer: "Не должен отвечать.",
      threadId: "thread-paused-reactivated",
      startedNewThread: true,
    }));
    const sendMessage = vi.fn(async () => telegramMessage(9202));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    await store.upsertDigitalTwinSession({
      sessionKey: "business:bc_1:777",
      source: "business",
      chatId: 777,
      businessConnectionId: "bc_1",
      ownerUserId: "10",
      ownerChatId: "99",
      status: "paused",
      statusReason: "manual_pause",
      codexThreadId: "old-thread",
      personaProfileVersion: "v1",
      summaryNeedsRefresh: false,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 1,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v2",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 131,
        messageId: 51,
        chatId: 777,
        text: "Пауза еще действует?",
      }),
    );

    expect(answerAsDigitalTwin).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(store.getDigitalTwinSession("business:bc_1:777")).resolves
      .toMatchObject({
        status: "paused",
        codexThreadId: "old-thread",
        personaProfileVersion: "v1",
      });
    await expect(store.listDigitalTwinMessages("business:bc_1:777")).resolves
      .toEqual([
        expect.objectContaining({
          messageKey: "telegram-business:bc_1:777:51",
          direction: "inbound",
          deliveryStatus: "received",
          metadata: { paused: true },
        }),
      ]);
  });

  it("keeps a queued digital twin message queued if another turn becomes active while draining", async () => {
    const firstAnswer = deferred<{
      answer: string;
      threadId: string;
      startedNewThread: boolean;
    }>();
    const answerAsDigitalTwin = vi.fn()
      .mockReturnValueOnce(firstAnswer.promise)
      .mockResolvedValueOnce({
        answer: "Не должен стартовать.",
        threadId: "thread-race",
        startedNewThread: false,
      });
    const sendMessage = vi.fn(async () => telegramMessage(9203));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const completeDigitalTwinTurnIfRunning = store.completeDigitalTwinTurnIfRunning
      .bind(store);
    vi.spyOn(store, "completeDigitalTwinTurnIfRunning").mockImplementation(
      async (turnId, input) => {
        const completed = await completeDigitalTwinTurnIfRunning(turnId, input);
        if (
          completed?.inboundMessageKey === "telegram-business:bc_1:777:52" &&
          input.status === "completed"
        ) {
          await store.startDigitalTwinTurn({
            id: "external-running-digital-twin-turn",
            sessionKey: "business:bc_1:777",
            inboundMessageKey: "telegram-business:bc_1:777:external",
            outboundMessageKey: "telegram-business-reply:bc_1:777:external",
            status: "running",
            startedAt: baseTime,
            metadata: {},
          });
        }
        return completed;
      },
    );
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 0,
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 132,
        messageId: 52,
        chatId: 777,
        text: "Первое",
      }),
    );
    await waitForExpect(() => expect(answerAsDigitalTwin).toHaveBeenCalledOnce());

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 133,
        messageId: 53,
        chatId: 777,
        text: "Останься в очереди",
      }),
    );

    firstAnswer.resolve({
      answer: "Первый ответ.",
      threadId: "thread-race",
      startedNewThread: true,
    });

    await waitForExpect(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(answerAsDigitalTwin).toHaveBeenCalledOnce();
    await expect(store.listQueuedMessages("business:bc_1:777")).resolves.toEqual([
      expect.objectContaining({
        id: "queued:133",
        message: expect.objectContaining({
          messageId: 53,
          text: "Останься в очереди",
        }),
      }),
    ]);
    expect(
      (await store.listDigitalTwinMessages("business:bc_1:777"))
        .map((message) => message.messageKey),
    ).not.toContain("telegram-business:bc_1:777:53");
  });

  it("writes encrypted full-text audit for inbound and outbound digital twin messages", async () => {
    const auditKey = Buffer.alloc(32, 7).toString("base64");
    process.env.TG_DIGITAL_TWIN_AUDIT_KEY = auditKey;
    const answerAsDigitalTwin = vi.fn(async () => ({
      answer: "секретный ответ",
      threadId: "thread-encrypted",
      startedNewThread: true,
    }));
    const sendMessage = vi.fn(async () => telegramMessage(9301));
    const store = new InMemoryTelegramAssistantStore();
    await upsertBusinessConnection(store);
    const service = buildAssistant({
      store,
      assistantCodex: { answerAsDigitalTwin },
      sendMessage,
      config: profileAutomationConfig({
        enabled: true,
        autoReplyEnabled: true,
        allowedOwnerIds: ["10"],
        allowedChatIds: ["777"],
        digitalTwin: {
          enabled: true,
          autoReplyEnabled: true,
          fullAccess: true,
          sessionTtlDays: 0,
          summaryRefreshMessageInterval: 20,
          maxRecentMessages: 20,
          codexTimeoutSeconds: 120,
          redactedRetentionDays: 30,
          fullTextRetentionDays: 7,
          auditEncryptionKeyEnv: "TG_DIGITAL_TWIN_AUDIT_KEY",
          personaProfileVersion: "v1",
          ownerStylePrompt: "",
        },
      }),
    });

    await service.handleUpdate(
      businessMessageUpdate({
        updateId: 140,
        messageId: 60,
        chatId: 777,
        text: "секретный вход",
      }),
    );
    await waitForExpect(() => expect(sendMessage).toHaveBeenCalledOnce());

    const messages = await store.listDigitalTwinMessages("business:bc_1:777");
    const inbound = messages.find((message) => message.direction === "inbound");
    const outbound = messages.find((message) => message.direction === "outbound");
    expect(inbound?.fullTextEncrypted).toBeDefined();
    expect(outbound?.fullTextEncrypted).toBeDefined();
    expect(inbound?.fullTextEncrypted).not.toContain("секретный вход");
    expect(outbound?.fullTextEncrypted).not.toContain("секретный ответ");
    expect(decryptTelegramAuditText(inbound!.fullTextEncrypted!, { key: auditKey }))
      .toBe("секретный вход");
    expect(decryptTelegramAuditText(outbound!.fullTextEncrypted!, { key: auditKey }))
      .toBe("секретный ответ");
  });

  it.each([
    {
      label: "reset_requested",
      sessionStatus: "reset_requested" as const,
      updatedAt: new Date().toISOString(),
      configTtlDays: 0,
      sessionPersonaVersion: "v2",
      configPersonaVersion: "v2",
      statusReason: "reset_requested",
    },
    {
      label: "TTL expired",
      sessionStatus: "active" as const,
      updatedAt: "2020-01-01T00:00:00.000Z",
      configTtlDays: 1,
      sessionPersonaVersion: "v2",
      configPersonaVersion: "v2",
      statusReason: "ttl_expired",
    },
    {
      label: "persona version changed",
      sessionStatus: "active" as const,
      updatedAt: new Date().toISOString(),
      configTtlDays: 0,
      sessionPersonaVersion: "v1",
      configPersonaVersion: "v2",
      statusReason: "persona_changed",
    },
  ])(
    "starts a fresh digital twin thread when $label",
    async ({
      sessionStatus,
      updatedAt,
      configTtlDays,
      sessionPersonaVersion,
      configPersonaVersion,
      statusReason,
    }) => {
      const answerAsDigitalTwin = vi.fn(async () => ({
        answer: "Свежий ответ.",
        threadId: "new-thread",
        startedNewThread: true,
      }));
      const sendMessage = vi.fn(async () => telegramMessage(9401));
      const store = new InMemoryTelegramAssistantStore();
      await upsertBusinessConnection(store);
      await store.upsertDigitalTwinSession({
        sessionKey: "business:bc_1:777",
        source: "business",
        chatId: 777,
        businessConnectionId: "bc_1",
        ownerUserId: "10",
        ownerChatId: "99",
        status: sessionStatus,
        codexThreadId: "old-thread",
        personaProfileVersion: sessionPersonaVersion,
        summary: "old recovery summary",
        summaryNeedsRefresh: false,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt,
      });
      const service = buildAssistant({
        store,
        assistantCodex: { answerAsDigitalTwin },
        sendMessage,
        config: profileAutomationConfig({
          enabled: true,
          autoReplyEnabled: true,
          allowedOwnerIds: ["10"],
          allowedChatIds: ["777"],
          digitalTwin: {
            enabled: true,
            autoReplyEnabled: true,
            fullAccess: true,
            sessionTtlDays: configTtlDays,
            summaryRefreshMessageInterval: 20,
            maxRecentMessages: 20,
            codexTimeoutSeconds: 120,
            redactedRetentionDays: 30,
            fullTextRetentionDays: 0,
            personaProfileVersion: configPersonaVersion,
            ownerStylePrompt: "",
          },
        }),
      });

      await service.handleUpdate(
        businessMessageUpdate({
          updateId: 150,
          messageId: 70,
          chatId: 777,
          text: "Новый заход",
        }),
      );
      await waitForExpect(() => expect(sendMessage).toHaveBeenCalledOnce());

      expect(answerAsDigitalTwin).toHaveBeenCalledWith(expect.not.objectContaining({
        threadId: "old-thread",
      }));
      expect(answerAsDigitalTwin).toHaveBeenCalledWith(expect.objectContaining({
        summary: "old recovery summary",
      }));
      await expect(store.getDigitalTwinSession("business:bc_1:777")).resolves.toMatchObject({
        status: "active",
        statusReason,
        codexThreadId: "new-thread",
        personaProfileVersion: configPersonaVersion,
        summaryNeedsRefresh: true,
      });
    },
  );
});
