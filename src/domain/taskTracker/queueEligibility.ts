import type {
  ClaimRepositoryProfile,
  TaskDependency,
  TaskLeaseRecord,
  TaskRecord,
} from "./types.js";

const PRIORITY_WEIGHTS: Record<string, number> = {
  blocker: 1000,
  critical: 700,
  high: 400,
  normal: 100,
  low: 0,
};

const MANUAL_OVERRIDE_TAGS = new Set(["ai_priority"]);

const normalize = (value: string): string => value.trim().toLowerCase();

const startOfUtcDay = (date: Date): number =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

const scoreDeadline = (deadline: string | undefined, now: Date): number => {
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
    return 600;
  }
  if (dueDay === today) {
    return 300;
  }

  return 0;
};

export const normalizeRepositoryLeaseKey = (value: string): string =>
  value.trim().replace(/\\/g, "/").toLowerCase();

export const taskLeaseKeyForTask = (taskId: string): string => `task:${taskId}`;

export const repositoryLeaseKeyForTask = (
  task: Pick<TaskRecord, "repositoryName" | "repoPathKey">,
): string => {
  const rawKey = task.repoPathKey ?? task.repositoryName;
  if (!rawKey) {
    throw new Error("Task has no repository key for lease creation.");
  }

  return `repo:${normalizeRepositoryLeaseKey(rawKey)}`;
};

export const isLeaseActiveAt = (lease: TaskLeaseRecord, now: Date): boolean =>
  lease.releasedAt === undefined && Date.parse(lease.expiresAt) > now.getTime();

export const taskMatchesRepositoryProfile = (
  task: TaskRecord,
  profiles: readonly ClaimRepositoryProfile[],
): boolean =>
  profiles.some((profile) => {
    if (task.repositoryName !== profile.name) {
      return false;
    }
    if (profile.repoPathKey && task.repoPathKey !== profile.repoPathKey) {
      return false;
    }
    if (
      profile.queues &&
      profile.queues.length > 0 &&
      (!task.queue || !profile.queues.includes(task.queue))
    ) {
      return false;
    }
    if (
      profile.tags &&
      profile.tags.length > 0 &&
      !profile.tags.some((tag) => task.tags.includes(tag))
    ) {
      return false;
    }

    return true;
  });

export const taskMatchesTarget = (
  task: TaskRecord,
  targetExternalKey: string | undefined,
): boolean => {
  if (!targetExternalKey) {
    return true;
  }

  return (
    task.id === targetExternalKey ||
    task.externalRefs.some((ref) => ref.externalKey === targetExternalKey)
  );
};

export const claimPriorityScore = (task: TaskRecord, now: Date): number => {
  const priority = task.priority
    ? (PRIORITY_WEIGHTS[normalize(task.priority)] ?? 0)
    : 0;
  const manualOverride = task.tags.map(normalize).some((tag) => MANUAL_OVERRIDE_TAGS.has(tag))
    ? 10_000
    : 0;
  const confidence = task.confidence !== undefined ? task.confidence * 2 : 0;

  return priority + manualOverride + scoreDeadline(task.deadline, now) + confidence;
};

const dependencyBlocksTask = (dependency: TaskDependency, taskId: string): boolean => {
  if (dependency.status !== "active") {
    return false;
  }

  if (dependency.kind === "blocks") {
    return dependency.toTaskId === taskId;
  }

  if (
    dependency.kind === "blocked_by" ||
    dependency.kind === "requires_human_input" ||
    dependency.kind === "requires_external_change"
  ) {
    return dependency.fromTaskId === taskId;
  }

  return false;
};

export const activeBlockingDependenciesForTask = (
  taskId: string,
  dependencies: Iterable<TaskDependency>,
): TaskDependency[] => {
  const blockers = new Map<string, TaskDependency>();
  for (const dependency of dependencies) {
    if (dependencyBlocksTask(dependency, taskId)) {
      blockers.set(dependency.id, dependency);
    }
  }

  return [...blockers.values()];
};

export const compareTasksForClaim = (now: Date) => (
  left: TaskRecord,
  right: TaskRecord,
): number => {
  const scoreDiff = claimPriorityScore(right, now) - claimPriorityScore(left, now);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const deadlineDiff = (left.deadline ?? "").localeCompare(right.deadline ?? "");
  if (deadlineDiff !== 0) {
    if (!left.deadline) {
      return 1;
    }
    if (!right.deadline) {
      return -1;
    }
    return deadlineDiff;
  }

  const createdDiff = left.createdAt.localeCompare(right.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return left.id.localeCompare(right.id);
};
