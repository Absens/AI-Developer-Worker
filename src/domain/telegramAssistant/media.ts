import type { TelegramAssistantMediaConfig } from "../../models/types.js";

export interface TelegramAttachmentCandidate {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

export const validateTelegramAttachment = (
  attachment: TelegramAttachmentCandidate,
  config: TelegramAssistantMediaConfig,
): { accepted: true } | { accepted: false; reason: string } => {
  if (!config.enabled) return { accepted: false, reason: "media disabled" };
  if (attachment.size === undefined) {
    return { accepted: false, reason: "file size required" };
  }
  if (attachment.size > config.maxBytes) {
    return { accepted: false, reason: "file too large" };
  }
  if (config.allowedMimeTypes.length > 0 && !attachment.mimeType) {
    return { accepted: false, reason: "mime type required" };
  }
  if (attachment.mimeType && !config.allowedMimeTypes.includes(attachment.mimeType)) {
    return { accepted: false, reason: "mime type not allowed" };
  }
  return { accepted: true };
};
