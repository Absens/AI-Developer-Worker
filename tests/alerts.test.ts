import { describe, expect, it } from "vitest";

import type { ObservabilityConfig } from "../src/models/types.js";
import {
  BasicAlertService,
  type Alert,
  type NotificationSink,
} from "../src/observability/alerts.js";
import { defaultObservabilityConfig } from "../src/observability/config.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";

class RecordingSink implements NotificationSink {
  readonly name = "recording";
  readonly alerts: Alert[] = [];

  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}

const createConfig = (overrides: Partial<ObservabilityConfig> = {}): ObservabilityConfig => ({
  ...defaultObservabilityConfig(),
  enabled: true,
  alerts: {
    ...defaultObservabilityConfig().alerts,
    enabled: true,
    minSeverity: "info",
    dedupWindowSeconds: 900,
    channels: [{ type: "webhook", url: "https://example.test/webhook" }],
  },
  ...overrides,
});

describe("BasicAlertService", () => {
  it("sends task_failed alerts and deduplicates repeats", async () => {
    const sink = new RecordingSink();
    const metrics = new InMemoryMetricsRegistry();
    const alerts = new BasicAlertService(createConfig(), metrics, undefined, [sink]);

    await alerts.recordEvent({
      id: "event-1",
      timestamp: new Date().toISOString(),
      workerId: "worker-1",
      repositoryName: "repo",
      issueKey: "DEV-1",
      type: "task_failed",
      status: "error",
      message: "failed",
    });
    await alerts.recordEvent({
      id: "event-2",
      timestamp: new Date().toISOString(),
      workerId: "worker-1",
      repositoryName: "repo",
      issueKey: "DEV-1",
      type: "task_failed",
      status: "error",
      message: "failed again",
    });

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({
      rule: "task_failed",
      severity: "error",
      repositoryName: "repo",
      issueKey: "DEV-1",
    });
    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain('outcome="sent"');
    expect(rendered).toContain('outcome="deduped"');
  });

  it("emits repeated validation failure alerts after the configured threshold", async () => {
    const sink = new RecordingSink();
    const alerts = new BasicAlertService(
      createConfig({
        alerts: {
          ...defaultObservabilityConfig().alerts,
          enabled: true,
          minSeverity: "warning",
          dedupWindowSeconds: 0,
          validationFailureThreshold: 2,
          validationFailureWindowSeconds: 3600,
          channels: [{ type: "webhook", url: "https://example.test/webhook" }],
        },
      }),
      new InMemoryMetricsRegistry(),
      undefined,
      [sink],
    );

    for (const id of ["event-1", "event-2"]) {
      await alerts.recordEvent({
        id,
        timestamp: new Date().toISOString(),
        workerId: "worker-1",
        repositoryName: "repo",
        issueKey: "DEV-1",
        type: "validation_completed",
        status: "error",
        message: "Validation gate tests failed.",
        details: { gate: "tests" },
      });
    }

    expect(sink.alerts.some((alert) => alert.rule === "validation_failures_repeated")).toBe(
      true,
    );
  });
});
