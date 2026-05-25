import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import { DEFAULT_AUTONOMY_POLICY_CONFIG } from "./domain/taskTracker/autonomyPolicy.js";
import type {
  AppConfig,
  AutonomyPolicyConfig,
  CodexSandbox,
  CoordinationConfig,
  DependencyUnknownStatusPolicy,
  GlobalWorkerConfig,
  LogicalStatus,
  MemoryBootstrapCodexSandbox,
  MemoryConfig,
  PriorityQueueConfig,
  ProjectManagerConfig,
  PromptProfileOverrideMap,
  RepositoryAutonomyPolicyConfig,
  RepositoryDecompositionConfig,
  RepositoryProfile,
  RepositoryProjectManagerConfig,
  RepositoryRuntimeConfig,
  TaskIntakeMode,
  TaskTrackerConfig,
  TrackerImageContextConfig,
  TrackerOrgHeader,
  TrackerStatusConfig,
  WorkerTaskMode,
} from "./models/types.js";
import { parseObservabilityConfig } from "./observability/config.js";
import { ConfigurationError } from "./utils/errors.js";
import { sanitizeRepositoryKey } from "./utils/repositoryKey.js";

const LOGICAL_STATUSES: LogicalStatus[] = [
  "open",
  "in_progress",
  "waiting_for_answer",
  "review",
  "failed",
  "done",
];

const DEFAULT_INTERNAL_TRACKER_STATUS_MAP: Record<LogicalStatus, TrackerStatusConfig> = {
  open: { statuses: ["open"] },
  in_progress: { statuses: ["in_progress"] },
  waiting_for_answer: { statuses: ["waiting_for_answer"] },
  review: { statuses: ["review"] },
  failed: { statuses: ["failed"] },
  done: { statuses: ["done"] },
};

const DEFAULT_PRIORITY_QUEUE_CONFIG: PriorityQueueConfig = {
  manualOverrideTags: ["ai_priority"],
  priorityWeights: {
    blocker: 1000,
    critical: 700,
    high: 400,
    normal: 100,
    low: 0,
  },
  tagBoosts: {},
  componentBoosts: {},
  confidencePriorityWeight: 2,
  deadlineBoost: {
    dueToday: 300,
    overdue: 600,
  },
  createdAtTieBreaker: "oldest",
};

const DEFAULT_TASK_MODE: WorkerTaskMode = "auto";
const DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD = 70;
const DEFAULT_CONFIDENCE_HUMAN_THRESHOLD = 40;
const DEFAULT_DECOMPOSITION_MAX_SUBTASKS = 8;
const DEFAULT_DECOMPOSITION_CREATE_ISSUES = true;
const DEFAULT_DECOMPOSITION_DRY_RUN = false;
const DEFAULT_DECOMPOSITION_SUBTASK_TAG = "ai_dev";
const DEFAULT_DECOMPOSITION_TITLE_PREFIX = "[AI split]";
const DEFAULT_TRACKER_PARENT_LINK_TYPE = "relates";
const DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE = "is blocked by";
const DEFAULT_DEPENDENCY_ENFORCEMENT = true;
const DEFAULT_DEPENDENCY_UNKNOWN_STATUS_POLICY: DependencyUnknownStatusPolicy = "block";
const DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG = {
  retention: {
    rawLogDays: 30,
    artifactDays: 30,
    failedArtifactDays: 90,
    historyDays: 365,
  },
  cleanup: {
    enabled: true,
    intervalSeconds: 3600,
  },
  metricsEnabled: true,
  redactionEnabled: true,
} as const;
const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  dir: "/workspace/ai-developer-memory",
  maxContextChars: 6000,
  strict: false,
  includeDraftRules: false,
  similarFailureLimit: 3,
  bootstrapOnStart: false,
  refreshOnPreflight: false,
  bootstrapCodexSandbox: "inherit",
};
const DEFAULT_TRACKER_IMAGE_CONTEXT_CONFIG: TrackerImageContextConfig = {
  enabled: true,
  maxCount: 5,
  maxBytes: 10 * 1024 * 1024,
};
const DEFAULT_CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS = 1;
const PROJECT_MANAGER_MAX_GOALS_PER_RUN_LIMIT = 20;
const PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL_LIMIT = 20;
const DEFAULT_PROJECT_MANAGER_CONFIG: ProjectManagerConfig = {
  enabled: false,
  runOnce: false,
  intervalMinutes: 1440,
  maxGoalsPerRun: 5,
  maxTaskProposalsPerGoal: 5,
  defaultAutonomyLevel: "proposal_only",
  autoApproveLowRisk: false,
  allowedTaskTypes: ["documentation", "tests_only", "dependency_update"],
  repositoryScanEnabled: false,
  repositoryScanMaxFiles: 200,
  requireHumanGoalApproval: true,
};

const requireEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigurationError(`Missing required environment variable: ${key}`);
  }
  return value;
};

const parsePositiveInt = (input: string, key: string): number => {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${key} must be a positive integer.`);
  }
  return value;
};

const assertPositiveIntAtMost = (
  value: number,
  key: string,
  maxValue: number,
): number => {
  if (value > maxValue) {
    throw new ConfigurationError(`${key} must be at most ${maxValue}.`);
  }
  return value;
};

const parsePositiveIntAtMost = (
  input: string,
  key: string,
  maxValue: number,
): number => assertPositiveIntAtMost(parsePositiveInt(input, key), key, maxValue);

const parseOptionalPercent = (
  input: string | undefined,
  key: string,
): number | undefined => {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }

  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConfigurationError(`${key} must be a number from 0 to 100.`);
  }

  return value;
};

const parsePercentInt = (input: string, key: string): number => {
  const value = Number.parseInt(input, 10);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new ConfigurationError(`${key} must be an integer from 0 to 100.`);
  }

  return value;
};

const parseBooleanFlag = (
  input: string | undefined,
  key: string,
  defaultValue: boolean,
): boolean => {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }

  throw new ConfigurationError(`${key} must be one of: true, false, 1, 0, yes, no.`);
};

const parseTaskTrackerProvider = (
  input: string | undefined,
): TaskTrackerConfig["provider"] => {
  const normalized = input?.trim() || "yandex";
  if (normalized === "yandex" || normalized === "internal") {
    return normalized;
  }

  throw new ConfigurationError("TASK_TRACKER_PROVIDER must be one of: yandex, internal.");
};

const parseTaskIntakeMode = (
  input: string | undefined,
  key = "TASK_INTAKE_MODE",
): TaskIntakeMode => {
  const normalized = input?.trim() || "standalone";
  if (
    normalized === "standalone" ||
    normalized === "yandex_integration" ||
    normalized === "hybrid" ||
    normalized === "system_only" ||
    normalized === "ai_proposed"
  ) {
    return normalized;
  }

  throw new ConfigurationError(
    `${key} must be one of: standalone, yandex_integration, hybrid, system_only, ai_proposed.`,
  );
};

const parseTaskTrackerStorage = (
  input: string | undefined,
  key = "TASK_TRACKER_STORAGE",
): "postgres" | "memory" => {
  const normalized = input?.trim() || "postgres";
  if (normalized === "postgres" || normalized === "memory") {
    return normalized;
  }

  throw new ConfigurationError(`${key} must be one of: postgres, memory.`);
};

const parseTaskTrackerOperationalConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
) => {
  const retention = optionalRecord(rawValue?.retention, "taskTracker.retention");
  const cleanup = optionalRecord(rawValue?.cleanup, "taskTracker.cleanup");
  const rawLogDays = env.TASK_TRACKER_RETENTION_RAW_LOG_DAYS?.trim()
    ? parsePositiveInt(
        env.TASK_TRACKER_RETENTION_RAW_LOG_DAYS,
        "TASK_TRACKER_RETENTION_RAW_LOG_DAYS",
      )
    : optionalPositiveInt(
        retention?.rawLogDays,
        "taskTracker.retention.rawLogDays",
        DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.retention.rawLogDays,
      );
  const artifactDays = env.TASK_TRACKER_RETENTION_ARTIFACT_DAYS?.trim()
    ? parsePositiveInt(
        env.TASK_TRACKER_RETENTION_ARTIFACT_DAYS,
        "TASK_TRACKER_RETENTION_ARTIFACT_DAYS",
      )
    : optionalPositiveInt(
        retention?.artifactDays,
        "taskTracker.retention.artifactDays",
        DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.retention.artifactDays,
      );
  const failedArtifactDays = env.TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS?.trim()
    ? parsePositiveInt(
        env.TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS,
        "TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS",
      )
    : optionalPositiveInt(
        retention?.failedArtifactDays,
        "taskTracker.retention.failedArtifactDays",
        DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.retention.failedArtifactDays,
      );
  const historyDays = env.TASK_TRACKER_RETENTION_HISTORY_DAYS?.trim()
    ? parsePositiveInt(
        env.TASK_TRACKER_RETENTION_HISTORY_DAYS,
        "TASK_TRACKER_RETENTION_HISTORY_DAYS",
      )
    : optionalPositiveInt(
        retention?.historyDays,
        "taskTracker.retention.historyDays",
        DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.retention.historyDays,
      );

  if (historyDays < 365) {
    throw new ConfigurationError(
      "TASK_TRACKER_RETENTION_HISTORY_DAYS must be at least 365 days.",
    );
  }
  if (failedArtifactDays < artifactDays) {
    throw new ConfigurationError(
      "TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS must be greater than or equal to TASK_TRACKER_RETENTION_ARTIFACT_DAYS.",
    );
  }

  return {
    retention: {
      rawLogDays,
      artifactDays,
      failedArtifactDays,
      historyDays,
    },
    cleanup: {
      enabled: env.TASK_TRACKER_CLEANUP_ENABLED?.trim()
        ? parseBooleanFlag(
            env.TASK_TRACKER_CLEANUP_ENABLED,
            "TASK_TRACKER_CLEANUP_ENABLED",
            DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.cleanup.enabled,
          )
        : optionalBoolean(
            cleanup?.enabled,
            "taskTracker.cleanup.enabled",
            DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.cleanup.enabled,
          ),
      intervalSeconds: env.TASK_TRACKER_CLEANUP_INTERVAL_SECONDS?.trim()
        ? parsePositiveInt(
            env.TASK_TRACKER_CLEANUP_INTERVAL_SECONDS,
            "TASK_TRACKER_CLEANUP_INTERVAL_SECONDS",
          )
        : optionalPositiveInt(
            cleanup?.intervalSeconds,
            "taskTracker.cleanup.intervalSeconds",
            DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.cleanup.intervalSeconds,
          ),
    },
    metricsEnabled: env.TASK_TRACKER_METRICS_ENABLED?.trim()
      ? parseBooleanFlag(
          env.TASK_TRACKER_METRICS_ENABLED,
          "TASK_TRACKER_METRICS_ENABLED",
          DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.metricsEnabled,
        )
      : optionalBoolean(
          rawValue?.metricsEnabled,
          "taskTracker.metricsEnabled",
          DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.metricsEnabled,
        ),
    redactionEnabled: env.TASK_TRACKER_REDACTION_ENABLED?.trim()
      ? parseBooleanFlag(
          env.TASK_TRACKER_REDACTION_ENABLED,
          "TASK_TRACKER_REDACTION_ENABLED",
          DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.redactionEnabled,
        )
      : optionalBoolean(
          rawValue?.redactionEnabled,
          "taskTracker.redactionEnabled",
          DEFAULT_TASK_TRACKER_OPERATIONAL_CONFIG.redactionEnabled,
        ),
  };
};

const validatePostgresUrl = (input: string, key: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (error) {
    throw new ConfigurationError(
      `${key} must be a valid PostgreSQL URL. ${(error as Error).message}`,
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ConfigurationError(`${key} must use the postgres:// or postgresql:// protocol.`);
  }

  return input;
};

const isTestOrLocalSmokeConfig = (env: NodeJS.ProcessEnv): boolean => {
  if (env.NODE_ENV?.trim().toLowerCase() === "test") {
    return true;
  }

  return parseBooleanFlag(
    env.TASK_TRACKER_LOCAL_SMOKE,
    "TASK_TRACKER_LOCAL_SMOKE",
    false,
  );
};

const parseCodexSandbox = (
  input?: string,
): CodexSandbox => {
  const normalized = input?.trim();
  if (!normalized) {
    return "danger-full-access";
  }

  if (
    normalized === "read-only" ||
    normalized === "workspace-write" ||
    normalized === "danger-full-access"
  ) {
    return normalized;
  }

  throw new ConfigurationError(
    "CODEX_SANDBOX must be one of: read-only, workspace-write, danger-full-access.",
  );
};

