import type { TrackerIssue } from "../models/types.js";

const MAX_SUMMARY_LENGTH = 500;

const sanitizeText = (value: string | undefined): string | undefined => {
  const normalized = value
    ?.replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized === "READY_FOR_IMPLEMENTATION") {
    return undefined;
  }

  return normalized.length > MAX_SUMMARY_LENGTH
    ? `${normalized.slice(0, MAX_SUMMARY_LENGTH).trim()}...`
    : normalized;
};

const formatChangedFiles = (changedFiles: string[]): string =>
  changedFiles.length > 0
    ? changedFiles.map((file) => `- \`${file}\``).join("\n")
    : "- No changed files reported.";

export const buildMergeRequestDescription = (input: {
  issue: TrackerIssue;
  sourceBranch: string;
  targetBranch: string;
  changedFiles: string[];
  validationSummary: string;
  workerId: string;
  codexSummary?: string;
}): string => {
  const summary =
    sanitizeText(input.codexSummary) ??
    sanitizeText(input.issue.description) ??
    input.issue.title;

  return [
    "## Summary",
    "",
    `- ${summary}`,
    "",
    "## Changed Files",
    "",
    formatChangedFiles(input.changedFiles),
    "",
    "## Testing",
    "",
    input.validationSummary || "- Validation commands were not recorded.",
    "",
    "## Risks / Notes",
    "",
    "- Review the generated changes against the original Tracker requirements before merging.",
    "",
    "## Links",
    "",
    `- Tracker issue: ${input.issue.key}`,
    `- Source branch: \`${input.sourceBranch}\``,
    `- Target branch: \`${input.targetBranch}\``,
    `- Worker: \`${input.workerId}\``,
  ].join("\n");
};
