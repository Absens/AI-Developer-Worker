import {
  extractOzonProductReference,
  type MarketplaceProductReference,
  type MarketplaceProductResearchPort,
  type OzonProductReference,
  type VerifiedMarketplaceProduct,
} from "../../domain/telegramAssistant/competitorResearch.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_ATTRIBUTES = 30;
const MAX_DESCRIPTION_CHARS = 5_000;
const MAX_DISCOVERY_LIMIT = 20;
const MAX_INSPECTION_LINKS = 50;
const MAX_INSPECTION_PRODUCTS = 5;
const MAX_INSPECTION_RESPONSE_BYTES = 256 * 1024;
const MAX_INSPECTION_STRING_CHARS = 1_000;
const DEFAULT_INSPECTION_CACHE_TTL_MS = 60_000;

type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OzonResearchHttpInspectorOptions {
  baseUrl: string;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}

export interface OzonProductLink extends OzonProductReference {
  productTitle: string;
}

export interface OzonProductPageInspection {
  finalUrl: string;
  structuredProducts: Array<Record<string, unknown>>;
  breadcrumbs: string[];
  attributes: Array<{ name: string; value: string }>;
  productLinks: OzonProductLink[];
}

export interface OzonProductResearchOptions {
  inspect?: (url: string) => Promise<OzonProductPageInspection | undefined>;
  mcpUrl?: string;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

interface InspectionCacheEntry {
  promise: Promise<OzonProductPageInspection | undefined>;
  expiresAt: number;
}

export class OzonProductResearch implements MarketplaceProductResearchPort {
  private readonly inspectPage: (
    url: string,
    deadlineAt?: number,
  ) => Promise<OzonProductPageInspection | undefined>;
  private readonly inspectionCache = new Map<
    string,
    InspectionCacheEntry
  >();
  private readonly cacheTtlMs: number;

  public constructor(options: OzonProductResearchOptions) {
    this.cacheTtlMs = Math.max(
      0,
      options.cacheTtlMs ?? DEFAULT_INSPECTION_CACHE_TTL_MS,
    );
    if (options.inspect) {
      this.inspectPage = options.inspect;
      return;
    }
    if (!options.mcpUrl) {
      throw new Error("Ozon product research requires mcpUrl or inspect.");
    }
    const inspector = new PlaywrightMcpOzonInspector({
      mcpUrl: options.mcpUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    this.inspectPage = (url, deadlineAt) => inspector.inspect(url, deadlineAt);
  }

  public async verify(
    reference: MarketplaceProductReference,
    deadlineAt?: number,
  ): Promise<VerifiedMarketplaceProduct | undefined> {
    if (reference.marketplace !== "ozon") {
      return undefined;
    }
    const inspection = await this.inspect(reference.sourceUrl, deadlineAt)
      .catch(() => undefined);
    if (!inspection) {
      return undefined;
    }
    const finalReference = extractOzonProductReference(inspection.finalUrl);
    if (
      !finalReference ||
      finalReference.productId !== reference.productId
    ) {
      return undefined;
    }
    const structuredProduct = inspection.structuredProducts.find((candidate) =>
      normalizeString(candidate["@type"]) === "Product" &&
      normalizeString(candidate.sku) === reference.productId
    );
    if (!structuredProduct) {
      return undefined;
    }
    const offerUrl = extractOfferUrl(structuredProduct.offers);
    const offerReference = offerUrl
      ? extractOzonProductReference(offerUrl)
      : undefined;
    const productTitle = normalizeString(structuredProduct.name);
    if (
      !offerReference ||
      offerReference.productId !== reference.productId ||
      offerReference.sourceUrl !== finalReference.sourceUrl ||
      !productTitle
    ) {
      return undefined;
    }
    return {
      productId: reference.productId,
      productTitle,
      brand: extractBrand(structuredProduct.brand),
      category: inspection.breadcrumbs.at(-1) ?? null,
      description: normalizeString(structuredProduct.description)
        .slice(0, MAX_DESCRIPTION_CHARS) || null,
      attributes: normalizeAttributes(inspection.attributes),
      sourceUrl: finalReference.sourceUrl,
    };
  }

  public async discover(
    reference: MarketplaceProductReference,
    _sourceProduct: VerifiedMarketplaceProduct,
    limit: number,
    deadlineAt?: number,
  ): Promise<MarketplaceProductReference[]> {
    if (reference.marketplace !== "ozon") {
      return [];
    }
    const inspection = await this.inspect(reference.sourceUrl, deadlineAt)
      .catch(() => undefined);
    if (!inspection) {
      return [];
    }
    const boundedLimit = Math.max(0, Math.min(limit, MAX_DISCOVERY_LIMIT));
    const seen = new Set<string>([reference.productId]);
    const products: OzonProductLink[] = [];
    for (const link of inspection.productLinks) {
      const parsed = extractOzonProductReference(link.sourceUrl);
      if (
        !parsed ||
        parsed.productId !== link.productId ||
        seen.has(parsed.productId)
      ) {
        continue;
      }
      seen.add(parsed.productId);
      products.push({
        ...parsed,
        productTitle: link.productTitle,
      });
      if (products.length >= boundedLimit) {
        break;
      }
    }
    return products;
  }

  private inspect(
    url: string,
    deadlineAt?: number,
  ): Promise<OzonProductPageInspection | undefined> {
    const now = Date.now();
    const cached = this.inspectionCache.get(url);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }
    if (cached) {
      this.inspectionCache.delete(url);
    }
    const inspection = this.inspectPage(url, deadlineAt);
    const entry: InspectionCacheEntry = {
      promise: inspection,
      expiresAt: now + this.cacheTtlMs,
    };
    this.inspectionCache.set(url, entry);
    void inspection.then(
      (value) => {
        if (this.inspectionCache.get(url)?.promise !== inspection) {
          return;
        }
        if (!value || this.cacheTtlMs === 0) {
          this.inspectionCache.delete(url);
          return;
        }
        entry.expiresAt = Date.now() + this.cacheTtlMs;
      },
      () => {
        if (this.inspectionCache.get(url)?.promise === inspection) {
          this.inspectionCache.delete(url);
        }
      },
    );
    return inspection;
  }
}

interface PlaywrightMcpOzonInspectorOptions {
  mcpUrl: string;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}

export class PlaywrightMcpOzonInspector {
  private readonly mcpUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;

