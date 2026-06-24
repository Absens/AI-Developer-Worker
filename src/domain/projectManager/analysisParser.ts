import type { TaskType } from "../../models/types.js";
import {
  EVIDENCE_REF_KINDS,
  type EvidenceRef,
} from "../taskTracker/types.js";
import {
  PROJECT_ANALYSIS_MARKER,
  PROJECT_GOAL_REPLAN_DECISIONS,
  PROJECT_GOAL_PRIORITIES,
  PROJECT_GOAL_RISK_LEVELS,
  PROJECT_HEALTH_SIGNAL_SEVERITIES,
  PROJECT_REPLAN_MARKER,
  PROJECT_STRATEGY_ARCHITECT_VERDICTS,
  PROJECT_STRATEGY_DIMENSIONS,
  PROJECT_STRATEGY_LENSES,
  PROJECT_STRATEGY_MARKER,
  PROJECT_STRATEGY_NEXT_STEPS,
  type ParsedProjectAnalysis,
  type ParsedProjectStrategyAnalysis,
  type ProjectGoalDraft,
  type ProjectGoalPriority,
  type ProjectGoalReplanClassification,
  type ProjectGoalReplanDecision,
  type ProjectGoalRiskLevel,
  type ProjectHealthSignal,
  type ProjectHealthSignalSeverity,
  type ProjectStrategyArchitectVerdict,
  type ProjectStrategyDimension,
  type ProjectStrategyLens,
  type ProjectStrategyLensSummary,
  type ProjectStrategyOpportunity,
  type ProjectStrategyProposedGoalDraft,
  type ProjectStrategyQuestion,
  type ProjectStrategyRecommendedNextStep,
  type ProjectTaskProposalDraft,
} from "./types.js";

const TASK_TYPES = new Set<TaskType>([
  "frontend_ui_fix",
  "backend_endpoint",
  "tests_only",
  "refactor",
  "dependency_update",
  "documentation",
  "unknown",
]);

const EVIDENCE_KINDS = new Set<EvidenceRef["kind"]>(EVIDENCE_REF_KINDS);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const parseStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values: string[] = [];
  for (const entry of value) {
    const parsed = nonEmptyString(entry);
    if (!parsed) {
      return undefined;
    }
    values.push(parsed);
  }
  return values;
};

const parseOptionalStringArray = (value: unknown): string[] | undefined =>
  value === undefined ? [] : parseStringArray(value);

const parseIntegerInRange = (
  value: unknown,
  min: number,
  max: number,
): number | undefined => {
  if (!Number.isInteger(value)) {
    return undefined;
  }
  const parsed = value as number;
  return parsed >= min && parsed <= max ? parsed : undefined;
};

const parseEvidenceRefs = (value: unknown): EvidenceRef[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const refs: EvidenceRef[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as Record<string, unknown>;
    const kind = nonEmptyString(raw.kind);
    const ref = nonEmptyString(raw.ref);
    const summary = nonEmptyString(raw.summary);
    if (!kind || !EVIDENCE_KINDS.has(kind as EvidenceRef["kind"]) || !ref) {
      return undefined;
    }
    refs.push({
      kind: kind as EvidenceRef["kind"],
      ref,
      ...(summary ? { summary } : {}),
    });
  }
  return refs;
};

const includesValue = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && values.includes(value as T);

const parseTaskProposalDrafts = (
  value: unknown,
): ProjectTaskProposalDraft[] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const proposals: ProjectTaskProposalDraft[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as Record<string, unknown>;
    const title = nonEmptyString(raw.title);
    const description = nonEmptyString(raw.description);
    const taskType = nonEmptyString(raw.taskType);
    const acceptanceCriteria = parseStringArray(raw.acceptanceCriteria);
    const expectedBlastRadius = nonEmptyString(raw.expectedBlastRadius);
    const evidenceRefs = parseEvidenceRefs(raw.evidenceRefs);
    if (
      !title ||
      !description ||
      !taskType ||
      !TASK_TYPES.has(taskType as TaskType) ||
      !acceptanceCriteria ||
      !evidenceRefs
    ) {
      return undefined;
    }
    proposals.push({
      title,
      description,
      taskType: taskType as TaskType,
      acceptanceCriteria,
      ...(expectedBlastRadius ? { expectedBlastRadius } : {}),
      evidenceRefs,
    });
  }
  return proposals;
};

