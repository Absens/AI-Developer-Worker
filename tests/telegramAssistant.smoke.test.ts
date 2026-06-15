import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryTelegramAssistantStore,
  TelegramAssistantService,
  TelegramNotificationRouter,
} from "../src/domain/telegramAssistant/index.js";
import {
  InMemoryTaskTrackerClient,
  type CreateTaskInput,
  type TaskRecord,
} from "../src/domain/taskTracker/index.js";
import {
  TelegramClient,
  TelegramUpdatePoller,
  type TelegramUpdate,
} from "../src/integrations/telegram/index.js";
import type {
  RepositoryProfile,
  TelegramAssistantConfig,
} from "../src/models/types.js";

interface TelegramRequestRecord {
  method: string;
  body: Record<string, unknown>;
  status: number;
}

class MockTelegramApiServer {
  readonly sentMessages: TelegramRequestRecord[] = [];
  readonly callbackAnswers: TelegramRequestRecord[] = [];
  readonly webhookCalls: TelegramRequestRecord[] = [];
  readonly requestedOffsets: Array<number | undefined> = [];
  private readonly updateBatches: TelegramUpdate[][];
  private readonly server: http.Server;
  private rejectNextHtmlMessage = true;
  private rateLimitNextGetUpdates = true;

  constructor(updateBatches: TelegramUpdate[][]) {
    this.updateBatches = [...updateBatches];
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", resolve);
    });
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const method = request.url?.split("/").at(-1) ?? "";

    if (method === "getUpdates") {
      this.requestedOffsets.push(
        typeof body.offset === "number" ? body.offset : undefined,
      );
      if (this.rateLimitNextGetUpdates) {
        this.rateLimitNextGetUpdates = false;
        writeTelegramResponse(response, 429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 0.01",
          parameters: { retry_after: 0.01 },
        });
        return;
      }
      writeTelegramResponse(response, 200, {
        ok: true,
        result: this.updateBatches.shift() ?? [],
      });
      return;
    }

    if (method === "sendMessage") {
      if (this.rejectNextHtmlMessage && body.parse_mode === "HTML") {
        this.rejectNextHtmlMessage = false;
        this.sentMessages.push({ method, body, status: 400 });
        writeTelegramResponse(response, 400, {
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities",
        });
        return;
      }
      this.sentMessages.push({ method, body, status: 200 });
      writeTelegramResponse(response, 200, {
        ok: true,
        result: {
          message_id: this.sentMessages.length,
          date: 1,
          chat: { id: Number(body.chat_id), type: "private" },
          text: body.text,
        },
      });
      return;
    }

    if (method === "answerCallbackQuery") {
      this.callbackAnswers.push({ method, body, status: 200 });
      writeTelegramResponse(response, 200, { ok: true, result: true });
      return;
    }

    if (method === "setWebhook" || method === "deleteWebhook") {
      this.webhookCalls.push({ method, body, status: 200 });
      writeTelegramResponse(response, 200, { ok: true, result: true });
      return;
    }

    writeTelegramResponse(response, 404, {
      ok: false,
      error_code: 404,
      description: `Unknown method ${method}`,
    });
  }
}

const servers: MockTelegramApiServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
});

const readJsonBody = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
};

const writeTelegramResponse = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const baseTelegramAssistantConfig = (): TelegramAssistantConfig => ({
  enabled: true,
  botToken: "TOKEN",
  mode: "polling",
  pollIntervalSeconds: 1,
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
  },
  profileAutomation: {
    enabled: true,
    autoReplyEnabled: true,
    requireOwnerApproval: true,
    projectQaEnabled: true,
    allowedOwnerIds: ["10"],
    allowedChatIds: ["777"],
    maxMessageAgeSeconds: 0,
  },
  defaultRepository: "developer",
});

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

const messageUpdate = (input: {
  updateId: number;
  messageId: number;
  chatId?: number;
  userId?: number;
  text: string;
}): TelegramUpdate => ({
  update_id: input.updateId,
  message: {
    message_id: input.messageId,
    date: 1,
    chat: { id: input.chatId ?? 1, type: "private" },
    from: {
      id: input.userId ?? 10,
      is_bot: false,
      first_name: "User",
    },
    text: input.text,
  },
});

