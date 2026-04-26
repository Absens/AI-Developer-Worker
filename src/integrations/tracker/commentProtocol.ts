import type {
  ClarificationQuestion,
  CommentWithMetadata,
  HumanTaskCommand,
  LogicalStatus,
  ParsedServiceComment,
  ReviewMetadata,
  TrackerComment,
  WaitingReason,
} from "../../models/types.js";

const STATUS_PREFIX = "AI STATUS:";
const QUESTION_PREFIX = "AI QUESTION:";
const MR_PREFIX = "AI MR:";
const REVIEW_PREFIX = "AI REVIEW:";
const JSON_BLOCK_START = "```json";
const JSON_BLOCK_END = "```";
const DEFAULT_RESUME_HINT =
  "Reply with /resume <option> or /resume freeform: <your answer>.";

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

const escapeJsonForCodeFence = (payload: Record<string, unknown>): string =>
  JSON.stringify(payload, null, 2);

const extractJsonPayload = (body: string): Record<string, unknown> | undefined => {
  const fencedMatch = body.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? body.trim();
  if (!candidate.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [];
};

const normalizeNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  return value;
};

const normalizeNumberArray = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.filter(
    (entry): entry is number => typeof entry === "number" && Number.isInteger(entry),
  );

  return normalized.length === value.length ? normalized : undefined;
};

const parseWaitingReason = (value: unknown): WaitingReason | undefined => {
  if (
    value === "clarification" ||
    value === "failure_recovery" ||
    value === "manual_hold"
  ) {
    return value;
  }

  return undefined;
};

const parseLogicalStatus = (value: unknown): LogicalStatus | undefined => {
  if (
    value === "open" ||
    value === "in_progress" ||
    value === "waiting_for_answer" ||
    value === "review" ||
    value === "failed" ||
    value === "done"
  ) {
    return value;
  }

  return undefined;
};

const normalizeClarificationQuestion = (
  value: Record<string, unknown>,
): ClarificationQuestion | undefined => {
  const question = normalizeString(value.question);
  const summary = normalizeString(value.summary) ?? question;
  const blockingReason = normalizeString(value.blockingReason) ?? summary;
  const options = normalizeStringArray(value.options) ?? [];
  const resumeHint = normalizeString(value.resumeHint) ?? DEFAULT_RESUME_HINT;

  if (!question || !summary || !blockingReason) {
    return undefined;
  }

  return {
    summary,
    blockingReason,
    question,
    options,
    resumeHint,
  };
};

const buildStructuredComment = (
  prefix: string,
  payload: Record<string, unknown>,
  humanBody?: string,
): string => [
  prefix,
  humanBody?.trim(),
  JSON_BLOCK_START,
  escapeJsonForCodeFence(payload),
  JSON_BLOCK_END,
]
  .filter(Boolean)
  .join("\n\n");

const formatClarificationBody = (clarification: ClarificationQuestion): string => {
  const lines = [
    clarification.summary,
    "",
    `Question: ${clarification.question}`,
    `Blocking reason: ${clarification.blockingReason}`,
  ];

  if (clarification.options.length > 0) {
    lines.push("", "Options:");
    for (const option of clarification.options) {
      lines.push(`- ${option}`);
    }
  }

  lines.push("", "To continue:", clarification.resumeHint);
  return lines.join("\n");
};

