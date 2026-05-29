import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listInternalTrackerMigrations,
  PostgresTelegramAssistantStore,
  runInternalTrackerMigrations,
} from "../src/integrations/internalTracker/index.js";
import type {
  TelegramInboundMessage,
  TelegramIntent,
  TelegramPendingAction,
} from "../src/domain/telegramAssistant/index.js";

const baseTime = "2026-05-30T08:00:00.000Z";
const laterTime = "2026-05-30T08:05:00.000Z";
const futureTime = "2026-05-30T09:00:00.000Z";
const staleRetryTime = "2026-05-30T08:06:00.000Z";
const conversationKey = "bot_private:100:200";

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
  text: "approve",
  redactedText: "approve",
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

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

const queryResult = <T extends QueryResultRow>(rows: T[]): QueryResult<T> => ({
  command: "SELECT",
  oid: 0,
  fields: [],
  rows,
  rowCount: rows.length,
});

class BusyPollingLeaseClient {
  public readonly queries: string[] = [];
  public released = false;

  public async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
  ): Promise<QueryResult<R>> {
    this.queries.push(text);
    if (text.includes("pg_try_advisory_lock")) {
      return queryResult([{ locked: false } as unknown as R]);
    }
    if (text.includes("pg_advisory_unlock")) {
      throw new Error("Busy polling leases must not be unlocked.");
    }
    throw new Error(`Unexpected SQL in busy polling lease test: ${text}`);
  }

  public release(): void {
    this.released = true;
  }
}

class BusyPollingLeasePool {
  public readonly client = new BusyPollingLeaseClient();

  public async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
    throw new Error("Busy polling lease test should use a dedicated client.");
  }

  public async connect(): Promise<BusyPollingLeaseClient> {
    return this.client;
  }
}

const assertPollingLeaseResultIncludesUndefined = (): void => {
  const store = null as unknown as PostgresTelegramAssistantStore;
  const result = store.withPollingLease("telegram-polling", async () => "leased");
  type LeaseResult = Awaited<typeof result>;
  type LeaseResultIncludesUndefined =
    undefined extends LeaseResult ? true : false;
  const leaseResultIncludesUndefined: LeaseResultIncludesUndefined = true;
  void leaseResultIncludesUndefined;
};
void assertPollingLeaseResultIncludesUndefined;

describe("PostgresTelegramAssistantStore polling leases", () => {
  it("returns undefined without running the operation when the polling lease is busy", async () => {
    const pool = new BusyPollingLeasePool();
    const store = new PostgresTelegramAssistantStore(pool);
    let operationRan = false;

    const resolved = await store.withPollingLease("telegram-polling", async () => {
      operationRan = true;
      return "leased";
    });

    expect(resolved).toBeUndefined();
    expect(operationRan).toBe(false);
    expect(pool.client.released).toBe(true);
    expect(pool.client.queries).toHaveLength(1);
  });
});

describe("telegram assistant internal tracker migrations", () => {
  it("lists migration 0011 without introducing a duplicate 0010 migration", () => {
    const migrations = listInternalTrackerMigrations();

    expect(migrations.map((migration) => migration.filename)).toContain(
      "0011_telegram_assistant.sql",
    );
    expect(migrations.filter((migration) => migration.version === "0010")).toHaveLength(
      1,
    );
  });
});

