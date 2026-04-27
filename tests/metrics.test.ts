import { describe, expect, it } from "vitest";

import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";

describe("InMemoryMetricsRegistry", () => {
  it("renders counters, gauges, and histograms in Prometheus text format", () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.incrementCounter("ai_developer_tasks_total", {
      repository: "client",
      status: "success",
    });
    metrics.setGauge("ai_developer_queue_depth", {
      repository: "client",
      queue: "FRONTEND",
    }, 3);
    metrics.observeHistogram("ai_developer_task_duration_seconds", {
      repository: "client",
      outcome: "success",
    }, 45);

    const rendered = metrics.renderPrometheus();

    expect(rendered).toContain(
      'ai_developer_tasks_total{repository="client",status="success"} 1',
    );
    expect(rendered).toContain(
      'ai_developer_queue_depth{queue="FRONTEND",repository="client"} 3',
    );
    expect(rendered).toContain(
      'ai_developer_task_duration_seconds_bucket{le="60",outcome="success",repository="client"} 1',
    );
    expect(rendered).toContain(
      'ai_developer_task_duration_seconds_count{outcome="success",repository="client"} 1',
    );
  });

  it("escapes label values", () => {
    const metrics = new InMemoryMetricsRegistry();
    metrics.incrementCounter("metric_total", { label: 'a"b\\c' });

    expect(metrics.renderPrometheus()).toContain('metric_total{label="a\\"b\\\\c"} 1');
  });
});