const parseHealthSignals = (
  value: unknown,
): ProjectHealthSignal[] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const healthSignals: ProjectHealthSignal[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const signal = entry as Record<string, unknown>;
    const kind = nonEmptyString(signal.kind);
    const severity = signal.severity;
    const title = nonEmptyString(signal.title);
    const description = nonEmptyString(signal.description);
    const evidenceRefs = parseEvidenceRefs(signal.evidenceRefs);
    const recommendation = nonEmptyString(signal.recommendation);
    if (
      !kind ||
      !includesValue<ProjectHealthSignalSeverity>(
        PROJECT_HEALTH_SIGNAL_SEVERITIES,
        severity,
      ) ||
      !title ||
      !description ||
      !evidenceRefs
    ) {
      return undefined;
    }
    healthSignals.push({
      kind,
      severity,
      title,
      description,
      evidenceRefs,
      ...(recommendation ? { recommendation } : {}),
    });
  }
  return healthSignals;
};

const parseProposedGoals = (value: unknown): ProjectGoalDraft[] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const proposedGoals: ProjectGoalDraft[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const goal = entry as Record<string, unknown>;
    const title = nonEmptyString(goal.title);
    const problemStatement = nonEmptyString(goal.problemStatement);
    const desiredOutcome = nonEmptyString(goal.desiredOutcome);
    const priority = goal.priority;
    const riskLevel = goal.riskLevel;
    const successMetrics = parseStringArray(goal.successMetrics);
    const evidenceRefs = parseEvidenceRefs(goal.evidenceRefs);
    const suggestedTaskProposals = parseTaskProposalDrafts(
      goal.suggestedTaskProposals,
    );
    if (
      !title ||
      !problemStatement ||
      !desiredOutcome ||
      !includesValue<ProjectGoalPriority>(PROJECT_GOAL_PRIORITIES, priority) ||
      !includesValue<ProjectGoalRiskLevel>(PROJECT_GOAL_RISK_LEVELS, riskLevel) ||
      !successMetrics ||
      !evidenceRefs ||
      !suggestedTaskProposals
    ) {
      return undefined;
    }
    proposedGoals.push({
      title,
      problemStatement,
      desiredOutcome,
      successMetrics,
      evidenceRefs,
      priority,
      riskLevel,
      suggestedTaskProposals,
    });
  }
  return proposedGoals;
};

const parseStrategyLensSummaries = (
  value: unknown,
): ProjectStrategyLensSummary[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const summaries: ProjectStrategyLensSummary[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as Record<string, unknown>;
    const lens = raw.lens;
    const summary = nonEmptyString(raw.summary);
    if (
      !includesValue<ProjectStrategyLens>(PROJECT_STRATEGY_LENSES, lens) ||
      !summary
    ) {
      return undefined;
    }
    summaries.push({ lens, summary });
  }
  return summaries;
};

