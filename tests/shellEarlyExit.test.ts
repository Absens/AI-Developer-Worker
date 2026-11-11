import { expect, it } from "vitest";
import { runCommand } from "../src/utils/shell.js";
it("reports child exit status instead of crashing when it closes stdin before reading a prompt", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "require('node:fs').closeSync(0); setTimeout(() => { console.error('early exit'); process.exit(7); }, 20)"],
    cwd: process.cwd(), stdin: "x".repeat(4 * 1024 * 1024), timeoutMs: 5000,
  });
  expect(result.exitCode).toBe(7);
  expect(result.stderr).toContain("early exit");
});
