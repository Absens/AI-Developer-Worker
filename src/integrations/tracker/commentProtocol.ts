import type {
  CommentWithMetadata,
  LogicalStatus,
  ParsedServiceComment,
  TrackerComment,
} from "../../models/types.js";

const STATUS_PREFIX = "AI STATUS:";
const QUESTION_PREFIX = "AI QUESTION:";
const MR_PREFIX = "AI MR:";

const parseKeyValueLines = (body: string): Record<string, string> => {
  const pairs = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const delimiterIndex = line.indexOf("=");
      if (delimiterIndex < 0) {
        return null;
      }
      return [
        line.slice(0, delimiterIndex).trim(),
        line.slice(delimiterIndex + 1).trim(),
      ] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return Object.fromEntries(pairs);
};

export const formatStatusComment = (
  worker: string,
  state: LogicalStatus,
  details: string,
): string => `${STATUS_PREFIX}
worker=${worker}
state=${state}
details=${details}`;

export const formatQuestionComment = (worker: string, question: string): string =>
  `${QUESTION_PREFIX}
worker=${worker}
question=${question}`;

export const formatMergeRequestComment = (
  worker: string,
  url: string,
  branch: string,
): string => `${MR_PREFIX}
worker=${worker}
url=${url}
branch=${branch}`;

export const parseServiceComment = (
  text: string,
): ParsedServiceComment | undefined => {
  const normalized = text.trim();
  if (normalized.startsWith(STATUS_PREFIX)) {
    const parsed = parseKeyValueLines(normalized.slice(STATUS_PREFIX.length));
    if (!parsed.worker || !parsed.state) {
      return undefined;
    }
    return {
      kind: "AI STATUS",
      worker: parsed.worker,
      state: parsed.state as LogicalStatus,
      details: parsed.details,
    };
  }

  if (normalized.startsWith(QUESTION_PREFIX)) {
    const parsed = parseKeyValueLines(normalized.slice(QUESTION_PREFIX.length));
    if (!parsed.worker || !parsed.question) {
      return undefined;
    }
    return {
      kind: "AI QUESTION",
      worker: parsed.worker,
      question: parsed.question,
    };
  }

  if (normalized.startsWith(MR_PREFIX)) {
    const parsed = parseKeyValueLines(normalized.slice(MR_PREFIX.length));
    if (!parsed.worker || !parsed.url || !parsed.branch) {
      return undefined;
    }
    return {
      kind: "AI MR",
      worker: parsed.worker,
      url: parsed.url,
      branch: parsed.branch,
    };
  }

  return undefined;
};

export const decorateComments = (
  comments: TrackerComment[],
): CommentWithMetadata[] =>
  comments.map((comment) => ({
    ...comment,
    metadata: parseServiceComment(comment.text),
  }));

export const getLatestServiceState = (
  comments: CommentWithMetadata[],
): ParsedServiceComment | undefined => {
  const serviceComments = comments
    .filter((comment) => comment.metadata)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );

  return serviceComments.at(-1)?.metadata;
};

export const findLatestStatusComment = (
  comments: CommentWithMetadata[],
): ParsedServiceComment | undefined => {
  const statusComments = comments
    .filter(
      (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
        comment.metadata?.kind === "AI STATUS",
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  return statusComments.at(-1)?.metadata;
};

export const findLatestQuestionComment = (
  comments: CommentWithMetadata[],
): (CommentWithMetadata & { metadata: ParsedServiceComment }) | undefined =>
  comments
    .filter(
      (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
        comment.metadata?.kind === "AI QUESTION",
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);

export const findFirstHumanReplyAfter = (
  comments: CommentWithMetadata[],
  timestamp: string,
): CommentWithMetadata | undefined =>
  comments
    .filter((comment) => !comment.metadata && !comment.isSystem)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .find((comment) => comment.createdAt > timestamp);
