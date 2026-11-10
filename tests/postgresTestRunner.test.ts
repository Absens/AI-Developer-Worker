import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  assertSuccessfulPostgresReport,
  requireTestDatabaseUrl,
} from "../scripts/run-postgres-tests.js";

const report = () => ({
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{ status: "passed", assertionResults: [{ status: "passed" }] }],
});

describe("PostgreSQL test runner safeguards", () => {
  it.each(["127.0.0.1", "localhost", "[::1]"])("accepts explicit loopback test database on %s", (host) => {
    const value = `postgresql://test:test@${host}:5432/ai_developer_ci_test`;
    expect(requireTestDatabaseUrl({ TASK_TRACKER_TEST_DATABASE_URL: value })).toBe(value);
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "postgresql://test:SENTINEL_SECRET@database.example.test/app_test",
    "postgresql://test:SENTINEL_SECRET@127.0.0.1/production",
    "postgresql://test:SENTINEL_SECRET@127.0.0.1/app_test?options=unsafe",
    "postgresql://test:SENTINEL_SECRET@127.0.0.1/app_test#fragment",
    "https://127.0.0.1/app_test",
  ])("rejects missing or unsafe database selection without revealing credentials (%#)", (value) => {
    expect(() => requireTestDatabaseUrl({ TASK_TRACKER_TEST_DATABASE_URL: value })).toThrow();
    try {
      requireTestDatabaseUrl({ TASK_TRACKER_TEST_DATABASE_URL: value });
    } catch (error) {
      expect(String(error)).not.toContain("SENTINEL_SECRET");
    }
  });

  it("accepts only actual passing test evidence", () => {
    expect(assertSuccessfulPostgresReport(report())).toBe(1);
  });

  it.each([
    null,
    {},
    { ...report(), success: false },
    { ...report(), numTotalTests: 0, numPassedTests: 0, testResults: [] },
    { ...report(), numPendingTests: 1 },
    { ...report(), numTodoTests: 1 },
    { ...report(), numPendingTestSuites: 1 },
    { ...report(), numFailedTests: 1 },
    { ...report(), numTotalTests: 2, numPassedTests: 2 },
    { ...report(), testResults: [{ status: "passed", assertionResults: [] }] },
    { ...report(), testResults: [{ status: "passed", assertionResults: [{ status: "pending" }] }] },
    { ...report(), testResults: [{ status: "failed", assertionResults: [{ status: "passed" }] }] },
  ])("rejects skipped, empty or inconsistent JSON evidence (%#)", (value) => {
    expect(() => assertSuccessfulPostgresReport(value)).toThrow();
  });

  it("exits nonzero when the dedicated command has no database URL", () => {
    const env = { ...process.env };
    delete env.TASK_TRACKER_TEST_DATABASE_URL;
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-postgres-tests.ts"], {
      env, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TASK_TRACKER_TEST_DATABASE_URL is required");
  });

  it("exits nonzero when PostgreSQL is unavailable, without printing the URL", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-postgres-tests.ts"], {
      env: {
        ...process.env,
        TASK_TRACKER_TEST_DATABASE_URL: "postgresql://test:SENTINEL_SECRET@127.0.0.1:1/unavailable_test",
      },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("database is unavailable");
    expect(`${result.stdout}${result.stderr}`).not.toContain("SENTINEL_SECRET");
  });
});