const parseMemoryBootstrapCodexSandbox = (
  input: string | undefined,
  key: string,
): MemoryBootstrapCodexSandbox => {
  const normalized = input?.trim();
  if (!normalized) {
    return DEFAULT_MEMORY_CONFIG.bootstrapCodexSandbox;
  }

  if (normalized === "inherit") {
    return normalized;
  }

  if (
    normalized === "read-only" ||
    normalized === "workspace-write" ||
    normalized === "danger-full-access"
  ) {
    return normalized;
  }

  throw new ConfigurationError(
    `${key} must be one of: inherit, read-only, workspace-write, danger-full-access.`,
  );
};

const parseTaskMode = (input: string | undefined, key = "TASK_MODE"): WorkerTaskMode => {
  const normalized = input?.trim();
  if (!normalized) {
    return DEFAULT_TASK_MODE;
  }

  if (
    normalized === "auto" ||
    normalized === "implement" ||
    normalized === "decompose" ||
    normalized === "analyze_only" ||
    normalized === "human"
  ) {
    return normalized;
  }

  throw new ConfigurationError(
    `${key} must be one of: auto, implement, decompose, analyze_only, human.`,
  );
};

const TASK_TYPE_VALUES = [
  "frontend_ui_fix",
  "backend_endpoint",
  "tests_only",
  "refactor",
  "dependency_update",
  "documentation",
  "unknown",
] as const;

const parseTaskTypeArray = (
  value: unknown,
  key: string,
  defaultValue: AutonomyPolicyConfig["defaultAllowedTaskTypes"],
): AutonomyPolicyConfig["defaultAllowedTaskTypes"] => {
  if (value === undefined || value === null) {
    return [...defaultValue];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ConfigurationError(`${key} must be an array of task type strings.`);
  }
  const values = value.map((entry) => entry.trim()).filter(Boolean);
  for (const taskType of values) {
    if (!TASK_TYPE_VALUES.includes(taskType as any)) {
      throw new ConfigurationError(
        `${key} contains unsupported task type "${taskType}".`,
      );
    }
  }
  return values as AutonomyPolicyConfig["defaultAllowedTaskTypes"];
};

const parseTaskTypeArrayEnv = (
  input: string | undefined,
  key: string,
  defaultValue: AutonomyPolicyConfig["defaultAllowedTaskTypes"],
): AutonomyPolicyConfig["defaultAllowedTaskTypes"] => {
  if (!input?.trim()) {
    return [...defaultValue];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new ConfigurationError(`${key} must be valid JSON. ${(error as Error).message}`);
  }
  return parseTaskTypeArray(parsed, key, defaultValue);
};

const parseAutonomyLevel = (
  input: string | undefined,
  key: string,
  defaultValue: ProjectManagerConfig["defaultAutonomyLevel"],
): ProjectManagerConfig["defaultAutonomyLevel"] => {
  const normalized = input?.trim();
  if (!normalized) {
    return defaultValue;
  }

  if (
    normalized === "proposal_only" ||
    normalized === "auto_triage" ||
    normalized === "auto_execute_low_risk"
  ) {
    return normalized;
  }

  throw new ConfigurationError(
    `${key} must be one of: proposal_only, auto_triage, auto_execute_low_risk.`,
  );
};

const parseOptionalRepositoryAutonomyPolicy = (
  value: unknown,
  path: string,
): RepositoryAutonomyPolicyConfig | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = asRecord(value, path);
  return {
    ...(raw.proposalsEnabled !== undefined
      ? {
          proposalsEnabled: optionalBoolean(
            raw.proposalsEnabled,
            `${path}.proposalsEnabled`,
            true,
          ),
        }
      : {}),
    ...(raw.autoExecuteLowRiskEnabled !== undefined
      ? {
          autoExecuteLowRiskEnabled: optionalBoolean(
            raw.autoExecuteLowRiskEnabled,
            `${path}.autoExecuteLowRiskEnabled`,
            false,
          ),
        }
      : {}),
    ...(raw.allowedTaskTypes !== undefined
      ? {
          allowedTaskTypes: parseTaskTypeArray(
            raw.allowedTaskTypes,
            `${path}.allowedTaskTypes`,
            DEFAULT_AUTONOMY_POLICY_CONFIG.defaultAllowedTaskTypes,
          ),
        }
      : {}),
    ...(raw.dailyProposalLimit !== undefined
      ? {
          dailyProposalLimit: optionalPositiveInt(
            raw.dailyProposalLimit,
            `${path}.dailyProposalLimit`,
            DEFAULT_AUTONOMY_POLICY_CONFIG.defaultDailyProposalLimit,
          ),
        }
      : {}),
    ...(raw.windowProposalLimit !== undefined
      ? {
          windowProposalLimit: optionalPositiveInt(
            raw.windowProposalLimit,
            `${path}.windowProposalLimit`,
            DEFAULT_AUTONOMY_POLICY_CONFIG.defaultWindowProposalLimit,
          ),
        }
      : {}),
    ...(raw.windowSeconds !== undefined
      ? {
          windowSeconds: optionalPositiveInt(
            raw.windowSeconds,
            `${path}.windowSeconds`,
            DEFAULT_AUTONOMY_POLICY_CONFIG.defaultWindowSeconds,
          ),
        }
      : {}),
  };
};

const parseAutonomyConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
  repositories: RepositoryProfile[] = [],
): AutonomyPolicyConfig => {
  const rawRepositories = optionalRecord(rawValue?.repositories, "autonomy.repositories");
  const repositoryPolicies: Record<string, RepositoryAutonomyPolicyConfig> = {};
  if (rawRepositories) {
    for (const [repositoryName, value] of Object.entries(rawRepositories)) {
      const policy = parseOptionalRepositoryAutonomyPolicy(
        value,
        `autonomy.repositories.${repositoryName}`,
      );
      if (policy) {
        repositoryPolicies[repositoryName] = policy;
      }
    }
  }
  for (const repository of repositories) {
    if (repository.autonomy) {
      repositoryPolicies[repository.name] = {
        ...(repositoryPolicies[repository.name] ?? {}),
        ...repository.autonomy,
      };
    }
  }

  return {
    aiProposalsEnabled: env.AI_PROPOSALS_ENABLED?.trim()
      ? parseBooleanFlag(
          env.AI_PROPOSALS_ENABLED,
          "AI_PROPOSALS_ENABLED",
          DEFAULT_AUTONOMY_POLICY_CONFIG.aiProposalsEnabled,
        )
      : optionalBoolean(
          rawValue?.aiProposalsEnabled,
          "autonomy.aiProposalsEnabled",
          DEFAULT_AUTONOMY_POLICY_CONFIG.aiProposalsEnabled,
        ),
    autoExecuteLowRiskEnabled: env.AUTO_EXECUTE_LOW_RISK_ENABLED?.trim()
      ? parseBooleanFlag(
          env.AUTO_EXECUTE_LOW_RISK_ENABLED,
          "AUTO_EXECUTE_LOW_RISK_ENABLED",
          DEFAULT_AUTONOMY_POLICY_CONFIG.autoExecuteLowRiskEnabled,
        )
      : optionalBoolean(
          rawValue?.autoExecuteLowRiskEnabled,
          "autonomy.autoExecuteLowRiskEnabled",
          DEFAULT_AUTONOMY_POLICY_CONFIG.autoExecuteLowRiskEnabled,
        ),
    defaultAllowedTaskTypes: env.AI_PROPOSAL_ALLOWED_TASK_TYPES_JSON?.trim()
      ? parseTaskTypeArrayEnv(
          env.AI_PROPOSAL_ALLOWED_TASK_TYPES_JSON,
          "AI_PROPOSAL_ALLOWED_TASK_TYPES_JSON",
          DEFAULT_AUTONOMY_POLICY_CONFIG.defaultAllowedTaskTypes,
        )
      : parseTaskTypeArray(
          rawValue?.defaultAllowedTaskTypes,
          "autonomy.defaultAllowedTaskTypes",
          DEFAULT_AUTONOMY_POLICY_CONFIG.defaultAllowedTaskTypes,
        ),
    defaultDailyProposalLimit: env.AI_PROPOSAL_DAILY_LIMIT?.trim()
      ? parsePositiveInt(env.AI_PROPOSAL_DAILY_LIMIT, "AI_PROPOSAL_DAILY_LIMIT")
      : optionalPositiveInt(
          rawValue?.defaultDailyProposalLimit,
          "autonomy.defaultDailyProposalLimit",
          DEFAULT_AUTONOMY_POLICY_CONFIG.defaultDailyProposalLimit,
        ),
    defaultWindowProposalLimit: env.AI_PROPOSAL_WINDOW_LIMIT?.trim()
      ? parsePositiveInt(env.AI_PROPOSAL_WINDOW_LIMIT, "AI_PROPOSAL_WINDOW_LIMIT")
      : optionalPositiveInt(
          rawValue?.defaultWindowProposalLimit,
          "autonomy.defaultWindowProposalLimit",
          DEFAULT_AUTONOMY_POLICY_CONFIG.defaultWindowProposalLimit,
        ),
    defaultWindowSeconds: env.AI_PROPOSAL_WINDOW_SECONDS?.trim()
      ? parsePositiveInt(env.AI_PROPOSAL_WINDOW_SECONDS, "AI_PROPOSAL_WINDOW_SECONDS")
      : optionalPositiveInt(
          rawValue?.defaultWindowSeconds,
          "autonomy.defaultWindowSeconds",
          DEFAULT_AUTONOMY_POLICY_CONFIG.defaultWindowSeconds,
        ),
    repositories: repositoryPolicies,
  };
};

const parseDependencyUnknownStatusPolicy = (
  input: string | undefined,
  key = "DEPENDENCY_UNKNOWN_STATUS_POLICY",
): DependencyUnknownStatusPolicy => {
  const normalized = input?.trim();
  if (!normalized) {
    return DEFAULT_DEPENDENCY_UNKNOWN_STATUS_POLICY;
  }

  if (normalized === "block" || normalized === "warn" || normalized === "ignore") {
    return normalized;
  }

  throw new ConfigurationError(`${key} must be one of: block, warn, ignore.`);
};

const parseStringArray = (input: string | undefined, key: string): string[] => {
  if (!input?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new ConfigurationError(
      `${key} must be valid JSON. ${(error as Error).message}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new ConfigurationError(`${key} must be a JSON array of strings.`);
  }

  return parsed.map((entry) => entry.trim()).filter(Boolean);
};

const parseConfigDocument = (path: string): unknown => {
  let rawValue: string;
  try {
    rawValue = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigurationError(
      `Unable to read WORKER_CONFIG_FILE at ${path}. ${(error as Error).message}`,
    );
  }

  try {
    if (extname(path).toLowerCase() === ".json") {
      return JSON.parse(rawValue);
    }

    return parseYaml(rawValue);
  } catch (error) {
    throw new ConfigurationError(
      `WORKER_CONFIG_FILE must contain valid JSON or YAML. ${(error as Error).message}`,
    );
  }
};

const asRecord = (value: unknown, key: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${key} must be an object.`);
  }

  return value as Record<string, unknown>;
};

const optionalRecord = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return asRecord(value, key);
};

const optionalString = (value: unknown, key: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ConfigurationError(`${key} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed || undefined;
};

const requiredString = (value: unknown, key: string): string => {
  const parsed = optionalString(value, key);
  if (!parsed) {
    throw new ConfigurationError(`${key} is required.`);
  }

  return parsed;
};

const optionalBoolean = (
  value: unknown,
  key: string,
  defaultValue: boolean,
): boolean => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "boolean") {
    throw new ConfigurationError(`${key} must be a boolean.`);
  }

  return value;
};

const parseTaskTrackerConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
): TaskTrackerConfig => {
  const provider = parseTaskTrackerProvider(
    env.TASK_TRACKER_PROVIDER ?? optionalString(rawValue?.provider, "taskTracker.provider"),
  );
  const rawIntakeMode =
    env.TASK_INTAKE_MODE ?? optionalString(rawValue?.intakeMode, "taskTracker.intakeMode");
  const rawStorage =
    env.TASK_TRACKER_STORAGE ?? optionalString(rawValue?.storage, "taskTracker.storage");
  const operational = parseTaskTrackerOperationalConfig(env, rawValue);

  if (provider === "yandex") {
    if (rawIntakeMode !== undefined) {
      parseTaskIntakeMode(rawIntakeMode);
    }
    if (rawStorage !== undefined) {
      parseTaskTrackerStorage(rawStorage);
    }
    return { provider };
  }

  const intakeMode = parseTaskIntakeMode(rawIntakeMode);
  const yandexSyncEnabled = env.YANDEX_SYNC_ENABLED?.trim()
    ? parseBooleanFlag(env.YANDEX_SYNC_ENABLED, "YANDEX_SYNC_ENABLED", false)
    : optionalBoolean(rawValue?.yandexSyncEnabled, "taskTracker.yandexSyncEnabled", false);

  if (
    yandexSyncEnabled &&
    intakeMode !== "yandex_integration" &&
    intakeMode !== "hybrid"
  ) {
    throw new ConfigurationError(
      "YANDEX_SYNC_ENABLED=true requires TASK_INTAKE_MODE=yandex_integration or hybrid.",
    );
  }

  if (
    !yandexSyncEnabled &&
    (intakeMode === "yandex_integration" || intakeMode === "hybrid")
  ) {
    throw new ConfigurationError(
      "YANDEX_SYNC_ENABLED=false is only valid with TASK_INTAKE_MODE=standalone, system_only, or ai_proposed.",
    );
  }

  const storage = parseTaskTrackerStorage(rawStorage);
  const databaseUrl =
    env.TASK_TRACKER_DATABASE_URL?.trim() ||
    optionalString(rawValue?.databaseUrl, "taskTracker.databaseUrl");

  if (storage === "memory") {
    if (!isTestOrLocalSmokeConfig(env)) {
      throw new ConfigurationError(
        "TASK_TRACKER_STORAGE=memory is allowed only with NODE_ENV=test or TASK_TRACKER_LOCAL_SMOKE=true.",
      );
    }

    return {
      provider,
      internal: {
        storage,
        ...(databaseUrl ? { databaseUrl } : {}),
        intakeMode,
        yandexSyncEnabled,
        operational,
      },
    };
  }

  if (!databaseUrl) {
    throw new ConfigurationError(
      "TASK_TRACKER_PROVIDER=internal requires TASK_TRACKER_DATABASE_URL unless TASK_TRACKER_STORAGE=memory is explicitly enabled for test/local smoke.",
    );
  }

  return {
    provider,
    internal: {
      storage,
      databaseUrl: validatePostgresUrl(databaseUrl, "TASK_TRACKER_DATABASE_URL"),
      intakeMode,
      yandexSyncEnabled,
      operational,
    },
  };
};

const taskTrackerUsesYandex = (taskTracker: TaskTrackerConfig): boolean =>
  taskTracker.provider === "yandex" ||
  (taskTracker.provider === "internal" && taskTracker.internal.yandexSyncEnabled);

const optionalPositiveInt = (
  value: unknown,
  key: string,
  defaultValue: number,
): number => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${key} must be a positive integer.`);
  }

  return value;
};

const parseTrackerImageContextConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
): TrackerImageContextConfig => {
  const tempDir = env.TRACKER_IMAGE_CONTEXT_TEMP_DIR?.trim()
    ? env.TRACKER_IMAGE_CONTEXT_TEMP_DIR.trim()
    : optionalString(rawValue?.tempDir, "trackerImageContext.tempDir");

  return {
    enabled: env.TRACKER_IMAGE_CONTEXT_ENABLED?.trim()
      ? parseBooleanFlag(
          env.TRACKER_IMAGE_CONTEXT_ENABLED,
          "TRACKER_IMAGE_CONTEXT_ENABLED",
          DEFAULT_TRACKER_IMAGE_CONTEXT_CONFIG.enabled,
        )
      : optionalBoolean(
          rawValue?.enabled,
          "trackerImageContext.enabled",
          DEFAULT_TRACKER_IMAGE_CONTEXT_CONFIG.enabled,
        ),
    maxCount: env.TRACKER_IMAGE_CONTEXT_MAX_COUNT?.trim()
      ? parsePositiveInt(
          env.TRACKER_IMAGE_CONTEXT_MAX_COUNT,
          "TRACKER_IMAGE_CONTEXT_MAX_COUNT",
        )
      : optionalPositiveInt(
          rawValue?.maxCount,
          "trackerImageContext.maxCount",
          DEFAULT_TRACKER_IMAGE_CONTEXT_CONFIG.maxCount,
        ),
    maxBytes: env.TRACKER_IMAGE_CONTEXT_MAX_BYTES?.trim()
      ? parsePositiveInt(
          env.TRACKER_IMAGE_CONTEXT_MAX_BYTES,
          "TRACKER_IMAGE_CONTEXT_MAX_BYTES",
        )
      : optionalPositiveInt(
          rawValue?.maxBytes,
          "trackerImageContext.maxBytes",
          DEFAULT_TRACKER_IMAGE_CONTEXT_CONFIG.maxBytes,
        ),
    ...(tempDir ? { tempDir } : {}),
  };
};

const optionalNumber = (
  value: unknown,
  key: string,
  defaultValue: number,
): number => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigurationError(`${key} must be a number.`);
  }

  return value;
};

const optionalMemoryBootstrapCodexSandbox = (
  value: unknown,
  key: string,
  defaultValue: MemoryBootstrapCodexSandbox,
): MemoryBootstrapCodexSandbox => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "string") {
    throw new ConfigurationError(`${key} must be a string.`);
  }

  return parseMemoryBootstrapCodexSandbox(value, key);
};

const optionalPercentIntValue = (
  value: unknown,
  key: string,
  defaultValue: number,
): number => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new ConfigurationError(`${key} must be an integer from 0 to 100.`);
  }

  return value;
};

const optionalPositiveIntAtMost = (
  value: unknown,
  key: string,
  defaultValue: number,
  maxValue: number,
): number =>
  assertPositiveIntAtMost(optionalPositiveInt(value, key, defaultValue), key, maxValue);

const optionalAutonomyLevel = (
  value: unknown,
  key: string,
  defaultValue: ProjectManagerConfig["defaultAutonomyLevel"],
): ProjectManagerConfig["defaultAutonomyLevel"] => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "string") {
    throw new ConfigurationError(`${key} must be a string.`);
  }

  return parseAutonomyLevel(value, key, defaultValue);
};

const optionalStringArrayValue = (
  value: unknown,
  key: string,
  defaultValue: string[],
): string[] => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ConfigurationError(`${key} must be an array of strings.`);
  }

  return value.map((entry) => entry.trim()).filter(Boolean);
};

const parseStringArrayEnv = (
  input: string | undefined,
  key: string,
  defaultValue: string[],
): string[] => {
  if (!input?.trim()) {
    return [...defaultValue];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new ConfigurationError(`${key} must be valid JSON. ${(error as Error).message}`);
  }

  return optionalStringArrayValue(parsed, key, defaultValue);
};

const optionalNumberRecord = (
  value: unknown,
  key: string,
  defaultValue: Record<string, number>,
): Record<string, number> => {
  if (value === undefined || value === null) {
    return { ...defaultValue };
  }

  const record = asRecord(value, key);
  const result: Record<string, number> = {};
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (typeof entryValue !== "number" || !Number.isFinite(entryValue)) {
      throw new ConfigurationError(`${key}.${entryKey} must be a number.`);
    }
    result[entryKey.toLowerCase()] = entryValue;
  }
  return result;
};

const parsePromptProfileOverrides = (
  value: unknown,
  path: string,
): PromptProfileOverrideMap | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const raw = asRecord(value, path);
  const result: PromptProfileOverrideMap = {};
  for (const [profileId, profileValue] of Object.entries(raw)) {
    const profilePath = `${path}.${profileId}`;
    const profile = asRecord(profileValue, profilePath);
    result[profileId] = {
      matchHints: optionalStringArrayValue(
        profile.matchHints,
        `${profilePath}.matchHints`,
        [],
      ),
      implementationInstructions: optionalStringArrayValue(
        profile.implementationInstructions,
        `${profilePath}.implementationInstructions`,
        [],
      ),
      validationFocus: optionalStringArrayValue(
        profile.validationFocus,
        `${profilePath}.validationFocus`,
        [],
      ),
      riskChecklist: optionalStringArrayValue(
        profile.riskChecklist,
        `${profilePath}.riskChecklist`,
        [],
      ),
    };
  }

  return result;
};

const parseRepositoryDecompositionConfig = (
  value: unknown,
  path: string,
): RepositoryDecompositionConfig | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const raw = asRecord(value, path);
  const maxSubtasks =
    raw.maxSubtasks === undefined
      ? undefined
      : optionalPositiveInt(raw.maxSubtasks, `${path}.maxSubtasks`, 1);

  return {
    ...(optionalString(raw.defaultSubtaskTag, `${path}.defaultSubtaskTag`)
      ? {
          defaultSubtaskTag: optionalString(
            raw.defaultSubtaskTag,
            `${path}.defaultSubtaskTag`,
          ),
        }
      : {}),
    ...(optionalString(raw.subtaskTitlePrefix, `${path}.subtaskTitlePrefix`)
      ? {
          subtaskTitlePrefix: optionalString(
            raw.subtaskTitlePrefix,
            `${path}.subtaskTitlePrefix`,
          ),
        }
      : {}),
    ...(maxSubtasks !== undefined ? { maxSubtasks } : {}),
  };
};

const parseProjectManagerConfig = (
  env: NodeJS.ProcessEnv,
  rawValue: Record<string, unknown> | undefined,
  taskTracker: TaskTrackerConfig,
): ProjectManagerConfig => {
  const enabled = env.PROJECT_MANAGER_ENABLED?.trim()
    ? parseBooleanFlag(
        env.PROJECT_MANAGER_ENABLED,
        "PROJECT_MANAGER_ENABLED",
        DEFAULT_PROJECT_MANAGER_CONFIG.enabled,
      )
    : optionalBoolean(
        rawValue?.enabled,
        "projectManager.enabled",
        DEFAULT_PROJECT_MANAGER_CONFIG.enabled,
      );

  if (enabled && taskTracker.provider !== "internal") {
    throw new ConfigurationError(
      "PROJECT_MANAGER_ENABLED=true requires TASK_TRACKER_PROVIDER=internal.",
    );
  }

  return {
    enabled,
    ...(env.PROJECT_MANAGER_FOCUS_AREAS_JSON?.trim()
      ? {
          focusAreas: parseStringArrayEnv(
            env.PROJECT_MANAGER_FOCUS_AREAS_JSON,
            "PROJECT_MANAGER_FOCUS_AREAS_JSON",
            [],
          ),
        }
      : rawValue?.focusAreas !== undefined
        ? {
            focusAreas: optionalStringArrayValue(
              rawValue.focusAreas,
              "projectManager.focusAreas",
              [],
            ),
          }
        : {}),
    runOnce: env.PROJECT_MANAGER_RUN_ONCE?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_RUN_ONCE,
          "PROJECT_MANAGER_RUN_ONCE",
          DEFAULT_PROJECT_MANAGER_CONFIG.runOnce,
        )
      : optionalBoolean(
          rawValue?.runOnce,
          "projectManager.runOnce",
          DEFAULT_PROJECT_MANAGER_CONFIG.runOnce,
        ),
    intervalMinutes: env.PROJECT_MANAGER_INTERVAL_MINUTES?.trim()
      ? parsePositiveInt(
          env.PROJECT_MANAGER_INTERVAL_MINUTES,
          "PROJECT_MANAGER_INTERVAL_MINUTES",
        )
      : optionalPositiveInt(
          rawValue?.intervalMinutes,
          "projectManager.intervalMinutes",
          DEFAULT_PROJECT_MANAGER_CONFIG.intervalMinutes,
        ),
    maxGoalsPerRun: env.PROJECT_MANAGER_MAX_GOALS_PER_RUN?.trim()
      ? parsePositiveIntAtMost(
          env.PROJECT_MANAGER_MAX_GOALS_PER_RUN,
          "PROJECT_MANAGER_MAX_GOALS_PER_RUN",
          PROJECT_MANAGER_MAX_GOALS_PER_RUN_LIMIT,
        )
      : optionalPositiveIntAtMost(
          rawValue?.maxGoalsPerRun,
          "projectManager.maxGoalsPerRun",
          DEFAULT_PROJECT_MANAGER_CONFIG.maxGoalsPerRun,
          PROJECT_MANAGER_MAX_GOALS_PER_RUN_LIMIT,
        ),
    maxTaskProposalsPerGoal: env.PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL?.trim()
      ? parsePositiveIntAtMost(
          env.PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL,
          "PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL",
          PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL_LIMIT,
        )
      : optionalPositiveIntAtMost(
          rawValue?.maxTaskProposalsPerGoal,
          "projectManager.maxTaskProposalsPerGoal",
          DEFAULT_PROJECT_MANAGER_CONFIG.maxTaskProposalsPerGoal,
          PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL_LIMIT,
        ),
    defaultAutonomyLevel: env.PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL?.trim()
      ? parseAutonomyLevel(
          env.PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL,
          "PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL",
          DEFAULT_PROJECT_MANAGER_CONFIG.defaultAutonomyLevel,
        )
      : optionalAutonomyLevel(
          rawValue?.defaultAutonomyLevel,
          "projectManager.defaultAutonomyLevel",
          DEFAULT_PROJECT_MANAGER_CONFIG.defaultAutonomyLevel,
        ),
    autoApproveLowRisk: env.PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK,
          "PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK",
          DEFAULT_PROJECT_MANAGER_CONFIG.autoApproveLowRisk,
        )
      : optionalBoolean(
          rawValue?.autoApproveLowRisk,
          "projectManager.autoApproveLowRisk",
          DEFAULT_PROJECT_MANAGER_CONFIG.autoApproveLowRisk,
        ),
    allowedTaskTypes: env.PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON?.trim()
      ? parseTaskTypeArrayEnv(
          env.PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON,
          "PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON",
          DEFAULT_PROJECT_MANAGER_CONFIG.allowedTaskTypes,
        )
      : parseTaskTypeArray(
          rawValue?.allowedTaskTypes,
          "projectManager.allowedTaskTypes",
          DEFAULT_PROJECT_MANAGER_CONFIG.allowedTaskTypes,
        ),
    repositoryScanEnabled: env.PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED,
          "PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED",
          DEFAULT_PROJECT_MANAGER_CONFIG.repositoryScanEnabled,
        )
      : optionalBoolean(
          rawValue?.repositoryScanEnabled,
          "projectManager.repositoryScanEnabled",
          DEFAULT_PROJECT_MANAGER_CONFIG.repositoryScanEnabled,
        ),
    repositoryScanMaxFiles: env.PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES?.trim()
      ? parsePositiveInt(
          env.PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES,
          "PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES",
        )
      : optionalPositiveInt(
          rawValue?.repositoryScanMaxFiles,
          "projectManager.repositoryScanMaxFiles",
          DEFAULT_PROJECT_MANAGER_CONFIG.repositoryScanMaxFiles,
        ),
    requireHumanGoalApproval: env.PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL,
          "PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL",
          DEFAULT_PROJECT_MANAGER_CONFIG.requireHumanGoalApproval,
        )
      : optionalBoolean(
          rawValue?.requireHumanGoalApproval,
          "projectManager.requireHumanGoalApproval",
          DEFAULT_PROJECT_MANAGER_CONFIG.requireHumanGoalApproval,
        ),
  };
};

