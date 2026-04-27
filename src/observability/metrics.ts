export type MetricLabelValue = string | number | boolean | undefined;
export type MetricLabels = Record<string, MetricLabelValue>;

export interface MetricsRegistry {
  incrementCounter(name: string, labels?: MetricLabels, value?: number): void;
  observeHistogram(name: string, labels: MetricLabels, value: number): void;
  setGauge(name: string, labels: MetricLabels, value: number): void;
  renderPrometheus(): string;
}

interface MetricPoint {
  labels: Record<string, string>;
  value: number;
}

interface HistogramPoint {
  labels: Record<string, string>;
  buckets: number[];
  sum: number;
  count: number;
}

const TASK_DURATION_BUCKETS = [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
const CODEX_DURATION_BUCKETS = [10, 30, 60, 120, 300, 600, 1200, 1800];
const GATE_DURATION_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600];
const DEFAULT_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1200];

const sanitizeMetricName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_:]/g, "_");

const normalizeLabels = (labels: MetricLabels = {}): Record<string, string> => {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined) {
      continue;
    }
    normalized[key.replace(/[^a-zA-Z0-9_]/g, "_")] = String(value);
  }
  return normalized;
};

const labelKey = (labels: Record<string, string>): string =>
  Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u0000");

const seriesKey = (name: string, labels: Record<string, string>): string =>
  `${sanitizeMetricName(name)}\u0001${labelKey(labels)}`;

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const formatLabels = (labels: Record<string, string>): string => {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
};

const histogramBucketsFor = (name: string): number[] => {
  if (name.includes("task_duration")) {
    return TASK_DURATION_BUCKETS;
  }
  if (name.includes("codex_duration")) {
    return CODEX_DURATION_BUCKETS;
  }
  if (name.includes("validation_gate_duration")) {
    return GATE_DURATION_BUCKETS;
  }
  return DEFAULT_BUCKETS;
};

export class InMemoryMetricsRegistry implements MetricsRegistry {
  private readonly counters = new Map<string, MetricPoint>();
  private readonly gauges = new Map<string, MetricPoint>();
  private readonly histograms = new Map<string, HistogramPoint>();
  private readonly histogramBuckets = new Map<string, number[]>();

  incrementCounter(name: string, labels: MetricLabels = {}, value = 1): void {
    const normalizedName = sanitizeMetricName(name);
    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(normalizedName, normalizedLabels);
    const current = this.counters.get(key);
    this.counters.set(key, {
      labels: normalizedLabels,
      value: (current?.value ?? 0) + value,
    });
  }

  observeHistogram(name: string, labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }

    const normalizedName = sanitizeMetricName(name);
    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(normalizedName, normalizedLabels);
    const buckets = histogramBucketsFor(normalizedName);
    const current =
      this.histograms.get(key) ??
      ({
        labels: normalizedLabels,
        buckets: Array.from({ length: buckets.length }, () => 0),
        sum: 0,
        count: 0,
      } satisfies HistogramPoint);

    buckets.forEach((bucket, index) => {
      if (value <= bucket) {
        current.buckets[index] = (current.buckets[index] ?? 0) + 1;
      }
    });
    current.sum += value;
    current.count += 1;
    this.histograms.set(key, current);
    this.histogramBuckets.set(normalizedName, buckets);
  }

  setGauge(name: string, labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }

    const normalizedName = sanitizeMetricName(name);
    const normalizedLabels = normalizeLabels(labels);
    this.gauges.set(seriesKey(normalizedName, normalizedLabels), {
      labels: normalizedLabels,
      value,
    });
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const renderPoint = (name: string, point: MetricPoint): void => {
      lines.push(`${name}${formatLabels(point.labels)} ${point.value}`);
    };

    for (const [key, point] of [...this.counters.entries()].sort()) {
      renderPoint(key.split("\u0001")[0] ?? key, point);
    }

    for (const [key, point] of [...this.gauges.entries()].sort()) {
      renderPoint(key.split("\u0001")[0] ?? key, point);
    }

    for (const [key, point] of [...this.histograms.entries()].sort()) {
      const name = key.split("\u0001")[0] ?? key;
      const buckets = this.histogramBuckets.get(name) ?? DEFAULT_BUCKETS;
      buckets.forEach((bucket, index) => {
        lines.push(
          `${name}_bucket${formatLabels({
            ...point.labels,
            le: String(bucket),
          })} ${point.buckets[index] ?? 0}`,
        );
      });
      lines.push(
        `${name}_bucket${formatLabels({ ...point.labels, le: "+Inf" })} ${point.count}`,
      );
      lines.push(`${name}_sum${formatLabels(point.labels)} ${point.sum}`);
      lines.push(`${name}_count${formatLabels(point.labels)} ${point.count}`);
    }

    return `${lines.join("\n")}\n`;
  }
}

export class NoopMetricsRegistry implements MetricsRegistry {
  incrementCounter(): void {}
  observeHistogram(): void {}
  setGauge(): void {}
  renderPrometheus(): string {
    return "";
  }
}
