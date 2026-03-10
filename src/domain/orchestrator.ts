import type {
  AppConfig,
  CodexExecution,
  CodexRunner,
  CommentWithMetadata,
  GitLabService,
  GitService,
  LogicalStatus,
  MergeRequestInfo,
  TrackerClient,
  TrackerIssue,
  ValidationResult,
} from "../models/types.js";
import {
  findFirstHumanReplyAfter,
  findLatestQuestionComment,
  findLatestStatusComment,
  formatMergeRequestComment,
  formatQuestionCommentWithThreadId,
  formatStatusComment,
} from "../integrations/tracker/commentProtocol.js";
import { buildFixPrompt, buildInitialPrompt, buildResumePrompt } from "./promptBuilder.js";
import {
  PermanentTaskError,
  TemporaryIntegrationError,
} from "../utils/errors.js";
import { Logger } from "../utils/logger.js";
import { runShellCommand } from "../utils/shell.js";
import { sleep } from "../utils/sleep.js";

type CycleOutcome = "processed" | "idle" | "waiting";

const ACTIVE_STATES: LogicalStatus[] = ["in_progress", "waiting_for_answer"];

const isValidationSuccessful = (validation: ValidationResult): boolean =>
  validation.changed && validation.testsPassed && validation.lintPassed;

