import type {
  AppConfig,
  ClarificationQuestion,
  CodexExecution,
  CodexRunner,
  CommentWithMetadata,
  FailureMemoryEntry,
  GitLabService,
  GitService,
  GlobalWorkerConfig,
  HumanTaskCommand,
  MergeRequestInfo,
  PromptProfile,
  TaskAnalysisDecision,
  TaskAnalysisResult,
  TrackerIssue,
  ValidationResult,
} from "../models/types.js";
import {
  AgentWorkflowService,
  type ClaimedTask,
  type TaskComment,
  type TaskDecision,
  type TaskLeaseRecord,
  mapTaskStatusToLogicalStatus,
  type TaskTrackerClient,
} from "./taskTracker/index.js";
import {
  DEFAULT_CONFIDENCE_HUMAN_THRESHOLD,
  DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD,
  createClarificationFromAnalysis,
  createManualHoldAnalysisDecision,
  createReadyAnalysisDecision,
  parseTaskAnalysisDecision,
} from "./analysisDecision.js";
import { buildCommitMessage } from "./commitMessage.js";
import {
  formatSubtaskDescription,
  parseDecompositionPlan,
} from "./decomposition.js";
import { buildMergeRequestDescription } from "./mergeRequestDescription.js";
import { FileMemoryStore, type MemoryStore } from "./memoryStore.js";
import {
  buildPromptContextBundle,
  type PromptContextBundle,
} from "./promptContext.js";
import {
  buildAnalysisPrompt,
  buildDecompositionPrompt,
  buildFixPrompt,
  buildImplementationPrompt,
  buildResumePrompt,
} from "./promptBuilder.js";
import { selectPromptProfile } from "./promptProfiles.js";
import {
  collectQualityGateNotes,
  formatQualityGateDiagnostics,
  formatQualityGateSummary,
  qualityGatesPassed,
  qualityGateStatus,
  runQualityGates,
} from "./qualityGates.js";
import type { RepositoryWorkerContext } from "./repositoryContext.js";
import type { YandexBridge } from "../integrations/yandexBridge/index.js";
import type { TaskEventType } from "../observability/events.js";
import {
  noopObservability,
  type ObservabilityTelemetry,
  type TaskTelemetryContext,
} from "../observability/service.js";
import {
  PermanentTaskError,
  TemporaryIntegrationError,
} from "../utils/errors.js";
import { Logger } from "../utils/logger.js";
import type { CycleOutcome } from "./orchestrator.js";

const ANALYSIS_READY_MARKER = "READY_FOR_IMPLEMENTATION";
const DEFAULT_TASK_MODE = "auto";
const DEFAULT_DECOMPOSITION_MAX_SUBTASKS = 8;
const DEFAULT_DECOMPOSITION_SUBTASK_TAG = "ai_dev";
const DEFAULT_DECOMPOSITION_TITLE_PREFIX = "[AI split]";

interface InternalExecutionContext {
  profile: RepositoryWorkerContext["profile"];
  config: AppConfig;
  git: GitService;
  gitlab: GitLabService;
  codex: CodexRunner;
}

interface InternalResumeContext {
  question: TaskComment;
  threadId?: string;
  command: HumanTaskCommand;
}

const isValidationSuccessful = (validation: ValidationResult): boolean =>
  validation.changed && qualityGatesPassed(validation.gates);

const hasRepositoryPromptProfileOverrides = (
  config: AppConfig,
): AppConfig["promptProfiles"] | undefined => config.promptProfiles;

const taskToIssue = (task: ClaimedTask["task"]): TrackerIssue => ({
  id: task.id,
  key: task.id,
  title: task.title,
  description: task.description,
  ...(task.queue ? { queue: task.queue } : {}),
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  logicalStatus: mapTaskStatusToLogicalStatus(task.status),
  ...(task.priority ? { priority: task.priority } : {}),
  ...(task.deadline ? { deadline: task.deadline } : {}),
  components: [...task.components],
  tags: [...task.tags],
});

const questionMetadata = (comment: TaskComment): CommentWithMetadata["metadata"] | undefined => {
  if (comment.kind !== "question") {
    return undefined;
  }
  const payload = (comment.payload ?? {}) as Record<string, unknown>;
  return {
    kind: "AI QUESTION",
    worker: typeof payload.workerId === "string" ? payload.workerId : comment.author.id,
    summary:
      typeof payload.summary === "string"
        ? payload.summary
        : comment.body ?? "Clarification requested.",
    blockingReason:
      typeof payload.blockingReason === "string"
        ? payload.blockingReason
        : "Not recorded.",
    question:
      typeof payload.question === "string"
        ? payload.question
        : comment.body ?? "",
    options: Array.isArray(payload.options)
      ? payload.options.filter((value): value is string => typeof value === "string")
      : [],
    resumeHint:
      typeof payload.resumeHint === "string" ? payload.resumeHint : "Reply with /resume.",
    ...(typeof payload.threadId === "string" ? { threadId: payload.threadId } : {}),
  };
};

const commentsForPrompt = (comments: TaskComment[]): CommentWithMetadata[] =>
  comments.map((comment) => ({
    id: comment.id,
    text: comment.body ?? "",
    createdAt: comment.createdAt,
    author: comment.author.displayName ?? comment.author.id,
    isSystem: comment.author.owner !== "human" && comment.kind !== "answer",
    ...(questionMetadata(comment) ? { metadata: questionMetadata(comment) } : {}),
  }));

