import { afterEach, describe, expect, it, vi } from "vitest";

import { getCodexShellEnv } from "../src/integrations/codex/auth.js";
import type { AppConfig } from "../src/models/types.js";
import { runCommand, runShellCommand } from "../src/utils/shell.js";

const names = [
  "EXECUTION_TEST_SECRET", "GITLAB_TOKEN", "TRACKER_TOKEN",
  "TASK_TRACKER_DATABASE_URL", "TELEGRAM_ASSISTANT_BOT_TOKEN",
  "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME",
  "EXECUTION_TEST_ALLOWED", "EXECUTION_TEST_UNLISTED", "ONLY_EXPLICIT",
];
const probe = `const names = ${JSON.stringify(names)}; console.log(JSON.stringify(Object.fromEntries(names.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))));`;
const secretKeys = names.slice(0, 5);

const seedSecrets = (): void => {
  for (const name of secretKeys) vi.stubEnv(name, "test-secret-not-a-real-credential");
  vi.stubEnv("OPENAI_API_KEY", "test-model-key");
  vi.stubEnv("CODEX_API_KEY", "test-codex-key");
  vi.stubEnv("CODEX_HOME", "/parent-codex-home");
  vi.stubEnv("WORKER_PROJECT_ENV_ALLOWLIST", "");
  vi.stubEnv("WORKER_CODEX_ENV_ALLOWLIST", "");
  vi.stubEnv("WORKER_GIT_ENV_ALLOWLIST", "");
};

afterEach(() => vi.unstubAllEnvs());

describe("execution environment security regression", () => {
  it("does not inherit parent secrets in a real direct child process", async () => {
    seedSecrets();
    const result = await runCommand({ command: process.execPath, args: ["-e", probe], cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it("does not inherit parent secrets in a real shell command", async () => {
    seedSecrets();
    const result = await runShellCommand(`"${process.execPath}" -e ${JSON.stringify(probe)}`, { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it("treats an explicit environment as a replacement, not a parent overlay", async () => {
    seedSecrets();
    const result = await runCommand({ command: process.execPath, args: ["-e", probe], cwd: process.cwd(), env: { ONLY_EXPLICIT: "present" } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ONLY_EXPLICIT: "present" });
  });

  it("only forwards exact operator-approved project variables", async () => {
    seedSecrets();
    vi.stubEnv("EXECUTION_TEST_ALLOWED", "test-project-value");
    vi.stubEnv("EXECUTION_TEST_UNLISTED", "must-not-leak");
    vi.stubEnv("WORKER_PROJECT_ENV_ALLOWLIST", " EXECUTION_TEST_ALLOWED,EXECUTION_TEST_ALLOWED ");
    const result = await runCommand({ command: process.execPath, args: ["-e", probe], cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ EXECUTION_TEST_ALLOWED: "test-project-value" });
  });

  it("constructs Codex auth explicitly without unrelated worker credentials", async () => {
    seedSecrets();
    const env = getCodexShellEnv({ codexHome: "/dedicated-codex-home" } as AppConfig);
    expect(env.CODEX_API_KEY).toBe("test-codex-key");
    expect(env.OPENAI_API_KEY).toBe("test-model-key");
    expect(env.CODEX_HOME).toBe("/dedicated-codex-home");
    for (const key of secretKeys) expect(env[key]).toBeUndefined();
    const result = await runCommand({ command: process.execPath, args: ["-e", probe], cwd: process.cwd(), env });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ CODEX_API_KEY: "test-codex-key", OPENAI_API_KEY: "test-model-key", CODEX_HOME: "/dedicated-codex-home" });
  });
});
