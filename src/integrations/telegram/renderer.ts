import type { TelegramInlineKeyboardMarkup } from "./types.js";

const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const DEFAULT_MAX_MESSAGE_CHARS = 3900;
const MAX_ESCAPED_CHAR_LENGTH = "&quot;".length;

type TelegramTitleBlock = { kind: "title"; text: string };
type TelegramParagraphBlock = { kind: "paragraph"; text: string };
type TelegramFieldBlock = {
  kind: "field";
  label: string;
  value: string;
};
type TelegramCodeBlock = { kind: "code"; code: string };
type TelegramLinkBlock = {
  kind: "link";
  label: string;
  url: string;
};

export type TelegramBlock =
  | TelegramTitleBlock
  | TelegramParagraphBlock
  | TelegramFieldBlock
  | TelegramCodeBlock
  | TelegramLinkBlock;

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

export interface TelegramResponse {
  blocks: TelegramBlock[];
  inlineButtonRows?: TelegramInlineButton[][];
  disableWebPagePreview?: boolean;
}

export interface RenderTelegramResponseOptions {
  maxMessageChars?: number;
}

export interface RenderedTelegramResponse {
  parseMode: "HTML";
  messages: string[];
  replyMarkup?: TelegramInlineKeyboardMarkup;
  disableWebPagePreview?: boolean;
}

export const escapeTelegramHtml = (input: string): string =>
  input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const renderTelegramResponse = (
  response: TelegramResponse,
  options: RenderTelegramResponseOptions = {},
): RenderedTelegramResponse => ({
  parseMode: "HTML",
  messages: chunkBlocks(response.blocks, normalizeMaxMessageChars(options.maxMessageChars)),
  ...(response.inlineButtonRows !== undefined
    ? { replyMarkup: renderInlineKeyboard(response.inlineButtonRows) }
    : {}),
  ...(response.disableWebPagePreview !== undefined
    ? { disableWebPagePreview: response.disableWebPagePreview }
    : {}),
});

const renderBlock = (block: TelegramBlock, maxMessageChars: number): string[] => {
  switch (block.kind) {
    case "title":
      return renderWrappedText(block.text, "<b>", "</b>", maxMessageChars);
    case "paragraph":
      return splitEscapedText(block.text, safeContentLimit(maxMessageChars, 0));
    case "field":
      return renderField(block, maxMessageChars);
    case "code":
      return renderWrappedText(
        block.code,
        "<pre><code>",
        "</code></pre>",
        maxMessageChars,
      );
    case "link":
      return renderLink(block, maxMessageChars);
  }
};

const chunkBlocks = (blocks: TelegramBlock[], maxMessageChars: number): string[] => {
  const messages: string[] = [];
  let current = "";

  for (const block of blocks) {
    const rendered = renderBlock(block, maxMessageChars);
    if (rendered.length > 1) {
      if (current) {
        messages.push(current);
        current = "";
      }
      messages.push(...rendered);
      continue;
    }

    const blockText = rendered[0];
    if (!blockText) {
      continue;
    }
    const candidate = current ? `${current}\n\n${blockText}` : blockText;
    if (candidate.length <= maxMessageChars) {
      current = candidate;
      continue;
    }

    if (current) {
      messages.push(current);
    }
    current = blockText;
  }

  if (current) {
    messages.push(current);
  }

  return messages;
};

const renderWrappedText = (
  text: string,
  prefix: string,
  suffix: string,
  maxMessageChars: number,
): string[] => {
  const contentLimit = safeContentLimit(maxMessageChars, prefix.length + suffix.length);
  return splitEscapedText(text, contentLimit).map((chunk) => `${prefix}${chunk}${suffix}`);
};

const renderField = (block: TelegramFieldBlock, maxMessageChars: number): string[] => {
  const prefix = `${escapeTelegramHtml(block.label)}: <code>`;
  const suffix = "</code>";
  if (prefix.length + suffix.length + MAX_ESCAPED_CHAR_LENGTH > TELEGRAM_MAX_MESSAGE_CHARS) {
    return [
      ...splitEscapedText(block.label, safeContentLimit(maxMessageChars, 0)),
      ...renderWrappedText(block.value, "<code>", "</code>", maxMessageChars),
    ];
  }

  const contentLimit = safeContentLimit(maxMessageChars, prefix.length + suffix.length);
  return splitEscapedText(block.value, contentLimit).map(
    (chunk) => `${prefix}${chunk}${suffix}`,
  );
};

const renderLink = (block: TelegramLinkBlock, maxMessageChars: number): string[] => {
  const prefix = `<a href="${escapeTelegramHtml(block.url)}">`;
  const suffix = "</a>";
  if (prefix.length + suffix.length + MAX_ESCAPED_CHAR_LENGTH > TELEGRAM_MAX_MESSAGE_CHARS) {
    return [
      ...splitEscapedText(block.label, safeContentLimit(maxMessageChars, 0)),
      ...splitEscapedText(block.url, safeContentLimit(maxMessageChars, 0)),
    ];
  }

  const contentLimit = safeContentLimit(maxMessageChars, prefix.length + suffix.length);
  return splitEscapedText(block.label, contentLimit).map(
    (chunk) => `${prefix}${chunk}${suffix}`,
  );
};

const splitEscapedText = (text: string, maxChars: number): string[] => {
  if (!text) {
    return [""];
  }

  const chunks: string[] = [];
  let current = "";

  for (const character of Array.from(text)) {
    const escaped = escapeTelegramHtml(character);
    if (current && current.length + escaped.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += escaped;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
};

const normalizeMaxMessageChars = (maxMessageChars?: number): number => {
  if (maxMessageChars === undefined) {
    return DEFAULT_MAX_MESSAGE_CHARS;
  }

  return Math.min(Math.max(1, Math.floor(maxMessageChars)), TELEGRAM_MAX_MESSAGE_CHARS);
};

const safeContentLimit = (maxMessageChars: number, wrapperChars: number): number =>
  Math.max(1, Math.min(TELEGRAM_MAX_MESSAGE_CHARS, maxMessageChars) - wrapperChars);

const renderInlineKeyboard = (
  rows: TelegramInlineButton[][],
): TelegramInlineKeyboardMarkup => ({
  inline_keyboard: rows.map((row) =>
    row.map((button) => ({
      text: button.text,
      callback_data: button.callbackData,
    })),
  ),
});
