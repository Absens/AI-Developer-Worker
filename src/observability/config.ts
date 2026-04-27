import type {
  AlertChannelConfig,
  AlertSeverity,
  ObservabilityAlertsConfig,
  ObservabilityConfig,
} from "../models/types.js";
import { ConfigurationError } from "../utils/errors.js";

const DEFAULT_OBSERVABILITY_PORT = 9464;
const DEFAULT_REDACT_MAX_CHARS = 4000;
const DEFAULT_EVENT_RETENTION = 1000;

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

const optionalRecord = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${key} must be an object.`);
  }

  return value as Record<string, unknown>;
};

const parseBoolean = (
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

const parsePositiveInt = (input: string, key: string): number => {
  const value = Number.parseInt(input, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${key} must be a positive integer.`);
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

const normalizePath = (path: string, key: string): string => {
  const trimmed = path.trim() || "/";
  if (!trimmed.startsWith("/")) {
    throw new ConfigurationError(`${key} must start with "/".`);
  }
  return trimmed.replace(/\/+$/, "") || "/";
};

const parseAlertSeverity = (
  input: string | undefined,
  key: string,
  defaultValue: AlertSeverity,
): AlertSeverity => {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (normalized === "info" || normalized === "warning" || normalized === "error") {
    return normalized;
  }

  throw new ConfigurationError(`${key} must be one of: info, warning, error.`);
};

const parseOptionalSeverity = (
  value: unknown,
  key: string,
  defaultValue: AlertSeverity,
): AlertSeverity => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new ConfigurationError(`${key} must be a string.`);
  }
  return parseAlertSeverity(value, key, defaultValue);
};

const parseEventStoreKind = (
  value: string | undefined,
  key: string,
): "memory" | "file" => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "memory";
  }

  if (normalized === "memory" || normalized === "file") {
    return normalized;
  }

  throw new ConfigurationError(`${key} must be either memory or file.`);
};

