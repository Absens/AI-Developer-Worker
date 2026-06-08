import type {
  CommentWithMetadata,
  HumanTaskCommand,
  MergeRequestDiscussion,
  MergeRequestInfo,
  PromptProfile,
  TaskAnalysisDecision,
  TrackerIssue,
} from "../models/types.js";
import {
  findHumanCommentsAfter,
  findLatestHumanTaskCommandAfter,
  findLatestQuestionComment,
} from "../integrations/tracker/commentProtocol.js";
import { getPromptProfile } from "./promptProfiles.js";
import {
  formatPromptContextBundle,
  type PromptContextBundle,
} from "./promptContext.js";

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

export interface PromptImageContext {
  promptSummary: string;
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

const formatProfileGuidance = (profile: PromptProfile | undefined): string => {
  const resolved = profile ?? getPromptProfile("general");

  return [
    `Prompt profile: ${resolved.id}`,
    `Task type: ${resolved.taskType}`,
    "",
    "Profile-specific implementation instructions:",
    ...resolved.implementationInstructions.map((entry) => `- ${entry}`),
    "",
    "Validation focus:",
    ...resolved.validationFocus.map((entry) => `- ${entry}`),
    "",
    "Risk checklist:",
    ...resolved.riskChecklist.map((entry) => `- ${entry}`),
  ].join("\n");
};

const formatAnalysisDecision = (
  decision: TaskAnalysisDecision | undefined,
): string => {
  if (!decision) {
    return "No structured analysis decision is available.";
  }

  return [
    `Confidence: ${decision.confidence}`,
    `Task type: ${decision.taskType}`,
    `Recommended mode: ${decision.recommendedMode}`,
    `Prompt profile: ${decision.promptProfileId}`,
    `Expected files: ${
      decision.expectedFiles.length > 0 ? decision.expectedFiles.join(", ") : "not specified"
    }`,
    `Expected subsystems: ${
      decision.expectedSubsystems.length > 0
        ? decision.expectedSubsystems.join(", ")
        : "not specified"
    }`,
    `Risk factors: ${
      decision.riskFactors.length > 0 ? decision.riskFactors.join("; ") : "none listed"
    }`,
    `Missing context: ${
      decision.missingContext.length > 0 ? decision.missingContext.join("; ") : "none"
    }`,
    `Reasoning: ${decision.reasoning}`,
  ].join("\n");
};

const formatRepositoryContext = (
  memoryContext: PromptContextBundle | undefined,
): string => {
  const formatted = formatPromptContextBundle(memoryContext);
  return formatted ? `\n${formatted}` : "";
};

const formatImageContext = (
  imageContext: PromptImageContext | undefined,
): string =>
  imageContext?.promptSummary
    ? [
        "",
        "Attached image context:",
        imageContext.promptSummary,
        "Use these attached images as task context when interpreting UI, visual, error, or acceptance details.",
      ].join("\n")
    : "";

export const buildAnalysisPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
  memoryContext?: PromptContextBundle,
  imageContext?: PromptImageContext,
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}

Previous clarification history:
${formatClarificationHistory(comments)}${formatRepositoryContext(memoryContext)}${formatImageContext(imageContext)}

Mode: analysis-only

Requirements:
1. Analyze the task and repository context only.
2. Do not modify files, do not create files, do not run formatters, and do not perform implementation work.
3. Reply with exactly one line that starts with AI_ANALYSIS: followed by one compact JSON object.
4. Do not add markdown fences, explanations, or any extra text around that one-line response.
5. Choose recommendedMode from: implement, ask_clarification, decompose, human.
6. Choose taskType from: frontend_ui_fix, backend_endpoint, tests_only, refactor, dependency_update, documentation, unknown.
7. Use promptProfileId from the same built-in ids, or general when no profile fits.
8. If critical context is missing, set recommendedMode to ask_clarification or human and list missingContext.
9. If the task is too large for one merge request, set recommendedMode to decompose.

