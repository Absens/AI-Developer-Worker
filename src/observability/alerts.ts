import type {
  AlertChannelConfig,
  AlertSeverity,
  ObservabilityAlertsConfig,
  ObservabilityConfig,
} from "../models/types.js";
import type { Logger } from "../utils/logger.js";
import type { TaskEvent } from "./events.js";
import type { MetricsRegistry } from "./metrics.js";
import { redactSecrets } from "./redaction.js";

export interface Alert {
  id: string;
  rule: string;
  severity: AlertSeverity;
  timestamp: string;
  repositoryName?: string;
  issueKey?: string;
  stage?: string;
  mergeRequestUrl?: string;
  message: string;
}

export interface AlertService {
  recordEvent(event: TaskEvent): Promise<void>;
  listRecent(limit: number): Alert[];
}

export interface NotificationSink {
  name: string;
  send(alert: Alert): Promise<void>;
}

const severityRank: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

const shouldSendSeverity = (
  severity: AlertSeverity,
  minSeverity: AlertSeverity,
): boolean => severityRank[severity] >= severityRank[minSeverity];

const nowIso = (): string => new Date().toISOString();

const alertKey = (alert: Alert): string =>
  [alert.rule, alert.repositoryName ?? "", alert.issueKey ?? "", alert.stage ?? ""].join("\u0000");

const formatAlertText = (alert: Alert): string =>
  [
    `[${alert.severity}] ${alert.rule}`,
    alert.repositoryName ? `repository=${alert.repositoryName}` : "",
    alert.issueKey ? `issue=${alert.issueKey}` : "",
    alert.stage ? `stage=${alert.stage}` : "",
    alert.mergeRequestUrl ? `mr=${alert.mergeRequestUrl}` : "",
    alert.message,
  ]
    .filter(Boolean)
    .join(" ");

class WebhookSink implements NotificationSink {
  readonly name: string;

  constructor(private readonly channel: AlertChannelConfig) {
    this.name = channel.type;
  }