const parseEnvAlertChannels = (env: NodeJS.ProcessEnv): AlertChannelConfig[] => {
  const channels = (env.ALERT_CHANNELS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return channels.map((channel) => {
    if (channel === "webhook") {
      return { type: "webhook", url: env.ALERT_WEBHOOK_URL?.trim() || undefined };
    }
    if (channel === "slack") {
      return { type: "slack", webhookUrl: env.SLACK_WEBHOOK_URL?.trim() || undefined };
    }
    if (channel === "telegram") {
      return {
        type: "telegram",
        botToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
        chatId: env.TELEGRAM_CHAT_ID?.trim() || undefined,
      };
    }

    throw new ConfigurationError(
      `ALERT_CHANNELS contains unsupported channel "${channel}".`,
    );
  });
};

const parseRawAlertChannels = (
  rawValue: unknown,
  env: NodeJS.ProcessEnv,
): AlertChannelConfig[] => {
  if (rawValue === undefined || rawValue === null) {
    return parseEnvAlertChannels(env);
  }

  if (!Array.isArray(rawValue)) {
    throw new ConfigurationError("alerts.channels must be an array.");
  }

  return rawValue.map((entry, index): AlertChannelConfig => {
    const raw = optionalRecord(entry, `alerts.channels[${index}]`) ?? {};
    const type = optionalString(raw.type, `alerts.channels[${index}].type`);
    if (type === "webhook") {
      const url =
        optionalString(raw.url, `alerts.channels[${index}].url`) ||
        env[optionalString(raw.urlEnv, `alerts.channels[${index}].urlEnv`) ?? ""]?.trim();
      return { type, ...(url ? { url } : {}) };
    }
    if (type === "slack") {
      const webhookUrl =
        optionalString(raw.webhookUrl, `alerts.channels[${index}].webhookUrl`) ||
        env[
          optionalString(raw.webhookUrlEnv, `alerts.channels[${index}].webhookUrlEnv`) ??
            ""
        ]?.trim();
      return { type, ...(webhookUrl ? { webhookUrl } : {}) };
    }
    if (type === "telegram") {
      const botToken =
        optionalString(raw.botToken, `alerts.channels[${index}].botToken`) ||
        env[
          optionalString(raw.botTokenEnv, `alerts.channels[${index}].botTokenEnv`) ?? ""
        ]?.trim();
      const chatId =
        optionalString(raw.chatId, `alerts.channels[${index}].chatId`) ||
        env[
          optionalString(raw.chatIdEnv, `alerts.channels[${index}].chatIdEnv`) ?? ""
        ]?.trim();
      return {
        type,
        ...(botToken ? { botToken } : {}),
        ...(chatId ? { chatId } : {}),
      };
    }

    throw new ConfigurationError(
      `alerts.channels[${index}].type must be one of: webhook, slack, telegram.`,
    );
  });
};

const parseAlertsConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
): ObservabilityAlertsConfig => ({
  enabled: env.ALERTS_ENABLED?.trim()
    ? parseBoolean(env.ALERTS_ENABLED, "ALERTS_ENABLED", false)
    : optionalBoolean(rawValue?.enabled, "alerts.enabled", false),
  minSeverity: env.ALERT_MIN_SEVERITY?.trim()
    ? parseAlertSeverity(env.ALERT_MIN_SEVERITY, "ALERT_MIN_SEVERITY", "warning")
    : parseOptionalSeverity(rawValue?.minSeverity, "alerts.minSeverity", "warning"),
  dedupWindowSeconds: env.ALERT_DEDUP_WINDOW_SECONDS?.trim()
    ? parsePositiveInt(env.ALERT_DEDUP_WINDOW_SECONDS, "ALERT_DEDUP_WINDOW_SECONDS")
    : optionalPositiveInt(
        rawValue?.dedupWindowSeconds,
        "alerts.dedupWindowSeconds",
        900,
      ),
  queueBlockedCycles: env.ALERT_QUEUE_BLOCKED_CYCLES?.trim()
    ? parsePositiveInt(env.ALERT_QUEUE_BLOCKED_CYCLES, "ALERT_QUEUE_BLOCKED_CYCLES")
    : optionalPositiveInt(
        rawValue?.queueBlockedCycles,
        "alerts.queueBlockedCycles",
        3,
      ),
  codexTimeoutWindowSeconds: env.ALERT_CODEX_TIMEOUT_WINDOW_SECONDS?.trim()
    ? parsePositiveInt(
        env.ALERT_CODEX_TIMEOUT_WINDOW_SECONDS,
        "ALERT_CODEX_TIMEOUT_WINDOW_SECONDS",
      )
    : optionalPositiveInt(
        rawValue?.codexTimeoutWindowSeconds,
        "alerts.codexTimeoutWindowSeconds",
        3600,
      ),
  codexTimeoutThreshold: env.ALERT_CODEX_TIMEOUT_THRESHOLD?.trim()
    ? parsePositiveInt(
        env.ALERT_CODEX_TIMEOUT_THRESHOLD,
        "ALERT_CODEX_TIMEOUT_THRESHOLD",
      )
    : optionalPositiveInt(
        rawValue?.codexTimeoutThreshold,
        "alerts.codexTimeoutThreshold",
        3,
      ),
  validationFailureWindowSeconds: env.ALERT_VALIDATION_FAILURE_WINDOW_SECONDS?.trim()
    ? parsePositiveInt(
        env.ALERT_VALIDATION_FAILURE_WINDOW_SECONDS,
        "ALERT_VALIDATION_FAILURE_WINDOW_SECONDS",
      )
    : optionalPositiveInt(
        rawValue?.validationFailureWindowSeconds,
        "alerts.validationFailureWindowSeconds",
        3600,
      ),
  validationFailureThreshold: env.ALERT_VALIDATION_FAILURE_THRESHOLD?.trim()
    ? parsePositiveInt(
        env.ALERT_VALIDATION_FAILURE_THRESHOLD,
        "ALERT_VALIDATION_FAILURE_THRESHOLD",
      )
    : optionalPositiveInt(
        rawValue?.validationFailureThreshold,
        "alerts.validationFailureThreshold",
        3,
      ),
  workerStaleSeconds: env.ALERT_WORKER_STALE_SECONDS?.trim()
    ? parsePositiveInt(env.ALERT_WORKER_STALE_SECONDS, "ALERT_WORKER_STALE_SECONDS")
    : optionalPositiveInt(rawValue?.workerStaleSeconds, "alerts.workerStaleSeconds", 300),
  channels: parseRawAlertChannels(rawValue?.channels, env),
});

