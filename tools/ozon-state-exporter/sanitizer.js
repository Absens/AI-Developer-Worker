"use strict";

((root) => {
  const AUTH_STORAGE_NAME = /token|auth|account|customer|login|user[_-]?id|session|(?:^|[_-])sid(?:$|[_-])|jwt/i;
  const MAX_COOKIES = 100;
  const MAX_ENTRIES = 100;
  const MAX_VALUE_CHARS = 16_384;

  const boundedString = (value, field, maxLength) => {
    if (typeof value !== "string" || !value || value.length > maxLength) {
      throw new Error(`${field} is missing or exceeds the allowed length.`);
    }
    return value;
  };

  const boundedValue = (value, field, maxLength) => {
    if (typeof value !== "string" || value.length > maxLength) {
      throw new Error(`${field} is missing or exceeds the allowed length.`);
    }
    return value;
  };

  const isOzonDomain = (domain) => {
    const hostname = String(domain || "").toLowerCase().replace(/^\./u, "");
    return hostname === "ozon.ru" || hostname.endsWith(".ozon.ru");
  };

  const assertAnonymousNames = (names) => {
    if (names.some((name) => AUTH_STORAGE_NAME.test(String(name || "")))) {
      throw new Error("Authenticated Ozon state is not allowed. Sign out and retry.");
    }
  };

  const normalizeSameSite = (value) => {
    if (value === "strict" || value === "Strict") return "Strict";
    if (value === "no_restriction" || value === "None") return "None";
    return "Lax";
  };

  const buildCandidate = ({ cookies, localStorage }) => {
    if (!Array.isArray(cookies) || cookies.length > MAX_COOKIES) {
      throw new Error("Ozon cookie count exceeds the allowed limit.");
    }
    if (!Array.isArray(localStorage) || localStorage.length > MAX_ENTRIES) {
      throw new Error("Ozon local storage count exceeds the allowed limit.");
    }
    for (const cookie of cookies) {
      if (!isOzonDomain(cookie && cookie.domain)) {
        throw new Error("A cookie outside the Ozon domain was rejected.");
      }
    }
    assertAnonymousNames([
      ...cookies.map((cookie) => cookie && cookie.name),
      ...localStorage.map((entry) => entry && entry.name),
    ]);
    const normalizedCookies = cookies.map((cookie) => ({
      name: boundedString(cookie.name, "Cookie name", 256),
      value: boundedValue(cookie.value, "Cookie value", MAX_VALUE_CHARS),
      domain: cookie.domain.toLowerCase(),
      path: typeof cookie.path === "string" && cookie.path.startsWith("/")
        ? cookie.path
        : "/",
      expires: Number.isFinite(cookie.expirationDate) ? cookie.expirationDate
        : Number.isFinite(cookie.expires) ? cookie.expires : -1,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure !== false,
      sameSite: normalizeSameSite(cookie.sameSite),
    }));
    const normalizedStorage = localStorage.map((entry) => ({
      name: boundedString(entry.name, "Storage name", 256),
      value: boundedValue(entry.value, "Storage value", MAX_VALUE_CHARS),
    }));
    if (normalizedCookies.length === 0 && normalizedStorage.length === 0) {
      throw new Error("Ozon browser state is empty.");
    }
    return {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      cookies: normalizedCookies,
      origins: [{
        origin: "https://www.ozon.ru",
        localStorage: normalizedStorage,
      }],
    };
  };

  root.OzonStateSanitizer = Object.freeze({ buildCandidate });
})(globalThis);