  public constructor(options: PlaywrightMcpOzonInspectorOptions) {
    this.mcpUrl = normalizeMcpUrl(options.mcpUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 45_000);
  }

  public async inspect(
    url: string,
    deadlineAt?: number,
  ): Promise<OzonProductPageInspection | undefined> {
    if (!extractOzonProductReference(url)) {
      return undefined;
    }
    const session = new McpSession(
      this.mcpUrl,
      this.fetchImpl,
      Math.min(
        Date.now() + this.timeoutMs,
        deadlineAt ?? Number.POSITIVE_INFINITY,
      ),
    );
    try {
      await session.initialize();
      await session.callTool("browser_navigate", { url });
      await session.callTool("browser_wait_for", { time: 3 });
      const result = await session.callTool("browser_evaluate", {
        function: OZON_INSPECTION_FUNCTION,
      });
      return parseInspectionToolResult(result);
    } catch {
      return undefined;
    } finally {
      await session.close();
    }
  }
}

export const createOzonResearchHttpInspector = (
  options: OzonResearchHttpInspectorOptions,
): ((url: string, deadlineAt?: number) => Promise<OzonProductPageInspection | undefined>) => {
  const baseUrl = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("Ozon research URL must be HTTP(S) without embedded credentials.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 45_000);
  return async (url, deadlineAt) => {
    if (!extractOzonProductReference(url)) {
      return undefined;
    }
    const remaining = Math.max(1, Math.min(
      timeoutMs,
      (deadlineAt ?? Date.now() + timeoutMs) - Date.now(),
    ));
    try {
      const response = await fetchImpl(new URL("/inspect", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok) {
        return undefined;
      }
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_INSPECTION_RESPONSE_BYTES) {
        return undefined;
      }
      return normalizeInspectionPayload(JSON.parse(body) as unknown);
    } catch {
      return undefined;
    }
  };
};

class McpSession {
  private sessionId?: string;
  private nextId = 1;

  public constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchImplementation,
    private readonly deadlineAt: number,
  ) {}

  public async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ai-developer-worker-ozon", version: "1.0.0" },
    });
    await this.notify("notifications/initialized");
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.request("tools/call", {
      name,
      arguments: args,
    });
    if (isRecord(response) && response.isError === true) {
      throw new Error(`Playwright MCP tool ${name} failed.`);
    }
    return response;
  }

  public async close(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    const remainingTimeoutMs = Math.floor(this.deadlineAt - Date.now());
    if (remainingTimeoutMs <= 0) {
      return;
    }
    await this.fetchImpl(this.url, {
      method: "DELETE",
      headers: {
        "mcp-session-id": this.sessionId,
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      signal: AbortSignal.timeout(remainingTimeoutMs),
    }).catch(() => undefined);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.send({ jsonrpc: "2.0", id, method, params });
    if (!isRecord(response) || response.id !== id) {
      throw new Error(`Playwright MCP returned an invalid ${method} response.`);
    }
    if (response.error !== undefined) {
      throw new Error(`Playwright MCP ${method} returned an error.`);
    }
    return response.result;
  }

  private async notify(method: string): Promise<void> {
    await this.send({ jsonrpc: "2.0", method });
  }

  private async send(payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId
          ? {
              "mcp-session-id": this.sessionId,
              "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.remainingTimeoutMs()),
    });
    const receivedSessionId = response.headers.get("mcp-session-id");
    if (!this.sessionId && receivedSessionId) {
      this.sessionId = receivedSessionId;
    }
    if (!response.ok) {
      throw new Error(`Playwright MCP returned HTTP ${response.status}.`);
    }
    const body = await response.text();
    if (!body.trim()) {
      return undefined;
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const dataLines = body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      for (const data of dataLines.reverse()) {
        try {
          return JSON.parse(data) as unknown;
        } catch {
          continue;
        }
      }
      throw new Error("Playwright MCP returned invalid event data.");
    }
    return JSON.parse(body) as unknown;
  }

  private remainingTimeoutMs(): number {
    const remaining = Math.floor(this.deadlineAt - Date.now());
    if (remaining <= 0) {
      throw new Error("Playwright MCP deadline exceeded.");
    }
    return remaining;
  }
}

