import type {
  VerifiedWildberriesProduct,
  WildberriesProductDiscoveryPort,
} from "../../domain/telegramAssistant/competitorResearch.js";

const SEARCH_ENDPOINT =
  "https://search.wb.ru/exactmatch/ru/common/v18/search";
const PRODUCT_ID_PATTERN = /^\d{5,15}$/u;
const MAX_DISCOVERY_LIMIT = 20;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WildberriesCompetitorDiscoveryOptions {
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}

export class WildberriesCompetitorDiscovery
  implements WildberriesProductDiscoveryPort {
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;

  public constructor(options: WildberriesCompetitorDiscoveryOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  }

  public async discover(
    sourceProduct: VerifiedWildberriesProduct,
    limit: number,
  ): Promise<string[]> {
    const boundedLimit = Math.min(
      MAX_DISCOVERY_LIMIT,
      Math.max(1, Math.floor(limit)),
    );
    const query = sourceProduct.category?.trim() || sourceProduct.productTitle.trim();
    if (!query) {
      return [];
    }

    try {
      const response = await this.fetchSearch(query);
      if (!isRecord(response) || !Array.isArray(response.products)) {
        return [];
      }
      const productIds: string[] = [];
      for (const item of response.products) {
        if (!isRecord(item)) {
          continue;
        }
        const productId = normalizeProductId(item.id);
        if (
          !productId ||
          productId === sourceProduct.productId ||
          productIds.includes(productId)
        ) {
          continue;
        }
        productIds.push(productId);
        if (productIds.length >= boundedLimit) {
          break;
        }
      }
      return productIds;
    } catch {
      return [];
    }
  }

  private async fetchSearch(query: string): Promise<unknown> {
    const url = new URL(SEARCH_ENDPOINT);
    url.search = new URLSearchParams({
      ab_testing: "false",
      appType: "1",
      curr: "rub",
      dest: "-1257786",
      query,
      resultset: "catalog",
      sort: "popular",
      spp: "30",
      suppressSpellcheck: "false",
    }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        return undefined;
      }
      return await response.json() as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}

const normalizeProductId = (value: unknown): string => {
  const normalized = typeof value === "number"
    ? String(value)
    : typeof value === "string"
    ? value.trim()
    : "";
  return PRODUCT_ID_PATTERN.test(normalized) ? normalized : "";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
