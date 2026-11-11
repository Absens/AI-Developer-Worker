import { describe, expect, it } from "vitest";
import { loadManagedBootstrap } from "../src/domain/settings/bootstrap.js";
import { buildExecutionEnvironment } from "../src/utils/executionEnvironment.js";
const env = { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SETTINGS_WORKSPACE_ROOT: "/tmp/settings-test", TASK_TRACKER_DATABASE_URL: "postgres://test:test@localhost/test", SETTINGS_GITLAB_ORIGINS: "https://gitlab.test" };
describe("managed bootstrap safety", () => {
  it.each([undefined, "short"])("requires a strong bootstrap bearer credential: %s", token => {
    expect(() => loadManagedBootstrap({ ...env, TASK_TRACKER_HUMAN_AUTH_MODE: "bearer", TASK_TRACKER_SYSTEM_TOKEN: token, OBSERVABILITY_HOST: "0.0.0.0" })).toThrow(/32/);
  });
  it("permits a long bearer credential with an explicitly non-loopback server", () => {
    expect(loadManagedBootstrap({ ...env, TASK_TRACKER_HUMAN_AUTH_MODE: "bearer", TASK_TRACKER_SYSTEM_TOKEN: "a".repeat(64), OBSERVABILITY_HOST: "0.0.0.0" }).fleet.repositories).toEqual([]);
  });
  it.each(["project", "git", "codex"] as const)("does not allow forwarding settings encryption keys into %s", profile => {
    const setting = `WORKER_${profile.toUpperCase()}_ENV_ALLOWLIST`;
    expect(() => buildExecutionEnvironment(profile, {}, { ...env, [setting]: "SETTINGS_ENCRYPTION_KEY" })).toThrow(/reserved/);
  });
});
