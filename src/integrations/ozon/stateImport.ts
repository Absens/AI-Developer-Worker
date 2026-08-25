import { isAbsolute, relative, resolve } from "node:path";

import { assertAnonymousOzonStorageState } from "./sessionState.js";
import { resolveOzonSessionBootstrapConfig } from "./sessionState.js";

const MAX_COOKIES = 100;
const MAX_LOCAL_STORAGE_ENTRIES = 100;
const MAX_COOKIE_NAME_CHARS = 256;
const MAX_STORAGE_NAME_CHARS = 256;
const MAX_STORAGE_VALUE_CHARS = 16_384;
export const maxOzonStateCandidateBytes = 512 * 1024;

interface NormalizedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface NormalizedOzonStorageState {
  cookies: NormalizedCookie[];
  origins: Array<{
    origin: "https://www.ozon.ru";
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface OzonStateImportConfig {
  candidateFile: string;
  stateDirectory: string;
  stateFile: string;
  canaryUrl: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isWithin = (parent: string, candidate: string): boolean => {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (
    !relativePath.startsWith("..") && !isAbsolute(relativePath)
  );
};

const isOzonDomain = (domain: string): boolean => {
  const hostname = domain.toLowerCase().replace(/^\./u, "");
  return hostname === "ozon.ru" || hostname.endsWith(".ozon.ru");
};

const boundedString = (
  value: unknown,
  field: string,
  maxLength: number,
): string => {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new Error(`${field} is missing or exceeds the allowed length.`);
  }
  return value;
};

const boundedValue = (
  value: unknown,
  field: string,
  maxLength: number,
): string => {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${field} is missing or exceeds the allowed length.`);
  }
  return value;
};

const normalizeCookie = (value: unknown): NormalizedCookie => {
  if (!isRecord(value)) {
    throw new Error("Ozon state candidate contains an invalid cookie.");
  }
  const domain = boundedString(value.domain, "Cookie domain", 255).toLowerCase();
  if (!isOzonDomain(domain)) {
    throw new Error("Ozon state candidate contains a cookie outside the Ozon domain.");
  }
  const path = boundedString(value.path, "Cookie path", 2_048);
  if (!path.startsWith("/")) {
    throw new Error("Ozon state candidate contains an invalid cookie path.");
  }
  const expires = typeof value.expires === "number" && Number.isFinite(value.expires)
    ? value.expires
    : -1;
  const sameSite = value.sameSite === "Strict" || value.sameSite === "None"
    ? value.sameSite
    : "Lax";
  return {
    name: boundedString(value.name, "Cookie name", MAX_COOKIE_NAME_CHARS),
    value: boundedValue(value.value, "Cookie value", MAX_STORAGE_VALUE_CHARS),
    domain,
    path,
    expires,
    httpOnly: value.httpOnly === true,
    secure: value.secure !== false,
    sameSite,
  };
};

export const normalizeOzonStateCandidate = (
  value: unknown,
): NormalizedOzonStorageState => {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new Error("Ozon state candidate has an invalid schema.");
  }
  if (value.formatVersion !== undefined && value.formatVersion !== 1) {
    throw new Error("Ozon state candidate format version is unsupported.");
  }
  if (value.cookies.length > MAX_COOKIES || value.origins.length > 1) {
    throw new Error("Ozon state candidate exceeds the allowed item count.");
  }
  const cookies = value.cookies.map(normalizeCookie);
  const origins = value.origins.map((origin) => {
    if (!isRecord(origin) || origin.origin !== "https://www.ozon.ru") {
      throw new Error("Ozon state candidate contains a non-Ozon origin.");
    }
    if (!Array.isArray(origin.localStorage) ||
      origin.localStorage.length > MAX_LOCAL_STORAGE_ENTRIES) {
      throw new Error("Ozon state candidate contains invalid local storage.");
    }
    return {
      origin: "https://www.ozon.ru" as const,
      localStorage: origin.localStorage.map((entry) => {
        if (!isRecord(entry)) {
          throw new Error("Ozon state candidate contains invalid local storage.");
        }
        return {
          name: boundedString(entry.name, "Storage name", MAX_STORAGE_NAME_CHARS),
          value: boundedValue(entry.value, "Storage value", MAX_STORAGE_VALUE_CHARS),
        };
      }),
    };
  });
  if (cookies.length === 0 && origins.every((origin) => origin.localStorage.length === 0)) {
    throw new Error("Ozon state candidate is empty.");
  }
  const normalized = { cookies, origins };
  assertAnonymousOzonStorageState(normalized);
  return normalized;
};

export const parseOzonStateCandidateJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("Ozon state candidate contains invalid JSON.");
  }
};

export const resolveOzonStateImportConfig = (
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): OzonStateImportConfig => {
  const rawCandidateFile = environment.OZON_STATE_CANDIDATE_FILE?.trim();
  if (!rawCandidateFile || !isAbsolute(rawCandidateFile)) {
    throw new Error("OZON_STATE_CANDIDATE_FILE must be an absolute path.");
  }
  const candidateFile = resolve(rawCandidateFile);
  if (isWithin(repositoryRoot, candidateFile)) {
    throw new Error("OZON_STATE_CANDIDATE_FILE must be outside the repository.");
  }
  return {
    candidateFile,
    ...resolveOzonSessionBootstrapConfig(environment, repositoryRoot),
  };
};
