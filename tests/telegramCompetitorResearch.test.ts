import { describe, expect, it } from "vitest";

import {
  buildCompetitorResearchFallbackTelegramResponse,
  buildCompetitorResearchHtmlReport,
  buildCompetitorResearchPrompt,
  buildCompetitorResearchReportFileName,
  buildCompetitorResearchTelegramResponse,
  COMPETITOR_RESEARCH_OUTPUT_SCHEMA,
  extractWildberriesProductReference,
  parseCompetitorResearchOutput,
} from "../src/domain/telegramAssistant/competitorResearch.js";
import { renderTelegramResponse } from "../src/integrations/telegram/renderer.js";

const reference = {
  marketplace: "wildberries" as const,
  productId: "123456789",
  sourceUrl: "https://www.wildberries.ru/catalog/123456789/detail.aspx",
};

describe("extractWildberriesProductReference", () => {
  it.each([
    [
      "https://www.wildberries.ru/catalog/123456789/detail.aspx",
      "123456789",
    ],
    [
      "Посмотри https://wildberries.ru/catalog/987654321/detail.aspx?targetUrl=SP, пожалуйста",
      "987654321",
    ],
    [
      "wildberries.ru/catalog/555666777/detail.aspx",
      "555666777",
    ],
    [
      "Ссылка: https://global.wildberries.ru/catalog/111222333/detail.aspx.",
      "111222333",
    ],
  ])("extracts and canonicalizes %s", (text, productId) => {
    expect(extractWildberriesProductReference(text)).toEqual({
      marketplace: "wildberries",
      productId,
      sourceUrl: `https://www.wildberries.ru/catalog/${productId}/detail.aspx`,
    });
  });

  it.each([
    "https://example.com/catalog/123456789/detail.aspx",
    "https://evilwildberries.ru/catalog/123456789/detail.aspx",
    "https://www.wildberries.ru/brands/example",
    "https://www.wildberries.ru/catalog/not-a-number/detail.aspx",
    "просто текст без ссылки",
  ])("rejects non-product input %s", (text) => {
    expect(extractWildberriesProductReference(text)).toBeUndefined();
  });
});

describe("competitor research prompt", () => {
  it("requires a concise summary and sourced full Russian report", () => {
    const prompt = buildCompetitorResearchPrompt(reference);

    expect(prompt).toContain(reference.sourceUrl);
    expect(prompt).toContain("русском языке");
    expect(prompt).toContain("краткое резюме");
    expect(prompt).toContain("полный отчёт");
    expect(prompt).toContain("прямых конкурентов");
    expect(prompt).toContain("поисковых конкурентов");
    expect(prompt).toContain("альтернатив покупателя");
    expect(prompt).toContain("URL источника");
    expect(prompt).toContain("Не выдумывай");
    expect(prompt).toContain("продаж");
    expect(prompt).toContain("остатков");
  });

  it("defines a strict summary-and-report output schema", () => {
    expect(COMPETITOR_RESEARCH_OUTPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["summary", "report"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 2500 },
        report: { type: "string", minLength: 1 },
      },
    });
  });
});

describe("parseCompetitorResearchOutput", () => {
  it("extracts a structured summary and report", () => {
    expect(parseCompetitorResearchOutput(JSON.stringify({
      summary: "  Краткий вывод.  ",
      report: "  Готовый отчёт.  ",
    }))).toEqual({
      summary: "Краткий вывод.",
      report: "Готовый отчёт.",
    });
  });

  it("builds a bounded compatibility summary for report-only JSON", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      report: [
        "## Основные выводы",
        "Первый важный вывод.",
        "Второй важный вывод.",
      ].join("\n"),
    }));

    expect(parsed.report).toContain("Первый важный вывод");
    expect(parsed.summary).toContain("Первый важный вывод");
    expect(parsed.summary.length).toBeLessThanOrEqual(2500);
  });

  it("keeps a non-empty plain-text response for CLI compatibility", () => {
    expect(parseCompetitorResearchOutput("  Обычный текст отчёта.  ")).toEqual({
      summary: "Обычный текст отчёта.",
      report: "Обычный текст отчёта.",
    });
  });

  it("returns stable diagnostics for empty output", () => {
    expect(parseCompetitorResearchOutput("   ")).toEqual({
      summary: "Codex не вернул отчёт по конкурентам.",
      report: "Codex не вернул отчёт по конкурентам.",
    });
  });
});

describe("competitor research presentation", () => {
  it("renders only the concise summary in Telegram", () => {
    const rendered = renderTelegramResponse(
      buildCompetitorResearchTelegramResponse(
        "Найдено 8 релевантных карточек. Три действия: изменить первый экран, уточнить УТП, проверить цену.",
        reference,
      ),
    );

    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0]).toContain("Конкурентный анализ Wildberries");
    expect(rendered.messages[0]).toContain("Найдено 8 релевантных карточек");
    expect(rendered.messages[0]).toContain("Полный отчёт приложен HTML-файлом");
    expect(rendered.disableWebPagePreview).toBe(true);
  });

  it("keeps a chunked text fallback when document delivery is unavailable", () => {
    const rendered = renderTelegramResponse(
      buildCompetitorResearchFallbackTelegramResponse(
        "Раздел отчёта. ".repeat(900),
        reference,
      ),
    );

    expect(rendered.messages.length).toBeGreaterThan(2);
    expect(rendered.messages.every((message) => message.length <= 3900)).toBe(true);
    expect(rendered.messages[0]).toContain("Полный отчёт текстом");
  });

  it("creates a self-contained safe HTML report", () => {
    const html = buildCompetitorResearchHtmlReport({
      reference,
      summary: "Краткий <script>alert('summary')</script> вывод.",
      report: [
        "## Основные конкуренты",
        "- Конкурент A — https://www.wildberries.ru/catalog/987654321/detail.aspx",
        "- <img src=x onerror=alert(1)>",
        "",
        "## Рекомендации",
        "1. Улучшить первый экран.",
      ].join("\n"),
      generatedAt: "2026-08-18T15:30:00.000Z",
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Конкурентный анализ Wildberries");
    expect(html).toContain("123456789");
    expect(html).toContain("2026-08-18T15:30:00.000Z");
    expect(html).toContain("&lt;script&gt;alert(&#39;summary&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("<h2>Основные конкуренты</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain(
      '<a href="https://www.wildberries.ru/catalog/987654321/detail.aspx"',
    );
    expect(html).toContain("Content-Security-Policy");
  });

  it("builds a stable report filename", () => {
    expect(buildCompetitorResearchReportFileName(reference)).toBe(
      "wb-competitor-report-123456789.html",
    );
  });
});
