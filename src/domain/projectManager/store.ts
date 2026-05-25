import { randomUUID } from "node:crypto";

import { buildProjectGoalDuplicateSignature } from "./goalPolicy.js";
import type {
  ApproveProjectGoalInput,
  CreateProjectGoalsFromAnalysisInput,
  LinkProjectGoalTaskInput,
  ListProjectGoalsInput,
  MarkProjectGoalStaleInput,
  ParsedProjectAnalysis,
  ProjectAnalysis,
  ProjectGoal,
  ProjectGoalAuditEvent,
  ProjectGoalTaskLink,
  ProjectManagerRun,
  ProjectManagerTrigger,
  RejectProjectGoalInput,
} from "./types.js";
import { isTerminalProjectGoalStatus } from "./types.js";

export interface StartProjectManagerRunInput {
  repositoryName: string;
  trigger: ProjectManagerTrigger;
}

export interface CompleteProjectManagerRunInput {
  analysisId?: string;
  proposedGoalIds?: string[];
  proposedTaskIds?: string[];
}

export interface RecordProjectAnalysisInput extends ParsedProjectAnalysis {
  repositoryName: string;
}

export interface ProjectManagerStore {
  startRun(input: StartProjectManagerRunInput): Promise<ProjectManagerRun>;
  completeRun(
    runId: string,
    input: CompleteProjectManagerRunInput,
  ): Promise<ProjectManagerRun>;
  failRun(runId: string, diagnostic: string): Promise<ProjectManagerRun>;
  recordAnalysis(input: RecordProjectAnalysisInput): Promise<ProjectAnalysis>;
  listRuns(): Promise<ProjectManagerRun[]>;
  listAnalyses(): Promise<ProjectAnalysis[]>;
  createGoalsFromAnalysis(
    input: CreateProjectGoalsFromAnalysisInput,
  ): Promise<ProjectGoal[]>;
  listGoals(input?: ListProjectGoalsInput): Promise<ProjectGoal[]>;
  getGoal(goalId: string): Promise<ProjectGoal>;
  approveGoal(
    goalId: string,
    input: ApproveProjectGoalInput,
  ): Promise<ProjectGoal>;
  rejectGoal(
    goalId: string,
    input: RejectProjectGoalInput,
  ): Promise<ProjectGoal>;
  markGoalStale(
    goalId: string,
    input: MarkProjectGoalStaleInput,
  ): Promise<ProjectGoal>;
  listGoalEvents(goalId: string): Promise<ProjectGoalAuditEvent[]>;
  linkGoalTask(input: LinkProjectGoalTaskInput): Promise<ProjectGoalTaskLink>;
  listGoalTaskLinks(goalId: string): Promise<ProjectGoalTaskLink[]>;
}

export interface InMemoryProjectManagerStoreInput {
  now?: () => Date;
}

export class InMemoryProjectManagerStore implements ProjectManagerStore {
  private readonly now: () => Date;
  private readonly runs = new Map<string, ProjectManagerRun>();
  private readonly analyses = new Map<string, ProjectAnalysis>();
  private readonly goals = new Map<string, ProjectGoal>();
  private readonly goalEvents = new Map<string, ProjectGoalAuditEvent[]>();
  private readonly goalTaskLinks = new Map<string, ProjectGoalTaskLink>();

  public constructor(input: InMemoryProjectManagerStoreInput = {}) {
    this.now = input.now ?? (() => new Date());
  }