const parseStrategyOpportunities = (
  value: unknown,
): ProjectStrategyOpportunity[] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const opportunities: ProjectStrategyOpportunity[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as Record<string, unknown>;
    const opportunityId = nonEmptyString(raw.opportunityId);
    const dimension = raw.dimension;
    const title = nonEmptyString(raw.title);
    const problemStatement = nonEmptyString(raw.problemStatement);
    const userOrBusinessImpact = nonEmptyString(raw.userOrBusinessImpact);
    const technicalImpact = nonEmptyString(raw.technicalImpact);
    const evidenceRefs = parseEvidenceRefs(raw.evidenceRefs);
    const confidence = parseIntegerInRange(raw.confidence, 0, 100);
    const priority = raw.priority;
    const riskLevel = raw.riskLevel;
    const recommendedNextStep = raw.recommendedNextStep;
    const rationale = nonEmptyString(raw.rationale);
    const redTeamNotes = parseOptionalStringArray(raw.redTeamNotes);
    const architectVerdict = raw.architectVerdict;
    if (
      !opportunityId ||
      !includesValue<ProjectStrategyDimension>(
        PROJECT_STRATEGY_DIMENSIONS,
        dimension,
      ) ||
      !title ||
      !problemStatement ||
      !userOrBusinessImpact ||
      !technicalImpact ||
      !evidenceRefs ||
      confidence === undefined ||
      !includesValue<ProjectGoalPriority>(PROJECT_GOAL_PRIORITIES, priority) ||
      !includesValue<ProjectGoalRiskLevel>(PROJECT_GOAL_RISK_LEVELS, riskLevel) ||
      !includesValue<ProjectStrategyRecommendedNextStep>(
        PROJECT_STRATEGY_NEXT_STEPS,
        recommendedNextStep,
      ) ||
      !rationale ||
      !redTeamNotes ||
      !includesValue<ProjectStrategyArchitectVerdict>(
        PROJECT_STRATEGY_ARCHITECT_VERDICTS,
        architectVerdict,
      )
    ) {
      return undefined;
    }
    opportunities.push({
      opportunityId,
      dimension,
      title,
      problemStatement,
      userOrBusinessImpact,
      technicalImpact,
      evidenceRefs,
      confidence,
      priority,
      riskLevel,
      recommendedNextStep,
      rationale,
      redTeamNotes,
      architectVerdict,
    });
  }
  return opportunities;
};

const parseStrategyProposedGoals = (
  value: unknown,
): ProjectStrategyProposedGoalDraft[] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const proposedGoals: ProjectStrategyProposedGoalDraft[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const sourceOpportunityId = nonEmptyString(
      (entry as Record<string, unknown>).sourceOpportunityId,
    );
    const parsedGoals = parseProposedGoals([entry]);
    const parsedGoal = parsedGoals?.[0];
    if (!sourceOpportunityId || !parsedGoal) {
      return undefined;
    }
    proposedGoals.push({
      ...parsedGoal,
      sourceOpportunityId,
    });
  }
  return proposedGoals;
};

const parseStrategyQuestions = (
  value: unknown,
): ProjectStrategyQuestion[] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const questions: ProjectStrategyQuestion[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as Record<string, unknown>;
    const question = nonEmptyString(raw.question);
    const whyItMatters = nonEmptyString(raw.whyItMatters);
    const relatedOpportunityId = nonEmptyString(raw.relatedOpportunityId);
    const relatedOpportunityTitle = nonEmptyString(raw.relatedOpportunityTitle);
    if (!question || !whyItMatters) {
      return undefined;
    }
    questions.push({
      question,
      whyItMatters,
      ...(relatedOpportunityId ? { relatedOpportunityId } : {}),
      ...(relatedOpportunityTitle ? { relatedOpportunityTitle } : {}),
    });
  }
  return questions;
};

const parseGoalReplans = (
  value: unknown,
): ProjectGoalReplanClassification[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const goalReplans: ProjectGoalReplanClassification[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const replan = entry as Record<string, unknown>;
    const goalId = nonEmptyString(replan.goalId);
    const decision = replan.decision;
    const rationale = nonEmptyString(replan.rationale);
    const evidenceRefs = parseEvidenceRefs(replan.evidenceRefs);
    const followUpGoals =
      replan.followUpGoals === undefined
        ? undefined
        : parseProposedGoals(replan.followUpGoals);
    const humanQuestion = nonEmptyString(replan.humanQuestion);
    if (
      !goalId ||
      !includesValue<ProjectGoalReplanDecision>(
        PROJECT_GOAL_REPLAN_DECISIONS,
        decision,
      ) ||
      !rationale ||
      !evidenceRefs ||
      !followUpGoals
    ) {
      return undefined;
    }
    goalReplans.push({
      goalId,
      decision,
      rationale,
      evidenceRefs,
      followUpGoals,
      ...(humanQuestion ? { humanQuestion } : {}),
    });
  }
  return goalReplans;
};

