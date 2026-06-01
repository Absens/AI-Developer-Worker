import type {
  TelegramAssistantTurn,
  TelegramAssistantTurnStatus,
  TelegramBusinessConnectionInput,
  TelegramBusinessConnectionRecord,
  TelegramMessageRef,
  TelegramNotificationDelivery,
  TelegramNotificationDeliveryStatus,
  TelegramPendingAction,
  TelegramPendingActionStatus,
  TelegramQueuedMessage,
  TelegramTaskSubscription,
} from "./types.js";

export interface ConsumePendingActionInput {
  actionId: string;
  chatId: number;
  userId: number;
  terminalStatus: Extract<TelegramPendingActionStatus, "executing" | "cancelled">;
  now?: string;
}

export interface CompletePendingActionInput {
  status: Extract<
    TelegramPendingActionStatus,
    "completed" | "cancelled" | "expired"
  >;
  completedAt?: string;
}

export interface ListPendingActionsInput {
  conversationKey?: string;
  status?: TelegramPendingActionStatus | TelegramPendingActionStatus[];
}

export interface CompleteAssistantTurnInput {
  status: Exclude<TelegramAssistantTurnStatus, "running">;
  completedAt?: string;
  threadId?: string;
  diagnostic?: string;
}

export interface CancelQueuedMessagesInput {
  cancelledAt?: string;
}

export interface ReserveNotificationDeliveryInput {
  id: string;
  subscriptionId: string;
  eventId: string;
  reservedAt: string;
  staleAfter: string;
}

export interface CompleteNotificationDeliveryInput {
  deliveryId: string;
  status: Extract<TelegramNotificationDeliveryStatus, "sent" | "failed">;
  completedAt?: string;
  errorMessage?: string;
}

export interface PurgeExpiredTelegramAssistantDataInput {
  now?: string;
}

export interface PurgeExpiredTelegramAssistantDataResult {
  messageRefs: number;
  queuedMessages: number;
  pendingActions: number;
}

export interface CountTelegramUserActivityInput {
  userId: number;
  since: string;
}

export interface PurgeTelegramConversationDataInput {
  conversationKey: string;
}

export interface PurgeTelegramConversationDataResult {
  messageRefs: number;
  queuedMessages: number;
  assistantTurns: number;
  pendingActions: number;
}

