import { describe, expect, it } from "vitest";

import {
  SELF_REVIEW_MARKER,
  buildSelfReviewPrompt,
  formatSelfReviewDiagnostic,
  parseSelfReviewResult,
} from "../src/domain/selfReview.js";
import type { TrackerIssue, ValidationResult } from "../src/models/types.js";

const issue: TrackerIssue = {
  id: "1",
  key: "DEV-1",
  title: "Fix checkout crash",
  description: "Null cart crashes checkout.",
  queue: "BACKEND",
  tags: ["ai_dev"],
};

const validation: ValidationResult = {
  changed: true,
  testsPassed: true,
  lintPassed: true,
  gates: [
    {
      id: "tests",
      label: "Tests",
      command: "npm test",
      status: "passed",
      exitCode: 0,
      diagnostic: "Tests passed.",
    },
  ],
  diagnostic: "",
};

describe("selfReview", () => {
  it("builds strict review instructions with the marker contract", () => {
    const prompt = buildSelfReviewPrompt({
      issue,
      baseBranch: "main",
      validation,
      implementationSummary: "Fixed checkout null handling.",
    });

    expect(prompt).toContain("Review the diff against base branch `main`.");
    expect(prompt).toContain("DEV-1");
    expect(prompt).toContain(SELF_REVIEW_MARKER);
    expect(prompt).toContain('"status": "pass"');
    expect(prompt).toContain('"status": "fail"');
    expect(prompt).toContain("Fail only for blocking");
  });

  it("parses a passing self-review result", () => {
    const result = parseSelfReviewResult(
      `${SELF_REVIEW_MARKER} {"status":"pass","summary":"No blocking issues.","findings":[]}`,
    );

    expect(result).toEqual({
      status: "pass",
      passed: true,
      summary: "No blocking issues.",
      findings: [],
    });
  });

  it("parses a failing self-review result with findings", () => {
    const result = parseSelfReviewResult(
      `${SELF_REVIEW_MARKER} {"status":"fail","summary":"One blocking issue.","findings":[{"severity":"blocking","title":"Null total still crashes","details":"src/cart.ts can still read total from null.","file":"src/cart.ts","line":42,"recommendation":"Guard the total before formatting."}]}`,
    );

    expect(result?.passed).toBe(false);
    expect(result?.findings[0]).toMatchObject({
      severity: "blocking",
      title: "Null total still crashes",
      file: "src/cart.ts",
      line: 42,
    });
  });

  it("returns undefined for invalid or missing marker output", () => {
    expect(parseSelfReviewResult("No issues found.")).toBeUndefined();
    expect(parseSelfReviewResult(`${SELF_REVIEW_MARKER} {"status":"maybe"}`)).toBeUndefined();
  });

  it("formats failing findings into a fix diagnostic", () => {
    const result = parseSelfReviewResult(
      `${SELF_REVIEW_MARKER} {"status":"fail","summary":"One blocking issue.","findings":[{"severity":"blocking","title":"Missing rollback","details":"The migration failure path leaves partial writes.","recommendation":"Wrap the operation in a transaction."}]}`,
    );

    expect(result).toBeDefined();
    expect(formatSelfReviewDiagnostic(result!)).toContain("Codex self-review failed.");
    expect(formatSelfReviewDiagnostic(result!)).toContain("Missing rollback");
    expect(formatSelfReviewDiagnostic(result!)).toContain("Wrap the operation in a transaction.");
  });
});
