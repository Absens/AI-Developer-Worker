import { describe, expect, it } from "vitest";

import {
  InMemoryTelegramAssistantStore,
  type TelegramAssistantActor,
  type TelegramInboundMessage,
  type TelegramIntent,
  type TelegramPendingAction,
  type TelegramQueuedMessage,
} from "../src/domain/telegramAssistant/index.js";

type ReserveNotificationDeliveryInput = Parameters<
  InMemoryTelegramAssistantStore["reserveNotificationDelivery"]
>[0];
type CompleteNotificationDeliveryInput = Parameters<
  InMemoryTelegramAssistantStore["completeNotificationDelivery"]
>[2];

const baseTime = "2026-05-30T08:00:00.000Z";
const laterTime = "2026-05-30T08:05:00.000Z";
const expiredTime = "2026-05-30T07:59:00.000Z";
const futureTime = "2026-05-30T09:00:00.000Z";
const conversationKey = "bot_private:100:200";

const validReserveInput: ReserveNotificationDeliveryInput = {
  id: "delivery-typecheck",
  subscriptionId: "sub-typecheck",
  eventId: "event-typecheck",
  reservedAt: baseTime,
  staleAfter: laterTime,
};
void validReserveInput;

const invalidReserveInput: ReserveNotificationDeliveryInput = {
  id: "delivery-typecheck",
  subscriptionId: "sub-typecheck",
  eventId: "event-typecheck",
  // @ts-expect-error reserve creates sending deliveries; callers cannot reserve sent.
  status: "sent",
  reservedAt: baseTime,
};
void invalidReserveInput;

// @ts-expect-error reserve requires staleAfter so sending leases cannot stick forever.
const missingStaleReserveInput: ReserveNotificationDeliveryInput = {
  id: "delivery-typecheck",
  subscriptionId: "sub-typecheck",
  eventId: "event-typecheck",
  reservedAt: baseTime,
};
void missingStaleReserveInput;

const invalidCompleteInput: CompleteNotificationDeliveryInput = {
  // @ts-expect-error complete only accepts terminal delivery statuses.
  status: "sending",
  deliveryId: "delivery-typecheck",
};
void invalidCompleteInput;

const actor: TelegramAssistantActor = {
  telegramUserId: 200,
  username: "dev",
  displayName: "Developer",
  role: "developer",
};

const intent: TelegramIntent = {
  name: "approve_action",
  confidence: 0.98,
  rawText: "approve",
};

const inboundMessage = (
  overrides: Partial<TelegramInboundMessage> = {},
): TelegramInboundMessage => ({
  id: "inbound-1",
  updateId: 900,
  conversationKey,
  source: "bot_private",
  chatId: 100,
  userId: 200,
  messageId: 300,
  text: "hello",
  redactedText: "hello",
  actor,
  receivedAt: baseTime,
  ...overrides,
});

const pendingAction = (
  overrides: Partial<TelegramPendingAction> = {},
): TelegramPendingAction => ({
  id: "action-1",
  conversationKey,
  chatId: 100,
  userId: 200,
  intent,
  payload: { taskId: "DEV-1" },
  status: "pending",
  createdAt: baseTime,
  updatedAt: baseTime,
  expiresAt: futureTime,
  ...overrides,
});

const queuedMessage = (
  overrides: Partial<TelegramQueuedMessage> = {},
): TelegramQueuedMessage => ({
  id: "queue-1",
  conversationKey,
  chatId: 100,
  userId: 200,
  message: inboundMessage(),
  status: "queued",
  createdAt: baseTime,
  expiresAt: futureTime,
  ...overrides,
});

const createStore = (): InMemoryTelegramAssistantStore =>
  new InMemoryTelegramAssistantStore({
    now: () => new Date(baseTime),
  });

