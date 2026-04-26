import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type {
  AppConfig,
  ProcessResult,
  QualityGate,
  QualityGateResult,
} from "../models/types.js";
import type { Logger } from "../utils/logger.js";
import { runShellCommand } from "../utils/shell.js";

export type QualityGateCommandRunner = (
  command: string,
  options: { cwd: string },
) => Promise<ProcessResult>;

interface QualityGateRunOptions {
  cwd: string;
  logger?: Logger;
  commandRunner?: QualityGateCommandRunner;
}

const LOG_OUTPUT_LIMIT = 2_000;

const trimOptional = (value: string | undefined): string => value?.trim() ?? "";

const truncateForLog = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= LOG_OUTPUT_LIMIT) {
    return trimmed;
  }

  return `${trimmed.slice(0, LOG_OUTPUT_LIMIT)}\n[output truncated after ${LOG_OUTPUT_LIMIT} characters]`;
};

const resolveReportPath = (cwd: string, reportFile: string): string =>
  isAbsolute(reportFile) ? reportFile : resolve(cwd, reportFile);

const formatPercent = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

const parseCoveragePercent = (rawValue: string): number | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return undefined;
  }

  const total = (parsed as { total?: unknown }).total;
  if (typeof total !== "object" || total === null) {
    return undefined;
  }

  const lines = (total as { lines?: unknown }).lines;
  if (typeof lines !== "object" || lines === null) {
    return undefined;
  }

  const pct = (lines as { pct?: unknown }).pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    return undefined;
  }

  return pct;
};

