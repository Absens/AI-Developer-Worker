import type { CommentWithMetadata, TrackerIssue } from "../models/types.js";
import {
  findFirstHumanReplyAfter,
  findLatestQuestionComment,
} from "../integrations/tracker/commentProtocol.js";

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

const formatQuestionAnswerHistory = (comments: CommentWithMetadata[]): string => {
  const latestQuestion = findLatestQuestionComment(comments);
  if (!latestQuestion?.metadata.question) {
    return "No previous AI questions.";
  }

  const answer = findFirstHumanReplyAfter(comments, latestQuestion.createdAt);
  return [
    `Question: ${latestQuestion.metadata.question}`,
    `Answer: ${answer?.text ?? "No answer yet."}`,
  ].join("\n");
};

export const buildInitialPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}

Previous AI Q/A:
${formatQuestionAnswerHistory(comments)}

Requirements:
1. Analyze the repository.
2. Create an implementation plan.
3. Implement the solution.
4. Run project tests.
5. Follow the existing architecture and coding style.
6. If critical business context is missing, output one line starting with AI_QUESTION: and then the question text.`;

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
3. If critical business context is missing, output one line starting with AI_QUESTION: and then the question text.`;
