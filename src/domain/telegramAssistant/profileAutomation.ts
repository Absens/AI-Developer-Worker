import type { TelegramAssistantConfig } from "../../models/types.js";
import type {
  TelegramBusinessConnectionRecord,
  TelegramInboundMessage,
} from "./types.js";

export interface BusinessMessagePolicy {
  allowed: boolean;
  reason?: string;
  canReply: boolean;
  shouldAutoReply: boolean;
}

export const canHandleBusinessMessage = (
  config: TelegramAssistantConfig,
  message: TelegramInboundMessage,
  connection: TelegramBusinessConnectionRecord | undefined,
): BusinessMessagePolicy => {
  if (!config.profileAutomation.enabled) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "profile automation disabled",
    };
  }
  if (!message.businessConnectionId) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "missing business connection",
    };
  }
  if (!connection?.isEnabled) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "business connection disabled",
    };
  }
  if (!config.profileAutomation.allowedOwnerIds.includes(connection.ownerUserId)) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "owner not allowlisted",
    };
  }
  if (message.senderIsBot === true) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "business sender is bot",
    };
  }
  if (
    message.userId !== undefined &&
    String(message.userId) === connection.ownerUserId
  ) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "business owner outbound message",
    };
  }
  if (
    config.profileAutomation.allowedChatIds.length > 0 &&
    !config.profileAutomation.allowedChatIds.includes(String(message.chatId))
  ) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "chat not allowlisted",
    };
  }
  if (connection.rights.can_read_messages !== true) {
    return {
      allowed: false,
      canReply: false,
      shouldAutoReply: false,
      reason: "business connection cannot read messages",
    };
  }
  const canReply = connection.rights.can_reply === true;
  return {
    allowed: true,
    canReply,
    shouldAutoReply: config.profileAutomation.autoReplyEnabled,
  };
};

