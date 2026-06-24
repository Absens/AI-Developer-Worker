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
  TelegramActiveTaskQuestionPrompt,
  TelegramExecutableTaskDraftSession,
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

const executableDraftSession = (
  overrides: Partial<TelegramExecutableTaskDraftSession> = {},
): TelegramExecutableTaskDraftSession => ({
  id: "draft-session-1",
  conversationKey,
  source: "private",
  initiatorUserId: 200,
  chatId: 100,
  messageId: 300,
  originalText: "Create a task for repository setup",
  draft: {
    title: "Repository setup",
    description: "Configure the repository for automated task execution.",
    acceptanceCriteria: ["Typecheck passes"],
    repositoryName: "developer",
    repoPathKey: "developer",
    tags: ["telegram"],
    risk: {
      riskLevel: "low",
      reasons: ["Repository maintenance only"],
      requiresOwnerApproval: false,
    },
    executionMode: "auto_ready",
  },
  status: "collecting",
  clarificationHistory: [],
  createdAt: baseTime,
  updatedAt: baseTime,
  expiresAt: futureTime,
  ...overrides,
});

const executableDraftSessionRow = (
  overrides: Partial<Record<string, unknown>> = {},
): QueryResultRow => ({
  id: "draft-session-1",
  conversation_key: conversationKey,
  source: "private",
  initiator_user_id: 200,
  owner_user_id: null,
  owner_chat_id: null,
  chat_id: 100,
  message_id: 300,
  original_text: "Create a task for repository setup",
  draft: executableDraftSession().draft,
  status: "collecting",
  clarification_question: null,
  clarification_history: [],
  created_at: baseTime,
  updated_at: baseTime,
  expires_at: futureTime,
  ...overrides,
});

const activeTaskQuestionPrompt = (
  overrides: Partial<TelegramActiveTaskQuestionPrompt> = {},
): TelegramActiveTaskQuestionPrompt => ({
  id: "prompt-1",
  conversationKey,
  chatId: 100,
  userId: 200,
  taskId: "DEV-1",
  questionId: "question-1",
  promptMessageId: 301,
  status: "open",
  createdAt: baseTime,
  updatedAt: baseTime,
  expiresAt: futureTime,
  ...overrides,
});

const activeTaskQuestionPromptRow = (
  overrides: Partial<Record<string, unknown>> = {},
): QueryResultRow => ({
  id: "prompt-1",
  conversation_key: conversationKey,
  chat_id: 100,
  user_id: 200,
  task_id: "DEV-1",
  question_id: "question-1",
  prompt_message_id: 301,
  status: "open",
  created_at: baseTime,
  updated_at: baseTime,
  expires_at: futureTime,
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

class ProcessedUpdateProcessingClient {
  public readonly queries: string[] = [];
  public readonly values: unknown[][] = [];
  public released = false;

  public async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.queries.push(text);
    this.values.push(values);
    if (text.includes("pg_advisory_lock") || text.includes("pg_advisory_unlock")) {
      return queryResult([]);
    }
    if (text.includes("telegram_assistant_processed_updates")) {
      return queryResult([{ update_id: 2000 } as unknown as R]);
    }
    throw new Error(`Unexpected SQL in update processing test: ${text}`);
  }

  public release(): void {
    this.released = true;
  }
}

class ProcessedUpdateProcessingPool {
  public readonly client = new ProcessedUpdateProcessingClient();

  public async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
    throw new Error("Update processing test should use a dedicated client.");
  }

  public async connect(): Promise<ProcessedUpdateProcessingClient> {
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

  it("skips update processing operations after claiming an already processed update", async () => {
    const pool = new ProcessedUpdateProcessingPool();
    const store = new PostgresTelegramAssistantStore(pool);
    let operationRan = false;

    const result = await store.withUpdateProcessing(2000, async () => {
      operationRan = true;
    });

    expect(result).toBe(false);
    expect(operationRan).toBe(false);
    expect(pool.client.queries.some((query) =>
      query.includes("pg_advisory_lock"),
    )).toBe(true);
    expect(pool.client.queries.some((query) =>
      query.includes("pg_advisory_unlock"),
    )).toBe(true);
    expect(pool.client.values.some((values) =>
      values.includes("telegram-update:2000"),
    )).toBe(true);
    expect(pool.client.released).toBe(true);
  });
});