const OZON_INSPECTION_FUNCTION = `() => {
  const structuredProducts = [];
  let structuredBreadcrumbs = [];
  const clip = (value, limit = 1000) => typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().slice(0, limit)
    : '';
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(script.textContent || 'null');
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (item && item['@graph'] && Array.isArray(item['@graph'])) values.push(...item['@graph']);
        if (item && item['@type'] === 'Product' && structuredProducts.length < 5) {
          const brand = typeof item.brand === 'string'
            ? clip(item.brand, 300)
            : item.brand && { name: clip(item.brand.name, 300) };
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          structuredProducts.push({
            '@type': 'Product',
            sku: clip(item.sku, 30),
            name: clip(item.name, 500),
            brand,
            description: clip(item.description, 5000),
            offers: offer && { url: clip(offer.url, 1000) },
          });
        }
        if (item && item['@type'] === 'BreadcrumbList' && Array.isArray(item.itemListElement)) {
          structuredBreadcrumbs = item.itemListElement.slice(0, 8).map((entry) => clip(entry && entry.item && entry.item.name || entry && entry.name || '', 300)).filter(Boolean);
        }
      }
    } catch {}
  }
  const heading = document.querySelector('h1');
  const categoryAnchors = Array.from(document.querySelectorAll('a[href*="/category/"]'))
    .filter((anchor) => !heading || Boolean(anchor.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING));
  const breadcrumbs = structuredBreadcrumbs.length > 0
    ? structuredBreadcrumbs
    : categoryAnchors.slice(-4).map((anchor) => (anchor.textContent || '').trim()).filter(Boolean);
  const attributes = Array.from(document.querySelectorAll('dt')).slice(0, 30).map((term) => ({
    name: clip(term.textContent || '', 300),
    value: clip(term.nextElementSibling && term.nextElementSibling.textContent || '', 1000),
  })).filter((item) => item.name && item.value);
  const links = new Map();
  for (const anchor of document.querySelectorAll('a[href*="/product/"]')) {
    try {
      const candidate = new URL(anchor.href, location.href);
      const match = candidate.pathname.match(/^\\/product\\/([a-z0-9-]+)-(\\d{5,15})\\/?$/i);
      if (!match) continue;
      const productId = match[2];
      const title = clip(anchor.textContent || anchor.getAttribute('aria-label') || '', 500);
      const current = links.get(productId);
      if (!current || (!current.productTitle && title)) {
        links.set(productId, {
          marketplace: 'ozon',
          productId,
          productTitle: title,
          sourceUrl: 'https://www.ozon.ru/product/' + match[1].toLowerCase() + '-' + productId + '/',
        });
      }
      if (links.size >= 50) break;
    } catch {}
  }
  return JSON.stringify({
    finalUrl: location.href,
    structuredProducts,
    breadcrumbs: breadcrumbs.slice(0, 8),
    attributes,
    productLinks: Array.from(links.values()).slice(0, 50),
  });
}`;

