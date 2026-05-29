import type { TelegramClient, TelegramUpdate } from "../../integrations/telegram/index.js";
import type {
  RepositoryProfile,
  TaskTrackerClient,
  TelegramAssistantConfig,
  TelegramAssistantRole,
} from "../../models/types.js";
import { redactSecrets } from "../../observability/redaction.js";
import type { Logger } from "../../utils/logger.js";
import type { TelegramAssistantStore } from "./store.js";
import type {
  TelegramAssistantActor,
  TelegramConversationSource,
  TelegramInboundMessage,
  TelegramQueuedMessage,
} from "./types.js";

type TelegramAssistantLogger = Pick<Logger, "info" | "warn" | "error">;

export interface TelegramAssistantServiceOptions {
  store: TelegramAssistantStore;
  config: TelegramAssistantConfig;
  taskTracker?: TaskTrackerClient;
  repositories: RepositoryProfile[];
  telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  logger?: TelegramAssistantLogger;
}

interface NormalizedUpdateCandidate {
  message: TelegramInboundMessage;
  callbackQueryId?: string;
}

const DEFAULT_OFFSET_SCOPE = "default";
const SKELETON_MESSAGE = "Telegram Assistant пока включен только в режиме каркаса.";
const UNAUTHORIZED_MESSAGE = "Telegram Assistant недоступен для этого чата или пользователя.";

export class TelegramAssistantService {
  private readonly store: TelegramAssistantStore;
  private readonly config: TelegramAssistantConfig;
  private readonly telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  private readonly logger?: TelegramAssistantLogger;

  public constructor(options: TelegramAssistantServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.telegram = options.telegram;
    this.logger = options.logger;
    void options.taskTracker;
    void options.repositories;
  }

  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (await this.store.isUpdateProcessed(update.update_id)) {
      await this.saveOffsetAfter(update.update_id);
      return;
    }

    const message = normalizeTelegramUpdate(update, this.config);
    if (!message) {
      await this.markProcessedAndAdvance(update.update_id);
      return;
    }

    try {
      await this.store.withConversationLock(
        message.conversationKey,
        async () => {
          if (!this.config.enabled) {
            return;
          }

          if (!this.isAuthorized(message)) {
            await this.telegram.sendMessage({
              chatId: String(message.chatId),
              text: UNAUTHORIZED_MESSAGE,
              ...(message.businessConnectionId
                ? { businessConnectionId: message.businessConnectionId }
                : {}),
            });
            return;
          }

          await this.recordMessageRef(message);

          const activeTurn = await this.store.getActiveAssistantTurn(
            message.conversationKey,
          );
          if (activeTurn) {
            await this.store.enqueueMessage(this.buildQueuedMessage(message));
            return;
          }

          await this.telegram.sendMessage({
            chatId: String(message.chatId),
            text: SKELETON_MESSAGE,
            ...(message.messageId
              ? { replyToMessageId: message.messageId }
              : {}),
            ...(message.businessConnectionId
              ? { businessConnectionId: message.businessConnectionId }
              : {}),
          });
        },
      );
      await this.markProcessedAndAdvance(update.update_id);
    } catch (error) {
      this.logger?.warn("Telegram assistant failed to handle update.", redactSecrets({
        updateId: update.update_id,
        error: errorToMessage(error),
      }));
      throw error;
    }
  }

  private isAuthorized(message: TelegramInboundMessage): boolean {
    if (!isAllowedId(this.config.allowedChatIds, message.chatId)) {
      return false;
    }
    if (this.config.allowedUserIds.length === 0) {
      return true;
    }
    return message.userId !== undefined && isAllowedId(this.config.allowedUserIds, message.userId);
  }

  private buildQueuedMessage(message: TelegramInboundMessage): TelegramQueuedMessage {
    const createdAt = new Date().toISOString();
    return {
      id: `queued:${message.updateId}`,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      ...(message.userId !== undefined ? { userId: message.userId } : {}),
      message,
      status: "queued",
      createdAt,
      expiresAt: addDays(createdAt, this.config.conversationRetentionDays),
    };
  }

  private async recordMessageRef(message: TelegramInboundMessage): Promise<void> {
    if (message.messageId === undefined || message.redactedText === undefined) {
      return;
    }

    await this.store.recordMessageRef({
      id: `message-ref:${message.updateId}:${message.messageId}`,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      messageId: message.messageId,
      source: "user",
      redactedText: message.redactedText,
      createdAt: message.receivedAt,
      expiresAt: addDays(message.receivedAt, this.config.conversationRetentionDays),
    });
  }

  private async markProcessedAndAdvance(updateId: number): Promise<void> {
    await this.store.markUpdateProcessed(updateId);
    await this.saveOffsetAfter(updateId);
  }

  private async saveOffsetAfter(updateId: number): Promise<void> {
    const nextOffset = updateId + 1;
    const currentOffset = await this.store.getOffset(DEFAULT_OFFSET_SCOPE);
    if (currentOffset === undefined || currentOffset < nextOffset) {
      await this.store.saveOffset(DEFAULT_OFFSET_SCOPE, nextOffset);
    }
  }
}

