import { describe, expect, it, vi } from "vitest";

import {
  buildCompetitorResearchFallbackTelegramResponse,
  buildCompetitorResearchHtmlReport,
  buildCompetitorResearchOutputSchema,
  buildCompetitorResearchPrompt,
  buildCompetitorResearchReportFileName,
  buildCompetitorResearchTelegramResponse,
  COMPETITOR_RESEARCH_OUTPUT_SCHEMA,
  enforceVerifiedMarketplaceCompetitors,
  extractMarketplaceProductReference,
  extractOzonProductReference,
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

const ozonReference = {
  marketplace: "ozon" as const,
  productId: "3085863400",
  sourceUrl:
    "https://www.ozon.ru/product/kuhonnyy-nozh-dlya-myasa-1-sht-lezvie-33-sm-vysokouglerodistaya-stal-3085863400/",
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

const validCompetitor = () => ({
  productId: "987654321",
  productTitle: "Подтверждённый конкурент",
  sourceUrl: "https://www.wildberries.ru/catalog/987654321/detail.aspx",
  relevance: "Тот же тип товара и сценарий использования.",
  evidence: [
    "Карточка Wildberries содержит артикул 987654321 и название товара.",
  ],
  comparison: {
    similarities: ["Та же категория и сценарий использования."],
    differences: ["Комплектация больше на две единицы."],
    strengths: ["Понятнее описан состав набора."],
    weaknesses: ["Не раскрыты размеры каждого предмета."],
    opportunity: "Добавить на первый экран точную комплектацию и размеры.",
  },
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

describe("extractOzonProductReference", () => {
  it("extracts and canonicalizes a regular Ozon product URL", () => {
    const text =
      "Посмотри https://ozon.ru/product/kuhonnyy-nozh-dlya-myasa-1-sht-lezvie-33-sm-vysokouglerodistaya-stal-3085863400/?from=share";

    expect(extractOzonProductReference(text)).toEqual(ozonReference);
    expect(extractMarketplaceProductReference(text)).toEqual(ozonReference);
  });

  it.each([
    "https://ozon.ru/t/7GxaYkf",
    "https://evilozon.ru/product/nozh-3085863400/",
    "https://www.ozon.ru/category/nozhi-14515/",
    "https://www.ozon.ru/product/nozh-without-sku/",
  ])("rejects unsupported or non-product Ozon input %s", (text) => {
    expect(extractOzonProductReference(text)).toBeUndefined();
  });
});

describe("competitor research prompt", () => {
  it("limits Ozon research and its output schema exclusively to Ozon cards", () => {
    const prompt = buildCompetitorResearchPrompt(ozonReference);
    const schema = buildCompetitorResearchOutputSchema(ozonReference);

    expect(prompt).toContain("исключительно внутри Ozon");
    expect(prompt).toContain(ozonReference.sourceUrl);
    expect(prompt).toContain("Wildberries");
    expect(prompt).toContain("не совпадает с исходным артикулом");
    expect(schema.properties.competitors.items.properties.sourceUrl.pattern)
      .toContain("ozon");
    expect(schema.properties.competitors.items.properties.sourceUrl.pattern)
      .not.toContain("wildberries");
  });
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

  it("limits discovery and competitor evidence to verified Wildberries product cards", () => {
    const prompt = buildCompetitorResearchPrompt(reference);

    expect(prompt).toContain("исключительно внутри Wildberries");
    expect(prompt).toContain("Поисковые системы можно использовать только для обнаружения");
    expect(prompt).toContain("каноническую ссылку");
    expect(prompt).toContain("не совпадает с исходным артикулом");
    expect(prompt).toContain("Ozon");
    expect(prompt).toContain("Яндекс Маркета");
    expect(prompt).toContain("AliExpress");
    expect(prompt).toContain("верни меньше конкурентов");
    expect(prompt).toContain("similarities");
    expect(prompt).toContain("differences");
    expect(prompt).toContain("strengths");
    expect(prompt).toContain("weaknesses");
    expect(prompt).toContain("opportunity");
  });

  it("defines a strict source-verification-and-report output schema", () => {
    expect(COMPETITOR_RESEARCH_OUTPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["sourceVerification", "competitors", "summary", "report"],
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
        competitors: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "productId",
              "productTitle",
              "sourceUrl",
              "relevance",
              "evidence",
              "comparison",
            ],
            properties: {
              productId: { type: "string", pattern: "^[0-9]+$" },
              productTitle: { type: "string", minLength: 1 },
              sourceUrl: {
                type: "string",
                pattern:
                  "^https://www\\.wildberries\\.ru/catalog/[0-9]+/detail\\.aspx$",
              },
              relevance: { type: "string", minLength: 1 },
              evidence: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
              comparison: {
                type: "object",
                additionalProperties: false,
                required: [
                  "similarities",
                  "differences",
                  "strengths",
                  "weaknesses",
                  "opportunity",
                ],
                properties: {
                  similarities: {
                    type: "array",
                    maxItems: 4,
                    items: { type: "string", minLength: 1 },
                  },
                  differences: {
                    type: "array",
                    maxItems: 4,
                    items: { type: "string", minLength: 1 },
                  },
                  strengths: {
                    type: "array",
                    maxItems: 4,
                    items: { type: "string", minLength: 1 },
                  },
                  weaknesses: {
                    type: "array",
                    maxItems: 4,
                    items: { type: "string", minLength: 1 },
                  },
                  opportunity: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        summary: { type: "string", minLength: 1, maxLength: 2500 },
        report: { type: "string" },
      },
    });
  });
});

describe("parseCompetitorResearchOutput", () => {
  it("accepts only a separate canonical Ozon card for an Ozon source", () => {
    const ozonCompetitor = {
      ...validCompetitor(),
      productId: "1753638237",
      productTitle: "Кухонный шеф-нож для мяса",
      sourceUrl:
        "https://www.ozon.ru/product/kuhonnyy-shef-nozh-dlya-myasa-1753638237/",
      evidence: ["Карточка Ozon подтвердила SKU 1753638237."],
    };
    const sourceVerification = {
      ...verifiedSource(),
      requestedProductId: ozonReference.productId,
      resolvedProductId: ozonReference.productId,
      evidence: ["Карточка Ozon подтвердила SKU 3085863400."],
    };

    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification,
      competitors: [
        ozonCompetitor,
        { ...ozonCompetitor, productId: ozonReference.productId, sourceUrl: ozonReference.sourceUrl },
        { ...ozonCompetitor, sourceUrl: "https://www.wildberries.ru/catalog/1753638237/detail.aspx" },
      ],
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), ozonReference);

    expect(parsed.competitors).toEqual([ozonCompetitor]);
  });
  it("accepts a separate canonical Wildberries product card candidate", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: verifiedSource(),
      competitors: [validCompetitor()],
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(parsed.competitors).toEqual([validCompetitor()]);
  });

  it("drops unsupported commercial metrics and search-snippet claims from analysis", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: verifiedSource(),
      competitors: [{
        ...validCompetitor(),
        relevance: "Высокая релевантность, рейтинг 5.0 в поисковой выдаче.",
        comparison: {
          similarities: ["Та же категория."],
          differences: [
            "У конкурента 1404 отзыва и рейтинг 5.0 в поисковой выдаче.",
            "Материал отличается от исходной карточки.",
          ],
          strengths: [
            "У конкурента 10 фото и видео.",
            "Подарочная коробка указана в характеристиках карточки.",
          ],
          weaknesses: ["Цена конкурента подтверждена: 4 788 ₽."],
          opportunity: "Добавить понятную информацию о комплектации.",
        },
      }],
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(parsed.competitors[0]?.relevance).toContain("требуют ручной проверки");
    expect(parsed.competitors[0]?.comparison).toEqual({
      similarities: ["Та же категория."],
      differences: ["Материал отличается от исходной карточки."],
      strengths: ["Подарочная коробка указана в характеристиках карточки."],
      weaknesses: [],
      opportunity: "Добавить понятную информацию о комплектации.",
    });
  });

  it.each([
    "https://www.ozon.ru/product/987654321/",
    "https://market.yandex.ru/product--example/987654321",
    "https://manufacturer.example/products/987654321",
  ])("rejects an external product URL as a competitor: %s", (sourceUrl) => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: verifiedSource(),
      competitors: [{ ...validCompetitor(), sourceUrl }],
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(parsed.competitors).toEqual([]);
  });

  it("rejects the source article as its own competitor", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: verifiedSource(),
      competitors: [{
        ...validCompetitor(),
        productId: reference.productId,
        sourceUrl: reference.sourceUrl,
      }],
      summary: "Краткий вывод.",
      report: "Полный отчёт.",
    }), reference);

    expect(parsed.competitors).toEqual([]);
  });

  it("extracts a browser-verified structured summary and report", () => {
    const parsed = parseCompetitorResearchOutput(JSON.stringify({
      sourceVerification: verifiedSource(),
      summary: "  Краткий вывод.  ",
      report: "  Готовый отчёт.  ",
    }), reference);

    expect(parsed).toEqual({
      sourceVerification: verifiedSource(),
      competitors: [],
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
      competitors: [],
      summary: "Codex не вернул результат исследования конкурентов.",
      report: "",
    });
  });
});