describe("PostgresTelegramAssistantStore business connections", () => {
  it("persists and maps business connection read rights", async () => {
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        expect(text).toContain("can_read_messages");
        expect(values).toContain(false);
        return queryResult([
          {
            id: "biz-read-rights",
            user_id: 200,
            user_chat_id: 100,
            can_reply: true,
            can_read_messages: false,
            is_enabled: true,
            created_at: baseTime,
            updated_at: baseTime,
            last_seen_at: baseTime,
            update_id: null,
          } as unknown as R,
        ]);
      },
    };
    const store = new PostgresTelegramAssistantStore(db);

    const saved = await store.upsertBusinessConnection({
      id: "biz-read-rights",
      userId: 200,
      userChatId: 100,
      rights: { can_reply: true, can_read_messages: false },
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
    });

    expect(saved).toMatchObject({
      id: "biz-read-rights",
      canReply: true,
      rights: { can_reply: true, can_read_messages: false },
    });
  });

  it("does not grant business connection read rights when they are omitted", async () => {
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        _text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        expect(values?.[4]).not.toBe(true);
        return queryResult([
          {
            id: "biz-missing-read-rights",
            user_id: 200,
            user_chat_id: 100,
            can_reply: true,
            can_read_messages: null,
            is_enabled: true,
            created_at: baseTime,
            updated_at: baseTime,
            last_seen_at: baseTime,
            update_id: null,
          } as unknown as R,
        ]);
      },
    };
    const store = new PostgresTelegramAssistantStore(db);

    const saved = await store.upsertBusinessConnection({
      id: "biz-missing-read-rights",
      userId: 200,
      userChatId: 100,
      rights: { can_reply: true },
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
    });

    expect(saved).toEqual(expect.objectContaining({
      id: "biz-missing-read-rights",
      canReply: true,
      rights: expect.not.objectContaining({ can_read_messages: true }),
    }));
  });
});

describe("PostgresTelegramAssistantStore conversation purge", () => {
  it("deletes pending actions with other conversation-scoped Telegram assistant data", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        const rowCount = text.includes("DELETE FROM telegram_assistant_") ||
          text.includes("DELETE FROM telegram_executable_task_draft_sessions") ||
          text.includes("DELETE FROM telegram_active_task_question_prompts")
          ? 1
          : null;
        return {
          command: "DELETE",
          oid: 0,
          fields: [],
          rows: [],
          rowCount,
        };
      },
    };
    const store = new PostgresTelegramAssistantStore(db);

    await expect(
      store.purgeTelegramConversationData({ conversationKey }),
    ).resolves.toEqual({
      messageRefs: 1,
      queuedMessages: 1,
      assistantTurns: 1,
      pendingActions: 1,
      executableTaskDraftSessions: 1,
      activeTaskQuestionPrompts: 1,
    });
    expect(queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("DELETE FROM telegram_assistant_pending_actions"),
      expect.stringContaining("DELETE FROM telegram_executable_task_draft_sessions"),
      expect.stringContaining("DELETE FROM telegram_active_task_question_prompts"),
    ]));
    expect(queries.filter((query) =>
      query.text.includes("DELETE FROM telegram_assistant_") ||
      query.text.includes("DELETE FROM telegram_executable_task_draft_sessions") ||
      query.text.includes("DELETE FROM telegram_active_task_question_prompts")
    ).map((query) => query.values)).toEqual([
      [conversationKey],
      [conversationKey],
      [conversationKey],
      [conversationKey],
      [conversationKey],
      [conversationKey],
    ]);
  });
});

describe("PostgresTelegramAssistantStore expired data purge", () => {
  it("expires active intake rows and deletes expired terminal intake rows", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        const rowCount = text.includes("telegram_executable_task_draft_sessions") ||
          text.includes("telegram_active_task_question_prompts")
          ? 2
          : 0;
        return {
          command: text.trimStart().startsWith("UPDATE") ? "UPDATE" : "DELETE",
          oid: 0,
          fields: [],
          rows: [],
          rowCount,
        };
      },
    };
    const store = new PostgresTelegramAssistantStore(db);

    await expect(
      store.purgeExpiredTelegramAssistantData({ now: baseTime }),
    ).resolves.toEqual({
      messageRefs: 0,
      queuedMessages: 0,
      pendingActions: 0,
      executableTaskDraftSessions: 4,
      activeTaskQuestionPrompts: 4,
    });
    expect(queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("DELETE FROM telegram_executable_task_draft_sessions"),
      expect.stringContaining("UPDATE telegram_executable_task_draft_sessions"),
      expect.stringContaining("DELETE FROM telegram_active_task_question_prompts"),
      expect.stringContaining("UPDATE telegram_active_task_question_prompts"),
    ]));
    expect(queries.some((query) =>
      query.text.includes("status = ANY($2::text[])") &&
      query.values?.[1] instanceof Array &&
      (query.values[1] as string[]).includes("completed") &&
      (query.values[1] as string[]).includes("cancelled") &&
      (query.values[1] as string[]).includes("expired")
    )).toBe(true);
    expect(queries.some((query) =>
      query.text.includes("status = 'open'") &&
      query.text.includes("SET status = 'expired'")
    )).toBe(true);
  });
});

