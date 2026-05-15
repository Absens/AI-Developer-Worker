# Codex Self-Review Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Codex-powered self-review gate that runs `codex exec review` after normal quality gates and before publishing a merge request.

**Architecture:** Keep the existing process-per-run Codex wrapper. Add a `runReview` path to `CliCodexRunner`, parse a small structured `AI_SELF_REVIEW:` result in the domain layer, and let `WorkerOrchestrator` either publish, ask Codex to fix blocking review findings, or fail before creating/updating the MR. The feature is off by default and controlled by config so production behavior does not change until enabled.

**Tech Stack:** Node.js, TypeScript, Vitest, Codex CLI `0.130.0`, existing `runCommand` shell wrapper, existing Tracker/GitLab orchestration.

---

## Context And Constraints

- Do not move to alpha Codex releases. Keep Docker pin and docs on `@openai/codex@0.130.0`.
- Use `codex exec review`, not top-level `codex review`, because `codex exec review --help` supports `--json` and `--output-last-message`.
- Do not replace GitLab/human review. This gate catches obvious correctness, security, data-loss, and regression risks before publishing.
- Do not run the gate by default. New default is disabled.
- When enabled, run this sequence:
  1. Codex implementation or reuse existing repository state.
  2. Existing quality gates.
  3. Codex self-review against `baseBranch`.
  4. If self-review passes, publish.
  5. If self-review fails, send findings through the existing Codex fix loop, rerun quality gates, then rerun self-review.
  6. If findings remain after configured attempts, fail the task before publishing.
- Review command should be ephemeral because we do not resume review sessions.
- Existing analysis/implementation thread should be used for fixes when available; the review session is only a reviewer, not the implementation thread.

## File Structure

- Modify `src/models/types.ts`
  - Add self-review config fields to `AppConfig` and `CodexGlobalConfig`.
  - Add `CodexReviewRunOptions`.
  - Extend `CodexProgressEvent.mode` with `"review"`.
  - Add `runReview` to `CodexRunner`.
- Modify `src/config.ts`
  - Parse `CODEX_SELF_REVIEW_ENABLED`.
  - Parse `CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS`.
  - Parse matching `codex.selfReviewEnabled` and `codex.selfReviewMaxFixAttempts` from fleet config.
- Create `src/domain/selfReview.ts`
  - Build the review prompt.
  - Parse `AI_SELF_REVIEW:` output.
  - Format a diagnostic usable by the existing fix prompt and failure memory.
- Modify `src/integrations/codex/runner.ts`
  - Add `runReview`.
  - Add review-specific argv builder for `codex exec review`.
  - Reuse JSONL parsing, heartbeat, logging, timeout, and `--output-last-message`.
- Modify `src/domain/preflight.ts`
  - When self-review is enabled, verify that `codex exec review --help` exposes the required flags.
- Modify `scripts/verify-codex-cli-contract.mjs`
  - Add static contract markers for `codex exec review --help`.
- Modify `src/observability/events.ts`
  - Add `self_review_started` and `self_review_completed` event types.
- Modify `src/domain/orchestrator.ts`
  - Insert the self-review gate after successful quality gates and before publish.
  - Use existing fix prompt path when review fails.
- Modify tests:
  - `tests/config.test.ts`
  - `tests/selfReview.test.ts`
  - `tests/codexRunner.test.ts`
  - `tests/preflight.test.ts`
  - `tests/orchestrator.test.ts`
  - `tests/codexCliContract.test.ts`
- Modify docs:
  - `.env.example`
  - `README.md`
  - `docs/ENV_CONFIGURATION.md`
  - `docs/CODEX_CLI_UPDATE_RUNBOOK.md`

---

### Task 0: Branch, Baseline, And Contract Snapshot

**Files:**
- Read: `src/integrations/codex/runner.ts`
- Read: `src/domain/orchestrator.ts`
- Read: `src/domain/preflight.ts`
- Read: `scripts/verify-codex-cli-contract.mjs`
- Read: `tests/codexRunner.test.ts`
- Read: `tests/orchestrator.test.ts`

- [ ] **Step 1: Create an implementation branch**

Run:

```powershell
git status --short --branch
git switch -c codex/codex-self-review-gate
```

Expected:

```text
## main...origin/main
Switched to a new branch 'codex/codex-self-review-gate'
```

- [ ] **Step 2: Confirm the installed stable Codex contract**

Run:

```powershell
codex --version
codex exec review --help
```

Expected:

```text
codex-cli 0.130.0
Usage: codex exec review [OPTIONS] [PROMPT]
```

The review help must include these markers:

```text
--base <BRANCH>
--json
--output-last-message <FILE>
--ephemeral
--skip-git-repo-check
```

- [ ] **Step 3: Run focused baseline tests**

Run:

```powershell
npm run verify:codex-cli
npx vitest run tests/config.test.ts tests/codexRunner.test.ts tests/preflight.test.ts tests/orchestrator.test.ts
```

Expected:

```text
Codex CLI contract verified.
Test Files ... passed
Tests ... passed
```

If baseline fails, stop and fix the baseline before implementing this plan.

---

### Task 1: Add Self-Review Configuration

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these tests near the existing Codex config tests in `tests/config.test.ts`:

