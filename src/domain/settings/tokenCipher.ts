import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The key is supplied by deployment, never by the browser or registry. */
export class TokenCipher {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== base64Key) {
      throw new Error("SETTINGS_ENCRYPTION_KEY must be canonical base64 for 32 random bytes.");
    }
  }
  seal(value: string, connectionId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`managed-connection:${connectionId}:v1`));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
  }
  open(encrypted: string, connectionId: string): string {
    try {
      const [version, nonce, tag, data, extra] = encrypted.split(".");
      if (version !== "v1" || !nonce || !tag || !data || extra) throw new Error();
      const iv = Buffer.from(nonce, "base64"); const auth = Buffer.from(tag, "base64");
      if (iv.length !== 12 || auth.length !== 16) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(`managed-connection:${connectionId}:v1`));
      cipher.setAuthTag(auth);
      return Buffer.concat([cipher.update(Buffer.from(data, "base64")), cipher.final()]).toString("utf8");
    } catch {
      throw new Error("Cannot decrypt managed connection. Check the deployment encryption key.");
    }
  }
}
