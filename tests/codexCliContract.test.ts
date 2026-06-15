import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "codex-contract-test-"));
  tempDirs.push(path);
  return path;
};

const createFakeCodexScript = (
  tempDir: string,
  options: {
    missingResumeJson?: boolean;
    missingReviewOutputLastMessage?: boolean;
    missingReviewUncommitted?: boolean;
  } = {},
): string => {
  const scriptPath = join(tempDir, "fake-codex.cjs");
  writeFileSync(
    scriptPath,
    [
      "const args = process.argv.slice(2).join(' ');",
      "const outputs = {",
      "  '--version': 'codex-cli 0.139.0\\n',",
      "  'exec --help': 'Usage: codex exec\\n--json\\n--output-last-message\\n--image\\n--model\\n--profile\\n--sandbox\\n--skip-git-repo-check\\n-C\\n--cd\\n',",
      options.missingResumeJson
        ? "  'exec resume --help': 'Usage: codex exec resume\\n--image\\n--output-last-message\\n',"
        : "  'exec resume --help': 'Usage: codex exec resume\\n--image\\n--json\\n--output-last-message\\n',",
      options.missingReviewOutputLastMessage
        ? "  'exec review --help': 'Usage: codex exec review\\n--base\\n--uncommitted\\n--json\\n--skip-git-repo-check\\n--ephemeral\\n',"
        : options.missingReviewUncommitted
          ? "  'exec review --help': 'Usage: codex exec review\\n--base\\n--json\\n--output-last-message\\n--skip-git-repo-check\\n--ephemeral\\n',"
          : "  'exec review --help': 'Usage: codex exec review\\n--base\\n--uncommitted\\n--json\\n--output-last-message\\n--skip-git-repo-check\\n--ephemeral\\n',",
      "  'login status --help': 'Usage: codex login status\\n',",
      "};",
      "if (!Object.prototype.hasOwnProperty.call(outputs, args)) {",
      "  console.error(`unexpected args: ${args}`);",
      "  process.exit(2);",
      "}",
      "process.stdout.write(outputs[args]);",
    ].join("\n"),
    "utf8",
  );

  return scriptPath;
};

const createFakeCodexCommand = (
  tempDir: string,
  options: {
    missingResumeJson?: boolean;
    missingReviewOutputLastMessage?: boolean;
    missingReviewUncommitted?: boolean;
  } = {},
): string => {
  const scriptPath = createFakeCodexScript(tempDir, options);

  if (process.platform === "win32") {
    const commandPath = join(tempDir, "codex.cmd");
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }

  const commandPath = join(tempDir, "codex");
  writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf8");
  chmodSync(commandPath, 0o755);
  return commandPath;
};

const runVerifier = (codexCommand: string) =>
  spawnSync(process.execPath, [join(process.cwd(), "scripts", "verify-codex-cli-contract.mjs")], {
    env: {
      ...process.env,
      CODEX_COMMAND: codexCommand,
      CODEX_CONTRACT_LIVE: "",
    },
    encoding: "utf8",
  });

const runVerifierWithEnv = (env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [join(process.cwd(), "scripts", "verify-codex-cli-contract.mjs")], {
    env: {
      ...process.env,
      CODEX_CONTRACT_LIVE: "",
      ...env,
    },
    encoding: "utf8",
  });

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("Codex CLI contract verifier", () => {
  it("passes when static help output includes all required markers", () => {
    const tempDir = createTempDir();
    const result = runVerifier(createFakeCodexCommand(tempDir));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Codex CLI contract verified");
  }, 15_000);

  it("fails when resume help output is missing required markers", () => {
    const tempDir = createTempDir();
    const result = runVerifier(createFakeCodexCommand(tempDir, { missingResumeJson: true }));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("codex exec resume --help");
    expect(`${result.stdout}\n${result.stderr}`).toContain("--json");
  });

  it("fails when review help output is missing required markers", () => {
    const tempDir = createTempDir();
    const result = runVerifier(
      createFakeCodexCommand(tempDir, { missingReviewOutputLastMessage: true }),
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("codex exec review --help");
    expect(`${result.stdout}\n${result.stderr}`).toContain("--output-last-message");
  });

  it("fails when review help output cannot include uncommitted changes", () => {
    const tempDir = createTempDir();
    const result = runVerifier(createFakeCodexCommand(tempDir, { missingReviewUncommitted: true }));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("codex exec review --help");
    expect(`${result.stdout}\n${result.stderr}`).toContain("--uncommitted");
  });

  it("prefers CODEX_CLI_COMMAND over the legacy CODEX_COMMAND override", () => {
    const tempDir = createTempDir();
    const result = runVerifierWithEnv({
      CODEX_COMMAND: join(tempDir, "missing-codex"),
      CODEX_CLI_COMMAND: createFakeCodexCommand(tempDir),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Codex CLI contract verified");
  }, 15_000);

  it("passes CODEX_CLI_ARGS_JSON before the Codex subcommand", () => {
    const tempDir = createTempDir();
    const result = runVerifierWithEnv({
      CODEX_CLI_COMMAND: "node",
      CODEX_CLI_ARGS_JSON: JSON.stringify([createFakeCodexScript(tempDir)]),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Codex CLI contract verified");
  }, 15_000);
});
