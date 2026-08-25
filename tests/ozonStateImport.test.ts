import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  normalizeOzonStateCandidate,
  parseOzonStateCandidateJson,
  resolveOzonStateImportConfig,
} from "../src/integrations/ozon/stateImport.js";

const canaryUrl =
  "https://www.ozon.ru/product/kuhonnyy-nozh-dlya-myasa-3085863400/";

const anonymousCandidate = {
  formatVersion: 1,
  cookies: [{
    name: "abt_data",
    value: "bounded-value",
    domain: ".ozon.ru",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }],
  origins: [{
    origin: "https://www.ozon.ru",
    localStorage: [{ name: "anonymous-device", value: "device-value" }],
  }],
};

describe("Ozon state import boundary", () => {
  it("accepts only bounded anonymous Ozon storage state", () => {
    expect(normalizeOzonStateCandidate(anonymousCandidate)).toEqual({
      cookies: anonymousCandidate.cookies,
      origins: anonymousCandidate.origins,
    });
    expect(normalizeOzonStateCandidate({
      ...anonymousCandidate,
      cookies: [{ ...anonymousCandidate.cookies[0], value: "" }],
    }).cookies[0]?.value).toBe("");

    expect(() => normalizeOzonStateCandidate({
      ...anonymousCandidate,
      cookies: [{ ...anonymousCandidate.cookies[0], domain: ".example.com" }],
    })).toThrow(/Ozon domain/i);
    expect(() => normalizeOzonStateCandidate({
      ...anonymousCandidate,
      cookies: [{ ...anonymousCandidate.cookies[0], name: "session_id" }],
    })).toThrow(/authenticated/i);
    expect(() => normalizeOzonStateCandidate({
      ...anonymousCandidate,
      origins: [{
        origin: "https://shop.example",
        localStorage: [],
      }],
    })).toThrow(/Ozon origin/i);
  });

  it("requires an absolute candidate file outside the repository", () => {
    const outsideFile = resolve(process.cwd(), "..", "ozon-state.json");
    const outsideDirectory = resolve(process.cwd(), "..", "ozon-state");
    expect(resolveOzonStateImportConfig({
      OZON_STATE_CANDIDATE_FILE: outsideFile,
      OZON_STORAGE_STATE_HOST_DIR: outsideDirectory,
      OZON_BOOTSTRAP_CANARY_URL: canaryUrl,
    }, process.cwd())).toEqual({
      candidateFile: outsideFile,
      stateDirectory: outsideDirectory,
      stateFile: resolve(outsideDirectory, "storage-state.json"),
      canaryUrl,
    });
    expect(() => resolveOzonStateImportConfig({
      OZON_STATE_CANDIDATE_FILE: "candidate.json",
      OZON_STORAGE_STATE_HOST_DIR: outsideDirectory,
      OZON_BOOTSTRAP_CANARY_URL: canaryUrl,
    }, process.cwd())).toThrow(/candidate.*absolute/i);
  });

  it("does not echo malformed candidate contents in parse errors", () => {
    const secretMarker = "DO_NOT_LOG_THIS_COOKIE_VALUE";
    let message = "";
    try {
      parseOzonStateCandidateJson(`{${secretMarker}`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/invalid JSON/i);
    expect(message).not.toContain(secretMarker);
  });
});

describe("Ozon state exporter extension policy", () => {
  it("requests only Ozon-scoped browser permissions", async () => {
    const extensionRoot = resolve(process.cwd(), "tools/ozon-state-exporter");
    const manifest = JSON.parse(await readFile(
      resolve(extensionRoot, "manifest.json"),
      "utf8",
    )) as { permissions?: unknown; host_permissions?: unknown };
    expect(manifest.permissions).toEqual(["cookies", "scripting"]);
    expect(manifest.host_permissions).toEqual([
      "https://ozon.ru/*",
      "https://*.ozon.ru/*",
    ]);
    const popupSource = await readFile(resolve(extensionRoot, "popup.js"), "utf8");
    expect(popupSource).not.toMatch(/\bfetch\s*\(/u);
    expect(popupSource).not.toMatch(/XMLHttpRequest|WebSocket/u);
  });

  it("rejects authenticated and external cookies before download", async () => {
    const sanitizerSource = await readFile(resolve(
      process.cwd(),
      "tools/ozon-state-exporter/sanitizer.js",
    ), "utf8");
    const sandbox = { globalThis: {} as Record<string, unknown> };
    vm.runInNewContext(sanitizerSource, sandbox);
    const sanitizer = sandbox.globalThis.OzonStateSanitizer as {
      buildCandidate(input: {
        cookies: unknown[];
        localStorage: unknown[];
      }): unknown;
    };

    expect(sanitizer.buildCandidate({
      cookies: anonymousCandidate.cookies,
      localStorage: anonymousCandidate.origins[0]?.localStorage ?? [],
    })).toMatchObject({ formatVersion: 1 });
    expect(sanitizer.buildCandidate({
      cookies: [{ ...anonymousCandidate.cookies[0], value: "" }],
      localStorage: [],
    })).toMatchObject({ cookies: [{ value: "" }] });
    expect(() => sanitizer.buildCandidate({
      cookies: [{ ...anonymousCandidate.cookies[0], name: "access_token" }],
      localStorage: [],
    })).toThrow(/authenticated/i);
    expect(() => sanitizer.buildCandidate({
      cookies: [{ ...anonymousCandidate.cookies[0], domain: ".example.com" }],
      localStorage: [],
    })).toThrow(/Ozon domain/i);
  });
});
