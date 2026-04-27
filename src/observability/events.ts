import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ObservabilityConfig } from "../models/types.js";
import type { Logger } from "../utils/logger.js";
import type { MetricsRegistry } from "./metrics.js";
import { redactSecrets } from "./redaction.js";

export type TaskEventStatus = "info" | "warning" | "error";

export type TaskEventType =
  | "worker_started"
  | "worker_ready"
  | "worker_stopping"
  | "queue_polled"
  | "task_candidate_found"
  | "task_picked"
  | "task_lease_acquired"
  | "task_lease_blocked"
  | "analysis_started"
  | "analysis_completed"
  | "clarification_requested"
  | "manual_hold"
  | "decomposition_started"
  | "decomposition_completed"
  | "implementation_started"
  | "implementation_completed"
  | "validation_started"
  | "validation_completed"
  | "review_fix_started"
  | "review_fix_completed"
  | "publish_started"
  | "mr_ready"
  | "task_completed"
  | "task_failed"
  | "task_waiting";

export interface TaskEvent {
  id: string;
  timestamp: string;
  workerId: string;
  repositoryName?: string;
  issueKey?: string;
  mergeRequestUrl?: string;
  mergeRequestIid?: number;
  branch?: string;
  type: TaskEventType;
  status: TaskEventStatus;
  message: string;
  details?: Record<string, unknown>;
}

export type TaskEventInput = Omit<TaskEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

export interface TaskSummary {
  id: string;
  timestamp: string;
  repositoryName?: string;
  issueKey?: string;
  mergeRequestUrl?: string;
  mergeRequestIid?: number;
  branch?: string;
  stage: TaskEventType;
  status: TaskEventStatus;
  message: string;
  durationSeconds?: number;
}

export interface RepositorySummary {
  repositoryName: string;
  queues: Array<{ queue: string; depth: number }>;
  activeTaskCount: number;
  tasksCompleted24h: number;
  failures24h: number;
  successRatePercent: number;
  averageTaskDurationSeconds?: number;
  p95TaskDurationSeconds?: number;
}

export interface EventStore {
  append(event: TaskEventInput): Promise<TaskEvent | null>;
  listRecent(input: { limit: number; repositoryName?: string }): Promise<TaskEvent[]>;
  listFailures(input: { limit: number; repositoryName?: string }): Promise<TaskEvent[]>;
  listTaskSummaries(input: { limit: number; repositoryName?: string }): Promise<TaskSummary[]>;
  summarizeRepositories(input: {
    repositories: string[];
    queues: Array<{ repositoryName: string; queue: string; depth: number }>;
    activeTasks: Array<{ repositoryName?: string }>;
    now?: Date;
  }): Promise<RepositorySummary[]>;
}

const clampLimit = (limit: number): number => Math.min(Math.max(limit, 1), 200);
const nowIso = (): string => new Date().toISOString();

let eventCounter = 0;
const nextEventId = (): string => {
  eventCounter += 1;
  return `${Date.now().toString(36)}-${eventCounter.toString(36)}`;
};

