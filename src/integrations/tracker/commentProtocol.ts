import type {
  ClarificationQuestion,
  CommentWithMetadata,
  HumanTaskCommand,
  LeaseKind,
  LogicalStatus,
  ParsedServiceComment,
  ReviewMetadata,
  TaskAnalysisDecision,
  TaskIntakeReviewDecision,
  TaskLease,
  TrackerComment,
  WaitingReason,
} from "../../models/types.js";

const STATUS_PREFIX = "AI STATUS:";
const QUESTION_PREFIX = "AI QUESTION:";
const MR_PREFIX = "AI MR:";
const REVIEW_PREFIX = "AI REVIEW:";
const LEASE_PREFIX = "AI LEASE:";
const ANALYSIS_PREFIX = "AI ANALYSIS:";
const TASK_REVIEW_PREFIX = "AI TASK REVIEW:";
const DECOMPOSITION_PREFIX = "AI DECOMPOSITION:";
const DIGEST_PREFIX = "AI DIGEST:";
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
  const fencedOpenMatches = Array.from(
    body.matchAll(/^[ \t]*```json[ \t]*(?:\r?\n|$)/gim),
  );
  const lastFenceStart = fencedOpenMatches.at(-1)?.index;
  const fencedMatch =
    lastFenceStart === undefined
      ? undefined
      : body
          .slice(lastFenceStart)
          .match(/^[ \t]*```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?:\r?\n[ \t]*)*$/i);
  const candidate =
    lastFenceStart === undefined ? body.trim() : fencedMatch?.[1]?.trim();
  if (!candidate) {
    return undefined;
  }

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

