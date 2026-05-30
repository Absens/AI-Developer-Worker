import type { QueryResultRow } from "pg";

import type {
  PostgresPoolLike,
  PostgresQueryable,
} from "../../integrations/internalTracker/postgresTaskTracker.js";
import type {
  CancelQueuedMessagesInput,
  CompleteAssistantTurnInput,
  CompleteNotificationDeliveryInput,
  CompletePendingActionInput,
  ConsumePendingActionInput,
  ListPendingActionsInput,
  PurgeExpiredTelegramAssistantDataInput,
  PurgeExpiredTelegramAssistantDataResult,
  ReserveNotificationDeliveryInput,
  TelegramAssistantStore,
} from "./store.js";
import type {
  TelegramAssistantTurn,
  TelegramBusinessConnectionRecord,
  TelegramInboundMessage,
  TelegramIntent,
  TelegramMessageRef,
  TelegramNotificationDelivery,
  TelegramNotificationDeliveryStatus,
  TelegramPendingAction,
  TelegramPendingActionStatus,
  TelegramQueuedMessage,
  TelegramTaskSubscription,
} from "./types.js";

export interface PostgresTelegramAssistantStoreOptions {
  now?: () => Date;
}

type TransactionClient = PostgresQueryable & { release?: () => void };

type OffsetRow = QueryResultRow & {
  offset_value: number | string;
};

type PendingActionRow = QueryResultRow & {
  id: string;
  conversation_key: string;
  chat_id: number | string;
  user_id: number | string;
  intent: unknown;
  payload: unknown;
  status: TelegramPendingActionStatus;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  completed_at: Date | string | null;
};

type MessageRefRow = QueryResultRow & {
  id: string;
  conversation_key: string;
  chat_id: number | string;
  message_id: number | string;
  source: TelegramMessageRef["source"];
  redacted_text: string;
  created_at: Date | string;
  expires_at: Date | string;
};

type AssistantTurnRow = QueryResultRow & {
  id: string;
  conversation_key: string;
  status: TelegramAssistantTurn["status"];
  started_at: Date | string;
  input: unknown | null;
  thread_id: string | null;
  completed_at: Date | string | null;
  diagnostic: string | null;
};

type QueuedMessageRow = QueryResultRow & {
  id: string;
  conversation_key: string;
  chat_id: number | string;
  user_id: number | string | null;
  message: unknown;
  status: TelegramQueuedMessage["status"];
  created_at: Date | string;
  expires_at: Date | string;
  cancelled_at: Date | string | null;
};

type TaskSubscriptionRow = QueryResultRow & {
  id: string;
  task_id: string;
  conversation_key: string;
  chat_id: number | string;
  user_id: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_notified_event_id: string | null;
};

type NotificationDeliveryRow = QueryResultRow & {
  id: string;
  subscription_id: string;
  event_id: string;
  status: TelegramNotificationDeliveryStatus;
  reserved_at: Date | string;
  stale_after: Date | string;
  completed_at: Date | string | null;
  error_message: string | null;
};

type BusinessConnectionRow = QueryResultRow & {
  id: string;
  user_id: number | string;
  user_chat_id: number | string;
  can_reply: boolean;
  is_enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  last_seen_at: Date | string;
  update_id: number | string | null;
};

const TERMINAL_PENDING_ACTION_STATUSES = new Set<TelegramPendingActionStatus>([
  "completed",
  "cancelled",
  "expired",
]);

const TERMINAL_NOTIFICATION_DELIVERY_STATUSES =
  new Set<TelegramNotificationDeliveryStatus>(["sent", "failed"]);

const isPoolLike = (value: PostgresQueryable): value is PostgresPoolLike =>
  typeof (value as { connect?: unknown }).connect === "function";

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

const optionalIso = (value: Date | string | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : toIso(value);

const toNumber = (value: number | string): number => Number(value);

const clone = <T>(value: T): T => structuredClone(value);

const jsonValue = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) {
    return clone(fallback);
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return clone(value as T);
};

