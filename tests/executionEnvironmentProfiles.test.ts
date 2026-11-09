import { afterEach, describe, expect, it, vi } from "vitest";

import { getCodexShellEnv } from "../src/integrations/codex/auth.js";
import type { AppConfig } from "../src/models/types.js";
import { buildExecutionEnvironment, type ExecutionEnvironmentProfile } from "../src/utils/executionEnvironment.js";
import { runCommand } from "../src/utils/shell.js";

const profiles: ExecutionEnvironmentProfile[] = ["project", "codex", "git"];
const settingFor = (profile: ExecutionEnvironmentProfile): string => `WORKER_${profile.toUpperCase()}_ENV_ALLOWLIST`;
afterEach(() => vi.unstubAllEnvs());

describe("execution environment profiles", () => {
  it.each(profiles)("%s keeps system variables without unrelated credentials", (profile) => {
    const source = { PATH: "/bin", HOME: "/home/test", TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "true", FORCE_COLOR: "", GITLAB_TOKEN: "dummy", TELEGRAM_BOT_TOKEN: "dummy", AWS_SECRET_ACCESS_KEY: "dummy", UNKNOWN_SECRET: "dummy" };
    expect(buildExecutionEnvironment(profile, {}, source, "linux")).toEqual({ PATH: "/bin", HOME: "/home/test", TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "true", FORCE_COLOR: "" });
    expect(source.GITLAB_TOKEN).toBe("dummy");
  });

  it("keeps provider credentials in Codex only and Git identity in Git only", () => {
    const source = { CODEX_API_KEY: "test-codex", OPENAI_API_KEY: "test-openai", GIT_AUTHOR_NAME: "Worker", GIT_AUTHOR_EMAIL: "worker@example.test" };
    expect(buildExecutionEnvironment("project", {}, source)).toEqual({});
    expect(buildExecutionEnvironment("codex", {}, source)).toEqual({ CODEX_API_KEY: "test-codex", OPENAI_API_KEY: "test-openai" });
    expect(buildExecutionEnvironment("git", {}, source)).toEqual({ GIT_AUTHOR_NAME: "Worker", GIT_AUTHOR_EMAIL: "worker@example.test" });
  });

  it.each(profiles)("%s only uses its own exact allowlist", (profile) => {
    const source = {
      WORKER_PROJECT_ENV_ALLOWLIST: "PROJECT_SETTING", PROJECT_SETTING: "project",
      WORKER_CODEX_ENV_ALLOWLIST: "MODEL_SETTING", MODEL_SETTING: "codex",
      WORKER_GIT_ENV_ALLOWLIST: "GIT_SETTING", GIT_SETTING: "git",
    };
    const key = { project: "PROJECT_SETTING", codex: "MODEL_SETTING", git: "GIT_SETTING" }[profile];
    expect(buildExecutionEnvironment(profile, {}, source)).toEqual({ [key]: profile });
  });

  it("trims and deduplicates exact names, omits missing values and preserves empty values", () => {
    expect(buildExecutionEnvironment("project", {}, {
      WORKER_PROJECT_ENV_ALLOWLIST: " APP_URL,APP_URL,MISSING,EMPTY ", APP_URL: "https://example.test", EMPTY: "",
    })).toEqual({ APP_URL: "https://example.test", EMPTY: "" });
  });

  it.each(["*", "APP_*", "APP_URL=do-not-print-this-secret", "APP_URL,,OTHER"])("rejects malformed allowlist %s without printing its value", (value) => {
    expect(() => buildExecutionEnvironment("project", {}, { WORKER_PROJECT_ENV_ALLOWLIST: value })).toThrow("comma-separated exact environment names");
    try {
      buildExecutionEnvironment("project", {}, { WORKER_PROJECT_ENV_ALLOWLIST: value });
    } catch (error) {
      expect(String(error)).not.toContain("do-not-print-this-secret");
    }
  });

  for (const profile of profiles) {
    it.each(["GITLAB_TOKEN", "TRACKER_TOKEN", "TASK_TRACKER_DATABASE_URL", "TELEGRAM_ASSISTANT_BOT_TOKEN", "WORKER_SYSTEM_SECRET", "SLACK_WEBHOOK_URL", "ALERT_WEBHOOK_URL", "GIT_REPOSITORY_TOKEN", "NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "__proto__"])(`${profile} rejects reserved allowlist variable %s`, (name) => {
      expect(() => buildExecutionEnvironment(profile, {}, { [settingFor(profile)]: name, [name]: "dummy-value" })).toThrow("reserved variable");
    });
  }

  it.each(["project", "git"] as const)("%s rejects model credentials even when explicitly requested", (profile) => {
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "ANTHROPIC_API_KEY"]) {
      expect(() => buildExecutionEnvironment(profile, {}, { [settingFor(profile)]: name })).toThrow("reserved variable");
      expect(() => buildExecutionEnvironment(profile, { [name]: "dummy" }, {})).toThrow("reserved environment override");
    }
  });

  it("allows custom Codex provider variables only by exact operator opt-in", () => {
    expect(buildExecutionEnvironment("codex", {}, { WORKER_CODEX_ENV_ALLOWLIST: "OPENAI_BASE_URL", OPENAI_BASE_URL: "https://model.example.test", GITLAB_TOKEN: "dummy" })).toEqual({ OPENAI_BASE_URL: "https://model.example.test" });
  });

  it("allows trusted per-operation Git auth but never inherits parent Git configuration", () => {
    const source = { GIT_CONFIG_COUNT: "9", GIT_CONFIG_VALUE_0: "parent-secret", GIT_CONFIG_PARAMETERS: "parent-config" };
    const auth = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://example.test/.extraheader", GIT_CONFIG_VALUE_0: "dummy-header" };
    expect(buildExecutionEnvironment("git", {}, source)).toEqual({});
    expect(buildExecutionEnvironment("git", auth, source)).toEqual(auth);
    expect(() => buildExecutionEnvironment("project", auth, source)).toThrow();
    expect(() => buildExecutionEnvironment("git", { GIT_CONFIG_PARAMETERS: "unsafe" }, source)).toThrow();
  });

  it("applies trusted overrides without mutating source and can remove an inherited value", () => {
    const source = { PATH: "/bin", HOME: "/original" };
    expect(buildExecutionEnvironment("project", { HOME: "/isolated", PATH: undefined, CUSTOM: "ok" }, source)).toEqual({ HOME: "/isolated", CUSTOM: "ok" });
    expect(source).toEqual({ PATH: "/bin", HOME: "/original" });
    expect(() => buildExecutionEnvironment("codex", { GITLAB_TOKEN: "dummy" }, {})).toThrow();
    expect(() => buildExecutionEnvironment("project", { NODE_OPTIONS: "unsafe" }, {})).toThrow();
  });

  it("pins CODEX_HOME from config even if an extra environment tries to replace it", () => {
    vi.stubEnv("WORKER_CODEX_ENV_ALLOWLIST", "");
    expect(getCodexShellEnv({ codexHome: "/configured-home" } as AppConfig, { CODEX_HOME: "/different-home" }).CODEX_HOME).toBe("/configured-home");
  });

  it("does not copy inherited object properties", () => {
    const source = Object.assign(Object.create({ PATH: "/inherited", APP: "secret" }), { WORKER_PROJECT_ENV_ALLOWLIST: "APP" }) as NodeJS.ProcessEnv;
    expect(buildExecutionEnvironment("project", {}, source, "linux")).toEqual({});
  });

  it("rejects NUL values without including their contents in diagnostics", () => {
    expect(() => buildExecutionEnvironment("project", { APP: "private\0value" }, {})).toThrow("Invalid environment value for APP");
  });

  it("normalizes Windows variables to one case-insensitive key and applies overrides", () => {
    const source = { Path: "C:/bin", PATH: "C:/bin", SystemRoot: "C:/Windows", ComSpec: "C:/Windows/cmd.exe", worker_project_env_allowlist: "App_Url", app_url: "test-url" };
    expect(buildExecutionEnvironment("project", { path: "D:/bin" }, source, "win32")).toEqual({ PATH: "D:/bin", SYSTEMROOT: "C:/Windows", COMSPEC: "C:/Windows/cmd.exe", APP_URL: "test-url" });
  });

  it("rejects conflicting Windows aliases instead of silently choosing a credential/path", () => {
    expect(() => buildExecutionEnvironment("project", {}, { Path: "one", PATH: "two" }, "win32")).toThrow("Ambiguous case-insensitive environment variable");
  });

  it("does not permit casing to bypass reserved names", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(() => buildExecutionEnvironment("project", {}, { WORKER_PROJECT_ENV_ALLOWLIST: "gitlab_token", gitlab_token: "dummy" }, platform)).toThrow("reserved variable");
      expect(() => buildExecutionEnvironment("codex", { node_options: "unsafe" }, {}, platform)).toThrow();
    }
  });

  it("preserves PATH-based executable discovery in a real process", async () => {
    vi.stubEnv("WORKER_PROJECT_ENV_ALLOWLIST", "");
    const result = await runCommand({ command: "node", args: ["-e", "process.stdout.write('path-ok')"], cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("path-ok");
  });
});
