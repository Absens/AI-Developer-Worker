#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codexCommand = process.env.CODEX_CLI_COMMAND || process.env.CODEX_COMMAND || "codex";

const parseStringArrayEnv = (key) => {
  const rawValue = process.env[key]?.trim();
  if (!rawValue) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${key} must be valid JSON. ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be a JSON array of strings.`);
  }
  return parsed;
};

const codexCliArgs = parseStringArrayEnv("CODEX_CLI_ARGS_JSON");

const staticChecks = [
  {
    display: "codex --version",
    args: ["--version"],
    markers: [],
  },
  {
    display: "codex exec --help",
    args: ["exec", "--help"],
    markers: [
      "Usage: codex exec",
      "--json",
      "--output-last-message",
      "--image",
      "--model",
      "--profile",
      "--sandbox",
      "--skip-git-repo-check",
      "-C",
      "--cd",
    ],
  },
  {
    display: "codex exec resume --help",
    args: ["exec", "resume", "--help"],
    markers: [
      "Usage: codex exec resume",
      "--image",
      "--json",
      "--output-last-message",
    ],
  },
  {
    display: "codex exec review --help",
    args: ["exec", "review", "--help"],
    markers: [
      "Usage: codex exec review",
      "--base",
      "--uncommitted",
      "--json",
      "--output-last-message",
      "--skip-git-repo-check",
      "--ephemeral",
    ],
  },
  {
    display: "codex login status --help",
    args: ["login", "status", "--help"],
    markers: ["Usage: codex login status"],
  },
];

const runCodex = (args, input) => {
  const result = spawnSync(codexCommand, [...codexCliArgs, ...args], {
    encoding: "utf8",
    env: process.env,
    input,
    shell: process.platform === "win32",
    windowsHide: true,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
    error: result.error,
    signal: result.signal,
  };
};

const formatFailureOutput = (result) =>
  [
    result.error ? `error: ${result.error.message}` : "",
    result.signal ? `signal: ${result.signal}` : "",
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

const assertCommandSucceeded = (display, result) => {
  if (result.exitCode !== 0 || result.error) {
    const details = formatFailureOutput(result);
    throw new Error(
      [`${display} failed with exit code ${result.exitCode}.`, details].filter(Boolean).join("\n\n"),
    );
  }
};

const assertMarkers = (display, output, markers) => {
  const missing = markers.filter((marker) => !output.includes(marker));
  if (missing.length > 0) {
    throw new Error(
      `${display} is missing required marker(s): ${missing.map((marker) => JSON.stringify(marker)).join(", ")}`,
    );
  }
};

const runStaticChecks = () => {
  for (const check of staticChecks) {
    const result = runCodex(check.args);
    assertCommandSucceeded(check.display, result);
    assertMarkers(check.display, `${result.stdout}\n${result.stderr}`, check.markers);
    const firstLine = result.stdout.trim().split(/\r?\n/).find(Boolean);
    console.log(`[ok] ${check.display}${firstLine ? `: ${firstLine}` : ""}`);
  }
};

const parseJsonl = (stdout) => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("live codex exec produced no JSONL stdout lines.");
  }

  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(
        `live codex exec stdout line is not valid JSON: ${line}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
};

const runLiveCheck = () => {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-contract-"));
  const outputPath = join(tempDir, "last-message.txt");
  try {
    const result = runCodex(
      [
        "exec",
        "--json",
        "--output-last-message",
        outputPath,
        "-C",
        tempDir,
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
      ],
      "Return exactly OK.",
    );
    assertCommandSucceeded("codex exec live contract probe", result);

    const events = parseJsonl(result.stdout);
    if (!events.some((event) => event?.type === "thread.started")) {
      throw new Error("live codex exec JSONL did not include a thread.started event.");
    }

    if (!existsSync(outputPath)) {
      throw new Error("live codex exec did not create the --output-last-message file.");
    }

    if (readFileSync(outputPath, "utf8").trim() === "") {
      throw new Error("live codex exec created an empty --output-last-message file.");
    }

    console.log("[ok] codex exec live contract probe");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

try {
  runStaticChecks();
  if (process.env.CODEX_CONTRACT_LIVE === "1") {
    runLiveCheck();
  } else {
    console.log("[skip] live codex exec probe; set CODEX_CONTRACT_LIVE=1 to enable it.");
  }
  console.log("Codex CLI contract verified.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
