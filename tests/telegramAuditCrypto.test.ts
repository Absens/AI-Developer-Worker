import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptTelegramAuditText,
  encryptTelegramAuditText,
} from "../src/domain/telegramAssistant/index.js";

const makeNonCanonicalPaddedBase64 = (value: string): string => {
  const paddingIndex = value.indexOf("=");
  if (paddingIndex <= 0) {
    throw new Error("Test value must include base64 padding.");
  }
  return `${value.slice(0, paddingIndex - 1)}B${value.slice(paddingIndex)}`;
};

describe("telegram audit crypto", () => {
  it("round-trips encrypted audit text with key metadata", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptTelegramAuditText("секретный текст", {
      key,
      keyId: "test-key",
    });

    expect(encrypted).toContain("v1:test-key:");
    expect(encrypted).not.toContain("секретный текст");
    expect(decryptTelegramAuditText(encrypted, { key })).toBe("секретный текст");
  });

  it("round-trips empty audit text", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptTelegramAuditText("", { key, keyId: "empty" });

    expect(decryptTelegramAuditText(encrypted, { key })).toBe("");
  });

  it("rejects invalid key material", () => {
    expect(() =>
      encryptTelegramAuditText("text", {
        key: Buffer.from("short").toString("base64"),
        keyId: "bad",
      }),
    ).toThrow(/32-byte/);
    expect(() =>
      encryptTelegramAuditText("text", {
        key: `!!!!${randomBytes(32).toString("base64")}`,
        keyId: "bad",
      }),
    ).toThrow(/base64/);
    expect(() =>
      encryptTelegramAuditText("text", {
        key: makeNonCanonicalPaddedBase64(Buffer.alloc(32).toString("base64")),
        keyId: "bad",
      }),
    ).toThrow(/base64/);
  });

  it("rejects unsafe key metadata", () => {
    const key = randomBytes(32).toString("base64");

    expect(() =>
      encryptTelegramAuditText("text", { key, keyId: "bad:key" }),
    ).toThrow(/key id/);
  });

  it("rejects malformed encrypted audit payloads", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptTelegramAuditText("text", { key });
    const encryptedParts = encrypted.split(":");
    const keyId = encryptedParts[1]!;
    const nonce = encryptedParts[2]!;
    const tag = encryptedParts[3]!;
    const ciphertext = encryptedParts[4]!;

    expect(() =>
      decryptTelegramAuditText("v1::nonce:tag:cipher", { key }),
    ).toThrow(/payload format/);
    expect(() =>
      decryptTelegramAuditText("v1:test:nonce:tag:cipher:extra", { key }),
    ).toThrow(/payload format/);
    expect(() =>
      decryptTelegramAuditText("v1:test:bm9uY2U=:dGFn:cipher", { key }),
    ).toThrow(/payload format/);
    expect(() =>
      decryptTelegramAuditText(
        `v1:${keyId}:!!!!${nonce}:${tag}:${ciphertext}`,
        { key },
      ),
    ).toThrow(/payload format/);
    expect(() =>
      decryptTelegramAuditText(
        `v1:${keyId}:${nonce}:${tag}:${makeNonCanonicalPaddedBase64(ciphertext)}`,
        { key },
      ),
    ).toThrow(/payload format/);
  });

  it("normalizes authentication failures to payload format errors", () => {
    const key = randomBytes(32).toString("base64");
    const wrongKey = randomBytes(32).toString("base64");
    const encrypted = encryptTelegramAuditText("text", { key });

    expect(() =>
      decryptTelegramAuditText(encrypted, { key: wrongKey }),
    ).toThrow(/payload format/);
  });

  it("rejects tampered encrypted audit key metadata", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptTelegramAuditText("text", { key, keyId: "key-a" });
    const [_version, _keyId, nonce, tag, ciphertext] = encrypted.split(":");

    expect(() =>
      decryptTelegramAuditText(`v1:bad/key:${nonce}:${tag}:${ciphertext}`, { key }),
    ).toThrow(/payload format/);
    expect(() =>
      decryptTelegramAuditText(`v1:key-b:${nonce}:${tag}:${ciphertext}`, { key }),
    ).toThrow(/payload format/);
  });
});