describe("PostgresTelegramAssistantStore executable task intake", () => {
  it("upserts and maps executable draft sessions", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        expect(text).toContain("telegram_executable_task_draft_sessions");
        expect(text).toContain("ON CONFLICT (id)");
        expect(values).toContain(JSON.stringify(executableDraftSession().draft));
        return queryResult([executableDraftSessionRow() as R]);
      },
    };
    const store = new PostgresTelegramAssistantStore(db);

    await expect(
      store.upsertExecutableTaskDraftSession(executableDraftSession()),
    ).resolves.toEqual(expect.objectContaining({
      id: "draft-session-1",
      draft: expect.objectContaining({ title: "Repository setup" }),
      clarificationHistory: [],
    }));
    expect(queries).toHaveLength(1);
  });

  it("selects active executable draft sessions by active statuses and expiry", async () => {
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        expect(text).toContain("telegram_executable_task_draft_sessions");
        expect(text).toContain("expires_at > $2");
        expect(text).toContain("status = ANY($3::text[])");
        expect(text).toContain("ORDER BY updated_at DESC, id DESC");
        expect(values).toEqual([
          conversationKey,
          baseTime,
          ["collecting", "awaiting_user_confirmation", "awaiting_owner_approval"],
        ]);
        return queryResult([
          executableDraftSessionRow({
            id: "active-session",
            status: "awaiting_owner_approval",
          }) as R,
        ]);
      },
    };
    const store = new PostgresTelegramAssistantStore(db, {
      now: () => new Date(baseTime),
    });

    await expect(
      store.getActiveExecutableTaskDraftSession(conversationKey),
    ).resolves.toEqual(expect.objectContaining({
      id: "active-session",
      status: "awaiting_owner_approval",
    }));
  });

  it("completes executable draft sessions and reports missing rows", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        if (text.includes("UPDATE telegram_executable_task_draft_sessions")) {
          return queryResult([
            executableDraftSessionRow({
              status: "completed",
              updated_at: laterTime,
            }) as R,
          ]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const store = new PostgresTelegramAssistantStore(db);

    await expect(
      store.completeExecutableTaskDraftSession("draft-session-1", {
        status: "completed",
        updatedAt: laterTime,
      }),
    ).resolves.toEqual(expect.objectContaining({
      status: "completed",
      updatedAt: laterTime,
    }));
    expect(queries[0]?.values).toEqual(["draft-session-1", "completed", laterTime]);

    const missingStore = new PostgresTelegramAssistantStore({
      async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
        return queryResult([]);
      },
    });
    await expect(
      missingStore.completeExecutableTaskDraftSession("missing-session", {
        status: "expired",
        updatedAt: laterTime,
      }),
    ).rejects.toThrow(
      "Telegram executable task draft session not found: missing-session",
    );
  });

  it("upserts and selects active task question prompts", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        if (text.includes("INSERT INTO telegram_active_task_question_prompts")) {
          expect(values).toContain("prompt-1");
          return queryResult([activeTaskQuestionPromptRow() as R]);
        }
        expect(text).toContain("WHERE conversation_key = $1");
        expect(text).toContain("status = 'open'");
        expect(text).toContain("expires_at > $2");
        return queryResult([activeTaskQuestionPromptRow() as R]);
      },
    };
    const store = new PostgresTelegramAssistantStore(db, {
      now: () => new Date(baseTime),
    });

    await expect(
      store.upsertActiveTaskQuestionPrompt(activeTaskQuestionPrompt()),
    ).resolves.toEqual(expect.objectContaining({ id: "prompt-1" }));
    await expect(
      store.getActiveTaskQuestionPrompt(conversationKey),
    ).resolves.toEqual(expect.objectContaining({ id: "prompt-1" }));
    expect(queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("telegram_active_task_question_prompts"),
    ]));
  });

  it("does not reopen an answered active task prompt from a later open upsert", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        if (text.includes("INSERT INTO telegram_active_task_question_prompts")) {
          expect(text).toContain("ON CONFLICT (id)");
          expect(text).toContain("status = 'open'");
          expect(text).toContain("EXCLUDED.status <> 'open'");
          return queryResult([]);
        }
        if (text.includes("WHERE id = $1")) {
          expect(values).toEqual(["prompt-1"]);
          return queryResult([
            activeTaskQuestionPromptRow({
              status: "answered",
              updated_at: laterTime,
            }) as R,
          ]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const store = new PostgresTelegramAssistantStore(db, {
      now: () => new Date(baseTime),
    });

    await expect(
      store.upsertActiveTaskQuestionPrompt(activeTaskQuestionPrompt({
        status: "open",
        updatedAt: futureTime,
      })),
    ).resolves.toEqual(expect.objectContaining({
      id: "prompt-1",
      status: "answered",
      updatedAt: laterTime,
    }));
    expect(queries).toHaveLength(2);
  });

  it("consumes active task question prompts inside a transaction and returns the original prompt", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return queryResult([]);
        }
        if (text.includes("FOR UPDATE")) {
          expect(text).toContain("telegram_active_task_question_prompts");
          expect(values).toEqual([conversationKey, laterTime]);
          return queryResult([activeTaskQuestionPromptRow() as R]);
        }
        if (text.includes("UPDATE telegram_active_task_question_prompts")) {
          expect(values).toEqual(["prompt-1", laterTime]);
          return queryResult([
            activeTaskQuestionPromptRow({
              status: "answered",
              updated_at: laterTime,
            }) as R,
          ]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const store = new PostgresTelegramAssistantStore(db, {
      now: () => new Date(baseTime),
    });

    await expect(
      store.consumeActiveTaskQuestionPrompt({
        conversationKey,
        chatId: 100,
        userId: 200,
        answeredAt: laterTime,
      }),
    ).resolves.toEqual(expect.objectContaining({
      id: "prompt-1",
      status: "open",
    }));
    expect(queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("UPDATE telegram_active_task_question_prompts"),
      "COMMIT",
    ]);
  });
});

