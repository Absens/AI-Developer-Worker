import { describe, expect, it, vi } from "vitest";

import {
  createOzonResearchHttpInspector,
  maxOzonInspectionResponseBytes,
  OzonProductResearch,
  type OzonProductPageInspection,
} from "../src/integrations/ozon/productResearch.js";

const sourceReference = {
  marketplace: "ozon" as const,
  productId: "3085863400",
  sourceUrl:
    "https://www.ozon.ru/product/kuhonnyy-nozh-dlya-myasa-1-sht-lezvie-33-sm-vysokouglerodistaya-stal-3085863400/",
};

const sourceInspection: OzonProductPageInspection = {
  finalUrl: sourceReference.sourceUrl,
  structuredProducts: [{
    "@type": "Product",
    sku: sourceReference.productId,
    name: "Кухонный нож для мяса",
    brand: "",
    description: "Косторез из высокоуглеродистой стали.",
    offers: { url: sourceReference.sourceUrl },
  }],
  breadcrumbs: ["Дом и сад", "Кухонные ножи"],
  attributes: [
    { name: "Тип", value: "Кухонный нож" },
    { name: "Материал лезвия", value: "Высокоуглеродистая сталь" },
  ],
  productLinks: [
    {
      marketplace: "ozon",
      productId: "1753638237",
      productTitle: "Кухонный шеф-нож для мяса",
      sourceUrl:
        "https://www.ozon.ru/product/kuhonnyy-shef-nozh-dlya-myasa-1753638237/",
    },
    {
      marketplace: "ozon",
      productId: sourceReference.productId,
      productTitle: "Исходный товар",
      sourceUrl: sourceReference.sourceUrl,
    },
  ],
};

describe("OzonProductResearch", () => {
  it("accepts only bounded inspection payloads from the research broker", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sourceInspection), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const inspect = createOzonResearchHttpInspector({
      baseUrl: "http://ozon-research:8933",
      fetchImpl,
    });

    await expect(inspect(sourceReference.sourceUrl)).resolves.toEqual(sourceInspection);
    await expect(inspect("https://shop.example/product/3085863400"))
      .resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized broker response", async () => {
    const inspect = createOzonResearchHttpInspector({
      baseUrl: "http://ozon-research:8933",
      fetchImpl: async () => new Response(
        "x".repeat(maxOzonInspectionResponseBytes + 1),
        { status: 200 },
      ),
    });

    await expect(inspect(sourceReference.sourceUrl)).resolves.toBeUndefined();
  });

  it("uses a bounded Playwright MCP session and parses JSON-LD inspection output", async () => {
    const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      requests.push({ method, ...(body ? { body } : {}) });
      if (method === "DELETE") {
        return new Response("", { status: 200 });
      }
      if (body?.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const id = body?.id;
      const params = body?.params as Record<string, unknown> | undefined;
      const toolName = params?.name;
      const result = body?.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "Playwright", version: "test" },
          }
        : {
            content: toolName === "browser_evaluate"
              ? [{
                  type: "text",
                  text: `### Result\n${JSON.stringify(JSON.stringify(sourceInspection))}\n### Ran Playwright code`,
                }]
              : [],
          };
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            ...(body?.method === "initialize"
              ? { "mcp-session-id": "session-1" }
              : {}),
          },
        },
      );
    });
    const research = new OzonProductResearch({
      mcpUrl: "http://playwright:8931/mcp",
      fetchImpl,
    });

    await expect(research.verify(sourceReference)).resolves.toEqual(
      expect.objectContaining({
        productId: sourceReference.productId,
        productTitle: "Кухонный нож для мяса",
      }),
    );
    expect(requests.map((request) => request.body?.method ?? request.method))
      .toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
        "tools/call",
        "tools/call",
        "DELETE",
      ]);
    expect(
      requests
        .filter((request) => request.body?.method === "tools/call")
        .map((request) =>
          (request.body?.params as Record<string, unknown>).name
        ),
    ).toEqual(["browser_navigate", "browser_wait_for", "browser_evaluate"]);
  });

  it("verifies the exact Ozon SKU from the product card and exposes same-site candidates", async () => {
    const inspect = vi.fn(async () => sourceInspection);
    const research = new OzonProductResearch({ inspect });

    await expect(research.verify(sourceReference)).resolves.toEqual({
      productId: sourceReference.productId,
      productTitle: "Кухонный нож для мяса",
      brand: null,
      category: "Кухонные ножи",
      description: "Косторез из высокоуглеродистой стали.",
      attributes: sourceInspection.attributes,
      sourceUrl: sourceReference.sourceUrl,
    });
    await expect(research.discover(sourceReference, {
      productId: sourceReference.productId,
      productTitle: "Кухонный нож для мяса",
      brand: null,
      category: "Кухонные ножи",
      description: null,
      attributes: [],
      sourceUrl: sourceReference.sourceUrl,
    }, 10)).resolves.toEqual([
      sourceInspection.productLinks[0],
    ]);
  });

  it.each([
    { ...sourceInspection, finalUrl: "https://www.ozon.ru/search/?text=nozh" },
    { ...sourceInspection, structuredProducts: [{ ...sourceInspection.structuredProducts[0], sku: "9999999999" }] },
    { ...sourceInspection, structuredProducts: [] },
  ])("fails closed when the page does not confirm the exact card", async (inspection) => {
    const research = new OzonProductResearch({ inspect: vi.fn(async () => inspection) });

    await expect(research.verify(sourceReference)).resolves.toBeUndefined();
  });

  it("retries inspection after a temporary undefined result", async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(sourceInspection);
    const research = new OzonProductResearch({ inspect });

    await expect(research.verify(sourceReference)).resolves.toBeUndefined();
    await expect(research.verify(sourceReference)).resolves.toEqual(
      expect.objectContaining({ productId: sourceReference.productId }),
    );
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("retries inspection after a temporary rejection", async () => {
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error("temporary MCP failure"))
      .mockResolvedValueOnce(sourceInspection);
    const research = new OzonProductResearch({ inspect });

    await expect(research.verify(sourceReference)).resolves.toBeUndefined();
    await expect(research.verify(sourceReference)).resolves.toEqual(
      expect.objectContaining({ productId: sourceReference.productId }),
    );
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("refreshes a successful inspection after its bounded cache TTL", async () => {
    const inspect = vi.fn(async () => sourceInspection);
    const research = new OzonProductResearch({ inspect, cacheTtlMs: 5 });

    await research.verify(sourceReference);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await research.verify(sourceReference);

    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