const parseInspectionToolResult = (
  value: unknown,
): OzonProductPageInspection | undefined => {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return undefined;
  }
  const text = value.content
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const parsed = parseEmbeddedJson(text);
  if (!isRecord(parsed)) {
    return undefined;
  }
  return normalizeInspectionPayload(parsed);
};

const normalizeInspectionPayload = (
  parsed: unknown,
): OzonProductPageInspection | undefined => {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const finalUrl = normalizeString(parsed.finalUrl);
  if (!finalUrl) {
    return undefined;
  }
  return {
    finalUrl,
    structuredProducts: Array.isArray(parsed.structuredProducts)
      ? parsed.structuredProducts
          .filter(isRecord)
          .slice(0, MAX_INSPECTION_PRODUCTS)
          .map(normalizeStructuredProduct)
      : [],
    breadcrumbs: normalizeStringArray(parsed.breadcrumbs),
    attributes: normalizeAttributes(parsed.attributes),
    productLinks: normalizeProductLinks(parsed.productLinks),
  };
};

const parseEmbeddedJson = (value: string): unknown => {
  const candidates = [value.trim()];
  const resultSection = value.match(/### Result\s*([\s\S]*?)(?:\r?\n###|$)/iu)?.[1];
  if (resultSection) {
    candidates.push(resultSection.trim());
  }
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  if (fenced) {
    candidates.push(fenced.trim());
  }
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(value.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed) as unknown;
        } catch {
          continue;
        }
      }
      return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
};

const normalizeProductLinks = (value: unknown): OzonProductLink[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const links: OzonProductLink[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const sourceUrl = normalizeString(item.sourceUrl);
    const reference = extractOzonProductReference(sourceUrl);
    const productId = normalizeString(item.productId);
    if (!reference || reference.productId !== productId || seen.has(productId)) {
      continue;
    }
    seen.add(productId);
    links.push({
      ...reference,
      productTitle: normalizeString(item.productTitle).slice(0, 500),
    });
    if (links.length >= MAX_INSPECTION_LINKS) {
      break;
    }
  }
  return links;
};

const normalizeAttributes = (
  value: unknown,
): Array<{ name: string; value: string }> => {
  if (!Array.isArray(value)) {
    return [];
  }
  const attributes: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = normalizeString(item.name).slice(0, 300);
    const attributeValue = normalizeString(item.value).slice(
      0,
      MAX_INSPECTION_STRING_CHARS,
    );
    const key = name.toLocaleLowerCase("ru-RU");
    if (!name || !attributeValue || seen.has(key)) {
      continue;
    }
    seen.add(key);
    attributes.push({ name, value: attributeValue });
    if (attributes.length >= MAX_ATTRIBUTES) {
      break;
    }
  }
  return attributes;
};

const normalizeStructuredProduct = (
  value: Record<string, unknown>,
): Record<string, unknown> => ({
  "@type": normalizeString(value["@type"]).slice(0, 50),
  sku: normalizeString(value.sku).slice(0, 30),
  name: normalizeString(value.name).slice(0, 500),
  brand: typeof value.brand === "string"
    ? value.brand.slice(0, 300)
    : isRecord(value.brand)
      ? { name: normalizeString(value.brand.name).slice(0, 300) }
      : "",
  description: normalizeString(value.description).slice(0, MAX_DESCRIPTION_CHARS),
  offers: { url: extractOfferUrl(value.offers).slice(0, MAX_INSPECTION_STRING_CHARS) },
});

const extractOfferUrl = (value: unknown): string => {
  if (isRecord(value)) {
    return normalizeString(value.url);
  }
  if (Array.isArray(value)) {
    for (const offer of value) {
      if (isRecord(offer)) {
        const url = normalizeString(offer.url);
        if (url) {
          return url;
        }
      }
    }
  }
  return "";
};

const extractBrand = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (isRecord(value)) {
    return normalizeString(value.name) || null;
  }
  return null;
};

const normalizeStringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.slice(0, 8).map((item) => normalizeString(item).slice(0, 300)).filter(Boolean)
  : [];

const normalizeString = (value: unknown): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";

export const maxOzonInspectionResponseBytes = MAX_INSPECTION_RESPONSE_BYTES;

const normalizeMcpUrl = (value: string): string => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("Ozon Playwright MCP URL must be HTTP(S) without credentials.");
  }
  return url.toString();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
