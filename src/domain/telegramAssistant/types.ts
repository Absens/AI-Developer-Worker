import type { TelegramAssistantRole } from "../../models/types.js";

export type { TelegramAssistantRole } from "../../models/types.js";

export type TelegramConversationSource = "bot_private" | "group" | "business";

export type TelegramIntentName =
  | "task_status"
  | "project_question"
  | "create_task_draft"
  | "answer_ai_question"
  | "subscribe_task"
  | "unsubscribe_task"
  | "approve_action"
  | "reject_action"
  | "task_command"
  | "unknown";

export interface TelegramAssistantActor {
  telegramUserId: number;
  username?: string;
  displayName?: string;
  role: TelegramAssistantRole;
}

export type TelegramAttachmentType = "document" | "photo";

export interface TelegramAttachmentMetadata {
  type: TelegramAttachmentType;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface TelegramInboundMessage {
  id: string;
  updateId: number;
  conversationKey: string;
  source: TelegramConversationSource;
  chatId: number;
  userId?: number;
  messageId?: number;
  text?: string;
  redactedText?: string;
  attachments?: TelegramAttachmentMetadata[];
  actor?: TelegramAssistantActor;
  businessConnectionId?: string;
  isReplyToBot?: boolean;
  replyToBotUsername?: string;
  receivedAt: string;
}

export type TelegramIntentSafetyLevel = "read_only" | "confirm_write";

export interface TelegramIntent {
  name: TelegramIntentName;
  confidence: number;
  rawText?: string;
  entities?: Record<string, unknown>;
  missingFields?: string[];
  requiresConfirmation?: boolean;
  safetyLevel?: TelegramIntentSafetyLevel;
}

export type TelegramPendingActionStatus =
  | "pending"
  | "executing"
  | "completed"
  | "cancelled"
  | "expired";

export interface TelegramPendingAction {
  id: string;
  conversationKey: string;
  chatId: number;
  userId: number;
  intent: TelegramIntent;
  payload: Record<string, unknown>;
  status: TelegramPendingActionStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  consumedAt?: string;
  completedAt?: string;
}

export interface TelegramTaskSubscription {
  id: string;
  taskId: string;
  conversationKey: string;
  chatId: number;
  userId?: number;
  createdAt: string;
  updatedAt: string;
  lastNotifiedEventId?: string;
}

export type TelegramMessageRefSource = "user" | "assistant" | "system";

export interface TelegramMessageRef {
  id: string;
  conversationKey: string;
  chatId: number;
  messageId: number;
  source: TelegramMessageRefSource;
  redactedText: string;
  createdAt: string;
  expiresAt: string;
}

export type TelegramAssistantTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TelegramAssistantTurn {
  id: string;
  conversationKey: string;
  status: TelegramAssistantTurnStatus;
  startedAt: string;
  input?: TelegramInboundMessage;
  threadId?: string;
  completedAt?: string;
  diagnostic?: string;
}

export type TelegramQueuedMessageStatus = "queued" | "cancelled";

export interface TelegramQueuedMessage {
  id: string;
  conversationKey: string;
  chatId: number;
  userId?: number;
  message: TelegramInboundMessage;
  status: TelegramQueuedMessageStatus;
  createdAt: string;
  expiresAt: string;
  cancelledAt?: string;
}

export type TelegramNotificationDeliveryStatus = "sending" | "sent" | "failed";

export interface TelegramNotificationDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  status: TelegramNotificationDeliveryStatus;
  reservedAt: string;
  staleAfter: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface TelegramBusinessConnectionRecord {
  id: string;
  businessConnectionId: string;
  userId: number;
  ownerUserId: string;
  userChatId: number;
  ownerChatId: string;
  canReply: boolean;
  rights: TelegramBusinessConnectionRights;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  updateId?: number;
}

export interface TelegramBusinessConnectionRights {
  can_reply?: boolean;
  can_read_messages?: boolean;
  [right: string]: boolean | undefined;
}

export type TelegramBusinessConnectionInput =
  Omit<
    TelegramBusinessConnectionRecord,
    | "id"
    | "businessConnectionId"
    | "userId"
    | "ownerUserId"
    | "userChatId"
    | "ownerChatId"
    | "canReply"
    | "rights"
  > &
  Partial<
    Pick<
      TelegramBusinessConnectionRecord,
      | "id"
      | "businessConnectionId"
      | "userId"
      | "ownerUserId"
      | "userChatId"
      | "ownerChatId"
      | "canReply"
      | "rights"
    >
  >;
