import { describe, expect, it } from "vitest";

import {
  TELEGRAM_ALLOWED_UPDATES,
  TelegramApiError,
  TelegramClient,
  TelegramRetryAfterError,
} from "../src/integrations/telegram/index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });

const readBody = (call: FetchCall): any => JSON.parse(String(call.init.body));

describe("TelegramClient", () => {
  it("posts getUpdates offset timeout and allowed update types to the Bot API", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ ok: true, result: [] });
    };
    const client = new TelegramClient({ botToken: "token", fetch: fetchImpl });

    const updates = await client.getUpdates({ offset: 42, timeoutSeconds: 25 });

    expect(updates).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottoken/getUpdates");
    expect(calls[0]?.init.method).toBe("POST");
    expect(readBody(calls[0]!)).toEqual({
      offset: 42,
      timeout: 25,
      allowed_updates: [
        "message",
        "callback_query",
        "business_connection",
        "business_message",
        "edited_business_message",
        "deleted_business_messages",
      ],
    });
  });

  it("throws retry-after errors for 429 responses without leaking the bot token", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 17 for secret-token",
          parameters: { retry_after: 17 },
        },
        { status: 429 },
      );
    const client = new TelegramClient({ botToken: "secret-token", fetch: fetchImpl });

    let error: unknown;
    try {
      await client.getUpdates();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TelegramRetryAfterError);
    expect((error as TelegramRetryAfterError).retryAfterSeconds).toBe(17);
    expect((error as Error).message).not.toContain("secret-token");
    expect((error as Error).message).not.toContain("https://api.telegram.org");
  });

  it("retries HTML sendMessage as plain text when Telegram rejects parse mode", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) {
        return jsonResponse(
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities: Can't find end tag",
          },
          { status: 400 },
        );
      }

      return jsonResponse({
        ok: true,
        result: { message_id: 9, chat: { id: 123, type: "private" }, date: 1 },
      });
    };
    const client = new TelegramClient({ botToken: "token", fetch: fetchImpl });

    const message = await client.sendMessage({
      chatId: 123,
      text: "<b>Hello</b>",
      parseMode: "HTML",
      disableWebPagePreview: true,
      replyToMessageId: 7,
      businessConnectionId: "biz-1",
      replyMarkup: { inline_keyboard: [[{ text: "Open", callback_data: "open" }]] },
    });

    expect(message.message_id).toBe(9);
    expect(calls).toHaveLength(2);
    expect(readBody(calls[0]!)).toMatchObject({
      chat_id: 123,
      text: "<b>Hello</b>",
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_to_message_id: 7,
      business_connection_id: "biz-1",
      reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open" }]] },
    });
    expect(readBody(calls[1]!)).toEqual({
      chat_id: 123,
      text: "<b>Hello</b>",
      disable_web_page_preview: true,
      reply_to_message_id: 7,
      business_connection_id: "biz-1",
      reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open" }]] },
    });
  });

  it("redacts fetch setup errors before rethrowing", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      throw new Error(`failed to fetch ${String(input)}`);
    };
    const client = new TelegramClient({
      botToken: "super-secret-token",
      fetch: fetchImpl,
    });

    let error: unknown;
    try {
      await client.sendMessage({ chatId: 123, text: "hello" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as Error).message).not.toMatch(/super-secret-token/);
    expect((error as Error).message).not.toMatch(
      /https:\/\/api\.telegram\.org\/bot[^/\s]+\/sendMessage/,
    );
  });

  it("rejects ok Telegram responses that omit result", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ ok: true });
    const client = new TelegramClient({ botToken: "token", fetch: fetchImpl });

    let error: unknown;
    try {
      await client.getUpdates();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as Error).message).toContain("Malformed Telegram response");
  });

  it("posts webhook allowed update types secret token and drop pending flag", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ ok: true, result: true });
    };
    const client = new TelegramClient({ botToken: "token", fetch: fetchImpl });

    await client.setWebhook({
      url: "https://worker.example.com/telegram",
      secretToken: "webhook-secret",
      dropPendingUpdates: true,
    });
    await client.deleteWebhook({ dropPendingUpdates: true });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.telegram.org/bottoken/setWebhook",
      "https://api.telegram.org/bottoken/deleteWebhook",
    ]);
    expect(readBody(calls[0]!)).toEqual({
      url: "https://worker.example.com/telegram",
      secret_token: "webhook-secret",
      drop_pending_updates: true,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    });
    expect(readBody(calls[1]!)).toEqual({
      drop_pending_updates: true,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    });
  });

  it("posts answerCallbackQuery options", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ ok: true, result: true });
    };
    const client = new TelegramClient({ botToken: "token", fetch: fetchImpl });

    const result = await client.answerCallbackQuery({
      callbackQueryId: "callback-1",
      text: "Queued",
      showAlert: true,
      url: "https://worker.example.com/task",
      cacheTime: 10,
    });

    expect(result).toBe(true);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottoken/answerCallbackQuery");
    expect(readBody(calls[0]!)).toEqual({
      callback_query_id: "callback-1",
      text: "Queued",
      show_alert: true,
      url: "https://worker.example.com/task",
      cache_time: 10,
    });
  });

  it("redacts TelegramApiError messages for malformed non-JSON responses", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("upstream failure for secret-token", { status: 502 });
    const client = new TelegramClient({ botToken: "secret-token", fetch: fetchImpl });

    let error: unknown;
    try {
      await client.getUpdates();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({
      name: "TelegramApiError",
      status: 502,
    });
    expect((error as Error).message).not.toContain("secret-token");
    expect((error as Error).message).not.toContain("https://api.telegram.org");
  });
});