const callbackUpdate = (input: {
  updateId: number;
  callbackQueryId: string;
  data: string;
}): TelegramUpdate => ({
  update_id: input.updateId,
  callback_query: {
    id: input.callbackQueryId,
    from: {
      id: 10,
      is_bot: false,
      first_name: "User",
    },
    message: {
      message_id: 203,
      date: 2,
      chat: { id: 1, type: "private" },
      text: "Создать задачу?",
    },
    chat_instance: "chat_instance_1",
    data: input.data,
  },
});

const businessConnectionUpdate = (): TelegramUpdate => ({
  update_id: 106,
  business_connection: {
    id: "bc_smoke",
    user: { id: 10, is_bot: false, first_name: "Owner" },
    user_chat_id: 1,
    date: Math.floor(Date.now() / 1000),
    can_reply: false,
    is_enabled: true,
    rights: { can_reply: false, can_read_messages: true },
  },
});

const businessMessageUpdate = (): TelegramUpdate => ({
  update_id: 107,
  business_message: {
    message_id: 301,
    date: Math.floor(Date.now() / 1000),
    business_connection_id: "bc_smoke",
    chat: { id: 777, type: "private" },
    from: {
      id: 7771,
      is_bot: false,
      first_name: "External",
    },
    text: "как устроен проект?",
  },
});