const secondsFromDetails = (details: Record<string, unknown> | undefined): number | undefined => {
  const value = details?.durationSeconds;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export class InMemoryEventStore implements EventStore {
  private readonly events: TaskEvent[] = [];

  constructor(
    private readonly config: ObservabilityConfig,
    private readonly metrics: MetricsRegistry,
    private readonly logger?: Logger,
  ) {
    this.loadPersistedEvents();
  }

  async append(input: TaskEventInput): Promise<TaskEvent | null> {
    const event: TaskEvent = redactSecrets(
      {
        id: input.id ?? nextEventId(),
        timestamp: input.timestamp ?? nowIso(),
        workerId: input.workerId,
        ...(input.repositoryName ? { repositoryName: input.repositoryName } : {}),
        ...(input.issueKey ? { issueKey: input.issueKey } : {}),
        ...(input.mergeRequestUrl ? { mergeRequestUrl: input.mergeRequestUrl } : {}),
        ...(input.mergeRequestIid !== undefined
          ? { mergeRequestIid: input.mergeRequestIid }
          : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        type: input.type,
        status: input.status,
        message: input.message,
        ...(input.details ? { details: input.details } : {}),
      },
      this.config.redactMaxChars,
    );

    this.events.push(event);
    this.trim();
    if (this.config.events.store === "file") {
      this.persist().catch((error) => {
        this.metrics.incrementCounter("ai_developer_observability_dropped_events_total", {
          reason: "persistence_error",
        });
        this.logger?.warn("Unable to persist observability events.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return event;
  }

  async listRecent(input: { limit: number; repositoryName?: string }): Promise<TaskEvent[]> {
    return this.filterRecent(input.limit, input.repositoryName);
  }

  async listFailures(input: { limit: number; repositoryName?: string }): Promise<TaskEvent[]> {
    return this.filterRecent(input.limit, input.repositoryName).filter(
      (event) => event.status === "error" || event.type === "task_failed",
    );
  }

  async listTaskSummaries(input: {
    limit: number;
    repositoryName?: string;
  }): Promise<TaskSummary[]> {
    return this.filterRecent(input.limit, input.repositoryName)
      .filter((event) =>
        [
          "task_picked",
          "task_completed",
          "task_failed",
          "task_waiting",
          "mr_ready",
          "validation_completed",
          "clarification_requested",
          "manual_hold",
        ].includes(event.type),
      )
      .map((event) => ({
        id: event.id,
        timestamp: event.timestamp,
        ...(event.repositoryName ? { repositoryName: event.repositoryName } : {}),
        ...(event.issueKey ? { issueKey: event.issueKey } : {}),
        ...(event.mergeRequestUrl ? { mergeRequestUrl: event.mergeRequestUrl } : {}),
        ...(event.mergeRequestIid !== undefined ? { mergeRequestIid: event.mergeRequestIid } : {}),
        ...(event.branch ? { branch: event.branch } : {}),
        stage: event.type,
        status: event.status,
        message: event.message,
        ...(secondsFromDetails(event.details) !== undefined
          ? { durationSeconds: secondsFromDetails(event.details) }
          : {}),
      }));
  }

  async summarizeRepositories(input: {
    repositories: string[];
    queues: Array<{ repositoryName: string; queue: string; depth: number }>;
    activeTasks: Array<{ repositoryName?: string }>;
    now?: Date;
  }): Promise<RepositorySummary[]> {
    const now = input.now ?? new Date();
    const since = now.getTime() - 24 * 60 * 60 * 1000;
    const repositoryNames = new Set([
      ...input.repositories,
      ...this.events.flatMap((event) => (event.repositoryName ? [event.repositoryName] : [])),
    ]);

    return [...repositoryNames].sort().map((repositoryName) => {
      const events = this.events.filter((event) => event.repositoryName === repositoryName);
      const recentTerminal = events.filter(
        (event) =>
          (event.type === "task_completed" ||
            event.type === "task_failed" ||
            event.type === "mr_ready") &&
          Date.parse(event.timestamp) >= since,
      );
      const failures24h = events.filter(
        (event) => event.type === "task_failed" && Date.parse(event.timestamp) >= since,
      ).length;
      const successes = recentTerminal.filter((event) => event.type !== "task_failed").length;
      const durations = recentTerminal
        .map((event) => secondsFromDetails(event.details))
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => left - right);
      const p95Index = durations.length > 0 ? Math.ceil(durations.length * 0.95) - 1 : -1;

      return {
        repositoryName,
        queues: input.queues
          .filter((queue) => queue.repositoryName === repositoryName)
          .map((queue) => ({ queue: queue.queue, depth: queue.depth })),
        activeTaskCount: input.activeTasks.filter(
          (task) => task.repositoryName === repositoryName,
        ).length,
        tasksCompleted24h: successes,
        failures24h,
        successRatePercent:
          recentTerminal.length === 0
            ? 100
            : Math.round((successes / recentTerminal.length) * 10000) / 100,
        ...(durations.length > 0
          ? {
              averageTaskDurationSeconds:
                Math.round(
                  (durations.reduce((sum, value) => sum + value, 0) / durations.length) *
                    100,
                ) / 100,
              p95TaskDurationSeconds: durations[p95Index] ?? durations[durations.length - 1],
            }
          : {}),
      };
    });
  }

  private filterRecent(limit: number, repositoryName?: string): TaskEvent[] {
    const normalizedLimit = clampLimit(limit);
    return this.events
      .filter((event) => !repositoryName || event.repositoryName === repositoryName)
      .slice(-normalizedLimit)
      .reverse();
  }

  private trim(): void {
    const overflow = this.events.length - this.config.events.retention;
    if (overflow > 0) {
      this.events.splice(0, overflow);
    }
  }

  private loadPersistedEvents(): void {
    if (this.config.events.store !== "file" || !this.config.events.file) {
      return;
    }
    if (!existsSync(this.config.events.file)) {
      return;
    }

    try {
      const raw = readFileSync(this.config.events.file, "utf8");
      const parsed = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEvent);
      this.events.push(...parsed);
      this.trim();
    } catch (error) {
      this.metrics.incrementCounter("ai_developer_observability_dropped_events_total", {
        reason: "load_error",
      });
      this.logger?.warn("Unable to load persisted observability events.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persist(): Promise<void> {
    if (!this.config.events.file) {
      throw new Error("OBSERVABILITY_EVENT_STORE_FILE is required when file store is enabled.");
    }

    mkdirSync(dirname(this.config.events.file), { recursive: true });
    writeFileSync(
      this.config.events.file,
      `${this.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
  }
}

export class NoopEventStore implements EventStore {
  async append(): Promise<TaskEvent | null> {
    return null;
  }
  async listRecent(): Promise<TaskEvent[]> {
    return [];
  }
  async listFailures(): Promise<TaskEvent[]> {
    return [];
  }
  async listTaskSummaries(): Promise<TaskSummary[]> {
    return [];
  }
  async summarizeRepositories(): Promise<RepositorySummary[]> {
    return [];
  }
}