const parseMergeRequestIidFromUrl = (url: string): number | undefined => {
  const match = url.match(/\/(?:-\/)?merge_requests\/(\d+)(?:[/?#]|$)/);
  if (!match?.[1]) {
    return undefined;
  }

  const iid = Number(match[1]);
  return Number.isInteger(iid) ? iid : undefined;
};

const normalizeBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

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

const parseLeaseKind = (value: unknown): LeaseKind | undefined => {
  if (value === "task" || value === "repository") {
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

const parseTaskType = (
  value: unknown,
): ParsedServiceComment["taskType"] | undefined => {
  if (
    value === "frontend_ui_fix" ||
    value === "backend_endpoint" ||
    value === "tests_only" ||
    value === "refactor" ||
    value === "dependency_update" ||
    value === "documentation" ||
    value === "unknown"
  ) {
    return value;
  }

  return undefined;
};

const parseRecommendedMode = (
  value: unknown,
): ParsedServiceComment["recommendedMode"] | undefined => {
  if (
    value === "implement" ||
    value === "ask_clarification" ||
    value === "decompose" ||
    value === "human"
  ) {
    return value;
  }

  return undefined;
};

const parseTaskIntakeReviewStatus = (
  value: unknown,
): ParsedServiceComment["reviewStatus"] | undefined => {
  if (
    value === "ready" ||
    value === "needs_clarification" ||
    value === "needs_decomposition" ||
    value === "reject_as_invalid"
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
      const mergeRequestIid =
        normalizeNumber(jsonPayload.mergeRequestIid) ?? parseMergeRequestIidFromUrl(url);

      return {
        kind,
        worker,
        url,
        branch,
        ...(mergeRequestIid !== undefined ? { mergeRequestIid } : {}),
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

    if (kind === "AI LEASE") {
      const leaseKind = parseLeaseKind(jsonPayload.leaseKind ?? jsonPayload.kind);
      const issueKey = normalizeString(jsonPayload.issueKey);
      const repositoryName = normalizeString(jsonPayload.repositoryName);
      const repoPath = normalizeString(jsonPayload.repoPath);
      const acquiredAt = normalizeString(jsonPayload.acquiredAt);
      const expiresAt = normalizeString(jsonPayload.expiresAt);
      const heartbeatAt = normalizeString(jsonPayload.heartbeatAt);
      const token = normalizeString(jsonPayload.token);
      const leaseKey = normalizeString(jsonPayload.leaseKey);
      if (
        !leaseKind ||
        !issueKey ||
        !repositoryName ||
        !repoPath ||
        !acquiredAt ||
        !expiresAt ||
        !heartbeatAt ||
        !token ||
        !leaseKey
      ) {
        return undefined;
      }

      return {
        kind,
        worker,
        leaseKind,
        leaseKey,
        issueKey,
        repositoryName,
        repoPath,
        acquiredAt,
        expiresAt,
        heartbeatAt,
        token,
        releasedAt: normalizeString(jsonPayload.releasedAt),
      };
    }

    if (kind === "AI ANALYSIS") {
      const issueKey = normalizeString(jsonPayload.issueKey);
      const confidence = normalizeNumber(jsonPayload.confidence);
      const taskType = parseTaskType(jsonPayload.taskType);
      const recommendedMode = parseRecommendedMode(jsonPayload.recommendedMode);
      const promptProfileId = normalizeString(jsonPayload.promptProfileId);
      if (
        !issueKey ||
        confidence === undefined ||
        confidence < 0 ||
        confidence > 100 ||
        !taskType ||
        !recommendedMode ||
        !promptProfileId
      ) {
        return undefined;
      }

      return {
        kind,
        worker,
        issueKey,
        confidence,
        taskType,
        recommendedMode,
        promptProfileId,
        expectedFiles: normalizeStringArray(jsonPayload.expectedFiles) ?? [],
        expectedSubsystems: normalizeStringArray(jsonPayload.expectedSubsystems) ?? [],
        riskFactors: normalizeStringArray(jsonPayload.riskFactors) ?? [],
        missingContext: normalizeStringArray(jsonPayload.missingContext) ?? [],
        reasoning: normalizeString(jsonPayload.reasoning),
      };
    }

    if (kind === "AI TASK REVIEW") {
      const issueKey = normalizeString(jsonPayload.issueKey);
      const reviewStatus = parseTaskIntakeReviewStatus(jsonPayload.status);
      const readinessScore = normalizeNumber(jsonPayload.readinessScore);
      const sourceFingerprint = normalizeString(jsonPayload.sourceFingerprint);
      if (
        !issueKey ||
        !reviewStatus ||
        readinessScore === undefined ||
        readinessScore < 0 ||
        readinessScore > 100 ||
        !sourceFingerprint
      ) {
        return undefined;
      }

      return {
        kind,
        worker,
        issueKey,
        reviewStatus,
        readinessScore,
        sourceFingerprint,
        summary: normalizeString(jsonPayload.summary),
        rewrittenTitle: normalizeString(jsonPayload.rewrittenTitle),
        rewrittenDescription: normalizeString(jsonPayload.rewrittenDescription),
        acceptanceCriteria: normalizeStringArray(jsonPayload.acceptanceCriteria) ?? [],
        clarificationQuestions:
          normalizeStringArray(jsonPayload.clarificationQuestions) ?? [],
        decompositionHints: normalizeStringArray(jsonPayload.decompositionHints) ?? [],
        riskFactors: normalizeStringArray(jsonPayload.riskFactors) ?? [],
        reasoning: normalizeString(jsonPayload.reasoning),
      };
    }

    if (kind === "AI DECOMPOSITION") {
      const parentIssueKey = normalizeString(jsonPayload.parentIssueKey);
      const createdIssueKeys = normalizeStringArray(jsonPayload.createdIssueKeys) ?? [];
      const dryRun = normalizeBoolean(jsonPayload.dryRun);
      if (!parentIssueKey || dryRun === undefined) {
        return undefined;
      }

      return {
        kind,
        worker,
        parentIssueKey,
        createdIssueKeys,
        dryRun,
        details: normalizeString(jsonPayload.summary),
      };
    }

    if (kind === "AI DIGEST") {
      const taskId = normalizeString(jsonPayload.taskId);
      const digestKind = normalizeString(jsonPayload.digestKind);
      if (!taskId || !digestKind) {
        return undefined;
      }

      return {
        kind,
        worker,
        taskId,
        digestKind,
        externalKey: normalizeString(jsonPayload.externalKey),
        details: normalizeString(jsonPayload.details),
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
    const mergeRequestIid = parseMergeRequestIidFromUrl(parsed.url);
    return {
      kind,
      worker: parsed.worker,
      url: parsed.url,
      branch: parsed.branch,
      ...(mergeRequestIid !== undefined ? { mergeRequestIid } : {}),
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
  mergeRequestIid?: number,
): string =>
  buildStructuredComment(
    MR_PREFIX,
    {
      worker,
      url,
      branch,
      ...(mergeRequestIid !== undefined ? { mergeRequestIid } : {}),
    },
    [
      `Merge request: ${url}`,
      `Branch: ${branch}`,
      mergeRequestIid !== undefined ? `Merge request IID: ${mergeRequestIid}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
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

export const formatAnalysisComment = (
  worker: string,
  issueKey: string,
  decision: TaskAnalysisDecision,
): string =>
  buildStructuredComment(
    ANALYSIS_PREFIX,
    {
      worker,
      issueKey,
      confidence: decision.confidence,
      taskType: decision.taskType,
      recommendedMode: decision.recommendedMode,
      promptProfileId: decision.promptProfileId,
      expectedFiles: decision.expectedFiles,
      expectedSubsystems: decision.expectedSubsystems,
      riskFactors: decision.riskFactors,
      missingContext: decision.missingContext,
      reasoning: decision.reasoning,
    },
    [
      `Confidence: ${decision.confidence}`,
      `Task type: ${decision.taskType}`,
      `Recommended mode: ${decision.recommendedMode}`,
      `Prompt profile: ${decision.promptProfileId}`,
      decision.reasoning,
    ].join("\n"),
  );

const appendBulletSection = (
  lines: string[],
  title: string,
  items: string[],
): void => {
  if (items.length === 0) {
    return;
  }

  lines.push("", `${title}:`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
};

const formatTaskIntakeReviewBody = (
  decision: TaskIntakeReviewDecision,
): string => {
  const lines = [
    `Task intake review: ${decision.status}`,
    `Readiness score: ${decision.readinessScore}`,
    "",
    decision.summary,
  ];

  if (decision.rewrittenTitle) {
    lines.push("", "Suggested title:", decision.rewrittenTitle);
  }

  if (decision.rewrittenDescription) {
    lines.push("", "Suggested description:", decision.rewrittenDescription);
  }

  appendBulletSection(lines, "Acceptance criteria", decision.acceptanceCriteria);
  appendBulletSection(
    lines,
    "Questions for the task author",
    decision.clarificationQuestions,
  );
  appendBulletSection(lines, "Decomposition hints", decision.decompositionHints);
  appendBulletSection(lines, "Risk factors", decision.riskFactors);

  return lines.join("\n");
};

export const formatTaskIntakeReviewComment = (
  worker: string,
  issueKey: string,
  decision: TaskIntakeReviewDecision,
  sourceFingerprint: string,
): string =>
  buildStructuredComment(
    TASK_REVIEW_PREFIX,
    {
      worker,
      issueKey,
      status: decision.status,
      readinessScore: decision.readinessScore,
      sourceFingerprint,
      summary: decision.summary,
      ...(decision.rewrittenTitle ? { rewrittenTitle: decision.rewrittenTitle } : {}),
      ...(decision.rewrittenDescription
        ? { rewrittenDescription: decision.rewrittenDescription }
        : {}),
      acceptanceCriteria: decision.acceptanceCriteria,
      clarificationQuestions: decision.clarificationQuestions,
      decompositionHints: decision.decompositionHints,
      riskFactors: decision.riskFactors,
      reasoning: decision.reasoning,
    },
    formatTaskIntakeReviewBody(decision),
  );

export const formatDecompositionComment = (
  worker: string,
  input: {
    parentIssueKey: string;
    createdIssueKeys?: string[];
    dryRun: boolean;
    summary: string;
    plan?: unknown;
    warnings?: string[];
  },
): string =>
  buildStructuredComment(
    DECOMPOSITION_PREFIX,
    {
      worker,
      parentIssueKey: input.parentIssueKey,
      createdIssueKeys: input.createdIssueKeys ?? [],
      dryRun: input.dryRun,
      summary: input.summary,
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.warnings && input.warnings.length > 0 ? { warnings: input.warnings } : {}),
    },
    [
      input.dryRun ? "Decomposition dry run." : "Decomposition completed.",
      input.summary,
      input.createdIssueKeys && input.createdIssueKeys.length > 0
        ? `Created issues: ${input.createdIssueKeys.join(", ")}`
        : "",
      input.warnings && input.warnings.length > 0
        ? `Warnings: ${input.warnings.join("; ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

export const formatLeaseComment = (lease: TaskLease): string =>
  buildStructuredComment(
    LEASE_PREFIX,
    {
      worker: lease.workerId,
      leaseKind: lease.kind,
      leaseKey: lease.leaseKey,
      issueKey: lease.issueKey,
      repositoryName: lease.repositoryName,
      repoPath: lease.repoPath,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      heartbeatAt: lease.heartbeatAt,
      token: lease.token,
      ...(lease.releasedAt ? { releasedAt: lease.releasedAt } : {}),
    },
    [
      `${lease.kind} lease for ${lease.issueKey}.`,
      `Repository: ${lease.repositoryName}`,
      `Expires at: ${lease.expiresAt}`,
      lease.releasedAt ? `Released at: ${lease.releasedAt}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

export const formatDigestComment = (
  worker: string,
  input: {
    taskId: string;
    digestKind: string;
    details: string;
    externalKey?: string;
    payload?: Record<string, unknown>;
  },
): string =>
  buildStructuredComment(
    DIGEST_PREFIX,
    {
      worker,
      taskId: input.taskId,
      digestKind: input.digestKind,
      details: input.details,
      ...(input.externalKey ? { externalKey: input.externalKey } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    },
    input.details,
  );

export const parseServiceComment = (
  text: string,
): ParsedServiceComment | undefined =>
  parseStructuredServiceComment(STATUS_PREFIX, "AI STATUS", text) ??
  parseStructuredServiceComment(QUESTION_PREFIX, "AI QUESTION", text) ??
  parseStructuredServiceComment(MR_PREFIX, "AI MR", text) ??
  parseStructuredServiceComment(REVIEW_PREFIX, "AI REVIEW", text) ??
  parseStructuredServiceComment(LEASE_PREFIX, "AI LEASE", text) ??
  parseStructuredServiceComment(ANALYSIS_PREFIX, "AI ANALYSIS", text) ??
  parseStructuredServiceComment(TASK_REVIEW_PREFIX, "AI TASK REVIEW", text) ??
  parseStructuredServiceComment(DECOMPOSITION_PREFIX, "AI DECOMPOSITION", text) ??
  parseStructuredServiceComment(DIGEST_PREFIX, "AI DIGEST", text);

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

export const findLatestAnalysisDecision = (
  comments: CommentWithMetadata[],
  issueKey?: string,
): TaskAnalysisDecision | undefined => {
  const metadata = comments
    .filter(
      (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
        comment.metadata?.kind === "AI ANALYSIS" &&
        (issueKey === undefined || comment.metadata.issueKey === issueKey),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.metadata;

  if (
    metadata?.confidence === undefined ||
    !metadata.taskType ||
    !metadata.recommendedMode ||
    !metadata.promptProfileId
  ) {
    return undefined;
  }

  return {
    confidence: metadata.confidence,
    taskType: metadata.taskType,
    recommendedMode: metadata.recommendedMode,
    promptProfileId: metadata.promptProfileId,
    expectedFiles: metadata.expectedFiles ?? [],
    expectedSubsystems: metadata.expectedSubsystems ?? [],
    riskFactors: metadata.riskFactors ?? [],
    missingContext: metadata.missingContext ?? [],
    reasoning: metadata.reasoning ?? "Analysis decision restored from Tracker comment.",
  };
};

export const findLatestTaskIntakeReview = (
  comments: CommentWithMetadata[],
  issueKey?: string,
): ParsedServiceComment | undefined =>
  comments
    .filter(
      (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
        comment.metadata?.kind === "AI TASK REVIEW" &&
        (issueKey === undefined || comment.metadata.issueKey === issueKey),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.metadata;

export const findLatestDecompositionMetadata = (
  comments: CommentWithMetadata[],
  parentIssueKey?: string,
): ParsedServiceComment | undefined =>
  comments
    .filter(
      (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
        comment.metadata?.kind === "AI DECOMPOSITION" &&
        (parentIssueKey === undefined ||
          comment.metadata.parentIssueKey === parentIssueKey),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.metadata;

const leaseFromMetadata = (
  metadata: ParsedServiceComment | undefined,
): TaskLease | undefined => {
  if (
    metadata?.kind !== "AI LEASE" ||
    !metadata.leaseKind ||
    !metadata.leaseKey ||
    !metadata.issueKey ||
    !metadata.repositoryName ||
    !metadata.repoPath ||
    !metadata.acquiredAt ||
    !metadata.expiresAt ||
    !metadata.heartbeatAt ||
    !metadata.token
  ) {
    return undefined;
  }

  return {
    kind: metadata.leaseKind,
    leaseKey: metadata.leaseKey,
    issueKey: metadata.issueKey,
    workerId: metadata.worker,
    repositoryName: metadata.repositoryName,
    repoPath: metadata.repoPath,
    acquiredAt: metadata.acquiredAt,
    expiresAt: metadata.expiresAt,
    heartbeatAt: metadata.heartbeatAt,
    token: metadata.token,
    ...(metadata.releasedAt ? { releasedAt: metadata.releasedAt } : {}),
  };
};

export const getLeaseComments = (
  comments: CommentWithMetadata[],
): Array<CommentWithMetadata & { metadata: ParsedServiceComment }> =>
  comments.filter(
    (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
      comment.metadata?.kind === "AI LEASE",
  );

export const isLeaseExpired = (lease: TaskLease, now: Date = new Date()): boolean => {
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime();
};

export const findLatestLease = (
  comments: CommentWithMetadata[],
  options: {
    kind?: LeaseKind;
    leaseKey?: string;
  } = {},
): TaskLease | undefined =>
  getLeaseComments(comments)
    .map((comment) => ({
      createdAt: comment.createdAt,
      lease: leaseFromMetadata(comment.metadata),
    }))
    .filter(
      (entry): entry is { createdAt: string; lease: TaskLease } =>
        entry.lease !== undefined &&
        (options.kind === undefined || entry.lease.kind === options.kind) &&
        (options.leaseKey === undefined || entry.lease.leaseKey === options.leaseKey),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.lease;

export const findActiveLease = (
  comments: CommentWithMetadata[],
  options: {
    kind?: LeaseKind;
    leaseKey?: string;
    now?: Date;
  } = {},
): TaskLease | undefined => {
  const latest = findLatestLease(comments, options);
  if (!latest || latest.releasedAt || isLeaseExpired(latest, options.now)) {
    return undefined;
  }

  return latest;
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