export const normalizeTelegramUpdate = (
  update: TelegramUpdate,
  config: TelegramAssistantConfig,
): TelegramInboundMessage | undefined => {
  const candidate = normalizeTelegramUpdateCandidate(update, config);
  return candidate?.message;
};

const normalizeTelegramUpdateCandidate = (
  update: TelegramUpdate,
  config: TelegramAssistantConfig,
): NormalizedUpdateCandidate | undefined => {
  if (update.callback_query?.message) {
    return normalizeMessage({
      update,
      config,
      message: update.callback_query.message,
      user: update.callback_query.from,
      text: update.callback_query.data ?? update.callback_query.message.text,
      idSuffix: `callback:${update.callback_query.id}`,
    });
  }

  if (update.business_message) {
    return normalizeMessage({
      update,
      config,
      message: update.business_message,
      user: update.business_message.from,
      text: update.business_message.text,
      idSuffix: `business_message:${update.business_message.message_id}`,
      forceSource: "business",
    });
  }

  if (update.edited_business_message) {
    return normalizeMessage({
      update,
      config,
      message: update.edited_business_message,
      user: update.edited_business_message.from,
      text: update.edited_business_message.text,
      idSuffix: `edited_business_message:${update.edited_business_message.message_id}`,
      forceSource: "business",
    });
  }

  if (update.message) {
    return normalizeMessage({
      update,
      config,
      message: update.message,
      user: update.message.from,
      text: update.message.text,
      idSuffix: `message:${update.message.message_id}`,
    });
  }

  return undefined;
};

interface NormalizeMessageInput {
  update: TelegramUpdate;
  config: TelegramAssistantConfig;
  message: NonNullable<TelegramUpdate["message"]>;
  user?: NonNullable<TelegramUpdate["message"]>["from"];
  text?: string;
  idSuffix: string;
  forceSource?: TelegramConversationSource;
}

const normalizeMessage = (
  input: NormalizeMessageInput,
): NormalizedUpdateCandidate | undefined => {
  const source = input.forceSource ?? sourceForChat(input.message.chat.type);
  if (!source) {
    return undefined;
  }

  const businessConnectionId = input.message.business_connection_id;
  if (source === "business" && !businessConnectionId) {
    return undefined;
  }

  const conversationKey = conversationKeyForMessage(
    source,
    input.message.chat.id,
    input.message.message_thread_id,
    businessConnectionId,
  );
  if (!conversationKey) {
    return undefined;
  }

  const text = input.text;
  const message: TelegramInboundMessage = {
    id: `telegram:${input.update.update_id}:${input.idSuffix}`,
    updateId: input.update.update_id,
    conversationKey,
    source,
    chatId: input.message.chat.id,
    ...(input.user?.id !== undefined ? { userId: input.user.id } : {}),
    messageId: input.message.message_id,
    ...(text !== undefined ? { text, redactedText: redactSecrets(text) } : {}),
    ...(input.user ? { actor: actorForUser(input.user, input.config) } : {}),
    ...(businessConnectionId ? { businessConnectionId } : {}),
    receivedAt: new Date(input.message.date * 1000).toISOString(),
  };

  return { message };
};

const sourceForChat = (
  chatType: NonNullable<TelegramUpdate["message"]>["chat"]["type"],
): TelegramConversationSource | undefined => {
  if (chatType === "private") {
    return "bot_private";
  }
  if (chatType === "group" || chatType === "supergroup") {
    return "group";
  }
  return undefined;
};

const conversationKeyForMessage = (
  source: TelegramConversationSource,
  chatId: number,
  messageThreadId: number | undefined,
  businessConnectionId: string | undefined,
): string | undefined => {
  if (source === "bot_private") {
    return `bot_private:${chatId}`;
  }
  if (source === "group") {
    return `group:${chatId}:${messageThreadId ?? "main"}`;
  }
  if (source === "business" && businessConnectionId) {
    return `business:${businessConnectionId}:${chatId}`;
  }
  return undefined;
};

const actorForUser = (
  user: NonNullable<NonNullable<TelegramUpdate["message"]>["from"]>,
  config: TelegramAssistantConfig,
): TelegramAssistantActor => ({
  telegramUserId: user.id,
  ...(user.username ? { username: user.username } : {}),
  displayName: [user.first_name, user.last_name].filter(Boolean).join(" "),
  role: roleForUser(user.id, config),
});

const roleForUser = (
  userId: number,
  config: TelegramAssistantConfig,
): TelegramAssistantRole => {
  if (isAllowedId(config.adminUserIds, userId)) {
    return "admin";
  }
  if (isAllowedId(config.operatorUserIds, userId)) {
    return "operator";
  }
  if (isAllowedId(config.developerUserIds, userId)) {
    return "developer";
  }
  return "viewer";
};

const isAllowedId = (allowedIds: string[], id: number): boolean =>
  allowedIds.length === 0 || allowedIds.includes(String(id));

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + Math.max(0, days));
  return date.toISOString();
};

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
