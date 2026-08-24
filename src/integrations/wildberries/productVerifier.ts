import type {
  VerifiedWildberriesProduct,
  WildberriesProductVerifierPort,
} from "../../domain/telegramAssistant/competitorResearch.js";

const UPSTREAMS_URL = "https://cdn.wbbasket.ru/api/v3/upstreams";
const PRODUCT_ID_PATTERN = /^\d{5,15}$/u;
const MEDIA_BASKET_HOST_PATTERN = /^basket-\d{2}\.wbbasket\.ru$/u;
const MAX_DESCRIPTION_CHARS = 5_000;
const MAX_ATTRIBUTES = 30;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WildberriesProductVerifierOptions {
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}

export class WildberriesProductVerifier
  implements WildberriesProductVerifierPort {
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;

  public constructor(options: WildberriesProductVerifierOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  }

  public async verify(
    productId: string,
  ): Promise<VerifiedWildberriesProduct | undefined> {
    const normalizedProductId = productId.trim();
    if (!PRODUCT_ID_PATTERN.test(normalizedProductId)) {
      return undefined;
    }

    const numericProductId = Number(normalizedProductId);
    if (!Number.isSafeInteger(numericProductId) || numericProductId <= 0) {
      return undefined;
    }

    try {
      const upstreams = await this.fetchJson(UPSTREAMS_URL);
      const volume = Math.floor(numericProductId / 100_000);
      const host = resolveMediaBasketHost(upstreams, volume);
      if (!host) {
        return undefined;
      }

      const part = Math.floor(numericProductId / 1_000);
      const sourceUrl =
        `https://${host}/vol${volume}/part${part}/${normalizedProductId}/info/ru/card.json`;
      const card = await this.fetchJson(sourceUrl);
      return normalizeCard(card, normalizedProductId, sourceUrl);
    } catch {
      return undefined;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
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
        throw new Error(`Wildberries CDN returned HTTP ${response.status}.`);
      }
      return await response.json() as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}

const resolveMediaBasketHost = (
  value: unknown,
  volume: number,
): string | undefined => {
  if (!isRecord(value) || !isRecord(value.origin)) {
    return undefined;
  }
  const routeMap = value.origin.mediabasket_route_map;
  if (!Array.isArray(routeMap)) {
    return undefined;
  }

  for (const route of routeMap) {
    if (!isRecord(route) || route.method !== "range" || !Array.isArray(route.hosts)) {
      continue;
    }
    for (const candidate of route.hosts) {
      if (!isRecord(candidate)) {
        continue;
      }
      const from = candidate.vol_range_from;
      const to = candidate.vol_range_to;
      const host = candidate.host;
      if (
        typeof from === "number" && Number.isInteger(from) &&
        typeof to === "number" && Number.isInteger(to) &&
        typeof host === "string" && MEDIA_BASKET_HOST_PATTERN.test(host) &&
        volume >= from && volume <= to
      ) {
        return host;
      }
    }
  }

  return undefined;
};

const normalizeCard = (
  value: unknown,
  productId: string,
  sourceUrl: string,
): VerifiedWildberriesProduct | undefined => {
  if (!isRecord(value) || String(value.nm_id) !== productId) {
    return undefined;
  }

  const productTitle = normalizedString(value.imt_name, 500);
  if (!productTitle) {
    return undefined;
  }

  const selling = isRecord(value.selling) ? value.selling : undefined;
  const options = Array.isArray(value.options) ? value.options : [];
  const attributes = options
    .flatMap((option) => {
      if (!isRecord(option)) {
        return [];
      }
      const name = normalizedString(option.name, 300);
      const attributeValue = normalizedString(option.value, 1_000);
      return name && attributeValue ? [{ name, value: attributeValue }] : [];
    })
    .slice(0, MAX_ATTRIBUTES);

  return {
    productId,
    productTitle,
    brand: normalizedString(selling?.brand_name, 300),
    category: normalizedString(value.subj_name, 300),
    description: normalizedString(value.description, MAX_DESCRIPTION_CHARS),
    attributes,
    sourceUrl,
  };
};

const normalizedString = (
  value: unknown,
  maxChars: number,
): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