describe("enforceVerifiedMarketplaceCompetitors", () => {
  const ozonSourceVerification = {
    status: "verified" as const,
    requestedProductId: ozonReference.productId,
    resolvedProductId: ozonReference.productId,
    productTitle: "Кухонный нож",
    brand: null,
    category: "Кухонные ножи",
    evidence: ["Карточка Ozon подтверждена."],
    failureReason: null,
  };
  const ozonCandidate = (productId: string) => ({
    productId,
    productTitle: `Нож ${productId}`,
    sourceUrl: `https://www.ozon.ru/product/nozh-${productId}/`,
    relevance: "Та же категория.",
    evidence: ["Карточка Ozon."],
    comparison: {
      similarities: ["Та же категория."],
      differences: [],
      strengths: [],
      weaknesses: [],
      opportunity: "Уточнить характеристики.",
    },
  });

  it("rejects an external URL returned by the marketplace verifier", async () => {
    const candidate = ozonCandidate("1753638237");
    const result = await enforceVerifiedMarketplaceCompetitors({
      sourceVerification: ozonSourceVerification,
      competitors: [candidate],
      summary: "До проверки.",
      report: "До проверки.",
    }, ozonReference, {
      verify: vi.fn(async () => ({
        productId: candidate.productId,
        productTitle: candidate.productTitle,
        brand: null,
        category: ozonSourceVerification.category,
        description: null,
        attributes: [],
        sourceUrl: "https://shop.example/products/1753638237",
      })),
      discover: vi.fn(async () => []),
    });

    expect(result.competitors).toEqual([]);
    expect(result.summary).not.toContain("shop.example");
    expect(result.report).not.toContain("shop.example");
  });

  it("verifies final Ozon candidates sequentially", async () => {
    const candidates = ["1753638237", "1753638238", "1753638239"]
      .map(ozonCandidate);
    let active = 0;
    let maxConcurrent = 0;
    const verify = vi.fn(async (candidate: typeof ozonReference) => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        productId: candidate.productId,
        productTitle: `Нож ${candidate.productId}`,
        brand: null,
        category: ozonSourceVerification.category,
        description: null,
        attributes: [],
        sourceUrl: candidate.sourceUrl,
      };
    });

    const result = await enforceVerifiedMarketplaceCompetitors({
      sourceVerification: ozonSourceVerification,
      competitors: candidates,
      summary: "До проверки.",
      report: "До проверки.",
    }, ozonReference, { verify, discover: vi.fn(async () => []) });

    expect(result.competitors).toHaveLength(3);
    expect(maxConcurrent).toBe(1);
  });
});

