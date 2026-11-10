import type { TaskComment } from "./types.js";

/** Equal timestamps have no ordering guarantee after a PostgreSQL round trip. */
export const latestUnambiguousQuestion = (comments: readonly TaskComment[]): TaskComment | undefined => {
  const questions = comments.filter((comment) => comment.kind === "question")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = questions[0];
  if (!latest || questions[1]?.createdAt === latest.createdAt) return undefined;
  return latest;
};

export const answerToQuestion = (
  comments: readonly TaskComment[], question: TaskComment,
): TaskComment | undefined => comments.filter((comment) => {
  if (comment.kind !== "answer") return false;
  const linkedId = (comment.payload as Record<string, unknown> | undefined)?.questionId;
  // An explicit link is stronger evidence than timestamp ordering. Never reuse an
  // answer to a different question merely because it arrived later.
  return typeof linkedId === "string"
    ? linkedId === question.id && comment.createdAt >= question.createdAt
    : comment.createdAt > question.createdAt;
}).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
