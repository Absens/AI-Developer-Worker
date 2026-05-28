import type { EvidenceRef } from "../taskTracker/types.js";
import { PROJECT_GOAL_PRIORITIES, PROJECT_GOAL_RISK_LEVELS } from "./types.js";
import type {
  ParsedProjectAnalysis,
  ParsedProjectStrategyAnalysis,
  ProjectGoalReplanClassification,
  ProjectGoalDraft,
  ProjectGoalPriority,
  ProjectGoalRiskLevel,
  ProjectHealthSignal,
  ProjectManagerConfig,
  ProjectStrategyOpportunity,
  ProjectTaskProposalDraft,
} from "./types.js";

export const PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS = {
  maxHealthSignals: 20,
  maxStaleGoalIds: 50,
  maxEvidenceRefsPerItem: 10,
  maxSuccessMetricsPerGoal: 10,
  maxAcceptanceCriteriaPerProposal: 10,
  maxSummaryChars: 4000,
  maxTextChars: 2000,
  maxShortTextChars: 500,
  maxTitleChars: 200,
  maxEvidenceRefChars: 500,
  maxEvidenceSummaryChars: 1000,
  maxIdChars: 200,
  maxGoalReplans: 20,
} as const;

export const PROJECT_MANAGER_STRATEGY_POLICY_LIMITS = {
  maxOpportunities: 10,
  maxQuestionsForHuman: 5,
  maxAnalysisLenses: 7,
  maxRedTeamNotesPerOpportunity: 5,
  minCreateGoalConfidence: 60,
} as const;

const evidenceIdentity = (ref: EvidenceRef): string =>
  `${ref.kind}:${ref.ref.trim().toLowerCase()}`;

const hasEvidenceOverlap = (
  left: readonly EvidenceRef[],
  right: readonly EvidenceRef[],
): boolean => {
  const leftIdentities = new Set(left.map(evidenceIdentity));
  return right.some((ref) => leftIdentities.has(evidenceIdentity(ref)));
};

const pushMaxCountViolation = (
  violations: string[],
  path: string,
  length: number,
  max: number,
  noun = "entries",
): void => {
  if (length > max) {
    violations.push(`${path} must contain at most ${max} ${noun}, received ${length}.`);
  }
};

const pushMaxStringViolation = (
  violations: string[],
  path: string,
  value: string | undefined,
  max: number,
): void => {
  if (value !== undefined && value.length > max) {
    violations.push(`${path} must be at most ${max} characters, received ${value.length}.`);
  }
};

const validateStringArray = (
  values: readonly string[],
  path: string,
  maxCount: number,
  maxChars: number,
  violations: string[],
): void => {
  pushMaxCountViolation(violations, path, values.length, maxCount);
  for (const [index, value] of values.entries()) {
    pushMaxStringViolation(violations, `${path}[${index}]`, value, maxChars);
  }
};

const validateEvidenceRefs = (
  evidenceRefs: readonly EvidenceRef[],
  path: string,
  violations: string[],
): void => {
  pushMaxCountViolation(
    violations,
    path,
    evidenceRefs.length,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxEvidenceRefsPerItem,
  );
  for (const [index, ref] of evidenceRefs.entries()) {
    const refPath = `${path}[${index}]`;
    pushMaxStringViolation(
      violations,
      `${refPath}.kind`,
      ref.kind,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxShortTextChars,
    );
    pushMaxStringViolation(
      violations,
      `${refPath}.ref`,
      ref.ref,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxEvidenceRefChars,
    );
    pushMaxStringViolation(
      violations,
      `${refPath}.summary`,
      ref.summary,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxEvidenceSummaryChars,
    );
  }
};

