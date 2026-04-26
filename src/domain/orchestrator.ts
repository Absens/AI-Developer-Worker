import type {
  AppConfig,
  ClarificationQuestion,
  CodexExecution,
  CodexRunner,
  CommentWithMetadata,
  CoordinationConfig,
  GitLabService,
  GitService,
  HumanTaskCommand,
  LockBackend,
  LogicalStatus,
  MergeRequestDiscussion,
  MergeRequestInfo,
  MergeRequestNote,
  PromptProfile,
  SubtaskDraft,
  TaskAnalysisDecision,
  TaskAnalysisResult,
  TaskLease,
  TrackerClient,
  TrackerIssue,
  ValidationResult,
} from "../models/types.js";
import {
  findHumanCommentsAfter,
  findLatestAnalysisDecision,
  findLatestDecompositionMetadata,
  findLatestHumanTaskCommandAfter,
  findLatestQuestionComment,
  findLatestReviewMetadata,
  findLatestStatusComment,
  formatAnalysisComment,
  formatDecompositionComment,
  formatReviewMetadataComment,
  formatMergeRequestComment,
  formatQuestionCommentWithThreadId,
  formatStatusComment,
} from "../integrations/tracker/commentProtocol.js";
import {
  buildAnalysisPrompt,
  buildDecompositionPrompt,
  buildFixPrompt,
  buildImplementationPrompt,
  buildReviewFixPrompt,
  buildResumePrompt,
} from "./promptBuilder.js";
import { buildCommitMessage } from "./commitMessage.js";
import { buildMergeRequestDescription } from "./mergeRequestDescription.js";
import {
  PermanentTaskError,
  TemporaryIntegrationError,
} from "../utils/errors.js";
import { Logger } from "../utils/logger.js";
import {
  collectQualityGateNotes,
  formatQualityGateDiagnostics,
  formatQualityGateSummary,
  qualityGatesPassed,
  qualityGateStatus,
  runQualityGates,
} from "./qualityGates.js";
import { withLeaseHeartbeat } from "./lockBackend.js";
import {
  DEFAULT_CONFIDENCE_HUMAN_THRESHOLD,
  DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD,
  createClarificationFromAnalysis,
  createManualHoldAnalysisDecision,
  createReadyAnalysisDecision,
  parseTaskAnalysisDecision,
} from "./analysisDecision.js";
import {
  formatSubtaskDescription,
  parseDecompositionPlan,
} from "./decomposition.js";
import { selectPromptProfile } from "./promptProfiles.js";
import { checkIssueDependencies } from "./dependencies.js";

export type CycleOutcome = "processed" | "idle" | "waiting";

interface ResumeContext {
  questionComment: CommentWithMetadata & { metadata: NonNullable<CommentWithMetadata["metadata"]> };
  command: HumanTaskCommand;
}

const ACTIVE_STATES: LogicalStatus[] = ["in_progress", "waiting_for_answer"];
const OWNED_TASK_STATES: LogicalStatus[] = [...ACTIVE_STATES, "review"];
const ANALYSIS_READY_MARKER = "READY_FOR_IMPLEMENTATION";
const DEFAULT_TASK_MODE = "auto";
const DEFAULT_DECOMPOSITION_MAX_SUBTASKS = 8;
const DEFAULT_DECOMPOSITION_SUBTASK_TAG = "ai_dev";
const DEFAULT_DECOMPOSITION_TITLE_PREFIX = "[AI split]";
const DEFAULT_TRACKER_PARENT_LINK_TYPE = "relates";
const DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE = "is blocked by";
const TARGET_PROCESSABLE_STATES: LogicalStatus[] = [
  "open",
  "in_progress",
  "waiting_for_answer",
  "review",
];

const branchNameForIssue = (issueKey: string): string => `feature/ai-task-${issueKey}`;

const isValidationSuccessful = (validation: ValidationResult): boolean =>
  validation.changed && qualityGatesPassed(validation.gates);

const isResumableStatus = (
  latestStatus: ReturnType<typeof findLatestStatusComment>,
): boolean =>
  latestStatus !== undefined &&
  latestStatus.state !== undefined &&
  ACTIVE_STATES.includes(latestStatus.state) &&
  latestStatus.waitingReason !== "failure_recovery" &&
  latestStatus.waitingReason !== "manual_hold";

const mergeUniqueStrings = (first: string[], second: string[]): string[] => [
  ...new Set([...first, ...second]),
];

const mergeUniqueNumbers = (first: number[], second: number[]): number[] => [
  ...new Set([...first, ...second]),
];

const hasRepositoryPromptProfileOverrides = (
  config: AppConfig,
): AppConfig["promptProfiles"] | undefined => config.promptProfiles;

const subtaskDependencyNotes = (
  subtask: SubtaskDraft,
  temporaryIdToIssueKey: Map<string, string>,
  dependencyReasons: Array<{
    blockedTaskTemporaryId: string;
    blockingTaskTemporaryId: string;
    reason: string;
  }>,
): string[] =>
  dependencyReasons
    .filter((dependency) => dependency.blockedTaskTemporaryId === subtask.temporaryId)
    .map((dependency) => {
      const blockingIssueKey =
        temporaryIdToIssueKey.get(dependency.blockingTaskTemporaryId) ??
        dependency.blockingTaskTemporaryId;
      return `Blocked by ${blockingIssueKey}: ${dependency.reason}`;
    });