```ts
  it("parses Codex self-review settings from environment", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_ORG_HEADER: "x-org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      CODEX_SELF_REVIEW_ENABLED: "true",
      CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS: "3",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.codexSelfReviewEnabled).toBe(true);
    expect(config.codexSelfReviewMaxFixAttempts).toBe(3);
  });

  it("defaults Codex self-review off with one fix attempt", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_ORG_HEADER: "x-org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.codexSelfReviewEnabled).toBe(false);
    expect(config.codexSelfReviewMaxFixAttempts).toBe(1);
  });

  it("rejects invalid Codex self-review max fix attempts", () => {
    const statusMapFile = createStatusMapFile();

    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_ORG_HEADER: "x-org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS: "0",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS/);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npx vitest run tests/config.test.ts -t "Codex self-review"
```

Expected: fail because `codexSelfReviewEnabled` and `codexSelfReviewMaxFixAttempts` are not implemented yet.

- [ ] **Step 3: Add config fields to types**

In `src/models/types.ts`, add these fields after `codexQuestionMarker` in `AppConfig`:

```ts
  codexSelfReviewEnabled: boolean;
  codexSelfReviewMaxFixAttempts: number;
```

In `src/models/types.ts`, add these fields after `questionMarker` in `CodexGlobalConfig`:

```ts
  selfReviewEnabled: boolean;
  selfReviewMaxFixAttempts: number;
```

- [ ] **Step 4: Parse config in single-repository mode**

In `src/config.ts`, add this constant near the other defaults:

```ts
const DEFAULT_CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS = 1;
```

In `loadConfig`, add these properties next to the other Codex settings:

```ts
    codexSelfReviewEnabled: parseBooleanFlag(
      env.CODEX_SELF_REVIEW_ENABLED,
      "CODEX_SELF_REVIEW_ENABLED",
      false,
    ),
    codexSelfReviewMaxFixAttempts: parsePositiveInt(
      env.CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS?.trim() ||
        String(DEFAULT_CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS),
      "CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS",
    ),
```

- [ ] **Step 5: Parse config in fleet mode**

In `loadFleetConfigFromFile`, add these fields to the `codex` object:

```ts
      selfReviewEnabled: env.CODEX_SELF_REVIEW_ENABLED?.trim()
        ? parseBooleanFlag(
            env.CODEX_SELF_REVIEW_ENABLED,
            "CODEX_SELF_REVIEW_ENABLED",
            false,
          )
        : optionalBoolean(codex.selfReviewEnabled, "codex.selfReviewEnabled", false),
      selfReviewMaxFixAttempts: env.CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS?.trim()
        ? parsePositiveInt(
            env.CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS,
            "CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS",
          )
        : optionalPositiveInt(
            codex.selfReviewMaxFixAttempts,
            "codex.selfReviewMaxFixAttempts",
            DEFAULT_CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS,
          ),
```

In `buildRepositoryRuntimeConfig`, pass the values through:

```ts
  codexSelfReviewEnabled: globalConfig.codex.selfReviewEnabled,
  codexSelfReviewMaxFixAttempts: globalConfig.codex.selfReviewMaxFixAttempts,
```

- [ ] **Step 6: Run config tests**

Run:

```powershell
npx vitest run tests/config.test.ts -t "Codex self-review"
```

Expected: all self-review config tests pass.

- [ ] **Step 7: Commit config changes**

Run:

```powershell
git add src/models/types.ts src/config.ts tests/config.test.ts
git commit -m "Add Codex self-review configuration"
```

Expected:

```text
[codex/codex-self-review-gate ...] Add Codex self-review configuration
```

---

### Task 2: Add Self-Review Prompt And Parser

**Files:**
- Create: `src/domain/selfReview.ts`
- Create: `tests/selfReview.test.ts`

- [ ] **Step 1: Write parser and prompt tests**

Create `tests/selfReview.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  SELF_REVIEW_MARKER,
  buildSelfReviewPrompt,
  formatSelfReviewDiagnostic,
  parseSelfReviewResult,
} from "../src/domain/selfReview.js";
import type { TrackerIssue, ValidationResult } from "../src/models/types.js";

const issue: TrackerIssue = {
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
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npx vitest run tests/selfReview.test.ts
```

Expected: fail because `src/domain/selfReview.ts` does not exist.

- [ ] **Step 3: Implement the self-review helper**

Create `src/domain/selfReview.ts`:

