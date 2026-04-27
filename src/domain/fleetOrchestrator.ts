import {
  findActiveLease,
} from "../integrations/tracker/commentProtocol.js";
import type {
  CommentWithMetadata,
  GlobalWorkerConfig,
  LockBackend,
  RepositoryProfile,
  TaskLease,
  TrackerIssue,
} from "../models/types.js";
import { PermanentTaskError } from "../utils/errors.js";
import { Logger } from "../utils/logger.js";
import {
  normalizeRepoPathForLease,
} from "./lockBackend.js";
import type { CycleOutcome } from "./orchestrator.js";
import type { RepositoryWorkerContext } from "./repositoryContext.js";
import {
  noopObservability,
  type ObservabilityTelemetry,
} from "../observability/service.js";
import {
  scoreAndSortCandidates,
  type CandidateIssue,
  type ScoredCandidate,
} from "./priorityQueue.js";
import { checkIssueDependencies } from "./dependencies.js";

interface CandidateWithContext extends CandidateIssue {
  context: RepositoryWorkerContext;
  comments: CommentWithMetadata[];
}

interface CandidateCollection {
  candidates: CandidateWithContext[];
  activeRepositoryLeases: Map<string, TaskLease>;
}

const TARGET_PROCESSABLE_STATES = new Set([
  "open",
  "in_progress",
  "waiting_for_answer",
  "review",
]);

const DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE = "is blocked by";

const queueFromIssue = (issue: TrackerIssue): string =>
  issue.queue?.trim() || issue.key.split("-")[0] || "";

const intersects = (left: string[] | undefined, right: string[]): boolean => {
  if (!left || left.length === 0) {
    return true;
  }

  const normalizedRight = new Set(right.map((value) => value.trim().toLowerCase()));
  return left.some((value) => normalizedRight.has(value.trim().toLowerCase()));
};

const repositoryMatchesIssue = (
  repository: RepositoryProfile,
  issue: TrackerIssue,
): boolean => {
  const queue = queueFromIssue(issue).toLowerCase();
  const queueMatches = repository.queues.some(
    (candidate) => candidate.trim().toLowerCase() === queue,
  );
  return queueMatches && intersects(issue.tags, repository.tags);
};

export class FleetOrchestrator {
  private shuttingDown = false;
  private wakeSleep: (() => void) | undefined;

  constructor(
    private readonly config: GlobalWorkerConfig,
    private readonly contexts: RepositoryWorkerContext[],
    private readonly lockBackend: LockBackend,
    private readonly logger: Logger,
    private readonly telemetry: ObservabilityTelemetry = noopObservability,
  ) {}

