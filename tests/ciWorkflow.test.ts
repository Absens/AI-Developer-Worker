import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
}

interface Job {
  name: string;
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  "runs-on": string;
  "timeout-minutes": number;
  "continue-on-error"?: boolean;
  steps: Step[];
}

interface Workflow {
  name: string;
  on: Record<string, { branches?: string[]; types?: string[]; paths?: string[]; "paths-ignore"?: string[] } | null>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workflow = parse(source) as Workflow;
const requiredJobs = ["backend", "web", "web_e2e", "postgres"];
const job = (id: string): Job => {
  const found = workflow.jobs[id];
  if (!found) throw new Error(`Missing CI job: ${id}`);
  return found;
};
const commands = (id: string): string[] => job(id).steps.flatMap((step) => step.run ? [step.run] : []);
const gate = job("required").steps[0];
const gateScript = gate?.run?.match(/<<'NODE'\n([\s\S]*?)\nNODE\s*$/)?.[1];
if (!gateScript) throw new Error("Missing executable required-checks gate");

const runGate = (results: string) => spawnSync(process.execPath, ["--input-type=module", "-e", gateScript], {
  encoding: "utf8",
  timeout: 10_000,
  env: { ...process.env, CI_JOB_RESULTS: results },
});

const statuses = ["success", "failure", "cancelled", "skipped"];
interface GateCase {
  label: string;
  results: Record<string, { result: string }>;
  success: boolean;
}
// Exercise all 4^4 combinations, including PostgreSQL failures/skips/cancellation.
const gateCases = requiredJobs.reduce<GateCase[]>((cases, id) =>
  cases.flatMap((entry) => statuses.map((status) => ({
    label: `${entry.label}/${id}=${status}`,
    results: { ...entry.results, [id]: { result: status } },
    success: entry.success && status === "success",
  }))),
[{ label: "", results: {}, success: true }]);

describe("CI foundation contract", () => {
  it("runs on main PRs, main pushes, merge queues and manual dispatch without path filters", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["merge_group", "pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on.pull_request?.branches).toEqual(["main"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.merge_group?.types).toEqual(["checks_requested"]);
    for (const event of Object.values(workflow.on)) {
      expect(event?.paths).toBeUndefined();
      expect(event?.["paths-ignore"]).toBeUndefined();
    }
  });

  it("uses read-only permissions, SHA-pinned official actions and no production secrets", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/secrets\./);
    expect(Object.keys(workflow.jobs).sort()).toEqual(["backend", "postgres", "required", "web", "web_e2e"]);
    for (const [id, current] of Object.entries(workflow.jobs)) {
      expect(current["runs-on"]).toBe("ubuntu-24.04");
      expect(current["timeout-minutes"]).toBeGreaterThan(0);
      expect(current["timeout-minutes"]).toBeLessThanOrEqual(30);
      expect(current["continue-on-error"]).toBeUndefined();
      expect(current.permissions).toEqual(id === "required" ? {} : undefined);
      for (const step of current.steps) {
        expect(step["continue-on-error"]).toBeUndefined();
        if (!step.uses) continue;
        expect(step.uses).toMatch(/^actions\/(checkout|setup-node|upload-artifact)@[a-f0-9]{40}$/);
        if (step.uses.startsWith("actions/checkout@")) {
          expect(step.with?.["persist-credentials"]).toBe(false);
          expect(step.with?.ref).toBeUndefined();
        }
      }
    }
  });

  it("cancels only superseded runs of the same event and ref or pull request", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow.concurrency.group).toContain("github.workflow");
    expect(workflow.concurrency.group).toContain("github.event_name");
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number || github.ref");
  });

  it("checks backend types, all unit/smoke tests and production build", () => {
    expect(commands("backend")).toEqual(["npm ci", "npm run typecheck", "npm test", "npm run build"]);
  });

  it("installs both lockfiles and checks Angular types, unit tests and build", () => {
    const steps = commands("web");
    expect(steps.slice(0, 2)).toEqual(["npm ci", "npm --prefix web ci"]);
    expect(steps).toEqual(expect.arrayContaining(["npm run web:typecheck", "npm run web:test", "npm run web:build"]));
    expect(steps.join("\n")).toContain("CHROME_BIN");
  });

  it.each(requiredJobs)("uses Node 22 and lockfile-aware npm caching for %s", (id) => {
    const setup = job(id).steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setup?.with?.["node-version"]).toBe("22");
    expect(setup?.with?.cache).toBe("npm");
    const files = String(setup?.with?.["cache-dependency-path"]).trim().split(/\s+/);
    expect(files).toEqual(["backend", "postgres"].includes(id) ? ["package-lock.json"] : ["package-lock.json", "web/package-lock.json"]);
  });

  it("runs real Chromium E2E against the existing mock server and forbids test.only", () => {
    expect(commands("web_e2e").slice(0, 2)).toEqual(["npm ci", "npm --prefix web ci"]);
    const install = job("web_e2e").steps.find((step) => step.run?.includes("playwright install"));
    expect(install?.["working-directory"]).toBe("web");
    expect(install?.run).toBe("npx --no-install playwright install --with-deps chromium");
    expect(commands("web_e2e")).toContain("npm --prefix web run e2e -- --reporter=list,html --forbid-only");
  });

  it("keeps only browser diagnostics with bounded retention even after test failure", () => {
    const upload = job("web_e2e").steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("${{ !cancelled() }}");
    expect(String(upload?.with?.path).trim().split(/\s+/)).toEqual(["web/playwright-report/", "web/test-results/"]);
    expect(upload?.with?.["retention-days"]).toBe(7);
    expect(upload?.with?.["include-hidden-files"]).toBe(false);
    expect(upload?.with?.["if-no-files-found"]).toBe("warn");
  });

  it("always evaluates every required dependency under a stable check name", () => {
    expect(job("required").name).toBe("CI required");
    expect(job("required").if).toBe("${{ always() }}");
    expect(job("required").needs).toEqual(requiredJobs);
    expect(gate?.env).toEqual({ CI_JOB_RESULTS: "${{ toJSON(needs) }}" });
  });

  it.each(gateCases)("required gate handles $label", ({ results, success }) => {
    const result = runGate(JSON.stringify(results));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(success ? 0 : 1);
  });

  it.each(["{}", "null", "{", '{"backend":{"result":"success"},"web":{"result":"success"}}', '{"backend":{"result":"success"},"web":{"result":"success"},"web_e2e":{"result":"success"}}'])(
    "rejects missing or malformed job results: %s",
    (input) => {
      const result = runGate(input);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
    },
  );
});
