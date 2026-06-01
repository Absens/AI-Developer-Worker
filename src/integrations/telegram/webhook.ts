export const TELEGRAM_WEBHOOK_PUBLIC_HTTPS_ERROR =
  "Telegram webhook mode requires a public https observability.baseUrl for setWebhook.";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const parseIpv4Address = (hostname: string): [number, number, number, number] | undefined => {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 10);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets as [number, number, number, number];
};

const isNonPublicIpv4Address = (hostname: string): boolean => {
  const octets = parseIpv4Address(hostname);
  if (!octets) {
    return false;
  }

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
};

const normalizeIpv6Hostname = (hostname: string): string | undefined => {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
    return undefined;
  }
  return hostname.slice(1, -1).toLowerCase();
};

const parseIpv6Hextet = (value: string): number | undefined => {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 16);
};

const parseIpv6Side = (value: string): number[] | undefined => {
  if (!value) {
    return [];
  }
  const hextets = value.split(":").map(parseIpv6Hextet);
  return hextets.some((hextet) => hextet === undefined)
    ? undefined
    : hextets as number[];
};

const parseIpv6Address = (hostname: string): number[] | undefined => {
  const value = normalizeIpv6Hostname(hostname);
  if (!value) {
    return undefined;
  }

  const compressedParts = value.split("::");
  if (compressedParts.length > 2) {
    return undefined;
  }

  if (compressedParts.length === 1) {
    const hextets = parseIpv6Side(value);
    return hextets?.length === 8 ? hextets : undefined;
  }

  const left = parseIpv6Side(compressedParts[0] ?? "");
  const right = parseIpv6Side(compressedParts[1] ?? "");
  if (!left || !right) {
    return undefined;
  }

  const omittedZeros = 8 - left.length - right.length;
  if (omittedZeros < 1) {
    return undefined;
  }
  return [...left, ...Array.from({ length: omittedZeros }, () => 0), ...right];
};

const isAllZeros = (hextets: number[]): boolean =>
  hextets.every((hextet) => hextet === 0);

const isIpv6Loopback = (hextets: number[]): boolean =>
  hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1;

const ipv4FromMappedIpv6 = (hextets: number[]): string | undefined => {
  if (
    hextets.slice(0, 5).some((hextet) => hextet !== 0) ||
    hextets[5] !== 0xffff
  ) {
    return undefined;
  }

  const high = hextets[6] ?? 0;
  const low = hextets[7] ?? 0;
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join(".");
};

const isNonPublicIpv6Address = (hostname: string): boolean => {
  const hextets = parseIpv6Address(hostname);
  if (!hextets) {
    return false;
  }

  const mappedIpv4 = ipv4FromMappedIpv6(hextets);
  if (mappedIpv4) {
    return isNonPublicIpv4Address(mappedIpv4);
  }

  const [first = 0, second = 0] = hextets;
  return (
    isAllZeros(hextets) ||
    isIpv6Loopback(hextets) ||
    first === 0x0100 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    first < 0x2000 ||
    first > 0x3fff ||
    (first === 0x2001 && second === 0x0000) ||
    (first === 0x2001 && second === 0x0002) ||
    (first === 0x2001 && second >= 0x0020 && second <= 0x002f) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002
  );
};

const isNonPublicHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return (
    LOOPBACK_HOSTS.has(normalized) ||
    isNonPublicIpv4Address(normalized) ||
    isNonPublicIpv6Address(normalized)
  );
};

export const isPublicHttpsTelegramWebhookBaseUrl = (
  rawBaseUrl: string | undefined,
): boolean => {
  if (!rawBaseUrl) {
    return false;
  }

  try {
    const url = new URL(rawBaseUrl);
    // DNS names are not resolved here; only deterministic non-global IP literals
    // and localhost are rejected without network access.
    return url.protocol === "https:" && !isNonPublicHostname(url.hostname);
  } catch {
    return false;
  }
};

export const assertPublicHttpsTelegramWebhookBaseUrl = (
  rawBaseUrl: string | undefined,
): void => {
  if (!isPublicHttpsTelegramWebhookBaseUrl(rawBaseUrl)) {
    throw new Error(TELEGRAM_WEBHOOK_PUBLIC_HTTPS_ERROR);
  }
};