const parseHumanTaskCommand = (text: string): HumanTaskCommand | undefined => {
  const normalized = text.trim();
  if (!normalized.includes("/")) {
    return undefined;
  }
  const lines = normalized.split(/\r?\n/);
  const commandLine = [...lines].reverse().find((line) => line.trim().startsWith("/"))?.trim();
  if (!commandLine) {
    return undefined;
  }
  if (/^\/skip\b/i.test(commandLine)) {
    return { type: "skip", rawText: normalized };
  }
  if (/^\/cancel\b/i.test(commandLine)) {
    return { type: "cancel", rawText: normalized };
  }
  const resumeMatch = commandLine.match(/^\/resume(?:\s+(.+))?$/i);
  if (!resumeMatch) {
    return undefined;
  }
  const argument = resumeMatch[1]?.trim() ?? "";
  if (!argument || /^continue$/i.test(argument)) {
    return { type: "resume", rawText: normalized };
  }
  const freeformMatch = argument.match(/^freeform\s*:\s*(.+)$/i);
  if (freeformMatch) {
    return {
      type: "resume",
      rawText: normalized,
      freeform: freeformMatch[1]?.trim() ?? "",
    };
  }
  const [choice, ...rest] = argument.split(/\s+/);
  return {
    type: "resume",
    rawText: normalized,
    ...(choice ? { choice } : {}),
    ...(rest.length > 0 ? { freeform: rest.join(" ") } : {}),
  };
};

const latestAnalysisDecision = (
  decisions: TaskDecision[],
): TaskAnalysisDecision | undefined => {
  const payload = decisions
    .filter((decision) => decision.kind === "analysis")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.payload;
  if (!payload) {
    return undefined;
  }
  if (
    typeof payload.confidence !== "number" ||
    typeof payload.taskType !== "string" ||
    typeof payload.recommendedMode !== "string" ||
    typeof payload.promptProfileId !== "string"
  ) {
    return undefined;
  }
  return {
    confidence: payload.confidence,
    taskType: payload.taskType as TaskAnalysisDecision["taskType"],
    recommendedMode: payload.recommendedMode as TaskAnalysisDecision["recommendedMode"],
    promptProfileId: payload.promptProfileId,
    expectedFiles: Array.isArray(payload.expectedFiles)
      ? payload.expectedFiles.filter((value): value is string => typeof value === "string")
      : [],
    expectedSubsystems: Array.isArray(payload.expectedSubsystems)
      ? payload.expectedSubsystems.filter((value): value is string => typeof value === "string")
      : [],
    riskFactors: Array.isArray(payload.riskFactors)
      ? payload.riskFactors.filter((value): value is string => typeof value === "string")
      : [],
    missingContext: Array.isArray(payload.missingContext)
      ? payload.missingContext.filter((value): value is string => typeof value === "string")
      : [],
    reasoning:
      typeof payload.reasoning === "string"
        ? payload.reasoning
        : "Analysis decision restored from internal tracker.",
  };
};

export class InternalWorkerOrchestrator {
  private shuttingDown = false;
  private wakeSleep: (() => void) | undefined;
  private readonly workflow: AgentWorkflowService;
  private readonly memoryStore?: MemoryStore;

  constructor(
    private readonly config: GlobalWorkerConfig,
    private readonly contexts: InternalExecutionContext[],
    private readonly taskTracker: TaskTrackerClient,
    private readonly logger: Logger,
    memoryStore?: MemoryStore,
    private readonly telemetry: ObservabilityTelemetry = noopObservability,
    private readonly yandexBridges: YandexBridge[] = [],
  ) {
    this.workflow = new AgentWorkflowService(taskTracker);
    this.memoryStore = memoryStore ?? (
      config.memory?.enabled ? new FileMemoryStore(config.memory, logger) : undefined
    );
  }

  async runForever(): Promise<void> {
    this.shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (this.shuttingDown) {
        return;
      }
      this.logger.info("Internal worker shutdown signal received.", { signal });
      this.shuttingDown = true;
      this.wakeSleep?.();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    try {
      while (!this.shuttingDown) {
        const outcome = await this.runOnce();
        if (outcome !== "processed" && !this.shuttingDown) {
          await this.interruptibleSleep(this.config.pollIntervalMs);
        }
      }
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
      stage: "internal_polling",
    });
    await this.importExternalTasks();

    const claim = await this.workflow.claimTask({
      workerId: this.config.workerId,
      repositoryProfiles: this.contexts.map((context) => ({
        name: context.profile.name,
        queues: context.profile.queues,
        tags: context.profile.tags,
      })),
      leaseTtlSeconds: Math.max(1, Math.floor(this.config.coordination.lockTtlMs / 1000)),
      ...(this.config.targetIssueKey ? { targetExternalKey: this.config.targetIssueKey } : {}),
    });
    if (!claim) {
      this.logger.info("No suitable internal tasks found.");
      return "idle";
    }

