import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTelegramAssistantStore,
  TelegramAssistantService,
  validateTelegramAttachment,
} from "../src/domain/telegramAssistant/index.js";
import { TelegramClient } from "../src/integrations/telegram/index.js";
import type { TelegramUpdate } from "../src/integrations/telegram/index.js";
import type { TelegramAssistantConfig } from "../src/models/types.js";
import type {
  CreateTaskInput,
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
    enabled: true,
    maxBytes: 2000,
    allowedMimeTypes: ["image/png"],
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
    enabled: false,
    autoReplyEnabled: false,
    requireOwnerApproval: true,
    projectQaEnabled: false,
    allowedOwnerIds: [],
    allowedChatIds: [],
    maxMessageAgeSeconds: 0,
  },
});

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
  clarificationQuestions: [],
  humanAnswers: [],
  decompositionDecisions: [],
  reviewMetadata: [],
  memoryContextRefs: [],
  createdAt: "2026-05-30T08:00:00.000Z",
  updatedAt: "2026-05-30T08:00:00.000Z",
  ...overrides,
});

const messageUpdateWithDocument = (): TelegramUpdate => ({
  update_id: 100,
  message: {
    message_id: 99,
    date: 1,
    chat: { id: 1, type: "private" },
    from: {
      id: 10,
      is_bot: false,
      first_name: "User",
    },
    text: "создай задачу проверить скриншот",
    document: {
      file_id: "file_1",
      file_unique_id: "unique_1",
      file_name: "screen.png",
      mime_type: "image/png",
      file_size: 1000,
    },
  },
});

const callbackUpdate = (data: string): TelegramUpdate => ({
  update_id: 101,
  callback_query: {
    id: "cb_1",
    from: {
      id: 10,
      is_bot: false,
      first_name: "User",
    },
    message: {
      message_id: 100,
      date: 2,
      chat: { id: 1, type: "private" },
      text: "Создать задачу?",
    },
    chat_instance: "chat_instance_1",
    data,
  },
});

describe("validateTelegramAttachment", () => {
  it("accepts allowed image attachments within size limit", () => {
    expect(validateTelegramAttachment({
      fileId: "file_1",
      fileName: "screen.png",
      mimeType: "image/png",
      size: 1000,
    }, {
      enabled: true,
      maxBytes: 2000,
      allowedMimeTypes: ["image/png"],
    })).toEqual({ accepted: true });
  });

  it("rejects disallowed mime types", () => {
    expect(validateTelegramAttachment({
      fileId: "file_1",
      fileName: "secret.exe",
      mimeType: "application/x-msdownload",
      size: 1000,
    }, {
      enabled: true,
      maxBytes: 2000,
      allowedMimeTypes: ["image/png"],
    })).toMatchObject({ accepted: false });
  });

  it("rejects missing mime types when an allowlist is configured", () => {
    expect(validateTelegramAttachment({
      fileId: "file_1",
      fileName: "unknown.bin",
      size: 1000,
    }, {
      enabled: true,
      maxBytes: 2000,
      allowedMimeTypes: ["image/png"],
    })).toMatchObject({ accepted: false });
  });

  it("rejects missing sizes when a max byte policy is configured", () => {
    expect(validateTelegramAttachment({
      fileId: "file_1",
      fileName: "screen.png",
      mimeType: "image/png",
    }, {
      enabled: true,
      maxBytes: 2000,
      allowedMimeTypes: ["image/png"],
    })).toEqual({ accepted: false, reason: "file size required" });
  });
});

describe("TelegramAssistantService media attachments", () => {
  it("records accepted document metadata on task drafts and created tasks", async () => {
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date("2026-05-30T08:00:00.000Z"),
    });
    const createdTask = taskFixture({
      id: "task_with_attachment",
      title: "проверить скриншот",
    });
    const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> => (
      createdTask
    ));
    const appendEventOnce = vi.fn(async (): Promise<boolean> => true);
    const taskTracker = {
      listTasks: vi.fn(async (): Promise<TaskRecord[]> => []),
      findTaskByExternalRef: vi.fn(async (): Promise<TaskRecord | null> => null),
      createTask,
      appendEventOnce,
    } as unknown as TaskTrackerClient;
    const service = new TelegramAssistantService({
      store,
      config: baseTelegramAssistantConfig(),
      taskTracker,
      repositories: [
        {
          name: "developer",
          repoPath: "C:\\repo\\developer",
          gitlabProjectId: "developer/project",
          gitRemoteName: "origin",
          baseBranch: "main",
          queues: ["DEV"],
          tags: [],
          testCommand: "npm test",
          lintCommand: "npm run typecheck",
        },
      ],
      telegram: { sendMessage: vi.fn(), answerCallbackQuery: vi.fn() },
    });

    await service.handleUpdate(messageUpdateWithDocument());

    const pendingActions = await store.listPendingActions();
    expect(pendingActions).toHaveLength(1);
    expect(pendingActions[0]?.payload.attachments).toEqual([
      {
        type: "document",
        fileId: "file_1",
        fileName: "screen.png",
        mimeType: "image/png",
        size: 1000,
      },
    ]);

    await service.handleUpdate(callbackUpdate(`c:${pendingActions[0]?.id}`));

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      externalSnapshot: {
        chatId: 1,
        messageId: 99,
        userId: 10,
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
    expect(appendEventOnce).toHaveBeenCalledWith("task_with_attachment", {
      kind: "attachments_registered",
      source: "external_source",
      message: "Telegram attachments registered.",
      payload: {
        provider: "telegram",
        externalKey: "telegram:1:99",
        registrationKey: "telegram:telegram:1:99:attachments_registered",
        source: {
          provider: "telegram",
          externalKey: "telegram:1:99",
          kind: "attachments_registered",
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
    });
  });
});

describe("TelegramClient file methods", () => {
  it("fetches file metadata through getFile", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response(
      JSON.stringify({
        ok: true,
        result: {
          file_id: "file_1",
          file_unique_id: "unique_1",
          file_size: 1000,
          file_path: "documents/screen.png",
        },
      }),
      { status: 200 },
    ));
    const client = new TelegramClient({
      botToken: "secret-token",
      fetch: fetchImpl,
      apiBaseUrl: "https://telegram.test",
    });

    await expect(client.getFile("file_1")).resolves.toEqual({
      file_id: "file_1",
      file_unique_id: "unique_1",
      file_size: 1000,
      file_path: "documents/screen.png",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://telegram.test/botsecret-token/getFile",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ file_id: "file_1" }),
      }),
    );
  });

  it("redacts bot-token file URLs from download errors", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new Error("network refused");
    });
    const client = new TelegramClient({
      botToken: "secret-token",
      fetch: fetchImpl,
      apiBaseUrl: "https://telegram.test",
    });

    await expect(client.downloadFile("documents/screen.png")).rejects.toThrow(
      "Telegram file download failed",
    );
    await expect(client.downloadFile("documents/screen.png")).rejects.not.toThrow(
      "https://telegram.test/file/botsecret-token/documents/screen.png",
    );
  });
});
