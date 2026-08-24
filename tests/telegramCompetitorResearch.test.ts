import { describe, expect, it } from "vitest";

import {
  buildCompetitorResearchFallbackTelegramResponse,
  buildCompetitorResearchHtmlReport,
  buildCompetitorResearchPrompt,
  buildCompetitorResearchReportFileName,
  buildCompetitorResearchTelegramResponse,
  COMPETITOR_RESEARCH_OUTPUT_SCHEMA,
  extractWildberriesProductReference,
  isCompetitorResearchSourceVerified,
  parseCompetitorResearchOutput,
} from "../src/domain/telegramAssistant/competitorResearch.js";
import { renderTelegramResponse } from "../src/integrations/telegram/renderer.js";

const reference = {
  marketplace: "wildberries" as const,
  productId: "123456789",
  sourceUrl: "https://www.wildberries.ru/catalog/123456789/detail.aspx",
};

const verifiedSource = () => ({
  status: "verified" as const,
  requestedProductId: reference.productId,
  resolvedProductId: reference.productId,
  productTitle: "Проверенный товар",
  brand: "Проверенный бренд",
  evidence: [
    "Playwright snapshot: карточка содержит артикул 123456789 и название товара.",
  ],
  failureReason: null,
});

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
  it("requires browser verification before any competitor search", () => {
    const prompt = buildCompetitorResearchPrompt(reference);

    expect(prompt).toContain(reference.sourceUrl);
    expect(prompt).toContain("Playwright MCP");
    expect(prompt).toContain("browser_navigate");
    expect(prompt).toContain("browser_wait_for");
    expect(prompt).toContain("browser_snapshot");
    expect(prompt).toContain("browser_network_requests");
    expect(prompt).toContain("browser_network_request");
    expect(prompt).toContain("не используй web search");
    expect(prompt).toContain(reference.productId);
    expect(prompt).toContain("sourceVerification.status = failed");
    expect(prompt).toContain("не ищи конкурентов");
    expect(prompt).toContain("не делай предположений");
  });

  it("uses worker-verified CDN metadata without requiring a second source-card navigation", () => {
    const prompt = buildCompetitorResearchPrompt(reference, {
      productId: reference.productId,
      productTitle: "Подтверждённый товар",
      brand: "Brand",
      category: "Категория",
      description: "Описание",
      attributes: [{ name: "Состав", value: "хлопок" }],
      sourceUrl: "https://basket-05.wbbasket.ru/card.json",
    });

    expect(prompt).toContain("карточка уже подтверждена worker");
    expect(prompt).toContain("Подтверждённый товар");
    expect(prompt).toContain("basket-05.wbbasket.ru/card.json");
    expect(prompt).not.toContain(
      "Обязательно используй Playwright MCP до любого поиска конкурентов",
    );
  });

  it("requires a concise summary and sourced full Russian report after verification", () => {
    const prompt = buildCompetitorResearchPrompt(reference);

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

  it("defines a strict source-verification-and-report output schema", () => {
    expect(COMPETITOR_RESEARCH_OUTPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["sourceVerification", "summary", "report"],
      properties: {
        sourceVerification: {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "requestedProductId",
            "resolvedProductId",
            "productTitle",
            "brand",
            "evidence",
            "failureReason",
          ],
          properties: {
            status: { type: "string", enum: ["verified", "failed"] },
            requestedProductId: { type: "string", minLength: 1 },
            resolvedProductId: { type: ["string", "null"] },
            productTitle: { type: ["string", "null"] },
            brand: { type: ["string", "null"] },
            evidence: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            failureReason: { type: ["string", "null"] },
          },
        },
        summary: { type: "string", minLength: 1, maxLength: 2500 },
        report: { type: "string" },
      },
    });
  });
});

describe("parseCompetitorResearchOutput", () => {
  it("extracts a browser-verified structured summary and report", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: verifiedSource(),
      summary: "  Краткий вывод.  ",
      report: "  Готовый отчёт.  ",
    }), reference);

    expect(parsed).toEqual({
      sourceVerification: verifiedSource(),
      summary: "Краткий вывод.",
      report: "Готовый отчёт.",
    });
    expect(isCompetitorResearchSourceVerified(parsed, reference)).toBe(true);
  });

  it("keeps an explicit browser verification failure and stops it from becoming valid", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: {
        status: "failed",
        requestedProductId: reference.productId,
        resolvedProductId: null,
        productTitle: null,
        brand: null,
        evidence: ["Playwright получил CAPTCHA вместо карточки."],
        failureReason: "Wildberries не отдал товарные данные.",
      },
      summary: "Исходную карточку подтвердить не удалось.",
      report: "",
    }), reference);

    expect(parsed.sourceVerification.status).toBe("failed");
    expect(parsed.sourceVerification.failureReason).toBe(
      "Wildberries не отдал товарные данные.",
    );
    expect(parsed.report).toBe("");
    expect(isCompetitorResearchSourceVerified(parsed, reference)).toBe(false);
  });

  it("rejects a nominally verified result for a different article", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: {
        ...verifiedSource(),
        resolvedProductId: "987654321",
      },
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(isCompetitorResearchSourceVerified(parsed, reference)).toBe(false);
  });

  it("rejects verified output without a product title or browser evidence", () => {
    const noEvidence = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: {
        ...verifiedSource(),
        productTitle: " ",
        evidence: [],
      },
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(isCompetitorResearchSourceVerified(noEvidence, reference)).toBe(false);
  });

  it("rejects browser evidence that does not mention the exact requested article", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: {
        ...verifiedSource(),
        evidence: ["Playwright snapshot showed a product title and brand."],
      },
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(isCompetitorResearchSourceVerified(parsed, reference)).toBe(false);
  });

  it("rejects verified output that still contains a failure reason", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: {
        ...verifiedSource(),
        failureReason: "Карточка подтверждена только частично.",
      },
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(isCompetitorResearchSourceVerified(parsed, reference)).toBe(false);
  });

  it("fails closed for legacy report-only JSON", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      report: "## Основные выводы\nПервый важный вывод.",
    }), reference);

    expect(parsed.sourceVerification).toEqual({
      status: "failed",
      requestedProductId: reference.productId,
      resolvedProductId: null,
      productTitle: null,
      brand: null,
      evidence: [],
      failureReason: "Codex не вернул структурированную browser-верификацию исходной карточки.",
    });
    expect(parsed.report).toContain("Первый важный вывод");
    expect(isCompetitorResearchSourceVerified(parsed, reference)).toBe(false);
  });

  it("fails closed for non-empty plain-text CLI output", () => {
    const parsed = parseCompetitorResearchOutput(
      "  Текстовый отчёт без browser-верификации.  ",
      reference,
    );

    expect(parsed.summary).toBe("Текстовый отчёт без browser-верификации.");
    expect(parsed.report).toBe("Текстовый отчёт без browser-верификации.");
    expect(parsed.sourceVerification.status).toBe("failed");
    expect(isCompetitorResearchSourceVerified(parsed, reference)).toBe(false);
  });

  it("returns stable failed diagnostics for empty output", () => {
    expect(parseCompetitorResearchOutput("   ", reference)).toEqual({
      sourceVerification: {
        status: "failed",
        requestedProductId: reference.productId,
        resolvedProductId: null,
        productTitle: null,
        brand: null,
        evidence: [],
        failureReason: "Codex не вернул результат исследования конкурентов.",
      },
      summary: "Codex не вернул результат исследования конкурентов.",
      report: "",
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
      sourceVerification: verifiedSource(),
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
