import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTelegramAssistantStore,
  TelegramAssistantService,
  type TelegramAssistantServiceOptions,
} from "../src/domain/telegramAssistant/index.js";
import type { TelegramUpdate } from "../src/integrations/telegram/index.js";
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

const profileAutomationConfig = (
  overrides: Partial<TelegramAssistantConfig["profileAutomation"]> = {},
): TelegramAssistantConfig => ({
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
  profileAutomation: {
    enabled: false,
    autoReplyEnabled: false,
    requireOwnerApproval: true,
    projectQaEnabled: false,
    allowedOwnerIds: [],
    allowedChatIds: [],
    maxMessageAgeSeconds: 0,
    ...overrides,
  },
});

interface BuildAssistantInput {
  store: InMemoryTelegramAssistantStore;
  config?: TelegramAssistantConfig;
  sendMessage?: TelegramAssistantServiceOptions["telegram"]["sendMessage"];
  answerCallbackQuery?: TelegramAssistantServiceOptions["telegram"]["answerCallbackQuery"];
  assistantCodex?: TelegramAssistantServiceOptions["assistantCodex"];
  taskTracker?: TaskTrackerClient;
  repositories?: RepositoryProfile[];
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
});