describe("competitor research presentation", () => {
  it("renders Ozon branding and links without presenting WB competitors", () => {
    const content = {
      sourceVerification: {
        ...verifiedSource(),
        requestedProductId: ozonReference.productId,
        resolvedProductId: ozonReference.productId,
        productTitle: "Кухонный нож для мяса",
      },
      competitors: [],
      summary: "Подтверждённых конкурентов пока нет.",
      report: "Ограничение: подтверждённых конкурентов пока нет.",
    };
    const telegram = renderTelegramResponse(
      buildCompetitorResearchTelegramResponse(content.summary, ozonReference),
    );
    const html = buildCompetitorResearchHtmlReport({
      ...content,
      reference: ozonReference,
      generatedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(telegram.messages.join("\n")).toContain("Конкурентный анализ Ozon");
    expect(html).toContain("Конкурентный анализ Ozon");
    expect(html).toContain(ozonReference.sourceUrl);
    expect(html).not.toContain("Карточка WB подтверждена");
    expect(buildCompetitorResearchReportFileName(ozonReference)).toBe(
      "ozon-competitor-report-3085863400.html",
    );
  });
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

  it("adds concise named links for verified competitors to Telegram", () => {
    const competitor = validCompetitor();
    const rendered = renderTelegramResponse(
      buildCompetitorResearchTelegramResponse(
        "Три вывода и три приоритетных действия.",
        reference,
        { reportDelivery: "html", competitors: [competitor] },
      ),
    );

    expect(rendered.messages[0]).toContain(
      `<a href="${competitor.sourceUrl}">1. ${competitor.productTitle} · ${competitor.productId}</a>`,
    );
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
    const unsafeCompetitor = {
      ...validCompetitor(),
      productTitle: "Конкурент <script>alert('title')</script>",
      comparison: {
        ...validCompetitor().comparison,
        strengths: ["<img src=x onerror=alert(1)>"],
      },
    };
    const html = buildCompetitorResearchHtmlReport({
      reference,
      sourceVerification: verifiedSource(),
      competitors: [unsafeCompetitor],
      summary: "Свободный summary не управляет HTML.",
      report: "Свободный report не управляет HTML.",
      generatedAt: "2026-08-18T15:30:00.000Z",
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Конкурентный анализ Wildberries");
    expect(html).toContain("123456789");
    expect(html).toContain("2026-08-18T15:30:00.000Z");
    expect(html).toContain("&lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("Свободный summary не управляет HTML.");
    expect(html).not.toContain("Свободный report не управляет HTML.");
    expect(html).toContain("<ul>");
    expect(html).toContain('<ol class="actions-list">');
    expect(html).toContain(
      'href="https://www.wildberries.ru/catalog/987654321/detail.aspx"',
    );
    expect(html).toContain("Content-Security-Policy");
  });

  it("renders a decision-oriented report with semantic competitor cards", () => {
    const competitors = [
      {
        ...validCompetitor(),
        comparison: {
          ...validCompetitor().comparison,
          differences: [
            "Первое отличие первого конкурента.",
            "Второе отличие первого конкурента не должно вытеснять остальных.",
          ],
        },
        brand: "Первый бренд",
        category: "Первая категория",
        attributes: [{ name: "Материал", value: "хлопок" }],
      },
      {
        ...validCompetitor(),
        productId: "555666777",
        productTitle: "Второй подтверждённый конкурент",
        sourceUrl: "https://www.wildberries.ru/catalog/555666777/detail.aspx",
        comparison: {
          ...validCompetitor().comparison,
          differences: ["Первое отличие второго конкурента."],
        },
      },
    ];
    const html = buildCompetitorResearchHtmlReport({
      reference,
      sourceVerification: {
        ...verifiedSource(),
        category: "Исходная категория",
        attributes: [
          { name: "Материал изделия", value: "сталь" },
          { name: "Комплектация", value: "1 предмет" },
        ],
      },
      competitors,
      summary: [
        "Подтверждённые конкуренты Wildberries: 2 из 5.",
        "Ключевые выводы:",
        "- Комплектации конкурентов описаны точнее.",
        "Приоритетные действия:",
        "1. Добавить размеры на первый экран.",
      ].join("\n"),
      report: "Этот свободный текст не должен определять структуру HTML.",
      generatedAt: "2026-08-24T13:05:00.000Z",
    });

    expect(html).toContain("2 карточки WB подтверждены");
    expect(html.match(/class="competitor-card"/gu)).toHaveLength(2);
    expect(html).toContain("Обзор конкурентов");
    expect(html).toContain("<table");
    expect(html).toContain("Исходная категория");
    expect(html).toContain("Материал изделия");
    expect(html).toContain("сталь");
    expect(html).toContain("Аналитический вывод");
    expect(html).toContain('class="comparison-details"');
    expect(html).toContain("Сходства");
    expect(html).toContain("Отличия");
    expect(html).toContain("Сильные стороны");
    expect(html).toContain("Риски и слабые места");
    expect(html).toContain("Возможность для исходной карточки");
    expect(html).toContain(
      ">Открыть «Подтверждённый конкурент» на WB</a>",
    );
    expect(html).not.toContain(">Открыть карточку WB</a>");
    expect(html).toContain("Первое отличие первого конкурента.");
    expect(html).toContain("Первое отличие второго конкурента.");
    expect(html).not.toContain(
      "Второе отличие первого конкурента не должно вытеснять остальных.</li><li>",
    );
    expect(html).toContain(
      "Подтверждение карточки не означает автоматического подтверждения аналитических выводов.",
    );
    expect(html).toContain("24.08.2026, 13:05 UTC");
    expect(html).not.toContain("2026-08-24T13:05:00.000Z</time>");
    expect(html).not.toContain("Этот свободный текст не должен определять структуру HTML.");
  });

  it("builds a stable report filename", () => {
    expect(buildCompetitorResearchReportFileName(reference)).toBe(
      "wb-competitor-report-123456789.html",
    );
  });
});
