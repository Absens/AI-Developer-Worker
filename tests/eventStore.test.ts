import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { ObservabilityConfig } from "../src/models/types.js";
import { InMemoryEventStore } from "../src/observability/events.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";
import { defaultObservabilityConfig } from "../src/observability/config.js";

const cleanupPaths: string[] = [];

const createConfig = (overrides: Partial<ObservabilityConfig> = {}): ObservabilityConfig => ({
  ...defaultObservabilityConfig(),
  enabled: true,
  ...overrides,
});

describe("InMemoryEventStore", () => {
  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("keeps a bounded recent event buffer", async () => {
    const store = new InMemoryEventStore(
      createConfig({ events: { store: "memory", retention: 2 } }),
      new InMemoryMetricsRegistry(),
    );

    await store.append({
      workerId: "worker-1",
      repositoryName: "repo",
      type: "task_picked",
      status: "info",
      message: "first",
    });
    await store.append({
      workerId: "worker-1",
      repositoryName: "repo",
      type: "task_failed",
      status: "error",
      message: "TRACKER_TOKEN=secret",
    });
    await store.append({
      workerId: "worker-1",
      repositoryName: "repo",
      type: "mr_ready",
      status: "info",
      message: "third",
    });

    const events = await store.listRecent({ limit: 10 });

    expect(events.map((event) => event.message)).toEqual(["third", "TRACKER_TOKEN=[redacted]"]);
  });

  it("persists bounded JSONL events when file store is enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "observability-events-"));
    cleanupPaths.push(directory);
    const file = join(directory, "events.jsonl");
    const config = createConfig({
      events: { store: "file", file, retention: 2 },
    });
    const metrics = new InMemoryMetricsRegistry();
    const store = new InMemoryEventStore(config, metrics);

    await store.append({
      workerId: "worker-1",
      repositoryName: "repo",
      type: "task_failed",
      status: "error",
      message: "failed",
    });

    expect(readFileSync(file, "utf8")).toContain('"type":"task_failed"');

    const reloaded = new InMemoryEventStore(config, metrics);
    expect(await reloaded.listRecent({ limit: 10 })).toHaveLength(1);
  });
});