const validateTaskProposal = (
  proposal: ProjectTaskProposalDraft,
  path: string,
  config: ProjectManagerConfig,
  violations: string[],
): void => {
  const allowedTaskTypes = new Set(config.allowedTaskTypes);
  pushMaxStringViolation(
    violations,
    `${path}.title`,
    proposal.title,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTitleChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.description`,
    proposal.description,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  if (!allowedTaskTypes.has(proposal.taskType)) {
    violations.push(
      `Task type ${proposal.taskType} is not allowed for ${path}. Allowed task types: ${config.allowedTaskTypes.join(", ")}.`,
    );
  }
  validateStringArray(
    proposal.acceptanceCriteria,
    `${path}.acceptanceCriteria`,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxAcceptanceCriteriaPerProposal,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxShortTextChars,
    violations,
  );
  pushMaxStringViolation(
    violations,
    `${path}.expectedBlastRadius`,
    proposal.expectedBlastRadius,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxEvidenceSummaryChars,
  );
  validateEvidenceRefs(proposal.evidenceRefs, `${path}.evidenceRefs`, violations);
};

const validateGoal = (
  goal: ProjectGoalDraft,
  path: string,
  config: ProjectManagerConfig,
  violations: string[],
): void => {
  pushMaxStringViolation(
    violations,
    `${path}.title`,
    goal.title,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTitleChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.problemStatement`,
    goal.problemStatement,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.desiredOutcome`,
    goal.desiredOutcome,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  validateStringArray(
    goal.successMetrics,
    `${path}.successMetrics`,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxSuccessMetricsPerGoal,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxShortTextChars,
    violations,
  );
  validateEvidenceRefs(goal.evidenceRefs, `${path}.evidenceRefs`, violations);
  pushMaxCountViolation(
    violations,
    `${path}.suggestedTaskProposals`,
    goal.suggestedTaskProposals.length,
    config.maxTaskProposalsPerGoal,
    "task proposals",
  );
  for (const [proposalIndex, proposal] of goal.suggestedTaskProposals.entries()) {
    validateTaskProposal(
      proposal,
      `${path}.suggestedTaskProposals[${proposalIndex}]`,
      config,
      violations,
    );
  }
};

const validateHealthSignal = (
  signal: ProjectHealthSignal,
  path: string,
  violations: string[],
): void => {
  pushMaxStringViolation(
    violations,
    `${path}.kind`,
    signal.kind,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxShortTextChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.title`,
    signal.title,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTitleChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.description`,
    signal.description,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  validateEvidenceRefs(signal.evidenceRefs, `${path}.evidenceRefs`, violations);
  pushMaxStringViolation(
    violations,
    `${path}.recommendation`,
    signal.recommendation,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
};

export const assertProjectAnalysisWithinPolicy = (
  analysis: ParsedProjectAnalysis,
  config: ProjectManagerConfig,
): void => {
  const violations: string[] = [];
  pushMaxStringViolation(
    violations,
    "summary",
    analysis.summary,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxSummaryChars,
  );
  pushMaxStringViolation(
    violations,
    "replanReason",
    analysis.replanReason,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  if (analysis.proposedGoals.length > config.maxGoalsPerRun) {
    violations.push(
      `Expected at most ${config.maxGoalsPerRun} proposed goals, received ${analysis.proposedGoals.length}.`,
    );
  }
  if (
    analysis.healthSignals.length >
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxHealthSignals
  ) {
    violations.push(
      `Expected at most ${PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxHealthSignals} health signals, received ${analysis.healthSignals.length}.`,
    );
  }
  validateStringArray(
    analysis.staleGoalIds,
    "staleGoalIds",
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxStaleGoalIds,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxIdChars,
    violations,
  );

  for (const [signalIndex, signal] of analysis.healthSignals.entries()) {
    validateHealthSignal(signal, `healthSignals[${signalIndex}]`, violations);
  }
  for (const [goalIndex, goal] of analysis.proposedGoals.entries()) {
    validateGoal(goal, `proposedGoals[${goalIndex}]`, config, violations);
  }

  if (violations.length > 0) {
    throw new Error(
      `Codex PROJECT_ANALYSIS violates project manager policy: ${violations.join(" ")}`,
    );
  }
};

export interface AssertProjectReplanWithinPolicyInput {
  parsed: ParsedProjectAnalysis;
  config: ProjectManagerConfig;
  activeGoalIds: string[];
}

const validateGoalReplan = (
  replan: ProjectGoalReplanClassification,
  path: string,
  config: ProjectManagerConfig,
  activeGoalIds: Set<string>,
  violations: string[],
): void => {
  pushMaxStringViolation(
    violations,
    `${path}.goalId`,
    replan.goalId,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxIdChars,
  );
  if (!activeGoalIds.has(replan.goalId)) {
    violations.push(`${path}.goalId is unknown or inactive: ${replan.goalId}.`);
  }
  pushMaxStringViolation(
    violations,
    `${path}.rationale`,
    replan.rationale,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  validateEvidenceRefs(replan.evidenceRefs, `${path}.evidenceRefs`, violations);
  pushMaxCountViolation(
    violations,
    `${path}.followUpGoals`,
    replan.followUpGoals.length,
    config.maxGoalsPerRun,
    "follow-up goals",
  );
  for (const [goalIndex, goal] of replan.followUpGoals.entries()) {
    validateGoal(goal, `${path}.followUpGoals[${goalIndex}]`, config, violations);
  }
  pushMaxStringViolation(
    violations,
    `${path}.humanQuestion`,
    replan.humanQuestion,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  if (replan.decision === "ask_human" && !replan.humanQuestion) {
    violations.push(`${path}.humanQuestion is required for ask_human decisions.`);
  }
};

export const assertProjectReplanWithinPolicy = (
  input: AssertProjectReplanWithinPolicyInput,
): void => {
  assertProjectAnalysisWithinPolicy(input.parsed, input.config);

  const violations: string[] = [];
  pushMaxCountViolation(
    violations,
    "goalReplans",
    input.parsed.goalReplans.length,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxGoalReplans,
  );
  const materializableGoalCount =
    input.parsed.proposedGoals.length +
    input.parsed.goalReplans.reduce(
      (count, replan) => count + replan.followUpGoals.length,
      0,
    );
  pushMaxCountViolation(
    violations,
    "materializableGoals",
    materializableGoalCount,
    input.config.maxGoalsPerRun,
    "materializable goals",
  );

  const activeGoalIds = new Set(input.activeGoalIds);
  for (const [replanIndex, replan] of input.parsed.goalReplans.entries()) {
    validateGoalReplan(
      replan,
      `goalReplans[${replanIndex}]`,
      input.config,
      activeGoalIds,
      violations,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `Codex PROJECT_REPLAN violates project manager policy: ${violations.join(" ")}`,
    );
  }
};

export interface AssertProjectStrategyWithinPolicyInput {
  parsed: ParsedProjectStrategyAnalysis;
  config: ProjectManagerConfig;
}

const validateStrategyOpportunity = (
  opportunity: ProjectStrategyOpportunity,
  path: string,
  violations: string[],
): void => {
  pushMaxStringViolation(
    violations,
    `${path}.opportunityId`,
    opportunity.opportunityId,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxIdChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.title`,
    opportunity.title,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTitleChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.problemStatement`,
    opportunity.problemStatement,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.userOrBusinessImpact`,
    opportunity.userOrBusinessImpact,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.technicalImpact`,
    opportunity.technicalImpact,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  pushMaxStringViolation(
    violations,
    `${path}.rationale`,
    opportunity.rationale,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
  );
  validateEvidenceRefs(opportunity.evidenceRefs, `${path}.evidenceRefs`, violations);
  if (opportunity.evidenceRefs.length === 0) {
    violations.push(`${path}.evidenceRefs must contain at least one evidence ref.`);
  }
  validateStringArray(
    opportunity.redTeamNotes,
    `${path}.redTeamNotes`,
    PROJECT_MANAGER_STRATEGY_POLICY_LIMITS.maxRedTeamNotesPerOpportunity,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxShortTextChars,
    violations,
  );
  if (
    opportunity.recommendedNextStep === "create_goal" &&
    opportunity.confidence <
      PROJECT_MANAGER_STRATEGY_POLICY_LIMITS.minCreateGoalConfidence
  ) {
    violations.push(
      `${path}.confidence below 60 is not allowed for create_goal opportunities.`,
    );
  }
  if (
    opportunity.recommendedNextStep === "create_goal" &&
    opportunity.architectVerdict !== "pursue"
  ) {
    violations.push(
      `${path}.architectVerdict must be pursue for create_goal opportunities.`,
    );
  }
};

const hasCriticalHighRiskEvidence = (
  evidenceRefs: readonly EvidenceRef[],
): boolean =>
  evidenceRefs.some((ref) =>
    ["task", "validation_failure", "review_comment"].includes(ref.kind),
  );

const priorityRank = (priority: ProjectGoalPriority): number =>
  PROJECT_GOAL_PRIORITIES.indexOf(priority);

const riskLevelRank = (riskLevel: ProjectGoalRiskLevel): number =>
  PROJECT_GOAL_RISK_LEVELS.indexOf(riskLevel);

const maxPriority = (
  left: ProjectGoalPriority,
  right: ProjectGoalPriority,
): ProjectGoalPriority => (priorityRank(left) >= priorityRank(right) ? left : right);

const maxRiskLevel = (
  left: ProjectGoalRiskLevel,
  right: ProjectGoalRiskLevel,
): ProjectGoalRiskLevel => (riskLevelRank(left) >= riskLevelRank(right) ? left : right);

export const assertProjectStrategyWithinPolicy = (
  input: AssertProjectStrategyWithinPolicyInput,
): void => {
  const { parsed, config } = input;
  const violations: string[] = [];
  pushMaxStringViolation(
    violations,
    "summary",
    parsed.summary,
    PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxSummaryChars,
  );
  pushMaxCountViolation(
    violations,
    "analysisLenses",
    parsed.analysisLenses.length,
    PROJECT_MANAGER_STRATEGY_POLICY_LIMITS.maxAnalysisLenses,
  );
  pushMaxCountViolation(
    violations,
    "opportunities",
    parsed.opportunities.length,
    PROJECT_MANAGER_STRATEGY_POLICY_LIMITS.maxOpportunities,
  );
  pushMaxCountViolation(
    violations,
    "questionsForHuman",
    parsed.questionsForHuman.length,
    PROJECT_MANAGER_STRATEGY_POLICY_LIMITS.maxQuestionsForHuman,
  );
  pushMaxCountViolation(
    violations,
    "proposedGoals",
    parsed.proposedGoals.length,
    config.maxGoalsPerRun,
    "proposed goals",
  );

  for (const [lensIndex, lens] of parsed.analysisLenses.entries()) {
    pushMaxStringViolation(
      violations,
      `analysisLenses[${lensIndex}].summary`,
      lens.summary,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxShortTextChars,
    );
  }

  const opportunitiesById = new Map<string, ProjectStrategyOpportunity>();
  for (const [opportunityIndex, opportunity] of parsed.opportunities.entries()) {
    const path = `opportunities[${opportunityIndex}]`;
    validateStrategyOpportunity(opportunity, path, violations);
    if (opportunitiesById.has(opportunity.opportunityId)) {
      violations.push(`${path}.opportunityId must be unique: ${opportunity.opportunityId}.`);
    }
    opportunitiesById.set(opportunity.opportunityId, opportunity);
  }

  for (const [questionIndex, question] of parsed.questionsForHuman.entries()) {
    const path = `questionsForHuman[${questionIndex}]`;
    pushMaxStringViolation(
      violations,
      `${path}.question`,
      question.question,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
    );
    pushMaxStringViolation(
      violations,
      `${path}.whyItMatters`,
      question.whyItMatters,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTextChars,
    );
    pushMaxStringViolation(
      violations,
      `${path}.relatedOpportunityId`,
      question.relatedOpportunityId,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxIdChars,
    );
    pushMaxStringViolation(
      violations,
      `${path}.relatedOpportunityTitle`,
      question.relatedOpportunityTitle,
      PROJECT_MANAGER_ANALYSIS_POLICY_LIMITS.maxTitleChars,
    );
  }

  for (const [goalIndex, goal] of parsed.proposedGoals.entries()) {
    const path = `proposedGoals[${goalIndex}]`;
    validateGoal(goal, path, config, violations);
    const opportunity = opportunitiesById.get(goal.sourceOpportunityId);
    if (!opportunity) {
      violations.push(
        `${path}.sourceOpportunityId must reference a valid opportunity: ${goal.sourceOpportunityId}.`,
      );
      continue;
    }
    if (opportunity.architectVerdict !== "pursue") {
      violations.push(
        `${path}.sourceOpportunityId must reference a pursued opportunity.`,
      );
    }
    if (opportunity.recommendedNextStep !== "create_goal") {
      violations.push(
        `${path}.sourceOpportunityId must reference an opportunity with recommendedNextStep create_goal.`,
      );
    }
    if (!hasEvidenceOverlap(goal.evidenceRefs, opportunity.evidenceRefs)) {
      violations.push(
        `${path}.evidenceRefs must overlap referenced opportunity evidence.`,
      );
    }
    if (riskLevelRank(goal.riskLevel) < riskLevelRank(opportunity.riskLevel)) {
      violations.push(
        `${path}.riskLevel must not be lower than source opportunity riskLevel ${opportunity.riskLevel}.`,
      );
    }
    if (priorityRank(goal.priority) < priorityRank(opportunity.priority)) {
      violations.push(
        `${path}.priority must not be lower than source opportunity priority ${opportunity.priority}.`,
      );
    }

    const effectiveRiskLevel = maxRiskLevel(goal.riskLevel, opportunity.riskLevel);
    const effectivePriority = maxPriority(goal.priority, opportunity.priority);
    if (effectiveRiskLevel === "high" && goal.suggestedTaskProposals.length > 1) {
      violations.push(
        `${path}.suggestedTaskProposals must contain at most 1 task proposal for high-risk goals.`,
      );
    }
    if (
      effectiveRiskLevel === "high" &&
      !(
        effectivePriority === "critical" &&
        hasCriticalHighRiskEvidence(goal.evidenceRefs)
      )
    ) {
      for (const [proposalIndex, proposal] of goal.suggestedTaskProposals.entries()) {
        if (!["documentation", "tests_only"].includes(proposal.taskType)) {
          violations.push(
            `${path}.suggestedTaskProposals[${proposalIndex}].taskType must be documentation or tests_only for high-risk strategy goals.`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Codex PROJECT_STRATEGY violates project manager policy: ${violations.join(" ")}`,
    );
  }
};
