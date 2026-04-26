import type {
  CommentWithMetadata,
  HumanTaskCommand,
  MergeRequestDiscussion,
  MergeRequestInfo,
  TrackerIssue,
} from "../models/types.js";
import {
  findHumanCommentsAfter,
  findLatestHumanTaskCommandAfter,
  findLatestQuestionComment,
} from "../integrations/tracker/commentProtocol.js";

const CLARIFICATION_SCHEMA = `{
  "summary": "short summary of what is unclear",
  "blockingReason": "why implementation cannot proceed safely",
  "question": "single direct question to the human",
  "options": ["A: option one", "B: option two"],
  "resumeHint": "Reply with /resume A or /resume freeform: <your answer>."
}`;

interface ReviewFixPromptContext {
  mergeRequest: MergeRequestInfo;
  discussions: MergeRequestDiscussion[];
  changedFiles: string[];
  diffFromBase: string;
}

const MAX_DIFF_CONTEXT_LENGTH = 16_000;

const formatHumanComments = (comments: CommentWithMetadata[]): string => {
  const relevant = comments.filter((comment) => !comment.metadata && !comment.isSystem);
  if (relevant.length === 0) {
    return "No additional comments.";
  }

  return relevant
    .map(
      (comment) =>
        `- ${comment.createdAt} ${comment.author ? `[${comment.author}] ` : ""}${comment.text}`,
    )
    .join("\n");
};

const formatDiscussionTail = (
  comments: CommentWithMetadata[],
  sinceTimestamp: string,
): string => {
  const discussion = findHumanCommentsAfter(comments, sinceTimestamp);
  if (discussion.length === 0) {
    return "No human comments after the latest AI clarification.";
  }

  return discussion
    .map(
      (comment) =>
        `- ${comment.createdAt} ${comment.author ? `[${comment.author}] ` : ""}${comment.text}`,
    )
    .join("\n");
};

const formatClarificationHistory = (comments: CommentWithMetadata[]): string => {
  const latestQuestion = findLatestQuestionComment(comments);
  if (!latestQuestion?.metadata.question) {
    return "No previous AI clarifications.";
  }

  const latestCommand = findLatestHumanTaskCommandAfter(
    comments,
    latestQuestion.createdAt,
  );

  return [
    `Summary: ${latestQuestion.metadata.summary ?? latestQuestion.metadata.question}`,
    `Question: ${latestQuestion.metadata.question}`,
    `Blocking reason: ${latestQuestion.metadata.blockingReason ?? "Not recorded."}`,
    latestQuestion.metadata.options && latestQuestion.metadata.options.length > 0
      ? `Options: ${latestQuestion.metadata.options.join(" | ")}`
      : "Options: none recorded",
    latestCommand
      ? `Latest command: ${latestCommand.rawText}`
      : "Latest command: no explicit resume command",
    "Discussion tail:",
    formatDiscussionTail(comments, latestQuestion.createdAt),
  ].join("\n");
};

const formatResumeCommand = (command: HumanTaskCommand): string =>
  [
    `Command: ${command.type}`,
    command.choice ? `Choice: ${command.choice}` : "",
    command.freeform ? `Freeform: ${command.freeform}` : "",
    `Raw: ${command.rawText}`,
  ]
    .filter(Boolean)
    .join("\n");

const formatReviewPosition = (discussion: MergeRequestDiscussion): string => {
  const position = discussion.notes.find((note) => note.position)?.position;
  const path = position?.newPath ?? position?.oldPath ?? "general";
  const line =
    position?.newLine !== undefined
      ? `new line ${position.newLine}`
      : position?.oldLine !== undefined
        ? `old line ${position.oldLine}`
        : "no line";

  return `${path}:${line}`;
};

