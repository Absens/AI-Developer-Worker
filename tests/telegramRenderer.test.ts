import { describe, expect, it } from "vitest";

import {
  escapeTelegramHtml,
  renderTelegramResponse,
} from "../src/integrations/telegram/index.js";

describe("telegram renderer", () => {
  const expectNoPartialEntity = (message: string): void => {
    expect(message).not.toMatch(/&(a|am|l|g|q|qu|quo|quot)?$/);
    expect(message).not.toMatch(/^(amp|mp|lt|t|gt|quot|uot|ot|t);/);
  };

  it("escapes Telegram HTML special characters", () => {
    expect(escapeTelegramHtml("<token>&\"")).toBe("&lt;token&gt;&amp;&quot;");
  });

  it("renders HTML titles fields and inline buttons", () => {
    const rendered = renderTelegramResponse({
      blocks: [
        { kind: "title", text: "Review <ready>" },
        { kind: "field", label: "Status", value: "review" },
      ],
      inlineButtonRows: [[{ text: "Open task", callbackData: "open:1" }]],
      disableWebPagePreview: true,
    });

    expect(rendered.parseMode).toBe("HTML");
    expect(rendered.messages).toEqual([
      "<b>Review &lt;ready&gt;</b>\n\nStatus: <code>review</code>",
    ]);
    expect(rendered.replyMarkup).toEqual({
      inline_keyboard: [[{ text: "Open task", callback_data: "open:1" }]],
    });
    expect(rendered.disableWebPagePreview).toBe(true);
  });

  it("renders escaped link blocks as Telegram HTML anchors", () => {
    const rendered = renderTelegramResponse({
      blocks: [
        {
          kind: "link",
          label: "Open <task>",
          url: "https://worker.example.com/task?a=1&name=\"review\"",
        },
      ],
    });

    expect(rendered.messages).toEqual([
      "<a href=\"https://worker.example.com/task?a=1&amp;name=&quot;review&quot;\">Open &lt;task&gt;</a>",
    ]);
  });

  it("chunks long messages on block boundaries", () => {
    const first = "a".repeat(30);
    const second = "b".repeat(30);
    const third = "c".repeat(30);

    const rendered = renderTelegramResponse(
      {
        blocks: [
          { kind: "paragraph", text: first },
          { kind: "paragraph", text: second },
          { kind: "paragraph", text: third },
        ],
      },
      { maxMessageChars: 80 },
    );

    expect(rendered.messages).toEqual([`${first}\n\n${second}`, third]);
  });

  it("splits a single oversized paragraph within Telegram's 4096 character limit", () => {
    const rendered = renderTelegramResponse({
      blocks: [{ kind: "paragraph", text: "x".repeat(9000) }],
    });

    expect(rendered.messages.length).toBeGreaterThan(1);
    expect(rendered.messages.every((message) => message.length <= 4096)).toBe(true);
    expect(rendered.messages.join("")).toBe("x".repeat(9000));
  });

  it("splits oversized titles into balanced bold chunks", () => {
    const rendered = renderTelegramResponse(
      {
        blocks: [{ kind: "title", text: "Title <&\" ".repeat(12) }],
      },
      { maxMessageChars: 40 },
    );

    expect(rendered.messages.length).toBeGreaterThan(1);
    for (const message of rendered.messages) {
      expect(message.length).toBeLessThanOrEqual(40);
      expect(message.startsWith("<b>")).toBe(true);
      expect(message.endsWith("</b>")).toBe(true);
      expect(message.slice(3, -4)).not.toContain("<b>");
      expectNoPartialEntity(message);
    }
  });

  it("splits oversized code blocks into balanced pre code chunks", () => {
    const rendered = renderTelegramResponse(
      {
        blocks: [{ kind: "code", code: "const value = \"<&\";\n".repeat(8) }],
      },
      { maxMessageChars: 60 },
    );

    expect(rendered.messages.length).toBeGreaterThan(1);
    for (const message of rendered.messages) {
      expect(message.length).toBeLessThanOrEqual(60);
      expect(message.startsWith("<pre><code>")).toBe(true);
      expect(message.endsWith("</code></pre>")).toBe(true);
      expectNoPartialEntity(message);
    }
  });

  it("splits oversized fields into valid code chunks", () => {
    const rendered = renderTelegramResponse(
      {
        blocks: [{ kind: "field", label: "Status", value: "review <&\" ".repeat(8) }],
      },
      { maxMessageChars: 70 },
    );

    expect(rendered.messages.length).toBeGreaterThan(1);
    for (const message of rendered.messages) {
      expect(message.length).toBeLessThanOrEqual(70);
      expect(message.startsWith("Status: <code>")).toBe(true);
      expect(message.endsWith("</code>")).toBe(true);
      expectNoPartialEntity(message);
    }
  });

  it("splits oversized links into valid anchor chunks", () => {
    const rendered = renderTelegramResponse(
      {
        blocks: [
          {
            kind: "link",
            label: "Open <task> & review ".repeat(5),
            url: "https://worker.example.com/task?a=1&name=\"review\"",
          },
        ],
      },
      { maxMessageChars: 120 },
    );

    expect(rendered.messages.length).toBeGreaterThan(1);
    for (const message of rendered.messages) {
      expect(message.length).toBeLessThanOrEqual(120);
      expect(
        message.startsWith(
          "<a href=\"https://worker.example.com/task?a=1&amp;name=&quot;review&quot;\">",
        ),
      ).toBe(true);
      expect(message.endsWith("</a>")).toBe(true);
      expectNoPartialEntity(message);
    }
  });

  it("does not split escaped entities across paragraph chunks", () => {
    const rendered = renderTelegramResponse(
      {
        blocks: [{ kind: "paragraph", text: "<&\"".repeat(10) }],
      },
      { maxMessageChars: 19 },
    );

    expect(rendered.messages.length).toBeGreaterThan(1);
    for (const message of rendered.messages) {
      expect(message.length).toBeLessThanOrEqual(19);
      expectNoPartialEntity(message);
    }
    expect(rendered.messages.join("")).toBe(escapeTelegramHtml("<&\"".repeat(10)));
  });

  it("clamps tiny maxMessageChars instead of emitting broken formatted tags", () => {
    const rendered = renderTelegramResponse(
      {
        blocks: [{ kind: "code", code: "abc" }],
      },
      { maxMessageChars: 8 },
    );

    for (const message of rendered.messages) {
      expect(message.startsWith("<pre><code>")).toBe(true);
      expect(message.endsWith("</code></pre>")).toBe(true);
      expect(message.length).toBeLessThanOrEqual(4096);
    }
    expect(
      rendered.messages
        .map((message) => message.replace("<pre><code>", "").replace("</code></pre>", ""))
        .join(""),
    ).toBe("abc");
    expect(rendered.messages.every((message) => message.length <= 4096)).toBe(true);
  });
});
