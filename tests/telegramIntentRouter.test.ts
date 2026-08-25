import { describe, expect, it } from "vitest";

import {
  resolveTelegramActor,
  routeTelegramIntent,
  shouldProcessGroupMessage,
} from "../src/domain/telegramAssistant/index.js";
import type { TelegramAssistantConfig } from "../src/models/types.js";

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

describe("routeTelegramIntent", () => {
  it.each([
    ["что там по задаче про регистрацию", "task_status"],
    ["статус task_123", "task_status"],
    ["надо сделать отправку письма после регистрации", "create_task_draft"],
    ["создай задачу починить регистрацию", "create_task_draft"],
    ["напиши когда будет готово", "subscribe_task"],
    ["ответь что можно продолжать с вариантом А", "answer_ai_question"],
    ["да, создай", "approve_action"],
    ["отмена", "reject_action"],
  ])("routes %s", (text, intent) => {
    expect(routeTelegramIntent(text).name).toBe(intent);
  });

  it("routes unknown text to project question when Q&A is enabled", () => {
    expect(routeTelegramIntent("как устроена регистрация", {
      projectQaEnabled: true,
    }).name).toBe("project_question");
  });

  it.each([
    "https://www.wildberries.ru/catalog/123456789/detail.aspx",
    "Найди конкурентов для wildberries.ru/catalog/123456789/detail.aspx",
    "https://www.ozon.ru/product/kuhonnyy-nozh-dlya-myasa-3085863400/",
  ])("routes Wildberries product research %s", (text) => {
    expect(routeTelegramIntent(text, { projectQaEnabled: true }).name).toBe(
      "competitor_research",
    );
  });

  it("keeps explicit task creation ahead of Wildberries research", () => {
    expect(routeTelegramIntent(
      "создай задачу проверить https://www.wildberries.ru/catalog/123456789/detail.aspx",
      { projectQaEnabled: true },
    ).name).toBe("create_task_draft");
  });

  it("does not route non-product Wildberries pages to competitor research", () => {
    expect(routeTelegramIntent(
      "https://www.wildberries.ru/brands/example",
      { projectQaEnabled: true },
    ).name).toBe("project_question");
  });
});

describe("resolveTelegramActor", () => {
  it("does not grant developer role from chat allowlist alone", () => {
    const actor = resolveTelegramActor(
      {
        ...baseTelegramAssistantConfig(),
        allowedChatIds: ["-1001"],
        allowedUserIds: [],
        developerUserIds: [],
      },
      {
        id: "telegram:1:message:1",
        updateId: 1,
        source: "group",
        conversationKey: "group:-1001:main",
        chatId: -1001,
        messageId: 1,
        userId: 999,
        receivedAt: "2026-05-29T00:00:00.000Z",
        text: "создай задачу",
      },
    );

    expect(actor).toMatchObject({ allowed: true, role: "viewer" });
  });
});

describe("shouldProcessGroupMessage", () => {
  it("ignores group chatter unless group mode allows it or the bot is mentioned/replied", () => {
    expect(shouldProcessGroupMessage({
      text: "что там по проекту",
      groupMode: "mentions_and_replies",
      botUsername: "assistant_bot",
      isReplyToBot: false,
    })).toBe(false);
    expect(shouldProcessGroupMessage({
      text: "@assistant_bot что там по проекту",
      groupMode: "mentions_and_replies",
      botUsername: "assistant_bot",
      isReplyToBot: false,
    })).toBe(true);
  });

  it("matches exact bot mentions case-insensitively without username-prefix false positives", () => {
    expect(shouldProcessGroupMessage({
      text: "@Assistant_Bot что там по проекту",
      groupMode: "mentions_and_replies",
      botUsername: "assistant_bot",
      isReplyToBot: false,
    })).toBe(true);
    expect(shouldProcessGroupMessage({
      text: "@assistant_bot2 что там по проекту",
      groupMode: "mentions_and_replies",
      botUsername: "assistant_bot",
      isReplyToBot: false,
    })).toBe(false);
    expect(shouldProcessGroupMessage({
      text: "@assistant_bot_extra что там по проекту",
      groupMode: "mentions_and_replies",
      botUsername: "assistant_bot",
      isReplyToBot: false,
    })).toBe(false);
  });

  it("matches replies only when the replied bot username is the assistant username", () => {
    expect(shouldProcessGroupMessage({
      text: "статус task_123",
      groupMode: "mentions_and_replies",
      botUsername: "assistant_bot",
      replyToBotUsername: "Assistant_Bot",
    })).toBe(true);
    expect(shouldProcessGroupMessage({
      text: "статус task_123",
      groupMode: "mentions_and_replies",
      botUsername: "assistant_bot",
      replyToBotUsername: "other_bot",
    })).toBe(false);
  });
});
