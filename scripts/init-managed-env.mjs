import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const origins = (process.argv[2] ?? "").split(",").map(value => value.trim()).filter(Boolean);
if (!origins.length || origins.some(value => {
  try { const url = new URL(value); return url.protocol !== "https:" || value !== url.origin || url.username || url.password; }
  catch { return true; }
})) {
  console.error("Usage: node scripts/init-managed-env.mjs https://gitlab.example.com[,https://gitlab.com]");
  process.exit(1);
}
const content = [
  "# Generated locally. Never commit this file; back up the encryption key securely.",
  `SETTINGS_GITLAB_ORIGINS=${origins.join(",")}`,
  `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}`,
  `TASK_TRACKER_SYSTEM_TOKEN=${randomBytes(32).toString("hex")}`,
  `SETTINGS_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  "CODEX_API_KEY=", "",
].join("\n");
try {
  writeFileSync(".env.managed", content, { flag: "wx", mode: 0o600 });
  console.log("Created .env.managed. It is never overwritten. Read the admin token from this file, not from logs.");
} catch {
  console.error("Could not create .env.managed (file may already exist). No existing file was changed.");
  process.exitCode = 1;
}