const buildCommandDiagnostic = (
  label: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): string =>
  [
    `${label} failed with exit code ${exitCode}.`,
    stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
    stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

export class WorkerOrchestrator {
  constructor(
    private readonly config: AppConfig,
    private readonly tracker: TrackerClient,
    private readonly git: GitService,
    private readonly gitlab: GitLabService,
    private readonly codex: CodexRunner,
    private readonly logger: Logger,
  ) {}

  async runForever(): Promise<void> {
    while (true) {
      try {
        const outcome = await this.runOnce();
        if (outcome !== "processed") {
          this.logger.info("Worker is sleeping.", {
            pollIntervalMinutes: this.config.pollIntervalMinutes,
          });
          await sleep(this.config.pollIntervalMs);
        }
      } catch (error) {
        this.logger.error("Worker cycle failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(this.config.pollIntervalMs);
      }
    }
  }

  async runOnce(): Promise<CycleOutcome> {
    const ownedTask = await this.resumeOwnedTask();
    if (ownedTask) {
      return this.handleIssue(ownedTask.issue, ownedTask.comments);
    }

    const nextTask = await this.pickNextTask();
    if (!nextTask) {
      this.logger.info("No suitable tasks found.");
      return "idle";
    }

    return this.handleIssue(nextTask.issue, nextTask.comments);
  }

  private async resumeOwnedTask(): Promise<{
    issue: TrackerIssue;
    comments: CommentWithMetadata[];
  } | null> {
    const issues = await this.tracker.findOwnedIssues(ACTIVE_STATES);
    for (const issue of issues) {
      const comments = await this.tracker.getComments(issue.key);
      const latestStatus = findLatestStatusComment(comments);
      if (latestStatus?.worker === this.config.workerId) {
        return { issue, comments };
      }
    }

    return null;
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

    return (
      latestStatus.worker !== this.config.workerId &&
      latestStatus.state !== undefined &&
      ACTIVE_STATES.includes(latestStatus.state)
    );
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
    let shouldResumeAfterAnswer = false;
    let activeThreadId: string | undefined;
    if (issue.logicalStatus === "open") {
      await this.tracker.transition(issue.key, "in_progress");
      await this.tracker.addComment(
        issue.key,
        formatStatusComment(this.config.workerId, "in_progress", "Started processing task."),
      );
      issue.logicalStatus = "in_progress";
    }

    if (issue.logicalStatus === "waiting_for_answer") {
      const latestQuestion = findLatestQuestionComment(comments);
      if (!latestQuestion || latestQuestion.metadata.worker !== this.config.workerId) {
        this.logger.warn("Task is waiting for answer, but no matching AI question was found.", {
          issueKey: issue.key,
        });
        return "waiting";
      }

      const answer = findFirstHumanReplyAfter(comments, latestQuestion.createdAt);
      if (!answer) {
        this.logger.info("Task is still waiting for a human answer.", {
          issueKey: issue.key,
        });
        return "waiting";
      }

      await this.tracker.transition(issue.key, "in_progress");
      await this.tracker.addComment(
        issue.key,
        formatStatusComment(
          this.config.workerId,
          "in_progress",
          "Human answer received. Resuming task processing.",
        ),
      );
      issue.logicalStatus = "in_progress";
      comments = await this.tracker.getComments(issue.key);
      shouldResumeAfterAnswer = true;
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
      const latestQuestion = findLatestQuestionComment(comments);
      const execution =
        shouldResumeAfterAnswer &&
        latestQuestion?.metadata.worker === this.config.workerId &&
        latestQuestion.metadata.threadId
          ? await this.runResumeWithFallback(issue, comments, latestQuestion.metadata.threadId)
          : await this.codex.runInitial(buildInitialPrompt(issue, comments));
      activeThreadId = execution.threadId ?? latestQuestion?.metadata.threadId;
      if (execution.question) {
        await this.pauseForAnswer(issue, execution.question, execution.threadId);
        return "waiting";
      }

      if (execution.process.exitCode !== 0) {
        this.logger.warn("Codex initial run exited with non-zero code.", {
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
      if (execution.question) {
        await this.pauseForAnswer(issue, execution.question, execution.threadId ?? activeThreadId);
        return "waiting";
      }

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

    await this.publish(issue, branch, existingMr);
    return "processed";
  }

  private async runResumeWithFallback(
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
    threadId: string,
  ): Promise<CodexExecution> {
    const execution = await this.codex.runResume(threadId, buildResumePrompt(issue, comments));
    if (execution.process.exitCode === 0) {
      return execution;
    }

    this.logger.warn("Codex resume failed, falling back to a fresh session.", {
      issueKey: issue.key,
      threadId,
      exitCode: execution.process.exitCode,
      stderr: execution.process.stderr,
    });
    return this.codex.runInitial(buildInitialPrompt(issue, comments));
  }

  private async pauseForAnswer(
    issue: TrackerIssue,
    question: string,
    threadId?: string,
  ): Promise<void> {
    await this.tracker.addComment(
      issue.key,
      formatQuestionCommentWithThreadId(this.config.workerId, question, threadId),
    );
    await this.tracker.transition(issue.key, "waiting_for_answer");
    await this.tracker.addComment(
      issue.key,
      formatStatusComment(
        this.config.workerId,
        "waiting_for_answer",
        "Waiting for human clarification.",
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
        diagnostic: "No repository changes detected.",
      };
    }

    const testResult = await runShellCommand(this.config.testCommand, {
      cwd: this.config.repoPath,
    });
    if (testResult.exitCode !== 0) {
      return {
        changed: true,
        testsPassed: false,
        lintPassed: false,
        diagnostic: buildCommandDiagnostic(
          "Tests",
          testResult.exitCode,
          testResult.stdout,
          testResult.stderr,
        ),
      };
    }

    const lintResult = await runShellCommand(this.config.lintCommand, {
      cwd: this.config.repoPath,
    });
    if (lintResult.exitCode !== 0) {
      return {
        changed: true,
        testsPassed: true,
        lintPassed: false,
        diagnostic: buildCommandDiagnostic(
          "Lint",
          lintResult.exitCode,
          lintResult.stdout,
          lintResult.stderr,
        ),
      };
    }

    return {
      changed: true,
      testsPassed: true,
      lintPassed: true,
      diagnostic: "",
    };
  }

  private async publish(
    issue: TrackerIssue,
    branch: string,
    existingMr: MergeRequestInfo | null,
  ): Promise<void> {
    if (await this.git.hasChanges()) {
      await this.git.commit(`feat: implement ${issue.key}`);
    }

    await this.git.push(branch);

    const mergeRequest =
      existingMr ??
      (await this.gitlab.findOpenMergeRequestByBranch(branch)) ??
      (await this.gitlab.createMergeRequest({
        sourceBranch: branch,
        targetBranch: this.config.baseBranch,
        title: `[AI] ${issue.key} implementation`,
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
    await this.tracker.transition(issue.key, "failed");
    await this.tracker.addComment(
      issue.key,
      formatStatusComment(this.config.workerId, "failed", diagnostic),
    );
  }
}