const formatReviewComments = (discussions: MergeRequestDiscussion[]): string => {
  if (discussions.length === 0) {
    return "No unresolved reviewer comments.";
  }

  const groups = new Map<string, MergeRequestDiscussion[]>();
  for (const discussion of discussions) {
    const key = formatReviewPosition(discussion);
    groups.set(key, [...(groups.get(key) ?? []), discussion]);
  }

  return [...groups.entries()]
    .map(([location, groupedDiscussions]) => {
      const lines = [`File/line: ${location}`];
      for (const discussion of groupedDiscussions) {
        lines.push(`Discussion ${discussion.id}:`);
        for (const note of discussion.notes) {
          lines.push(
            [
              `- note ${note.id}`,
              note.authorUsername ? `by @${note.authorUsername}` : "by unknown reviewer",
              `at ${note.createdAt}:`,
              note.body,
            ].join(" "),
          );
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
};

const truncateDiff = (diff: string): string => {
  if (!diff.trim()) {
    return "No diff from base was reported.";
  }

  if (diff.length <= MAX_DIFF_CONTEXT_LENGTH) {
    return diff;
  }

  return `${diff.slice(0, MAX_DIFF_CONTEXT_LENGTH)}\n[diff truncated after ${MAX_DIFF_CONTEXT_LENGTH} characters]`;
};

const buildClarificationInstruction = (): string => [
  'If critical business context is missing, reply with exactly one line that starts with AI_QUESTION: followed by a compact JSON object.',
  "The JSON object must match this schema exactly:",
  CLARIFICATION_SCHEMA,
  "Do not add markdown fences, explanations, or any extra text around that one-line response.",
].join("\n");

export const buildAnalysisPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}

Previous clarification history:
${formatClarificationHistory(comments)}

Mode: analysis-only

Requirements:
1. Analyze the task and repository context only.
2. Do not modify files, do not create files, do not run formatters, and do not perform implementation work.
3. If the task is clear enough to implement safely, reply with exactly READY_FOR_IMPLEMENTATION and nothing else.
4. If the task is ambiguous, reply with exactly one AI_QUESTION line using the clarification JSON contract below.
5. Offer 2 to 4 mutually exclusive options when possible.
6. Make the question human-friendly and specific to the blocker.

${buildClarificationInstruction()}`;

export const buildImplementationPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}

Clarification history:
${formatClarificationHistory(comments)}

Requirements:
1. Analyze the repository.
2. Create an implementation plan.
3. Implement the solution.
4. Run project tests.
5. Follow the existing architecture and coding style.
6. If critical business context is missing, stop and ask for clarification using the exact AI_QUESTION JSON contract below.

${buildClarificationInstruction()}`;

export const buildFixPrompt = (
  issue: TrackerIssue,
  diagnostic: string,
): string => `Task: ${issue.key}
Title: ${issue.title}

The previous implementation did not pass validation. Fix the code and rerun the required checks.

Validation errors:
${diagnostic}

Requirements:
1. Modify only what is necessary to resolve the validation issues.
2. Keep the existing task context and architecture intact.
3. If critical business context is missing, stop and ask for clarification using the exact AI_QUESTION JSON contract below.

${buildClarificationInstruction()}`;

export const buildResumePrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
  command: HumanTaskCommand,
): string => {
  const latestQuestion = findLatestQuestionComment(comments);

  return `Continue the existing Codex session for task ${issue.key}.
Title: ${issue.title}

Original description:
${issue.description || "No description."}

Latest AI clarification:
${formatClarificationHistory(comments)}

Explicit human command:
${formatResumeCommand(command)}

Requirements:
1. Continue from the existing session context instead of restarting analysis from scratch.
2. Treat the explicit human command as authoritative.
3. Use the discussion tail after the latest AI clarification as additional context.
4. If critical business context is still missing, stop and ask for clarification using the exact AI_QUESTION JSON contract below.
5. If enough context is available, continue implementation and validation work.

Latest question timestamp:
${latestQuestion?.createdAt ?? "unknown"}

${buildClarificationInstruction()}`;
};

export const buildReviewFixPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
  reviewContext: ReviewFixPromptContext,
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Relevant Tracker context:
${formatHumanComments(comments)}

Merge request:
- URL: ${reviewContext.mergeRequest.url}
- Source branch: ${reviewContext.mergeRequest.sourceBranch}
- Target branch: ${reviewContext.mergeRequest.targetBranch}

Changed files from base:
${
  reviewContext.changedFiles.length > 0
    ? reviewContext.changedFiles.map((file) => `- ${file}`).join("\n")
    : "No changed files reported."
}

Unresolved reviewer comments:
${formatReviewComments(reviewContext.discussions)}

Diff from base:
${truncateDiff(reviewContext.diffFromBase)}

Requirements:
1. Fix the unresolved reviewer comments by modifying only the target repository files.
2. Keep the original task intent and existing architecture intact.
3. Do not resolve GitLab threads manually and do not mark discussions as resolved.
4. Do not change unrelated files or unrelated behavior.
5. Run the project checks that are appropriate for the repository.
6. If critical business context is missing, stop and ask for clarification using the exact AI_QUESTION JSON contract below.

${buildClarificationInstruction()}`;