  public async startRun(
    input: StartProjectManagerRunInput,
  ): Promise<ProjectManagerRun> {
    const run: ProjectManagerRun = {
      id: `pm_run_${randomUUID()}`,
      repositoryName: input.repositoryName,
      trigger: input.trigger,
      status: "started",
      proposedGoalIds: [],
      proposedTaskIds: [],
      startedAt: this.now().toISOString(),
    };
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  public async completeRun(
    runId: string,
    input: CompleteProjectManagerRunInput,
  ): Promise<ProjectManagerRun> {
    const existing = this.requireRun(runId);
    const completed: ProjectManagerRun = {
      ...existing,
      status: "completed",
      ...(input.analysisId ? { analysisId: input.analysisId } : {}),
      proposedGoalIds: input.proposedGoalIds ?? existing.proposedGoalIds,
      proposedTaskIds: input.proposedTaskIds ?? existing.proposedTaskIds,
      completedAt: this.now().toISOString(),
    };
    this.runs.set(runId, structuredClone(completed));
    return structuredClone(completed);
  }

  public async failRun(
    runId: string,
    diagnostic: string,
  ): Promise<ProjectManagerRun> {
    const existing = this.requireRun(runId);
    const failed: ProjectManagerRun = {
      ...existing,
      status: "failed",
      diagnostic,
      completedAt: this.now().toISOString(),
    };
    this.runs.set(runId, structuredClone(failed));
    return structuredClone(failed);
  }

  public async recordAnalysis(
    input: RecordProjectAnalysisInput,
  ): Promise<ProjectAnalysis> {
    const analysis: ProjectAnalysis = {
      id: `pm_analysis_${randomUUID()}`,
      repositoryName: input.repositoryName,
      summary: input.summary,
      healthSignals: input.healthSignals,
      proposedGoals: input.proposedGoals,
      staleGoalIds: input.staleGoalIds,
      ...(input.replanReason ? { replanReason: input.replanReason } : {}),
      createdAt: this.now().toISOString(),
    };
    this.analyses.set(analysis.id, structuredClone(analysis));
    return structuredClone(analysis);
  }

  public async listRuns(): Promise<ProjectManagerRun[]> {
    return structuredClone([...this.runs.values()]);
  }

  public async listAnalyses(): Promise<ProjectAnalysis[]> {
    return structuredClone([...this.analyses.values()]);
  }

  public async createGoalsFromAnalysis(
    input: CreateProjectGoalsFromAnalysisInput,
  ): Promise<ProjectGoal[]> {
    const createdGoals: ProjectGoal[] = [];

    for (const draft of input.goals) {
      const duplicateSignature = buildProjectGoalDuplicateSignature({
        repositoryName: input.repositoryName,
        title: draft.title,
        evidenceRefs: draft.evidenceRefs,
      });
      if (this.hasActiveDuplicate(input.repositoryName, duplicateSignature)) {
        continue;
      }

      const goal: ProjectGoal = {
        id: `pm_goal_${randomUUID()}`,
        analysisId: input.analysisId,
        repositoryName: input.repositoryName,
        status: "proposed",
        title: draft.title,
        problemStatement: draft.problemStatement,
        desiredOutcome: draft.desiredOutcome,
        successMetrics: structuredClone(draft.successMetrics),
        evidenceRefs: structuredClone(draft.evidenceRefs),
        priority: draft.priority,
        riskLevel: draft.riskLevel,
        suggestedTaskProposals: structuredClone(draft.suggestedTaskProposals),
        duplicateSignature,
        createdAt: this.now().toISOString(),
      };
      this.goals.set(goal.id, structuredClone(goal));
      this.appendGoalEvent(goal.id, {
        kind: "project_goal_created",
        payload: {
          analysisId: input.analysisId,
          repositoryName: input.repositoryName,
        },
      });
      createdGoals.push(structuredClone(goal));
    }

    return createdGoals;
  }

  public async listGoals(
    input: ListProjectGoalsInput = {},
  ): Promise<ProjectGoal[]> {
    const statuses = input.status
      ? new Set(Array.isArray(input.status) ? input.status : [input.status])
      : undefined;

    const goals = [...this.goals.values()].filter((goal) => {
      if (input.repositoryName && goal.repositoryName !== input.repositoryName) {
        return false;
      }
      if (input.analysisId && goal.analysisId !== input.analysisId) {
        return false;
      }
      if (statuses && !statuses.has(goal.status)) {
        return false;
      }
      return true;
    });

    return structuredClone(goals);
  }

  public async getGoal(goalId: string): Promise<ProjectGoal> {
    return this.requireGoal(goalId);
  }

  public async approveGoal(
    goalId: string,
    input: ApproveProjectGoalInput,
  ): Promise<ProjectGoal> {
    const existing = this.requireGoal(goalId);
    this.requireGoalStatus(existing, "proposed", "approve");

    const approved: ProjectGoal = {
      ...existing,
      status: "approved",
      approvedBy: input.approvedBy,
      approvedAt: this.now().toISOString(),
    };
    this.goals.set(goalId, structuredClone(approved));
    this.appendGoalEvent(goalId, {
      kind: "project_goal_approved",
      actor: input.approvedBy,
    });
    return structuredClone(approved);
  }

  public async rejectGoal(
    goalId: string,
    input: RejectProjectGoalInput,
  ): Promise<ProjectGoal> {
    const existing = this.requireGoal(goalId);
    this.requireGoalStatus(existing, "proposed", "reject");

    const rejected: ProjectGoal = {
      ...existing,
      status: "rejected",
      rejectedBy: input.rejectedBy,
      rejectedAt: this.now().toISOString(),
      rejectionReason: input.rejectionReason,
    };
    this.goals.set(goalId, structuredClone(rejected));
    this.appendGoalEvent(goalId, {
      kind: "project_goal_rejected",
      actor: input.rejectedBy,
      message: input.rejectionReason,
    });
    return structuredClone(rejected);
  }

  public async markGoalStale(
    goalId: string,
    input: MarkProjectGoalStaleInput,
  ): Promise<ProjectGoal> {
    const existing = this.requireGoal(goalId);
    const allowedStatuses: ProjectGoal["status"][] = [
      "proposed",
      "approved",
      "active",
    ];
    if (!allowedStatuses.includes(existing.status)) {
      throw new Error(
        `Cannot mark project goal stale from status ${existing.status}`,
      );
    }

    const stale: ProjectGoal = {
      ...existing,
      status: "stale",
      staleAt: this.now().toISOString(),
      staleReason: input.staleReason,
    };
    this.goals.set(goalId, structuredClone(stale));
    this.appendGoalEvent(goalId, {
      kind: "project_goal_stale",
      message: input.staleReason,
    });
    return structuredClone(stale);
  }

  public async listGoalEvents(
    goalId: string,
  ): Promise<ProjectGoalAuditEvent[]> {
    this.requireGoal(goalId);
    return structuredClone(this.goalEvents.get(goalId) ?? []);
  }

  public async linkGoalTask(
    input: LinkProjectGoalTaskInput,
  ): Promise<ProjectGoalTaskLink> {
    this.requireGoal(input.goalId);
    const existing = [...this.goalTaskLinks.values()].find(
      (link) =>
        link.goalId === input.goalId &&
        link.taskId === input.taskId &&
        link.linkType === input.linkType,
    );
    if (existing) {
      return structuredClone(existing);
    }

    const link: ProjectGoalTaskLink = {
      id: `pm_goal_task_link_${randomUUID()}`,
      goalId: input.goalId,
      taskId: input.taskId,
      linkType: input.linkType,
      createdAt: this.now().toISOString(),
    };
    this.goalTaskLinks.set(link.id, structuredClone(link));
    return structuredClone(link);
  }

  public async listGoalTaskLinks(
    goalId: string,
  ): Promise<ProjectGoalTaskLink[]> {
    this.requireGoal(goalId);
    return structuredClone(
      [...this.goalTaskLinks.values()].filter((link) => link.goalId === goalId),
    );
  }

  private requireRun(runId: string): ProjectManagerRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Project manager run not found: ${runId}`);
    }
    return structuredClone(run);
  }

  private requireGoal(goalId: string): ProjectGoal {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new Error(`Project manager goal not found: ${goalId}`);
    }
    return structuredClone(goal);
  }

  private requireGoalStatus(
    goal: ProjectGoal,
    expectedStatus: ProjectGoal["status"],
    action: string,
  ): void {
    if (goal.status !== expectedStatus) {
      throw new Error(
        `Cannot ${action} project goal from status ${goal.status}`,
      );
    }
  }

  private hasActiveDuplicate(
    repositoryName: string,
    duplicateSignature: string,
  ): boolean {
    return [...this.goals.values()].some(
      (goal) =>
        goal.repositoryName === repositoryName &&
        goal.duplicateSignature === duplicateSignature &&
        !isTerminalProjectGoalStatus(goal.status),
    );
  }

  private appendGoalEvent(
    goalId: string,
    input: Pick<ProjectGoalAuditEvent, "kind"> &
      Partial<Pick<ProjectGoalAuditEvent, "actor" | "message" | "payload">>,
  ): void {
    const event: ProjectGoalAuditEvent = {
      id: `pm_goal_event_${randomUUID()}`,
      goalId,
      kind: input.kind,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.payload ? { payload: structuredClone(input.payload) } : {}),
      createdAt: this.now().toISOString(),
    };
    const existingEvents = this.goalEvents.get(goalId) ?? [];
    this.goalEvents.set(goalId, [...existingEvents, structuredClone(event)]);
  }
}
