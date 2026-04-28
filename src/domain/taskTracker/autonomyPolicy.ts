import { createHash, randomUUID } from "node:crypto";

import type {
  AutonomyPolicyConfig,
  RepositoryAutonomyPolicyConfig,
  TaskType,
} from "../../models/types.js";
import type {
  ArtifactRefInput,
  EvidenceRef,
  ProposalPolicyDecision,
  ProposalPolicyEvaluation,
  ProposeTaskInput,
} from "./types.js";

export const LOW_RISK_TASK_TYPES: TaskType[] = [
  "documentation",
  "tests_only",
  "dependency_update",
];

export const DEFAULT_AUTONOMY_POLICY_CONFIG: AutonomyPolicyConfig = {
  aiProposalsEnabled: true,
  autoExecuteLowRiskEnabled: false,
  defaultAllowedTaskTypes: LOW_RISK_TASK_TYPES,
  defaultDailyProposalLimit: 20,
  defaultWindowProposalLimit: 5,
  defaultWindowSeconds: 60 * 60,
  repositories: {},
};

const HIGH_RISK_PATTERNS = [
  "security",
  "secret",
  "credential",
  "auth",
  "authentication",
  "authorization",
  "payment",
  "billing",
  "database migration",
  "db migration",
  "schema migration",
  "public api",
  "breaking api",
  "broad refactor",
  "large refactor",
  "multi-repository",
  "multi repository",
  "cross-repository",
];

export interface ProposalWindowCounts {
  daily: number;
  window: number;
}

export interface EvaluatedProposalPolicy {
  decision: ProposalPolicyDecision;
  supervisorStatus: "proposed" | "auto_approved";
  allowed: boolean;
  autoApproved: boolean;
  approvalPolicy: string;
  reason: string;
}

export const normalizeAutonomyPolicyConfig = (
  config?: Partial<AutonomyPolicyConfig>,
): AutonomyPolicyConfig => ({
  aiProposalsEnabled:
    config?.aiProposalsEnabled ?? DEFAULT_AUTONOMY_POLICY_CONFIG.aiProposalsEnabled,
  autoExecuteLowRiskEnabled:
    config?.autoExecuteLowRiskEnabled ??
    DEFAULT_AUTONOMY_POLICY_CONFIG.autoExecuteLowRiskEnabled,
  defaultAllowedTaskTypes:
    config?.defaultAllowedTaskTypes ??
    DEFAULT_AUTONOMY_POLICY_CONFIG.defaultAllowedTaskTypes,
  defaultDailyProposalLimit:
    config?.defaultDailyProposalLimit ??
    DEFAULT_AUTONOMY_POLICY_CONFIG.defaultDailyProposalLimit,
  defaultWindowProposalLimit:
    config?.defaultWindowProposalLimit ??
    DEFAULT_AUTONOMY_POLICY_CONFIG.defaultWindowProposalLimit,
  defaultWindowSeconds:
    config?.defaultWindowSeconds ?? DEFAULT_AUTONOMY_POLICY_CONFIG.defaultWindowSeconds,
  repositories: {
    ...DEFAULT_AUTONOMY_POLICY_CONFIG.repositories,
    ...(config?.repositories ?? {}),
  },
});

export const repositoryPolicyFor = (
  config: AutonomyPolicyConfig,
  repositoryName: string,
): RepositoryAutonomyPolicyConfig =>
  config.repositories[repositoryName] ?? config.repositories[repositoryName.toLowerCase()] ?? {};

const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeProposalTitle = (title: string): string => normalize(title);

export const evidenceKey = (evidence: EvidenceRef): string =>
  `${evidence.kind}:${normalize(evidence.ref)}`;

const dependencyTarget = (input: ProposeTaskInput): string | undefined => {
  if (input.taskType !== "dependency_update") {
    return undefined;
  }

  const searchable = [
    input.title,
    input.description,
    input.proposalReason,
    ...input.evidenceRefs.map((ref) => ref.ref),
  ].join(" ");
  const match = searchable.match(
    /\b([@a-z0-9_.\-\/]+)\s*(?:@|->|to|version)\s*(v?\d+(?:\.\d+){0,3}[a-z0-9_.\-]*)/i,
  );
  return match ? `${match[1]?.toLowerCase()}@${match[2]?.toLowerCase()}` : undefined;
};