const mapPendingActionRow = (row: PendingActionRow): TelegramPendingAction => ({
  id: row.id,
  conversationKey: row.conversation_key,
  chatId: toNumber(row.chat_id),
  userId: toNumber(row.user_id),
  intent: jsonValue<TelegramIntent>(row.intent, {
    name: "unknown",
    confidence: 0,
  }),
  payload: jsonValue<Record<string, unknown>>(row.payload, {}),
  status: row.status,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
  expiresAt: toIso(row.expires_at),
  ...(optionalIso(row.consumed_at) ? { consumedAt: optionalIso(row.consumed_at) } : {}),
  ...(optionalIso(row.completed_at)
    ? { completedAt: optionalIso(row.completed_at) }
    : {}),
});

const mapMessageRefRow = (row: MessageRefRow): TelegramMessageRef => ({
  id: row.id,
  conversationKey: row.conversation_key,
  chatId: toNumber(row.chat_id),
  messageId: toNumber(row.message_id),
  source: row.source,
  redactedText: row.redacted_text,
  createdAt: toIso(row.created_at),
  expiresAt: toIso(row.expires_at),
});

const mapAssistantTurnRow = (row: AssistantTurnRow): TelegramAssistantTurn => ({
  id: row.id,
  conversationKey: row.conversation_key,
  status: row.status,
  startedAt: toIso(row.started_at),
  ...(row.input
    ? { input: jsonValue<TelegramInboundMessage | undefined>(row.input, undefined) }
    : {}),
  ...(row.thread_id ? { threadId: row.thread_id } : {}),
  ...(optionalIso(row.completed_at)
    ? { completedAt: optionalIso(row.completed_at) }
    : {}),
  ...(row.diagnostic ? { diagnostic: row.diagnostic } : {}),
});

const mapQueuedMessageRow = (row: QueuedMessageRow): TelegramQueuedMessage => ({
  id: row.id,
  conversationKey: row.conversation_key,
  chatId: toNumber(row.chat_id),
  ...(row.user_id !== null ? { userId: toNumber(row.user_id) } : {}),
  message: jsonValue<TelegramInboundMessage>(row.message, {
    id: "missing",
    updateId: 0,
    conversationKey: row.conversation_key,
    source: "bot_private",
    chatId: toNumber(row.chat_id),
    receivedAt: toIso(row.created_at),
  }),
  status: row.status,
  createdAt: toIso(row.created_at),
  expiresAt: toIso(row.expires_at),
  ...(optionalIso(row.cancelled_at)
    ? { cancelledAt: optionalIso(row.cancelled_at) }
    : {}),
});

const mapTaskSubscriptionRow = (
  row: TaskSubscriptionRow,
): TelegramTaskSubscription => ({
  id: row.id,
  taskId: row.task_id,
  conversationKey: row.conversation_key,
  chatId: toNumber(row.chat_id),
  ...(row.user_id !== null ? { userId: toNumber(row.user_id) } : {}),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
  ...(row.last_notified_event_id
    ? { lastNotifiedEventId: row.last_notified_event_id }
    : {}),
});

const mapNotificationDeliveryRow = (
  row: NotificationDeliveryRow,
): TelegramNotificationDelivery => ({
  id: row.id,
  subscriptionId: row.subscription_id,
  eventId: row.event_id,
  status: row.status,
  reservedAt: toIso(row.reserved_at),
  staleAfter: toIso(row.stale_after),
  ...(optionalIso(row.completed_at)
    ? { completedAt: optionalIso(row.completed_at) }
    : {}),
  ...(row.error_message ? { errorMessage: row.error_message } : {}),
});