export class WorkerOrchestrator {
  private shuttingDown = false;
  private wakeSleep: (() => void) | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly tracker: TrackerClient,
    private readonly git: GitService,
    private readonly gitlab: GitLabService,
    private readonly codex: CodexRunner,
    private readonly logger: Logger,
    private readonly lockBackend?: LockBackend,
    private readonly coordination?: CoordinationConfig,
  ) {}

  async runForever(): Promise<void> {
    this.shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (this.shuttingDown) {
        return;
      }

      this.logger.info("Shutdown signal received, finishing current cycle.", { signal });
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
            this.logger.info("Worker is sleeping.", {
              pollIntervalMinutes: this.config.pollIntervalMinutes,
            });
            await this.interruptibleSleep(this.config.pollIntervalMs);
          }
        } catch (error) {
          this.logger.error("Worker cycle failed.", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!this.shuttingDown) {
            await this.interruptibleSleep(this.config.pollIntervalMs);
          }
        }
      }

      this.logger.info("Worker shut down gracefully.");
    } finally {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      this.wakeSleep?.();
      this.wakeSleep = undefined;
    }
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

  async runOnce(): Promise<CycleOutcome> {
    if (this.config.targetIssueKey) {
      return this.runTargetIssueCycle(this.config.targetIssueKey);
    }

    const ownedTask = await this.resumeOwnedTask();
    if (ownedTask) {
      const leases = await this.acquireProcessingLeases(ownedTask.issue);
      if (!leases) {
        return "waiting";
      }
      const outcome = await this.processSelectedIssue(
        ownedTask.issue,
        ownedTask.comments,
        leases,
      );
      if (outcome !== "idle" || ownedTask.issue.logicalStatus !== "review") {
        return outcome;
      }
    }

    const nextTask = await this.pickNextTask();
    if (!nextTask) {
      this.logger.info("No suitable tasks found.");
      return "idle";
    }

    const leases = await this.acquireProcessingLeases(nextTask.issue);
    if (!leases) {
      return "waiting";
    }

    return this.processSelectedIssue(nextTask.issue, nextTask.comments, leases);
  }

  private async runTargetIssueCycle(issueKey: string): Promise<CycleOutcome> {
    this.logger.info("Target issue mode enabled.", { issueKey });
    const issue = await this.loadTargetIssue(issueKey);
    const comments = await this.tracker.getComments(issue.key);

    this.logger.info("Loaded target issue.", {
      issueKey: issue.key,
      logicalStatus: issue.logicalStatus,
    });

    if (this.isBusyByAnotherWorker(comments)) {
      this.logger.info("Target issue is locked by another worker.", { issueKey: issue.key });
      return "waiting";
    }

    if (!issue.logicalStatus || !TARGET_PROCESSABLE_STATES.includes(issue.logicalStatus)) {
      throw new PermanentTaskError(
        `Target issue ${issue.key} has unsupported logical status: ${issue.logicalStatus ?? "unknown"}.`,
      );
    }

    const leases = await this.acquireProcessingLeases(issue);
    if (!leases) {
      return "waiting";
    }

    return this.processSelectedIssue(issue, comments, leases);
  }

  async processSelectedIssue(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
    leases: TaskLease[] = [],
  ): Promise<CycleOutcome> {
    if (this.lockBackend && leases.length > 0) {
      return withLeaseHeartbeat(
        this.lockBackend,
        leases,
        this.coordination?.lockHeartbeatMs ?? 60 * 1000,
        () => this.handleIssue(issue, comments),
      );
    }

    return this.handleIssue(issue, comments);
  }

  private async acquireProcessingLeases(issue: TrackerIssue): Promise<TaskLease[] | null> {
    if (!this.lockBackend || !this.coordination) {
      return [];
    }

    const repositoryName = "repositoryName" in this.config
      ? String(this.config.repositoryName)
      : "default";
    const taskLease = await this.lockBackend.acquireTaskLease({
      issueKey: issue.key,
      workerId: this.config.workerId,
      repositoryName,
      repoPath: this.config.repoPath,
      ttlMs: this.coordination.lockTtlMs,
    });
    if (!taskLease) {
      this.logger.info("Issue is already leased by another worker.", { issueKey: issue.key });
      return null;
    }

    const repositoryLease = await this.lockBackend.acquireRepositoryLease({
      issueKey: issue.key,
      workerId: this.config.workerId,
      repositoryName,
      repoPath: this.config.repoPath,
      ttlMs: this.coordination.lockTtlMs,
    });
    if (!repositoryLease) {
      await this.lockBackend.releaseTaskLease(taskLease);
      this.logger.info("Repository is already leased by another worker.", {
        issueKey: issue.key,
        repoPath: this.config.repoPath,
      });
      return null;
    }

    return [taskLease, repositoryLease];
  }

  private async loadTargetIssue(issueKey: string): Promise<TrackerIssue> {
    let issue: TrackerIssue;
    try {
      issue = await this.tracker.getIssue(issueKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PermanentTaskError(`Unable to load target issue ${issueKey}: ${message}`);
    }

    const logicalStatus = this.tracker.determineLogicalStatus(issue);
    return {
      ...issue,
      logicalStatus,
    };
  }

  private async resumeOwnedTask(): Promise<{
    issue: TrackerIssue;
    comments: CommentWithMetadata[];
  } | null> {
    const issues = await this.tracker.findOwnedIssues(OWNED_TASK_STATES);
    for (const issue of issues) {
      const comments = await this.tracker.getComments(issue.key);
      const latestStatus = findLatestStatusComment(comments);
      if (
        latestStatus?.worker === this.config.workerId &&
        isResumableStatus(latestStatus)
      ) {
        return { issue, comments };
      }

      if (issue.logicalStatus === "review" && this.isReviewOwnedByThisWorker(comments)) {
        return { issue, comments };
      }
    }

    return null;
  }

  private isReviewOwnedByThisWorker(comments: CommentWithMetadata[]): boolean {
    return comments.some(
      (comment) =>
        comment.metadata?.worker === this.config.workerId &&
        (comment.metadata.kind === "AI MR" ||
          (comment.metadata.kind === "AI STATUS" && comment.metadata.state === "review") ||
          comment.metadata.kind === "AI REVIEW"),
    );
  }

  private async pickNextTask(): Promise<{
    issue: TrackerIssue;
    comments: CommentWithMetadata[];
  } | null> {
    const issues = await this.tracker.findCandidateIssues();
    const openIssues = issues.filter((issue) => issue.logicalStatus === "open");

    for (const issue of openIssues) {
      const dependencyCheck = await checkIssueDependencies(this.tracker, issue, {
        enforcement: this.config.dependencyEnforcement ?? true,
        unknownStatusPolicy: this.config.dependencyUnknownStatusPolicy ?? "block",
        blockedByLinkType:
          this.config.trackerBlockedByLinkType ?? DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE,
      });
      if (!dependencyCheck.eligible) {
        this.logger.info("Skipping issue because dependencies are not done.", {
          issueKey: issue.key,
          blockers: dependencyCheck.blockers,
        });
        continue;
      }

      const comments = await this.tracker.getComments(issue.key);
      if (!this.isBusyByAnotherWorker(comments)) {
        return { issue, comments };
      }
    }

    return null;
  }

  private isBusyByAnotherWorker(comments: CommentWithMetadata[]): boolean {
    const latestStatus = findLatestStatusComment(comments);
    if (!latestStatus) {
      return false;
    }

    return latestStatus.worker !== this.config.workerId && isResumableStatus(latestStatus);
  }

  private async handleIssue(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
  ): Promise<CycleOutcome> {
    try {
      return await this.processIssue(issue, comments);
    } catch (error) {
      if (error instanceof TemporaryIntegrationError) {
        this.logger.error("Temporary integration error while processing issue.", {
          issueKey: issue.key,
          error: error.message,
        });
        return "waiting";
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Permanent issue processing failure.", {
        issueKey: issue.key,
        error: message,
      });
      await this.finalizeFailure(issue, message);
      return "processed";
    }
  }

  private async processIssue(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
  ): Promise<CycleOutcome> {
    let resumeContext: ResumeContext | undefined;
    let activeThreadId: string | undefined;
    let implementationSummary: string | undefined;
    let analysisDecision = findLatestAnalysisDecision(comments, issue.key);

    if (issue.logicalStatus === "review") {
      return this.handleReviewFeedback(issue, comments);
    }

    if (issue.logicalStatus === "open") {
      await this.tracker.transition(issue.key, "in_progress");
      await this.tracker.addComment(
        issue.key,
        formatStatusComment(this.config.workerId, "in_progress", "Started processing task."),
      );
      issue.logicalStatus = "in_progress";
    }

    if (issue.logicalStatus === "waiting_for_answer") {
      resumeContext = this.resolveResumeContext(issue, comments);
      if (!resumeContext) {
        return "waiting";
      }

      activeThreadId = resumeContext.questionComment.metadata.threadId;
      await this.tracker.transition(issue.key, "in_progress");
      await this.tracker.addComment(
        issue.key,
        formatStatusComment(
          this.config.workerId,
          "in_progress",
          "Explicit resume command received. Resuming task processing.",
        ),
      );
      issue.logicalStatus = "in_progress";
      comments = await this.tracker.getComments(issue.key);
    } else {
      const analysis = await this.runAnalysis(issue, comments);
      activeThreadId = analysis.threadId;
      analysisDecision = analysis.decision;
      if (!analysisDecision) {
        analysisDecision = createManualHoldAnalysisDecision(
          "Analysis did not produce a structured routing decision.",
        );
      }

      const taskMode = this.resolveTaskMode(analysisDecision);
      if (taskMode === "analyze_only") {
        await this.tracker.transition(issue.key, "waiting_for_answer");
        await this.tracker.addComment(
          issue.key,
          formatStatusComment(
            this.config.workerId,
            "waiting_for_answer",
            "Analysis completed; TASK_MODE=analyze_only stopped before implementation.",
            "manual_hold",
          ),
        );
        return "processed";
      }

      if (taskMode === "ask_clarification") {
        await this.pauseForClarification(
          issue,
          analysis.clarification ?? createClarificationFromAnalysis(analysisDecision),
          activeThreadId,
        );
        return "waiting";
      }

      if (taskMode === "human") {
        await this.pauseForManualHold(issue, analysisDecision);
        return "waiting";
      }

      if (taskMode === "decompose") {
        return this.runDecomposition(issue, comments, analysisDecision, activeThreadId);
      }

      if (analysis.status === "clarification_required" && analysis.clarification) {
        await this.pauseForClarification(issue, analysis.clarification, activeThreadId);
        return "waiting";
      }
    }

    const promptProfile = this.selectProfile(issue, analysisDecision);
    const branch = await this.git.checkoutTaskBranch(issue.key);
    const existingMr = await this.gitlab.findOpenMergeRequestByBranch(branch);
    const hasUncommittedChanges = await this.git.hasChanges();
    const hasCommittedDiff = await this.git.hasDiffFromBase();

    if (existingMr && !hasUncommittedChanges && hasCommittedDiff) {
      await this.finalizeSuccess(issue, branch, existingMr);
      return "processed";
    }

    if (!hasUncommittedChanges && !hasCommittedDiff) {
      const implementationPrompt = buildImplementationPrompt(
        issue,
        comments,
        promptProfile,
        analysisDecision,
      );
      const execution = resumeContext
        ? await this.runResumeOrInitial(
            issue,
            activeThreadId,
            buildResumePrompt(issue, comments, resumeContext.command),
            implementationPrompt,
          )
        : activeThreadId
          ? await this.runResumeOrInitial(
              issue,
              activeThreadId,
              implementationPrompt,
              implementationPrompt,
            )
          : await this.codex.runInitial(implementationPrompt);

      activeThreadId = execution.threadId ?? activeThreadId;
      if (execution.clarification) {
        await this.pauseForClarification(issue, execution.clarification, activeThreadId);
        return "waiting";
      }
      implementationSummary = execution.finalMessage?.trim();

      if (execution.process.exitCode !== 0) {
        this.logger.warn("Codex implementation run exited with non-zero code.", {
          issueKey: issue.key,
          exitCode: execution.process.exitCode,
        });
      }
    } else {
      this.logger.info("Reusing existing repository state for task validation.", {
        issueKey: issue.key,
        branch,
        hasUncommittedChanges,
        hasCommittedDiff,
      });
    }

    let validation = await this.validateRepositoryState();
    if (!validation.changed) {
      throw new PermanentTaskError("Codex completed without producing repository changes.");
    }

    let attempt = 0;
    while (!isValidationSuccessful(validation) && attempt < this.config.maxFixAttempts) {
      attempt += 1;
      this.logger.warn("Validation failed, asking Codex to apply a fix.", {
        issueKey: issue.key,
        attempt,
        threadId: activeThreadId,
      });

      const execution = activeThreadId
        ? await this.codex.runResume(
            activeThreadId,
            buildFixPrompt(issue, validation.diagnostic, promptProfile, analysisDecision),
          )
        : await this.codex.runFix(
            buildFixPrompt(issue, validation.diagnostic, promptProfile, analysisDecision),
          );
      activeThreadId = execution.threadId ?? activeThreadId;
      if (execution.clarification) {
        await this.pauseForClarification(issue, execution.clarification, activeThreadId);
        return "waiting";
      }
      implementationSummary = execution.finalMessage?.trim() ?? implementationSummary;

      if (execution.process.exitCode !== 0) {
        this.logger.warn("Codex fix run exited with non-zero code.", {
          issueKey: issue.key,
          attempt,
          exitCode: execution.process.exitCode,
        });
      }

      validation = await this.validateRepositoryState();
    }

    if (!isValidationSuccessful(validation)) {
      throw new PermanentTaskError(validation.diagnostic);
    }

    await this.publish(issue, branch, existingMr, validation, implementationSummary);
    return "processed";
  }

  private async handleReviewFeedback(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
  ): Promise<CycleOutcome> {
    const { branch, mergeRequest } = await this.resolveReviewMergeRequest(issue, comments);
    const pendingDiscussions = await this.findPendingReviewDiscussions(
      issue,
      comments,
      mergeRequest,
    );

    if (pendingDiscussions.length === 0) {
      this.logger.info("Review issue has no pending unresolved reviewer comments.", {
        issueKey: issue.key,
        mergeRequestIid: mergeRequest.iid,
      });
      return "idle";
    }

    await this.tracker.transition(issue.key, "in_progress");
    await this.tracker.addComment(
      issue.key,
      formatStatusComment(
        this.config.workerId,
        "in_progress",
        "Fixing unresolved review discussions.",
      ),
    );

    const checkedOutBranch = await this.git.checkoutBranch(branch);
    const headBefore = await this.git.getHeadSha();
    const diffFromBase = await this.git.getDiffFromBase();
    const changedFiles = await this.git.getChangedFilesFromBase();
    const analysisDecision = findLatestAnalysisDecision(comments, issue.key);
    const promptProfile = this.selectProfile(issue, analysisDecision);
    const prompt = buildReviewFixPrompt(
      issue,
      comments,
      {
        mergeRequest,
        discussions: pendingDiscussions,
        changedFiles,
        diffFromBase,
      },
      promptProfile,
      analysisDecision,
    );

    let execution = await this.codex.runInitial(prompt);
    let reviewThreadId = execution.threadId;
    let reviewFixSummary = execution.finalMessage?.trim();
    if (execution.clarification) {
      await this.pauseForClarification(issue, execution.clarification, execution.threadId);
      return "waiting";
    }

    if (execution.process.exitCode !== 0) {
      this.logger.warn("Codex review fix run exited with non-zero code.", {
        issueKey: issue.key,
        exitCode: execution.process.exitCode,
      });
    }

    let validation = await this.validateRepositoryState();
    let attempt = 0;
    while (!isValidationSuccessful(validation) && attempt < this.config.maxReviewFixAttempts) {
      attempt += 1;
      this.logger.warn("Review fix validation failed, asking Codex to apply a fix.", {
        issueKey: issue.key,
        attempt,
        threadId: reviewThreadId,
      });

      execution = reviewThreadId
        ? await this.codex.runResume(
            reviewThreadId,
            buildFixPrompt(issue, validation.diagnostic, promptProfile, analysisDecision),
          )
        : await this.codex.runFix(
            buildFixPrompt(issue, validation.diagnostic, promptProfile, analysisDecision),
          );
      reviewThreadId = execution.threadId ?? reviewThreadId;
      reviewFixSummary = execution.finalMessage?.trim() ?? reviewFixSummary;
      if (execution.clarification) {
        await this.pauseForClarification(issue, execution.clarification, execution.threadId);
        return "waiting";
      }

      if (execution.process.exitCode !== 0) {
        this.logger.warn("Codex review validation fix run exited with non-zero code.", {
          issueKey: issue.key,
          attempt,
          exitCode: execution.process.exitCode,
        });
      }

      validation = await this.validateRepositoryState();
    }

    if (!isValidationSuccessful(validation)) {
      throw new PermanentTaskError(validation.diagnostic);
    }

    if (await this.git.hasChanges()) {
      const commitChangedFiles = await this.git.getChangedFilesFromBase();
      await this.git.commit(
        buildCommitMessage({
          issue,
          changedFiles: commitChangedFiles,
          summary: reviewFixSummary,
        }),
      );
    }

    const headAfter = await this.git.getHeadSha();
    if (headAfter === headBefore) {
      throw new PermanentTaskError(
        "Codex completed the review fix without producing a new commit.",
      );
    }

    await this.git.push(checkedOutBranch);

    const validationSummary = this.formatValidationSummary(validation);
    const replyBody = this.formatReviewReplyBody(headAfter, validationSummary);
    for (const discussion of pendingDiscussions) {
      await this.gitlab.replyToDiscussion(mergeRequest.iid, discussion.id, replyBody);
    }

    const previousMetadata = findLatestReviewMetadata(
      comments,
      issue.key,
      mergeRequest.iid,
    );
    await this.tracker.addComment(
      issue.key,
      formatReviewMetadataComment({
        worker: this.config.workerId,
        issueKey: issue.key,
        mergeRequestIid: mergeRequest.iid,
        processedDiscussionIds: mergeUniqueStrings(
          previousMetadata?.processedDiscussionIds ?? [],
          pendingDiscussions.map((discussion) => discussion.id),
        ),
        processedNoteIds: mergeUniqueNumbers(
          previousMetadata?.processedNoteIds ?? [],
          pendingDiscussions.flatMap((discussion) =>
            discussion.notes.map((note) => note.id),
          ),
        ),
        lastFixCommit: headAfter,
      }),
    );

    await this.tracker.transition(issue.key, "review");
    await this.tracker.addComment(
      issue.key,
      formatStatusComment(
        this.config.workerId,
        "review",
        `Review feedback addressed and pushed: ${mergeRequest.url}`,
      ),
    );

    return "processed";
  }

  private async resolveReviewMergeRequest(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
  ): Promise<{ branch: string; mergeRequest: MergeRequestInfo }> {
    const branch = this.findLatestMergeRequestBranch(comments) ?? branchNameForIssue(issue.key);
    const mergeRequest = await this.gitlab.findOpenMergeRequestByBranch(branch);
    if (!mergeRequest) {
      throw new PermanentTaskError(
        `Issue ${issue.key} is in review, but no open merge request was found for ${branch}.`,
      );
    }

    return { branch, mergeRequest };
  }

  private findLatestMergeRequestBranch(comments: CommentWithMetadata[]): string | undefined {
    return comments
      .filter(
        (comment) =>
          comment.metadata?.kind === "AI MR" &&
          comment.metadata.worker === this.config.workerId &&
          comment.metadata.branch,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1)?.metadata?.branch;
  }

  private async findPendingReviewDiscussions(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
    mergeRequest: MergeRequestInfo,
  ): Promise<MergeRequestDiscussion[]> {
    const [currentUser, discussions] = await Promise.all([
      this.gitlab.getCurrentUser(),
      this.gitlab.getMergeRequestDiscussions(mergeRequest.iid),
    ]);
    const previousMetadata = findLatestReviewMetadata(
      comments,
      issue.key,
      mergeRequest.iid,
    );
    const processedDiscussionIds = new Set(
      previousMetadata?.processedDiscussionIds ?? [],
    );
    const processedNoteIds = new Set(previousMetadata?.processedNoteIds ?? []);

    return discussions
      .filter((discussion) => !discussion.resolved)
      .map((discussion) =>
        this.filterPendingReviewNotes(
          discussion,
          currentUser.username,
          processedDiscussionIds,
          processedNoteIds,
        ),
      )
      .filter(
        (discussion): discussion is MergeRequestDiscussion =>
          discussion !== undefined && discussion.notes.length > 0,
      );
  }

  private filterPendingReviewNotes(
    discussion: MergeRequestDiscussion,
    currentUsername: string,
    processedDiscussionIds: Set<string>,
    processedNoteIds: Set<number>,
  ): MergeRequestDiscussion | undefined {
    if (processedDiscussionIds.has(discussion.id) && processedNoteIds.size === 0) {
      return undefined;
    }

    const anchorPosition = discussion.notes.find((note) => note.position)?.position;
    const notes = discussion.notes
      .filter((note) => this.isPendingReviewerNote(note, currentUsername, processedNoteIds))
      .map((note) =>
        note.position || !anchorPosition
          ? note
          : {
              ...note,
              position: anchorPosition,
            },
      );

    if (notes.length === 0) {
      return undefined;
    }

    return {
      ...discussion,
      notes,
    };
  }

  private isPendingReviewerNote(
    note: MergeRequestNote,
    currentUsername: string,
    processedNoteIds: Set<number>,
  ): boolean {
    return (
      !note.system &&
      note.authorUsername !== currentUsername &&
      !processedNoteIds.has(note.id)
    );
  }

  private resolveResumeContext(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
  ): ResumeContext | undefined {
    const latestQuestion = findLatestQuestionComment(comments);
    if (!latestQuestion || latestQuestion.metadata.worker !== this.config.workerId) {
      this.logger.warn("Task is waiting for answer, but no matching AI question was found.", {
        issueKey: issue.key,
      });
      return undefined;
    }

    const humanComments = findHumanCommentsAfter(comments, latestQuestion.createdAt);
    if (humanComments.length === 0) {
      this.logger.info("Task is still waiting for a human answer.", {
        issueKey: issue.key,
        latestQuestionCreatedAt: latestQuestion.createdAt,
        commentsAfterQuestion: comments.filter(
          (comment) => comment.createdAt > latestQuestion.createdAt,
        ).length,
      });
      return undefined;
    }

    const command = findLatestHumanTaskCommandAfter(comments, latestQuestion.createdAt);
    if (!command) {
      this.logger.info("Human comments received, but no explicit /resume command was found.", {
        issueKey: issue.key,
        latestQuestionCreatedAt: latestQuestion.createdAt,
        humanCommentCount: humanComments.length,
        slashCommandCandidates: humanComments.filter((comment) =>
          /(^|\n)\s*\/(?:resume|skip|cancel)\b/i.test(comment.text),
        ).length,
      });
      return undefined;
    }

    if (command.type !== "resume") {
      this.logger.info("Latest human command does not resume task execution.", {
        issueKey: issue.key,
        command: command.type,
      });
      return undefined;
    }

    return {
      questionComment: latestQuestion,
      command,
    };
  }

  private async runAnalysis(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
  ): Promise<TaskAnalysisResult> {
    const storedDecision = findLatestAnalysisDecision(comments, issue.key);
    if (storedDecision) {
      this.logger.info("Reusing stored task analysis decision.", {
        issueKey: issue.key,
        confidence: storedDecision.confidence,
        recommendedMode: storedDecision.recommendedMode,
      });
      return {
        status:
          storedDecision.recommendedMode === "ask_clarification"
            ? "clarification_required"
            : "ready",
        decision: storedDecision,
      };
    }

    const execution = await this.codex.runInitial(buildAnalysisPrompt(issue, comments));
    let decision: TaskAnalysisDecision | undefined;
    if (execution.clarification) {
      decision = {
        confidence: Math.max(
          0,
          Math.min(
            this.config.confidenceHumanThreshold ??
              DEFAULT_CONFIDENCE_HUMAN_THRESHOLD,
            30,
          ),
        ),
        taskType: "unknown",
        recommendedMode: "ask_clarification",
        promptProfileId: "general",
        expectedFiles: [],
        expectedSubsystems: [],
        riskFactors: [execution.clarification.blockingReason],
        missingContext: [execution.clarification.question],
        reasoning: "Codex analysis requested human clarification.",
      };
      await this.tracker.addComment(
        issue.key,
        formatAnalysisComment(this.config.workerId, issue.key, decision),
      );
      return {
        status: "clarification_required",
        clarification: execution.clarification,
        threadId: execution.threadId,
        decision,
      };
    }

    const finalMessage = execution.finalMessage?.trim();
    if (finalMessage === ANALYSIS_READY_MARKER) {
      decision = createReadyAnalysisDecision();
    } else {
      decision = parseTaskAnalysisDecision(finalMessage, {
        implementThreshold:
          this.config.confidenceImplementThreshold ??
          DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD,
        humanThreshold:
          this.config.confidenceHumanThreshold ?? DEFAULT_CONFIDENCE_HUMAN_THRESHOLD,
      });
    }

    if (!decision) {
      const reason =
        execution.process.exitCode !== 0
          ? execution.process.stderr.trim() || "Codex analysis stage failed."
          : `Codex analysis did not return valid AI_ANALYSIS output: ${
              finalMessage || "empty response"
            }`;
      decision = createManualHoldAnalysisDecision(reason);
      this.logger.warn("Analysis stage failed safely into manual hold.", {
        issueKey: issue.key,
        reason,
      });
    }

    await this.tracker.addComment(
      issue.key,
      formatAnalysisComment(this.config.workerId, issue.key, decision),
    );

    return {
      status:
        decision.recommendedMode === "ask_clarification"
          ? "clarification_required"
          : "ready",
      threadId: execution.threadId,
      decision,
    };
  }

  private resolveTaskMode(
    decision: TaskAnalysisDecision,
  ): "implement" | "ask_clarification" | "decompose" | "human" | "analyze_only" {
    const configuredMode = this.config.taskMode ?? DEFAULT_TASK_MODE;
    if (configuredMode === "analyze_only") {
      return "analyze_only";
    }
    if (configuredMode === "implement") {
      return "implement";
    }
    if (configuredMode === "decompose") {
      return "decompose";
    }
    if (configuredMode === "human") {
      return "human";
    }

    const implementThreshold =
      this.config.confidenceImplementThreshold ??
      DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD;
    const humanThreshold =
      this.config.confidenceHumanThreshold ?? DEFAULT_CONFIDENCE_HUMAN_THRESHOLD;
    if (decision.recommendedMode === "implement" && decision.confidence < humanThreshold) {
      return "human";
    }
    if (decision.recommendedMode === "implement" && decision.confidence < implementThreshold) {
      return decision.missingContext.length > 0 ? "ask_clarification" : "human";
    }

    return decision.recommendedMode;
  }

  private selectProfile(
    issue: TrackerIssue,
    decision: TaskAnalysisDecision | undefined,
  ): PromptProfile {
    const profile = selectPromptProfile(
      issue,
      decision,
      hasRepositoryPromptProfileOverrides(this.config),
    );
    if (decision?.promptProfileId && profile.id !== decision.promptProfileId) {
      this.logger.warn("Unknown prompt profile from analysis; using fallback profile.", {
        issueKey: issue.key,
        requestedProfile: decision.promptProfileId,
        selectedProfile: profile.id,
      });
    }
    return profile;
  }

  private async runResumeOrInitial(
    issue: TrackerIssue,
    threadId: string | undefined,
    resumePrompt: string,
    fallbackPrompt: string,
  ): Promise<CodexExecution> {
    if (!threadId) {
      return this.codex.runInitial(fallbackPrompt);
    }

    const execution = await this.codex.runResume(threadId, resumePrompt);
    if (execution.process.exitCode === 0 || execution.clarification) {
      return execution;
    }

    this.logger.warn("Codex resume failed, falling back to a fresh session.", {
      issueKey: issue.key,
      threadId,
      exitCode: execution.process.exitCode,
      stderr: execution.process.stderr,
    });
    return this.codex.runInitial(fallbackPrompt);
  }

  private async pauseForClarification(
    issue: TrackerIssue,
    clarification: ClarificationQuestion,
    threadId?: string,
  ): Promise<void> {
    await this.tracker.addComment(
      issue.key,
      formatQuestionCommentWithThreadId(this.config.workerId, clarification, threadId),
    );
    await this.tracker.transition(issue.key, "waiting_for_answer");
    await this.tracker.addComment(
      issue.key,
      formatStatusComment(
        this.config.workerId,
        "waiting_for_answer",
        "Waiting for explicit /resume command after clarification.",
        "clarification",
      ),
    );
  }

  private async pauseForManualHold(
    issue: TrackerIssue,
    decision: TaskAnalysisDecision,
  ): Promise<void> {
    await this.tracker.transition(issue.key, "waiting_for_answer");
    await this.tracker.addComment(
      issue.key,
      formatStatusComment(
        this.config.workerId,
        "waiting_for_answer",
        `Manual hold after analysis: ${decision.reasoning}`,
        "manual_hold",
      ),
    );
  }

  private async runDecomposition(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
    analysisDecision: TaskAnalysisDecision,
    threadId?: string,
  ): Promise<CycleOutcome> {
    const existing = findLatestDecompositionMetadata(comments, issue.key);
    if (existing?.createdIssueKeys && existing.createdIssueKeys.length > 0) {
      this.logger.info("Skipping decomposition because created sub-issues already exist.", {
        issueKey: issue.key,
        createdIssueKeys: existing.createdIssueKeys,
      });
      await this.pauseForManualHold(issue, analysisDecision);
      return "processed";
    }

    const maxSubtasks =
      this.config.decompositionMaxSubtasks ?? DEFAULT_DECOMPOSITION_MAX_SUBTASKS;
    const defaultSubtaskTag =
      this.config.decompositionDefaultSubtaskTag ?? DEFAULT_DECOMPOSITION_SUBTASK_TAG;
    const titlePrefix =
      this.config.decompositionSubtaskTitlePrefix ??
      DEFAULT_DECOMPOSITION_TITLE_PREFIX;
    const prompt = buildDecompositionPrompt(
      issue,
      comments,
      {
        maxSubtasks,
        defaultSubtaskTag,
        titlePrefix,
      },
      analysisDecision,
    );
    const execution = threadId
      ? await this.codex.runResume(threadId, prompt)
      : await this.codex.runInitial(prompt);
    const plan = parseDecompositionPlan(execution.finalMessage, {
      parentIssueKey: issue.key,
      maxSubtasks,
    });
    if (!plan) {
      await this.tracker.addComment(
        issue.key,
        formatDecompositionComment(this.config.workerId, {
          parentIssueKey: issue.key,
          dryRun: true,
          summary: "Decomposition failed because Codex did not return a valid plan.",
          warnings: [execution.process.stderr.trim() || "Invalid AI_DECOMPOSITION output."],
        }),
      );
      await this.pauseForManualHold(issue, analysisDecision);
      return "waiting";
    }

    const createIssues =
      this.config.decompositionCreateIssues ?? true;
    const dryRun = this.config.decompositionDryRun ?? false;
    if (dryRun || !createIssues) {
      await this.tracker.addComment(
        issue.key,
        formatDecompositionComment(this.config.workerId, {
          parentIssueKey: issue.key,
          dryRun: true,
          summary: plan.summary,
          plan,
        }),
      );
      await this.pauseForManualHold(issue, analysisDecision);
      return "processed";
    }

    if (!this.tracker.createIssue) {
      await this.tracker.addComment(
        issue.key,
        formatDecompositionComment(this.config.workerId, {
          parentIssueKey: issue.key,
          dryRun: true,
          summary:
            "Decomposition create mode is enabled, but the Tracker client does not support issue creation.",
          plan,
          warnings: ["Tracker createIssue API is unavailable."],
        }),
      );
      await this.pauseForManualHold(issue, analysisDecision);
      return "waiting";
    }

    const parentQueue = issue.queue ?? issue.key.split("-")[0];
    if (!parentQueue) {
      throw new PermanentTaskError(
        `Cannot decompose ${issue.key}: parent queue is missing.`,
      );
    }

    const temporaryIdToIssueKey = new Map<string, string>();
    const warnings: string[] = [];
    for (const subtask of plan.subtasks) {
      const queue = subtask.queue ?? parentQueue;
      const dependencyNotes = subtaskDependencyNotes(
        subtask,
        temporaryIdToIssueKey,
        plan.dependencies,
      );
      const created = await this.tracker.createIssue({
        queue,
        title: `${titlePrefix} ${subtask.title}`,
        description: formatSubtaskDescription(issue.key, subtask, {
          dependencyNotes,
        }),
        tags: [...new Set([...subtask.tags, defaultSubtaskTag])],
      });
      temporaryIdToIssueKey.set(subtask.temporaryId, created.key);

      if (this.tracker.linkIssue) {
        await this.tracker
          .linkIssue({
            sourceIssueKey: issue.key,
            targetIssueKey: created.key,
            linkType: this.config.trackerParentLinkType ?? DEFAULT_TRACKER_PARENT_LINK_TYPE,
          })
          .catch((error) => {
            warnings.push(
              `Unable to link ${created.key} to parent ${issue.key}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      } else {
        warnings.push(`Parent link for ${created.key} was not created.`);
      }
    }

    for (const dependency of plan.dependencies) {
      const blockedIssueKey = temporaryIdToIssueKey.get(dependency.blockedTaskTemporaryId);
      const blockingIssueKey = temporaryIdToIssueKey.get(dependency.blockingTaskTemporaryId);
      if (!blockedIssueKey || !blockingIssueKey) {
        continue;
      }

      if (!this.tracker.linkIssue) {
        warnings.push(
          `Dependency link not created: ${blockedIssueKey} is blocked by ${blockingIssueKey}.`,
        );
        continue;
      }

      await this.tracker
        .linkIssue({
          sourceIssueKey: blockedIssueKey,
          targetIssueKey: blockingIssueKey,
          linkType:
            this.config.trackerBlockedByLinkType ?? DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE,
        })
        .catch((error) => {
          warnings.push(
            `Unable to link dependency ${blockedIssueKey} -> ${blockingIssueKey}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }

    const createdIssueKeys = [...temporaryIdToIssueKey.values()];
    await this.tracker.addComment(
      issue.key,
      formatDecompositionComment(this.config.workerId, {
        parentIssueKey: issue.key,
        createdIssueKeys,
        dryRun: false,
        summary: plan.summary,
        plan,
        warnings,
      }),
    );
    await this.pauseForManualHold(issue, analysisDecision);
    return "processed";
  }

  private async validateRepositoryState(): Promise<ValidationResult> {
    const changed = (await this.git.hasChanges()) || (await this.git.hasDiffFromBase());
    if (!changed) {
      return {
        changed: false,
        testsPassed: false,
        lintPassed: false,
        gates: [],
        diagnostic: "No repository changes detected.",
      };
    }

    const gates = await runQualityGates(this.config, {
      cwd: this.config.repoPath,
      logger: this.logger,
    });

    return {
      changed: true,
      testsPassed: qualityGateStatus(gates, "tests") === "passed",
      lintPassed: qualityGateStatus(gates, "lint") === "passed",
      gates,
      diagnostic: formatQualityGateDiagnostics(gates),
    };
  }

  private formatValidationSummary(validation: ValidationResult): string {
    return [
      validation.changed ? "- Repository changes: detected" : "- Repository changes: none",
      formatQualityGateSummary(validation.gates),
      validation.diagnostic ? `\nDiagnostic:\n${validation.diagnostic}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private formatReviewReplyBody(commitSha: string, validationSummary: string): string {
    return [
      `Applied the review feedback in commit ${commitSha}.`,
      "",
      "Validation:",
      validationSummary,
    ].join("\n");
  }

  private async publish(
    issue: TrackerIssue,
    branch: string,
    existingMr: MergeRequestInfo | null,
    validation: ValidationResult,
    implementationSummary?: string,
  ): Promise<void> {
    if (await this.git.hasChanges()) {
      const changedFiles = await this.git.getChangedFilesFromBase();
      await this.git.commit(
        buildCommitMessage({
          issue,
          changedFiles,
          summary: implementationSummary,
        }),
      );
    }

    await this.git.push(branch);
    const changedFiles = await this.git.getChangedFilesFromBase();

    const mergeRequest =
      existingMr ??
      (await this.gitlab.findOpenMergeRequestByBranch(branch)) ??
      (await this.gitlab.createMergeRequest({
        sourceBranch: branch,
        targetBranch: this.config.baseBranch,
        title: `[AI] ${issue.key} implementation`,
        description: buildMergeRequestDescription({
          issue,
          sourceBranch: branch,
          targetBranch: this.config.baseBranch,
          changedFiles,
          validationSummary: this.formatValidationSummary(validation),
          validationNotes: collectQualityGateNotes(validation.gates),
          workerId: this.config.workerId,
          codexSummary: implementationSummary,
        }),
      }));

    await this.finalizeSuccess(issue, branch, mergeRequest);
  }

  private async finalizeSuccess(
    issue: TrackerIssue,
    branch: string,
    mergeRequest: MergeRequestInfo,
  ): Promise<void> {
    await this.tracker.addComment(
      issue.key,
      formatMergeRequestComment(this.config.workerId, mergeRequest.url, branch),
    );
    await this.tracker.transition(issue.key, "review");
    await this.tracker.addComment(
      issue.key,
      formatStatusComment(
        this.config.workerId,
        "review",
        `Merge Request ready: ${mergeRequest.url}`,
      ),
    );
  }

  private async finalizeFailure(issue: TrackerIssue, diagnostic: string): Promise<void> {
    await this.tracker.addComment(
      issue.key,
      `Automation failed for ${issue.key}.\n\n${diagnostic}`,
    );
    try {
      await this.tracker.transition(issue.key, "failed");
      await this.tracker.addComment(
        issue.key,
        formatStatusComment(this.config.workerId, "failed", diagnostic),
      );
    } catch (error) {
      this.logger.warn("Failed to move issue into failed state. Falling back to waiting state.", {
        issueKey: issue.key,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.tracker.transition(issue.key, "waiting_for_answer");
      await this.tracker.addComment(
        issue.key,
        formatStatusComment(
          this.config.workerId,
          "waiting_for_answer",
          "Waiting for manual intervention after automation failure.",
          "failure_recovery",
        ),
      );
    }
  }
}
