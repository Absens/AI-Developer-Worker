import type { TaskRecord } from "../taskTracker/index.js";

export interface TelegramTaskCandidate {
  task: TaskRecord;
  score: number;
  reasons: string[];
}

const SEARCH_TOKEN_PATTERN = /[\p{L}\p{N}_-]+/gu;

export const resolveTelegramTaskCandidates = (
  query: string,
  tasks: TaskRecord[],
): TelegramTaskCandidate[] => {
  const queryTerms = tokenizeSearchTerms(query);

  return tasks
    .map((task) => scoreTaskCandidate(query, queryTerms, task))
    .filter((candidate) => candidate.score > 0)
    .sort(compareTelegramTaskCandidates);
};

const scoreTaskCandidate = (
  query: string,
  queryTerms: string[],
  task: TaskRecord,
): TelegramTaskCandidate => {
  let score = 0;
  const reasons: string[] = [];

  if (matchesTaskId(query, task.id)) {
    score += 100;
    reasons.push("direct_task_id");
  }

  const haystackTerms = tokenizeSearchTerms(buildTaskHaystack(task));
  const haystackTermSet = new Set(haystackTerms);
  for (const term of new Set(queryTerms)) {
    if (!haystackTermSet.has(term)) {
      continue;
    }
    score += 10;
    reasons.push(`term:${term}`);
  }

  return { task, score, reasons };
};

const buildTaskHaystack = (task: TaskRecord): string => {
  const values: Array<string | undefined> = [
    task.id,
    task.title,
    task.description,
    task.humanSummary,
    task.repositoryName,
    task.repoPathKey,
    task.baseBranch,
    task.queue,
    task.businessStatus,
    ...task.tags,
    ...task.components,
    ...task.externalRefs.flatMap((ref) => [
      ref.provider,
      ref.externalKey,
      ref.externalUrl,
      ref.businessStatus,
    ]),
    ...task.events.flatMap((event) => [
      event.kind,
      event.message,
      event.createdAt,
      stringifyPayload(event.payload),
    ]),
    ...task.mergeRequests.flatMap((mergeRequest) => [
      mergeRequest.branch,
      mergeRequest.mergeRequest.title,
      mergeRequest.mergeRequest.sourceBranch,
      mergeRequest.mergeRequest.targetBranch,
      mergeRequest.mergeRequest.url,
    ]),
  ];

  return values.filter(isNonEmptyString).join(" ");
};

const tokenizeSearchTerms = (input: string): string[] => {
  const terms = new Set<string>();
  for (const match of input.matchAll(SEARCH_TOKEN_PATTERN)) {
    const rawTerm = match[0]?.toLowerCase();
    if (!rawTerm || rawTerm.length < 3 || !hasSearchCharacter(rawTerm)) {
      continue;
    }

    terms.add(rawTerm);
    terms.add(normalizeSearchTerm(rawTerm));
  }

  return [...terms].filter((term) => term.length >= 3);
};

const normalizeSearchTerm = (term: string): string => {
  if (!/[\p{Script=Cyrillic}]/u.test(term) || term.length < 5) {
    return term;
  }

  return term.replace(
    /(иями|ями|ами|ого|ему|ыми|ими|иям|иях|ия|ии|ию|ие|ий|ей|ая|ое|ые|ый|ой|ую|юю|ом|ем|ам|ям|ах|ях|а|я|ы|и|у|ю|е|о)$/u,
    "",
  );
};

const matchesTaskId = (query: string, taskId: string): boolean => {
  const taskIdPattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_-])${escapeRegExp(taskId)}(?=$|[^\\p{L}\\p{N}_-])`,
    "iu",
  );
  return taskIdPattern.test(query);
};

const compareTelegramTaskCandidates = (
  left: TelegramTaskCandidate,
  right: TelegramTaskCandidate,
): number => {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return timestampForTask(right.task) - timestampForTask(left.task);
};

const timestampForTask = (task: TaskRecord): number => {
  const timestamp = Date.parse(task.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const stringifyPayload = (payload: Record<string, unknown> | undefined): string | undefined => {
  if (payload === undefined) {
    return undefined;
  }

  return JSON.stringify(payload);
};

const hasSearchCharacter = (value: string): boolean =>
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{N}]/u.test(value);

const isNonEmptyString = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