const mapBusinessConnectionRow = (
  row: BusinessConnectionRow,
): TelegramBusinessConnectionRecord => ({
  id: row.id,
  userId: toNumber(row.user_id),
  userChatId: toNumber(row.user_chat_id),
  canReply: row.can_reply,
  isEnabled: row.is_enabled,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
  lastSeenAt: toIso(row.last_seen_at),
  ...(row.update_id !== null ? { updateId: toNumber(row.update_id) } : {}),
});

export class PostgresTelegramAssistantStore implements TelegramAssistantStore {
  private readonly now: () => Date;

  public constructor(
    private readonly db: PostgresQueryable,
    options: PostgresTelegramAssistantStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async getOffset(scope: string): Promise<number | undefined> {
    const result = await this.db.query<OffsetRow>(
      `
        SELECT offset_value
        FROM telegram_assistant_offsets
        WHERE scope = $1
      `,
      [scope],
    );
    const row = result.rows[0];
    return row ? toNumber(row.offset_value) : undefined;
  }

  public async saveOffset(scope: string, offset: number): Promise<void> {
    await this.db.query(
      `
        INSERT INTO telegram_assistant_offsets (scope, offset_value, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (scope)
        DO UPDATE SET
          offset_value = EXCLUDED.offset_value,
          updated_at = EXCLUDED.updated_at
      `,
      [scope, offset, this.nowIso()],
    );
  }

  public async isUpdateProcessed(updateId: number): Promise<boolean> {
    const result = await this.db.query(
      `
        SELECT 1
        FROM telegram_assistant_processed_updates
        WHERE update_id = $1
      `,
      [updateId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async markUpdateProcessed(updateId: number): Promise<void> {
    await this.db.query(
      `
        INSERT INTO telegram_assistant_processed_updates (update_id, processed_at)
        VALUES ($1, $2)
        ON CONFLICT (update_id) DO NOTHING
      `,
      [updateId, this.nowIso()],
    );
  }

  public async withPollingLease<T>(
    leaseKey: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    const client: TransactionClient = isPoolLike(this.db)
      ? await this.db.connect()
      : this.db;
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [leaseKey],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) {
        return undefined;
      }
      return await operation();
    } finally {
      if (locked) {
        await client
          .query("SELECT pg_advisory_unlock(hashtext($1))", [leaseKey])
          .catch(() => undefined);
      }
      client.release?.();
    }
  }

  public async withConversationLock<T>(
    conversationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `telegram-conversation:${conversationKey}`,
      ]);
      return operation();
    });
  }

  public async recordMessageRef(
    ref: TelegramMessageRef,
  ): Promise<TelegramMessageRef> {
    const result = await this.db.query<MessageRefRow>(
      `
        INSERT INTO telegram_assistant_message_refs (
          id, conversation_key, chat_id, message_id, source,
          redacted_text, created_at, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id)
        DO UPDATE SET
          conversation_key = EXCLUDED.conversation_key,
          chat_id = EXCLUDED.chat_id,
          message_id = EXCLUDED.message_id,
          source = EXCLUDED.source,
          redacted_text = EXCLUDED.redacted_text,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
        RETURNING *
      `,
      [
        ref.id,
        ref.conversationKey,
        ref.chatId,
        ref.messageId,
        ref.source,
        ref.redactedText,
        ref.createdAt,
        ref.expiresAt,
      ],
    );
    return mapMessageRefRow(result.rows[0]!);
  }

  public async listMessageRefs(
    conversationKey: string,
  ): Promise<TelegramMessageRef[]> {
    const result = await this.db.query<MessageRefRow>(
      `
        SELECT *
        FROM telegram_assistant_message_refs
        WHERE conversation_key = $1
        ORDER BY created_at, id
      `,
      [conversationKey],
    );
    return result.rows.map(mapMessageRefRow);
  }

  public async startAssistantTurn(
    turn: TelegramAssistantTurn,
  ): Promise<TelegramAssistantTurn> {
    const result = await this.db.query<AssistantTurnRow>(
      `
        INSERT INTO telegram_assistant_turns (
          id, conversation_key, status, started_at, input,
          thread_id, completed_at, diagnostic
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
        ON CONFLICT (id)
        DO UPDATE SET
          conversation_key = EXCLUDED.conversation_key,
          status = EXCLUDED.status,
          started_at = EXCLUDED.started_at,
          input = EXCLUDED.input,
          thread_id = EXCLUDED.thread_id,
          completed_at = EXCLUDED.completed_at,
          diagnostic = EXCLUDED.diagnostic
        RETURNING *
      `,
      [
        turn.id,
        turn.conversationKey,
        turn.status,
        turn.startedAt,
        turn.input ? JSON.stringify(turn.input) : null,
        turn.threadId ?? null,
        turn.completedAt ?? null,
        turn.diagnostic ?? null,
      ],
    );
    return mapAssistantTurnRow(result.rows[0]!);
  }

  public async getActiveAssistantTurn(
    conversationKey: string,
  ): Promise<TelegramAssistantTurn | undefined> {
    const result = await this.db.query<AssistantTurnRow>(
      `
        SELECT *
        FROM telegram_assistant_turns
        WHERE conversation_key = $1
          AND status = 'running'
        ORDER BY started_at DESC, id
        LIMIT 1
      `,
      [conversationKey],
    );
    const row = result.rows[0];
    return row ? mapAssistantTurnRow(row) : undefined;
  }

  public async completeAssistantTurn(
    turnId: string,
    input: CompleteAssistantTurnInput,
  ): Promise<TelegramAssistantTurn> {
    const completedAt = input.completedAt ?? this.nowIso();
    const result = await this.db.query<AssistantTurnRow>(
      `
        UPDATE telegram_assistant_turns
        SET status = $2,
            completed_at = $3,
            thread_id = COALESCE($4, thread_id),
            diagnostic = COALESCE($5, diagnostic)
        WHERE id = $1
        RETURNING *
      `,
      [turnId, input.status, completedAt, input.threadId ?? null, input.diagnostic ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Telegram assistant turn not found: ${turnId}`);
    }
    return mapAssistantTurnRow(row);
  }

  public async completeAssistantTurnIfRunning(
    turnId: string,
    input: CompleteAssistantTurnInput,
  ): Promise<TelegramAssistantTurn | undefined> {
    const completedAt = input.completedAt ?? this.nowIso();
    const result = await this.db.query<AssistantTurnRow>(
      `
        UPDATE telegram_assistant_turns
        SET status = $2,
            completed_at = $3,
            thread_id = COALESCE($4, thread_id),
            diagnostic = COALESCE($5, diagnostic)
        WHERE id = $1
          AND status = 'running'
        RETURNING *
      `,
      [turnId, input.status, completedAt, input.threadId ?? null, input.diagnostic ?? null],
    );
    const row = result.rows[0];
    return row ? mapAssistantTurnRow(row) : undefined;
  }

  public async enqueueMessage(
    message: TelegramQueuedMessage,
  ): Promise<TelegramQueuedMessage> {
    const result = await this.db.query<QueuedMessageRow>(
      `
        INSERT INTO telegram_assistant_queued_messages (
          id, conversation_key, chat_id, user_id, message,
          status, created_at, expires_at, cancelled_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        ON CONFLICT (id)
        DO UPDATE SET
          conversation_key = EXCLUDED.conversation_key,
          chat_id = EXCLUDED.chat_id,
          user_id = EXCLUDED.user_id,
          message = EXCLUDED.message,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          cancelled_at = EXCLUDED.cancelled_at
        RETURNING *
      `,
      [
        message.id,
        message.conversationKey,
        message.chatId,
        message.userId ?? null,
        JSON.stringify(message.message),
        message.status,
        message.createdAt,
        message.expiresAt,
        message.cancelledAt ?? null,
      ],
    );
    return mapQueuedMessageRow(result.rows[0]!);
  }

  public async listQueuedMessages(
    conversationKey: string,
  ): Promise<TelegramQueuedMessage[]> {
    const result = await this.db.query<QueuedMessageRow>(
      `
        SELECT *
        FROM telegram_assistant_queued_messages
        WHERE conversation_key = $1
          AND status = 'queued'
        ORDER BY created_at, id
      `,
      [conversationKey],
    );
    return result.rows.map(mapQueuedMessageRow);
  }

  public async deleteQueuedMessage(messageId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM telegram_assistant_queued_messages WHERE id = $1",
      [messageId],
    );
  }

  public async cancelQueuedMessages(
    conversationKey: string,
    input: CancelQueuedMessagesInput = {},
  ): Promise<TelegramQueuedMessage[]> {
    const cancelledAt = input.cancelledAt ?? this.nowIso();
    const result = await this.db.query<QueuedMessageRow>(
      `
        UPDATE telegram_assistant_queued_messages
        SET status = 'cancelled',
            cancelled_at = $2
        WHERE conversation_key = $1
          AND status = 'queued'
        RETURNING *
      `,
      [conversationKey, cancelledAt],
    );
    return result.rows.map(mapQueuedMessageRow);
  }

  public async upsertPendingAction(
    action: TelegramPendingAction,
  ): Promise<TelegramPendingAction> {
    const result = await this.db.query<PendingActionRow>(
      `
        INSERT INTO telegram_assistant_pending_actions (
          id, conversation_key, chat_id, user_id, intent, payload,
          status, created_at, updated_at, expires_at, consumed_at, completed_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id)
        DO UPDATE SET
          conversation_key = EXCLUDED.conversation_key,
          chat_id = EXCLUDED.chat_id,
          user_id = EXCLUDED.user_id,
          intent = EXCLUDED.intent,
          payload = EXCLUDED.payload,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at,
          consumed_at = EXCLUDED.consumed_at,
          completed_at = EXCLUDED.completed_at
        RETURNING *
      `,
      [
        action.id,
        action.conversationKey,
        action.chatId,
        action.userId,
        JSON.stringify(action.intent),
        JSON.stringify(action.payload),
        action.status,
        action.createdAt,
        action.updatedAt,
        action.expiresAt,
        action.consumedAt ?? null,
        action.completedAt ?? null,
      ],
    );
    return mapPendingActionRow(result.rows[0]!);
  }

  public async getPendingAction(
    actionId: string,
  ): Promise<TelegramPendingAction | undefined> {
    const result = await this.db.query<PendingActionRow>(
      `
        SELECT *
        FROM telegram_assistant_pending_actions
        WHERE id = $1
      `,
      [actionId],
    );
    const row = result.rows[0];
    return row ? mapPendingActionRow(row) : undefined;
  }

  public async listPendingActions(
    input: ListPendingActionsInput = {},
  ): Promise<TelegramPendingAction[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (input.conversationKey) {
      clauses.push(`conversation_key = ${addParam(input.conversationKey)}`);
    }
    if (input.status) {
      const statuses = Array.isArray(input.status) ? input.status : [input.status];
      clauses.push(`status = ANY(${addParam(statuses)}::text[])`);
    }

    const result = await this.db.query<PendingActionRow>(
      `
        SELECT *
        FROM telegram_assistant_pending_actions
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at, id
      `,
      params,
    );
    return result.rows.map(mapPendingActionRow);
  }

  public async consumePendingAction(
    input: ConsumePendingActionInput,
  ): Promise<TelegramPendingAction | undefined> {
    const now = input.now ?? this.nowIso();
    const result = await this.db.query<PendingActionRow>(
      `
        UPDATE telegram_assistant_pending_actions
        SET status = $5,
            consumed_at = $6,
            updated_at = $6
        WHERE id = $1
          AND status = 'pending'
          AND chat_id = $2
          AND user_id = $3
          AND expires_at > $4
        RETURNING *
      `,
      [
        input.actionId,
        input.chatId,
        input.userId,
        now,
        input.terminalStatus,
        now,
      ],
    );
    const row = result.rows[0];
    return row ? mapPendingActionRow(row) : undefined;
  }

  public async completePendingAction(
    actionId: string,
    input: CompletePendingActionInput,
  ): Promise<TelegramPendingAction> {
    return this.withTransaction(async (client) => {
      const existing = await this.requirePendingAction(client, actionId, true);
      if (TERMINAL_PENDING_ACTION_STATUSES.has(existing.status)) {
        if (existing.status === input.status) {
          return existing;
        }
        throw new Error(
          `Cannot change telegram pending action ${actionId} from ${existing.status} to ${input.status}.`,
        );
      }

      const completedAt = input.completedAt ?? this.nowIso();
      const result = await client.query<PendingActionRow>(
        `
          UPDATE telegram_assistant_pending_actions
          SET status = $2,
              completed_at = $3,
              updated_at = $3
          WHERE id = $1
          RETURNING *
        `,
        [actionId, input.status, completedAt],
      );
      return mapPendingActionRow(result.rows[0]!);
    });
  }

  public async upsertTaskSubscription(
    subscription: TelegramTaskSubscription,
  ): Promise<TelegramTaskSubscription> {
    const result = await this.db.query<TaskSubscriptionRow>(
      `
        INSERT INTO telegram_assistant_subscriptions (
          id, task_id, conversation_key, chat_id, user_id,
          created_at, updated_at, last_notified_event_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id)
        DO UPDATE SET
          task_id = EXCLUDED.task_id,
          conversation_key = EXCLUDED.conversation_key,
          chat_id = EXCLUDED.chat_id,
          user_id = EXCLUDED.user_id,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          last_notified_event_id = EXCLUDED.last_notified_event_id
        RETURNING *
      `,
      [
        subscription.id,
        subscription.taskId,
        subscription.conversationKey,
        subscription.chatId,
        subscription.userId ?? null,
        subscription.createdAt,
        subscription.updatedAt,
        subscription.lastNotifiedEventId ?? null,
      ],
    );
    return mapTaskSubscriptionRow(result.rows[0]!);
  }

  public async listTaskSubscriptions(
    conversationKey: string,
  ): Promise<TelegramTaskSubscription[]> {
    const result = await this.db.query<TaskSubscriptionRow>(
      `
        SELECT *
        FROM telegram_assistant_subscriptions
        WHERE conversation_key = $1
        ORDER BY created_at, id
      `,
      [conversationKey],
    );
    return result.rows.map(mapTaskSubscriptionRow);
  }

  public async listTaskSubscriptionsForTask(
    taskId: string,
  ): Promise<TelegramTaskSubscription[]> {
    const result = await this.db.query<TaskSubscriptionRow>(
      `
        SELECT *
        FROM telegram_assistant_subscriptions
        WHERE task_id = $1
        ORDER BY created_at, id
      `,
      [taskId],
    );
    return result.rows.map(mapTaskSubscriptionRow);
  }

  public async listAllTaskSubscriptions(): Promise<TelegramTaskSubscription[]> {
    const result = await this.db.query<TaskSubscriptionRow>(
      `
        SELECT *
        FROM telegram_assistant_subscriptions
        ORDER BY task_id, created_at, id
      `,
    );
    return result.rows.map(mapTaskSubscriptionRow);
  }

  public async reserveNotificationDelivery(
    input: ReserveNotificationDeliveryInput,
  ): Promise<TelegramNotificationDelivery | undefined> {
    if (!input.staleAfter) {
      throw new Error("Telegram notification delivery staleAfter is required.");
    }

    const result = await this.db.query<NotificationDeliveryRow>(
      `
        INSERT INTO telegram_assistant_sent_notifications (
          subscription_id, event_id, id, status, reserved_at,
          stale_after, completed_at, error_message
        )
        VALUES ($1, $2, $3, 'sending', $4, $5, NULL, NULL)
        ON CONFLICT (subscription_id, event_id)
        DO UPDATE SET
          id = EXCLUDED.id,
          status = 'sending',
          reserved_at = EXCLUDED.reserved_at,
          stale_after = EXCLUDED.stale_after,
          completed_at = NULL,
          error_message = NULL
        WHERE telegram_assistant_sent_notifications.status = 'sending'
          AND telegram_assistant_sent_notifications.stale_after <= EXCLUDED.reserved_at
        RETURNING *
      `,
      [
        input.subscriptionId,
        input.eventId,
        input.id,
        input.reservedAt,
        input.staleAfter,
      ],
    );
    const row = result.rows[0];
    return row ? mapNotificationDeliveryRow(row) : undefined;
  }

  public async completeNotificationDelivery(
    subscriptionId: string,
    eventId: string,
    input: CompleteNotificationDeliveryInput,
  ): Promise<TelegramNotificationDelivery> {
    if (!TERMINAL_NOTIFICATION_DELIVERY_STATUSES.has(input.status)) {
      throw new Error(
        `Invalid terminal notification delivery status: ${input.status}.`,
      );
    }

    return this.withTransaction(async (client) => {
      const existing = await this.requireNotificationDelivery(
        client,
        subscriptionId,
        eventId,
        true,
      );
      const key = JSON.stringify([subscriptionId, eventId]);
      if (existing.id !== input.deliveryId) {
        throw new Error(
          `Telegram notification delivery ${input.deliveryId} is not the active notification delivery for ${key}.`,
        );
      }
      if (TERMINAL_NOTIFICATION_DELIVERY_STATUSES.has(existing.status)) {
        return existing;
      }

      const completedAt = input.completedAt ?? this.nowIso();
      const result = await client.query<NotificationDeliveryRow>(
        `
          UPDATE telegram_assistant_sent_notifications
          SET status = $4,
              completed_at = $5,
              error_message = $6
          WHERE subscription_id = $1
            AND event_id = $2
            AND id = $3
            AND status = 'sending'
          RETURNING *
        `,
        [
          subscriptionId,
          eventId,
          input.deliveryId,
          input.status,
          completedAt,
          input.errorMessage ?? null,
        ],
      );
      const completed = mapNotificationDeliveryRow(result.rows[0]!);
      if (input.status === "sent") {
        await client.query(
          `
            UPDATE telegram_assistant_subscriptions
            SET last_notified_event_id = $2,
                updated_at = $3
            WHERE id = $1
          `,
          [subscriptionId, eventId, completedAt],
        );
      }
      return completed;
    });
  }

  public async upsertBusinessConnection(
    record: TelegramBusinessConnectionRecord,
  ): Promise<TelegramBusinessConnectionRecord> {
    const result = await this.db.query<BusinessConnectionRow>(
      `
        WITH upsert AS (
          INSERT INTO telegram_profile_automation_connections (
            id, user_id, user_chat_id, can_reply, is_enabled,
            created_at, updated_at, last_seen_at, update_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id)
          DO UPDATE SET
            user_id = EXCLUDED.user_id,
            user_chat_id = EXCLUDED.user_chat_id,
            can_reply = EXCLUDED.can_reply,
            is_enabled = EXCLUDED.is_enabled,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            last_seen_at = EXCLUDED.last_seen_at,
            update_id = EXCLUDED.update_id
          WHERE (
              telegram_profile_automation_connections.update_id IS NOT NULL
              AND EXCLUDED.update_id IS NOT NULL
              AND EXCLUDED.update_id > telegram_profile_automation_connections.update_id
            )
            OR (
              (
                telegram_profile_automation_connections.update_id IS NULL
                OR EXCLUDED.update_id IS NULL
              )
              AND GREATEST(EXCLUDED.updated_at, EXCLUDED.last_seen_at) >
                GREATEST(
                  telegram_profile_automation_connections.updated_at,
                  telegram_profile_automation_connections.last_seen_at
                )
            )
          RETURNING *
        )
        SELECT *
        FROM upsert
        UNION ALL
        SELECT *
        FROM telegram_profile_automation_connections
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM upsert)
        LIMIT 1
      `,
      [
        record.id,
        record.userId,
        record.userChatId,
        record.canReply,
        record.isEnabled,
        record.createdAt,
        record.updatedAt,
        record.lastSeenAt,
        record.updateId ?? null,
      ],
    );
    return mapBusinessConnectionRow(result.rows[0]!);
  }

  public async getBusinessConnection(
    connectionId: string,
  ): Promise<TelegramBusinessConnectionRecord | undefined> {
    const result = await this.db.query<BusinessConnectionRow>(
      `
        SELECT *
        FROM telegram_profile_automation_connections
        WHERE id = $1
      `,
      [connectionId],
    );
    const row = result.rows[0];
    return row ? mapBusinessConnectionRow(row) : undefined;
  }

  public async purgeExpiredTelegramAssistantData(
    input: PurgeExpiredTelegramAssistantDataInput = {},
  ): Promise<PurgeExpiredTelegramAssistantDataResult> {
    const now = input.now ?? this.nowIso();
    return this.withTransaction(async (client) => {
      const messageRefs = await client.query(
        `
          DELETE FROM telegram_assistant_message_refs
          WHERE expires_at <= $1
        `,
        [now],
      );
      const queuedMessages = await client.query(
        `
          DELETE FROM telegram_assistant_queued_messages
          WHERE expires_at <= $1
        `,
        [now],
      );
      const deletedPendingActions = await client.query(
        `
          DELETE FROM telegram_assistant_pending_actions
          WHERE status = ANY($2::text[])
            AND expires_at <= $1
        `,
        [now, [...TERMINAL_PENDING_ACTION_STATUSES]],
      );
      const expiredPendingActions = await client.query(
        `
          UPDATE telegram_assistant_pending_actions
          SET status = 'expired',
              completed_at = $1,
              updated_at = $1
          WHERE status = 'pending'
            AND expires_at <= $1
        `,
        [now],
      );

      return {
        messageRefs: messageRefs.rowCount ?? 0,
        queuedMessages: queuedMessages.rowCount ?? 0,
        pendingActions:
          (deletedPendingActions.rowCount ?? 0) +
          (expiredPendingActions.rowCount ?? 0),
      };
    });
  }

  private async requirePendingAction(
    client: PostgresQueryable,
    actionId: string,
    forUpdate = false,
  ): Promise<TelegramPendingAction> {
    const result = await client.query<PendingActionRow>(
      `
        SELECT *
        FROM telegram_assistant_pending_actions
        WHERE id = $1
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [actionId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Telegram pending action not found: ${actionId}`);
    }
    return mapPendingActionRow(row);
  }

  private async requireNotificationDelivery(
    client: PostgresQueryable,
    subscriptionId: string,
    eventId: string,
    forUpdate = false,
  ): Promise<TelegramNotificationDelivery> {
    const result = await client.query<NotificationDeliveryRow>(
      `
        SELECT *
        FROM telegram_assistant_sent_notifications
        WHERE subscription_id = $1
          AND event_id = $2
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [subscriptionId, eventId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Telegram notification delivery not found: ${JSON.stringify([
          subscriptionId,
          eventId,
        ])}`,
      );
    }
    return mapNotificationDeliveryRow(row);
  }

  private async withTransaction<T>(
    callback: (client: PostgresQueryable) => Promise<T>,
  ): Promise<T> {
    const client: TransactionClient = isPoolLike(this.db)
      ? await this.db.connect()
      : this.db;
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