    const context = this.contextForClaim(claim);
    return this.withLeaseHeartbeat(claim, () => this.processClaimedTask(context, claim));
  }

  private async importExternalTasks(): Promise<void> {
    for (const bridge of this.yandexBridges) {
      await bridge.importCandidates();
    }
  }

  private async syncExternalMirror(taskId: string): Promise<void> {
    for (const bridge of this.yandexBridges) {
      await bridge.exportTaskDigests(taskId);
      await bridge.syncTaskStatus(taskId);
      await bridge.mirrorApprovedChildTasks(taskId);
    }
  }

  private contextForClaim(claim: ClaimedTask): InternalExecutionContext {
    const repositoryName = claim.task.repositoryName;
    const context = this.contexts.find((candidate) => candidate.profile.name === repositoryName);
    if (!context) {
      throw new PermanentTaskError(
        `Internal task ${claim.task.id} targets unknown repository ${repositoryName ?? "unknown"}.`,
      );
    }
    return context;
  }

  private async withLeaseHeartbeat<T>(
    claim: ClaimedTask,
    run: () => Promise<T>,
  ): Promise<T> {
    let taskLease: TaskLeaseRecord = claim.taskLease;
    let repositoryLease: TaskLeaseRecord = claim.repositoryLease;
    const heartbeatSeconds = Math.max(
      1,
      Math.floor(this.config.coordination.lockTtlMs / 1000),
    );
    const heartbeat = async (): Promise<void> => {
      taskLease = await this.workflow.heartbeatLease(taskLease.leaseId, {
        workerId: this.config.workerId,
        token: taskLease.token,
        leaseTtlSeconds: heartbeatSeconds,
      });
      repositoryLease = await this.workflow.heartbeatLease(repositoryLease.leaseId, {
        workerId: this.config.workerId,
        token: repositoryLease.token,
        leaseTtlSeconds: heartbeatSeconds,
      });
    };
    const interval = setInterval(() => {
      heartbeat().catch((error) => {
        this.logger.warn("Internal lease heartbeat failed.", {
          taskId: claim.task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.config.coordination.lockHeartbeatMs);

    try {
      return await run();
    } finally {
      clearInterval(interval);
      await Promise.allSettled([
        this.workflow.releaseLease(taskLease.leaseId, {
          workerId: this.config.workerId,
          token: taskLease.token,
        }),
        this.workflow.releaseLease(repositoryLease.leaseId, {
          workerId: this.config.workerId,
          token: repositoryLease.token,
        }),
      ]);
    }
  }

  private async processClaimedTask(
    context: InternalExecutionContext,
    claim: ClaimedTask,
  ): Promise<CycleOutcome> {
    const startedAt = Date.now();
    const issue = taskToIssue(claim.task);
    await this.recordWorkflowEvent(context, claim.task.id, {
      type: "task_picked",
      status: "info",
      message: "Internal task picked for processing.",
    });

    try {
      const outcome = await this.processTask(context, claim);
      await this.syncExternalMirror(claim.task.id);
      this.telemetry.recordTaskFinished(
        this.taskContext(context, claim.task.id),
        outcome === "waiting" ? "waiting" : "processed",
        Date.now() - startedAt,
        outcome === "waiting" ? "Internal task is waiting." : "Internal task processed.",
      );
      return outcome;
    } catch (error) {
      if (error instanceof TemporaryIntegrationError) {
        this.logger.error("Temporary integration error while processing internal task.", {
          taskId: issue.key,
          error: error.message,
        });
        this.telemetry.recordTaskFinished(
          this.taskContext(context, claim.task.id),
          "waiting",
          Date.now() - startedAt,
          error.message,
        );
        await this.syncExternalMirror(claim.task.id);
        return "waiting";
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.finalizeFailure(context, claim.task.id, message);
      await this.syncExternalMirror(claim.task.id);
      this.telemetry.recordTaskFinished(
        this.taskContext(context, claim.task.id),
        "failed",
        Date.now() - startedAt,
        message,
      );
      return "processed";
    }
  }

  private async processTask(
    context: InternalExecutionContext,
    claim: ClaimedTask,
  ): Promise<CycleOutcome> {
    let task = await this.taskTracker.getTask(claim.task.id);
    let issue = taskToIssue(task);
    let comments = commentsForPrompt(task.comments);
    let activeThreadId: string | undefined;
    let implementationSummary: string | undefined;
    let analysisDecision = latestAnalysisDecision(task.decisions);
    const resumeContext = this.resolveResumeContext(task.comments);

    await this.taskTracker.setStatus(task.id, "analyzing", "Internal task analysis started.");
    await this.workflow.recordTaskStep(task.id, { kind: "analyze", status: "running" });

    if (resumeContext) {
      activeThreadId = resumeContext.threadId;
      await this.workflow.recordTaskStep(task.id, {
        kind: "analyze",
        status: "done",
        outputSummary: "Resuming from stored human answer.",
      });
    } else {
      const analysis = await this.runAnalysis(context, task.id, issue, comments);
      activeThreadId = analysis.threadId;
      analysisDecision = analysis.decision;
      if (!analysisDecision) {
        analysisDecision = createManualHoldAnalysisDecision(
          "Analysis did not produce a structured routing decision.",
        );
      }

      const taskMode = this.resolveTaskMode(context.config, analysisDecision);
      if (taskMode === "analyze_only") {
        await this.pauseForManualHold(context, task.id, analysisDecision);
        return "waiting";
      }
      if (taskMode === "ask_clarification") {
        await this.pauseForClarification(
          context,
          task.id,
          analysis.clarification ?? createClarificationFromAnalysis(analysisDecision),
          activeThreadId,
        );
        return "waiting";
      }
      if (taskMode === "human") {
        await this.pauseForManualHold(context, task.id, analysisDecision);
        return "waiting";
      }
      if (taskMode === "decompose") {
        return this.runDecomposition(context, task.id, issue, comments, analysisDecision, activeThreadId);
      }
      if (analysis.status === "clarification_required" && analysis.clarification) {
        await this.pauseForClarification(context, task.id, analysis.clarification, activeThreadId);
        return "waiting";
      }
    }

    await this.taskTracker.setStatus(task.id, "implementing", "Internal task implementation started.");
    await this.workflow.recordTaskStep(task.id, { kind: "implement", status: "running" });
    task = await this.taskTracker.getTask(task.id);
    issue = taskToIssue(task);
    comments = commentsForPrompt(task.comments);
    const promptProfile = this.selectProfile(context.config, issue, analysisDecision);
    const branch = await context.git.checkoutTaskBranch(task.id);
    const existingMr = await context.gitlab.findOpenMergeRequestByBranch(branch);
    const hasUncommittedChanges = await context.git.hasChanges();
    const hasCommittedDiff = await context.git.hasDiffFromBase();

    if (existingMr && !hasUncommittedChanges && hasCommittedDiff) {
      await this.taskTracker.setStatus(task.id, "validating", "Reusing existing validated MR state.");
      await this.workflow.recordTaskStep(task.id, {
        kind: "validate",
        status: "skipped",
        outputSummary: "Existing merge request and branch diff were reused.",
      });
      await this.publishExisting(context, task.id, branch, existingMr);
      return "processed";
    }

    if (!hasUncommittedChanges && !hasCommittedDiff) {
      const memoryContext = await this.buildMemoryContext(context, {
        taskId: task.id,
        issue,
        taskType: analysisDecision?.taskType ?? promptProfile.taskType,
        promptProfileId: promptProfile.id,
        expectedFiles: analysisDecision?.expectedFiles ?? [],
        extraTags: analysisDecision?.expectedSubsystems ?? [],
      });
      const implementationPrompt = buildImplementationPrompt(
        issue,
        comments,
        promptProfile,
        analysisDecision,
        memoryContext,
      );
      const execution = await this.runCodexStage(context, task.id, "implementation", () =>
        resumeContext
          ? this.runResumeOrInitial(
              context,
              issue,
              activeThreadId,
              buildResumePrompt(issue, comments, resumeContext.command),
              implementationPrompt,
            )
          : activeThreadId
            ? this.runResumeOrInitial(context, issue, activeThreadId, implementationPrompt, implementationPrompt)
            : context.codex.runInitial(implementationPrompt),
      );
      activeThreadId = execution.threadId ?? activeThreadId;
      if (execution.clarification) {
        await this.pauseForClarification(context, task.id, execution.clarification, activeThreadId);
        return "waiting";
      }
      implementationSummary = execution.finalMessage?.trim();
      await this.workflow.recordTaskStep(task.id, {
        kind: "implement",
        status: "done",
        outputSummary: implementationSummary,
      });
    } else {
      this.logger.info("Reusing existing repository state for internal task validation.", {
        taskId: task.id,
        branch,
        hasUncommittedChanges,
        hasCommittedDiff,
      });
      await this.workflow.recordTaskStep(task.id, {
        kind: "implement",
        status: "done",
        outputSummary: "Reused existing repository state.",
      });
    }

    await this.taskTracker.setStatus(task.id, "validating", "Internal task validation started.");
    await this.workflow.recordTaskStep(task.id, { kind: "validate", status: "running" });
    let validation = await this.validateRepositoryState(context, task.id);
    if (!validation.changed) {
      await this.recordFailureMemory(context, {
        issue,
        failureKind: "no_repository_changes",
        diagnostic: "Codex completed without producing repository changes.",
        promptProfile,
        analysisDecision,
      });
      await this.workflow.recordTaskStep(task.id, {
        kind: "validate",
        status: "failed",
        failureKind: "no_repository_changes",
        diagnostic: validation.diagnostic,
      });
      throw new PermanentTaskError("Codex completed without producing repository changes.");
    }

    let attempt = 0;
    while (!isValidationSuccessful(validation) && attempt < context.config.maxFixAttempts) {
      attempt += 1;
      await this.taskTracker.setStatus(task.id, "implementing", "Applying validation fix.");
      await this.workflow.recordTaskStep(task.id, {
        kind: "fix",
        attempt,
        status: "running",
        diagnostic: validation.diagnostic,
      });
      const execution = await this.runCodexStage(context, task.id, "implementation", () =>
        activeThreadId
          ? context.codex.runResume(
              activeThreadId,
              buildFixPrompt(issue, validation.diagnostic, promptProfile, analysisDecision),
            )
          : context.codex.runFix(
              buildFixPrompt(issue, validation.diagnostic, promptProfile, analysisDecision),
            ),
      );
      activeThreadId = execution.threadId ?? activeThreadId;
      if (execution.clarification) {
        await this.pauseForClarification(context, task.id, execution.clarification, activeThreadId);
        return "waiting";
      }
      implementationSummary = execution.finalMessage?.trim() ?? implementationSummary;
      await this.workflow.recordTaskStep(task.id, {
        kind: "fix",
        attempt,
        status: "done",
        outputSummary: implementationSummary,
      });
      await this.taskTracker.setStatus(task.id, "validating", "Re-running validation after fix.");
      validation = await this.validateRepositoryState(context, task.id);
    }

    if (!isValidationSuccessful(validation)) {
      await this.recordFailureMemory(context, {
        issue,
        failureKind: "validation_exhausted",
        diagnostic: validation.diagnostic,
        promptProfile,
        analysisDecision,
      });
      await this.workflow.recordTaskStep(task.id, {
        kind: "validate",
        status: "failed",
        failureKind: "validation_exhausted",
        diagnostic: validation.diagnostic,
      });
      throw new PermanentTaskError(validation.diagnostic);
    }

    await this.workflow.recordTaskStep(task.id, {
      kind: "validate",
      status: "done",
      outputSummary: this.formatValidationSummary(validation),
    });
    await this.workflow.recordTaskStep(task.id, { kind: "publish", status: "running" });
    await this.publish(context, task.id, issue, branch, existingMr, validation, implementationSummary);
    await this.workflow.recordTaskStep(task.id, { kind: "publish", status: "done" });
    return "processed";
  }

  private resolveResumeContext(comments: TaskComment[]): InternalResumeContext | undefined {
    const latestQuestion = comments
      .filter((comment) => comment.kind === "question")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    if (!latestQuestion) {
      return undefined;
    }
    const answer = comments
      .filter((comment) => comment.kind === "answer" && comment.createdAt > latestQuestion.createdAt)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    if (!answer?.body) {
      return undefined;
    }
    const command = parseHumanTaskCommand(answer.body);
    if (command?.type !== "resume") {
      return undefined;
    }
    const payload = (latestQuestion.payload ?? {}) as Record<string, unknown>;
    return {
      question: latestQuestion,
      ...(typeof payload.threadId === "string" ? { threadId: payload.threadId } : {}),
      command,
    };
  }

  private async runAnalysis(
    context: InternalExecutionContext,
    taskId: string,
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
  ): Promise<TaskAnalysisResult> {
    await this.recordWorkflowEvent(context, taskId, {
      type: "analysis_started",
      status: "info",
      message: "Internal task analysis started.",
    });
    const storedDecision = latestAnalysisDecision((await this.taskTracker.getTask(taskId)).decisions);
    if (storedDecision && storedDecision.recommendedMode !== "ask_clarification") {
      await this.workflow.recordTaskStep(taskId, {
        kind: "analyze",
        status: "done",
        outputSummary: "Reused stored analysis decision.",
      });
      return {
        status: "ready",
        decision: storedDecision,
      };
    }

    const memoryContext = await this.buildMemoryContext(context, {
      taskId,
      issue,
      taskType: "unknown",
      promptProfileId: "general",
      expectedFiles: [],
    });
    const execution = await this.runCodexStage(context, taskId, "analysis", () =>
      context.codex.runInitial(buildAnalysisPrompt(issue, comments, memoryContext)),
    );
    let decision: TaskAnalysisDecision | undefined;
    if (execution.clarification) {
      decision = {
        confidence: Math.max(
          0,
          Math.min(context.config.confidenceHumanThreshold ?? DEFAULT_CONFIDENCE_HUMAN_THRESHOLD, 30),
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
      await this.workflow.recordAnalysisDecision(taskId, decision);
      await this.workflow.recordTaskStep(taskId, {
        kind: "analyze",
        status: "done",
        outputSummary: decision.reasoning,
      });
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
          context.config.confidenceImplementThreshold ?? DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD,
        humanThreshold:
          context.config.confidenceHumanThreshold ?? DEFAULT_CONFIDENCE_HUMAN_THRESHOLD,
      });
    }
    if (!decision) {
      const reason =
        execution.process.exitCode !== 0
          ? execution.process.stderr.trim() || "Codex analysis stage failed."
          : `Codex analysis did not return valid AI_ANALYSIS output: ${finalMessage || "empty response"}`;
      decision = createManualHoldAnalysisDecision(reason);
    }
    await this.workflow.recordAnalysisDecision(taskId, decision);
    await this.workflow.recordTaskStep(taskId, {
      kind: "analyze",
      status: "done",
      outputSummary: decision.reasoning,
    });
    return {
      status: decision.recommendedMode === "ask_clarification" ? "clarification_required" : "ready",
      threadId: execution.threadId,
      decision,
    };
  }

  private resolveTaskMode(
    config: AppConfig,
    decision: TaskAnalysisDecision,
  ): "implement" | "ask_clarification" | "decompose" | "human" | "analyze_only" {
    const configuredMode = config.taskMode ?? DEFAULT_TASK_MODE;
    if (configuredMode !== "auto") {
      return configuredMode;
    }
    const implementThreshold =
      config.confidenceImplementThreshold ?? DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD;
    const humanThreshold =
      config.confidenceHumanThreshold ?? DEFAULT_CONFIDENCE_HUMAN_THRESHOLD;
    if (decision.recommendedMode === "implement" && decision.confidence < humanThreshold) {
      return "human";
    }
    if (decision.recommendedMode === "implement" && decision.confidence < implementThreshold) {
      return decision.missingContext.length > 0 ? "ask_clarification" : "human";
    }
    return decision.recommendedMode;
  }

  private selectProfile(
    config: AppConfig,
    issue: TrackerIssue,
    decision: TaskAnalysisDecision | undefined,
  ): PromptProfile {
    return selectPromptProfile(issue, decision, hasRepositoryPromptProfileOverrides(config));
  }

  private async pauseForClarification(
    context: InternalExecutionContext,
    taskId: string,
    clarification: ClarificationQuestion,
    threadId?: string,
  ): Promise<void> {
    await this.workflow.askClarification(taskId, {
      ...clarification,
      workerId: this.config.workerId,
      ...(threadId ? { threadId } : {}),
    });
    await this.taskTracker.setStatus(taskId, "awaiting_human", "Waiting for human clarification.");
    await this.workflow.recordTaskStep(taskId, {
      kind: "analyze",
      status: "done",
      outputSummary: clarification.summary,
    });
    await this.recordWorkflowEvent(context, taskId, {
      type: "clarification_requested",
      status: "warning",
      message: clarification.summary,
      details: {
        blockingReason: clarification.blockingReason,
        question: clarification.question,
      },
    });
  }

  private async pauseForManualHold(
    context: InternalExecutionContext,
    taskId: string,
    decision: TaskAnalysisDecision,
  ): Promise<void> {
    await this.taskTracker.setStatus(taskId, "awaiting_human", `Manual hold after analysis: ${decision.reasoning}`);
    await this.recordWorkflowEvent(context, taskId, {
      type: "manual_hold",
      status: "warning",
      message: decision.reasoning,
      details: {
        confidence: decision.confidence,
        taskType: decision.taskType,
        promptProfileId: decision.promptProfileId,
      },
    });
  }

  private async runDecomposition(
    context: InternalExecutionContext,
    taskId: string,
    issue: TrackerIssue,
    comments: CommentWithMetadata[],
    analysisDecision: TaskAnalysisDecision,
    threadId?: string,
  ): Promise<CycleOutcome> {
    await this.taskTracker.setStatus(taskId, "decomposing", "Internal task decomposition started.");
    await this.workflow.recordTaskStep(taskId, { kind: "plan", status: "running" });
    await this.recordWorkflowEvent(context, taskId, {
      type: "decomposition_started",
      status: "info",
      message: "Task decomposition started.",
    });
    const maxSubtasks =
      context.config.decompositionMaxSubtasks ?? DEFAULT_DECOMPOSITION_MAX_SUBTASKS;
    const defaultSubtaskTag =
      context.config.decompositionDefaultSubtaskTag ?? DEFAULT_DECOMPOSITION_SUBTASK_TAG;
    const titlePrefix =
      context.config.decompositionSubtaskTitlePrefix ?? DEFAULT_DECOMPOSITION_TITLE_PREFIX;
    const prompt = buildDecompositionPrompt(
      issue,
      comments,
      { maxSubtasks, defaultSubtaskTag, titlePrefix },
      analysisDecision,
    );
    const execution = await this.runCodexStage(context, taskId, "decomposition", () =>
      threadId ? context.codex.runResume(threadId, prompt) : context.codex.runInitial(prompt),
    );
    const plan = parseDecompositionPlan(execution.finalMessage, {
      parentIssueKey: issue.key,
      maxSubtasks,
    });
    if (!plan) {
      await this.workflow.recordTaskStep(taskId, {
        kind: "plan",
        status: "failed",
        failureKind: "invalid_decomposition",
        diagnostic: execution.process.stderr.trim() || "Invalid AI_DECOMPOSITION output.",
      });
      await this.pauseForManualHold(context, taskId, analysisDecision);
      return "waiting";
    }
    await this.workflow.recordDecomposition(taskId, plan);
    const children = await this.workflow.createChildTasks(
      taskId,
      plan.subtasks.map((subtask) => ({
        ...subtask,
        title: `${titlePrefix} ${subtask.title}`,
        description: formatSubtaskDescription(issue.key, subtask),
        tags: [...new Set([...subtask.tags, defaultSubtaskTag])],
      })),
    );
    for (const child of children) {
      await this.workflow.linkDependency({
        fromTaskId: taskId,
        toTaskId: child.id,
        kind: "parent_child",
        reason: "Created by internal task decomposition.",
      });
    }
    const temporaryIdToTaskId = new Map(
      plan.subtasks.map((subtask, index) => [subtask.temporaryId, children[index]?.id]),
    );
    for (const dependency of plan.dependencies) {
      const blockedTaskId = temporaryIdToTaskId.get(dependency.blockedTaskTemporaryId);
      const blockingTaskId = temporaryIdToTaskId.get(dependency.blockingTaskTemporaryId);
      if (blockedTaskId && blockingTaskId) {
        await this.workflow.linkDependency({
          fromTaskId: blockedTaskId,
          toTaskId: blockingTaskId,
          kind: "blocked_by",
          reason: dependency.reason,
        });
      }
    }
    await this.workflow.recordTaskStep(taskId, {
      kind: "plan",
      status: "done",
      outputSummary: `Created ${children.length} internal child tasks.`,
    });
    await this.recordWorkflowEvent(context, taskId, {
      type: "decomposition_completed",
      status: "info",
      message: `Created ${children.length} internal child tasks.`,
      details: { childTaskIds: children.map((child) => child.id) },
    });
    await this.pauseForManualHold(context, taskId, analysisDecision);
    return "waiting";
  }

  private async validateRepositoryState(
    context: InternalExecutionContext,
    taskId: string,
  ): Promise<ValidationResult> {
    await this.recordWorkflowEvent(context, taskId, {
      type: "validation_started",
      status: "info",
      message: "Validation started.",
    });
    const changed = (await context.git.hasChanges()) || (await context.git.hasDiffFromBase());
    if (!changed) {
      const validation: ValidationResult = {
        changed: false,
        testsPassed: false,
        lintPassed: false,
        gates: [],
        diagnostic: "No repository changes detected.",
      };
      await this.workflow.recordValidation(taskId, {
        workerId: this.config.workerId,
        validation,
        status: "failed",
        summary: this.formatValidationSummary(validation),
      });
      return validation;
    }
    const gates = await runQualityGates(context.config, {
      cwd: context.config.repoPath,
      logger: this.logger,
    });
    const validation: ValidationResult = {
      changed: true,
      testsPassed: qualityGateStatus(gates, "tests") === "passed",
      lintPassed: qualityGateStatus(gates, "lint") === "passed",
      gates,
      diagnostic: formatQualityGateDiagnostics(gates),
    };
    this.recordValidationResults(context, taskId, validation);
    await this.workflow.recordValidation(taskId, {
      workerId: this.config.workerId,
      validation,
      status: qualityGatesPassed(gates) ? "passed" : "failed",
      summary: this.formatValidationSummary(validation),
    });
    return validation;
  }

  private async publishExisting(
    context: InternalExecutionContext,
    taskId: string,
    branch: string,
    mergeRequest: MergeRequestInfo,
  ): Promise<void> {
    await this.workflow.recordMergeRequest(taskId, {
      workerId: this.config.workerId,
      mergeRequest,
      branch,
      outcome: "reused",
    });
    await this.taskTracker.setStatus(taskId, "review", `Merge Request ready: ${mergeRequest.url}`);
    this.telemetry.recordMergeRequest({
      workerId: this.config.workerId,
      repositoryName: context.profile.name,
      issueKey: taskId,
      branch,
      mergeRequestUrl: mergeRequest.url,
      mergeRequestIid: mergeRequest.iid,
      outcome: "reused",
    });
  }

  private async publish(
    context: InternalExecutionContext,
    taskId: string,
    issue: TrackerIssue,
    branch: string,
    existingMr: MergeRequestInfo | null,
    validation: ValidationResult,
    implementationSummary?: string,
  ): Promise<void> {
    await this.recordWorkflowEvent(context, taskId, {
      type: "publish_started",
      status: "info",
      message: "Publishing internal task result.",
      details: { branch },
    });
    if (await context.git.hasChanges()) {
      const changedFiles = await context.git.getChangedFilesFromBase();
      await context.git.commit(
        buildCommitMessage({ issue, changedFiles, summary: implementationSummary }),
      );
    }
    await context.git.push(branch);
    const changedFiles = await context.git.getChangedFilesFromBase();
    let mergeRequest = existingMr ?? (await context.gitlab.findOpenMergeRequestByBranch(branch));
    const outcome: "created" | "reused" = mergeRequest ? "reused" : "created";
    const validationSummary = this.formatValidationSummary(validation);
    if (!mergeRequest) {
      mergeRequest = await context.gitlab.createMergeRequest({
        sourceBranch: branch,
        targetBranch: context.config.baseBranch,
        title: `[AI] ${taskId} implementation`,
        description: buildMergeRequestDescription({
          issue,
          sourceBranch: branch,
          targetBranch: context.config.baseBranch,
          changedFiles,
          validationSummary,
          validationNotes: collectQualityGateNotes(validation.gates),
          workerId: this.config.workerId,
          codexSummary: implementationSummary,
        }),
      });
    }
    await this.workflow.recordMergeRequest(taskId, {
      workerId: this.config.workerId,
      mergeRequest,
      branch,
      outcome,
      validationSummary,
    });
    await this.taskTracker.setStatus(taskId, "review", `Merge Request ready: ${mergeRequest.url}`);
    this.telemetry.recordMergeRequest({
      workerId: this.config.workerId,
      repositoryName: context.profile.name,
      issueKey: taskId,
      branch,
      mergeRequestUrl: mergeRequest.url,
      mergeRequestIid: mergeRequest.iid,
      outcome,
    });
  }

  private async runCodexStage(
    context: InternalExecutionContext,
    taskId: string,
    stage: "analysis" | "implementation" | "decomposition" | "review_fix",
    run: () => Promise<CodexExecution>,
  ): Promise<CodexExecution> {
    const startedAt = new Date().toISOString();
    await this.recordWorkflowEvent(context, taskId, {
      type: `${stage}_started` as TaskEventType,
      status: "info",
      message: `Codex ${stage} started.`,
    });
    const startedMs = Date.now();
    const execution = await run();
    const completedAt = new Date().toISOString();
    this.telemetry.recordCodexRun({
      workerId: this.config.workerId,
      repositoryName: context.profile.name,
      issueKey: taskId,
      stage,
      durationMs: Date.now() - startedMs,
      exitCode: execution.process.exitCode,
      timedOut: execution.process.timedOut,
    });
    await this.workflow.recordAgentRun(taskId, {
      workerId: this.config.workerId,
      stage,
      status: execution.process.exitCode === 0 ? "completed" : "failed",
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      exitCode: execution.process.exitCode,
      ...(execution.process.timedOut !== undefined ? { timedOut: execution.process.timedOut } : {}),
      ...(execution.finalMessage ? { finalMessage: execution.finalMessage } : {}),
      ...(execution.process.stderr.trim() ? { diagnostic: execution.process.stderr.trim() } : {}),
      startedAt,
      completedAt,
    });
    await this.recordWorkflowEvent(context, taskId, {
      type: `${stage}_completed` as TaskEventType,
      status: execution.process.exitCode === 0 ? "info" : "warning",
      message: `Codex ${stage} completed.`,
      details: {
        exitCode: execution.process.exitCode,
        timedOut: execution.process.timedOut,
      },
    });
    return execution;
  }

  private async runResumeOrInitial(
    context: InternalExecutionContext,
    issue: TrackerIssue,
    threadId: string | undefined,
    resumePrompt: string,
    fallbackPrompt: string,
  ): Promise<CodexExecution> {
    if (!threadId) {
      return context.codex.runInitial(fallbackPrompt);
    }
    const execution = await context.codex.runResume(threadId, resumePrompt);
    if (execution.process.exitCode === 0 || execution.clarification) {
      return execution;
    }
    this.logger.warn("Codex resume failed, falling back to a fresh internal session.", {
      taskId: issue.key,
      threadId,
      exitCode: execution.process.exitCode,
      stderr: execution.process.stderr,
    });
    return context.codex.runInitial(fallbackPrompt);
  }

  private async buildMemoryContext(
    context: InternalExecutionContext,
    input: {
      taskId: string;
      issue: TrackerIssue;
      taskType: TaskAnalysisDecision["taskType"];
      promptProfileId: string;
      expectedFiles: string[];
      extraTags?: string[];
    },
  ): Promise<PromptContextBundle | undefined> {
    const memoryConfig = context.config.memory;
    if (!memoryConfig?.enabled || !this.memoryStore) {
      return undefined;
    }
    const bundle = await buildPromptContextBundle({
      store: this.memoryStore,
      repositoryName: context.profile.name,
      taskType: input.taskType,
      promptProfileId: input.promptProfileId,
      expectedFiles: input.expectedFiles,
      tags: [
        ...(input.issue.tags ?? []),
        ...(input.issue.components ?? []),
        ...(input.extraTags ?? []),
      ],
      contextBudgetChars: memoryConfig.maxContextChars,
      includeDraftRules: memoryConfig.includeDraftRules,
      similarFailureLimit: memoryConfig.similarFailureLimit,
    });
    await this.workflow.recordMemoryContext(input.taskId, {
      workerId: this.config.workerId,
      promptProfileId: input.promptProfileId,
      taskType: input.taskType,
      knowledgeSectionIds: bundle.knowledgeSections.map((section) => section.id),
      promptRuleIds: bundle.promptRules.map((rule) => rule.id),
      similarFailureCount: bundle.similarFailures.length,
    });
    return bundle;
  }

  private async recordFailureMemory(
    context: InternalExecutionContext,
    input: {
      issue: TrackerIssue;
      failureKind: string;
      diagnostic: string;
      promptProfile?: PromptProfile;
      analysisDecision?: TaskAnalysisDecision;
    },
  ): Promise<void> {
    if (!context.config.memory?.enabled || !this.memoryStore) {
      return;
    }
    let affectedFiles: string[] = [];
    try {
      affectedFiles = await context.git.getChangedFilesFromBase();
    } catch (error) {
      this.logger.warn("Unable to collect changed files for internal failure memory.", {
        taskId: input.issue.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const entry: FailureMemoryEntry = {
      repositoryName: context.profile.name,
      issueKey: input.issue.key,
      taskType:
        input.analysisDecision?.taskType ??
        input.promptProfile?.taskType ??
        "unknown",
      promptProfileId:
        input.analysisDecision?.promptProfileId ??
        input.promptProfile?.id ??
        "general",
      failureKind: input.failureKind,
      diagnosticSummary:
        input.diagnostic.length > 4000
          ? `${input.diagnostic.slice(0, 4000)}\n[diagnostic truncated]`
          : input.diagnostic,
      affectedFiles,
      tags: [
        ...(input.issue.tags ?? []),
        ...(input.issue.components ?? []),
        ...(input.analysisDecision?.expectedSubsystems ?? []),
      ],
      createdAt: new Date().toISOString(),
    };
    await this.memoryStore.appendFailure(entry);
  }

  private recordValidationResults(
    context: InternalExecutionContext,
    taskId: string,
    validation: ValidationResult,
  ): void {
    for (const gate of validation.gates) {
      this.telemetry.recordValidationGate({
        workerId: this.config.workerId,
        repositoryName: context.profile.name,
        issueKey: taskId,
        gate: gate.id,
        status: gate.status,
        ...(gate.durationMs !== undefined ? { durationMs: gate.durationMs } : {}),
        ...(gate.status === "failed" ? { diagnostic: gate.diagnostic } : {}),
      });
    }
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

  private async finalizeFailure(
    context: InternalExecutionContext,
    taskId: string,
    diagnostic: string,
  ): Promise<void> {
    await this.recordWorkflowEvent(context, taskId, {
      type: "task_failed",
      status: "error",
      message: diagnostic,
    });
    try {
      await this.taskTracker.setStatus(taskId, "failed", diagnostic);
    } catch (error) {
      this.logger.warn("Unable to move internal task to failed status.", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordWorkflowEvent(
    context: InternalExecutionContext,
    taskId: string,
    event: {
      type: TaskEventType;
      status: "info" | "warning" | "error";
      message: string;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    this.telemetry.recordEvent({
      workerId: this.config.workerId,
      repositoryName: context.profile.name,
      issueKey: taskId,
      type: event.type,
      status: event.status,
      message: event.message,
      details: event.details,
    });
    await this.workflow.recordLifecycleEvent(taskId, {
      kind: event.type,
      source: "worker_agent",
      actor: { owner: "worker_agent", id: this.config.workerId },
      message: event.message,
      payload: {
        status: event.status,
        ...(event.details ? { details: event.details } : {}),
      },
    });
  }

  private taskContext(
    context: InternalExecutionContext,
    taskId: string,
  ): TaskTelemetryContext {
    return {
      workerId: this.config.workerId,
      repositoryName: context.profile.name,
      issueKey: taskId,
    };
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
