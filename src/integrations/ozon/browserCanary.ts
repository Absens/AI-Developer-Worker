import type { Page } from "playwright-core";

import { hasExactOzonPrimaryProduct } from "./sessionState.js";

export interface OzonCanaryResult {
  status: number;
  widgetCount: number;
  productMatched: boolean;
  finalUrl: string;
}

export const verifyOzonCanaryPage = async (
  page: Page,
  canaryUrl: string,
  productId: string,
): Promise<OzonCanaryResult> => {
  const result = await page.evaluate(async ({ productPath }) => {
    const query = new URLSearchParams({ url: productPath });
    const response = await fetch(
      `/api/composer-api.bx/page/json/v2?${query.toString()}`,
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) {
      return {
        status: response.status,
        widgetCount: 0,
        finalUrl: location.href,
        structuredProducts: [] as unknown[],
      };
    }
    const payload = await response.json() as { widgetStates?: unknown };
    const widgetStates = payload.widgetStates && typeof payload.widgetStates === "object"
      ? payload.widgetStates as Record<string, unknown>
      : {};
    const structuredProducts: unknown[] = [];
    const maxJsonLdNodes = 100;
    const maxProducts = 20;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const source = script.textContent || "null";
        if (source.length > 256 * 1024) continue;
        const parsed = JSON.parse(source) as unknown;
        const queue = Array.isArray(parsed)
          ? parsed.slice(0, maxJsonLdNodes)
          : [parsed];
        for (let index = 0;
          index < queue.length && index < maxJsonLdNodes;
          index += 1) {
          const item = queue[index];
          if (item && typeof item === "object") {
            const record = item as Record<string, unknown>;
            if (Array.isArray(record["@graph"])) {
              const remaining = Math.max(0, maxJsonLdNodes - queue.length);
              queue.push(...record["@graph"].slice(0, remaining));
            }
            if (record["@type"] === "Product" && structuredProducts.length < maxProducts) {
              structuredProducts.push({
                "@type": "Product",
                sku: record.sku,
              });
            }
          }
        }
      } catch {
        // Ignore malformed third-party JSON-LD blocks; the exact Product is required below.
      }
    }
    return {
      status: response.status,
      widgetCount: Object.keys(widgetStates).length,
      finalUrl: location.href,
      structuredProducts,
    };
  }, {
    productPath: new URL(canaryUrl).pathname,
  });

  return {
    status: result.status,
    widgetCount: result.widgetCount,
    finalUrl: result.finalUrl,
    productMatched: hasExactOzonPrimaryProduct(
      result.finalUrl,
      result.structuredProducts,
      canaryUrl,
      productId,
    ),
  };
};