Required JSON schema:
{
  "confidence": 82,
  "taskType": "frontend_ui_fix",
  "recommendedMode": "implement",
  "promptProfileId": "frontend_ui_fix",
  "expectedFiles": ["src/components/Button.tsx"],
  "expectedSubsystems": ["ui", "forms"],
  "riskFactors": ["visual regression risk"],
  "missingContext": [],
  "reasoning": "Localized UI fix with clear acceptance criteria."
}`;

export const buildTaskIntakeReviewPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
  memoryContext?: PromptContextBundle,
  imageContext?: PromptImageContext,
  maxQuestions = 5,
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}
${formatRepositoryContext(memoryContext)}${formatImageContext(imageContext)}

Mode: task-intake-review

Requirements:
1. Review the task specification quality only.
2. Do not modify files, do not create files, do not run commands, and do not perform implementation work.
3. Decide whether the task is ready for development, needs clarification, needs decomposition, or is invalid for an AI development worker.
4. Do not invent missing business requirements. If information is missing, ask for it explicitly.
5. When suggesting a rewritten title or description, preserve only facts present in the task, human comments, attachments, or repository context.
6. readinessScore must be an integer from 0 to 100.
7. Use [] when no acceptance criteria are directly supported by the task, human comments, attachments, or repository context.
8. Ask at most ${maxQuestions} clarification questions.
9. Reply with exactly one line that starts with AI_TASK_REVIEW: followed by one compact JSON object.
10. Do not add markdown fences, explanations, or any extra text around that one-line response.

Required JSON schema:
{
  "status": "needs_clarification",
  "readinessScore": 35,
  "summary": "The task lacks observable acceptance criteria.",
  "rewrittenTitle": "Clarify form submission failure",
  "rewrittenDescription": "Only include known facts; state that missing facts must be answered by the author.",
  "acceptanceCriteria": [],
  "clarificationQuestions": ["Which screen or workflow is affected?"],
  "decompositionHints": [],
  "riskFactors": ["The affected subsystem is unclear."],
  "reasoning": "The task describes a symptom but not the expected behavior."
}

Allowed status values:
- ready
- needs_clarification
- needs_decomposition
- reject_as_invalid`;

export const buildImplementationPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
  profile?: PromptProfile,
  analysisDecision?: TaskAnalysisDecision,
  memoryContext?: PromptContextBundle,
  imageContext?: PromptImageContext,
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}

Clarification history:
${formatClarificationHistory(comments)}

Structured analysis:
${formatAnalysisDecision(analysisDecision)}

${formatProfileGuidance(profile)}
${formatRepositoryContext(memoryContext)}${formatImageContext(imageContext)}

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
  profile?: PromptProfile,
  analysisDecision?: TaskAnalysisDecision,
  imageContext?: PromptImageContext,
): string => `Task: ${issue.key}
Title: ${issue.title}

The previous implementation did not pass validation. Fix the code and rerun the required checks.

Structured analysis:
${formatAnalysisDecision(analysisDecision)}

${formatProfileGuidance(profile)}
${formatImageContext(imageContext)}

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
  imageContext?: PromptImageContext,
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
${formatImageContext(imageContext)}

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
  profile?: PromptProfile,
  analysisDecision?: TaskAnalysisDecision,
  imageContext?: PromptImageContext,
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Relevant Tracker context:
${formatHumanComments(comments)}

Structured analysis:
${formatAnalysisDecision(analysisDecision)}

${formatProfileGuidance(profile)}
${formatImageContext(imageContext)}

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

export const buildDecompositionPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
  options: {
    maxSubtasks: number;
    defaultSubtaskTag: string;
    titlePrefix: string;
  },
  analysisDecision?: TaskAnalysisDecision,
  imageContext?: PromptImageContext,
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}

Structured analysis:
${formatAnalysisDecision(analysisDecision)}
${formatImageContext(imageContext)}

Mode: decomposition-only

Requirements:
1. Split this parent issue into no more than ${options.maxSubtasks} implementation-ready subtasks.
2. Do not modify repository files and do not run implementation commands.
3. Each subtask must include concrete acceptance criteria and a recommendedPromptProfileId.
4. Prefer queue ${issue.queue ?? issue.key.split("-")[0]}; only specify another queue if the issue clearly requires it.
5. Include tag ${options.defaultSubtaskTag} on every subtask unless a more specific tag is already present.
6. Use title prefix ${options.titlePrefix} when thinking about final Tracker titles, but return clean subtask titles without duplicating the prefix.
7. Express dependencies only between returned temporaryId values.
8. Reply with exactly one line that starts with AI_DECOMPOSITION: followed by one compact JSON object.

Required JSON schema:
{
  "parentIssueKey": "${issue.key}",
  "summary": "Short summary of the split.",
  "subtasks": [
    {
      "temporaryId": "task-1",
      "title": "Implement API contract",
      "description": "Detailed implementation scope.",
      "queue": "${issue.queue ?? issue.key.split("-")[0]}",
      "tags": ["${options.defaultSubtaskTag}"],
      "acceptanceCriteria": ["Criterion one"],
      "recommendedPromptProfileId": "backend_endpoint"
    }
  ],
  "dependencies": [
    {
      "blockedTaskTemporaryId": "task-2",
      "blockingTaskTemporaryId": "task-1",
      "reason": "UI work depends on the API contract."
    }
  ],
  "risks": ["Cross-subtask integration risk"]
}`;
