import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { extractOzonProductReference } from "../../domain/telegramAssistant/competitorResearch.js";

export interface OzonSessionBootstrapConfig {
  stateDirectory: string;
  stateFile: string;
  canaryUrl: string;
}

export const hasExactOzonPrimaryProduct = (
  finalUrl: string,
  structuredProducts: unknown[],
  expectedUrl: string,
  productId: string,
): boolean => {
  const finalReference = extractOzonProductReference(finalUrl);
  if (!finalReference || finalReference.sourceUrl !== expectedUrl) {
    return false;
  }
  return structuredProducts.some((product) => (
    product !== null && typeof product === "object" &&
    (product as Record<string, unknown>)["@type"] === "Product" &&
    String((product as Record<string, unknown>).sku) === productId
  ));
};

const AUTH_STORAGE_NAME = /token|auth|account|customer|login|user[_-]?id|session|(?:^|[_-])sid(?:$|[_-])|jwt/i;

export const assertAnonymousOzonStorageState = (state: unknown): void => {
  if (!state || typeof state !== "object") {
    throw new Error("Ozon storage state is invalid.");
  }
  const value = state as {
    cookies?: Array<{ name?: unknown }>;
    origins?: Array<{ localStorage?: Array<{ name?: unknown }> }>;
  };
  const names = [
    ...(Array.isArray(value.cookies) ? value.cookies.map((cookie) => cookie.name) : []),
    ...(Array.isArray(value.origins)
      ? value.origins.flatMap((origin) => Array.isArray(origin.localStorage)
        ? origin.localStorage.map((entry) => entry.name)
        : [])
      : []),
  ];
  if (names.some((name) => typeof name === "string" && AUTH_STORAGE_NAME.test(name))) {
    throw new Error("Authenticated Ozon browser state is not allowed.");
  }
};

export const writeOzonStorageStateAtomically = async (
  stateFile: string,
  state: unknown,
  repositoryRoot: string,
): Promise<void> => {
  const temporaryStateFile = `${stateFile}.${randomUUID()}.tmp`;
  const stateDirectory = dirname(stateFile);
  await mkdir(stateDirectory, { recursive: true });
  const [repositoryRealPath, stateDirectoryRealPath] = await Promise.all([
    realpath(repositoryRoot),
    realpath(stateDirectory),
  ]);
  if (isWithin(repositoryRealPath, stateDirectoryRealPath)) {
    throw new Error("Ozon storage state destination must resolve outside the repository.");
  }
  try {
    await writeFile(temporaryStateFile, JSON.stringify(state), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryStateFile, stateFile);
    try {
      await chmod(stateFile, 0o600);
    } catch {
      // Windows ACLs are managed separately; chmod is best-effort there.
    }
  } finally {
    await rm(temporaryStateFile, { force: true });
  }
};

const isWithin = (parent: string, candidate: string): boolean => {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (
    !relativePath.startsWith("..") && !isAbsolute(relativePath)
  );
};

export const resolveOzonSessionBootstrapConfig = (
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): OzonSessionBootstrapConfig => {
  const rawStateDirectory = environment.OZON_STORAGE_STATE_HOST_DIR?.trim();
  if (!rawStateDirectory || !isAbsolute(rawStateDirectory)) {
    throw new Error(
      "OZON_STORAGE_STATE_HOST_DIR must be an absolute directory outside the repository.",
    );
  }
  const stateDirectory = resolve(rawStateDirectory);
  if (isWithin(repositoryRoot, stateDirectory)) {
    throw new Error(
      "OZON_STORAGE_STATE_HOST_DIR must be outside the repository.",
    );
  }

  const rawCanaryUrl = environment.OZON_BOOTSTRAP_CANARY_URL?.trim() ?? "";
  const canaryReference = extractOzonProductReference(rawCanaryUrl);
  if (!canaryReference || canaryReference.sourceUrl !== rawCanaryUrl) {
    throw new Error(
      "OZON_BOOTSTRAP_CANARY_URL must be a regular Ozon product canonical URL.",
    );
  }

  return {
    stateDirectory,
    stateFile: resolve(stateDirectory, "storage-state.json"),
    canaryUrl: canaryReference.sourceUrl,
  };
};
