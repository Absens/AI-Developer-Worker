import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AppConfig,
  LogicalStatus,
  TrackerOrgHeader,
  TrackerStatusConfig,
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
  };
};
