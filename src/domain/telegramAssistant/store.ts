import type {
  TelegramAssistantTurn,
  TelegramAssistantTurnStatus,
  TelegramActiveTaskQuestionPrompt,
  TelegramBusinessConnectionInput,
  TelegramBusinessConnectionRecord,
  TelegramDigitalTwinDeliveryStatus,
  TelegramDigitalTwinMessage,
  TelegramDigitalTwinSession,
  TelegramDigitalTwinTurn,
  TelegramDigitalTwinTurnStatus,
  TelegramExecutableTaskDraftSession,
  TelegramExecutableTaskDraftStatus,
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

export interface CompleteExecutableTaskDraftSessionInput {
  status: Extract<
    TelegramExecutableTaskDraftStatus,
    "completed" | "cancelled" | "expired"
  >;
  updatedAt?: string;
}

export interface ConsumeActiveTaskQuestionPromptInput {
  promptId: string;
  conversationKey: string;
  chatId: number;
  userId?: number;
  answeredAt?: string;
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

export interface ReserveDigitalTwinMessageResult {
  inserted: boolean;
  message: TelegramDigitalTwinMessage;
}

export interface UpdateDigitalTwinMessageDeliveryInput {
  messageKey: string;
  deliveryStatus: TelegramDigitalTwinDeliveryStatus;
  deliveryAttemptedAt?: string;
  deliveredAt?: string;
  deliveryError?: string;
  sentTelegramMessageId?: number;
  redactedText?: string;
  fullTextEncrypted?: string;
  codexThreadId?: string;
  codexTurnId?: string;
}

export interface CompleteDigitalTwinTurnInput {
  status: Exclude<TelegramDigitalTwinTurnStatus, "running">;
  completedAt?: string;
  codexThreadId?: string;
  error?: string;
}

export interface PurgeDigitalTwinSessionDataResult {
  sessions: number;
  messages: number;
  turns: number;
}

export interface PruneDigitalTwinAuditDataInput {
  redactedBefore?: string;
  fullTextBefore?: string;
}

export interface PruneDigitalTwinAuditDataResult {
  redactedTextsCleared: number;
  fullTextsCleared: number;
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
  executableTaskDraftSessions?: number;
  activeTaskQuestionPrompts?: number;
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
  executableTaskDraftSessions?: number;
  activeTaskQuestionPrompts?: number;
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
  withDigitalTwinSessionLock<T>(
    sessionKey: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  getDigitalTwinSession(
    sessionKey: string,
  ): Promise<TelegramDigitalTwinSession | undefined>;
  upsertDigitalTwinSession(
    session: TelegramDigitalTwinSession,
  ): Promise<TelegramDigitalTwinSession>;
  reserveDigitalTwinMessage(
    message: TelegramDigitalTwinMessage,
  ): Promise<ReserveDigitalTwinMessageResult>;
  updateDigitalTwinMessageDelivery(
    input: UpdateDigitalTwinMessageDeliveryInput,
  ): Promise<TelegramDigitalTwinMessage>;
  listDigitalTwinMessages(
    sessionKey: string,
    input?: { limit?: number },
  ): Promise<TelegramDigitalTwinMessage[]>;
  startDigitalTwinTurn(
    turn: TelegramDigitalTwinTurn,
  ): Promise<TelegramDigitalTwinTurn | undefined>;
  getActiveDigitalTwinTurn(
    sessionKey: string,
  ): Promise<TelegramDigitalTwinTurn | undefined>;
  completeDigitalTwinTurnIfRunning(
    turnId: string,
    input: CompleteDigitalTwinTurnInput,
  ): Promise<TelegramDigitalTwinTurn | undefined>;
  purgeDigitalTwinSessionData(
    sessionKey: string,
  ): Promise<PurgeDigitalTwinSessionDataResult>;
  pruneDigitalTwinAuditData(
    input: PruneDigitalTwinAuditDataInput,
  ): Promise<PruneDigitalTwinAuditDataResult>;
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
  upsertExecutableTaskDraftSession(
    session: TelegramExecutableTaskDraftSession,
  ): Promise<TelegramExecutableTaskDraftSession>;
  getExecutableTaskDraftSession(
    sessionId: string,
  ): Promise<TelegramExecutableTaskDraftSession | undefined>;
  getActiveExecutableTaskDraftSession(
    conversationKey: string,
  ): Promise<TelegramExecutableTaskDraftSession | undefined>;
  completeExecutableTaskDraftSession(
    sessionId: string,
    input: CompleteExecutableTaskDraftSessionInput,
  ): Promise<TelegramExecutableTaskDraftSession>;
  upsertActiveTaskQuestionPrompt(
    prompt: TelegramActiveTaskQuestionPrompt,
  ): Promise<TelegramActiveTaskQuestionPrompt>;
  getActiveTaskQuestionPrompt(
    conversationKey: string,
  ): Promise<TelegramActiveTaskQuestionPrompt | undefined>;
  consumeActiveTaskQuestionPrompt(
    input: ConsumeActiveTaskQuestionPromptInput,
  ): Promise<TelegramActiveTaskQuestionPrompt | undefined>;
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

const EXECUTABLE_TASK_DRAFT_ACTIVE_STATUSES =
  new Set<TelegramExecutableTaskDraftStatus>([
    "collecting",
    "awaiting_user_confirmation",
    "awaiting_owner_approval",
  ]);

const EXECUTABLE_TASK_DRAFT_TERMINAL_STATUSES =
  new Set<TelegramExecutableTaskDraftStatus>([
    "completed",
    "cancelled",
    "expired",
  ]);

const ACTIVE_TASK_QUESTION_PROMPT_TERMINAL_STATUSES =
  new Set<TelegramActiveTaskQuestionPrompt["status"]>([
    "answered",
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
  private readonly executableTaskDraftSessions =
    new Map<string, TelegramExecutableTaskDraftSession>();
  private readonly activeTaskQuestionPrompts =
    new Map<string, TelegramActiveTaskQuestionPrompt>();
  private readonly businessConnections =
    new Map<string, TelegramBusinessConnectionRecord>();
  private readonly digitalTwinSessions =
    new Map<string, TelegramDigitalTwinSession>();
  private readonly digitalTwinMessages =
    new Map<string, TelegramDigitalTwinMessage>();
  private readonly digitalTwinTurns = new Map<string, TelegramDigitalTwinTurn>();

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

  public async withDigitalTwinSessionLock<T>(
    sessionKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withConversationLock(`digital-twin:${sessionKey}`, operation);
  }

  public async getDigitalTwinSession(
    sessionKey: string,
  ): Promise<TelegramDigitalTwinSession | undefined> {
    const session = this.digitalTwinSessions.get(sessionKey);
    return session ? clone(session) : undefined;
  }

  public async upsertDigitalTwinSession(
    session: TelegramDigitalTwinSession,
  ): Promise<TelegramDigitalTwinSession> {
    this.digitalTwinSessions.set(session.sessionKey, clone(session));
    return clone(session);
  }

  public async reserveDigitalTwinMessage(
    message: TelegramDigitalTwinMessage,
  ): Promise<ReserveDigitalTwinMessageResult> {
    const existing = [...this.digitalTwinMessages.values()].find(
      (candidate) => candidate.messageKey === message.messageKey,
    );
    if (existing) {
      return {
        inserted: false,
        message: clone(existing),
      };
    }

    this.digitalTwinMessages.set(message.id, clone(message));
    return {
      inserted: true,
      message: clone(message),
    };
  }

  public async updateDigitalTwinMessageDelivery(
    input: UpdateDigitalTwinMessageDeliveryInput,
  ): Promise<TelegramDigitalTwinMessage> {
    const existing = [...this.digitalTwinMessages.values()].find(
      (candidate) => candidate.messageKey === input.messageKey,
    );
    if (!existing) {
      throw new Error(`Telegram digital twin message not found: ${input.messageKey}`);
    }

    const updated: TelegramDigitalTwinMessage = {
      ...existing,
      deliveryStatus: input.deliveryStatus,
      ...(input.deliveryAttemptedAt !== undefined
        ? { deliveryAttemptedAt: input.deliveryAttemptedAt }
        : {}),
      ...(input.deliveredAt !== undefined ? { deliveredAt: input.deliveredAt } : {}),
      ...(input.deliveryError !== undefined
        ? { deliveryError: input.deliveryError }
        : {}),
      ...(input.sentTelegramMessageId !== undefined
        ? { sentTelegramMessageId: input.sentTelegramMessageId }
        : {}),
      ...(input.redactedText !== undefined ? { redactedText: input.redactedText } : {}),
      ...(input.fullTextEncrypted !== undefined
        ? { fullTextEncrypted: input.fullTextEncrypted }
        : {}),
      ...(input.codexThreadId !== undefined
        ? { codexThreadId: input.codexThreadId }
        : {}),
      ...(input.codexTurnId !== undefined ? { codexTurnId: input.codexTurnId } : {}),
    };
    this.digitalTwinMessages.set(existing.id, clone(updated));
    return clone(updated);
  }

  public async listDigitalTwinMessages(
    sessionKey: string,
    input: { limit?: number } = {},
  ): Promise<TelegramDigitalTwinMessage[]> {
    const messages = [...this.digitalTwinMessages.values()]
      .filter((message) => message.sessionKey === sessionKey)
      .sort((left, right) => {
        const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
        return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id);
      });
    if (input.limit !== undefined && input.limit <= 0) {
      return [];
    }
    return clone(input.limit === undefined ? messages : messages.slice(-input.limit));
  }

  public async startDigitalTwinTurn(
    turn: TelegramDigitalTwinTurn,
  ): Promise<TelegramDigitalTwinTurn | undefined> {
    const active = [...this.digitalTwinTurns.values()].find(
      (candidate) =>
        candidate.sessionKey === turn.sessionKey && candidate.status === "running",
    );
    if (active) {
      return undefined;
    }

    this.digitalTwinTurns.set(turn.id, clone(turn));
    return clone(turn);
  }

  public async getActiveDigitalTwinTurn(
    sessionKey: string,
  ): Promise<TelegramDigitalTwinTurn | undefined> {
    const turn = [...this.digitalTwinTurns.values()].find(
      (candidate) =>
        candidate.sessionKey === sessionKey && candidate.status === "running",
    );
    return turn ? clone(turn) : undefined;
  }

  public async completeDigitalTwinTurnIfRunning(
    turnId: string,
    input: CompleteDigitalTwinTurnInput,
  ): Promise<TelegramDigitalTwinTurn | undefined> {
    const existing = this.digitalTwinTurns.get(turnId);
    if (!existing || existing.status !== "running") {
      return undefined;
    }

    const completed: TelegramDigitalTwinTurn = {
      ...existing,
      status: input.status,
      completedAt: input.completedAt ?? this.nowIso(),
      ...(input.codexThreadId !== undefined
        ? { codexThreadId: input.codexThreadId }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    this.digitalTwinTurns.set(turnId, clone(completed));
    return clone(completed);
  }

  public async purgeDigitalTwinSessionData(
    sessionKey: string,
  ): Promise<PurgeDigitalTwinSessionDataResult> {
    const result: PurgeDigitalTwinSessionDataResult = {
      sessions: 0,
      messages: 0,
      turns: 0,
    };

    if (this.digitalTwinSessions.delete(sessionKey)) {
      result.sessions += 1;
    }

    for (const [id, message] of this.digitalTwinMessages.entries()) {
      if (message.sessionKey === sessionKey) {
        this.digitalTwinMessages.delete(id);
        result.messages += 1;
      }
    }

    for (const [id, turn] of this.digitalTwinTurns.entries()) {
      if (turn.sessionKey === sessionKey) {
        this.digitalTwinTurns.delete(id);
        result.turns += 1;
      }
    }

    return result;
  }

  public async pruneDigitalTwinAuditData(
    input: PruneDigitalTwinAuditDataInput,
  ): Promise<PruneDigitalTwinAuditDataResult> {
    const result: PruneDigitalTwinAuditDataResult = {
      redactedTextsCleared: 0,
      fullTextsCleared: 0,
    };
    const redactedCutoff = input.redactedBefore
      ? Date.parse(input.redactedBefore)
      : undefined;
    const fullTextCutoff = input.fullTextBefore
      ? Date.parse(input.fullTextBefore)
      : undefined;

    for (const [id, message] of this.digitalTwinMessages.entries()) {
      const createdAt = Date.parse(message.createdAt);
      const updated: TelegramDigitalTwinMessage = { ...message };
      let changed = false;

      if (
        redactedCutoff !== undefined &&
        createdAt < redactedCutoff &&
        updated.redactedText !== undefined
      ) {
        delete updated.redactedText;
        result.redactedTextsCleared += 1;
        changed = true;
      }

      if (
        fullTextCutoff !== undefined &&
        createdAt < fullTextCutoff &&
        updated.fullTextEncrypted !== undefined
      ) {
        delete updated.fullTextEncrypted;
        result.fullTextsCleared += 1;
        changed = true;
      }

      if (changed) {
        this.digitalTwinMessages.set(id, clone(updated));
      }
    }

    return result;
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

  public async upsertExecutableTaskDraftSession(
    session: TelegramExecutableTaskDraftSession,
  ): Promise<TelegramExecutableTaskDraftSession> {
    this.executableTaskDraftSessions.set(session.id, clone(session));
    return clone(session);
  }

  public async getExecutableTaskDraftSession(
    sessionId: string,
  ): Promise<TelegramExecutableTaskDraftSession | undefined> {
    const session = this.executableTaskDraftSessions.get(sessionId);
    return session ? clone(session) : undefined;
  }

  public async getActiveExecutableTaskDraftSession(
    conversationKey: string,
  ): Promise<TelegramExecutableTaskDraftSession | undefined> {
    const now = this.nowIso();
    const session = [...this.executableTaskDraftSessions.values()]
      .filter((candidate) =>
        candidate.conversationKey === conversationKey &&
        EXECUTABLE_TASK_DRAFT_ACTIVE_STATUSES.has(candidate.status) &&
        !isExpired(candidate.expiresAt, now)
      )
      .sort(compareNewestByUpdatedAtThenId)[0];
    return session ? clone(session) : undefined;
  }

  public async completeExecutableTaskDraftSession(
    sessionId: string,
    input: CompleteExecutableTaskDraftSessionInput,
  ): Promise<TelegramExecutableTaskDraftSession> {
    const existing = this.executableTaskDraftSessions.get(sessionId);
    if (!existing) {
      throw new Error(
        `Telegram executable task draft session not found: ${sessionId}`,
      );
    }

    const updatedAt = input.updatedAt ?? this.nowIso();
    const completed: TelegramExecutableTaskDraftSession = {
      ...existing,
      status: input.status,
      updatedAt,
    };
    this.executableTaskDraftSessions.set(sessionId, clone(completed));
    return clone(completed);
  }

  public async upsertActiveTaskQuestionPrompt(
    prompt: TelegramActiveTaskQuestionPrompt,
  ): Promise<TelegramActiveTaskQuestionPrompt> {
    const existing = this.activeTaskQuestionPrompts.get(prompt.id);
    if (
      existing &&
      prompt.status === "open" &&
      ACTIVE_TASK_QUESTION_PROMPT_TERMINAL_STATUSES.has(existing.status)
    ) {
      return clone(existing);
    }
    this.activeTaskQuestionPrompts.set(prompt.id, clone(prompt));
    return clone(prompt);
  }

  public async getActiveTaskQuestionPrompt(
    conversationKey: string,
  ): Promise<TelegramActiveTaskQuestionPrompt | undefined> {
    const prompt = this.findActiveTaskQuestionPrompt(conversationKey, this.nowIso());
    return prompt ? clone(prompt) : undefined;
  }

  public async consumeActiveTaskQuestionPrompt(
    input: ConsumeActiveTaskQuestionPromptInput,
  ): Promise<TelegramActiveTaskQuestionPrompt | undefined> {
    const now = input.answeredAt ?? this.nowIso();
    const existing = this.activeTaskQuestionPrompts.get(input.promptId);
    if (
      !existing ||
      existing.conversationKey !== input.conversationKey ||
      existing.status !== "open" ||
      isExpired(existing.expiresAt, now) ||
      existing.chatId !== input.chatId ||
      (existing.userId !== undefined && existing.userId !== input.userId)
    ) {
      return undefined;
    }

    const answered: TelegramActiveTaskQuestionPrompt = {
      ...existing,
      status: "answered",
      updatedAt: now,
    };
    this.activeTaskQuestionPrompts.set(existing.id, clone(answered));
    return clone(existing);
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
      executableTaskDraftSessions: 0,
      activeTaskQuestionPrompts: 0,
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

    for (const [id, session] of this.executableTaskDraftSessions.entries()) {
      if (
        EXECUTABLE_TASK_DRAFT_TERMINAL_STATUSES.has(session.status) &&
        isExpired(session.expiresAt, now)
      ) {
        this.executableTaskDraftSessions.delete(id);
        result.executableTaskDraftSessions =
          (result.executableTaskDraftSessions ?? 0) + 1;
        continue;
      }
      if (
        EXECUTABLE_TASK_DRAFT_ACTIVE_STATUSES.has(session.status) &&
        isExpired(session.expiresAt, now)
      ) {
        this.executableTaskDraftSessions.set(id, {
          ...session,
          status: "expired",
          updatedAt: now,
        });
        result.executableTaskDraftSessions =
          (result.executableTaskDraftSessions ?? 0) + 1;
      }
    }

    for (const [id, prompt] of this.activeTaskQuestionPrompts.entries()) {
      if (
        ACTIVE_TASK_QUESTION_PROMPT_TERMINAL_STATUSES.has(prompt.status) &&
        isExpired(prompt.expiresAt, now)
      ) {
        this.activeTaskQuestionPrompts.delete(id);
        result.activeTaskQuestionPrompts =
          (result.activeTaskQuestionPrompts ?? 0) + 1;
        continue;
      }
      if (prompt.status === "open" && isExpired(prompt.expiresAt, now)) {
        this.activeTaskQuestionPrompts.set(id, {
          ...prompt,
          status: "expired",
          updatedAt: now,
        });
        result.activeTaskQuestionPrompts =
          (result.activeTaskQuestionPrompts ?? 0) + 1;
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
      executableTaskDraftSessions: 0,
      activeTaskQuestionPrompts: 0,
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

    for (const [id, session] of this.executableTaskDraftSessions.entries()) {
      if (session.conversationKey === input.conversationKey) {
        this.executableTaskDraftSessions.delete(id);
        result.executableTaskDraftSessions =
          (result.executableTaskDraftSessions ?? 0) + 1;
      }
    }

    for (const [id, prompt] of this.activeTaskQuestionPrompts.entries()) {
      if (prompt.conversationKey === input.conversationKey) {
        this.activeTaskQuestionPrompts.delete(id);
        result.activeTaskQuestionPrompts =
          (result.activeTaskQuestionPrompts ?? 0) + 1;
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

  private findActiveTaskQuestionPrompt(
    conversationKey: string,
    now: string,
  ): TelegramActiveTaskQuestionPrompt | undefined {
    return [...this.activeTaskQuestionPrompts.values()]
      .filter((candidate) =>
        candidate.conversationKey === conversationKey &&
        candidate.status === "open" &&
        !isExpired(candidate.expiresAt, now)
      )
      .sort(compareNewestByUpdatedAtThenId)[0];
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

const compareNewestByUpdatedAtThenId = <
  T extends { id: string; updatedAt: string },
>(
  left: T,
  right: T,
): number => {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  return byUpdatedAt !== 0 ? byUpdatedAt : right.id.localeCompare(left.id);
};