export interface TelegramAssistantStore {
  getOffset(scope: string): Promise<number | undefined>;
  saveOffset(scope: string, offset: number): Promise<void>;
  isUpdateProcessed(updateId: number): Promise<boolean>;
  markUpdateProcessed(updateId: number): Promise<void>;
  withUpdateProcessing(
    updateId: number,
    operation: () => Promise<void>,
  ): Promise<boolean>;
  withPollingLease<T>(
    leaseKey: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined>;
  withConversationLock<T>(
    conversationKey: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  recordMessageRef(ref: TelegramMessageRef): Promise<TelegramMessageRef>;
  listMessageRefs(conversationKey: string): Promise<TelegramMessageRef[]>;
  startAssistantTurn(turn: TelegramAssistantTurn): Promise<TelegramAssistantTurn>;
  getActiveAssistantTurn(
    conversationKey: string,
  ): Promise<TelegramAssistantTurn | undefined>;
  completeAssistantTurn(
    turnId: string,
    input: CompleteAssistantTurnInput,
  ): Promise<TelegramAssistantTurn>;
  completeAssistantTurnIfRunning(
    turnId: string,
    input: CompleteAssistantTurnInput,
  ): Promise<TelegramAssistantTurn | undefined>;
  enqueueMessage(message: TelegramQueuedMessage): Promise<TelegramQueuedMessage>;
  listQueuedMessages(conversationKey: string): Promise<TelegramQueuedMessage[]>;
  deleteQueuedMessage(messageId: string): Promise<void>;
  cancelQueuedMessages(
    conversationKey: string,
    input?: CancelQueuedMessagesInput,
  ): Promise<TelegramQueuedMessage[]>;
  upsertPendingAction(
    action: TelegramPendingAction,
  ): Promise<TelegramPendingAction>;
  getPendingAction(actionId: string): Promise<TelegramPendingAction | undefined>;
  listPendingActions(
    input?: ListPendingActionsInput,
  ): Promise<TelegramPendingAction[]>;
  consumePendingAction(
    input: ConsumePendingActionInput,
  ): Promise<TelegramPendingAction | undefined>;
  completePendingAction(
    actionId: string,
    input: CompletePendingActionInput,
  ): Promise<TelegramPendingAction>;
  upsertTaskSubscription(
    subscription: TelegramTaskSubscription,
  ): Promise<TelegramTaskSubscription>;
  listTaskSubscriptions(conversationKey: string): Promise<TelegramTaskSubscription[]>;
  listTaskSubscriptionsForTask(taskId: string): Promise<TelegramTaskSubscription[]>;
  listAllTaskSubscriptions(): Promise<TelegramTaskSubscription[]>;
  reserveNotificationDelivery(
    input: ReserveNotificationDeliveryInput,
  ): Promise<TelegramNotificationDelivery | undefined>;
  completeNotificationDelivery(
    subscriptionId: string,
    eventId: string,
    input: CompleteNotificationDeliveryInput,
  ): Promise<TelegramNotificationDelivery>;
  upsertBusinessConnection(
    record: TelegramBusinessConnectionInput,
  ): Promise<TelegramBusinessConnectionRecord>;
  getBusinessConnection(
    connectionId: string,
  ): Promise<TelegramBusinessConnectionRecord | undefined>;
  purgeExpiredTelegramAssistantData(
    input?: PurgeExpiredTelegramAssistantDataInput,
  ): Promise<PurgeExpiredTelegramAssistantDataResult>;
  countTaskCreationActionsForUser(
    input: CountTelegramUserActivityInput,
  ): Promise<number>;
  countAssistantTurnsForUser(input: CountTelegramUserActivityInput): Promise<number>;
  purgeTelegramConversationData(
    input: PurgeTelegramConversationDataInput,
  ): Promise<PurgeTelegramConversationDataResult>;
}

export interface InMemoryTelegramAssistantStoreOptions {
  now?: () => Date;
}

const clone = <T>(value: T): T => structuredClone(value);

const isExpired = (expiresAt: string, now: string): boolean =>
  Date.parse(expiresAt) <= Date.parse(now);

const notificationDeliveryKey = (subscriptionId: string, eventId: string): string =>
  JSON.stringify([subscriptionId, eventId]);

const latestBusinessConnectionTimestamp = (
  record: Pick<TelegramBusinessConnectionRecord, "updatedAt" | "lastSeenAt">,
): number =>
  Math.max(Date.parse(record.updatedAt), Date.parse(record.lastSeenAt));

const shouldReplaceBusinessConnection = (
  existing: TelegramBusinessConnectionRecord,
  incoming: TelegramBusinessConnectionRecord,
): boolean => {
  if (existing.updateId !== undefined && incoming.updateId !== undefined) {
    return incoming.updateId > existing.updateId;
  }

  return (
    latestBusinessConnectionTimestamp(incoming) >
    latestBusinessConnectionTimestamp(existing)
  );
};

const normalizeBusinessConnection = (
  record: TelegramBusinessConnectionInput,
): TelegramBusinessConnectionRecord => {
  const id = record.id ?? record.businessConnectionId;
  if (!id) {
    throw new Error("Telegram business connection id is required.");
  }

  const ownerUserId = record.ownerUserId ?? (
    record.userId !== undefined ? String(record.userId) : undefined
  );
  const userId = record.userId ?? parseNumericId(ownerUserId);
  if (userId === undefined || ownerUserId === undefined) {
    throw new Error("Telegram business connection owner user id is required.");
  }

  const ownerChatId = record.ownerChatId ?? (
    record.userChatId !== undefined ? String(record.userChatId) : undefined
  );
  const userChatId = record.userChatId ?? parseNumericId(ownerChatId);
  if (userChatId === undefined || ownerChatId === undefined) {
    throw new Error("Telegram business connection owner chat id is required.");
  }

  const rights = {
    ...(record.rights ?? {}),
    can_reply: record.rights?.can_reply ?? record.canReply ?? false,
  };

  return {
    ...record,
    id,
    businessConnectionId: id,
    userId,
    ownerUserId,
    userChatId,
    ownerChatId,
    canReply: rights.can_reply === true,
    rights,
  };
};

const parseNumericId = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const PENDING_ACTION_TERMINAL_STATUSES = new Set<TelegramPendingActionStatus>([
  "completed",
  "cancelled",
  "expired",
]);

const NOTIFICATION_DELIVERY_TERMINAL_STATUSES =
  new Set<TelegramNotificationDeliveryStatus>(["sent", "failed"]);

export class InMemoryTelegramAssistantStore implements TelegramAssistantStore {
  private readonly now: () => Date;
  private readonly offsets = new Map<string, number>();
  private readonly processedUpdates = new Set<number>();
  private readonly updateLocks = new Map<number, Promise<void>>();
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private readonly messageRefs = new Map<string, TelegramMessageRef>();
  private readonly assistantTurns = new Map<string, TelegramAssistantTurn>();
  private readonly queuedMessages = new Map<string, TelegramQueuedMessage>();
  private readonly pendingActions = new Map<string, TelegramPendingAction>();
  private readonly taskSubscriptions = new Map<string, TelegramTaskSubscription>();
  private readonly notificationDeliveries =
    new Map<string, TelegramNotificationDelivery>();
  private readonly businessConnections =
    new Map<string, TelegramBusinessConnectionRecord>();

  public constructor(options: InMemoryTelegramAssistantStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public async getOffset(scope: string): Promise<number | undefined> {
    return this.offsets.get(scope);
  }

  public async saveOffset(scope: string, offset: number): Promise<void> {
    this.offsets.set(scope, offset);
  }

  public async isUpdateProcessed(updateId: number): Promise<boolean> {
    return this.processedUpdates.has(updateId);
  }

  public async markUpdateProcessed(updateId: number): Promise<void> {
    this.processedUpdates.add(updateId);
  }

  public async withUpdateProcessing(
    updateId: number,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    const previous = this.updateLocks.get(updateId);
    let releaseCurrent = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous
      ? previous.catch(() => undefined).then(() => current)
      : current;
    this.updateLocks.set(updateId, queued);

    if (previous) {
      await previous.catch(() => undefined);
    }

    try {
      if (this.processedUpdates.has(updateId)) {
        return false;
      }
      await operation();
      return true;
    } finally {
      releaseCurrent();
      if (this.updateLocks.get(updateId) === queued) {
        this.updateLocks.delete(updateId);
      }
    }
  }

  public async withPollingLease<T>(
    _leaseKey: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    return operation();
  }

  public async withConversationLock<T>(
    conversationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.conversationLocks.get(conversationKey);
    let releaseCurrent = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous
      ? previous.catch(() => undefined).then(() => current)
      : current;
    this.conversationLocks.set(conversationKey, queued);

    if (previous) {
      await previous.catch(() => undefined);
    }

    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.conversationLocks.get(conversationKey) === queued) {
        this.conversationLocks.delete(conversationKey);
      }
    }
  }

  public async recordMessageRef(
    ref: TelegramMessageRef,
  ): Promise<TelegramMessageRef> {
    this.messageRefs.set(ref.id, clone(ref));
    return clone(ref);
  }

  public async listMessageRefs(conversationKey: string): Promise<TelegramMessageRef[]> {
    return clone(
      [...this.messageRefs.values()].filter(
        (ref) => ref.conversationKey === conversationKey,
      ),
    );
  }

  public async startAssistantTurn(
    turn: TelegramAssistantTurn,
  ): Promise<TelegramAssistantTurn> {
    this.assistantTurns.set(turn.id, clone(turn));
    return clone(turn);
  }

  public async getActiveAssistantTurn(
    conversationKey: string,
  ): Promise<TelegramAssistantTurn | undefined> {
    const turn = [...this.assistantTurns.values()].find(
      (candidate) =>
        candidate.conversationKey === conversationKey &&
        candidate.status === "running",
    );
    return turn ? clone(turn) : undefined;
  }

  public async completeAssistantTurn(
    turnId: string,
    input: CompleteAssistantTurnInput,
  ): Promise<TelegramAssistantTurn> {
    const existing = this.requireAssistantTurn(turnId);
    const completed = this.buildCompletedAssistantTurn(existing, input);
    this.assistantTurns.set(turnId, clone(completed));
    return clone(completed);
  }

  public async completeAssistantTurnIfRunning(
    turnId: string,
    input: CompleteAssistantTurnInput,
  ): Promise<TelegramAssistantTurn | undefined> {
    const existing = this.assistantTurns.get(turnId);
    if (!existing || existing.status !== "running") {
      return undefined;
    }
    const completed = this.buildCompletedAssistantTurn(existing, input);
    this.assistantTurns.set(turnId, clone(completed));
    return clone(completed);
  }

  private buildCompletedAssistantTurn(
    existing: TelegramAssistantTurn,
    input: CompleteAssistantTurnInput,
  ): TelegramAssistantTurn {
    const completed: TelegramAssistantTurn = {
      ...existing,
      status: input.status,
      completedAt: input.completedAt ?? this.nowIso(),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
    };
    return completed;
  }

  public async enqueueMessage(
    message: TelegramQueuedMessage,
  ): Promise<TelegramQueuedMessage> {
    this.queuedMessages.set(message.id, clone(message));
    return clone(message);
  }

  public async listQueuedMessages(
    conversationKey: string,
  ): Promise<TelegramQueuedMessage[]> {
    return clone(
      [...this.queuedMessages.values()].filter(
        (message) =>
          message.conversationKey === conversationKey && message.status === "queued",
      ),
    );
  }

  public async deleteQueuedMessage(messageId: string): Promise<void> {
    this.queuedMessages.delete(messageId);
  }

  public async cancelQueuedMessages(
    conversationKey: string,
    input: CancelQueuedMessagesInput = {},
  ): Promise<TelegramQueuedMessage[]> {
    const cancelledAt = input.cancelledAt ?? this.nowIso();
    const cancelled: TelegramQueuedMessage[] = [];
    for (const message of this.queuedMessages.values()) {
      if (message.conversationKey !== conversationKey || message.status !== "queued") {
        continue;
      }
      const updated: TelegramQueuedMessage = {
        ...message,
        status: "cancelled",
        cancelledAt,
      };
      this.queuedMessages.delete(message.id);
      cancelled.push(updated);
    }
    return clone(cancelled);
  }

  public async upsertPendingAction(
    action: TelegramPendingAction,
  ): Promise<TelegramPendingAction> {
    this.pendingActions.set(action.id, clone(action));
    return clone(action);
  }

  public async getPendingAction(
    actionId: string,
  ): Promise<TelegramPendingAction | undefined> {
    const action = this.pendingActions.get(actionId);
    return action ? clone(action) : undefined;
  }

  public async listPendingActions(
    input: ListPendingActionsInput = {},
  ): Promise<TelegramPendingAction[]> {
    const statuses = input.status
      ? new Set(Array.isArray(input.status) ? input.status : [input.status])
      : undefined;
    return clone(
      [...this.pendingActions.values()].filter((action) => {
        if (input.conversationKey && action.conversationKey !== input.conversationKey) {
          return false;
        }
        if (statuses && !statuses.has(action.status)) {
          return false;
        }
        return true;
      }),
    );
  }

  public async consumePendingAction(
    input: ConsumePendingActionInput,
  ): Promise<TelegramPendingAction | undefined> {
    const existing = this.pendingActions.get(input.actionId);
    const now = input.now ?? this.nowIso();
    if (
      !existing ||
      existing.status !== "pending" ||
      existing.chatId !== input.chatId ||
      existing.userId !== input.userId ||
      isExpired(existing.expiresAt, now)
    ) {
      return undefined;
    }

    const consumed: TelegramPendingAction = {
      ...existing,
      status: input.terminalStatus,
      consumedAt: now,
      updatedAt: now,
    };
    this.pendingActions.set(existing.id, clone(consumed));
    return clone(consumed);
  }

  public async completePendingAction(
    actionId: string,
    input: CompletePendingActionInput,
  ): Promise<TelegramPendingAction> {
    const existing = this.requirePendingAction(actionId);
    if (PENDING_ACTION_TERMINAL_STATUSES.has(existing.status)) {
      if (existing.status === input.status) {
        return clone(existing);
      }
      throw new Error(
        `Cannot change telegram pending action ${actionId} from ${existing.status} to ${input.status}.`,
      );
    }

    const completedAt = input.completedAt ?? this.nowIso();
    const completed: TelegramPendingAction = {
      ...existing,
      status: input.status,
      completedAt,
      updatedAt: completedAt,
    };
    this.pendingActions.set(actionId, clone(completed));
    return clone(completed);
  }

  public async upsertTaskSubscription(
    subscription: TelegramTaskSubscription,
  ): Promise<TelegramTaskSubscription> {
    this.taskSubscriptions.set(subscription.id, clone(subscription));
    return clone(subscription);
  }

  public async listTaskSubscriptions(
    conversationKey: string,
  ): Promise<TelegramTaskSubscription[]> {
    return clone(
      [...this.taskSubscriptions.values()].filter(
        (subscription) => subscription.conversationKey === conversationKey,
      ),
    );
  }

  public async listTaskSubscriptionsForTask(
    taskId: string,
  ): Promise<TelegramTaskSubscription[]> {
    return clone(
      [...this.taskSubscriptions.values()].filter(
        (subscription) => subscription.taskId === taskId,
      ),
    );
  }

  public async listAllTaskSubscriptions(): Promise<TelegramTaskSubscription[]> {
    return clone([...this.taskSubscriptions.values()]);
  }

  public async reserveNotificationDelivery(
    input: ReserveNotificationDeliveryInput,
  ): Promise<TelegramNotificationDelivery | undefined> {
    if (!input.staleAfter) {
      throw new Error("Telegram notification delivery staleAfter is required.");
    }

    const key = notificationDeliveryKey(input.subscriptionId, input.eventId);
    const existing = this.notificationDeliveries.get(key);
    if (existing) {
      if (NOTIFICATION_DELIVERY_TERMINAL_STATUSES.has(existing.status)) {
        return undefined;
      }
      if (
        existing.status === "sending" &&
        (!existing.staleAfter ||
          Date.parse(existing.staleAfter) > Date.parse(input.reservedAt))
      ) {
        return undefined;
      }
    }

    const reserved: TelegramNotificationDelivery = {
      ...clone(input),
      status: "sending",
    };
    this.notificationDeliveries.set(key, clone(reserved));
    return clone(reserved);
  }

  public async completeNotificationDelivery(
    subscriptionId: string,
    eventId: string,
    input: CompleteNotificationDeliveryInput,
  ): Promise<TelegramNotificationDelivery> {
    if (!NOTIFICATION_DELIVERY_TERMINAL_STATUSES.has(input.status)) {
      throw new Error(
        `Invalid terminal notification delivery status: ${input.status}.`,
      );
    }

    const key = notificationDeliveryKey(subscriptionId, eventId);
    const existing = this.notificationDeliveries.get(key);
    if (!existing) {
      throw new Error(`Telegram notification delivery not found: ${key}`);
    }
    if (existing.id !== input.deliveryId) {
      throw new Error(
        `Telegram notification delivery ${input.deliveryId} is not the active notification delivery for ${key}.`,
      );
    }
    if (NOTIFICATION_DELIVERY_TERMINAL_STATUSES.has(existing.status)) {
      return clone(existing);
    }

    const completedAt = input.completedAt ?? this.nowIso();
    const completed: TelegramNotificationDelivery = {
      ...existing,
      status: input.status,
      completedAt,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    };
    this.notificationDeliveries.set(key, clone(completed));

    if (input.status === "sent") {
      const subscription = this.taskSubscriptions.get(subscriptionId);
      if (subscription) {
        this.taskSubscriptions.set(subscriptionId, {
          ...subscription,
          lastNotifiedEventId: eventId,
          updatedAt: completedAt,
        });
      }
    }

    return clone(completed);
  }

  public async upsertBusinessConnection(
    record: TelegramBusinessConnectionInput,
  ): Promise<TelegramBusinessConnectionRecord> {
    const normalized = normalizeBusinessConnection(record);
    const existing = this.businessConnections.get(normalized.id);
    if (existing && !shouldReplaceBusinessConnection(existing, normalized)) {
      return clone(existing);
    }
    this.businessConnections.set(normalized.id, clone(normalized));
    return clone(normalized);
  }

  public async getBusinessConnection(
    connectionId: string,
  ): Promise<TelegramBusinessConnectionRecord | undefined> {
    const record = this.businessConnections.get(connectionId);
    return record ? clone(record) : undefined;
  }

  public async purgeExpiredTelegramAssistantData(
    input: PurgeExpiredTelegramAssistantDataInput = {},
  ): Promise<PurgeExpiredTelegramAssistantDataResult> {
    const now = input.now ?? this.nowIso();
    const result: PurgeExpiredTelegramAssistantDataResult = {
      messageRefs: 0,
      queuedMessages: 0,
      pendingActions: 0,
    };

    for (const [id, ref] of this.messageRefs.entries()) {
      if (isExpired(ref.expiresAt, now)) {
        this.messageRefs.delete(id);
        result.messageRefs += 1;
      }
    }

    for (const [id, message] of this.queuedMessages.entries()) {
      if (isExpired(message.expiresAt, now)) {
        this.queuedMessages.delete(id);
        result.queuedMessages += 1;
      }
    }

    for (const [id, action] of this.pendingActions.entries()) {
      if (
        PENDING_ACTION_TERMINAL_STATUSES.has(action.status) &&
        isExpired(action.expiresAt, now)
      ) {
        this.pendingActions.delete(id);
        result.pendingActions += 1;
        continue;
      }
      if (action.status === "pending" && isExpired(action.expiresAt, now)) {
        this.pendingActions.set(id, {
          ...action,
          status: "expired",
          completedAt: now,
          updatedAt: now,
        });
        result.pendingActions += 1;
      }
    }

    return result;
  }

  public async countTaskCreationActionsForUser(
    input: CountTelegramUserActivityInput,
  ): Promise<number> {
    const since = Date.parse(input.since);
    return [...this.pendingActions.values()].filter(
      (action) =>
        action.userId === input.userId &&
        action.intent.name === "create_task_draft" &&
        Date.parse(action.createdAt) >= since,
    ).length;
  }

  public async countAssistantTurnsForUser(
    input: CountTelegramUserActivityInput,
  ): Promise<number> {
    const since = Date.parse(input.since);
    return [...this.assistantTurns.values()].filter(
      (turn) =>
        turn.input?.userId === input.userId &&
        Date.parse(turn.startedAt) >= since,
    ).length;
  }

  public async purgeTelegramConversationData(
    input: PurgeTelegramConversationDataInput,
  ): Promise<PurgeTelegramConversationDataResult> {
    const result: PurgeTelegramConversationDataResult = {
      messageRefs: 0,
      queuedMessages: 0,
      assistantTurns: 0,
      pendingActions: 0,
    };

    for (const [id, ref] of this.messageRefs.entries()) {
      if (ref.conversationKey === input.conversationKey) {
        this.messageRefs.delete(id);
        result.messageRefs += 1;
      }
    }

    for (const [id, message] of this.queuedMessages.entries()) {
      if (message.conversationKey === input.conversationKey) {
        this.queuedMessages.delete(id);
        result.queuedMessages += 1;
      }
    }

    for (const [id, turn] of this.assistantTurns.entries()) {
      if (turn.conversationKey === input.conversationKey) {
        this.assistantTurns.delete(id);
        result.assistantTurns += 1;
      }
    }

    for (const [id, action] of this.pendingActions.entries()) {
      if (action.conversationKey === input.conversationKey) {
        this.pendingActions.delete(id);
        result.pendingActions += 1;
      }
    }

    return result;
  }

  private requireAssistantTurn(turnId: string): TelegramAssistantTurn {
    const turn = this.assistantTurns.get(turnId);
    if (!turn) {
      throw new Error(`Telegram assistant turn not found: ${turnId}`);
    }
    return clone(turn);
  }

  private requirePendingAction(actionId: string): TelegramPendingAction {
    const action = this.pendingActions.get(actionId);
    if (!action) {
      throw new Error(`Telegram pending action not found: ${actionId}`);
    }
    return clone(action);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