const parseStructuredServiceComment = (
  prefix: string,
  kind: ParsedServiceComment["kind"],
  text: string,
): ParsedServiceComment | undefined => {
  const normalized = text.trim();
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }

  const body = normalized.slice(prefix.length).trim();
  const jsonPayload = extractJsonPayload(body);
  if (jsonPayload) {
    const worker = normalizeString(jsonPayload.worker);
    if (!worker) {
      return undefined;
    }

    if (kind === "AI STATUS") {
      const state = parseLogicalStatus(jsonPayload.state);
      if (!state) {
        return undefined;
      }

      return {
        kind,
        worker,
        state,
        details: normalizeString(jsonPayload.details),
        waitingReason: parseWaitingReason(jsonPayload.waitingReason),
      };
    }

    if (kind === "AI QUESTION") {
      const clarification = normalizeClarificationQuestion(jsonPayload);
      if (!clarification) {
        return undefined;
      }

      return {
        kind,
        worker,
        question: clarification.question,
        threadId: normalizeString(jsonPayload.threadId),
        mode: "clarification",
        summary: clarification.summary,
        blockingReason: clarification.blockingReason,
        options: clarification.options,
        resumeHint: clarification.resumeHint,
        waitingReason: parseWaitingReason(jsonPayload.waitingReason) ?? "clarification",
      };
    }

    if (kind === "AI MR") {
      const url = normalizeString(jsonPayload.url);
      const branch = normalizeString(jsonPayload.branch);
      if (!url || !branch) {
        return undefined;
      }

      return {
        kind,
        worker,
        url,
        branch,
      };
    }

    if (kind === "AI REVIEW") {
      const issueKey = normalizeString(jsonPayload.issueKey);
      const mergeRequestIid = normalizeNumber(jsonPayload.mergeRequestIid);
      if (!issueKey || mergeRequestIid === undefined) {
        return undefined;
      }

      return {
        kind,
        worker,
        issueKey,
        mergeRequestIid,
        processedDiscussionIds:
          normalizeStringArray(jsonPayload.processedDiscussionIds) ?? [],
        processedNoteIds: normalizeNumberArray(jsonPayload.processedNoteIds) ?? [],
        lastFixCommit: normalizeString(jsonPayload.lastFixCommit),
      };
    }
  }

  const parsed = parseKeyValueLines(body);
  if (!parsed.worker) {
    return undefined;
  }

  if (kind === "AI STATUS" && parsed.state) {
    return {
      kind,
      worker: parsed.worker,
      state: parsed.state as LogicalStatus,
      details: parsed.details,
      waitingReason: parseWaitingReason(parsed.waitingReason),
    };
  }

  if (kind === "AI QUESTION" && parsed.question) {
    return {
      kind,
      worker: parsed.worker,
      question: parsed.question,
      threadId: parsed.threadId,
      mode: "clarification",
      summary: parsed.question,
      blockingReason: parsed.question,
      options: [],
      resumeHint: DEFAULT_RESUME_HINT,
      waitingReason: "clarification",
    };
  }

  if (kind === "AI MR" && parsed.url && parsed.branch) {
    return {
      kind,
      worker: parsed.worker,
      url: parsed.url,
      branch: parsed.branch,
    };
  }

  return undefined;
};

export const formatStatusComment = (
  worker: string,
  state: LogicalStatus,
  details: string,
  waitingReason?: WaitingReason,
): string =>
  buildStructuredComment(
    STATUS_PREFIX,
    {
      worker,
      state,
      details,
      ...(waitingReason ? { waitingReason } : {}),
    },
    details,
  );

export const formatQuestionComment = (
  worker: string,
  clarification: string | ClarificationQuestion,
): string => formatQuestionCommentWithThreadId(worker, clarification);

export const formatQuestionCommentWithThreadId = (
  worker: string,
  clarification: string | ClarificationQuestion,
  threadId?: string,
): string => {
  const normalized =
    typeof clarification === "string"
      ? {
          summary: clarification,
          blockingReason: clarification,
          question: clarification,
          options: [],
          resumeHint: DEFAULT_RESUME_HINT,
        }
      : {
          ...clarification,
          resumeHint: clarification.resumeHint || DEFAULT_RESUME_HINT,
        };

  return buildStructuredComment(
    QUESTION_PREFIX,
    {
      worker,
      threadId,
      mode: "clarification",
      waitingReason: "clarification",
      ...normalized,
    },
    formatClarificationBody(normalized),
  );
};

export const formatMergeRequestComment = (
  worker: string,
  url: string,
  branch: string,
): string =>
  buildStructuredComment(
    MR_PREFIX,
    {
      worker,
      url,
      branch,
    },
    `Merge request: ${url}\nBranch: ${branch}`,
  );

