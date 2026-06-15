import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface TelegramAuditCryptoOptions {
  key: string;
  keyId?: string;
}

const decodeKey = (key: string): Buffer => {
  const decoded = decodeBase64Value(key, "Telegram audit encryption key");
  if (decoded.length !== 32) {
    throw new Error("Telegram audit encryption key must decode to 32-byte AES-256 material.");
  }
  return decoded;
};

const decodeBase64Value = (value: string, label: string): Buffer => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be valid base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} must be valid base64.`);
  }
  return decoded;
};

const decodePayloadBase64Value = (value: string, label: string): Buffer => {
  try {
    return decodeBase64Value(value, label);
  } catch (_error) {
    throw new Error("Unsupported Telegram audit encrypted payload format.");
  }
};

const normalizeKeyId = (keyId: string | undefined): string => {
  const normalized = keyId ?? "default";
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Telegram audit encryption key id must be delimiter-safe.");
  }
  return normalized;
};

const normalizePayloadKeyId = (keyId: string): string => {
  try {
    return normalizeKeyId(keyId);
  } catch (_error) {
    throw new Error("Unsupported Telegram audit encrypted payload format.");
  }
};

const buildAuditAssociatedData = (version: string, keyId: string): Buffer =>
  Buffer.from(`${version}:${keyId}`, "utf8");

export const encryptTelegramAuditText = (
  plaintext: string,
  options: TelegramAuditCryptoOptions,
): string => {
  const key = decodeKey(options.key);
  const keyId = normalizeKeyId(options.keyId);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(buildAuditAssociatedData("v1", keyId));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    keyId,
    nonce.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
};

export const decryptTelegramAuditText = (
  encrypted: string,
  options: Pick<TelegramAuditCryptoOptions, "key">,
): string => {
  const parts = encrypted.split(":");
  const [version, keyId, nonceValue, tagValue, ciphertextValue] = parts;
  if (
    parts.length !== 5 ||
    version !== "v1" ||
    !keyId ||
    !nonceValue ||
    !tagValue ||
    ciphertextValue === undefined
  ) {
    throw new Error("Unsupported Telegram audit encrypted payload format.");
  }
  const normalizedKeyId = normalizePayloadKeyId(keyId);
  const nonce = decodePayloadBase64Value(nonceValue, "Telegram audit encrypted nonce");
  const tag = decodePayloadBase64Value(tagValue, "Telegram audit encrypted tag");
  const ciphertext = decodePayloadBase64Value(
    ciphertextValue,
    "Telegram audit encrypted ciphertext",
  );
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new Error("Unsupported Telegram audit encrypted payload format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeKey(options.key),
    nonce,
  );
  decipher.setAAD(buildAuditAssociatedData(version, normalizedKeyId));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (_error) {
    throw new Error("Unsupported Telegram audit encrypted payload format.");
  }
};
