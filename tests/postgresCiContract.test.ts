import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = () => parse(readFileSync(".github/workflows/ci.yml", "utf8"));

describe("required PostgreSQL integration CI contract", () => {
  it("runs a real PostgreSQL service and the dedicated test command", () => {
    const job = workflow().jobs.postgres;
    expect(job, "PostgreSQL must be an explicit CI job").toBeDefined();
    expect(job.services.postgres.image).toMatch(/^postgres:16/);
    expect(job.services.postgres.options).toContain("pg_isready");
    expect(job.env.TASK_TRACKER_TEST_DATABASE_URL).toContain("ai_developer_ci_test");
    expect(job.steps.some((step: { run?: string }) => step.run === "npm run test:postgres")).toBe(true);
    expect(job["continue-on-error"]).not.toBe(true);
  });

  it("makes PostgreSQL mandatory in both the dependency graph and final gate", () => {
    const gate = workflow().jobs.required;
    expect(gate.needs).toContain("postgres");
    const script = gate.steps.find((step: { run?: string }) => step.run?.includes("const required"))?.run;
    expect(script).toContain('"postgres"');
    expect(script).toContain('result !== "success"');
  });

  it("provides an explicit fail-closed local entrypoint instead of relying on optional database tests", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["test:postgres"]).toBe("node --import tsx scripts/run-postgres-tests.ts");
  });
});
