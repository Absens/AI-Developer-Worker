import type {
  AgentRunInput,
  ClaimReviewTaskInput,
  ClaimTaskInput,
  ClaimedTask,
  ClarificationQuestionInput,
  HumanAnswerInput,
  LeaseHeartbeatInput,
  LinkTaskDependencyInput,
  MemoryContextRecordInput,
  MergeRequestRecordInput,
  ReleaseLeaseInput,
  ReviewMetadataRecordInput,
  TaskEventInput,
  TaskStepRecordInput,
  TaskTrackerClient,
  ValidationRecordInput,
} from "./types.js";
import type {
  DecompositionPlan,
  SubtaskDraft,
  TaskAnalysisDecision,
} from "../../models/types.js";

const requireNonEmpty = (value: string | undefined, field: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} is required.`);
  }
  return trimmed;
};

const requireArray = <T>(value: readonly T[] | undefined, field: string): readonly T[] => {
  if (!value || value.length === 0) {
    throw new Error(`${field} must contain at least one item.`);
  }
  return value;
};

export class AgentWorkflowService {
  constructor(private readonly tracker: TaskTrackerClient) {}

  async claimTask(input: ClaimTaskInput): Promise<ClaimedTask | null> {
    requireNonEmpty(input.workerId, "workerId");
    requireArray(input.repositoryProfiles, "repositoryProfiles");
    if (!Number.isFinite(input.leaseTtlSeconds) || input.leaseTtlSeconds <= 0) {
      throw new Error("leaseTtlSeconds must be a positive number.");
    }
    return this.tracker.claimNextTask(input);
  }

  async claimReviewTask(input: ClaimReviewTaskInput): Promise<ClaimedTask | null> {
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.taskId, "taskId");
    requireArray(input.repositoryProfiles, "repositoryProfiles");
    if (!Number.isFinite(input.leaseTtlSeconds) || input.leaseTtlSeconds <= 0) {
      throw new Error("leaseTtlSeconds must be a positive number.");
    }
    return this.tracker.claimReviewTask(input);
  }

  async recordLifecycleEvent(taskId: string, input: TaskEventInput): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(input.kind, "kind");
    await this.tracker.appendEvent(taskId, input);
  }

  async recordAnalysisDecision(
    taskId: string,
    decision: TaskAnalysisDecision,
  ): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(decision.promptProfileId, "decision.promptProfileId");
    await this.tracker.recordAnalysis(taskId, decision);
  }

  async recordTaskStep(taskId: string, input: TaskStepRecordInput): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    await this.tracker.recordTaskStep(taskId, input);
  }

  async askClarification(
    taskId: string,
    question: ClarificationQuestionInput,
  ): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(question.question, "question.question");
    await this.tracker.askClarification(taskId, question);
  }

  async recordHumanAnswer(taskId: string, input: HumanAnswerInput): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(input.body, "body");
    await this.tracker.recordHumanAnswer(taskId, input);
  }

  async recordAgentRun(taskId: string, input: AgentRunInput): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(input.workerId, "workerId");
    await this.tracker.recordAgentRun(taskId, input);
  }

  async recordValidation(taskId: string, input: ValidationRecordInput): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(input.workerId, "workerId");
    await this.tracker.recordValidation(taskId, input);
  }

  async recordMergeRequest(
    taskId: string,
    input: MergeRequestRecordInput,
  ): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.branch, "branch");
    requireNonEmpty(input.mergeRequest.url, "mergeRequest.url");
    await this.tracker.recordMergeRequest(taskId, input);
  }

  async recordReviewMetadata(
    taskId: string,
    input: ReviewMetadataRecordInput,
  ): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    await this.tracker.recordReviewMetadata(taskId, input);
  }

  async recordDecomposition(taskId: string, plan: DecompositionPlan): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireArray(plan.subtasks, "plan.subtasks");
    await this.tracker.recordDecomposition(taskId, plan);
  }

  async createChildTasks(taskId: string, subtasks: SubtaskDraft[]) {
    requireNonEmpty(taskId, "taskId");
    requireArray(subtasks, "subtasks");
    return this.tracker.createChildTasks(taskId, subtasks);
  }

  async linkDependency(input: LinkTaskDependencyInput): Promise<void> {
    requireNonEmpty(input.fromTaskId, "fromTaskId");
    requireNonEmpty(input.toTaskId, "toTaskId");
    await this.tracker.linkDependency(input);
  }

  async recordMemoryContext(
    taskId: string,
    input: MemoryContextRecordInput,
  ): Promise<void> {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(input.workerId, "workerId");
    await this.tracker.recordMemoryContext(taskId, input);
  }

  async heartbeatLease(
    leaseId: string,
    input: LeaseHeartbeatInput,
  ) {
    requireNonEmpty(leaseId, "leaseId");
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.token, "token");
    return this.tracker.heartbeatLease(leaseId, input);
  }

  async releaseLease(leaseId: string, input: ReleaseLeaseInput): Promise<void> {
    requireNonEmpty(leaseId, "leaseId");
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.token, "token");
    await this.tracker.releaseLease(leaseId, input);
  }
}