export const parseObservabilityConfig = (
  env: NodeJS.ProcessEnv = process.env,
  rawValue?: Record<string, unknown>,
): ObservabilityConfig => {
  const metrics = optionalRecord(rawValue?.metrics, "observability.metrics");
  const health = optionalRecord(rawValue?.health, "observability.health");
  const dashboard = optionalRecord(rawValue?.dashboard, "observability.dashboard");
  const events = optionalRecord(rawValue?.events, "observability.events");
  const alertsRoot =
    optionalRecord(rawValue?.alerts, "observability.alerts") ??
    optionalRecord((rawValue as { alerts?: unknown } | undefined)?.alerts, "alerts");
  const envPort = env.OBSERVABILITY_PORT?.trim() || env.METRICS_PORT?.trim();
  const rawPort =
    rawValue?.port === undefined || rawValue?.port === null
      ? DEFAULT_OBSERVABILITY_PORT
      : optionalPositiveInt(rawValue.port, "observability.port", DEFAULT_OBSERVABILITY_PORT);
  const port = envPort
    ? parsePositiveInt(envPort, env.OBSERVABILITY_PORT?.trim() ? "OBSERVABILITY_PORT" : "METRICS_PORT")
    : rawPort;
  const host =
    env.OBSERVABILITY_HOST?.trim() ||
    env.METRICS_HOST?.trim() ||
    optionalString(rawValue?.host, "observability.host") ||
    "127.0.0.1";

  return {
    enabled: env.OBSERVABILITY_ENABLED?.trim()
      ? parseBoolean(env.OBSERVABILITY_ENABLED, "OBSERVABILITY_ENABLED", false)
      : optionalBoolean(rawValue?.enabled, "observability.enabled", false),
    host,
    port,
    baseUrl:
      env.OBSERVABILITY_BASE_URL?.trim()?.replace(/\/+$/, "") ||
      optionalString(rawValue?.baseUrl, "observability.baseUrl")?.replace(/\/+$/, "") ||
      `http://${host}:${port}`,
    strictStartup: env.OBSERVABILITY_STRICT_STARTUP?.trim()
      ? parseBoolean(
          env.OBSERVABILITY_STRICT_STARTUP,
          "OBSERVABILITY_STRICT_STARTUP",
          true,
        )
      : optionalBoolean(rawValue?.strictStartup, "observability.strictStartup", true),
    redactMaxChars: env.OBSERVABILITY_REDACT_MAX_CHARS?.trim()
      ? parsePositiveInt(
          env.OBSERVABILITY_REDACT_MAX_CHARS,
          "OBSERVABILITY_REDACT_MAX_CHARS",
        )
      : optionalPositiveInt(
          rawValue?.redactMaxChars,
          "observability.redactMaxChars",
          DEFAULT_REDACT_MAX_CHARS,
        ),
    metrics: {
      enabled: env.METRICS_ENABLED?.trim()
        ? parseBoolean(env.METRICS_ENABLED, "METRICS_ENABLED", true)
        : optionalBoolean(metrics?.enabled, "observability.metrics.enabled", true),
      path: normalizePath(
        env.METRICS_PATH?.trim() ||
          optionalString(metrics?.path, "observability.metrics.path") ||
          "/metrics",
        "METRICS_PATH",
      ),
    },
    health: {
      path: normalizePath(
        env.HEALTH_PATH?.trim() ||
          optionalString(health?.path, "observability.health.path") ||
          "/healthz",
        "HEALTH_PATH",
      ),
      readinessPath: normalizePath(
        env.READY_PATH?.trim() ||
          optionalString(health?.readinessPath, "observability.health.readinessPath") ||
          "/readyz",
        "READY_PATH",
      ),
    },
    events: {
      store: parseEventStoreKind(
        env.OBSERVABILITY_EVENT_STORE?.trim() ||
          optionalString(events?.store, "observability.events.store"),
        "OBSERVABILITY_EVENT_STORE",
      ),
      ...(env.OBSERVABILITY_EVENT_STORE_FILE?.trim() ||
      optionalString(events?.file, "observability.events.file")
        ? {
            file:
              env.OBSERVABILITY_EVENT_STORE_FILE?.trim() ||
              optionalString(events?.file, "observability.events.file"),
          }
        : {}),
      retention: env.OBSERVABILITY_EVENT_RETENTION?.trim()
        ? parsePositiveInt(
            env.OBSERVABILITY_EVENT_RETENTION,
            "OBSERVABILITY_EVENT_RETENTION",
          )
        : optionalPositiveInt(
            events?.retention,
            "observability.events.retention",
            DEFAULT_EVENT_RETENTION,
          ),
    },
    dashboard: {
      enabled: env.DASHBOARD_ENABLED?.trim()
        ? parseBoolean(env.DASHBOARD_ENABLED, "DASHBOARD_ENABLED", false)
        : optionalBoolean(dashboard?.enabled, "observability.dashboard.enabled", false),
      path: normalizePath(
        env.DASHBOARD_PATH?.trim() ||
          optionalString(dashboard?.path, "observability.dashboard.path") ||
          "/dashboard",
        "DASHBOARD_PATH",
      ),
      refreshSeconds: env.DASHBOARD_REFRESH_SECONDS?.trim()
        ? parsePositiveInt(
            env.DASHBOARD_REFRESH_SECONDS,
            "DASHBOARD_REFRESH_SECONDS",
          )
        : optionalPositiveInt(
            dashboard?.refreshSeconds,
            "observability.dashboard.refreshSeconds",
            10,
          ),
      apiPath: normalizePath(
        env.DASHBOARD_API_PATH?.trim() ||
          optionalString(dashboard?.apiPath, "observability.dashboard.apiPath") ||
          "/api",
        "DASHBOARD_API_PATH",
      ),
      ...(env.DASHBOARD_BEARER_TOKEN?.trim() ||
      optionalString(dashboard?.bearerToken, "observability.dashboard.bearerToken")
        ? {
            bearerToken:
              env.DASHBOARD_BEARER_TOKEN?.trim() ||
              optionalString(dashboard?.bearerToken, "observability.dashboard.bearerToken"),
          }
        : {}),
    },
    alerts: parseAlertsConfig(
      env,
      alertsRoot ??
        optionalRecord((rawValue as Record<string, unknown> | undefined)?.alerts, "alerts"),
    ),
  };
};

export const defaultObservabilityConfig = (): ObservabilityConfig =>
  parseObservabilityConfig({});