export const buildProposalDuplicateSignature = (input: ProposeTaskInput): string => {
  const parts = [
    `repo:${normalize(input.repositoryName)}`,
    `title:${normalizeProposalTitle(input.title)}`,
    `type:${input.taskType ?? "unknown"}`,
  ];
  const dependency = dependencyTarget(input);
  if (dependency) {
    parts.push(`dependency:${dependency}`);
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
};

export const hasOverlappingEvidence = (
  left: readonly EvidenceRef[],
  right: readonly EvidenceRef[],
): boolean => {
  const rightKeys = new Set(right.map(evidenceKey));
  return left.some((ref) => rightKeys.has(evidenceKey(ref)));
};

export const isTerminalProposalTaskStatus = (status: string): boolean =>
  status === "done" || status === "failed" || status === "cancelled";

const hasHighRiskSignal = (input: ProposeTaskInput): boolean => {
  const haystack = [
    input.title,
    input.description,
    input.proposalReason,
    input.expectedBlastRadius ?? "",
    ...(input.riskFactors ?? []),
  ]
    .join(" ")
    .toLowerCase();

  return HIGH_RISK_PATTERNS.some((pattern) => haystack.includes(pattern));
};

export const evaluateProposalPolicy = (
  input: ProposeTaskInput,
  config: AutonomyPolicyConfig,
  counts: ProposalWindowCounts,
): EvaluatedProposalPolicy => {
  const repositoryPolicy = repositoryPolicyFor(config, input.repositoryName);
  const policyName = input.approvalPolicy?.trim() || "default_low_risk_policy";
  const proposalsEnabled =
    repositoryPolicy.proposalsEnabled ?? config.aiProposalsEnabled;
  const dailyLimit =
    repositoryPolicy.dailyProposalLimit ?? config.defaultDailyProposalLimit;
  const windowLimit =
    repositoryPolicy.windowProposalLimit ?? config.defaultWindowProposalLimit;
  const allowedTaskTypes =
    repositoryPolicy.allowedTaskTypes ?? config.defaultAllowedTaskTypes;

  if (!proposalsEnabled) {
    return {
      decision: "blocked",
      supervisorStatus: "proposed",
      allowed: false,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: "AI proposals are disabled by policy.",
    };
  }
  if (counts.daily >= dailyLimit) {
    return {
      decision: "blocked",
      supervisorStatus: "proposed",
      allowed: false,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: `Daily proposal limit ${dailyLimit} reached for ${input.repositoryName}.`,
    };
  }
  if (counts.window >= windowLimit) {
    return {
      decision: "blocked",
      supervisorStatus: "proposed",
      allowed: false,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: `Proposal window limit ${windowLimit} reached for ${input.repositoryName}.`,
    };
  }
  if (input.autonomyLevel !== "auto_execute_low_risk") {
    return {
      decision: "requires_approval",
      supervisorStatus: "proposed",
      allowed: true,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: `Autonomy level ${input.autonomyLevel} requires supervisor approval.`,
    };
  }
  if (!config.autoExecuteLowRiskEnabled) {
    return {
      decision: "requires_approval",
      supervisorStatus: "proposed",
      allowed: true,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: "Global auto_execute_low_risk is disabled.",
    };
  }
  if (repositoryPolicy.autoExecuteLowRiskEnabled !== true) {
    return {
      decision: "requires_approval",
      supervisorStatus: "proposed",
      allowed: true,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: `Repository ${input.repositoryName} does not allow auto_execute_low_risk.`,
    };
  }
  if (hasHighRiskSignal(input)) {
    return {
      decision: "requires_approval",
      supervisorStatus: "proposed",
      allowed: true,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: "High-risk proposal signals prevent auto-approval.",
    };
  }
  if (!allowedTaskTypes.includes(input.taskType ?? "unknown")) {
    return {
      decision: "requires_approval",
      supervisorStatus: "proposed",
      allowed: true,
      autoApproved: false,
      approvalPolicy: policyName,
      reason: `Task type ${input.taskType ?? "unknown"} is not allowlisted for auto-execution.`,
    };
  }

  return {
    decision: "auto_approved",
    supervisorStatus: "auto_approved",
    allowed: true,
    autoApproved: true,
    approvalPolicy: policyName,
    reason: "Low-risk proposal auto-approved by explicit repository policy.",
  };
};

export const createPolicyEvaluationRecord = (input: {
  taskId: string;
  decision: ProposalPolicyDecision;
  policy: string;
  allowed: boolean;
  autoApproved: boolean;
  reason: string;
  autonomyLevel: ProposeTaskInput["autonomyLevel"];
  evidenceRefs: readonly EvidenceRef[];
  createdAt: string;
}): ProposalPolicyEvaluation => ({
  id: `policy_eval_${randomUUID()}`,
  taskId: input.taskId,
  decision: input.decision,
  policy: input.policy,
  allowed: input.allowed,
  autoApproved: input.autoApproved,
  reason: input.reason,
  autonomyLevel: input.autonomyLevel,
  evidenceRefs: input.evidenceRefs.map((ref) => ({ ...ref })),
  createdAt: input.createdAt,
});

export const evidenceRefsToArtifactInputs = (
  evidenceRefs: readonly EvidenceRef[],
): ArtifactRefInput[] =>
  evidenceRefs.map((ref) => {
    const summary = ref.summary ?? `${ref.kind}: ${ref.ref}`;
    if (ref.kind === "file") {
      return {
        kind: "proposal_evidence",
        path: ref.ref,
        summary,
        retentionClass: "audit",
      };
    }

    return {
      kind: "proposal_evidence",
      uri:
        ref.kind === "external_url"
          ? ref.ref
          : `urn:ai-proposal-evidence:${ref.kind}:${encodeURIComponent(ref.ref)}`,
      summary,
      retentionClass: "audit",
    };
  });