describe("InMemoryTelegramAssistantStore", () => {
  it("saves polling offsets separately from processed update ids", async () => {
    const store = createStore();

    await expect(store.getOffset("telegram-polling")).resolves.toBeUndefined();
    await store.markUpdateProcessed(41);

    await expect(store.isUpdateProcessed(41)).resolves.toBe(true);
    await expect(store.getOffset("telegram-polling")).resolves.toBeUndefined();

    await store.saveOffset("telegram-polling", 42);

    await expect(store.getOffset("telegram-polling")).resolves.toBe(42);
  });

  it("runs polling lease operations in memory", async () => {
    const store = createStore();

    const result = await store.withPollingLease("telegram-polling", async () => {
      await store.saveOffset("telegram-polling", 5);
      return "leased";
    });

    expect(result).toBe("leased");
    await expect(store.getOffset("telegram-polling")).resolves.toBe(5);
  });

  it("consumes only matching non-expired pending actions once and completes terminal statuses", async () => {
    const store = createStore();
    await store.upsertPendingAction(pendingAction());
    await store.upsertPendingAction(
      pendingAction({
        id: "expired-action",
        expiresAt: expiredTime,
      }),
    );
    await store.upsertPendingAction(
      pendingAction({
        id: "other-user-action",
        userId: 201,
      }),
    );

    await expect(
      store.consumePendingAction({
        actionId: "action-1",
        chatId: 100,
        userId: 201,
        terminalStatus: "executing",
        now: baseTime,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.consumePendingAction({
        actionId: "expired-action",
        chatId: 100,
        userId: 200,
        terminalStatus: "executing",
        now: baseTime,
      }),
    ).resolves.toBeUndefined();

    const consumed = await store.consumePendingAction({
      actionId: "action-1",
      chatId: 100,
      userId: 200,
      terminalStatus: "executing",
      now: baseTime,
    });

    expect(consumed).toEqual(
      expect.objectContaining({
        id: "action-1",
        status: "executing",
        consumedAt: baseTime,
      }),
    );
    await expect(
      store.consumePendingAction({
        actionId: "action-1",
        chatId: 100,
        userId: 200,
        terminalStatus: "executing",
        now: baseTime,
      }),
    ).resolves.toBeUndefined();

    await expect(
      store.completePendingAction("action-1", {
        status: "completed",
        completedAt: laterTime,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "action-1",
        status: "completed",
        completedAt: laterTime,
      }),
    );
    await expect(
      store.completePendingAction("other-user-action", {
        status: "cancelled",
        completedAt: laterTime,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "cancelled" }));
    await expect(
      store.completePendingAction("expired-action", {
        status: "expired",
        completedAt: laterTime,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "expired" }));
    await expect(store.getPendingAction("action-1")).resolves.toEqual(
      expect.objectContaining({ status: "completed" }),
    );
    await expect(store.listPendingActions({ conversationKey })).resolves.toHaveLength(3);
  });

  it("keeps pending action terminal completion idempotent and rejects conflicts", async () => {
    const store = createStore();
    await store.upsertPendingAction(pendingAction());

    const completed = await store.completePendingAction("action-1", {
      status: "completed",
      completedAt: laterTime,
    });
    await expect(
      store.completePendingAction("action-1", {
        status: "completed",
        completedAt: futureTime,
      }),
    ).resolves.toEqual(completed);
    await expect(
      store.completePendingAction("action-1", {
        status: "cancelled",
        completedAt: futureTime,
      }),
    ).rejects.toThrow(/Cannot change telegram pending action action-1/);
    await expect(store.getPendingAction("action-1")).resolves.toEqual(completed);
  });

  it("serializes work per conversation and manages queued messages", async () => {
    const store = createStore();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.withConversationLock(conversationKey, async () => {
      events.push("first-start");
      await firstCanFinish;
      events.push("first-end");
      return "first";
    });
    const second = store.withConversationLock(conversationKey, async () => {
      events.push("second-start");
      return "second";
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    await store.startAssistantTurn({
      id: "turn-1",
      conversationKey,
      status: "running",
      startedAt: baseTime,
      input: inboundMessage(),
    });
    await store.enqueueMessage(queuedMessage({ id: "queue-1" }));
    await store.enqueueMessage(
      queuedMessage({
        id: "queue-2",
        message: inboundMessage({ id: "inbound-2", updateId: 901 }),
      }),
    );
    await store.deleteQueuedMessage("queue-1");

    await expect(store.getActiveAssistantTurn(conversationKey)).resolves.toEqual(
      expect.objectContaining({ id: "turn-1", status: "running" }),
    );
    await expect(store.listQueuedMessages(conversationKey)).resolves.toEqual([
      expect.objectContaining({ id: "queue-2", status: "queued" }),
    ]);

    await store.cancelQueuedMessages(conversationKey, {
      cancelledAt: laterTime,
    });

    await expect(store.listQueuedMessages(conversationKey)).resolves.toHaveLength(0);
    await expect(
      store.completeAssistantTurn("turn-1", {
        status: "completed",
        completedAt: laterTime,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "turn-1",
        status: "completed",
        completedAt: laterTime,
      }),
    );
    await expect(store.getActiveAssistantTurn(conversationKey)).resolves.toBeUndefined();

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("releases conversation locks after a failed operation", async () => {
    const store = createStore();
    const events: string[] = [];

    await expect(
      store.withConversationLock(conversationKey, async () => {
        events.push("first-start");
        throw new Error("turn failed");
      }),
    ).rejects.toThrow("turn failed");
    await expect(
      store.withConversationLock(conversationKey, async () => {
        events.push("second-start");
        return "second";
      }),
    ).resolves.toBe("second");

    expect(events).toEqual(["first-start", "second-start"]);
  });

  it("deduplicates notification delivery reservation by subscription and event id", async () => {
    const store = createStore();
    await store.upsertTaskSubscription({
      id: "sub-1",
      taskId: "DEV-1",
      conversationKey,
      chatId: 100,
      userId: 200,
      createdAt: baseTime,
      updatedAt: baseTime,
    });

    await expect(
      store.reserveNotificationDelivery({
        id: "delivery-1",
        subscriptionId: "sub-1",
        eventId: "event-1",
        reservedAt: baseTime,
        staleAfter: laterTime,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "delivery-1",
        status: "sending",
        staleAfter: laterTime,
      }),
    );
    await expect(
      store.reserveNotificationDelivery({
        id: "delivery-2",
        subscriptionId: "sub-1",
        eventId: "event-1",
        reservedAt: baseTime,
        staleAfter: laterTime,
      }),
    ).resolves.toBeUndefined();

    await expect(
      store.completeNotificationDelivery("sub-1", "event-1", {
        deliveryId: "delivery-1",
        status: "sent",
        completedAt: laterTime,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        subscriptionId: "sub-1",
        eventId: "event-1",
        status: "sent",
        completedAt: laterTime,
      }),
    );
    await expect(store.listTaskSubscriptionsForTask("DEV-1")).resolves.toEqual([
      expect.objectContaining({
        id: "sub-1",
        lastNotifiedEventId: "event-1",
        updatedAt: laterTime,
      }),
    ]);
  });

  it("allows stale sending notification deliveries to be reserved again", async () => {
    const store = createStore();
    await store.upsertTaskSubscription({
      id: "sub-stale",
      taskId: "DEV-1",
      conversationKey,
      chatId: 100,
      userId: 200,
      createdAt: baseTime,
      updatedAt: baseTime,
    });

    const firstReservation = await store.reserveNotificationDelivery({
      id: "stale-delivery-1",
      subscriptionId: "sub-stale",
      eventId: "event-stale",
      reservedAt: baseTime,
      staleAfter: laterTime,
    });
    expect(firstReservation).toEqual(
      expect.objectContaining({
        id: "stale-delivery-1",
        status: "sending",
        staleAfter: laterTime,
      }),
    );
    await expect(
      store.reserveNotificationDelivery({
        id: "stale-delivery-2",
        subscriptionId: "sub-stale",
        eventId: "event-stale",
        reservedAt: baseTime,
        staleAfter: futureTime,
      }),
    ).resolves.toBeUndefined();

    const retryReservation = await store.reserveNotificationDelivery({
      id: "stale-delivery-3",
      subscriptionId: "sub-stale",
      eventId: "event-stale",
      reservedAt: laterTime,
      staleAfter: futureTime,
    });
    expect(retryReservation).toEqual(
      expect.objectContaining({
        id: "stale-delivery-3",
        status: "sending",
        staleAfter: futureTime,
      }),
    );

    await expect(
      store.completeNotificationDelivery("sub-stale", "event-stale", {
        deliveryId: "stale-delivery-1",
        status: "sent",
        completedAt: futureTime,
      }),
    ).rejects.toThrow(/active notification delivery/);
    const subscriptionsAfterStaleCompletion =
      await store.listTaskSubscriptionsForTask("DEV-1");
    expect(subscriptionsAfterStaleCompletion).toEqual([
      expect.objectContaining({ id: "sub-stale" }),
    ]);
    expect(subscriptionsAfterStaleCompletion[0]).not.toHaveProperty(
      "lastNotifiedEventId",
    );

    await expect(
      store.completeNotificationDelivery("sub-stale", "event-stale", {
        deliveryId: "stale-delivery-3",
        status: "sent",
        completedAt: futureTime,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "stale-delivery-3",
        status: "sent",
        completedAt: futureTime,
      }),
    );
  });

  it("does not let sent notification deliveries be changed to failed", async () => {
    const store = createStore();
    await store.upsertTaskSubscription({
      id: "sub-sent-terminal",
      taskId: "DEV-1",
      conversationKey,
      chatId: 100,
      userId: 200,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await store.reserveNotificationDelivery({
      id: "delivery-sent-terminal",
      subscriptionId: "sub-sent-terminal",
      eventId: "event-sent-terminal",
      reservedAt: baseTime,
      staleAfter: laterTime,
    });

    const sent = await store.completeNotificationDelivery(
      "sub-sent-terminal",
      "event-sent-terminal",
      {
        deliveryId: "delivery-sent-terminal",
        status: "sent",
        completedAt: laterTime,
      },
    );
    const retryAsFailed = await store.completeNotificationDelivery(
      "sub-sent-terminal",
      "event-sent-terminal",
      {
        deliveryId: "delivery-sent-terminal",
        status: "failed",
        completedAt: futureTime,
        errorMessage: "late sender failure",
      },
    );

    expect(retryAsFailed).toEqual(sent);
    await expect(store.listTaskSubscriptionsForTask("DEV-1")).resolves.toContainEqual(
      expect.objectContaining({
        id: "sub-sent-terminal",
        lastNotifiedEventId: "event-sent-terminal",
        updatedAt: laterTime,
      }),
    );
  });

  it("does not let failed notification deliveries be changed to sent", async () => {
    const store = createStore();
    await store.upsertTaskSubscription({
      id: "sub-failed-terminal",
      taskId: "DEV-1",
      conversationKey,
      chatId: 100,
      userId: 200,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await store.reserveNotificationDelivery({
      id: "delivery-failed-terminal",
      subscriptionId: "sub-failed-terminal",
      eventId: "event-failed-terminal",
      reservedAt: baseTime,
      staleAfter: laterTime,
    });

    const failed = await store.completeNotificationDelivery(
      "sub-failed-terminal",
      "event-failed-terminal",
      {
        deliveryId: "delivery-failed-terminal",
        status: "failed",
        completedAt: laterTime,
        errorMessage: "send failed",
      },
    );
    const retryAsSent = await store.completeNotificationDelivery(
      "sub-failed-terminal",
      "event-failed-terminal",
      {
        deliveryId: "delivery-failed-terminal",
        status: "sent",
        completedAt: futureTime,
      },
    );

    expect(retryAsSent).toEqual(failed);
    const subscriptions = await store.listTaskSubscriptionsForTask("DEV-1");
    const subscription = subscriptions.find(
      (candidate) => candidate.id === "sub-failed-terminal",
    );
    expect(subscription).toBeDefined();
    expect(subscription).not.toHaveProperty("lastNotifiedEventId");
  });

  it("does not reopen failed notification deliveries for the same subscription event", async () => {
    const store = createStore();
    await store.upsertTaskSubscription({
      id: "sub-failed-reserve",
      taskId: "DEV-1",
      conversationKey,
      chatId: 100,
      userId: 200,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await store.reserveNotificationDelivery({
      id: "delivery-failed-reserve",
      subscriptionId: "sub-failed-reserve",
      eventId: "event-failed-reserve",
      reservedAt: baseTime,
      staleAfter: laterTime,
    });
    const failed = await store.completeNotificationDelivery(
      "sub-failed-reserve",
      "event-failed-reserve",
      {
        deliveryId: "delivery-failed-reserve",
        status: "failed",
        completedAt: laterTime,
        errorMessage: "send failed",
      },
    );

    await expect(
      store.reserveNotificationDelivery({
        id: "delivery-failed-reserve-retry",
        subscriptionId: "sub-failed-reserve",
        eventId: "event-failed-reserve",
        reservedAt: futureTime,
        staleAfter: "2026-05-30T10:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.completeNotificationDelivery(
        "sub-failed-reserve",
        "event-failed-reserve",
        {
          deliveryId: "delivery-failed-reserve",
          status: "sent",
          completedAt: futureTime,
        },
      ),
    ).resolves.toEqual(failed);

    const subscriptions = await store.listTaskSubscriptionsForTask("DEV-1");
    const subscription = subscriptions.find(
      (candidate) => candidate.id === "sub-failed-reserve",
    );
    expect(subscription).toBeDefined();
    expect(subscription).not.toHaveProperty("lastNotifiedEventId");
  });

  it("rejects non-terminal notification delivery completion statuses at runtime", async () => {
    const store = createStore();
    await store.reserveNotificationDelivery({
      id: "delivery-runtime-status",
      subscriptionId: "sub-runtime-status",
      eventId: "event-runtime-status",
      reservedAt: baseTime,
      staleAfter: laterTime,
    });

    await expect(
      store.completeNotificationDelivery("sub-runtime-status", "event-runtime-status", {
        deliveryId: "delivery-runtime-status",
        status: "sending",
      } as unknown as CompleteNotificationDeliveryInput),
    ).rejects.toThrow(/terminal notification delivery status/);
  });

  it("rejects notification reservations without a stale deadline at runtime", async () => {
    const store = createStore();

    await expect(
      store.reserveNotificationDelivery({
        id: "delivery-no-stale",
        subscriptionId: "sub-no-stale",
        eventId: "event-no-stale",
        reservedAt: baseTime,
      } as ReserveNotificationDeliveryInput),
    ).rejects.toThrow(/staleAfter is required/);
  });

  it("deduplicates processed updates without advancing the polling offset", async () => {
    const store = createStore();

    await expect(store.isUpdateProcessed(1000)).resolves.toBe(false);
    await store.markUpdateProcessed(1000);

    await expect(store.isUpdateProcessed(1000)).resolves.toBe(true);
    await expect(store.getOffset("telegram-polling")).resolves.toBeUndefined();
  });

  it("records recent redacted message refs by conversation and purges expired refs and queued messages", async () => {
    const store = createStore();
    await store.recordMessageRef({
      id: "ref-1",
      conversationKey,
      chatId: 100,
      messageId: 300,
      source: "user",
      redactedText: "token [redacted]",
      createdAt: baseTime,
      expiresAt: futureTime,
    });
    await store.recordMessageRef({
      id: "ref-2",
      conversationKey: "bot_private:101:201",
      chatId: 101,
      messageId: 301,
      source: "assistant",
      redactedText: "other conversation",
      createdAt: baseTime,
      expiresAt: futureTime,
    });
    await store.recordMessageRef({
      id: "expired-ref",
      conversationKey,
      chatId: 100,
      messageId: 299,
      source: "user",
      redactedText: "old",
      createdAt: expiredTime,
      expiresAt: expiredTime,
    });
    await store.enqueueMessage(
      queuedMessage({
        id: "expired-queue",
        expiresAt: expiredTime,
      }),
    );

    await expect(store.listMessageRefs(conversationKey)).resolves.toEqual([
      expect.objectContaining({
        id: "ref-1",
        redactedText: "token [redacted]",
      }),
      expect.objectContaining({ id: "expired-ref" }),
    ]);

    await expect(
      store.purgeExpiredTelegramAssistantData({ now: baseTime }),
    ).resolves.toEqual({
      messageRefs: 1,
      queuedMessages: 1,
      pendingActions: 0,
    });
    await expect(store.listMessageRefs(conversationKey)).resolves.toEqual([
      expect.objectContaining({ id: "ref-1" }),
    ]);
    await expect(store.listMessageRefs("bot_private:101:201")).resolves.toEqual([
      expect.objectContaining({ id: "ref-2" }),
    ]);
    await expect(store.listQueuedMessages(conversationKey)).resolves.toEqual([]);
  });

  it("purges expired terminal pending actions and keeps non-expired terminal actions", async () => {
    const store = createStore();
    await store.upsertPendingAction(
      pendingAction({
        id: "completed-expired",
        status: "completed",
        expiresAt: expiredTime,
        completedAt: expiredTime,
      }),
    );
    await store.upsertPendingAction(
      pendingAction({
        id: "cancelled-expired",
        status: "cancelled",
        expiresAt: expiredTime,
        completedAt: expiredTime,
      }),
    );
    await store.upsertPendingAction(
      pendingAction({
        id: "expired-terminal",
        status: "expired",
        expiresAt: expiredTime,
        completedAt: expiredTime,
      }),
    );
    await store.upsertPendingAction(
      pendingAction({
        id: "completed-current",
        status: "completed",
        expiresAt: futureTime,
        completedAt: baseTime,
      }),
    );

    await expect(
      store.purgeExpiredTelegramAssistantData({ now: baseTime }),
    ).resolves.toEqual({
      messageRefs: 0,
      queuedMessages: 0,
      pendingActions: 3,
    });
    await expect(store.listPendingActions({ conversationKey })).resolves.toEqual([
      expect.objectContaining({ id: "completed-current", status: "completed" }),
    ]);
  });

  it("stores business connection records by connection id", async () => {
    const store = createStore();

    await store.upsertBusinessConnection({
      id: "biz-1",
      userId: 200,
      userChatId: 100,
      canReply: true,
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
    });
    await store.upsertBusinessConnection({
      id: "biz-1",
      userId: 200,
      userChatId: 100,
      canReply: false,
      isEnabled: false,
      createdAt: baseTime,
      updatedAt: laterTime,
      lastSeenAt: laterTime,
    });

    await expect(store.getBusinessConnection("biz-1")).resolves.toEqual({
      id: "biz-1",
      businessConnectionId: "biz-1",
      userId: 200,
      ownerUserId: "200",
      userChatId: 100,
      ownerChatId: "100",
      canReply: false,
      rights: { can_reply: false },
      isEnabled: false,
      createdAt: baseTime,
      updatedAt: laterTime,
      lastSeenAt: laterTime,
    });
  });

  it("does not grant business connection read rights when they are omitted", async () => {
    const store = createStore();

    await store.upsertBusinessConnection({
      id: "biz-missing-read-rights",
      userId: 200,
      userChatId: 100,
      rights: { can_reply: true },
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
    });

    await expect(
      store.getBusinessConnection("biz-missing-read-rights"),
    ).resolves.toEqual(expect.objectContaining({
      canReply: true,
      rights: expect.objectContaining({ can_reply: true }),
    }));
    await expect(
      store.getBusinessConnection("biz-missing-read-rights"),
    ).resolves.toEqual(expect.objectContaining({
      rights: expect.not.objectContaining({ can_read_messages: true }),
    }));
  });

  it("does not overwrite newer business connection records with stale updates", async () => {
    const store = createStore();

    await store.upsertBusinessConnection({
      id: "biz-stale",
      userId: 201,
      userChatId: 101,
      canReply: false,
      isEnabled: false,
      createdAt: baseTime,
      updatedAt: laterTime,
      lastSeenAt: laterTime,
    });
    const result = await store.upsertBusinessConnection({
      id: "biz-stale",
      userId: 200,
      userChatId: 100,
      canReply: true,
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
    });

    expect(result).toEqual({
      id: "biz-stale",
      businessConnectionId: "biz-stale",
      userId: 201,
      ownerUserId: "201",
      userChatId: 101,
      ownerChatId: "101",
      canReply: false,
      rights: { can_reply: false },
      isEnabled: false,
      createdAt: baseTime,
      updatedAt: laterTime,
      lastSeenAt: laterTime,
    });
    await expect(store.getBusinessConnection("biz-stale")).resolves.toEqual(result);
  });

  it("does not overwrite newer business connection records with same-second stale update ids", async () => {
    const store = createStore();
    const expected = {
      id: "biz-same-second",
      businessConnectionId: "biz-same-second",
      userId: 201,
      ownerUserId: "201",
      userChatId: 101,
      ownerChatId: "101",
      canReply: false,
      rights: { can_reply: false, can_read_messages: true },
      isEnabled: false,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
      updateId: 11,
    };

    await store.upsertBusinessConnection(expected);
    const lowerUpdate = await store.upsertBusinessConnection({
      id: "biz-same-second",
      userId: 200,
      userChatId: 100,
      canReply: true,
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
      updateId: 10,
    });
    const equalUpdate = await store.upsertBusinessConnection({
      id: "biz-same-second",
      userId: 200,
      userChatId: 100,
      canReply: true,
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
      updateId: 11,
    });

    expect(lowerUpdate).toEqual(expected);
    expect(equalUpdate).toEqual(expected);
    await expect(store.getBusinessConnection("biz-same-second")).resolves.toEqual(
      expected,
    );
  });
});