const parseRepositoryProjectManagerConfig = (
  value: unknown,
  path: string,
): RepositoryProjectManagerConfig | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const raw = asRecord(value, path);
  return {
    ...(raw.enabled !== undefined
      ? { enabled: optionalBoolean(raw.enabled, `${path}.enabled`, false) }
      : {}),
    ...(raw.focusAreas !== undefined
      ? {
          focusAreas: optionalStringArrayValue(raw.focusAreas, `${path}.focusAreas`, []),
        }
      : {}),
    ...(raw.allowedTaskTypes !== undefined
      ? {
          allowedTaskTypes: parseTaskTypeArray(
            raw.allowedTaskTypes,
            `${path}.allowedTaskTypes`,
            DEFAULT_PROJECT_MANAGER_CONFIG.allowedTaskTypes,
          ),
        }
      : {}),
    ...(raw.maxGoalsPerRun !== undefined
      ? {
          maxGoalsPerRun: optionalPositiveIntAtMost(
            raw.maxGoalsPerRun,
            `${path}.maxGoalsPerRun`,
            DEFAULT_PROJECT_MANAGER_CONFIG.maxGoalsPerRun,
            PROJECT_MANAGER_MAX_GOALS_PER_RUN_LIMIT,
          ),
        }
      : {}),
    ...(raw.maxTaskProposalsPerGoal !== undefined
      ? {
          maxTaskProposalsPerGoal: optionalPositiveIntAtMost(
            raw.maxTaskProposalsPerGoal,
            `${path}.maxTaskProposalsPerGoal`,
            DEFAULT_PROJECT_MANAGER_CONFIG.maxTaskProposalsPerGoal,
            PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL_LIMIT,
          ),
        }
      : {}),
  };
};

const assertProjectManagerProviderCompatibility = (
  taskTracker: TaskTrackerConfig,
  projectManager: ProjectManagerConfig,
  repositories: RepositoryProfile[] = [],
): void => {
  const repositoryProjectManagerEnabled = repositories.some(
    (repository) => repository.projectManager?.enabled === true,
  );
  if (
    taskTracker.provider !== "internal" &&
    (projectManager.enabled || repositoryProjectManagerEnabled)
  ) {
    throw new ConfigurationError(
      "PROJECT_MANAGER_ENABLED=true requires TASK_TRACKER_PROVIDER=internal.",
    );
  }
};

const resolveRepositoryProjectManagerConfig = (
  globalProjectManager: ProjectManagerConfig | undefined,
  repositoryProjectManager: RepositoryProjectManagerConfig | undefined,
): ProjectManagerConfig | undefined => {
  if (!globalProjectManager) {
    return undefined;
  }

  return {
    ...globalProjectManager,
    ...(repositoryProjectManager?.enabled !== undefined
      ? { enabled: repositoryProjectManager.enabled }
      : {}),
    ...(repositoryProjectManager?.focusAreas !== undefined
      ? { focusAreas: repositoryProjectManager.focusAreas }
      : {}),
    ...(repositoryProjectManager?.allowedTaskTypes !== undefined
      ? { allowedTaskTypes: repositoryProjectManager.allowedTaskTypes }
      : {}),
    ...(repositoryProjectManager?.maxGoalsPerRun !== undefined
      ? { maxGoalsPerRun: repositoryProjectManager.maxGoalsPerRun }
      : {}),
    ...(repositoryProjectManager?.maxTaskProposalsPerGoal !== undefined
      ? {
          maxTaskProposalsPerGoal:
            repositoryProjectManager.maxTaskProposalsPerGoal,
        }
      : {}),
  };
};

export const parseMemoryConfig = (
  env: NodeJS.ProcessEnv = process.env,
  rawValue?: Record<string, unknown>,
): MemoryConfig => {
  const refreshOnPreflightEnv =
    env.MEMORY_REFRESH_ON_PREFLIGHT ?? env.MEMORY_REFRESH_ON_PRELIGHT;

  return {
  enabled: env.MEMORY_ENABLED?.trim()
    ? parseBooleanFlag(env.MEMORY_ENABLED, "MEMORY_ENABLED", DEFAULT_MEMORY_CONFIG.enabled)
    : optionalBoolean(rawValue?.enabled, "memory.enabled", DEFAULT_MEMORY_CONFIG.enabled),
  dir:
    env.MEMORY_DIR?.trim() ||
    optionalString(rawValue?.dir, "memory.dir") ||
    DEFAULT_MEMORY_CONFIG.dir,
  maxContextChars: env.MEMORY_MAX_CONTEXT_CHARS?.trim()
    ? parsePositiveInt(env.MEMORY_MAX_CONTEXT_CHARS, "MEMORY_MAX_CONTEXT_CHARS")
    : optionalPositiveInt(
        rawValue?.maxContextChars,
        "memory.maxContextChars",
        DEFAULT_MEMORY_CONFIG.maxContextChars,
      ),
  strict: env.MEMORY_STRICT?.trim()
    ? parseBooleanFlag(env.MEMORY_STRICT, "MEMORY_STRICT", DEFAULT_MEMORY_CONFIG.strict)
    : optionalBoolean(rawValue?.strict, "memory.strict", DEFAULT_MEMORY_CONFIG.strict),
  includeDraftRules: env.MEMORY_INCLUDE_DRAFT_RULES?.trim()
    ? parseBooleanFlag(
        env.MEMORY_INCLUDE_DRAFT_RULES,
        "MEMORY_INCLUDE_DRAFT_RULES",
        DEFAULT_MEMORY_CONFIG.includeDraftRules,
      )
    : optionalBoolean(
        rawValue?.includeDraftRules,
        "memory.includeDraftRules",
        DEFAULT_MEMORY_CONFIG.includeDraftRules,
      ),
  similarFailureLimit: env.MEMORY_SIMILAR_FAILURE_LIMIT?.trim()
    ? parsePositiveInt(env.MEMORY_SIMILAR_FAILURE_LIMIT, "MEMORY_SIMILAR_FAILURE_LIMIT")
    : optionalPositiveInt(
        rawValue?.similarFailureLimit,
        "memory.similarFailureLimit",
        DEFAULT_MEMORY_CONFIG.similarFailureLimit,
      ),
  bootstrapOnStart: env.MEMORY_BOOTSTRAP_ON_START?.trim()
    ? parseBooleanFlag(
        env.MEMORY_BOOTSTRAP_ON_START,
        "MEMORY_BOOTSTRAP_ON_START",
        DEFAULT_MEMORY_CONFIG.bootstrapOnStart,
      )
    : optionalBoolean(
      rawValue?.bootstrapOnStart,
      "memory.bootstrapOnStart",
      DEFAULT_MEMORY_CONFIG.bootstrapOnStart,
    ),
  refreshOnPreflight: refreshOnPreflightEnv?.trim()
    ? parseBooleanFlag(
        refreshOnPreflightEnv,
        "MEMORY_REFRESH_ON_PREFLIGHT",
        DEFAULT_MEMORY_CONFIG.refreshOnPreflight,
      )
    : optionalBoolean(
        rawValue?.refreshOnPreflight,
        "memory.refreshOnPreflight",
        DEFAULT_MEMORY_CONFIG.refreshOnPreflight,
      ),
  bootstrapCodexSandbox: env.MEMORY_BOOTSTRAP_CODEX_SANDBOX?.trim()
    ? parseMemoryBootstrapCodexSandbox(
        env.MEMORY_BOOTSTRAP_CODEX_SANDBOX,
        "MEMORY_BOOTSTRAP_CODEX_SANDBOX",
      )
    : optionalMemoryBootstrapCodexSandbox(
        rawValue?.bootstrapCodexSandbox,
        "memory.bootstrapCodexSandbox",
        DEFAULT_MEMORY_CONFIG.bootstrapCodexSandbox,
      ),
  };
};

const resolveEnvReference = (
  env: NodeJS.ProcessEnv,
  config: Record<string, unknown> | undefined,
  valueKey: string,
  envKey: string,
  defaultEnvName: string,
  label: string,
): string => {
  const directValue = optionalString(config?.[valueKey], `${label}.${valueKey}`);
  if (directValue) {
    return directValue;
  }

  const envName = optionalString(config?.[envKey], `${label}.${envKey}`) ?? defaultEnvName;
  return requireEnv(env, envName);
};

const parseTrackerOrgHeader = (input?: string): TrackerOrgHeader => {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return "X-Cloud-Org-ID";
  }

  if (normalized === "x-org-id") {
    return "X-Org-ID";
  }

  if (normalized === "x-cloud-org-id") {
    return "X-Cloud-Org-ID";
  }

  throw new ConfigurationError(
    "TRACKER_ORG_HEADER must be either X-Org-ID or X-Cloud-Org-ID.",
  );
};

const normalizeStatusConfig = (
  rawValue: unknown,
  logicalStatus: LogicalStatus,
): TrackerStatusConfig => {
  if (typeof rawValue !== "object" || rawValue === null) {
    throw new ConfigurationError(
      `Tracker status map entry "${logicalStatus}" must be an object.`,
    );
  }

  const value = rawValue as { statuses?: unknown; transition?: unknown };
  if (!Array.isArray(value.statuses) || value.statuses.length === 0) {
    throw new ConfigurationError(
      `Tracker status map entry "${logicalStatus}.statuses" must be a non-empty array.`,
    );
  }

  const statuses = value.statuses.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigurationError(
        `Tracker status map entry "${logicalStatus}.statuses" must contain strings.`,
      );
    }
    return entry.trim();
  });

  if (value.transition !== undefined && typeof value.transition !== "string") {
    throw new ConfigurationError(
      `Tracker status map entry "${logicalStatus}.transition" must be a string.`,
    );
  }

  return {
    statuses,
    ...(value.transition ? { transition: value.transition.trim() } : {}),
  };
};

