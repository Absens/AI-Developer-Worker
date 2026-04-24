import { describe, expect, it } from "vitest";

import { runCommand } from "../src/utils/shell.js";

describe("shell utilities", () => {
  it("keeps only the tail of large stdout and stderr buffers", async () => {
    const stdoutChunks: string[] = [];
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('a'.repeat(20)); process.stderr.write('b'.repeat(20));",
      ],
      cwd: process.cwd(),
      maxBufferBytes: 5,
      onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("aaaaa");
    expect(result.stderr).toBe("bbbbb");
    expect(stdoutChunks.join("")).toBe("a".repeat(20));
  });

  it("marks a command as timed out and returns exit code 124", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });
});