describe("PostgresTelegramAssistantStore digital twin sessions", () => {
  it("uses a transaction advisory lock for digital twin sessions", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<R>> {
        queries.push({ text, values });
        return queryResult([]);
      },
    };
    const store = new PostgresTelegramAssistantStore(db);

    await store.withDigitalTwinSessionLock("business:bc_1:777", async () => "ok");

    expect(queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      "COMMIT",
    ]));
    expect(queries.some((query) =>
      query.values?.includes("telegram-digital-twin:business:bc_1:777")
    )).toBe(true);
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

  it("adds business connection update ids in a separate migration after 0011", () => {
    const migrations = listInternalTrackerMigrations();
    const telegramMigration = migrations.find((migration) =>
      migration.filename === "0011_telegram_assistant.sql"
    );
    const updateIdMigration = migrations.find((migration) =>
      migration.filename === "0012_telegram_business_connection_update_id.sql"
    );
    const businessConnectionTable = telegramMigration?.sql.match(
      /CREATE TABLE IF NOT EXISTS telegram_profile_automation_connections \([\s\S]*?\);/,
    )?.[0];

    expect(businessConnectionTable).toContain(
      "CREATE TABLE IF NOT EXISTS telegram_profile_automation_connections",
    );
    expect(businessConnectionTable).not.toContain("update_id");
    expect(updateIdMigration?.version).toBe("0012");
    expect(updateIdMigration?.sql).toContain(
      "ALTER TABLE telegram_profile_automation_connections",
    );
    expect(updateIdMigration?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS update_id bigint",
    );
  });

  it("adds business connection read rights in a separate migration after 0012", () => {
    const migrations = listInternalTrackerMigrations();
    const telegramMigration = migrations.find((migration) =>
      migration.filename === "0011_telegram_assistant.sql"
    );
    const readRightsMigration = migrations.find((migration) =>
      migration.filename === "0013_telegram_business_connection_read_rights.sql"
    );
    const businessConnectionTable = telegramMigration?.sql.match(
      /CREATE TABLE IF NOT EXISTS telegram_profile_automation_connections \([\s\S]*?\);/,
    )?.[0];

    expect(businessConnectionTable).not.toContain("can_read_messages");
    expect(readRightsMigration?.version).toBe("0013");
    expect(readRightsMigration?.sql).toContain(
      "ALTER TABLE telegram_profile_automation_connections",
    );
    expect(readRightsMigration?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS can_read_messages boolean",
    );
    expect(readRightsMigration?.sql).not.toMatch(
      /can_read_messages boolean[^\n;]*DEFAULT true/i,
    );
  });

  it("adds Telegram digital twin tables in migration 0014", () => {
    const migrations = listInternalTrackerMigrations();
    const migration = migrations.find((candidate) =>
      candidate.filename === "0014_telegram_digital_twin.sql"
    );

    expect(migration?.version).toBe("0014");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS telegram_digital_twin_sessions");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS telegram_digital_twin_messages");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS telegram_digital_twin_turns");
    expect(migration?.sql).toContain("telegram_digital_twin_turns_running_unique_idx");
  });

  it("adds Telegram executable task intake tables in migration 0015", () => {
    const migrations = listInternalTrackerMigrations();
    const migration = migrations.find((candidate) =>
      candidate.filename === "0015_telegram_executable_task_intake.sql"
    );

    expect(migration?.version).toBe("0015");
    expect(migration?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS telegram_executable_task_draft_sessions",
    );
    expect(migration?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS telegram_active_task_question_prompts",
    );
    expect(migration?.sql).toContain("CHECK (source IN ('private', 'business', 'twin'))");
    expect(migration?.sql).toContain(
      "CHECK (status IN ('collecting', 'awaiting_user_confirmation', 'awaiting_owner_approval', 'completed', 'cancelled', 'expired'))",
    );
    expect(migration?.sql).toContain(
      "CHECK (status IN ('open', 'answered', 'cancelled', 'expired'))",
    );
    expect(migration?.sql).toContain(
      "telegram_executable_task_draft_sessions_active_idx",
    );
    expect(migration?.sql).toContain(
      "telegram_executable_task_draft_sessions_expiry_idx",
    );
    expect(migration?.sql).toContain(
      "telegram_active_task_question_prompts_conversation_idx",
    );
    expect(migration?.sql).toContain(
      "telegram_active_task_question_prompts_task_idx",
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
      executableTaskDraftSessions: 0,
      activeTaskQuestionPrompts: 0,
    });
  });

  it("does not overwrite newer business connection records with stale updates", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });

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

    expect(result).toMatchObject({
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
    await expect(store.getBusinessConnection("biz-stale")).resolves.toMatchObject({
      id: "biz-stale",
      businessConnectionId: "biz-stale",
      ownerUserId: "201",
      ownerChatId: "101",
      rights: { can_reply: false },
    });
  });

  it("round-trips business connection read rights", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });

    const saved = await store.upsertBusinessConnection({
      id: "biz-read-rights",
      userId: 200,
      userChatId: 100,
      rights: { can_reply: true, can_read_messages: false },
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
    });

    expect(saved).toEqual(expect.objectContaining({
      id: "biz-read-rights",
      canReply: true,
      rights: { can_reply: true, can_read_messages: false },
    }));
    await expect(store.getBusinessConnection("biz-read-rights")).resolves.toEqual(
      expect.objectContaining({
        id: "biz-read-rights",
        canReply: true,
        rights: { can_reply: true, can_read_messages: false },
      }),
    );
  });

  it("round-trips omitted business connection read rights without granting them", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });

    const saved = await store.upsertBusinessConnection({
      id: "biz-missing-read-rights",
      userId: 200,
      userChatId: 100,
      rights: { can_reply: true },
      isEnabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastSeenAt: baseTime,
    });

    expect(saved).toEqual(expect.objectContaining({
      id: "biz-missing-read-rights",
      canReply: true,
      rights: expect.not.objectContaining({ can_read_messages: true }),
    }));
    await expect(
      store.getBusinessConnection("biz-missing-read-rights"),
    ).resolves.toEqual(expect.objectContaining({
      id: "biz-missing-read-rights",
      canReply: true,
      rights: expect.not.objectContaining({ can_read_messages: true }),
    }));
  });

  it("persists digital twin sessions, messages, turns, and purge", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });
    const sessionKey = "business:bc_1:777";

    await store.upsertDigitalTwinSession({
      sessionKey,
      source: "business",
      chatId: 777,
      businessConnectionId: "bc_1",
      ownerUserId: "10",
      ownerChatId: "99",
      status: "active",
      codexThreadId: "thread_1",
      personaProfileVersion: "default",
      summaryNeedsRefresh: false,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const reserved = await store.reserveDigitalTwinMessage({
      id: "dtm-1",
      sessionKey,
      messageKey: "telegram-business:bc_1:777:10",
      telegramUpdateId: 2,
      direction: "inbound",
      telegramMessageId: 10,
      deliveryStatus: "received",
      redactedText: "hello",
      createdAt: baseTime,
      metadata: {},
    });
    const duplicate = await store.reserveDigitalTwinMessage({
      id: "dtm-duplicate",
      sessionKey,
      messageKey: "telegram-business:bc_1:777:10",
      telegramUpdateId: 2,
      direction: "inbound",
      telegramMessageId: 10,
      deliveryStatus: "received",
      redactedText: "hello",
      createdAt: baseTime,
      metadata: {},
    });
    const turn = await store.startDigitalTwinTurn({
      id: "dtt-1",
      sessionKey,
      inboundMessageKey: "telegram-business:bc_1:777:10",
      outboundMessageKey: "telegram-business-reply:bc_1:777:10",
      status: "running",
      codexThreadId: "thread_1",
      startedAt: baseTime,
      metadata: {},
    });
    const competingTurn = await store.startDigitalTwinTurn({
      id: "dtt-2",
      sessionKey,
      inboundMessageKey: "telegram-business:bc_1:777:11",
      outboundMessageKey: "telegram-business-reply:bc_1:777:11",
      status: "running",
      startedAt: baseTime,
      metadata: {},
    });

    expect(reserved.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(turn).toEqual(expect.objectContaining({ id: "dtt-1" }));
    expect(competingTurn).toBeUndefined();
    await expect(store.getDigitalTwinSession(sessionKey)).resolves.toEqual(
      expect.objectContaining({ codexThreadId: "thread_1" }),
    );
    await expect(store.listDigitalTwinMessages(sessionKey)).resolves.toHaveLength(1);
    await expect(store.pruneDigitalTwinAuditData({
      redactedBefore: laterTime,
      fullTextBefore: laterTime,
    })).resolves.toEqual({
      redactedTextsCleared: 1,
      fullTextsCleared: 0,
    });
    await expect(store.purgeDigitalTwinSessionData(sessionKey)).resolves.toEqual({
      sessions: 1,
      messages: 1,
      turns: 1,
    });
  });

  it("persists executable draft sessions and active task prompts", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });

    await store.upsertExecutableTaskDraftSession(executableDraftSession());
    await store.upsertActiveTaskQuestionPrompt(activeTaskQuestionPrompt());

    await expect(
      store.getExecutableTaskDraftSession("draft-session-1"),
    ).resolves.toEqual(expect.objectContaining({
      id: "draft-session-1",
      draft: expect.objectContaining({ title: "Repository setup" }),
    }));
    await expect(
      store.getActiveExecutableTaskDraftSession(conversationKey),
    ).resolves.toEqual(expect.objectContaining({ id: "draft-session-1" }));
    await expect(
      store.getActiveTaskQuestionPrompt(conversationKey),
    ).resolves.toEqual(expect.objectContaining({ id: "prompt-1" }));
    await expect(
      store.consumeActiveTaskQuestionPrompt({
        conversationKey,
        chatId: 100,
        userId: 200,
        answeredAt: laterTime,
      }),
    ).resolves.toEqual(expect.objectContaining({
      id: "prompt-1",
      status: "open",
    }));
    await expect(
      store.completeExecutableTaskDraftSession("draft-session-1", {
        status: "completed",
        updatedAt: laterTime,
      }),
    ).resolves.toEqual(expect.objectContaining({
      id: "draft-session-1",
      status: "completed",
    }));
  });

  it("does not overwrite newer business connection records with same-second stale update ids", async () => {
    await runInternalTrackerMigrations(pool);
    const store = new PostgresTelegramAssistantStore(pool, {
      now: () => new Date(baseTime),
    });
    const expected = {
      id: "biz-same-second",
      businessConnectionId: "biz-same-second",
      userId: 201,
      ownerUserId: "201",
      userChatId: 101,
      ownerChatId: "101",
      canReply: false,
      rights: { can_reply: false },
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

    expect(lowerUpdate).toMatchObject(expected);
    expect(equalUpdate).toMatchObject(expected);
    await expect(store.getBusinessConnection("biz-same-second")).resolves.toMatchObject(
      expected,
    );
  });
});
