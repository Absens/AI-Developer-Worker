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

export const SELF_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "findings"],
  properties: {
    status: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "details"],
        properties: {
          severity: { type: "string", enum: ["blocking", "warning"] },
          title: { type: "string", minLength: 1 },
          details: { type: "string", minLength: 1 },
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          recommendation: { type: "string" },
        },
      },
    },
  },
} satisfies Record<string, unknown>;

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

  const file = nonEmptyString(value.file);
  const recommendation = nonEmptyString(value.recommendation);
  const line =
    typeof value.line === "number" && Number.isFinite(value.line)
      ? Math.max(1, Math.floor(value.line))
      : undefined;

  return {
    severity,
    title,
    details,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(recommendation ? { recommendation } : {}),
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
    "Return exactly one compact JSON object and no markdown.",
    `For legacy callers without --output-schema, the line may start with ${SELF_REVIEW_MARKER} followed by compact JSON matching one of these shapes:`,
    `${SELF_REVIEW_MARKER} {"status": "pass", "summary": "No blocking issues found.", "findings": []}`,
    `${SELF_REVIEW_MARKER} {"status": "fail", "summary": "One sentence summary.", "findings": [{"severity": "blocking", "title": "Short title", "details": "Specific problem and why it blocks publishing.", "file": "src/example.ts", "line": 12, "recommendation": "Concrete fix."}]}`,
  ].join("\n");

const extractSelfReviewPayload = (message: string | undefined): string | undefined => {
  const trimmed = message?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  return trimmed
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .find((entry) => entry.startsWith(SELF_REVIEW_MARKER))
    ?.slice(SELF_REVIEW_MARKER.length)
    .trim();
};

export const parseSelfReviewResult = (
  message: string | undefined,
): SelfReviewResult | undefined => {
  const payload = extractSelfReviewPayload(message);
  if (!payload) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
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