export const formatReviewMetadataComment = (
  metadata: ReviewMetadata,
): string =>
  buildStructuredComment(
    REVIEW_PREFIX,
    {
      worker: metadata.worker,
      issueKey: metadata.issueKey,
      mergeRequestIid: metadata.mergeRequestIid,
      processedDiscussionIds: metadata.processedDiscussionIds,
      processedNoteIds: metadata.processedNoteIds,
      ...(metadata.lastFixCommit ? { lastFixCommit: metadata.lastFixCommit } : {}),
    },
    [
      `Review feedback processed for ${metadata.issueKey}.`,
      `Merge request IID: ${metadata.mergeRequestIid}`,
      metadata.lastFixCommit ? `Last fix commit: ${metadata.lastFixCommit}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

export const parseServiceComment = (
  text: string,
): ParsedServiceComment | undefined =>
  parseStructuredServiceComment(STATUS_PREFIX, "AI STATUS", text) ??
  parseStructuredServiceComment(QUESTION_PREFIX, "AI QUESTION", text) ??
  parseStructuredServiceComment(MR_PREFIX, "AI MR", text) ??
  parseStructuredServiceComment(REVIEW_PREFIX, "AI REVIEW", text);

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

export const findLatestReviewMetadata = (
  comments: CommentWithMetadata[],
  issueKey: string,
  mergeRequestIid?: number,
): ReviewMetadata | undefined => {
  const metadata = comments
    .filter(
      (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
        comment.metadata?.kind === "AI REVIEW" &&
        comment.metadata.issueKey === issueKey &&
        (mergeRequestIid === undefined ||
          comment.metadata.mergeRequestIid === mergeRequestIid),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.metadata;

  if (!metadata?.issueKey || metadata.mergeRequestIid === undefined) {
    return undefined;
  }

  return {
    worker: metadata.worker,
    issueKey: metadata.issueKey,
    mergeRequestIid: metadata.mergeRequestIid,
    processedDiscussionIds: metadata.processedDiscussionIds ?? [],
    processedNoteIds: metadata.processedNoteIds ?? [],
    ...(metadata.lastFixCommit ? { lastFixCommit: metadata.lastFixCommit } : {}),
  };
};

export const findHumanCommentsAfter = (
  comments: CommentWithMetadata[],
  timestamp: string,
): CommentWithMetadata[] =>
  comments
    .filter((comment) => !comment.metadata && !comment.isSystem && comment.createdAt > timestamp)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

export const findFirstHumanReplyAfter = (
  comments: CommentWithMetadata[],
  timestamp: string,
): CommentWithMetadata | undefined => findHumanCommentsAfter(comments, timestamp)[0];

export const parseHumanTaskCommand = (
  text: string,
): HumanTaskCommand | undefined => {
  const normalized = text.trim();
  if (!normalized.includes("/")) {
    return undefined;
  }

  const lines = normalized.split(/\r?\n/);
  let commandLineIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim().startsWith("/")) {
      commandLineIndex = index;
      break;
    }
  }
  if (commandLineIndex < 0) {
    return undefined;
  }

  const commandLine = lines[commandLineIndex]?.trim() ?? "";
  const remainder = lines.slice(commandLineIndex + 1).join("\n").trim();

  if (/^\/skip\b/i.test(commandLine)) {
    return {
      type: "skip",
      rawText: normalized,
      ...(remainder ? { freeform: remainder } : {}),
    };
  }

  if (/^\/cancel\b/i.test(commandLine)) {
    return {
      type: "cancel",
      rawText: normalized,
      ...(remainder ? { freeform: remainder } : {}),
    };
  }

  const resumeMatch = commandLine.match(/^\/resume(?:\s+(.+))?$/i);
  if (!resumeMatch) {
    return undefined;
  }

  const argument = resumeMatch[1]?.trim() ?? "";
  const freeformMatch = argument.match(/^freeform\s*:\s*(.+)$/i);
  if (freeformMatch) {
    const freeform = [
      (freeformMatch[1] ?? "").trim(),
      remainder,
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      type: "resume",
      rawText: normalized,
      ...(freeform ? { freeform } : {}),
    };
  }

  if (!argument || /^continue$/i.test(argument)) {
    return {
      type: "resume",
      rawText: normalized,
      ...(remainder ? { freeform: remainder } : {}),
    };
  }

  const [choice, ...rest] = argument.split(/\s+/);
  const freeform = [rest.join(" ").trim(), remainder].filter(Boolean).join("\n").trim();
  return {
    type: "resume",
    rawText: normalized,
    ...(choice ? { choice } : {}),
    ...(freeform ? { freeform } : {}),
  };
};

export const findLatestHumanTaskCommandAfter = (
  comments: CommentWithMetadata[],
  timestamp: string,
): HumanTaskCommand | undefined => {
  const commands = findHumanCommentsAfter(comments, timestamp)
    .map((comment) => parseHumanTaskCommand(comment.text))
    .filter((command): command is HumanTaskCommand => command !== undefined);

  return commands.at(-1);
};
