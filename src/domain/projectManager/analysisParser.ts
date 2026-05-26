import type { TaskType } from "../../models/types.js";
import {
  EVIDENCE_REF_KINDS,
  type EvidenceRef,
} from "../taskTracker/types.js";
import {
  PROJECT_ANALYSIS_MARKER,
  PROJECT_GOAL_PRIORITIES,
  PROJECT_GOAL_RISK_LEVELS,
  PROJECT_HEALTH_SIGNAL_SEVERITIES,
  type ParsedProjectAnalysis,
  type ProjectGoalDraft,
  type ProjectGoalPriority,
  type ProjectGoalRiskLevel,
  type ProjectHealthSignal,
  type ProjectHealthSignalSeverity,
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

export const parseProjectAnalysisResponse = (
  message: string | undefined,
): ParsedProjectAnalysis | undefined => {
  if (!message?.startsWith(PROJECT_ANALYSIS_MARKER)) {
    return undefined;
  }

  const payload = message.slice(PROJECT_ANALYSIS_MARKER.length).trim();
  if (!payload.startsWith("{")) {
    return undefined;
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const summary = nonEmptyString(raw.summary);
  const healthSignals = parseHealthSignals(raw.healthSignals);
  const proposedGoals = parseProposedGoals(raw.proposedGoals);
  const staleGoalIds = parseOptionalStringArray(raw.staleGoalIds);
  const replanReason = nonEmptyString(raw.replanReason);
  if (!summary || !healthSignals || !proposedGoals || !staleGoalIds) {
    return undefined;
  }

  return {
    summary,
    healthSignals,
    proposedGoals,
    staleGoalIds,
    ...(replanReason ? { replanReason } : {}),
  };
};
