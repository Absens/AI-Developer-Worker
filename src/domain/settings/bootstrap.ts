import { isAbsolute } from "node:path";
import { loadUnconfiguredManagedFleet } from "../../config.js";
import { TokenCipher } from "./tokenCipher.js";
import { validateOrigin } from "./validation.js";

/** Only deployment parameters are read from env in managed mode. Per-project values live in the registry. */
export const loadManagedBootstrap = (env: NodeJS.ProcessEnv = process.env) => {
  if (env.WORKER_CONFIG_FILE?.trim()) throw new Error("Managed mode cannot also use WORKER_CONFIG_FILE.");
  for (const [key, expected] of Object.entries({ TASK_TRACKER_PROVIDER: "internal", TASK_TRACKER_STORAGE: "postgres", TASK_INTAKE_MODE: "standalone", YANDEX_SYNC_ENABLED: "false", TELEGRAM_ASSISTANT_ENABLED: "false", PROJECT_MANAGER_ENABLED: "false" })) {
    if (env[key]?.trim() && env[key]!.trim() !== expected) throw new Error(`${key} must be ${expected} in the first managed-mode release.`);
  }
  const databaseUrl = env.TASK_TRACKER_DATABASE_URL?.trim();
  const encryptionKey = env.SETTINGS_ENCRYPTION_KEY?.trim() ?? "";
  const workspaceRoot = env.SETTINGS_WORKSPACE_ROOT?.trim() ?? "";
  if (!databaseUrl) throw new Error("TASK_TRACKER_DATABASE_URL is required.");
  new TokenCipher(encryptionKey);
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) throw new Error("SETTINGS_WORKSPACE_ROOT must be absolute.");
  const allowedOrigins = (env.SETTINGS_GITLAB_ORIGINS ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (!allowedOrigins.length) throw new Error("SETTINGS_GITLAB_ORIGINS must explicitly allow your GitLab HTTPS origins.");
  for (const origin of allowedOrigins) if (validateOrigin(origin, [origin]) !== origin) throw new Error("Use canonical HTTPS origins.");
  const authMode = env.TASK_TRACKER_HUMAN_AUTH_MODE ?? "localhost";
  if (authMode === "bearer" && (env.TASK_TRACKER_SYSTEM_TOKEN?.trim().length ?? 0) < 32) {
    throw new Error("Managed bearer authentication requires TASK_TRACKER_SYSTEM_TOKEN of at least 32 characters.");
  }
  const host = env.OBSERVABILITY_HOST ?? "127.0.0.1";
  const uiHost = env.TASK_TRACKER_UI_BIND_HOST ?? host;
  if (authMode === "localhost" && (!["127.0.0.1", "::1"].includes(host) || !["127.0.0.1", "::1"].includes(uiHost))) {
    throw new Error("Localhost authentication requires loopback binding. For remote access use a protected trusted proxy.");
  }
  if (authMode === "trusted_proxy" && env.SETTINGS_TRUSTED_PROXY_CONFIRMED !== "true") {
    throw new Error("Confirm backend isolation and identity-header sanitization with SETTINGS_TRUSTED_PROXY_CONFIRMED=true.");
  }
  const fleet = loadUnconfiguredManagedFleet({
    ...env,
    TASK_TRACKER_PROVIDER: "internal", TASK_TRACKER_STORAGE: "postgres", TASK_INTAKE_MODE: "standalone", YANDEX_SYNC_ENABLED: "false",
    TELEGRAM_ASSISTANT_ENABLED: "false", PROJECT_MANAGER_ENABLED: "false", LOCK_BACKEND: "none",
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "AI Developer", GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "ai-developer@localhost",
    MAX_FIX_ATTEMPTS: "2", WORKER_ID: env.WORKER_ID ?? "managed-worker-1",
    CODEX_SANDBOX: env.CODEX_SANDBOX ?? "workspace-write",
    OBSERVABILITY_ENABLED: "true", OBSERVABILITY_HOST: host, TASK_TRACKER_UI_ENABLED: "true",
    TASK_TRACKER_UI_BIND_HOST: uiHost, TASK_TRACKER_HUMAN_AUTH_MODE: authMode,
  });
  return { fleet, databaseUrl, encryptionKey, workspaceRoot, allowedOrigins };
};