const commandFailureDiagnostic = (
  gate: QualityGate,
  result: ProcessResult,
): string =>
  [
    `Quality gate "${gate.label}" (${gate.id}) failed with exit code ${result.exitCode}.`,
    `Command: ${gate.command}`,
    gate.id === "build"
      ? "Build is not a test failure, but it blocks publishing."
      : "",
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

const coverageParseFailureDiagnostic = (
  gate: QualityGate,
  source: string,
): string =>
  [
    `Quality gate "${gate.label}" (${gate.id}) failed.`,
    `Command: ${gate.command}`,
    `Coverage command completed successfully, but coverage summary could not be parsed from ${source}.`,
    'Expected Istanbul/Vitest JSON shape: {"total":{"lines":{"pct":82.5}}}.',
  ].join("\n\n");

export const buildQualityGates = (config: AppConfig): QualityGate[] => [
  {
    id: "typecheck",
    label: "Type Check",
    command: trimOptional(config.typeCheckCommand),
    required: false,
  },
  {
    id: "lint",
    label: "Lint",
    command: config.lintCommand,
    required: true,
  },
  {
    id: "tests",
    label: "Tests",
    command: config.testCommand,
    required: true,
  },
  {
    id: "build",
    label: "Build",
    command: trimOptional(config.buildCommand),
    required: false,
  },
  {
    id: "security_scan",
    label: "Security Scan",
    command: trimOptional(config.securityScanCommand),
    required: false,
  },
  {
    id: "sast",
    label: "SAST",
    command: trimOptional(config.sastCommand),
    required: false,
  },
  {
    id: "coverage",
    label: "Coverage",
    command: trimOptional(config.coverageCommand),
    required: false,
  },
  {
    id: "visual_regression",
    label: "Visual Regression",
    command: trimOptional(config.visualRegressionCommand),
    required: false,
    ...(trimOptional(config.visualRegressionCommand) && config.visualRegressionArtifactsDir
      ? { artifactPath: config.visualRegressionArtifactsDir }
      : {}),
  },
];

export const hasFailedQualityGate = (results: QualityGateResult[]): boolean =>
  results.some((result) => result.status === "failed");

export const qualityGatesPassed = (results: QualityGateResult[]): boolean =>
  !hasFailedQualityGate(results);

export const qualityGateStatus = (
  results: QualityGateResult[],
  id: string,
): QualityGateResult["status"] | undefined =>
  results.find((result) => result.id === id)?.status;

const evaluateCoverageResult = (
  gate: QualityGate,
  processResult: ProcessResult,
  config: AppConfig,
  cwd: string,
  baseResult: QualityGateResult,
): QualityGateResult => {
  let rawCoverage = "";
  let source = "stdout";

  if (config.coverageReportFile) {
    const reportPath = resolveReportPath(cwd, config.coverageReportFile);
    source = reportPath;
    if (!existsSync(reportPath)) {
      return {
        ...baseResult,
        status: "failed",
        diagnostic: [
          `Quality gate "${gate.label}" (${gate.id}) failed.`,
          `Command: ${gate.command}`,
          `Coverage report file was not found at ${reportPath}.`,
          'Expected Istanbul/Vitest JSON shape: {"total":{"lines":{"pct":82.5}}}.',
        ].join("\n\n"),
      };
    }

    rawCoverage = readFileSync(reportPath, "utf8");
  } else {
    rawCoverage = processResult.stdout;
  }

  const coveragePercent = parseCoveragePercent(rawCoverage);
  if (coveragePercent === undefined) {
    return {
      ...baseResult,
      status: "failed",
      diagnostic: coverageParseFailureDiagnostic(gate, source),
    };
  }

  const threshold = config.minCoveragePercent;
  if (threshold !== undefined && coveragePercent < threshold) {
    return {
      ...baseResult,
      status: "failed",
      coveragePercent,
      coverageThreshold: threshold,
      diagnostic: [
        `Quality gate "${gate.label}" (${gate.id}) failed.`,
        `Command: ${gate.command}`,
        `Lines coverage ${formatPercent(coveragePercent)}% is below the required ${formatPercent(threshold)}%.`,
      ].join("\n\n"),
    };
  }

  return {
    ...baseResult,
    status: "passed",
    coveragePercent,
    ...(threshold !== undefined ? { coverageThreshold: threshold } : {}),
    diagnostic:
      threshold !== undefined
        ? `Lines coverage ${formatPercent(coveragePercent)}% meets the required ${formatPercent(threshold)}%.`
        : `Lines coverage ${formatPercent(coveragePercent)}% parsed successfully. No minimum threshold configured.`,
  };
};

const buildSkippedResult = (
  gate: QualityGate,
  diagnostic: string,
): QualityGateResult => ({
  id: gate.id,
  label: gate.label,
  command: gate.command,
  status: "skipped",
  ...(gate.artifactPath ? { artifactPath: gate.artifactPath } : {}),
  diagnostic,
});

const logGateResult = (logger: Logger | undefined, result: QualityGateResult): void => {
  if (!logger) {
    return;
  }

  const context = {
    gateId: result.id,
    command: result.command,
    durationMs: result.durationMs ?? 0,
    status: result.status,
    ...(result.status === "failed"
      ? {
          stdout: result.stdout ? truncateForLog(result.stdout) : "",
          stderr: result.stderr ? truncateForLog(result.stderr) : "",
        }
      : {}),
  };

  if (result.status === "failed") {
    logger.warn("Quality gate failed.", context);
    return;
  }

  logger.info("Quality gate completed.", context);
};

export const runQualityGates = async (
  config: AppConfig,
  options: QualityGateRunOptions,
): Promise<QualityGateResult[]> => {
  const commandRunner = options.commandRunner ?? runShellCommand;
  const results: QualityGateResult[] = [];
  let failedGate: QualityGateResult | undefined;

  for (const gate of buildQualityGates(config)) {
    if (failedGate) {
      const skipped = buildSkippedResult(
        gate,
        `blocked by failed quality gate "${failedGate.label}" (${failedGate.id})`,
      );
      results.push(skipped);
      logGateResult(options.logger, skipped);
      continue;
    }

    if (!gate.command) {
      const skipped = buildSkippedResult(
        gate,
        gate.required
          ? "no command configured"
          : "not configured",
      );
      results.push(skipped);
      logGateResult(options.logger, skipped);
      continue;
    }

    const startedAt = Date.now();
    const processResult = await commandRunner(gate.command, { cwd: options.cwd });
    const durationMs = Date.now() - startedAt;
    const baseResult: QualityGateResult = {
      id: gate.id,
      label: gate.label,
      command: gate.command,
      status: processResult.exitCode === 0 ? "passed" : "failed",
      exitCode: processResult.exitCode,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      durationMs,
      ...(gate.artifactPath ? { artifactPath: gate.artifactPath } : {}),
      diagnostic:
        processResult.exitCode === 0
          ? `${gate.label} passed.`
          : commandFailureDiagnostic(gate, processResult),
    };

    const result =
      processResult.exitCode === 0 && gate.id === "coverage"
        ? evaluateCoverageResult(gate, processResult, config, options.cwd, baseResult)
        : baseResult;

    results.push(result);
    logGateResult(options.logger, result);
    if (result.status === "failed") {
      failedGate = result;
    }
  }

  return results;
};

export const formatQualityGateDiagnostics = (
  results: QualityGateResult[],
): string =>
  results
    .filter((result) => result.status === "failed")
    .map((result) => result.diagnostic)
    .join("\n\n");

const formatCoverageSummary = (result: QualityGateResult): string | undefined => {
  if (result.coveragePercent === undefined) {
    return undefined;
  }

  if (result.coverageThreshold === undefined) {
    return `lines coverage ${formatPercent(result.coveragePercent)}%`;
  }

  const comparator =
    result.coveragePercent >= result.coverageThreshold ? ">=" : "<";
  return `lines coverage ${formatPercent(result.coveragePercent)}% ${comparator} ${formatPercent(result.coverageThreshold)}%`;
};

const formatGateResultLine = (result: QualityGateResult): string => {
  const command = result.command ? ` (\`${result.command}\`)` : "";
  const coverage = formatCoverageSummary(result);
  const artifacts = result.artifactPath ? `artifacts: \`${result.artifactPath}\`` : "";
  const suffix = [coverage, artifacts].filter(Boolean).join("; ");

  if (result.status === "skipped") {
    return `- ${result.label}${command}: skipped (${result.diagnostic})`;
  }

  return `- ${result.label}${command}: ${
    suffix ? `${result.status} (${suffix})` : result.status
  }`;
};

export const formatQualityGateSummary = (results: QualityGateResult[]): string =>
  results.length > 0
    ? results.map(formatGateResultLine).join("\n")
    : "- Quality gates were not run.";

export const collectQualityGateNotes = (results: QualityGateResult[]): string[] =>
  results
    .filter((result) => result.artifactPath)
    .map(
      (result) =>
        `${result.label} artifacts: \`${result.artifactPath ?? ""}\` (${result.status}).`,
    );