```ts
import type { TrackerIssue, ValidationResult } from "../models/types.js";
import { formatQualityGateSummary } from "./qualityGates.js";

export const SELF_REVIEW_MARKER = "AI_SELF_REVIEW:";

export type SelfReviewStatus = "pass" | "fail";
export type SelfReviewFindingSeverity = "blocking" | "warning";

export interface SelfReviewFinding {
  severity: SelfReviewFindingSeverity;
  title: string;
  details: string;
  file?: string;
  line?: number;
  recommendation?: string;
}

export interface SelfReviewResult {
  status: SelfReviewStatus;
  passed: boolean;
  summary: string;
  findings: SelfReviewFinding[];
}

interface BuildSelfReviewPromptInput {
  issue: TrackerIssue;
  baseBranch: string;
  validation: ValidationResult;
  implementationSummary?: string;
}

const compact = (value: string | undefined): string => value?.trim() || "Not provided.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeFinding = (value: unknown): SelfReviewFinding | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const severity = value.severity;
  if (severity !== "blocking" && severity !== "warning") {
    return undefined;
  }

  const title = nonEmptyString(value.title);
  const details = nonEmptyString(value.details);
  if (!title || !details) {
    return undefined;
  }

  const line = typeof value.line === "number" && Number.isFinite(value.line)
    ? Math.max(1, Math.floor(value.line))
    : undefined;

  return {
    severity,
    title,
    details,
    ...(nonEmptyString(value.file) ? { file: nonEmptyString(value.file) } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(nonEmptyString(value.recommendation)
      ? { recommendation: nonEmptyString(value.recommendation) }
      : {}),
  };
};

export const buildSelfReviewPrompt = (input: BuildSelfReviewPromptInput): string =>
  [
    `Review the diff against base branch \`${input.baseBranch}\`.`,
    "",
    "Task:",
    `- Key: ${input.issue.key}`,
    `- Title: ${input.issue.title}`,
    `- Description: ${compact(input.issue.description)}`,
    `- Implementation summary: ${compact(input.implementationSummary)}`,
    "",
    "Quality gates already passed:",
    formatQualityGateSummary(input.validation.gates),
    "",
    "Review scope:",
    "- Fail only for blocking correctness, security, data-loss, migration, API contract, test coverage, or user-facing regression risks.",
    "- Do not fail for style, naming, formatting, preference, or speculative refactors.",
    "- Keep findings actionable and tied to the current diff.",
    "",
    "Return exactly one line and no markdown.",
    `The line must start with ${SELF_REVIEW_MARKER} followed by compact JSON matching one of these shapes:`,
    `${SELF_REVIEW_MARKER} {"status":"pass","summary":"No blocking issues found.","findings":[]}`,
    `${SELF_REVIEW_MARKER} {"status":"fail","summary":"One sentence summary.","findings":[{"severity":"blocking","title":"Short title","details":"Specific problem and why it blocks publishing.","file":"src/example.ts","line":12,"recommendation":"Concrete fix."}]}`,
  ].join("\n");

export const parseSelfReviewResult = (
  message: string | undefined,
): SelfReviewResult | undefined => {
  const line = message
    ?.split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .find((entry) => entry.startsWith(SELF_REVIEW_MARKER));
  if (!line) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(SELF_REVIEW_MARKER.length).trim());
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const status = parsed.status;
  if (status !== "pass" && status !== "fail") {
    return undefined;
  }

  const summary = nonEmptyString(parsed.summary);
  if (!summary || !Array.isArray(parsed.findings)) {
    return undefined;
  }

  const findings = parsed.findings
    .map(normalizeFinding)
    .filter((finding): finding is SelfReviewFinding => Boolean(finding));

  if (status === "fail" && findings.length === 0) {
    return undefined;
  }

  return {
    status,
    passed: status === "pass",
    summary,
    findings,
  };
};