  async send(alert: Alert): Promise<void> {
    if (this.channel.type === "webhook") {
      await this.postJson(this.channel.url, alert);
      return;
    }

    if (this.channel.type === "slack") {
      await this.postJson(this.channel.webhookUrl, {
        text: formatAlertText(alert),
      });
      return;
    }

    const token = this.channel.botToken;
    const chatId = this.channel.chatId;
    if (!token || !chatId) {
      throw new Error("Telegram alert channel is missing bot token or chat id.");
    }
    await this.postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: formatAlertText(alert),
      disable_web_page_preview: true,
    });
  }

  private async postJson(url: string | undefined, body: unknown): Promise<void> {
    if (!url) {
      throw new Error(`${this.name} alert channel is missing credentials.`);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${this.name} alert channel returned HTTP ${response.status}.`);
    }
  }
}

export class BasicAlertService implements AlertService {
  private readonly sinks: NotificationSink[];
  private readonly recentAlerts: Alert[] = [];
  private readonly lastSentAt = new Map<string, number>();
  private readonly validationFailures = new Map<string, number[]>();
  private readonly codexTimeouts = new Map<string, number[]>();
  private readonly queueBlockedCycles = new Map<string, number>();

  constructor(
    private readonly config: ObservabilityConfig,
    private readonly metrics: MetricsRegistry,
    private readonly logger?: Logger,
    sinks?: NotificationSink[],
  ) {
    this.sinks =
      sinks ??
      config.alerts.channels.map((channel) => new WebhookSink(channel));
  }

  async recordEvent(event: TaskEvent): Promise<void> {
    if (!this.config.alerts.enabled) {
      return;
    }

    const alerts = this.evaluate(event);
    for (const alert of alerts) {
      await this.send(alert);
    }
  }

  listRecent(limit: number): Alert[] {
    return this.recentAlerts.slice(-Math.min(Math.max(limit, 1), 50)).reverse();
  }

  private evaluate(event: TaskEvent): Alert[] {
    const alerts: Alert[] = [];
    if (event.type === "task_failed") {
      alerts.push(this.alertFromEvent("task_failed", "error", event, event.message));
    }
    if (event.type === "mr_ready") {
      alerts.push(this.alertFromEvent("mr_ready", "info", event, event.message));
    }
    if (event.type === "task_lease_blocked") {
      const key = event.repositoryName ?? "unknown";
      const count = (this.queueBlockedCycles.get(key) ?? 0) + 1;
      this.queueBlockedCycles.set(key, count);
      if (count >= this.config.alerts.queueBlockedCycles) {
        alerts.push(
          this.alertFromEvent(
            "queue_blocked",
            "warning",
            event,
            `Queue has been blocked for ${count} cycles.`,
          ),
        );
      }
    } else if (event.type === "task_picked" && event.repositoryName) {
      this.queueBlockedCycles.delete(event.repositoryName);
    }

    if (
      event.type === "validation_completed" &&
      event.status === "error" &&
      event.repositoryName
    ) {
      const gate =
        typeof event.details?.gate === "string" ? event.details.gate : event.details?.gateId;
      const key = `${event.repositoryName}:${typeof gate === "string" ? gate : "unknown"}`;
      const failures = this.pushWindowed(
        this.validationFailures,
        key,
        this.config.alerts.validationFailureWindowSeconds,
      );
      if (failures >= this.config.alerts.validationFailureThreshold) {
        alerts.push(
          this.alertFromEvent(
            "validation_failures_repeated",
            "warning",
            event,
            `Repeated validation failures for ${key}.`,
          ),
        );
      }
    }

    if (event.details?.timedOut === true && event.repositoryName) {
      const failures = this.pushWindowed(
        this.codexTimeouts,
        event.repositoryName,
        this.config.alerts.codexTimeoutWindowSeconds,
      );
      if (failures >= this.config.alerts.codexTimeoutThreshold) {
        alerts.push(
          this.alertFromEvent(
            "codex_timeouts_repeated",
            "warning",
            event,
            `Repeated Codex timeouts for ${event.repositoryName}.`,
          ),
        );
      }
    }

    return alerts;
  }

  private pushWindowed(
    store: Map<string, number[]>,
    key: string,
    windowSeconds: number,
  ): number {
    const now = Date.now();
    const since = now - windowSeconds * 1000;
    const values = (store.get(key) ?? []).filter((timestamp) => timestamp >= since);
    values.push(now);
    store.set(key, values);
    return values.length;
  }

  private alertFromEvent(
    rule: string,
    severity: AlertSeverity,
    event: TaskEvent,
    message: string,
  ): Alert {
    return redactSecrets(
      {
        id: `${event.id}:${rule}`,
        rule,
        severity,
        timestamp: nowIso(),
        ...(event.repositoryName ? { repositoryName: event.repositoryName } : {}),
        ...(event.issueKey ? { issueKey: event.issueKey } : {}),
        stage: event.type,
        ...(event.mergeRequestUrl ? { mergeRequestUrl: event.mergeRequestUrl } : {}),
        message,
      },
      this.config.redactMaxChars,
    );
  }

  private async send(alert: Alert): Promise<void> {
    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > 50) {
      this.recentAlerts.splice(0, this.recentAlerts.length - 50);
    }

    const outcome = await this.sendWithDedup(alert);
    this.metrics.incrementCounter("ai_developer_alerts_total", {
      rule: alert.rule,
      severity: alert.severity,
      outcome,
    });
  }

  private async sendWithDedup(alert: Alert): Promise<"sent" | "deduped" | "filtered" | "failed"> {
    if (!shouldSendSeverity(alert.severity, this.config.alerts.minSeverity)) {
      return "filtered";
    }

    const key = alertKey(alert);
    const now = Date.now();
    const previous = this.lastSentAt.get(key);
    if (
      previous !== undefined &&
      now - previous < this.config.alerts.dedupWindowSeconds * 1000
    ) {
      return "deduped";
    }
    this.lastSentAt.set(key, now);

    if (this.sinks.length === 0) {
      this.logger?.warn("Alert generated without configured notification sinks.", {
        rule: alert.rule,
        severity: alert.severity,
      });
      return "failed";
    }

    let failed = false;
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.send(alert);
        } catch (error) {
          failed = true;
          this.logger?.warn("Alert notification failed.", {
            sink: sink.name,
            rule: alert.rule,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return failed ? "failed" : "sent";
  }
}

export class NoopAlertService implements AlertService {
  async recordEvent(): Promise<void> {}
  listRecent(): Alert[] {
    return [];
  }
}
