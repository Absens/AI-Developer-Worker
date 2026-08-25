import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertAnonymousOzonStorageState,
  hasExactOzonPrimaryProduct,
  resolveOzonSessionBootstrapConfig,
  writeOzonStorageStateAtomically,
} from "../src/integrations/ozon/sessionState.js";

const canaryUrl =
  "https://www.ozon.ru/product/kuhonnyy-nozh-dlya-myasa-3085863400/";

describe("resolveOzonSessionBootstrapConfig", () => {
  it("requires an absolute state directory outside the repository", () => {
    const outsideDirectory = resolve(process.cwd(), "..", "ozon-session-state");

    expect(resolveOzonSessionBootstrapConfig({
      OZON_STORAGE_STATE_HOST_DIR: outsideDirectory,
      OZON_BOOTSTRAP_CANARY_URL: canaryUrl,
    }, process.cwd())).toEqual({
      stateDirectory: outsideDirectory,
      stateFile: resolve(outsideDirectory, "storage-state.json"),
      canaryUrl,
    });
    expect(() => resolveOzonSessionBootstrapConfig({
      OZON_STORAGE_STATE_HOST_DIR: ".runtime/ozon",
      OZON_BOOTSTRAP_CANARY_URL: canaryUrl,
    }, process.cwd())).toThrow(/absolute/i);
    expect(() => resolveOzonSessionBootstrapConfig({
      OZON_STORAGE_STATE_HOST_DIR: resolve(process.cwd(), ".runtime", "ozon"),
      OZON_BOOTSTRAP_CANARY_URL: canaryUrl,
    }, process.cwd())).toThrow(/outside/i);
  });

  it("accepts only a regular canonical Ozon card as the canary", () => {
    const outsideDirectory = resolve(process.cwd(), "..", "ozon-session-state");

    expect(() => resolveOzonSessionBootstrapConfig({
      OZON_STORAGE_STATE_HOST_DIR: outsideDirectory,
      OZON_BOOTSTRAP_CANARY_URL: "https://ozon.ru/t/7GxaYkf",
    }, process.cwd())).toThrow(/regular Ozon product/i);
    expect(() => resolveOzonSessionBootstrapConfig({
      OZON_STORAGE_STATE_HOST_DIR: outsideDirectory,
      OZON_BOOTSTRAP_CANARY_URL: "https://shop.example/products/3085863400",
    }, process.cwd())).toThrow(/regular Ozon product/i);
  });
});

describe("Ozon bootstrap state gates", () => {
  it("requires the exact primary JSON-LD product, not a recommendation", () => {
    expect(hasExactOzonPrimaryProduct(canaryUrl, [{
      "@type": "Product",
      sku: "3085863400",
    }], canaryUrl, "3085863400")).toBe(true);
    expect(hasExactOzonPrimaryProduct(canaryUrl, [{
      "@type": "ItemList",
      recommendations: [{ sku: "3085863400" }],
    }], canaryUrl, "3085863400")).toBe(false);
    expect(hasExactOzonPrimaryProduct(canaryUrl, [{
      "@type": "Product",
      sku: "30858634001",
    }], canaryUrl, "3085863400")).toBe(false);
  });

  it("rejects storage names that indicate an authenticated account", () => {
    expect(() => assertAnonymousOzonStorageState({
      cookies: [{ name: "__Secure-access-token" }],
      origins: [],
    })).toThrow(/authenticated/i);
    for (const name of ["session", "session_id", "sid", "jwt", "token"]) {
      expect(() => assertAnonymousOzonStorageState({
        cookies: [{ name }],
        origins: [],
      })).toThrow(/authenticated/i);
    }
    expect(() => assertAnonymousOzonStorageState({
      cookies: [{ name: "abt_data" }],
      origins: [{ localStorage: [{ name: "anonymous-device" }] }],
    })).not.toThrow();
  });

  it("atomically replaces a last-known-good state without temp residue", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ozon-state-test-"));
    const stateFile = resolve(directory, "storage-state.json");
    try {
      await writeOzonStorageStateAtomically(stateFile, { version: 1 }, process.cwd());
      await writeOzonStorageStateAtomically(stateFile, { version: 2 }, process.cwd());
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({ version: 2 });
      await expect(readdir(directory)).resolves.toEqual(["storage-state.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a lexical external directory that resolves inside the repository", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ozon-state-link-test-"));
    const repositoryRoot = resolve(root, "repository");
    const internalDirectory = resolve(repositoryRoot, "sensitive-state");
    const externalLink = resolve(root, "external-link");
    try {
      await mkdir(internalDirectory, { recursive: true });
      await symlink(
        internalDirectory,
        externalLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(writeOzonStorageStateAtomically(
        resolve(externalLink, "storage-state.json"),
        { secret: true },
        repositoryRoot,
      )).rejects.toThrow(/resolve outside/i);
      await expect(readdir(internalDirectory)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
