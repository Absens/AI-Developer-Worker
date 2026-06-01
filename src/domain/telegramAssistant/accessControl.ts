import type {
  TelegramAssistantConfig,
  TelegramAssistantGroupMode,
  TelegramAssistantRole,
} from "../../models/types.js";
import type { TelegramInboundMessage } from "./types.js";

export interface TelegramResolvedActor {
  allowed: boolean;
  role: TelegramAssistantRole;
  telegramUserId?: number;
  username?: string;
  displayName?: string;
}

export interface ShouldProcessGroupMessageInput {
  text?: string;
  groupMode: TelegramAssistantGroupMode;
  botUsername?: string;
  isReplyToBot?: boolean;
  replyToBotUsername?: string;
}

export const resolveTelegramActor = (
  config: TelegramAssistantConfig,
  message: TelegramInboundMessage,
): TelegramResolvedActor => {
  const telegramUserId = message.userId ?? message.actor?.telegramUserId;
  const role = resolveTelegramRole(config, telegramUserId);
  const allowed =
    isAllowedTelegramId(config.allowedChatIds, message.chatId) ||
    isAllowedTelegramId(config.allowedUserIds, telegramUserId) ||
    role !== "viewer";

  return {
    allowed,
    role,
    ...(telegramUserId !== undefined ? { telegramUserId } : {}),
    ...(message.actor?.username ? { username: message.actor.username } : {}),
    ...(message.actor?.displayName ? { displayName: message.actor.displayName } : {}),
  };
};

export const canPerformTelegramWrite = (
  actor: Pick<TelegramResolvedActor, "allowed" | "role">,
): boolean =>
  actor.allowed &&
  (actor.role === "developer" ||
    actor.role === "operator" ||
    actor.role === "admin");

export const shouldProcessGroupMessage = (
  input: ShouldProcessGroupMessageInput,
): boolean => {
  if (input.groupMode === "all_messages") {
    return true;
  }
  if (input.groupMode === "private_only") {
    return false;
  }
  const botUsername = normalizeTelegramUsername(input.botUsername);
  if (!botUsername) {
    return false;
  }

  if (normalizeTelegramUsername(input.replyToBotUsername) === botUsername) {
    return true;
  }

  return buildTelegramMentionPattern(botUsername).test(input.text ?? "");
};

export const resolveTelegramRole = (
  config: TelegramAssistantConfig,
  userId: number | undefined,
): TelegramAssistantRole => {
  if (isAllowedTelegramId(config.adminUserIds, userId)) {
    return "admin";
  }
  if (isAllowedTelegramId(config.operatorUserIds, userId)) {
    return "operator";
  }
  if (isAllowedTelegramId(config.developerUserIds, userId)) {
    return "developer";
  }
  return "viewer";
};

const isAllowedTelegramId = (
  allowedIds: string[],
  id: number | undefined,
): boolean => id !== undefined && allowedIds.includes(String(id));

const normalizeTelegramUsername = (username: string | undefined): string | undefined => {
  const normalized = username?.trim().replace(/^@/, "").toLowerCase();
  return normalized || undefined;
};

const buildTelegramMentionPattern = (botUsername: string): RegExp =>
  new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(botUsername)}(?![A-Za-z0-9_])`, "iu");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
