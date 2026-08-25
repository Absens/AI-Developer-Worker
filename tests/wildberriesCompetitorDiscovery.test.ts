import { describe, expect, it, vi } from "vitest";

import { WildberriesCompetitorDiscovery } from "../src/integrations/wildberries/competitorDiscovery.js";

const sourceProduct = {
  productId: "206021830",
  productTitle: "Подстаканник никелированный Танк",
  brand: "Мои Подарки",
  category: "Подстаканники",
  description: "Подарочный подстаканник.",
  attributes: [],
  sourceUrl: "https://basket-14.wbbasket.ru/source-card.json",
};

describe("WildberriesCompetitorDiscovery", () => {
  it("discovers bounded numeric product ids through the Wildberries catalog", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://search.wb.ru");
      expect(url.pathname).toBe("/exactmatch/ru/common/v18/search");
      expect(url.searchParams.get("query")).toBe(sourceProduct.category);
      return Response.json({
        products: [
          { id: Number(sourceProduct.productId), name: sourceProduct.productTitle },
          { id: 765001988, name: "Два подстаканника" },
          { id: "765001988", name: "Дубликат" },
          { id: 64959402, name: "Набор для чая" },
          { id: "not-an-id", name: "Некорректный товар" },
        ],
      });
    });
    const discovery = new WildberriesCompetitorDiscovery({ fetchImpl });

    await expect(discovery.discover(sourceProduct, 2)).resolves.toEqual([
      "765001988",
      "64959402",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the verified title when category is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get("query")).toBe(
        sourceProduct.productTitle,
      );
      return Response.json({ products: [] });
    });
    const discovery = new WildberriesCompetitorDiscovery({ fetchImpl });

    await expect(discovery.discover({
      ...sourceProduct,
      category: null,
    }, 5)).resolves.toEqual([]);
  });

  it("fails closed for an invalid or unavailable catalog response", async () => {
    const invalidDiscovery = new WildberriesCompetitorDiscovery({
      fetchImpl: vi.fn(async () => Response.json({ products: "invalid" })),
    });
    const failedDiscovery = new WildberriesCompetitorDiscovery({
      fetchImpl: vi.fn(async () => {
        throw new Error("Wildberries search unavailable");
      }),
    });

    await expect(invalidDiscovery.discover(sourceProduct, 5)).resolves.toEqual([]);
    await expect(failedDiscovery.discover(sourceProduct, 5)).resolves.toEqual([]);
  });
});