describe("Telegram assistant smoke", () => {
  it("processes polling, task creation, notifications, retries, and business guardrails", async () => {
    const store = new InMemoryTelegramAssistantStore();
    const taskTracker = new InMemoryTaskTrackerClient();
    await taskTracker.createTask({
      id: "task_existing",
      title: "Existing smoke task",
      description: "Task used for status lookup.",
      source: { kind: "native" },
      createdBy: { owner: "human", id: "fixture" },
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queue: "DEV",
      status: "ready",
      tags: ["smoke"],
      acceptanceCriteria: ["Status can be reported."],
    });

    const createdTasks: TaskRecord[] = [];
    const originalCreateTask = taskTracker.createTask.bind(taskTracker);
    const createTask = vi.spyOn(taskTracker, "createTask");
    createTask.mockImplementation(async (input: CreateTaskInput) => {
      const task = await originalCreateTask(input);
      if (
        input.source?.kind === "system" &&
        "provider" in input.source &&
        input.source.provider === "telegram"
      ) {
        createdTasks.push(task);
      }
      return task;
    });

    const pendingActionId = "tgpa_2u_5m";
    const updates = [
      messageUpdate({
        updateId: 101,
        messageId: 201,
        text: "какой статус task_existing?",
      }),
      messageUpdate({
        updateId: 102,
        messageId: 202,
        text: "создай задачу Создал smoke задачу",
      }),
      callbackUpdate({
        updateId: 103,
        callbackQueryId: "callback_smoke_1",
        data: `c:${pendingActionId}`,
      }),
      callbackUpdate({
        updateId: 104,
        callbackQueryId: "callback_smoke_duplicate",
        data: `c:${pendingActionId}`,
      }),
      messageUpdate({
        updateId: 105,
        messageId: 205,
        chatId: 999,
        userId: 999,
        text: "создай задачу forbidden",
      }),
      businessConnectionUpdate(),
      businessMessageUpdate(),
    ];
    expect(updates.filter((update) =>
      update.callback_query?.data === `c:${pendingActionId}`,
    )).toHaveLength(2);
    expect(updates.filter((update) =>
      update.callback_query?.data === `c:${pendingActionId}`,
    ).map((update) => update.update_id)).toEqual([103, 104]);
    const telegramServer = new MockTelegramApiServer([updates]);
    servers.push(telegramServer);
    await telegramServer.start();

    const telegram = new TelegramClient({
      botToken: "TOKEN",
      apiBaseUrl: telegramServer.baseUrl(),
      fetch,
    });
    await telegram.setWebhook({
      url: "https://worker.example.test/telegram/webhook",
      secretToken: "secret",
      dropPendingUpdates: false,
    });
    await telegram.deleteWebhook({ dropPendingUpdates: false });

    const metrics = {
      counters: [] as Array<{ name: string; labels: Record<string, string> }>,
      incrementCounter(name: string, labels: Record<string, string> = {}): void {
        this.counters.push({ name, labels });
      },
      observeHistogram(): void {},
      setGauge(): void {},
    };
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [repositoryFixture()],
      telegram,
      observability: metrics,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    const poller = new TelegramUpdatePoller({
      client: telegram,
      getOffset: () => store.getOffset("default"),
      handler: service,
      intervalSeconds: 1,
      withPollingLease: <T>(operation: () => Promise<T>) => store.withPollingLease(
        "telegram:TOKEN",
        operation,
      ),
      observability: metrics,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await poller.runOnce();
    expect(metrics.counters).toContainEqual({
      name: "telegram_rate_limited_total",
      labels: { direction: "inbound" },
    });
    await poller.runOnce();

    if (!createdTasks[0]) {
      throw new Error("Expected Telegram assistant to create a task.");
    }
    await taskTracker.appendEvent(createdTasks[0].id, {
      kind: "status_changed",
      source: "worker_agent",
      message: "Smoke notification created.",
    });
    const notificationRouter = new TelegramNotificationRouter({
      store,
      telegram,
      taskTracker,
      logger: { warn: vi.fn() },
    });
    await notificationRouter.scanSubscribedTasks();
    const notificationsAfterFirstScan = telegramServer.sentMessages.filter(
      (message) => String(message.body.text).includes("Smoke notification created."),
    );
    await notificationRouter.scanSubscribedTasks();
    const notificationsAfterSecondScan = telegramServer.sentMessages.filter(
      (message) => String(message.body.text).includes("Smoke notification created."),
    );

    const sentMessages = telegramServer.sentMessages.map((message) => ({
      text: String(message.body.text),
      body: message.body,
      status: message.status,
    }));

    expect(sentMessages.some((message) => message.text.includes("Создал")))
      .toBe(true);
    expect(sentMessages.every((message) =>
      !message.text.includes("TELEGRAM_ASSISTANT_BOT_TOKEN"),
    )).toBe(true);
    expect(createdTasks).toHaveLength(1);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(telegramServer.webhookCalls.map((call) => call.method)).toEqual([
      "setWebhook",
      "deleteWebhook",
    ]);
    expect(telegramServer.requestedOffsets).toEqual([undefined, undefined]);
    expect(telegramServer.callbackAnswers).toHaveLength(2);
    expect(telegramServer.callbackAnswers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.objectContaining({
          callback_query_id: "callback_smoke_1",
          text: "Создаю задачу...",
        }),
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          callback_query_id: "callback_smoke_duplicate",
          text: "Это действие уже выполнено или истекло.",
        }),
      }),
    ]));
    expect(telegramServer.sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 200,
        body: expect.objectContaining({ parse_mode: "HTML" }),
      }),
    ]));
    const rejectedHtml = telegramServer.sentMessages.find(
      (message) => message.status === 400 && message.body.parse_mode === "HTML",
    );
    expect(rejectedHtml).toBeDefined();
    expect(telegramServer.sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 400,
        body: expect.objectContaining({ parse_mode: "HTML" }),
      }),
      expect.objectContaining({
        status: 200,
        body: expect.not.objectContaining({ parse_mode: "HTML" }),
      }),
    ]));
    expect(telegramServer.sentMessages.find(
      (message) =>
        message.status === 200 &&
        message.body.text === rejectedHtml?.body.text &&
        !("parse_mode" in message.body),
    )).toBeDefined();
    expect(telegramServer.sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 200,
        body: expect.objectContaining({
          text: "У меня нет доступа к этому чату/пользователю.",
        }),
      }),
    ]));
    expect(await store.getPendingAction(pendingActionId)).toEqual(expect.objectContaining({
      status: "completed",
    }));
    await expect(store.listPendingActions({ conversationKey: "bot_private:999" }))
      .resolves.toEqual([]);
    expect(await store.getOffset("default")).toBe(108);
    expect(notificationsAfterFirstScan).toHaveLength(1);
    expect(notificationsAfterSecondScan).toHaveLength(1);
    expect(telegramServer.sentMessages).toEqual(expect.not.arrayContaining([
      expect.objectContaining({
        body: expect.objectContaining({ business_connection_id: "bc_smoke" }),
      }),
    ]));
    expect(telegramServer.sentMessages.filter((message) =>
      message.body.chat_id === 777 || message.body.chat_id === "777",
    )).toEqual([]);
    expect(telegramServer.sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.objectContaining({
          chat_id: "1",
          text: "Не могу ответить клиенту через бизнес-чат: у подключения нет права can_reply.",
        }),
      }),
    ]));
  });
});
