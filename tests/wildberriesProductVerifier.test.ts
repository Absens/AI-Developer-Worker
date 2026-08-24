import { describe, expect, it, vi } from "vitest";

import { WildberriesProductVerifier } from "../src/integrations/wildberries/productVerifier.js";

const productId = "74801352";
const cardUrl =
  "https://basket-05.wbbasket.ru/vol748/part74801/74801352/info/ru/card.json";

const upstreamsResponse = {
  origin: {
    mediabasket_route_map: [
      {
        method: "range",
        hosts: [
          {
            vol_range_from: 720,
            vol_range_to: 1007,
            host: "basket-05.wbbasket.ru",
          },
        ],
      },
    ],
  },
};

describe("WildberriesProductVerifier", () => {
  it("resolves the current CDN shard and verifies an arbitrary product card", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://cdn.wbbasket.ru/api/v3/upstreams") {
        return Response.json(upstreamsResponse);
      }
      if (url === cardUrl) {
        return Response.json({
          nm_id: 74801352,
          imt_name: "Футболка",
          subj_name: "Футболки",
          description: "Мужская хлопковая футболка.",
          selling: {
            brand_name: "Мои подарки",
            supplier_id: 97764,
          },
          options: [
            { name: "Состав", value: "хлопок" },
            { name: "Пол", value: "Мужской" },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const verifier = new WildberriesProductVerifier({ fetchImpl });

    await expect(verifier.verify(productId)).resolves.toEqual({
      productId,
      productTitle: "Футболка",
      brand: "Мои подарки",
      category: "Футболки",
      description: "Мужская хлопковая футболка.",
      attributes: [
        { name: "Состав", value: "хлопок" },
        { name: "Пол", value: "Мужской" },
      ],
      sourceUrl: cardUrl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed when CDN payload resolves to another product", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url === "https://cdn.wbbasket.ru/api/v3/upstreams"
        ? Response.json(upstreamsResponse)
        : Response.json({ nm_id: 99999999, imt_name: "Другой товар" });
    });
    const verifier = new WildberriesProductVerifier({ fetchImpl });

    await expect(verifier.verify(productId)).resolves.toBeUndefined();
  });

  it("does not follow an untrusted host from the upstream map", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      origin: {
        mediabasket_route_map: [{
          method: "range",
          hosts: [{
            vol_range_from: 720,
            vol_range_to: 1007,
            host: "attacker.example",
          }],
        }],
      },
    }));
    const verifier = new WildberriesProductVerifier({ fetchImpl });

    await expect(verifier.verify(productId)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
