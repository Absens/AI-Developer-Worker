import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import type {
  AppConfig,
  CoordinationConfig,
  DependencyUnknownStatusPolicy,
  GlobalWorkerConfig,
  LogicalStatus,
  PriorityQueueConfig,
  PromptProfileOverrideMap,
  RepositoryDecompositionConfig,
  RepositoryProfile,
  RepositoryRuntimeConfig,
  TrackerOrgHeader,
  TrackerStatusConfig,
  WorkerTaskMode,
} from "./models/types.js";
import { ConfigurationError } from "./utils/errors.js";

const LOGICAL_STATUSES: LogicalStatus[] = [
  "open",
  "in_progress",
  "waiting_for_answer",
  "review",
  "failed",
  "done",
];

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

const parseCodexSandbox = (
  input?: string,
): "read-only" | "workspace-write" | "danger-full-access" => {
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
  const trackerStatusMap = loadStatusMapFromFile(env);
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

  return {
    trackerToken: requireEnv(env, "TRACKER_TOKEN"),
    trackerOrgHeader: parseTrackerOrgHeader(env.TRACKER_ORG_HEADER),
    trackerOrgId: requireEnv(env, "TRACKER_ORG_ID"),
    trackerDefaultQueue: env.TRACKER_DEFAULT_QUEUE?.trim() || "FRONTEND",
    trackerTag: env.TRACKER_TAG?.trim() || "ai_dev",
    trackerStatusMap,
    trackerApiBaseUrl:
      env.TRACKER_API_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://api.tracker.yandex.net/v3",
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
  };
};

const parseCoordinationConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
): CoordinationConfig => {
  const lockBackend =
    env.LOCK_BACKEND?.trim() ||
    optionalString(rawValue?.lockBackend, "coordination.lockBackend") ||
    "tracker";
  if (
    lockBackend !== "tracker" &&
    lockBackend !== "redis" &&
    lockBackend !== "postgres"
  ) {
    throw new ConfigurationError("LOCK_BACKEND must be one of: tracker, redis, postgres.");
  }
  if (lockBackend === "redis") {
    throw new ConfigurationError("LOCK_BACKEND=redis is not implemented yet.");
  }
  if (lockBackend === "postgres") {
    throw new ConfigurationError("LOCK_BACKEND=postgres is not implemented yet.");
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
): GlobalWorkerConfig => ({
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
  ...(config.trackerParentLinkType ? { trackerParentLinkType: config.trackerParentLinkType } : {}),
  ...(config.trackerBlockedByLinkType
    ? { trackerBlockedByLinkType: config.trackerBlockedByLinkType }
    : {}),
  maxFixAttempts: config.maxFixAttempts,
  maxReviewFixAttempts: config.maxReviewFixAttempts,
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
  },
  coordination: parseCoordinationConfig(env),
  priorityQueue: parsePriorityQueueConfig(env),
  repositories: [
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
    },
  ],
});

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
  };
};

const validateRepositoryProfiles = (repositories: RepositoryProfile[]): void => {
  const names = new Set<string>();
  for (const repository of repositories) {
    if (names.has(repository.name)) {
      throw new ConfigurationError(`Duplicate repository name: ${repository.name}`);
    }
    names.add(repository.name);
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
  const coordination = optionalRecord(root.coordination, "coordination");
  const priorityQueue = optionalRecord(root.priorityQueue, "priorityQueue");
  if (!Array.isArray(root.repositories) || root.repositories.length === 0) {
    throw new ConfigurationError("repositories must be a non-empty array.");
  }
  const repositories = root.repositories.map(parseRepositoryProfile);
  validateRepositoryProfiles(repositories);

  const statusMapFile =
    optionalString(tracker.statusMapFile, "tracker.statusMapFile") ??
    requireEnv(env, "TRACKER_STATUS_MAP_FILE");
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
      token: resolveEnvReference(
        env,
        tracker,
        "token",
        "tokenEnv",
        "TRACKER_TOKEN",
        "tracker",
      ),
      orgHeader: parseTrackerOrgHeader(
        optionalString(tracker.orgHeader, "tracker.orgHeader") ?? env.TRACKER_ORG_HEADER,
      ),
      orgId: resolveEnvReference(
        env,
        tracker,
        "orgId",
        "orgIdEnv",
        "TRACKER_ORG_ID",
        "tracker",
      ),
      statusMap: readStatusMapFile(statusMapFile, "tracker.statusMapFile"),
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
    },
    coordination: parseCoordinationConfig(env, coordination),
    priorityQueue: parsePriorityQueueConfig(env, priorityQueue),
    repositories,
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
  repositoryName: repository.name,
  trackerToken: globalConfig.tracker.token,
  trackerOrgHeader: globalConfig.tracker.orgHeader,
  trackerOrgId: globalConfig.tracker.orgId,
  trackerDefaultQueue: repository.queues[0] ?? "FRONTEND",
  trackerTag: repository.tags[0] ?? "ai_dev",
  trackerStatusMap: globalConfig.tracker.statusMap,
  trackerApiBaseUrl: globalConfig.tracker.apiBaseUrl,
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
});
