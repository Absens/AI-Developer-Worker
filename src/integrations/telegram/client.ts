import { redactSecrets } from "../../observability/redaction.js";
import type {
  TelegramApiResponse,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";
import { TELEGRAM_ALLOWED_UPDATES } from "./types.js";

export type TelegramFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TelegramClientOptions {
  botToken: string;
  fetch?: TelegramFetch;
  apiBaseUrl?: string;
}

export interface TelegramGetUpdatesOptions {
  offset?: number;
  timeoutSeconds?: number;
}

export interface TelegramSendMessageInput {
  chatId: number | string;
  text: string;
  parseMode?: "HTML";
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
  businessConnectionId?: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramAnswerCallbackQueryInput {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
  url?: string;
  cacheTime?: number;
}

export interface TelegramSetWebhookInput {
  url: string;
  secretToken?: string;
  dropPendingUpdates?: boolean;
}

export interface TelegramDeleteWebhookInput {
  dropPendingUpdates?: boolean;
}

export class TelegramRetryAfterError extends Error {
  readonly retryAfterSeconds: number;

  constructor(
    method: string,
    retryAfterSeconds: number,
    description?: string,
    secrets: string[] = [],
  ) {
    super(
      redactTelegramText(
        `Telegram request ${method} was rate limited; retry after ${retryAfterSeconds}s${
          description ? `: ${description}` : ""
        }`,
        secrets,
      ),
    );
    this.name = "TelegramRetryAfterError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly isParseModeError: boolean;

  constructor(method: string, status: number, description?: string, secrets: string[] = []) {
    const safeDescription = redactTelegramText(
      description ?? "Unknown Telegram API error",
      secrets,
    );
    super(`Telegram request ${method} failed with status ${status}: ${safeDescription}`);
    this.name = "TelegramApiError";
    this.status = status;
    this.isParseModeError =
      status === 400 &&
      (safeDescription.toLowerCase().includes("can't parse") ||
        safeDescription.toLowerCase().includes("parse entities"));
  }
}

export class TelegramClient {
  private readonly botToken: string;
  private readonly fetchImpl: TelegramFetch;
  private readonly apiBaseUrl: string;

  constructor(options: TelegramClientOptions) {
    this.botToken = options.botToken;
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
  }

  async getUpdates(options: TelegramGetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
    return this.post<TelegramUpdate[]>("getUpdates", {
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.timeoutSeconds !== undefined ? { timeout: options.timeoutSeconds } : {}),
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    });
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<TelegramMessage> {
    const body = this.buildSendMessageBody(input);

    try {
      return await this.post<TelegramMessage>("sendMessage", body);
    } catch (error) {
      if (
        input.parseMode === "HTML" &&
        error instanceof TelegramApiError &&
        error.isParseModeError
      ) {
        return this.post<TelegramMessage>("sendMessage", this.buildSendMessageBody({
          ...input,
          parseMode: undefined,
        }));
      }

      throw error;
    }
  }

  async answerCallbackQuery(input: TelegramAnswerCallbackQueryInput): Promise<boolean> {
    return this.post<boolean>("answerCallbackQuery", {
      callback_query_id: input.callbackQueryId,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.showAlert !== undefined ? { show_alert: input.showAlert } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.cacheTime !== undefined ? { cache_time: input.cacheTime } : {}),
    });
  }

  async setWebhook(input: TelegramSetWebhookInput): Promise<boolean> {
    return this.post<boolean>("setWebhook", {
      url: input.url,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
      ...(input.secretToken !== undefined ? { secret_token: input.secretToken } : {}),
      ...(input.dropPendingUpdates !== undefined
        ? { drop_pending_updates: input.dropPendingUpdates }
        : {}),
    });
  }

  async deleteWebhook(input: TelegramDeleteWebhookInput = {}): Promise<boolean> {
    return this.post<boolean>("deleteWebhook", {
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
      ...(input.dropPendingUpdates !== undefined
        ? { drop_pending_updates: input.dropPendingUpdates }
        : {}),
    });
  }

  private buildSendMessageBody(input: TelegramSendMessageInput): Record<string, unknown> {
    return {
      chat_id: input.chatId,
      text: input.text,
      ...(input.parseMode !== undefined ? { parse_mode: input.parseMode } : {}),
      ...(input.disableWebPagePreview !== undefined
        ? { disable_web_page_preview: input.disableWebPagePreview }
        : {}),
      ...(input.replyToMessageId !== undefined
        ? { reply_to_message_id: input.replyToMessageId }
        : {}),
      ...(input.businessConnectionId !== undefined
        ? { business_connection_id: input.businessConnectionId }
        : {}),
      ...(input.replyMarkup !== undefined ? { reply_markup: input.replyMarkup } : {}),
    };
  }

  private async post<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const url = this.methodUrl(method);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((error) => {
      throw new TelegramApiError(
        method,
        0,
        `Telegram fetch failed: ${errorToMessage(error)}`,
        [this.botToken, url],
      );
    });
    const text = await response.text();
    const payload = parseTelegramResponse<T>(text);
    const description = payload?.description ?? text;

    if (response.status === 429) {
      throw new TelegramRetryAfterError(
        method,
        getRetryAfterSeconds(response, payload),
        description,
        [this.botToken],
      );
    }

    if (!response.ok || payload?.ok === false) {
      throw new TelegramApiError(method, response.status, description, [this.botToken]);
    }

    if (!payload?.ok) {
      throw new TelegramApiError(
        method,
        response.status,
        "Telegram response was not ok.",
        [this.botToken],
      );
    }

    if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
      throw new TelegramApiError(
        method,
        response.status,
        "Malformed Telegram response: missing result.",
        [this.botToken],
      );
    }

    return payload.result as T;
  }

  private methodUrl(method: string): string {
    return `${this.apiBaseUrl.replace(/\/$/, "")}/bot${this.botToken}/${method}`;
  }
}

const parseTelegramResponse = <T>(text: string): TelegramApiResponse<T> | undefined => {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as TelegramApiResponse<T>;
  } catch {
    return undefined;
  }
};

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const redactTelegramText = (value: string, secrets: string[] = []): string =>
  secrets.reduce((redacted, secret) => {
    if (!secret) {
      return redacted;
    }
    return redacted.split(secret).join("[redacted]");
  }, redactSecrets(value));

const getRetryAfterSeconds = <T>(
  response: Response,
  payload: TelegramApiResponse<T> | undefined,
): number => {
  if (payload?.parameters?.retry_after !== undefined) {
    return payload.parameters.retry_after;
  }

  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) {
    return 0;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds);
  }

  const timestamp = Date.parse(retryAfter);
  if (Number.isNaN(timestamp)) {
    return 0;
  }

  return Math.ceil(Math.max(0, timestamp - Date.now()) / 1000);
};