const extractStructuredPayload = (
  message: string | undefined,
  marker: string,
): Record<string, unknown> | undefined => {
  if (!message) {
    return undefined;
  }

  const payload = message.startsWith(marker)
    ? message.slice(marker.length).trim()
    : message.trim();
  if (!payload.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

export const parseProjectAnalysisResponse = (
  message: string | undefined,
): ParsedProjectAnalysis | undefined => {
  const raw = extractStructuredPayload(message, PROJECT_ANALYSIS_MARKER);
  if (!raw) {
    return undefined;
  }

  const summary = nonEmptyString(raw.summary);
  const healthSignals = parseHealthSignals(raw.healthSignals);
  const proposedGoals = parseProposedGoals(raw.proposedGoals);
  const staleGoalIds = parseOptionalStringArray(raw.staleGoalIds);
  const previousAnalysisId = nonEmptyString(raw.previousAnalysisId);
  const replanReason = nonEmptyString(raw.replanReason);
  if (!summary || !healthSignals || !proposedGoals || !staleGoalIds) {
    return undefined;
  }

  return {
    summary,
    healthSignals,
    proposedGoals,
    staleGoalIds,
    ...(previousAnalysisId ? { previousAnalysisId } : {}),
    ...(replanReason ? { replanReason } : {}),
    goalReplans: [],
  };
};

export const parseProjectReplanResponse = (
  message: string | undefined,
): ParsedProjectAnalysis | undefined => {
  const raw = extractStructuredPayload(message, PROJECT_REPLAN_MARKER);
  if (!raw) {
    return undefined;
  }

  const summary = nonEmptyString(raw.summary);
  const healthSignals =
    raw.healthSignals === undefined
      ? undefined
      : parseHealthSignals(raw.healthSignals);
  const proposedGoals =
    raw.proposedGoals === undefined
      ? undefined
      : parseProposedGoals(raw.proposedGoals);
  const staleGoalIds =
    raw.staleGoalIds === undefined
      ? undefined
      : parseStringArray(raw.staleGoalIds);
  const previousAnalysisId = nonEmptyString(raw.previousAnalysisId);
  const replanReason = nonEmptyString(raw.replanReason);
  const goalReplans = parseGoalReplans(raw.goalReplans);
  if (
    !summary ||
    !healthSignals ||
    !proposedGoals ||
    !staleGoalIds ||
    !replanReason ||
    !goalReplans
  ) {
    return undefined;
  }

  return {
    summary,
    healthSignals,
    proposedGoals,
    staleGoalIds,
    ...(previousAnalysisId ? { previousAnalysisId } : {}),
    replanReason,
    goalReplans,
  };
};

export const parseProjectStrategyResponse = (
  message: string | undefined,
): ParsedProjectStrategyAnalysis | undefined => {
  const raw = extractStructuredPayload(message, PROJECT_STRATEGY_MARKER);
  if (!raw) {
    return undefined;
  }

  const summary = nonEmptyString(raw.summary);
  const analysisLenses = parseStrategyLensSummaries(raw.analysisLenses);
  const opportunities = parseStrategyOpportunities(raw.opportunities);
  const proposedGoals = parseStrategyProposedGoals(raw.proposedGoals);
  const questionsForHuman = parseStrategyQuestions(raw.questionsForHuman);
  if (
    !summary ||
    !analysisLenses ||
    !opportunities ||
    !proposedGoals ||
    !questionsForHuman
  ) {
    return undefined;
  }

  return {
    summary,
    analysisLenses,
    opportunities,
    proposedGoals,
    questionsForHuman,
  };
};