export const formatSelfReviewDiagnostic = (result: SelfReviewResult): string =>
  [
    result.passed ? "Codex self-review passed." : "Codex self-review failed.",
    result.summary,
    ...result.findings.map((finding, index) => {
      const location = [
        finding.file,
        finding.line !== undefined ? String(finding.line) : undefined,
      ]
        .filter(Boolean)
        .join(":");
      return [
        `${index + 1}. [${finding.severity}] ${finding.title}`,
        location ? `Location: ${location}` : "",
        `Details: ${finding.details}`,
        finding.recommendation ? `Recommendation: ${finding.recommendation}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
```

- [ ] **Step 4: Run self-review helper tests**

Run:

```powershell
npx vitest run tests/selfReview.test.ts
```

Expected: all tests in `tests/selfReview.test.ts` pass.

- [ ] **Step 5: Commit helper changes**

Run:

```powershell
git add src/domain/selfReview.ts tests/selfReview.test.ts
git commit -m "Add Codex self-review parser"
```

Expected:

```text
[codex/codex-self-review-gate ...] Add Codex self-review parser
```

---

### Task 3: Add `codex exec review` Runner Support

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/integrations/codex/runner.ts`
- Modify: `tests/codexRunner.test.ts`

- [ ] **Step 1: Write failing runner test**

Add this test to `tests/codexRunner.test.ts`:

```ts
  it("runs codex exec review against the configured base branch", async () => {
    const tempDir = createTempDir();
    const scriptPath = join(tempDir, "codex-review-runner.cjs");
    const argsPath = join(tempDir, "review-args.json");
    const stdinPath = join(tempDir, "review-stdin.txt");
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
        `fs.writeFileSync(${JSON.stringify(stdinPath)}, fs.readFileSync(0, 'utf8'), 'utf8');`,
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, 'AI_SELF_REVIEW: {\"status\":\"pass\",\"summary\":\"No blocking issues.\",\"findings\":[]}\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-review' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );

    const runner = new CliCodexRunner(
      {
        ...createConfig(tempDir, "node", [scriptPath]),
        codexModel: "gpt-5.5",
      },
      new Logger(),
    );

    const execution = await runner.runReview("Review this diff.", undefined, {
      baseBranch: "main",
      title: "[AI] DEV-1 implementation",
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const lastMessageFile = args.at(args.indexOf("--output-last-message") + 1);
    expect(args).toEqual([
      "exec",
      "review",
      "--json",
      "--output-last-message",
      lastMessageFile,
      "--base",
      "main",
      "--title",
      "[AI] DEV-1 implementation",
      "--model",
      "gpt-5.5",
      "--skip-git-repo-check",
      "--ephemeral",
    ]);
    expect(readFileSync(stdinPath, "utf8")).toBe("Review this diff.");
    expect(execution.finalMessage).toContain("AI_SELF_REVIEW:");
    expect(execution.threadId).toBe("thread-review");
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/codexRunner.test.ts -t "codex exec review"
```

Expected: fail because `runReview` is not part of `CodexRunner` or `CliCodexRunner`.

- [ ] **Step 3: Add review run types**

In `src/models/types.ts`, add this interface near `CodexRunOptions`:

```ts
export interface CodexReviewRunOptions {
  baseBranch: string;
  title?: string;
}
```

Extend `CodexProgressEvent.mode`:

```ts
  mode: "new" | "resume" | "review";
```

Add this method to `CodexRunner`:

```ts
  runReview(
    prompt: string,
    observer?: CodexRunObserver,
    options?: CodexReviewRunOptions,
  ): Promise<CodexExecution>;
```

- [ ] **Step 4: Implement review argv in `CliCodexRunner`**

In `src/integrations/codex/runner.ts`, import `CodexReviewRunOptions` and widen the local mode unions from `"new" | "resume"` to `"new" | "resume" | "review"`.

Add this public method:

```ts
  runReview(
    prompt: string,
    observer?: CodexRunObserver,
    options?: CodexReviewRunOptions,
  ): Promise<CodexExecution> {
    return this.run({
      prompt,
      mode: "review",
      observer,
      imagePaths: [],
      review: {
        baseBranch: options?.baseBranch ?? this.config.baseBranch,
        title: options?.title,
      },
    });
  }
```

Add this private argv builder:

```ts
  private buildReviewArgs(
    lastMessagePath: string,
    review: { baseBranch: string; title?: string },
  ): string[] {
    const args = [
      "exec",
      "review",
      "--json",
      "--output-last-message",
      lastMessagePath,
      "--base",
      review.baseBranch,
    ];

    const title = review.title?.trim();
    if (title) {
      args.push("--title", title);
    }
    if (this.config.codexModel) {
      args.push("--model", this.config.codexModel);
    }

    args.push("--skip-git-repo-check", "--ephemeral");
    return args;
  }
```

Change the private `run` input shape:

```ts
  private async run(input: {
    prompt: string;
    mode: "new" | "resume" | "review";
    threadId?: string;
    observer?: CodexRunObserver;
    imagePaths: string[];
    review?: { baseBranch: string; title?: string };
  }): Promise<CodexExecution> {
```

Change argv selection inside `run`:

```ts
      const args =
        input.mode === "review" && input.review
          ? this.buildReviewArgs(lastMessagePath, input.review)
          : this.buildBaseArgs(lastMessagePath);
      if (input.mode === "resume" && input.threadId) {
        args.push("resume");
        appendImageArgs(args, input.imagePaths);
        args.push(input.threadId);
      } else if (input.mode !== "review") {
        appendImageArgs(args, input.imagePaths);
      }
```

- [ ] **Step 5: Run runner tests**

Run:

```powershell
npx vitest run tests/codexRunner.test.ts
```

Expected: all Codex runner tests pass.

- [ ] **Step 6: Commit runner changes**

Run:

```powershell
git add src/models/types.ts src/integrations/codex/runner.ts tests/codexRunner.test.ts
git commit -m "Add Codex review runner"
```

Expected:

```text
[codex/codex-self-review-gate ...] Add Codex review runner
```

---

### Task 4: Add Review CLI Contract Checks

**Files:**
- Modify: `scripts/verify-codex-cli-contract.mjs`
- Modify: `src/domain/preflight.ts`
- Modify: `tests/preflight.test.ts`
- Modify: `tests/codexCliContract.test.ts`

- [ ] **Step 1: Extend the contract verifier**

In `scripts/verify-codex-cli-contract.mjs`, add this static check after `codex exec resume --help`:

```js
  {
    display: "codex exec review --help",
    args: ["exec", "review", "--help"],
    markers: [
      "Usage: codex exec review",
      "--base",
      "--json",
      "--output-last-message",
      "--skip-git-repo-check",
      "--ephemeral",
    ],
  },
```

- [ ] **Step 2: Run verifier**

Run:

```powershell
npm run verify:codex-cli
```

Expected:

```text
[ok] codex exec review --help: Run a code review against the current repository
Codex CLI contract verified.
```

- [ ] **Step 3: Add preflight command helper**

In `src/domain/preflight.ts`, add this helper next to the existing Codex help helpers:

```ts
const buildCodexExecReviewHelpCommand = (config: AppConfig): string =>
  buildCodexHelpCommand(config, ["exec", "review", "--help"]);
```

- [ ] **Step 4: Add preflight check when the feature is enabled**

In `PreflightService.run`, after the image input check block, add:

```ts
    if (this.config.codexSelfReviewEnabled) {
      await this.record(checks, "Codex self-review", () => this.checkCodexSelfReview(), (details) =>
        details,
      );
    }
```

Add this private method to `PreflightService`:

```ts
  private async checkCodexSelfReview(): Promise<string> {
    const command = buildCodexExecReviewHelpCommand(this.config);
    const result = await this.commandRunner(command, {
      cwd: this.config.repoPath,
    });
    if (result.exitCode !== 0) {
      throw new Error(buildCommandFailure("CODEX_SELF_REVIEW_HELP", command, result));
    }

    const output = `${result.stdout}\n${result.stderr}`;
    const missing = [
      "Usage: codex exec review",
      "--base",
      "--json",
      "--output-last-message",
      "--skip-git-repo-check",
      "--ephemeral",
    ].filter((marker) => !output.includes(marker));
    if (missing.length > 0) {
      throw new Error(
        `CODEX_SELF_REVIEW_ENABLED=true requires a Codex CLI whose \`codex exec review --help\` includes: ${missing.join(", ")}.`,
      );
    }

    return "Codex CLI supports self-review through codex exec review.";
  }
```

- [ ] **Step 5: Add preflight tests**

In `tests/preflight.test.ts`, add:

```ts
  it("checks codex exec review help when Codex self-review is enabled", async () => {
    const commands: string[] = [];
    const service = new PreflightService(
      {
        ...createConfig(),
        codexSelfReviewEnabled: true,
      },
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) => {
        commands.push(command);
        if (command.includes("exec review --help")) {
          return {
            stdout:
              "Usage: codex exec review\n  --base <BRANCH>\n  --json\n  --output-last-message <FILE>\n  --skip-git-repo-check\n  --ephemeral",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    const checks = await service.run();

    expect(commands).toEqual(expect.arrayContaining([expect.stringContaining("exec review --help")]));
    expect(checks).toEqual(
      expect.arrayContaining([
        {
          name: "Codex self-review",
          status: "pass",
          details: "Codex CLI supports self-review through codex exec review.",
        },
      ]),
    );
  });

  it("fails preflight when Codex self-review support is missing", async () => {
    const service = new PreflightService(
      {
        ...createConfig(),
        codexSelfReviewEnabled: true,
      },
      new FakeTrackerClient(),
      new FakeGitService(),
      new FakeGitLabService(),
      async () => undefined,
      new Logger(),
      async (command) =>
        command.includes("exec review --help")
          ? { stdout: "Usage: codex exec review\n  --base <BRANCH>", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 },
    );

    const checks = await service.run();

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex self-review",
          status: "fail",
          details: expect.stringContaining("--output-last-message"),
        }),
      ]),
    );
  });
```

- [ ] **Step 6: Run preflight and contract tests**

Run:

```powershell
npx vitest run tests/preflight.test.ts tests/codexCliContract.test.ts
npm run verify:codex-cli
```

Expected: all tests pass and verifier prints the new `codex exec review --help` check.

- [ ] **Step 7: Commit contract checks**

Run:

```powershell
git add scripts/verify-codex-cli-contract.mjs src/domain/preflight.ts tests/preflight.test.ts tests/codexCliContract.test.ts
git commit -m "Verify Codex self-review contract"
```

Expected:

```text
[codex/codex-self-review-gate ...] Verify Codex self-review contract
```

---

### Task 5: Integrate Self-Review Into The Orchestrator

**Files:**
- Modify: `src/observability/events.ts`
- Modify: `src/domain/orchestrator.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Extend fake Codex runner in tests**

In `tests/orchestrator.test.ts`, update `FakeCodexRunner`:

```ts
  readonly reviewCalls: Array<{ prompt: string; baseBranch: string; title?: string }> = [];
```

Extend its constructor:

```ts
    private readonly reviewQueue: Array<
      (prompt: string, baseBranch: string) => CodexExecution | Promise<CodexExecution>
    > = [],
```

Add the method:

```ts
  runReview(
    prompt: string,
    _observer?: CodexRunObserver,
    options?: CodexReviewRunOptions,
  ): Promise<CodexExecution> {
    this.reviewCalls.push({
      prompt,
      baseBranch: options?.baseBranch ?? "main",
      ...(options?.title ? { title: options.title } : {}),
    });
    const next = this.reviewQueue.shift();
    if (!next) {
      return Promise.resolve({
        process: { stdout: "", stderr: "", exitCode: 0 },
        finalMessage:
          'AI_SELF_REVIEW: {"status":"pass","summary":"No blocking issues.","findings":[]}',
      });
    }
    return Promise.resolve(next(prompt, options?.baseBranch ?? "main"));
  }
```

Add `CodexReviewRunOptions` to the type imports at the top of the test.

- [ ] **Step 2: Write pass-path orchestrator test**

Add this test near the implementation publish tests:

```ts
  it("runs Codex self-review before publishing when enabled", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          key: "DEV-SELF-REVIEW",
          title: "Fix checkout crash",
          description: "Null cart crashes checkout.",
          queue: "BACKEND",
          tags: ["ai_dev"],
          logicalStatus: "open",
        },
      ],
      { "DEV-SELF-REVIEW": [] },
    );
    const git = new FakeGitService();
    git.uncommittedChanges = true;
    const gitlab = new FakeGitLabService();
    const codex = new FakeCodexRunner(
      [
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "READY_FOR_IMPLEMENTATION", threadId: "thread-analysis" }),
      ],
      [
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "Implementation complete", threadId: "thread-impl" }),
      ],
      [],
      [
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage:
            'AI_SELF_REVIEW: {"status":"pass","summary":"No blocking issues.","findings":[]}',
        }),
      ],
    );

    const orchestrator = new WorkerOrchestrator(
      createConfig({
        codexSelfReviewEnabled: true,
        codexSelfReviewMaxFixAttempts: 1,
        testCommand: "node -e \"process.exit(0)\"",
        lintCommand: "node -e \"process.exit(0)\"",
      }),
      tracker,
      git,
      gitlab,
      codex,
      new Logger(),
    );

    await orchestrator.runOnce();

    expect(codex.reviewCalls).toHaveLength(1);
    expect(codex.reviewCalls[0]?.baseBranch).toBe("main");
    expect(codex.reviewCalls[0]?.prompt).toContain("AI_SELF_REVIEW:");
    expect(gitlab.createCalls).toEqual(["feature/ai-task-DEV-SELF-REVIEW"]);
    expect(tracker.transitions).toContainEqual({ issueKey: "DEV-SELF-REVIEW", target: "review" });
  });
```

Adjust constructor argument order to match the updated `FakeCodexRunner`.

- [ ] **Step 3: Write fail-then-fix orchestrator test**

Add this test:

```ts
  it("asks Codex to fix blocking self-review findings before publishing", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          key: "DEV-SELF-REVIEW-FIX",
          title: "Fix checkout crash",
          description: "Null cart crashes checkout.",
          queue: "BACKEND",
          tags: ["ai_dev"],
          logicalStatus: "open",
        },
      ],
      { "DEV-SELF-REVIEW-FIX": [] },
    );
    const git = new FakeGitService();
    git.uncommittedChanges = true;
    const gitlab = new FakeGitLabService();
    const codex = new FakeCodexRunner(
      [
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "READY_FOR_IMPLEMENTATION", threadId: "thread-analysis" }),
      ],
      [
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "Implementation complete", threadId: "thread-impl" }),
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "Self-review fix applied", threadId: "thread-impl" }),
      ],
      [],
      [
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage:
            'AI_SELF_REVIEW: {"status":"fail","summary":"One blocking issue.","findings":[{"severity":"blocking","title":"Missing null guard","details":"The checkout total still dereferences null.","file":"src/example.ts","line":12,"recommendation":"Guard the total before formatting."}]}',
        }),
        () => ({
          process: { stdout: "", stderr: "", exitCode: 0 },
          finalMessage:
            'AI_SELF_REVIEW: {"status":"pass","summary":"No blocking issues.","findings":[]}',
        }),
      ],
    );

    const orchestrator = new WorkerOrchestrator(
      createConfig({
        codexSelfReviewEnabled: true,
        codexSelfReviewMaxFixAttempts: 1,
        testCommand: "node -e \"process.exit(0)\"",
        lintCommand: "node -e \"process.exit(0)\"",
      }),
      tracker,
      git,
      gitlab,
      codex,
      new Logger(),
    );

    await orchestrator.runOnce();

    expect(codex.reviewCalls).toHaveLength(2);
    expect(codex.resumeCalls.some((call) => call.prompt.includes("Codex self-review failed."))).toBe(true);
    expect(gitlab.createCalls).toEqual(["feature/ai-task-DEV-SELF-REVIEW-FIX"]);
  });
```

- [ ] **Step 4: Write exhaustion test**

Add this test:

```ts
  it("fails before publishing when self-review findings remain after fixes", async () => {
    const tracker = new FakeTrackerClient(
      [
        {
          key: "DEV-SELF-REVIEW-BLOCK",
          title: "Fix checkout crash",
          description: "Null cart crashes checkout.",
          queue: "BACKEND",
          tags: ["ai_dev"],
          logicalStatus: "open",
        },
      ],
      { "DEV-SELF-REVIEW-BLOCK": [] },
    );
    const git = new FakeGitService();
    git.uncommittedChanges = true;
    const gitlab = new FakeGitLabService();
    const failingReview = () => ({
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage:
        'AI_SELF_REVIEW: {"status":"fail","summary":"One blocking issue.","findings":[{"severity":"blocking","title":"Still unsafe","details":"The diff still leaves a data-loss path."}]}',
    });
    const codex = new FakeCodexRunner(
      [
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "READY_FOR_IMPLEMENTATION", threadId: "thread-analysis" }),
      ],
      [
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "Implementation complete", threadId: "thread-impl" }),
        () => ({ process: { stdout: "", stderr: "", exitCode: 0 }, finalMessage: "Attempted fix", threadId: "thread-impl" }),
      ],
      [],
      [failingReview, failingReview],
    );

    const orchestrator = new WorkerOrchestrator(
      createConfig({
        codexSelfReviewEnabled: true,
        codexSelfReviewMaxFixAttempts: 1,
        testCommand: "node -e \"process.exit(0)\"",
        lintCommand: "node -e \"process.exit(0)\"",
      }),
      tracker,
      git,
      gitlab,
      codex,
      new Logger(),
    );

    await orchestrator.runOnce();

    expect(codex.reviewCalls).toHaveLength(2);
    expect(gitlab.createCalls).toEqual([]);
    expect(tracker.transitions).toContainEqual({ issueKey: "DEV-SELF-REVIEW-BLOCK", target: "failed" });
  });
```

- [ ] **Step 5: Run tests to verify failure**

Run:

```powershell
npx vitest run tests/orchestrator.test.ts -t "self-review"
```

Expected: fail because orchestrator does not run self-review yet.

- [ ] **Step 6: Add observability event types**

In `src/observability/events.ts`, add:

```ts
  | "self_review_started"
  | "self_review_completed"
```

- [ ] **Step 7: Add orchestrator self-review imports**

In `src/domain/orchestrator.ts`, import:

```ts
import {
  buildSelfReviewPrompt,
  formatSelfReviewDiagnostic,
  parseSelfReviewResult,
} from "./selfReview.js";
```

- [ ] **Step 8: Extend `runCodexStage` stage union**

Change the stage type:

```ts
    stage: "analysis" | "implementation" | "decomposition" | "review_fix" | "self_review",
```

- [ ] **Step 9: Add self-review gate method**

Add this method to `WorkerOrchestrator` near `validateRepositoryState`:

```ts
  private async runSelfReviewGate(input: {
    issue: TrackerIssue;
    validation: ValidationResult;
    implementationSummary?: string;
    activeThreadId?: string;
    promptProfile: PromptProfile;
    analysisDecision?: TaskAnalysisDecision;
    imageContext: PreparedTrackerImageContext;
    codexOptions: CodexRunOptions;
  }): Promise<{ validation: ValidationResult; implementationSummary?: string; activeThreadId?: string }> {
    if (!this.config.codexSelfReviewEnabled) {
      return {
        validation: input.validation,
        implementationSummary: input.implementationSummary,
        activeThreadId: input.activeThreadId,
      };
    }

    let validation = input.validation;
    let implementationSummary = input.implementationSummary;
    let activeThreadId = input.activeThreadId;
    let attempt = 0;

    while (true) {
      this.markStage(input.issue, "self_review");
      const reviewExecution = await this.runCodexStage(input.issue, "self_review", () =>
        this.codex.runReview(
          buildSelfReviewPrompt({
            issue: input.issue,
            baseBranch: this.config.baseBranch,
            validation,
            implementationSummary,
          }),
          undefined,
          {
            baseBranch: this.config.baseBranch,
            title: `[AI] ${input.issue.key} implementation`,
          },
        ),
      );

      const review = parseSelfReviewResult(reviewExecution.finalMessage);
      if (!review) {
        throw new PermanentTaskError(
          [
            "Codex self-review did not return a valid AI_SELF_REVIEW result.",
            reviewExecution.finalMessage?.trim()
              ? `Final message:\n${reviewExecution.finalMessage.trim()}`
              : "Final message was empty.",
          ].join("\n\n"),
        );
      }

      this.telemetry.recordEvent({
        workerId: this.config.workerId,
        repositoryName: this.repositoryName(),
        issueKey: input.issue.key,
        type: "self_review_completed",
        status: review.passed ? "info" : "warning",
        message: review.summary,
        details: {
          passed: review.passed,
          findings: review.findings,
        },
      });

      if (review.passed) {
        return { validation, implementationSummary, activeThreadId };
      }

      const diagnostic = formatSelfReviewDiagnostic(review);
      if (attempt >= this.config.codexSelfReviewMaxFixAttempts) {
        await this.recordFailureMemory({
          issue: input.issue,
          failureKind: "self_review_exhausted",
          diagnostic,
          promptProfile: input.promptProfile,
          analysisDecision: input.analysisDecision,
        });
        throw new PermanentTaskError(diagnostic);
      }

      attempt += 1;
      this.logger.warn("Codex self-review failed, asking Codex to apply a fix.", {
        issueKey: input.issue.key,
        attempt,
        maxAttempts: this.config.codexSelfReviewMaxFixAttempts,
      });

      const fixExecution = await this.runCodexStage(input.issue, "implementation", () =>
        activeThreadId
          ? this.codex.runResume(
              activeThreadId,
              buildFixPrompt(
                input.issue,
                diagnostic,
                input.promptProfile,
                input.analysisDecision,
                input.imageContext,
              ),
              undefined,
              input.codexOptions,
            )
          : this.codex.runFix(
              buildFixPrompt(
                input.issue,
                diagnostic,
                input.promptProfile,
                input.analysisDecision,
                input.imageContext,
              ),
              undefined,
              input.codexOptions,
            ),
      );

      activeThreadId = fixExecution.threadId ?? activeThreadId;
      implementationSummary = fixExecution.finalMessage?.trim() ?? implementationSummary;
      if (fixExecution.clarification) {
        await this.pauseForClarification(input.issue, fixExecution.clarification, activeThreadId);
        throw new PermanentTaskError("Codex self-review fix requested human clarification.");
      }

      this.markStage(input.issue, "validation");
      validation = await this.validateRepositoryState(input.issue);
      if (!isValidationSuccessful(validation)) {
        await this.recordFailureMemory({
          issue: input.issue,
          failureKind: "self_review_fix_validation_failed",
          diagnostic: validation.diagnostic,
          promptProfile: input.promptProfile,
          analysisDecision: input.analysisDecision,
        });
        throw new PermanentTaskError(validation.diagnostic);
      }
    }
  }
```

If throwing after `pauseForClarification` causes an unwanted failed transition in `runOnce`, return a small union instead:

```ts
type SelfReviewGateOutcome =
  | { outcome: "ready"; validation: ValidationResult; implementationSummary?: string; activeThreadId?: string }
  | { outcome: "waiting" };
```

Use that union only if the test for clarification path proves it is needed.

- [ ] **Step 10: Call the gate before publish**

Replace:

```ts
    this.markStage(issue, "publish");
    await this.publish(issue, branch, existingMr, validation, implementationSummary);
```

With:

```ts
    const selfReview = await this.runSelfReviewGate({
      issue,
      validation,
      implementationSummary,
      activeThreadId,
      promptProfile,
      analysisDecision,
      imageContext,
      codexOptions,
    });
    validation = selfReview.validation;
    implementationSummary = selfReview.implementationSummary;
    activeThreadId = selfReview.activeThreadId ?? activeThreadId;

    this.markStage(issue, "publish");
    await this.publish(issue, branch, existingMr, validation, implementationSummary);
```

- [ ] **Step 11: Run orchestrator self-review tests**

Run:

```powershell
npx vitest run tests/orchestrator.test.ts -t "self-review"
```

Expected: all self-review orchestrator tests pass.

- [ ] **Step 12: Run full orchestrator tests**

Run:

```powershell
npx vitest run tests/orchestrator.test.ts
```

Expected: all orchestrator tests pass.

- [ ] **Step 13: Commit orchestrator integration**

Run:

```powershell
git add src/observability/events.ts src/domain/orchestrator.ts tests/orchestrator.test.ts
git commit -m "Run Codex self-review before publish"
```

Expected:

```text
[codex/codex-self-review-gate ...] Run Codex self-review before publish
```

---

### Task 6: Document And Configure The Feature

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/ENV_CONFIGURATION.md`
- Modify: `docs/CODEX_CLI_UPDATE_RUNBOOK.md`

- [ ] **Step 1: Update `.env.example`**

Add after `CODEX_EXEC_ARGS_JSON=[]`:

```env
# Optional Codex self-review gate before publishing merge requests.
# Uses `codex exec review` after local quality gates pass.
CODEX_SELF_REVIEW_ENABLED=false
# Number of Codex fix attempts allowed for blocking self-review findings.
CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS=1
```

- [ ] **Step 2: Update README configuration section**

In `README.md`, add this near the Codex configuration bullets:

```md
- `CODEX_SELF_REVIEW_ENABLED=false` - optional pre-publish gate that runs `codex exec review` against `BASE_BRANCH` after quality gates pass.
- `CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS=1` - how many Codex fix attempts are allowed for blocking self-review findings before the worker fails the task.
```

Add this paragraph near the quality gate or MR flow description:

```md
When `CODEX_SELF_REVIEW_ENABLED=true`, the worker runs `codex exec review --base <BASE_BRANCH>` after tests/lint/build pass and before publishing the merge request. Blocking review findings are fed back into the existing Codex fix loop, then local quality gates and self-review run again. Human GitLab review remains the source of truth after the MR is published.
```

- [ ] **Step 3: Update env documentation**

In `docs/ENV_CONFIGURATION.md`, add these rows to the Codex section:

```md
| `CODEX_SELF_REVIEW_ENABLED` | No | `false` | When `true`, run `codex exec review` after quality gates and before publishing a merge request. Blocking findings are sent through the Codex fix loop. |
| `CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS` | No | `1` | Positive integer. Maximum number of Codex fix attempts for blocking self-review findings before the task fails without publishing. |
```

- [ ] **Step 4: Update update runbook contract**

In `docs/CODEX_CLI_UPDATE_RUNBOOK.md`, add `codex exec review --help` to the static checks section and include these required markers:

```md
- `codex exec review --help`
- `--base`
- `--json`
- `--output-last-message`
- `--skip-git-repo-check`
- `--ephemeral`
```

Add this compatibility risk:

```md
9. `codex exec review` loses JSONL or `--output-last-message` support, which breaks the optional self-review gate.
```

- [ ] **Step 5: Run doc/config searches**

Run:

```powershell
rg -n "CODEX_SELF_REVIEW|codex exec review|self-review" .env.example README.md docs
```

Expected: references appear in `.env.example`, `README.md`, `docs/ENV_CONFIGURATION.md`, and `docs/CODEX_CLI_UPDATE_RUNBOOK.md`.

- [ ] **Step 6: Commit docs**

Run:

```powershell
git add .env.example README.md docs/ENV_CONFIGURATION.md docs/CODEX_CLI_UPDATE_RUNBOOK.md
git commit -m "Document Codex self-review gate"
```

Expected:

```text
[codex/codex-self-review-gate ...] Document Codex self-review gate
```

---

### Task 7: Final Verification

**Files:**
- Read: all modified files

- [ ] **Step 1: Run focused checks**

Run:

```powershell
npm run verify:codex-cli
npx vitest run tests/selfReview.test.ts tests/config.test.ts tests/codexRunner.test.ts tests/preflight.test.ts tests/orchestrator.test.ts tests/codexCliContract.test.ts
```

Expected:

```text
Codex CLI contract verified.
Test Files ... passed
Tests ... passed
```

- [ ] **Step 2: Run full repository verification**

Run:

```powershell
npm run typecheck
npm test
npm run build
```

Expected:

```text
typecheck exits 0
vitest exits 0
build exits 0
```

- [ ] **Step 3: Run optional live self-review smoke only if auth and target repo are available**

Use this only when Codex auth and network are available:

```powershell
$env:CODEX_SELF_REVIEW_ENABLED="true"
npm run verify:codex-cli
```

Expected: static contract passes. Do not require a real task execution in this plan unless a safe sandbox task is available.

- [ ] **Step 4: Inspect final diff**

Run:

```powershell
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected:

```text
Only self-review gate files are changed.
Commits are the task commits from this plan.
```

- [ ] **Step 5: Merge or hand off**

If the user asks to merge to `main`, run:

```powershell
git switch main
git pull --ff-only origin main
git merge --ff-only codex/codex-self-review-gate
npm run verify:codex-cli
npm run typecheck
npm test
npm run build
git push origin main
```

Expected:

```text
main fast-forwards.
All verification commands exit 0.
origin/main receives the self-review gate.
```

---

## Completion Checklist

- [ ] `CODEX_SELF_REVIEW_ENABLED=false` leaves existing worker behavior unchanged.
- [ ] `CODEX_SELF_REVIEW_ENABLED=true` runs `codex exec review` after successful quality gates and before publish.
- [ ] Self-review pass publishes the MR.
- [ ] Self-review fail sends findings into the existing Codex fix loop.
- [ ] Quality gates rerun after self-review fixes.
- [ ] Remaining self-review findings fail the task before publishing.
- [ ] `npm run verify:codex-cli` checks `codex exec review --help`.
- [ ] Docs explain the feature, default, and retry behavior.
- [ ] No alpha Codex version is introduced.