export const parseStatusMap = (
  rawValue: string,
): Record<LogicalStatus, TrackerStatusConfig> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new ConfigurationError(
      `TRACKER_STATUS_MAP_FILE must contain valid JSON. ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigurationError("TRACKER_STATUS_MAP_FILE must contain a JSON object.");
  }

  const result = {} as Record<LogicalStatus, TrackerStatusConfig>;
  for (const logicalStatus of LOGICAL_STATUSES) {
    result[logicalStatus] = normalizeStatusConfig(
      (parsed as Record<string, unknown>)[logicalStatus],
      logicalStatus,
    );
  }
  return result;
};

const loadStatusMapFromFile = (
  env: NodeJS.ProcessEnv,
): Record<LogicalStatus, TrackerStatusConfig> => {
  const path = requireEnv(env, "TRACKER_STATUS_MAP_FILE");

  let rawValue: string;
  try {
    rawValue = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigurationError(
      `Unable to read TRACKER_STATUS_MAP_FILE at ${path}. ${(error as Error).message}`,
    );
  }

  return parseStatusMap(rawValue);
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const taskTracker = parseTaskTrackerConfig(env);
  const usesYandex = taskTrackerUsesYandex(taskTracker);
  const trackerStatusMap = usesYandex
    ? loadStatusMapFromFile(env)
    : DEFAULT_INTERNAL_TRACKER_STATUS_MAP;
  const pollIntervalMinutes = parsePositiveInt(
    env.POLL_INTERVAL_MINUTES?.trim() || "30",
    "POLL_INTERVAL_MINUTES",
  );
  const maxFixAttempts = parsePositiveInt(
    requireEnv(env, "MAX_FIX_ATTEMPTS"),
    "MAX_FIX_ATTEMPTS",
  );
  const minCoveragePercent = parseOptionalPercent(
    env.MIN_COVERAGE_PERCENT,
    "MIN_COVERAGE_PERCENT",
  );
  const memory = parseMemoryConfig(env);
  const observability = parseObservabilityConfig(env);
  const autonomy = parseAutonomyConfig(env);
  const projectManager = parseProjectManagerConfig(env, undefined, taskTracker);
  assertProjectManagerProviderCompatibility(taskTracker, projectManager);
  const trackerImageContext = parseTrackerImageContextConfig(env);

  return {
    taskTracker,
    trackerToken: usesYandex
      ? requireEnv(env, "TRACKER_TOKEN")
      : env.TRACKER_TOKEN?.trim() || "",
    trackerOrgHeader: usesYandex
      ? parseTrackerOrgHeader(env.TRACKER_ORG_HEADER)
      : parseTrackerOrgHeader(undefined),
    trackerOrgId: usesYandex
      ? requireEnv(env, "TRACKER_ORG_ID")
      : env.TRACKER_ORG_ID?.trim() || "",
    trackerDefaultQueue: env.TRACKER_DEFAULT_QUEUE?.trim() || "FRONTEND",
    trackerTag: env.TRACKER_TAG?.trim() || "ai_dev",
    trackerStatusMap,
    trackerApiBaseUrl:
      env.TRACKER_API_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://api.tracker.yandex.net/v3",
    trackerImageContext,
    trackerParentLinkType:
      env.TRACKER_PARENT_LINK_TYPE?.trim() || DEFAULT_TRACKER_PARENT_LINK_TYPE,
    trackerBlockedByLinkType:
      env.TRACKER_BLOCKED_BY_LINK_TYPE?.trim() || DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE,
    gitlabUrl: requireEnv(env, "GITLAB_URL").replace(/\/+$/, ""),
    gitlabToken: requireEnv(env, "GITLAB_TOKEN"),
    gitlabProjectId: requireEnv(env, "GITLAB_PROJECT_ID"),
    gitRemoteName: env.GIT_REMOTE_NAME?.trim() || "origin",
    gitRepositoryToken:
      env.GIT_REPOSITORY_TOKEN?.trim() || requireEnv(env, "GITLAB_TOKEN"),
    gitRepositoryUsername: env.GIT_REPOSITORY_USERNAME?.trim() || "oauth2",
    ...(env.GIT_REPOSITORY_URL?.trim()
      ? { gitRepositoryUrl: env.GIT_REPOSITORY_URL.trim() }
      : {}),
    gitCommitNoVerify: parseBooleanFlag(env.GIT_COMMIT_NO_VERIFY, "GIT_COMMIT_NO_VERIFY", true),
    ...(env.GIT_AUTHOR_NAME?.trim() ? { gitAuthorName: env.GIT_AUTHOR_NAME.trim() } : {}),
    ...(env.GIT_AUTHOR_EMAIL?.trim() ? { gitAuthorEmail: env.GIT_AUTHOR_EMAIL.trim() } : {}),
    repoPath: env.REPO_PATH?.trim() || "/workspace/project",
    baseBranch: env.BASE_BRANCH?.trim() || "main",
    pollIntervalMinutes,
    pollIntervalMs: pollIntervalMinutes * 60 * 1000,
    codexHome: env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    codexCliCommand: env.CODEX_CLI_COMMAND?.trim() || "codex",
    codexCliArgs: parseStringArray(env.CODEX_CLI_ARGS_JSON, "CODEX_CLI_ARGS_JSON"),
    ...(env.CODEX_MODEL?.trim() ? { codexModel: env.CODEX_MODEL.trim() } : {}),
    ...(env.CODEX_PROFILE?.trim() ? { codexProfile: env.CODEX_PROFILE.trim() } : {}),
    codexSandbox: parseCodexSandbox(env.CODEX_SANDBOX),
    codexExecArgs: parseStringArray(env.CODEX_EXEC_ARGS_JSON, "CODEX_EXEC_ARGS_JSON"),
    codexTimeoutMs:
      parsePositiveInt(
        env.CODEX_TIMEOUT_SECONDS?.trim() || "1800",
        "CODEX_TIMEOUT_SECONDS",
      ) * 1000,
    codexProgressLogIntervalMs:
      parsePositiveInt(
        env.CODEX_PROGRESS_LOG_INTERVAL_SECONDS?.trim() || "30",
        "CODEX_PROGRESS_LOG_INTERVAL_SECONDS",
      ) * 1000,
    codexLogFullEvents: parseBooleanFlag(
      env.CODEX_LOG_FULL_EVENTS,
      "CODEX_LOG_FULL_EVENTS",
      false,
    ),
    codexQuestionMarker: env.CODEX_QUESTION_MARKER?.trim() || "AI_QUESTION:",
    codexSelfReviewEnabled: parseBooleanFlag(
      env.CODEX_SELF_REVIEW_ENABLED,
      "CODEX_SELF_REVIEW_ENABLED",
      false,
    ),
    codexSelfReviewMaxFixAttempts: parsePositiveInt(
      env.CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS?.trim() ||
        String(DEFAULT_CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS),
      "CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS",
    ),
    maxFixAttempts,
    maxReviewFixAttempts: parsePositiveInt(
      env.MAX_REVIEW_FIX_ATTEMPTS?.trim() || String(maxFixAttempts),
      "MAX_REVIEW_FIX_ATTEMPTS",
    ),
    workerId: requireEnv(env, "WORKER_ID"),
    ...(env.TYPE_CHECK_COMMAND?.trim()
      ? { typeCheckCommand: env.TYPE_CHECK_COMMAND.trim() }
      : {}),
    testCommand: env.TEST_COMMAND?.trim() || "npm test",
    lintCommand: env.LINT_COMMAND?.trim() || "npm run lint",
    ...(env.BUILD_COMMAND?.trim() ? { buildCommand: env.BUILD_COMMAND.trim() } : {}),
    ...(env.SECURITY_SCAN_COMMAND?.trim()
      ? { securityScanCommand: env.SECURITY_SCAN_COMMAND.trim() }
      : {}),
    ...(env.SAST_COMMAND?.trim() ? { sastCommand: env.SAST_COMMAND.trim() } : {}),
    ...(env.COVERAGE_COMMAND?.trim()
      ? { coverageCommand: env.COVERAGE_COMMAND.trim() }
      : {}),
    ...(minCoveragePercent !== undefined ? { minCoveragePercent } : {}),
    ...(env.COVERAGE_REPORT_FILE?.trim()
      ? { coverageReportFile: env.COVERAGE_REPORT_FILE.trim() }
      : {}),
    ...(env.VISUAL_REGRESSION_COMMAND?.trim()
      ? { visualRegressionCommand: env.VISUAL_REGRESSION_COMMAND.trim() }
      : {}),
    ...(env.VISUAL_REGRESSION_ARTIFACTS_DIR?.trim()
      ? { visualRegressionArtifactsDir: env.VISUAL_REGRESSION_ARTIFACTS_DIR.trim() }
      : {}),
    runOnce: parseBooleanFlag(env.WORKER_RUN_ONCE, "WORKER_RUN_ONCE", false),
    preflightOnly: parseBooleanFlag(
      env.WORKER_PREFLIGHT_ONLY,
      "WORKER_PREFLIGHT_ONLY",
      false,
    ),
    ...(env.TRACKER_PREFLIGHT_ISSUE_KEY?.trim()
      ? { trackerPreflightIssueKey: env.TRACKER_PREFLIGHT_ISSUE_KEY.trim() }
      : {}),
    ...(env.GITLAB_PREFLIGHT_SOURCE_BRANCH?.trim()
      ? { gitlabPreflightSourceBranch: env.GITLAB_PREFLIGHT_SOURCE_BRANCH.trim() }
      : {}),
    preflightRunTargetCommands: parseBooleanFlag(
      env.PREFLIGHT_RUN_TARGET_COMMANDS,
      "PREFLIGHT_RUN_TARGET_COMMANDS",
      true,
    ),
    ...(env.TARGET_ISSUE_KEY?.trim()
      ? { targetIssueKey: env.TARGET_ISSUE_KEY.trim() }
      : {}),
    taskMode: parseTaskMode(env.TASK_MODE),
    confidenceImplementThreshold: env.CONFIDENCE_IMPLEMENT_THRESHOLD?.trim()
      ? parsePercentInt(
          env.CONFIDENCE_IMPLEMENT_THRESHOLD,
          "CONFIDENCE_IMPLEMENT_THRESHOLD",
        )
      : DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD,
    confidenceHumanThreshold: env.CONFIDENCE_HUMAN_THRESHOLD?.trim()
      ? parsePercentInt(env.CONFIDENCE_HUMAN_THRESHOLD, "CONFIDENCE_HUMAN_THRESHOLD")
      : DEFAULT_CONFIDENCE_HUMAN_THRESHOLD,
    decompositionMaxSubtasks: env.DECOMPOSITION_MAX_SUBTASKS?.trim()
      ? parsePositiveInt(env.DECOMPOSITION_MAX_SUBTASKS, "DECOMPOSITION_MAX_SUBTASKS")
      : DEFAULT_DECOMPOSITION_MAX_SUBTASKS,
    decompositionCreateIssues: parseBooleanFlag(
      env.DECOMPOSITION_CREATE_ISSUES,
      "DECOMPOSITION_CREATE_ISSUES",
      DEFAULT_DECOMPOSITION_CREATE_ISSUES,
    ),
    decompositionDryRun: parseBooleanFlag(
      env.DECOMPOSITION_DRY_RUN,
      "DECOMPOSITION_DRY_RUN",
      DEFAULT_DECOMPOSITION_DRY_RUN,
    ),
    decompositionDefaultSubtaskTag:
      env.DECOMPOSITION_DEFAULT_SUBTASK_TAG?.trim() ||
      DEFAULT_DECOMPOSITION_SUBTASK_TAG,
    decompositionSubtaskTitlePrefix:
      env.DECOMPOSITION_SUBTASK_TITLE_PREFIX?.trim() ||
      DEFAULT_DECOMPOSITION_TITLE_PREFIX,
    dependencyEnforcement: parseBooleanFlag(
      env.DEPENDENCY_ENFORCEMENT,
      "DEPENDENCY_ENFORCEMENT",
      DEFAULT_DEPENDENCY_ENFORCEMENT,
    ),
    dependencyUnknownStatusPolicy: parseDependencyUnknownStatusPolicy(
      env.DEPENDENCY_UNKNOWN_STATUS_POLICY,
    ),
    memory,
    observability,
    autonomy,
    projectManager,
  };
};

const parseCoordinationConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
  taskTracker?: TaskTrackerConfig,
): CoordinationConfig => {
  const defaultLockBackend = taskTracker?.provider === "internal" ? "none" : "tracker";
  const lockBackend =
    env.LOCK_BACKEND?.trim() ||
    optionalString(rawValue?.lockBackend, "coordination.lockBackend") ||
    defaultLockBackend;
  if (
    lockBackend !== "none" &&
    lockBackend !== "tracker" &&
    lockBackend !== "redis" &&
    lockBackend !== "postgres"
  ) {
    throw new ConfigurationError("LOCK_BACKEND must be one of: none, tracker, redis, postgres.");
  }
  if (lockBackend === "redis") {
    throw new ConfigurationError("LOCK_BACKEND=redis is not implemented yet.");
  }
  if (lockBackend === "postgres") {
    throw new ConfigurationError("LOCK_BACKEND=postgres is not implemented yet.");
  }
  if (taskTracker?.provider === "internal" && lockBackend === "tracker") {
    throw new ConfigurationError(
      "LOCK_BACKEND=tracker is only supported with TASK_TRACKER_PROVIDER=yandex in Phase 7C.",
    );
  }

  const ttlSeconds = env.LOCK_TTL_SECONDS?.trim()
    ? parsePositiveInt(env.LOCK_TTL_SECONDS, "LOCK_TTL_SECONDS")
    : optionalPositiveInt(rawValue?.ttlSeconds, "coordination.ttlSeconds", 900);
  const heartbeatSeconds = env.LOCK_HEARTBEAT_SECONDS?.trim()
    ? parsePositiveInt(env.LOCK_HEARTBEAT_SECONDS, "LOCK_HEARTBEAT_SECONDS")
    : optionalPositiveInt(rawValue?.heartbeatSeconds, "coordination.heartbeatSeconds", 60);
  const redisUrl =
    env.LOCK_REDIS_URL?.trim() ||
    optionalString(rawValue?.redisUrl, "coordination.redisUrl");
  const postgresUrl =
    env.LOCK_POSTGRES_URL?.trim() ||
    optionalString(rawValue?.postgresUrl, "coordination.postgresUrl");

  return {
    lockBackend,
    lockTtlMs: ttlSeconds * 1000,
    lockHeartbeatMs: heartbeatSeconds * 1000,
    ...(redisUrl ? { redisUrl } : {}),
    ...(postgresUrl ? { postgresUrl } : {}),
  };
};

const parsePriorityQueueConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
): PriorityQueueConfig => {
  const deadlineBoost = optionalRecord(
    rawValue?.deadlineBoost,
    "priorityQueue.deadlineBoost",
  );
  const tieBreaker =
    optionalString(rawValue?.createdAtTieBreaker, "priorityQueue.createdAtTieBreaker") ??
    DEFAULT_PRIORITY_QUEUE_CONFIG.createdAtTieBreaker;
  if (tieBreaker !== "oldest" && tieBreaker !== "newest") {
    throw new ConfigurationError(
      "priorityQueue.createdAtTieBreaker must be either oldest or newest.",
    );
  }

  return {
    manualOverrideTags: optionalStringArrayValue(
      rawValue?.manualOverrideTags,
      "priorityQueue.manualOverrideTags",
      DEFAULT_PRIORITY_QUEUE_CONFIG.manualOverrideTags,
    ),
    priorityWeights: optionalNumberRecord(
      rawValue?.priorityWeights,
      "priorityQueue.priorityWeights",
      DEFAULT_PRIORITY_QUEUE_CONFIG.priorityWeights,
    ),
    tagBoosts: optionalNumberRecord(
      rawValue?.tagBoosts,
      "priorityQueue.tagBoosts",
      DEFAULT_PRIORITY_QUEUE_CONFIG.tagBoosts,
    ),
    componentBoosts: optionalNumberRecord(
      rawValue?.componentBoosts,
      "priorityQueue.componentBoosts",
      DEFAULT_PRIORITY_QUEUE_CONFIG.componentBoosts,
    ),
    confidencePriorityWeight: env.CONFIDENCE_PRIORITY_WEIGHT?.trim()
      ? parsePositiveInt(env.CONFIDENCE_PRIORITY_WEIGHT, "CONFIDENCE_PRIORITY_WEIGHT")
      : optionalNumber(
          rawValue?.confidencePriorityWeight,
          "priorityQueue.confidencePriorityWeight",
          DEFAULT_PRIORITY_QUEUE_CONFIG.confidencePriorityWeight ?? 2,
        ),
    deadlineBoost: {
      dueToday: optionalNumber(
        deadlineBoost?.dueToday,
        "priorityQueue.deadlineBoost.dueToday",
        DEFAULT_PRIORITY_QUEUE_CONFIG.deadlineBoost.dueToday,
      ),
      overdue: optionalNumber(
        deadlineBoost?.overdue,
        "priorityQueue.deadlineBoost.overdue",
        DEFAULT_PRIORITY_QUEUE_CONFIG.deadlineBoost.overdue,
      ),
    },
    createdAtTieBreaker: tieBreaker,
  };
};

const buildSingleRepositoryFleetConfig = (
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): GlobalWorkerConfig => {
  const repositories: RepositoryProfile[] = [
    {
      name: "default",
      repoPath: config.repoPath,
      gitlabProjectId: config.gitlabProjectId,
      gitRemoteName: config.gitRemoteName,
      baseBranch: config.baseBranch,
      queues: [config.trackerDefaultQueue],
      tags: [config.trackerTag],
      testCommand: config.testCommand,
      lintCommand: config.lintCommand,
      ...(config.typeCheckCommand ? { typeCheckCommand: config.typeCheckCommand } : {}),
      ...(config.buildCommand ? { buildCommand: config.buildCommand } : {}),
      ...(config.securityScanCommand
        ? { securityScanCommand: config.securityScanCommand }
        : {}),
      ...(config.sastCommand ? { sastCommand: config.sastCommand } : {}),
      ...(config.coverageCommand ? { coverageCommand: config.coverageCommand } : {}),
      ...(config.minCoveragePercent !== undefined
        ? { minCoveragePercent: config.minCoveragePercent }
        : {}),
      ...(config.coverageReportFile
        ? { coverageReportFile: config.coverageReportFile }
        : {}),
      ...(config.visualRegressionCommand
        ? { visualRegressionCommand: config.visualRegressionCommand }
        : {}),
      ...(config.visualRegressionArtifactsDir
        ? { visualRegressionArtifactsDir: config.visualRegressionArtifactsDir }
        : {}),
      ...(config.gitRepositoryUrl ? { gitRepositoryUrl: config.gitRepositoryUrl } : {}),
      decomposition: {
        ...(config.decompositionDefaultSubtaskTag
          ? { defaultSubtaskTag: config.decompositionDefaultSubtaskTag }
          : {}),
        ...(config.decompositionSubtaskTitlePrefix
          ? { subtaskTitlePrefix: config.decompositionSubtaskTitlePrefix }
          : {}),
        ...(config.decompositionMaxSubtasks !== undefined
          ? { maxSubtasks: config.decompositionMaxSubtasks }
          : {}),
      },
      ...(config.autonomy?.repositories.default
        ? { autonomy: config.autonomy.repositories.default }
        : {}),
    },
  ];
  validateRepositoryProfiles(repositories);

  return {
    taskTracker: config.taskTracker,
    workerId: config.workerId,
    pollIntervalMinutes: config.pollIntervalMinutes,
    pollIntervalMs: config.pollIntervalMs,
    runOnce: config.runOnce,
    preflightOnly: config.preflightOnly,
    preflightRunTargetCommands: config.preflightRunTargetCommands,
    ...(config.trackerPreflightIssueKey
      ? { trackerPreflightIssueKey: config.trackerPreflightIssueKey }
      : {}),
    ...(config.gitlabPreflightSourceBranch
      ? { gitlabPreflightSourceBranch: config.gitlabPreflightSourceBranch }
      : {}),
    ...(config.targetIssueKey ? { targetIssueKey: config.targetIssueKey } : {}),
    ...(config.taskMode ? { taskMode: config.taskMode } : {}),
    ...(config.confidenceImplementThreshold !== undefined
      ? { confidenceImplementThreshold: config.confidenceImplementThreshold }
      : {}),
    ...(config.confidenceHumanThreshold !== undefined
      ? { confidenceHumanThreshold: config.confidenceHumanThreshold }
      : {}),
    ...(config.decompositionMaxSubtasks !== undefined
      ? { decompositionMaxSubtasks: config.decompositionMaxSubtasks }
      : {}),
    ...(config.decompositionCreateIssues !== undefined
      ? { decompositionCreateIssues: config.decompositionCreateIssues }
      : {}),
    ...(config.decompositionDryRun !== undefined
      ? { decompositionDryRun: config.decompositionDryRun }
      : {}),
    ...(config.decompositionDefaultSubtaskTag
      ? { decompositionDefaultSubtaskTag: config.decompositionDefaultSubtaskTag }
      : {}),
    ...(config.decompositionSubtaskTitlePrefix
      ? { decompositionSubtaskTitlePrefix: config.decompositionSubtaskTitlePrefix }
      : {}),
    ...(config.dependencyEnforcement !== undefined
      ? { dependencyEnforcement: config.dependencyEnforcement }
      : {}),
    ...(config.dependencyUnknownStatusPolicy
      ? { dependencyUnknownStatusPolicy: config.dependencyUnknownStatusPolicy }
      : {}),
    ...(config.trackerParentLinkType
      ? { trackerParentLinkType: config.trackerParentLinkType }
      : {}),
    ...(config.trackerBlockedByLinkType
      ? { trackerBlockedByLinkType: config.trackerBlockedByLinkType }
      : {}),
    maxFixAttempts: config.maxFixAttempts,
    maxReviewFixAttempts: config.maxReviewFixAttempts,
    trackerImageContext: config.trackerImageContext,
    gitRepositoryToken: config.gitRepositoryToken,
    gitRepositoryUsername: config.gitRepositoryUsername,
    gitCommitNoVerify: config.gitCommitNoVerify,
    ...(config.gitAuthorName ? { gitAuthorName: config.gitAuthorName } : {}),
    ...(config.gitAuthorEmail ? { gitAuthorEmail: config.gitAuthorEmail } : {}),
    tracker: {
      token: config.trackerToken,
      orgHeader: config.trackerOrgHeader,
      orgId: config.trackerOrgId,
      statusMap: config.trackerStatusMap,
      apiBaseUrl: config.trackerApiBaseUrl,
    },
    gitlab: {
      url: config.gitlabUrl,
      token: config.gitlabToken,
    },
    codex: {
      home: config.codexHome,
      cliCommand: config.codexCliCommand,
      cliArgs: config.codexCliArgs,
      ...(config.codexModel ? { model: config.codexModel } : {}),
      ...(config.codexProfile ? { profile: config.codexProfile } : {}),
      sandbox: config.codexSandbox,
      execArgs: config.codexExecArgs,
      timeoutMs: config.codexTimeoutMs,
      progressLogIntervalMs: config.codexProgressLogIntervalMs,
      logFullEvents: config.codexLogFullEvents,
      questionMarker: config.codexQuestionMarker,
      selfReviewEnabled: config.codexSelfReviewEnabled,
      selfReviewMaxFixAttempts: config.codexSelfReviewMaxFixAttempts,
    },
    coordination: parseCoordinationConfig(env, undefined, config.taskTracker),
    priorityQueue: parsePriorityQueueConfig(env),
    repositories,
    memory: config.memory,
    observability: config.observability,
    ...(config.autonomy ? { autonomy: config.autonomy } : {}),
    ...(config.projectManager ? { projectManager: config.projectManager } : {}),
  };
};

const optionalProfileString = (
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined => optionalString(raw[key], `${path}.${key}`);

const parseRepositoryProfile = (
  value: unknown,
  index: number,
): RepositoryProfile => {
  const path = `repositories[${index}]`;
  const raw = asRecord(value, path);
  const name = requiredString(raw.name, `${path}.name`);
  const repoPath = requiredString(raw.repoPath, `${path}.repoPath`);
  const gitlabProjectId = requiredString(raw.gitlabProjectId, `${path}.gitlabProjectId`);
  const queues = optionalStringArrayValue(raw.queues, `${path}.queues`, []);
  if (queues.length === 0) {
    throw new ConfigurationError(`${path}.queues must not be empty.`);
  }

  const tags = optionalStringArrayValue(raw.tags, `${path}.tags`, ["ai_dev"]);
  if (tags.length === 0) {
    throw new ConfigurationError(`${path}.tags must not be empty.`);
  }

  const minCoveragePercent =
    raw.minCoveragePercent === undefined
      ? undefined
      : optionalNumber(raw.minCoveragePercent, `${path}.minCoveragePercent`, 0);
  if (
    minCoveragePercent !== undefined &&
    (minCoveragePercent < 0 || minCoveragePercent > 100)
  ) {
    throw new ConfigurationError(
      `${path}.minCoveragePercent must be a number from 0 to 100.`,
    );
  }

  return {
    name,
    repoPath,
    gitlabProjectId,
    gitRemoteName: optionalProfileString(raw, "gitRemoteName", path) ?? "origin",
    baseBranch: optionalProfileString(raw, "baseBranch", path) ?? "main",
    queues,
    tags,
    testCommand: optionalProfileString(raw, "testCommand", path) ?? "npm test",
    lintCommand: optionalProfileString(raw, "lintCommand", path) ?? "npm run lint",
    ...(optionalProfileString(raw, "typeCheckCommand", path)
      ? { typeCheckCommand: optionalProfileString(raw, "typeCheckCommand", path) }
      : {}),
    ...(optionalProfileString(raw, "buildCommand", path)
      ? { buildCommand: optionalProfileString(raw, "buildCommand", path) }
      : {}),
    ...(optionalProfileString(raw, "securityScanCommand", path)
      ? { securityScanCommand: optionalProfileString(raw, "securityScanCommand", path) }
      : {}),
    ...(optionalProfileString(raw, "sastCommand", path)
      ? { sastCommand: optionalProfileString(raw, "sastCommand", path) }
      : {}),
    ...(optionalProfileString(raw, "coverageCommand", path)
      ? { coverageCommand: optionalProfileString(raw, "coverageCommand", path) }
      : {}),
    ...(minCoveragePercent !== undefined ? { minCoveragePercent } : {}),
    ...(optionalProfileString(raw, "coverageReportFile", path)
      ? { coverageReportFile: optionalProfileString(raw, "coverageReportFile", path) }
      : {}),
    ...(optionalProfileString(raw, "visualRegressionCommand", path)
      ? {
          visualRegressionCommand: optionalProfileString(
            raw,
            "visualRegressionCommand",
            path,
          ),
        }
      : {}),
    ...(optionalProfileString(raw, "visualRegressionArtifactsDir", path)
      ? {
          visualRegressionArtifactsDir: optionalProfileString(
            raw,
            "visualRegressionArtifactsDir",
            path,
          ),
        }
      : {}),
    ...(optionalProfileString(raw, "gitRepositoryUrl", path)
      ? { gitRepositoryUrl: optionalProfileString(raw, "gitRepositoryUrl", path) }
      : {}),
    ...(parsePromptProfileOverrides(raw.promptProfiles, `${path}.promptProfiles`)
      ? {
          promptProfiles: parsePromptProfileOverrides(
            raw.promptProfiles,
            `${path}.promptProfiles`,
          ),
        }
      : {}),
    ...(parseRepositoryDecompositionConfig(raw.decomposition, `${path}.decomposition`)
      ? {
          decomposition: parseRepositoryDecompositionConfig(
            raw.decomposition,
            `${path}.decomposition`,
          ),
        }
      : {}),
    ...(parseOptionalRepositoryAutonomyPolicy(raw.autonomy, `${path}.autonomy`)
      ? {
          autonomy: parseOptionalRepositoryAutonomyPolicy(
            raw.autonomy,
            `${path}.autonomy`,
          ),
        }
      : {}),
    ...(parseRepositoryProjectManagerConfig(raw.projectManager, `${path}.projectManager`)
      ? {
          projectManager: parseRepositoryProjectManagerConfig(
            raw.projectManager,
            `${path}.projectManager`,
          ),
        }
      : {}),
  };
};

const validateRepositoryProfiles = (repositories: RepositoryProfile[]): void => {
  const names = new Set<string>();
  const memoryKeys = new Map<string, string>();
  for (const repository of repositories) {
    if (names.has(repository.name)) {
      throw new ConfigurationError(`Duplicate repository name: ${repository.name}`);
    }
    names.add(repository.name);

    const memoryKey = sanitizeRepositoryKey(repository.name);
    const previousName = memoryKeys.get(memoryKey);
    if (previousName) {
      throw new ConfigurationError(
        `Repository names "${previousName}" and "${repository.name}" resolve to the same memory key "${memoryKey}". Rename one repository profile to keep MEMORY_DIR storage unambiguous.`,
      );
    }
    memoryKeys.set(memoryKey, repository.name);
  }
};

const readStatusMapFile = (path: string, label: string) => {
  try {
    return parseStatusMap(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(
      `Unable to read ${label} at ${path}. ${(error as Error).message}`,
    );
  }
};

const loadFleetConfigFromFile = (
  env: NodeJS.ProcessEnv,
  configFile: string,
): GlobalWorkerConfig => {
  const root = asRecord(parseConfigDocument(configFile), "WORKER_CONFIG_FILE");
  const worker = optionalRecord(root.worker, "worker") ?? {};
  const tracker = optionalRecord(root.tracker, "tracker") ?? {};
  const gitlab = optionalRecord(root.gitlab, "gitlab") ?? {};
  const codex = optionalRecord(root.codex, "codex") ?? {};
  const taskTracker = parseTaskTrackerConfig(
    env,
    optionalRecord(root.taskTracker, "taskTracker"),
  );
  const coordination = optionalRecord(root.coordination, "coordination");
  const priorityQueue = optionalRecord(root.priorityQueue, "priorityQueue");
  const memory = optionalRecord(root.memory, "memory");
  const observability = optionalRecord(root.observability, "observability");
  const alerts = optionalRecord(root.alerts, "alerts");
  const autonomyRoot = optionalRecord(root.autonomy, "autonomy");
  const projectManagerRoot = optionalRecord(root.projectManager, "projectManager");
  const trackerImageContext = optionalRecord(
    root.trackerImageContext,
    "trackerImageContext",
  );
  if (!Array.isArray(root.repositories) || root.repositories.length === 0) {
    throw new ConfigurationError("repositories must be a non-empty array.");
  }
  const repositories = root.repositories.map(parseRepositoryProfile);
  validateRepositoryProfiles(repositories);
  const autonomy = parseAutonomyConfig(env, autonomyRoot, repositories);
  const projectManager = parseProjectManagerConfig(
    env,
    projectManagerRoot,
    taskTracker,
  );
  assertProjectManagerProviderCompatibility(taskTracker, projectManager, repositories);

  const usesYandex = taskTrackerUsesYandex(taskTracker);
  const statusMapFile =
    usesYandex
      ? optionalString(tracker.statusMapFile, "tracker.statusMapFile") ??
        requireEnv(env, "TRACKER_STATUS_MAP_FILE")
      : undefined;
  const pollIntervalMinutes = env.POLL_INTERVAL_MINUTES?.trim()
    ? parsePositiveInt(env.POLL_INTERVAL_MINUTES, "POLL_INTERVAL_MINUTES")
    : optionalPositiveInt(worker.pollIntervalMinutes, "worker.pollIntervalMinutes", 30);
  const workerId = optionalString(worker.id, "worker.id") ?? requireEnv(env, "WORKER_ID");
  const maxFixAttempts = env.MAX_FIX_ATTEMPTS?.trim()
    ? parsePositiveInt(env.MAX_FIX_ATTEMPTS, "MAX_FIX_ATTEMPTS")
    : optionalPositiveInt(worker.maxFixAttempts, "worker.maxFixAttempts", 2);
  const gitlabToken = resolveEnvReference(
    env,
    gitlab,
    "token",
    "tokenEnv",
    "GITLAB_TOKEN",
    "gitlab",
  );

  return {
    taskTracker,
    workerId,
    pollIntervalMinutes,
    pollIntervalMs: pollIntervalMinutes * 60 * 1000,
    runOnce: env.WORKER_RUN_ONCE?.trim()
      ? parseBooleanFlag(env.WORKER_RUN_ONCE, "WORKER_RUN_ONCE", false)
      : optionalBoolean(worker.runOnce, "worker.runOnce", false),
    preflightOnly: parseBooleanFlag(
      env.WORKER_PREFLIGHT_ONLY,
      "WORKER_PREFLIGHT_ONLY",
      false,
    ),
    preflightRunTargetCommands: parseBooleanFlag(
      env.PREFLIGHT_RUN_TARGET_COMMANDS,
      "PREFLIGHT_RUN_TARGET_COMMANDS",
      true,
    ),
    ...(env.TRACKER_PREFLIGHT_ISSUE_KEY?.trim()
      ? { trackerPreflightIssueKey: env.TRACKER_PREFLIGHT_ISSUE_KEY.trim() }
      : {}),
    ...(env.GITLAB_PREFLIGHT_SOURCE_BRANCH?.trim()
      ? { gitlabPreflightSourceBranch: env.GITLAB_PREFLIGHT_SOURCE_BRANCH.trim() }
      : {}),
    ...(env.TARGET_ISSUE_KEY?.trim()
      ? { targetIssueKey: env.TARGET_ISSUE_KEY.trim() }
      : {}),
    taskMode: env.TASK_MODE?.trim()
      ? parseTaskMode(env.TASK_MODE)
      : parseTaskMode(optionalString(worker.taskMode, "worker.taskMode")),
    confidenceImplementThreshold: env.CONFIDENCE_IMPLEMENT_THRESHOLD?.trim()
      ? parsePercentInt(
          env.CONFIDENCE_IMPLEMENT_THRESHOLD,
          "CONFIDENCE_IMPLEMENT_THRESHOLD",
        )
      : optionalPercentIntValue(
          worker.confidenceImplementThreshold,
          "worker.confidenceImplementThreshold",
          DEFAULT_CONFIDENCE_IMPLEMENT_THRESHOLD,
        ),
    confidenceHumanThreshold: env.CONFIDENCE_HUMAN_THRESHOLD?.trim()
      ? parsePercentInt(env.CONFIDENCE_HUMAN_THRESHOLD, "CONFIDENCE_HUMAN_THRESHOLD")
      : optionalPercentIntValue(
          worker.confidenceHumanThreshold,
          "worker.confidenceHumanThreshold",
          DEFAULT_CONFIDENCE_HUMAN_THRESHOLD,
        ),
    decompositionMaxSubtasks: env.DECOMPOSITION_MAX_SUBTASKS?.trim()
      ? parsePositiveInt(env.DECOMPOSITION_MAX_SUBTASKS, "DECOMPOSITION_MAX_SUBTASKS")
      : optionalPositiveInt(
          worker.decompositionMaxSubtasks,
          "worker.decompositionMaxSubtasks",
          DEFAULT_DECOMPOSITION_MAX_SUBTASKS,
        ),
    decompositionCreateIssues: env.DECOMPOSITION_CREATE_ISSUES?.trim()
      ? parseBooleanFlag(
          env.DECOMPOSITION_CREATE_ISSUES,
          "DECOMPOSITION_CREATE_ISSUES",
          DEFAULT_DECOMPOSITION_CREATE_ISSUES,
        )
      : optionalBoolean(
          worker.decompositionCreateIssues,
          "worker.decompositionCreateIssues",
          DEFAULT_DECOMPOSITION_CREATE_ISSUES,
        ),
    decompositionDryRun: env.DECOMPOSITION_DRY_RUN?.trim()
      ? parseBooleanFlag(
          env.DECOMPOSITION_DRY_RUN,
          "DECOMPOSITION_DRY_RUN",
          DEFAULT_DECOMPOSITION_DRY_RUN,
        )
      : optionalBoolean(
          worker.decompositionDryRun,
          "worker.decompositionDryRun",
          DEFAULT_DECOMPOSITION_DRY_RUN,
        ),
    decompositionDefaultSubtaskTag:
      env.DECOMPOSITION_DEFAULT_SUBTASK_TAG?.trim() ||
      optionalString(
        worker.decompositionDefaultSubtaskTag,
        "worker.decompositionDefaultSubtaskTag",
      ) ||
      DEFAULT_DECOMPOSITION_SUBTASK_TAG,
    decompositionSubtaskTitlePrefix:
      env.DECOMPOSITION_SUBTASK_TITLE_PREFIX?.trim() ||
      optionalString(
        worker.decompositionSubtaskTitlePrefix,
        "worker.decompositionSubtaskTitlePrefix",
      ) ||
      DEFAULT_DECOMPOSITION_TITLE_PREFIX,
    dependencyEnforcement: env.DEPENDENCY_ENFORCEMENT?.trim()
      ? parseBooleanFlag(
          env.DEPENDENCY_ENFORCEMENT,
          "DEPENDENCY_ENFORCEMENT",
          DEFAULT_DEPENDENCY_ENFORCEMENT,
        )
      : optionalBoolean(
          worker.dependencyEnforcement,
          "worker.dependencyEnforcement",
          DEFAULT_DEPENDENCY_ENFORCEMENT,
        ),
    dependencyUnknownStatusPolicy: env.DEPENDENCY_UNKNOWN_STATUS_POLICY?.trim()
      ? parseDependencyUnknownStatusPolicy(env.DEPENDENCY_UNKNOWN_STATUS_POLICY)
      : parseDependencyUnknownStatusPolicy(
          optionalString(
            worker.dependencyUnknownStatusPolicy,
            "worker.dependencyUnknownStatusPolicy",
          ),
          "worker.dependencyUnknownStatusPolicy",
        ),
    trackerParentLinkType:
      env.TRACKER_PARENT_LINK_TYPE?.trim() ||
      optionalString(tracker.parentLinkType, "tracker.parentLinkType") ||
      DEFAULT_TRACKER_PARENT_LINK_TYPE,
    trackerBlockedByLinkType:
      env.TRACKER_BLOCKED_BY_LINK_TYPE?.trim() ||
      optionalString(tracker.blockedByLinkType, "tracker.blockedByLinkType") ||
      DEFAULT_TRACKER_BLOCKED_BY_LINK_TYPE,
    maxFixAttempts,
    maxReviewFixAttempts: env.MAX_REVIEW_FIX_ATTEMPTS?.trim()
      ? parsePositiveInt(env.MAX_REVIEW_FIX_ATTEMPTS, "MAX_REVIEW_FIX_ATTEMPTS")
      : optionalPositiveInt(
          worker.maxReviewFixAttempts,
          "worker.maxReviewFixAttempts",
          maxFixAttempts,
        ),
    trackerImageContext: parseTrackerImageContextConfig(env, trackerImageContext),
    gitRepositoryToken: env.GIT_REPOSITORY_TOKEN?.trim() || gitlabToken,
    gitRepositoryUsername: env.GIT_REPOSITORY_USERNAME?.trim() || "oauth2",
    gitCommitNoVerify: parseBooleanFlag(
      env.GIT_COMMIT_NO_VERIFY,
      "GIT_COMMIT_NO_VERIFY",
      true,
    ),
    ...(env.GIT_AUTHOR_NAME?.trim() ? { gitAuthorName: env.GIT_AUTHOR_NAME.trim() } : {}),
    ...(env.GIT_AUTHOR_EMAIL?.trim()
      ? { gitAuthorEmail: env.GIT_AUTHOR_EMAIL.trim() }
      : {}),
    tracker: {
      token:
        usesYandex
          ? resolveEnvReference(
              env,
              tracker,
              "token",
              "tokenEnv",
              "TRACKER_TOKEN",
              "tracker",
            )
          : env.TRACKER_TOKEN?.trim() ||
            optionalString(tracker.token, "tracker.token") ||
            "",
      orgHeader:
        usesYandex
          ? parseTrackerOrgHeader(
              optionalString(tracker.orgHeader, "tracker.orgHeader") ??
                env.TRACKER_ORG_HEADER,
            )
          : parseTrackerOrgHeader(undefined),
      orgId:
        usesYandex
          ? resolveEnvReference(
              env,
              tracker,
              "orgId",
              "orgIdEnv",
              "TRACKER_ORG_ID",
              "tracker",
            )
          : env.TRACKER_ORG_ID?.trim() ||
            optionalString(tracker.orgId, "tracker.orgId") ||
            "",
      statusMap: statusMapFile
        ? readStatusMapFile(statusMapFile, "tracker.statusMapFile")
        : DEFAULT_INTERNAL_TRACKER_STATUS_MAP,
      apiBaseUrl:
        optionalString(tracker.apiBaseUrl, "tracker.apiBaseUrl")?.replace(/\/+$/, "") ||
        env.TRACKER_API_BASE_URL?.trim().replace(/\/+$/, "") ||
        "https://api.tracker.yandex.net/v3",
    },
    gitlab: {
      url: resolveEnvReference(env, gitlab, "url", "urlEnv", "GITLAB_URL", "gitlab").replace(
        /\/+$/,
        "",
      ),
      token: gitlabToken,
    },
    codex: {
      home:
        optionalString(codex.home, "codex.home") ||
        env[optionalString(codex.homeEnv, "codex.homeEnv") ?? "CODEX_HOME"]?.trim() ||
        join(homedir(), ".codex"),
      cliCommand:
        optionalString(codex.cliCommand, "codex.cliCommand") ||
        env.CODEX_CLI_COMMAND?.trim() ||
        "codex",
      cliArgs:
        codex.cliArgs === undefined
          ? parseStringArray(env.CODEX_CLI_ARGS_JSON, "CODEX_CLI_ARGS_JSON")
          : optionalStringArrayValue(codex.cliArgs, "codex.cliArgs", []),
      ...(optionalString(codex.model, "codex.model") || env.CODEX_MODEL?.trim()
        ? { model: optionalString(codex.model, "codex.model") || env.CODEX_MODEL?.trim() }
        : {}),
      ...(optionalString(codex.profile, "codex.profile") || env.CODEX_PROFILE?.trim()
        ? {
            profile:
              optionalString(codex.profile, "codex.profile") || env.CODEX_PROFILE?.trim(),
          }
        : {}),
      sandbox: parseCodexSandbox(
        optionalString(codex.sandbox, "codex.sandbox") ?? env.CODEX_SANDBOX,
      ),
      execArgs:
        codex.execArgs === undefined
          ? parseStringArray(env.CODEX_EXEC_ARGS_JSON, "CODEX_EXEC_ARGS_JSON")
          : optionalStringArrayValue(codex.execArgs, "codex.execArgs", []),
      timeoutMs:
        (env.CODEX_TIMEOUT_SECONDS?.trim()
          ? parsePositiveInt(env.CODEX_TIMEOUT_SECONDS, "CODEX_TIMEOUT_SECONDS")
          : optionalPositiveInt(codex.timeoutSeconds, "codex.timeoutSeconds", 1800)) * 1000,
      progressLogIntervalMs:
        (env.CODEX_PROGRESS_LOG_INTERVAL_SECONDS?.trim()
          ? parsePositiveInt(
              env.CODEX_PROGRESS_LOG_INTERVAL_SECONDS,
              "CODEX_PROGRESS_LOG_INTERVAL_SECONDS",
            )
          : optionalPositiveInt(
              codex.progressLogIntervalSeconds,
              "codex.progressLogIntervalSeconds",
              30,
            )) * 1000,
      logFullEvents: parseBooleanFlag(
        env.CODEX_LOG_FULL_EVENTS,
        "CODEX_LOG_FULL_EVENTS",
        false,
      ),
      questionMarker: env.CODEX_QUESTION_MARKER?.trim() || "AI_QUESTION:",
      selfReviewEnabled: env.CODEX_SELF_REVIEW_ENABLED?.trim()
        ? parseBooleanFlag(
            env.CODEX_SELF_REVIEW_ENABLED,
            "CODEX_SELF_REVIEW_ENABLED",
            false,
          )
        : optionalBoolean(codex.selfReviewEnabled, "codex.selfReviewEnabled", false),
      selfReviewMaxFixAttempts: env.CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS?.trim()
        ? parsePositiveInt(
            env.CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS,
            "CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS",
          )
        : optionalPositiveInt(
            codex.selfReviewMaxFixAttempts,
            "codex.selfReviewMaxFixAttempts",
            DEFAULT_CODEX_SELF_REVIEW_MAX_FIX_ATTEMPTS,
          ),
    },
    coordination: parseCoordinationConfig(env, coordination, taskTracker),
    priorityQueue: parsePriorityQueueConfig(env, priorityQueue),
    repositories,
    memory: parseMemoryConfig(env, memory),
    observability: parseObservabilityConfig(env, {
      ...(observability ?? {}),
      ...(alerts ? { alerts } : {}),
    }),
    autonomy,
    projectManager,
  };
};

export const loadFleetConfig = (
  env: NodeJS.ProcessEnv = process.env,
): GlobalWorkerConfig => {
  const configFile = env.WORKER_CONFIG_FILE?.trim();
  if (!configFile) {
    return buildSingleRepositoryFleetConfig(loadConfig(env), env);
  }

  return loadFleetConfigFromFile(env, configFile);
};

export const buildRepositoryRuntimeConfig = (
  globalConfig: GlobalWorkerConfig,
  repository: RepositoryProfile,
): RepositoryRuntimeConfig => ({
  ...(globalConfig.taskTracker ? { taskTracker: globalConfig.taskTracker } : {}),
  repositoryName: repository.name,
  trackerToken: globalConfig.tracker.token,
  trackerOrgHeader: globalConfig.tracker.orgHeader,
  trackerOrgId: globalConfig.tracker.orgId,
  trackerDefaultQueue: repository.queues[0] ?? "FRONTEND",
  trackerTag: repository.tags[0] ?? "ai_dev",
  trackerStatusMap: globalConfig.tracker.statusMap,
  trackerApiBaseUrl: globalConfig.tracker.apiBaseUrl,
  trackerImageContext: globalConfig.trackerImageContext,
  ...(globalConfig.trackerParentLinkType
    ? { trackerParentLinkType: globalConfig.trackerParentLinkType }
    : {}),
  ...(globalConfig.trackerBlockedByLinkType
    ? { trackerBlockedByLinkType: globalConfig.trackerBlockedByLinkType }
    : {}),
  gitlabUrl: globalConfig.gitlab.url,
  gitlabToken: globalConfig.gitlab.token,
  gitlabProjectId: repository.gitlabProjectId,
  gitRemoteName: repository.gitRemoteName,
  gitRepositoryToken: globalConfig.gitRepositoryToken,
  gitRepositoryUsername: globalConfig.gitRepositoryUsername,
  ...(repository.gitRepositoryUrl ? { gitRepositoryUrl: repository.gitRepositoryUrl } : {}),
  gitCommitNoVerify: globalConfig.gitCommitNoVerify,
  ...(globalConfig.gitAuthorName ? { gitAuthorName: globalConfig.gitAuthorName } : {}),
  ...(globalConfig.gitAuthorEmail ? { gitAuthorEmail: globalConfig.gitAuthorEmail } : {}),
  repoPath: repository.repoPath,
  baseBranch: repository.baseBranch,
  pollIntervalMinutes: globalConfig.pollIntervalMinutes,
  pollIntervalMs: globalConfig.pollIntervalMs,
  codexHome: globalConfig.codex.home,
  codexCliCommand: globalConfig.codex.cliCommand,
  codexCliArgs: globalConfig.codex.cliArgs,
  ...(globalConfig.codex.model ? { codexModel: globalConfig.codex.model } : {}),
  ...(globalConfig.codex.profile ? { codexProfile: globalConfig.codex.profile } : {}),
  codexSandbox: globalConfig.codex.sandbox,
  codexExecArgs: globalConfig.codex.execArgs,
  codexTimeoutMs: globalConfig.codex.timeoutMs,
  codexProgressLogIntervalMs: globalConfig.codex.progressLogIntervalMs,
  codexLogFullEvents: globalConfig.codex.logFullEvents,
  codexQuestionMarker: globalConfig.codex.questionMarker,
  codexSelfReviewEnabled: globalConfig.codex.selfReviewEnabled,
  codexSelfReviewMaxFixAttempts: globalConfig.codex.selfReviewMaxFixAttempts,
  maxFixAttempts: globalConfig.maxFixAttempts,
  maxReviewFixAttempts: globalConfig.maxReviewFixAttempts,
  workerId: globalConfig.workerId,
  ...(globalConfig.taskMode ? { taskMode: globalConfig.taskMode } : {}),
  ...(globalConfig.confidenceImplementThreshold !== undefined
    ? { confidenceImplementThreshold: globalConfig.confidenceImplementThreshold }
    : {}),
  ...(globalConfig.confidenceHumanThreshold !== undefined
    ? { confidenceHumanThreshold: globalConfig.confidenceHumanThreshold }
    : {}),
  decompositionMaxSubtasks:
    repository.decomposition?.maxSubtasks ??
    globalConfig.decompositionMaxSubtasks ??
    DEFAULT_DECOMPOSITION_MAX_SUBTASKS,
  decompositionCreateIssues:
    globalConfig.decompositionCreateIssues ?? DEFAULT_DECOMPOSITION_CREATE_ISSUES,
  decompositionDryRun: globalConfig.decompositionDryRun ?? DEFAULT_DECOMPOSITION_DRY_RUN,
  decompositionDefaultSubtaskTag:
    repository.decomposition?.defaultSubtaskTag ??
    globalConfig.decompositionDefaultSubtaskTag ??
    DEFAULT_DECOMPOSITION_SUBTASK_TAG,
  decompositionSubtaskTitlePrefix:
    repository.decomposition?.subtaskTitlePrefix ??
    globalConfig.decompositionSubtaskTitlePrefix ??
    DEFAULT_DECOMPOSITION_TITLE_PREFIX,
  dependencyEnforcement:
    globalConfig.dependencyEnforcement ?? DEFAULT_DEPENDENCY_ENFORCEMENT,
  dependencyUnknownStatusPolicy:
    globalConfig.dependencyUnknownStatusPolicy ?? DEFAULT_DEPENDENCY_UNKNOWN_STATUS_POLICY,
  ...(repository.promptProfiles ? { promptProfiles: repository.promptProfiles } : {}),
  ...(repository.typeCheckCommand ? { typeCheckCommand: repository.typeCheckCommand } : {}),
  testCommand: repository.testCommand,
  lintCommand: repository.lintCommand,
  ...(repository.buildCommand ? { buildCommand: repository.buildCommand } : {}),
  ...(repository.securityScanCommand
    ? { securityScanCommand: repository.securityScanCommand }
    : {}),
  ...(repository.sastCommand ? { sastCommand: repository.sastCommand } : {}),
  ...(repository.coverageCommand ? { coverageCommand: repository.coverageCommand } : {}),
  ...(repository.minCoveragePercent !== undefined
    ? { minCoveragePercent: repository.minCoveragePercent }
    : {}),
  ...(repository.coverageReportFile
    ? { coverageReportFile: repository.coverageReportFile }
    : {}),
  ...(repository.visualRegressionCommand
    ? { visualRegressionCommand: repository.visualRegressionCommand }
    : {}),
  ...(repository.visualRegressionArtifactsDir
    ? { visualRegressionArtifactsDir: repository.visualRegressionArtifactsDir }
    : {}),
  runOnce: globalConfig.runOnce,
  preflightOnly: globalConfig.preflightOnly,
  ...(globalConfig.trackerPreflightIssueKey
    ? { trackerPreflightIssueKey: globalConfig.trackerPreflightIssueKey }
    : {}),
  ...(globalConfig.gitlabPreflightSourceBranch
    ? { gitlabPreflightSourceBranch: globalConfig.gitlabPreflightSourceBranch }
    : {}),
  preflightRunTargetCommands: globalConfig.preflightRunTargetCommands,
  ...(globalConfig.targetIssueKey ? { targetIssueKey: globalConfig.targetIssueKey } : {}),
  memory: globalConfig.memory,
  observability: globalConfig.observability,
  ...(globalConfig.autonomy ? { autonomy: globalConfig.autonomy } : {}),
  ...(resolveRepositoryProjectManagerConfig(
    globalConfig.projectManager,
    repository.projectManager,
  )
    ? {
        projectManager: resolveRepositoryProjectManagerConfig(
          globalConfig.projectManager,
          repository.projectManager,
        ),
      }
    : {}),
});