describePostgres("PostgresTelegramAssistantStore with real PostgreSQL", () => {
  let pool: Pool;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = `telegram_store_${randomUUID().replace(/-/g, "")}`;
    const admin = new Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    await admin.end();

    pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
  });

  afterEach(async () => {
    await pool?.end().catch(() => undefined);
    if (!schemaName) {
      return;
    }
    const admin = new Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin
      .query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
      .catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it("applies migration 0011 and creates telegram assistant tables", async () => {
    const ran = await runInternalTrackerMigrations(pool);
    const tableNames = [
      "telegram_assistant_offsets",
      "telegram_assistant_processed_updates",
      "telegram_assistant_pending_actions",
      "telegram_assistant_message_refs",
      "telegram_assistant_turns",
      "telegram_assistant_queued_messages",
      "telegram_assistant_subscriptions",
      "telegram_assistant_sent_notifications",
      "telegram_profile_automation_connections",
    ];

    expect(ran.map((migration) => migration.filename)).toContain(
      "0011_telegram_assistant.sql",
    );
    for (const tableName of tableNames) {
      await expect(
        pool.query("SELECT to_regclass($1) IS NOT NULL AS exists", [tableName]),
      ).resolves.toMatchObject({
        rows: [expect.objectContaining({ exists: true })],
      });
    }
  });

  it("persists offsets and pending actions", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });

    await expect(store.getOffset("telegram-polling")).resolves.toBeUndefined();
    await store.saveOffset("telegram-polling", 42);
    await store.upsertPendingAction(pendingAction());

    await expect(store.getOffset("telegram-polling")).resolves.toBe(42);
    await expect(store.getPendingAction("action-1")).resolves.toEqual(
      expect.objectContaining({
        id: "action-1",
        conversationKey,
        payload: { taskId: "DEV-1" },
        status: "pending",
      }),
    );
    await expect(store.listPendingActions({ conversationKey })).resolves.toEqual([
      expect.objectContaining({ id: "action-1" }),
    ]);
  });

  it("atomically consumes a pending action once for the matching actor", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });
    await store.upsertPendingAction(pendingAction());

    const consumed = await store.consumePendingAction({
      actionId: "action-1",
      chatId: 100,
      userId: 200,
      now: baseTime,
      terminalStatus: "executing",
    });
    const secondConsume = await store.consumePendingAction({
      actionId: "action-1",
      chatId: 100,
      userId: 200,
      now: baseTime,
      terminalStatus: "cancelled",
    });

    expect(consumed).toEqual(
      expect.objectContaining({
        id: "action-1",
        status: "executing",
        consumedAt: baseTime,
      }),
    );
    expect(secondConsume).toBeUndefined();
  });

  it("matches in-memory notification delivery reservation semantics", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });
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
        subscriptionId: "sub-1",
        eventId: "event-1",
        status: "sending",
        staleAfter: laterTime,
      }),
    );
    await expect(
      store.reserveNotificationDelivery({
        id: "delivery-duplicate",
        subscriptionId: "sub-1",
        eventId: "event-1",
        reservedAt: baseTime,
        staleAfter: laterTime,
      }),
    ).resolves.toBeUndefined();

    await expect(
      store.reserveNotificationDelivery({
        id: "delivery-2",
        subscriptionId: "sub-1",
        eventId: "event-1",
        reservedAt: staleRetryTime,
        staleAfter: futureTime,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "delivery-2",
        status: "sending",
        staleAfter: futureTime,
      }),
    );
    await expect(
      store.completeNotificationDelivery("sub-1", "event-1", {
        deliveryId: "delivery-1",
        status: "sent",
        completedAt: futureTime,
      }),
    ).rejects.toThrow(/active notification delivery/);
    await expect(
      store.completeNotificationDelivery("sub-1", "event-1", {
        deliveryId: "delivery-2",
        status: "failed",
        completedAt: futureTime,
        errorMessage: "send failed",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "delivery-2",
        status: "failed",
        completedAt: futureTime,
        errorMessage: "send failed",
      }),
    );
    await expect(
      store.reserveNotificationDelivery({
        id: "delivery-3",
        subscriptionId: "sub-1",
        eventId: "event-1",
        reservedAt: "2026-05-30T10:00:00.000Z",
        staleAfter: "2026-05-30T11:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.completeNotificationDelivery("sub-1", "event-1", {
        deliveryId: "delivery-2",
        status: "sent",
        completedAt: "2026-05-30T10:00:00.000Z",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "delivery-2",
        status: "failed",
        completedAt: futureTime,
      }),
    );
    await expect(store.listTaskSubscriptionsForTask("DEV-1")).resolves.toEqual([
      expect.not.objectContaining({ lastNotifiedEventId: "event-1" }),
    ]);
  });

  it("persists message refs, turns, queued messages, subscriptions, business connections, and purge", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });

    await store.markUpdateProcessed(900);
    await store.recordMessageRef({
      id: "ref-1",
      conversationKey,
      chatId: 100,
      messageId: 300,
      source: "user",
      redactedText: "approve",
      createdAt: baseTime,
      expiresAt: futureTime,
    });
    await store.startAssistantTurn({
      id: "turn-1",
      conversationKey,
      status: "running",
      startedAt: baseTime,
      input: inboundMessage(),
    });
    await store.enqueueMessage({
      id: "queue-1",
      conversationKey,
      chatId: 100,
      userId: 200,
      message: inboundMessage({ id: "inbound-2", updateId: 901 }),
      status: "queued",
      createdAt: baseTime,
      expiresAt: futureTime,
    });
    await store.upsertTaskSubscription({
      id: "sub-refs",
      taskId: "DEV-2",
      conversationKey,
      chatId: 100,
      userId: 200,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
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

    await expect(store.isUpdateProcessed(900)).resolves.toBe(true);
    await expect(store.listMessageRefs(conversationKey)).resolves.toEqual([
      expect.objectContaining({ id: "ref-1" }),
    ]);
    await expect(store.getActiveAssistantTurn(conversationKey)).resolves.toEqual(
      expect.objectContaining({ id: "turn-1", status: "running" }),
    );
    await expect(store.listQueuedMessages(conversationKey)).resolves.toEqual([
      expect.objectContaining({ id: "queue-1", status: "queued" }),
    ]);
    await expect(store.listTaskSubscriptions(conversationKey)).resolves.toEqual([
      expect.objectContaining({ id: "sub-refs", taskId: "DEV-2" }),
    ]);
    await expect(store.getBusinessConnection("biz-1")).resolves.toEqual(
      expect.objectContaining({ id: "biz-1", canReply: true }),
    );
    await expect(
      store.completeAssistantTurn("turn-1", {
        status: "completed",
        completedAt: laterTime,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "completed" }));
    await expect(
      store.cancelQueuedMessages(conversationKey, { cancelledAt: laterTime }),
    ).resolves.toEqual([expect.objectContaining({ id: "queue-1" })]);
    await expect(
      store.purgeExpiredTelegramAssistantData({ now: futureTime }),
    ).resolves.toEqual({
      messageRefs: 1,
      queuedMessages: 1,
      pendingActions: 0,
    });
  });
});
