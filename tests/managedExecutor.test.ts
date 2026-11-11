import { expect, it, vi } from "vitest";
import { checkManagedExecutor } from "../src/domain/settings/executorReadiness.js";
const base = { command: "codex", args: [], cwd: "/tmp/project", env: { PATH: "/usr/bin", CODEX_HOME: "/codex-home" } };
it("bounds local CLI checks, never calls a real model", async () => {
  const calls: any[] = [];
  await checkManagedExecutor(base, async input => { calls.push(input); return { exitCode: 0, stdout: "", stderr: "" }; });
  expect(calls.map(call => call.args)).toEqual([["--version"], ["login", "status"]]);
  expect(calls.every(call => call.timeoutMs === 15_000 && call.maxBufferBytes === 4096)).toBe(true);
});
it("checks executable even for API-key auth without printing command output", async () => {
  const run = vi.fn(async () => ({ exitCode: 1, stdout: "credential-sensitive-output", stderr: "" }));
  await expect(checkManagedExecutor({ ...base, env: { CODEX_API_KEY: "test-key" } }, run)).rejects.toThrow("Исполнитель недоступен");
  expect(run).toHaveBeenCalledTimes(1);
});
it("does not regard a timeout as a ready executor", async () => {
  await expect(checkManagedExecutor(base, async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: true }))).rejects.toThrow();
});
