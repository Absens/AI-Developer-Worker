import { homedir } from "node:os";
import { join } from "node:path";

import type { AppConfig, LogicalStatus, TrackerStatusConfig } from "./models/types.js";
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

const normalizeStatusConfig = (
  rawValue: unknown,
  logicalStatus: LogicalStatus,
): TrackerStatusConfig => {
  if (typeof rawValue !== "object" || rawValue === null) {
    throw new ConfigurationError(
      `TRACKER_STATUS_MAP.${logicalStatus} must be an object.`,
    );
  }

  const value = rawValue as { statuses?: unknown; transition?: unknown };
  if (!Array.isArray(value.statuses) || value.statuses.length === 0) {
    throw new ConfigurationError(
      `TRACKER_STATUS_MAP.${logicalStatus}.statuses must be a non-empty array.`,
    );
  }

  const statuses = value.statuses.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigurationError(
        `TRACKER_STATUS_MAP.${logicalStatus}.statuses must contain strings.`,
      );
    }
    return entry.trim();
  });

  if (value.transition !== undefined && typeof value.transition !== "string") {
    throw new ConfigurationError(
      `TRACKER_STATUS_MAP.${logicalStatus}.transition must be a string.`,
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
      `TRACKER_STATUS_MAP must be valid JSON. ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigurationError("TRACKER_STATUS_MAP must be a JSON object.");
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

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const trackerStatusMap = parseStatusMap(requireEnv(env, "TRACKER_STATUS_MAP"));
  const pollIntervalMinutes = parsePositiveInt(
    env.POLL_INTERVAL_MINUTES?.trim() || "30",
    "POLL_INTERVAL_MINUTES",
  );

  return {
    trackerToken: requireEnv(env, "TRACKER_TOKEN"),
    trackerOrgId: requireEnv(env, "TRACKER_ORG_ID"),
    trackerTag: env.TRACKER_TAG?.trim() || "ai_dev",
    trackerStatusMap,
    trackerApiBaseUrl:
      env.TRACKER_API_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://api.tracker.yandex.net/v3",
    gitlabUrl: requireEnv(env, "GITLAB_URL").replace(/\/+$/, ""),
    gitlabToken: requireEnv(env, "GITLAB_TOKEN"),
    gitlabProjectId: requireEnv(env, "GITLAB_PROJECT_ID"),
    repoPath: env.REPO_PATH?.trim() || "/workspace/project",
    baseBranch: env.BASE_BRANCH?.trim() || "main",
    pollIntervalMinutes,
    pollIntervalMs: pollIntervalMinutes * 60 * 1000,
    codexHome: env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    codexCliCommand: env.CODEX_CLI_COMMAND?.trim() || "codex",
    codexCommand: requireEnv(env, "CODEX_COMMAND"),
    codexQuestionMarker: env.CODEX_QUESTION_MARKER?.trim() || "AI_QUESTION:",
    maxFixAttempts: parsePositiveInt(
      requireEnv(env, "MAX_FIX_ATTEMPTS"),
      "MAX_FIX_ATTEMPTS",
    ),
    workerId: requireEnv(env, "WORKER_ID"),
    testCommand: env.TEST_COMMAND?.trim() || "npm test",
    lintCommand: env.LINT_COMMAND?.trim() || "npm run lint",
    runOnce: env.WORKER_RUN_ONCE?.trim().toLowerCase() === "true",
  };
};
