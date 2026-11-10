import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Only an explicitly selected, disposable local test database may be used. */
export const requireTestDatabaseUrl = (env: NodeJS.ProcessEnv): string => {
  const value = env.TASK_TRACKER_TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new Error("TASK_TRACKER_TEST_DATABASE_URL is required; PostgreSQL tests must not be skipped.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid PostgreSQL test URL; its value is intentionally not logged.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("PostgreSQL tests require a loopback URL, a database ending in _test, and no URL query or fragment.");
  }
  return value;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

/** Exit code zero alone is insufficient: empty, skipped and todo runs fail closed. */
export const assertSuccessfulPostgresReport = (value: unknown): number => {
  const report = object(value);
  const total = report?.numTotalTests;
  if (
    !report || report.success !== true || typeof total !== "number" ||
    !Number.isInteger(total) || total <= 0 ||
    report.numPassedTests !== total || report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 || (report.numTodoTests ?? 0) !== 0 ||
    (report.numPendingTestSuites ?? 0) !== 0 ||
    !Array.isArray(report.testResults) || report.testResults.length === 0
  ) {
    throw new Error("PostgreSQL report must contain successful tests with no failures, skipped tests or todo entries.");
  }
  let assertions = 0;
  for (const entry of report.testResults) {
    const suite = object(entry);
    if (
      !suite || suite.status !== "passed" ||
      !Array.isArray(suite.assertionResults) || suite.assertionResults.length === 0
    ) {
      throw new Error("Every PostgreSQL test file must contain executed passing assertions.");
    }
    for (const assertion of suite.assertionResults) {
      if (object(assertion)?.status !== "passed") {
        throw new Error("Skipped, todo or failed PostgreSQL assertions are forbidden.");
      }
      assertions += 1;
    }
  }
  if (assertions !== total) {
    throw new Error("PostgreSQL report assertion count does not match the reported test count.");
  }
  return total;
};

export const runPostgresTests = async (): Promise<void> => {
  const connectionString = requireTestDatabaseUrl(process.env);
  const probe = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
  });
  try {
    await probe.query("SELECT 1");
  } catch {
    throw new Error("PostgreSQL test database is unavailable; no tests were skipped. Check the disposable service and credentials.");
  } finally {
    await probe.end();
  }

  const directory = mkdtempSync(join(tmpdir(), "postgres-test-report-"));
  try {
    const reportFile = join(directory, "results.json");
    const result = spawnSync(process.execPath, [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run", "--config", "vitest.postgres.config.ts",
      "--reporter=default", "--reporter=json", `--outputFile=${reportFile}`,
    ], { cwd: root, env: process.env, stdio: "inherit", timeout: 180_000 });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error("PostgreSQL integration test process failed or timed out.");
    }
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(reportFile, "utf8"));
    } catch {
      throw new Error("PostgreSQL tests did not produce a valid JSON report.");
    }
    const count = assertSuccessfulPostgresReport(report);
    console.log(`PostgreSQL integration gate passed: ${count} tests executed, zero skipped.`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPostgresTests().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PostgreSQL test runner failed.");
    process.exitCode = 1;
  });
}
