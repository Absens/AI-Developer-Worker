import { createHash } from "node:crypto";

import type { AutonomyLevel } from "../../models/types.js";
import type {
  EvidenceRef,
  ProposeTaskInput,
} from "../taskTracker/types.js";
import type {
  ProjectGoal,
  ProjectManagerConfig,
  ProjectTaskProposalDraft,
} from "./types.js";

export const PROJECT_MANAGER_PROPOSED_TASK_LINK_TYPE = "proposed_task";
export const PROJECT_MANAGER_TASK_PROPOSAL_POLICY = "project_manager_goal_policy";
export const PROJECT_MANAGER_TASK_PROPOSAL_ACTOR = "project_manager_agent";

export interface ProjectGoalTaskProposalBuilderConfig {
  maxTaskProposalsPerGoal?: ProjectManagerConfig["maxTaskProposalsPerGoal"];
  defaultAutonomyLevel?: ProjectManagerConfig["defaultAutonomyLevel"];
}

export interface BuildProjectGoalTaskProposalInputsInput {
  goal: ProjectGoal;
  config?: ProjectGoalTaskProposalBuilderConfig;
  proposedBy?: string;
}

const DEFAULT_MAX_TASK_PROPOSALS_PER_GOAL = 5;

const evidenceIdentity = (ref: EvidenceRef): string =>
  `${ref.kind}:${ref.ref.trim().toLowerCase()}`;

const dedupeEvidenceRefs = (refs: readonly EvidenceRef[]): EvidenceRef[] => {
  const seen = new Set<string>();
  const deduped: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = evidenceIdentity(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ ...ref });
  }
  return deduped;
};

const projectManagerRef = (
  kind: "goal" | "analysis" | "run",
  id: string,
  summary: string,
): EvidenceRef => ({
  kind: "external_url",
  ref: `urn:project-manager:${kind}:${id}`,
  summary,
});

const boundedProposalCount = (
  config: ProjectGoalTaskProposalBuilderConfig | undefined,
): number => {
  const configured =
    config?.maxTaskProposalsPerGoal ?? DEFAULT_MAX_TASK_PROPOSALS_PER_GOAL;
  if (!Number.isFinite(configured)) {
    return DEFAULT_MAX_TASK_PROPOSALS_PER_GOAL;
  }
  return Math.max(0, Math.floor(configured));
};

const autonomyLevelFor = (
  goal: ProjectGoal,
  config: ProjectGoalTaskProposalBuilderConfig | undefined,
): AutonomyLevel => {
  if (goal.riskLevel === "high") {
    return "proposal_only";
  }
  return config?.defaultAutonomyLevel ?? "proposal_only";
};

const proposalReasonFor = (goal: ProjectGoal): string =>
  [
    `Project goal: ${goal.title}`,
    `Problem: ${goal.problemStatement}`,
    `Desired outcome: ${goal.desiredOutcome}`,
    goal.successMetrics.length > 0
      ? `Success metrics: ${goal.successMetrics.join("; ")}`
      : undefined,
    `Priority: ${goal.priority}`,
    `Risk level: ${goal.riskLevel}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

const stableDraftHash = (
  goal: ProjectGoal,
  draft: ProjectTaskProposalDraft,
): string => {
  const evidenceRefs = draft.evidenceRefs
    .map(evidenceIdentity)
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        goalId: goal.id,
        title: draft.title.trim(),
        description: draft.description.trim(),
        taskType: draft.taskType,
        acceptanceCriteria: draft.acceptanceCriteria,
        expectedBlastRadius: draft.expectedBlastRadius?.trim(),
        evidenceRefs,
      }),
    )
    .digest("hex")
    .slice(0, 16);
};

const evidenceRefsFor = (
  goal: ProjectGoal,
  draft: ProjectTaskProposalDraft,
): EvidenceRef[] =>
  dedupeEvidenceRefs([
    ...goal.evidenceRefs,
    projectManagerRef(
      "goal",
      goal.id,
      `Project Manager goal: ${goal.title}`,
    ),
    projectManagerRef(
      "analysis",
      goal.sourceAnalysisId,
      `Project Manager analysis for goal ${goal.id}`,
    ),
    ...(goal.sourceRunId
      ? [
          projectManagerRef(
            "run",
            goal.sourceRunId,
            `Project Manager run for goal ${goal.id}`,
          ),
        ]
      : []),
    ...draft.evidenceRefs,
  ]);

export const buildProjectGoalTaskProposalInputs = (
  input: BuildProjectGoalTaskProposalInputsInput,
): ProposeTaskInput[] => {
  const maxProposals = boundedProposalCount(input.config);
  const drafts = input.goal.suggestedTaskProposals.slice(0, maxProposals);
  const autonomyLevel = autonomyLevelFor(input.goal, input.config);

  return drafts.map((draft, index) => ({
    source: "ai_proposal",
    proposedBy: input.proposedBy ?? PROJECT_MANAGER_TASK_PROPOSAL_ACTOR,
    repositoryName: input.goal.repositoryName,
    title: draft.title,
    description: draft.description,
    proposalReason: proposalReasonFor(input.goal),
    evidenceRefs: evidenceRefsFor(input.goal, draft),
    suggestedAcceptanceCriteria: [...draft.acceptanceCriteria],
    taskType: draft.taskType,
    riskFactors: [`Project goal risk level: ${input.goal.riskLevel}`],
    ...(draft.expectedBlastRadius
      ? { expectedBlastRadius: draft.expectedBlastRadius }
      : {}),
    autonomyLevel,
    approvalPolicy: PROJECT_MANAGER_TASK_PROPOSAL_POLICY,
    idempotencyKey: [
      "pm-goal-task",
      input.goal.id,
      index,
      stableDraftHash(input.goal, draft),
    ].join(":"),
    priority: input.goal.priority,
  }));
};
