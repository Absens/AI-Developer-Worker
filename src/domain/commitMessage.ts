import type { TrackerIssue } from "../models/types.js";

const MAX_SUBJECT_LENGTH = 90;

const COMMIT_TYPES = ["feat", "fix", "test", "docs", "refactor", "chore"] as const;
type CommitType = (typeof COMMIT_TYPES)[number];

const stripMarkdown = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#[\]()>]/g, " ")
    .replace(/["'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isSafeSummary = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== "" &&
    normalized !== "ready_for_implementation" &&
    normalized !== "implementation complete" &&
    normalized !== "implemented" &&
    !normalized.startsWith("ai_question:")
  );
};

const sanitizeSummary = (summary: string | undefined, issueKey: string): string | undefined => {
  if (!summary || !isSafeSummary(summary)) {
    return undefined;
  }

  const singleLine = stripMarkdown(summary)
    .replace(new RegExp(`\\b${escapeRegExp(issueKey)}\\b`, "gi"), "")
    .replace(/^(feat|fix|test|docs|refactor|chore)(\([^)]*\))?:\s*/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();

  if (!singleLine || !isSafeSummary(singleLine)) {
    return undefined;
  }

  return singleLine.charAt(0).toLowerCase() + singleLine.slice(1);
};

const inferCommitType = (
  issue: TrackerIssue,
  changedFiles: string[],
  summary?: string,
): CommitType => {
  const searchable = `${issue.title} ${issue.description} ${summary ?? ""}`.toLowerCase();
  const normalizedFiles = changedFiles.map((file) => file.replace(/\\/g, "/").toLowerCase());

  if (
    normalizedFiles.length > 0 &&
    normalizedFiles.every(
      (file) =>
        file.endsWith(".md") ||
        file.startsWith("docs/") ||
        file === "readme.md" ||
        file.includes("/readme.md"),
    )
  ) {
    return "docs";
  }

  if (
    normalizedFiles.length > 0 &&
    normalizedFiles.every(
      (file) =>
        file.startsWith("tests/") ||
        file.includes(".test.") ||
        file.includes(".spec."),
    )
  ) {
    return "test";
  }

  if (/\b(refactor|cleanup|restructure)\b/.test(searchable)) {
    return "refactor";
  }

  if (/\b(fix|bug|error|failure|failed|crash|regression|broken)\b/.test(searchable)) {
    return "fix";
  }

  if (
    normalizedFiles.length > 0 &&
    normalizedFiles.every((file) =>
      /(^|\/)(package-lock\.json|package\.json|tsconfig.*\.json|\.github\/|scripts\/|config\/)/.test(
        file,
      ),
    )
  ) {
    return "chore";
  }

  return "feat";
};

const truncateSubject = (subject: string): string => {
  if (subject.length <= MAX_SUBJECT_LENGTH) {
    return subject;
  }

  return subject.slice(0, MAX_SUBJECT_LENGTH).replace(/\s+\S*$/, "").trim();
};

export const buildCommitMessage = (input: {
  issue: TrackerIssue;
  changedFiles: string[];
  summary?: string;
}): string => {
  const type = inferCommitType(input.issue, input.changedFiles, input.summary);
  const safeSummary = sanitizeSummary(input.summary, input.issue.key);
  const body = safeSummary ?? `implement ${input.issue.key}`;
  const subjectWithoutIssue = truncateSubject(`${type}: ${body}`);

  if (subjectWithoutIssue.endsWith(input.issue.key)) {
    return subjectWithoutIssue;
  }

  return truncateSubject(`${subjectWithoutIssue} ${input.issue.key}`);
};
