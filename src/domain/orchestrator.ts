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
  TaskAnalysisResult,
  TaskLease,
  TrackerClient,
  TrackerIssue,
  ValidationResult,
} from "../models/types.js";
import {
  findHumanCommentsAfter,
  findLatestHumanTaskCommandAfter,
  findLatestQuestionComment,
  findLatestReviewMetadata,
  findLatestStatusComment,
  formatReviewMetadataComment,
  formatMergeRequestComment,
  formatQuestionCommentWithThreadId,
  formatStatusComment,
} from "../integrations/tracker/commentProtocol.js";
import {
  buildAnalysisPrompt,
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

export type CycleOutcome = "processed" | "idle" | "waiting";

interface ResumeContext {
  questionComment: CommentWithMetadata & { metadata: NonNullable<CommentWithMetadata["metadata"]> };
  command: HumanTaskCommand;
}

const ACTIVE_STATES: LogicalStatus[] = ["in_progress", "waiting_for_answer"];
const OWNED_TASK_STATES: LogicalStatus[] = [...ACTIVE_STATES, "review"];
const ANALYSIS_READY_MARKER = "READY_FOR_IMPLEMENTATION";
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
  latestStatus.waitingReason !== "failure_recovery";

const mergeUniqueStrings = (first: string[], second: string[]): string[] => [
  ...new Set([...first, ...second]),
];

const mergeUniqueNumbers = (first: number[], second: number[]): number[] => [
  ...new Set([...first, ...second]),
];

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
      if (analysis.status === "clarification_required" && analysis.clarification) {
        await this.pauseForClarification(issue, analysis.clarification, activeThreadId);
        return "waiting";
      }
    }

    const branch = await this.git.checkoutTaskBranch(issue.key);
    const existingMr = await this.gitlab.findOpenMergeRequestByBranch(branch);
    const hasUncommittedChanges = await this.git.hasChanges();
    const hasCommittedDiff = await this.git.hasDiffFromBase();

    if (existingMr && !hasUncommittedChanges && hasCommittedDiff) {
      await this.finalizeSuccess(issue, branch, existingMr);
      return "processed";
    }

    if (!hasUncommittedChanges && !hasCommittedDiff) {
      const implementationPrompt = buildImplementationPrompt(issue, comments);
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
        ? await this.codex.runResume(activeThreadId, buildFixPrompt(issue, validation.diagnostic))
        : await this.codex.runFix(buildFixPrompt(issue, validation.diagnostic));
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
    const prompt = buildReviewFixPrompt(issue, comments, {
      mergeRequest,
      discussions: pendingDiscussions,
      changedFiles,
      diffFromBase,
    });

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
            buildFixPrompt(issue, validation.diagnostic),
          )
        : await this.codex.runFix(buildFixPrompt(issue, validation.diagnostic));
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
    const execution = await this.codex.runInitial(buildAnalysisPrompt(issue, comments));
    if (execution.clarification) {
      return {
        status: "clarification_required",
        clarification: execution.clarification,
        threadId: execution.threadId,
      };
    }

    const finalMessage = execution.finalMessage?.trim();
    if (execution.process.exitCode !== 0 && finalMessage !== ANALYSIS_READY_MARKER) {
      throw new PermanentTaskError(
        execution.process.stderr.trim() || "Codex analysis stage failed.",
      );
    }

    if (finalMessage && finalMessage !== ANALYSIS_READY_MARKER) {
      this.logger.warn("Analysis stage returned unexpected final message, treating task as ready.", {
        issueKey: issue.key,
        finalMessage,
      });
    }

    return {
      status: "ready",
      threadId: execution.threadId,
    };
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
