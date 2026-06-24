import type { TelegramAssistantRole } from "../../models/types.js";

export type { TelegramAssistantRole } from "../../models/types.js";

export type TelegramConversationSource = "bot_private" | "group" | "business";

export type TelegramDigitalTwinSessionStatus =
  | "active"
  | "paused"
  | "reset_requested"
  | "disabled_by_connection"
  | "failed";

export type TelegramDigitalTwinMessageDirection =
  | "inbound"
  | "outbound"
  | "system";

export type TelegramDigitalTwinDeliveryStatus =
  | "received"
  | "generating"
  | "generated"
  | "sending"
  | "sent"
  | "send_failed"
  | "unknown_after_send_attempt"
  | "skipped"
  | "duplicate";

export type TelegramDigitalTwinTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TelegramDigitalTwinSession {
  sessionKey: string;
  source: "business";
  chatId: number;
  businessConnectionId: string;
  ownerUserId?: string;
  ownerChatId?: string;
  status: TelegramDigitalTwinSessionStatus;
  statusReason?: string;
  codexThreadId?: string;
  personaProfileVersion: string;
  summary?: string;
  summaryUpdatedAt?: string;
  summaryNeedsRefresh: boolean;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramDigitalTwinMessage {
  id: string;
  sessionKey: string;
  messageKey: string;
  telegramUpdateId?: number;
  direction: TelegramDigitalTwinMessageDirection;
  telegramMessageId?: number;
  sentTelegramMessageId?: number;
  deliveryStatus: TelegramDigitalTwinDeliveryStatus;
  deliveryAttemptedAt?: string;
  deliveredAt?: string;
  deliveryError?: string;
  redactedText?: string;
  fullTextEncrypted?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface TelegramDigitalTwinTurn {
  id: string;
  sessionKey: string;
  inboundMessageKey: string;
  outboundMessageKey: string;
  status: TelegramDigitalTwinTurnStatus;
  codexThreadId?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  metadata: Record<string, unknown>;
}

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
  senderIsBot?: boolean;
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

export type TelegramTaskRiskLevel = "low" | "medium" | "high";

export interface TelegramTaskRiskAssessment {
  riskLevel: TelegramTaskRiskLevel;
  reasons: string[];
  requiresOwnerApproval: boolean;
}

export type TelegramExecutableTaskDraftSource = "private" | "business" | "twin";

export type TelegramExecutableTaskDraftStatus =
  | "collecting"
  | "awaiting_user_confirmation"
  | "awaiting_owner_approval"
  | "completed"
  | "cancelled"
  | "expired";

export type TelegramExecutableTaskDraftExecutionMode =
  | "auto_ready"
  | "owner_approval"
  | "triage_only";

export interface TelegramExecutableTaskDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
  repositoryName?: string;
  repoPathKey?: string;
  baseBranch?: string;
  queue?: string;
  tags: string[];
  risk: TelegramTaskRiskAssessment;
  executionMode: TelegramExecutableTaskDraftExecutionMode;
}

export interface TelegramExecutableTaskDraftQuestion {
  field: "repositoryProfile" | "acceptanceCriteria" | "description";
  text: string;
}

export interface TelegramExecutableTaskDraftClarification {
  field: TelegramExecutableTaskDraftQuestion["field"];
  question: string;
  answer: string;
  answeredAt: string;
}

export interface TelegramExecutableTaskDraftSession {
  id: string;
  conversationKey: string;
  source: TelegramExecutableTaskDraftSource;
  initiatorUserId?: number;
  ownerUserId?: string;
  ownerChatId?: string;
  chatId: number;
  messageId?: number;
  originalText: string;
  draft: TelegramExecutableTaskDraft;
  status: TelegramExecutableTaskDraftStatus;
  clarificationQuestion?: TelegramExecutableTaskDraftQuestion;
  clarificationHistory: TelegramExecutableTaskDraftClarification[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface TelegramActiveTaskQuestionPrompt {
  id: string;
  conversationKey: string;
  chatId: number;
  userId?: number;
  taskId: string;
  questionId: string;
  promptMessageId?: number;
  status: "open" | "answered" | "cancelled" | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
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
