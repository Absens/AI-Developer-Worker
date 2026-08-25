import type { TelegramIntent } from "./types.js";
import { extractMarketplaceProductReference } from "./competitorResearch.js";

export interface RouteTelegramIntentOptions {
  projectQaEnabled?: boolean;
}

export const routeTelegramIntent = (
  text: string | undefined,
  options: RouteTelegramIntentOptions = {},
): TelegramIntent => {
  const rawText = text ?? "";
  const normalizedText = rawText.trim().toLowerCase();

  if (/^(?:нет|отмена|cancel|не надо)(?:$|[\s,!.?])/u.test(normalizedText)) {
    return buildIntent("reject_action", rawText, {
      confidence: 1,
      safetyLevel: "read_only",
    });
  }
  if (/(?:создай задачу|надо сделать|починить|добавить|сделать чтобы|заведи задачу)/u.test(normalizedText)) {
    return buildIntent("create_task_draft", rawText, {
      confidence: 1,
      requiresConfirmation: true,
      safetyLevel: "confirm_write",
    });
  }
  if (/(?:ответь|скажи ему|можно продолжать|вариант)/u.test(normalizedText)) {
    return buildIntent("answer_ai_question", rawText, {
      confidence: 1,
      requiresConfirmation: true,
      safetyLevel: "confirm_write",
    });
  }
  if (/(?:напиши когда|сообщи когда|уведомь|подпиши)/u.test(normalizedText)) {
    return buildIntent("subscribe_task", rawText, {
      confidence: 1,
      safetyLevel: "read_only",
    });
  }
  if (/(?:что там|статус|готово ли|как идет|по задаче|task_[a-z0-9_-]+)/u.test(normalizedText)) {
    return buildIntent("task_status", rawText, {
      confidence: 1,
      safetyLevel: "read_only",
    });
  }
  if (/^(?:да|ок|создай|подтверждаю|yes)(?:$|[\s,!.?])/u.test(normalizedText)) {
    return buildIntent("approve_action", rawText, {
      confidence: 1,
      safetyLevel: "confirm_write",
    });
  }
  if (extractMarketplaceProductReference(rawText)) {
    return buildIntent("competitor_research", rawText, {
      confidence: 1,
      safetyLevel: "read_only",
    });
  }
  if (options.projectQaEnabled === true) {
    return buildIntent("project_question", rawText, {
      confidence: 0.6,
      safetyLevel: "read_only",
    });
  }

  return buildIntent("unknown", rawText, {
    confidence: 0,
    safetyLevel: "read_only",
  });
};

const buildIntent = (
  name: TelegramIntent["name"],
  rawText: string,
  options: Pick<TelegramIntent, "confidence" | "requiresConfirmation" | "safetyLevel">,
): TelegramIntent => ({
  name,
  confidence: options.confidence,
  rawText,
  ...(options.requiresConfirmation !== undefined
    ? { requiresConfirmation: options.requiresConfirmation }
    : {}),
  ...(options.safetyLevel !== undefined ? { safetyLevel: options.safetyLevel } : {}),
});