  async runForever(): Promise<void> {
    this.shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (this.shuttingDown) {
        return;
      }

      this.logger.info("Fleet shutdown signal received, finishing current cycle.", { signal });
      this.shuttingDown = true;
      this.wakeSleep?.();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      while (!this.shuttingDown) {
        try {
          const outcome = await this.runOnce();
          if (outcome !== "processed" && !this.shuttingDown) {
            this.logger.info("Fleet worker is sleeping.", {
              pollIntervalMinutes: this.config.pollIntervalMinutes,
            });
            await this.interruptibleSleep(this.config.pollIntervalMs);
          }
        } catch (error) {
          this.logger.error("Fleet cycle failed.", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!this.shuttingDown) {
            await this.interruptibleSleep(this.config.pollIntervalMs);
          }
        }
      }

      this.logger.info("Fleet worker shut down gracefully.");
    } finally {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      this.wakeSleep?.();
      this.wakeSleep = undefined;
    }
  }

  async runOnce(): Promise<CycleOutcome> {
    this.telemetry.setWorkerState({
      workerId: this.config.workerId,
      state: "polling",
      stage: "fleet_polling",
    });
    if (this.config.targetIssueKey) {
      return this.runTargetIssueCycle(this.config.targetIssueKey);
    }

    const collection = await this.collectCandidates();
    if (collection.candidates.length === 0) {
      this.logger.info("No suitable fleet tasks found.");
      for (const context of this.contexts) {
        for (const queue of context.profile.queues) {
          this.telemetry.setQueueDepth(context.profile.name, queue, 0);
        }
      }
      return "idle";
    }

    const scoredCandidates = scoreAndSortCandidates(
      collection.candidates.filter((candidate) =>
        this.isRepositoryAvailable(candidate, collection.activeRepositoryLeases),
      ),
      this.config.priorityQueue,
    ) as Array<ScoredCandidate & CandidateWithContext>;

    for (const candidate of scoredCandidates) {
      this.logger.info("Trying scored fleet candidate.", {
        issueKey: candidate.issue.key,
        repositoryName: candidate.repository.name,
        score: candidate.score,
      });

      const leases = await this.acquireLeases(candidate);
      if (!leases) {
        continue;
      }

      return candidate.context.orchestrator.processSelectedIssue(
        candidate.issue,
        candidate.comments,
        leases,
      );
    }

    this.logger.info("Fleet candidates were blocked by active leases.");
    this.telemetry.recordEvent({
      workerId: this.config.workerId,
      type: "task_lease_blocked",
      status: "warning",
      message: "Fleet candidates were blocked by active leases.",
    });
    return "waiting";
  }

  private async runTargetIssueCycle(issueKey: string): Promise<CycleOutcome> {
    const firstContext = this.contexts[0];
    if (!firstContext) {
      throw new PermanentTaskError("Fleet has no repository contexts.");
    }

    const issue = await firstContext.tracker.getIssue(issueKey);
    if (
      !issue.logicalStatus ||
      !TARGET_PROCESSABLE_STATES.has(issue.logicalStatus)
    ) {
      throw new PermanentTaskError(
        `Target issue ${issue.key} has unsupported logical status: ${issue.logicalStatus ?? "unknown"}.`,
      );
    }

    const context =
      this.contexts.find((candidate) => repositoryMatchesIssue(candidate.profile, issue)) ??
      firstContext;
    const comments = await context.tracker.getComments(issue.key);
    const leases = await this.acquireLeases({
      issue,
      repository: context.profile,
      comments,
      context,
    });
    if (!leases) {
      return "waiting";
    }

    return context.orchestrator.processSelectedIssue(issue, comments, leases);
  }

  private async collectCandidates(): Promise<CandidateCollection> {
    const candidates = new Map<string, CandidateWithContext>();
    const fetchedIssueKeys = new Set<string>();
    const activeRepositoryLeases = new Map<string, TaskLease>();
    const trackerLeaseCommentsEnabled = this.config.coordination.lockBackend !== "none";

    for (const context of this.contexts) {
      for (const queue of context.profile.queues) {
        for (const tag of context.profile.tags) {
          const issues = await context.tracker.findCandidateIssues({ queue, tag });
          this.telemetry.setQueueDepth(
            context.profile.name,
            queue,
            issues.filter((issue) => issue.logicalStatus === "open").length,
          );
          for (const issue of issues) {
            const issueKey = `${context.profile.name}:${issue.key}`;
            if (fetchedIssueKeys.has(issueKey)) {
              continue;
            }
            fetchedIssueKeys.add(issueKey);

            const comments = await context.tracker.getComments(issue.key);
            if (trackerLeaseCommentsEnabled) {
              const activeRepositoryLease = findActiveLease(comments, {
                kind: "repository",
              });
              if (activeRepositoryLease) {
                activeRepositoryLeases.set(
                  activeRepositoryLease.leaseKey,
                  activeRepositoryLease,
                );
              }
            }

            if (!repositoryMatchesIssue(context.profile, issue)) {
              continue;
            }

            if (trackerLeaseCommentsEnabled) {
              const activeTaskLease = findActiveLease(comments, {
                kind: "task",
              });
              if (
                activeTaskLease &&
                activeTaskLease.workerId !== this.config.workerId
              ) {
                continue;
              }
            }

            if (issue.logicalStatus !== "open") {
              continue;
            }

            const dependencyCheck = await checkIssueDependencies(
              context.tracker,
              issue,
              {
                enforcement: this.config.dependencyEnforcement ?? true,
                unknownStatusPolicy:
                  this.config.dependencyUnknownStatusPolicy ?? "block",
                blockedByLinkType:
                  this.config.trackerBlockedByLinkType ??
                  DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE,
              },
            );
            if (!dependencyCheck.eligible) {
              this.logger.info("Skipping issue because dependencies are not done.", {
                issueKey: issue.key,
                blockers: dependencyCheck.blockers,
              });
              continue;
            }
            if (dependencyCheck.blockers.length > 0) {
              this.logger.warn("Issue has dependency warnings but remains eligible.", {
                issueKey: issue.key,
                blockers: dependencyCheck.blockers,
              });
            }

            candidates.set(issueKey, {
              issue,
              repository: context.profile,
              comments,
              context,
              commentsLoadedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    return {
      candidates: [...candidates.values()],
      activeRepositoryLeases,
    };
  }

  private isRepositoryAvailable(
    candidate: CandidateWithContext,
    activeRepositoryLeases: Map<string, TaskLease>,
  ): boolean {
    const leaseKey = `repo:${normalizeRepoPathForLease(candidate.repository.repoPath)}`;
    const lease = activeRepositoryLeases.get(leaseKey);
    return (
      !lease ||
      lease.workerId === this.config.workerId ||
      lease.issueKey === candidate.issue.key
    );
  }

  private async acquireLeases(
    candidate: Omit<ScoredCandidate, "score"> & {
      context: RepositoryWorkerContext;
      comments: CommentWithMetadata[];
    },
  ): Promise<TaskLease[] | null> {
    const taskLease = await this.lockBackend.acquireTaskLease({
      issueKey: candidate.issue.key,
      workerId: this.config.workerId,
      repositoryName: candidate.repository.name,
      repoPath: candidate.repository.repoPath,
      ttlMs: this.config.coordination.lockTtlMs,
    });
    if (!taskLease) {
      this.telemetry.incrementCounter("ai_developer_lease_acquire_failures_total", {
        repository: candidate.repository.name,
        kind: "task",
      });
      return null;
    }

    const repositoryLease = await this.lockBackend.acquireRepositoryLease({
      issueKey: candidate.issue.key,
      workerId: this.config.workerId,
      repositoryName: candidate.repository.name,
      repoPath: candidate.repository.repoPath,
      ttlMs: this.config.coordination.lockTtlMs,
    });
    if (!repositoryLease) {
      await this.lockBackend.releaseTaskLease(taskLease);
      this.telemetry.incrementCounter("ai_developer_lease_acquire_failures_total", {
        repository: candidate.repository.name,
        kind: "repository",
      });
      return null;
    }

    this.telemetry.recordEvent({
      workerId: this.config.workerId,
      repositoryName: candidate.repository.name,
      issueKey: candidate.issue.key,
      type: "task_lease_acquired",
      status: "info",
      message: "Fleet task and repository leases acquired.",
    });
    return [taskLease, repositoryLease];
  }

  private async interruptibleSleep(milliseconds: number): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    await new Promise<void>((resolve) => {
      let timeout: NodeJS.Timeout;
      const wake = (): void => {
        clearTimeout(timeout);
        if (this.wakeSleep === wake) {
          this.wakeSleep = undefined;
        }
        resolve();
      };
      timeout = setTimeout(wake, milliseconds);
      this.wakeSleep = wake;
    });
  }
}
