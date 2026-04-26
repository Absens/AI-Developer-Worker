import type {
  PriorityQueueConfig,
  RepositoryProfile,
  TrackerIssue,
} from "../models/types.js";

export interface CandidateIssue {
  issue: TrackerIssue;
  repository: RepositoryProfile;
  commentsLoadedAt?: string;
}

export interface CandidateScore {
  total: number;
  priority: number;
  deadline: number;
  tags: number;
  components: number;
  manualOverride: number;
  staleLease: number;
  confidence: number;
}

export interface ScoredCandidate extends CandidateIssue {
  score: CandidateScore;
}

const normalize = (value: string): string => value.trim().toLowerCase();

const startOfUtcDay = (date: Date): number =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

const scoreDeadline = (
  deadline: string | undefined,
  config: PriorityQueueConfig,
  now: Date,
): number => {
  if (!deadline) {
    return 0;
  }

  const deadlineTime = Date.parse(deadline);
  if (Number.isNaN(deadlineTime)) {
    return 0;
  }

  const today = startOfUtcDay(now);
  const dueDay = startOfUtcDay(new Date(deadlineTime));
  if (dueDay < today) {
    return config.deadlineBoost.overdue;
  }
  if (dueDay === today) {
    return config.deadlineBoost.dueToday;
  }

  return 0;
};

const sumBoosts = (
  values: string[] | undefined,
  boosts: Record<string, number>,
): number =>
  (values ?? []).reduce((total, value) => total + (boosts[normalize(value)] ?? 0), 0);

export const scoreCandidate = (
  issue: TrackerIssue,
  config: PriorityQueueConfig,
  options: {
    now?: Date;
    staleLeasePenalty?: number;
    confidenceScore?: number;
  } = {},
): CandidateScore => {
  const now = options.now ?? new Date();
  const normalizedTags = (issue.tags ?? []).map(normalize);
  const priority = issue.priority
    ? (config.priorityWeights[normalize(issue.priority)] ?? 0)
    : 0;
  const manualOverride = normalizedTags.some((tag) =>
    config.manualOverrideTags.map(normalize).includes(tag),
  )
    ? 10_000
    : 0;
  const tags = sumBoosts(issue.tags, config.tagBoosts);
  const components = sumBoosts(issue.components, config.componentBoosts);
  const deadline = scoreDeadline(issue.deadline, config, now);
  const staleLease = options.staleLeasePenalty ?? 0;
  const confidence = options.confidenceScore ?? 0;

  return {
    total: priority + deadline + tags + components + manualOverride + staleLease + confidence,
    priority,
    deadline,
    tags,
    components,
    manualOverride,
    staleLease,
    confidence,
  };
};

const createdAtForSort = (issue: TrackerIssue): string =>
  issue.createdAt || issue.updatedAt || "";

export const sortScoredCandidates = (
  candidates: ScoredCandidate[],
  config: PriorityQueueConfig,
): ScoredCandidate[] =>
  [...candidates].sort((left, right) => {
    const scoreDiff = right.score.total - left.score.total;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    const createdDiff = createdAtForSort(left.issue).localeCompare(
      createdAtForSort(right.issue),
    );
    if (createdDiff !== 0) {
      return config.createdAtTieBreaker === "oldest" ? createdDiff : -createdDiff;
    }

    const keyDiff = left.issue.key.localeCompare(right.issue.key);
    if (keyDiff !== 0) {
      return keyDiff;
    }

    return left.repository.name.localeCompare(right.repository.name);
  });

export const scoreAndSortCandidates = (
  candidates: CandidateIssue[],
  config: PriorityQueueConfig,
  now: Date = new Date(),
): ScoredCandidate[] =>
  sortScoredCandidates(
    candidates.map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate.issue, config, { now }),
    })),
    config,
  );
