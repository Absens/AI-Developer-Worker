import type {
  ObservabilityConfig,
  RepositoryProfile,
  TaskTrackerClient,
} from "../models/types.js";
import type { Logger } from "../utils/logger.js";
import { defaultObservabilityConfig } from "./config.js";
import {
  BasicAlertService,
  NoopAlertService,
  type AlertService,
} from "./alerts.js";
import {
  InMemoryEventStore,
  NoopEventStore,
  type EventStore,
  type TaskEventInput,
} from "./events.js";
import {
  InMemoryMetricsRegistry,
  NoopMetricsRegistry,
  type MetricLabels,
  type MetricsRegistry,
} from "./metrics.js";
import { ObservabilityHttpServer } from "./server.js";
import type { ProjectManagerApiDependencies } from "./taskTrackerHumanApi.js";
import {
  InMemoryWorkerStateRegistry,
  NoopWorkerStateRegistry,
  type WorkerRuntimeState,
  type WorkerStateRegistry,
} from "./state.js";

export interface TaskTelemetryContext {
  workerId: string;
  repositoryName: string;
  issueKey?: string;
  branch?: string;
  mergeRequestUrl?: string;
  mergeRequestIid?: number;
}

export interface ObservabilityTelemetry {
  setWorkerState(input: {
    workerId: string;
    state: WorkerRuntimeState;
    repositoryName?: string;
    issueKey?: string;
    stage?: string;
    error?: string;
  }): void;
  heartbeat(workerId: string): void;
  setQueueDepth(repositoryName: string, queue: string, depth: number): void;
  recordEvent(event: TaskEventInput): void;
  incrementCounter(name: string, labels?: MetricLabels, value?: number): void;
  observeHistogram(name: string, labels: MetricLabels, value: number): void;
  setGauge(name: string, labels: MetricLabels, value: number): void;
  recordTaskFinished(
    context: TaskTelemetryContext,
    outcome: "success" | "failed" | "waiting" | "processed",
    durationMs: number,
    message?: string,
  ): void;
  recordCodexRun(input: {
    workerId: string;
    repositoryName: string;
    issueKey?: string;
    stage: string;
    durationMs: number;
    exitCode?: number;
    timedOut?: boolean;
  }): void;
  recordValidationGate(input: {
    workerId: string;
    repositoryName: string;
    issueKey?: string;
    gate: string;
    status: "passed" | "failed" | "skipped";
    durationMs?: number;
    diagnostic?: string;
  }): void;
  recordMergeRequest(input: {
    workerId: string;
    repositoryName: string;
    issueKey: string;
    branch: string;
    mergeRequestUrl: string;
    mergeRequestIid: number;
    outcome: "created" | "reused";
  }): void;
}

export interface ObservabilityService extends ObservabilityTelemetry {
  readonly config: ObservabilityConfig;
  readonly metrics: MetricsRegistry;
  readonly events: EventStore;
  readonly state: WorkerStateRegistry;
  readonly alerts: AlertService;
  start(): Promise<void>;
  markReady(): void;
  markNotReady(reason: string): void;
  stop(): Promise<void>;
}

const WORKER_STATES: WorkerRuntimeState[] = [
  "starting",
  "idle",
  "polling",
  "processing",
  "waiting",
  "error",
  "shutting_down",
];

const seconds = (milliseconds: number): number => Math.max(0, milliseconds / 1000);

const safeMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class RuntimeObservabilityService implements ObservabilityService {
  readonly metrics: MetricsRegistry;
  readonly events: EventStore;
  readonly state: WorkerStateRegistry;
  readonly alerts: AlertService;
  private readonly server: ObservabilityHttpServer;
  private ready = false;
  private readinessReason = "startup pending";
  private started = false;

  constructor(
    readonly config: ObservabilityConfig,
    private readonly logger: Logger,
    private readonly repositories: RepositoryProfile[],
    taskTracker?: TaskTrackerClient,
    projectManager?: ProjectManagerApiDependencies,
  ) {
    this.metrics = new InMemoryMetricsRegistry();
    this.events = new InMemoryEventStore(config, this.metrics, logger);
    this.state = new InMemoryWorkerStateRegistry();
    this.alerts = new BasicAlertService(config, this.metrics, logger);
    this.server = new ObservabilityHttpServer({
      config,
      metrics: this.metrics,
      state: this.state,
      readiness: () => ({
        ready: this.ready,
        reason: this.readinessReason,
      }),
      repositories: () => this.repositories.map((repository) => repository.name),
      taskTracker,
      projectManager,
    });
    this.metrics.setGauge("ai_developer_build_info", {
      version: process.env.npm_package_version ?? "unknown",
      commit: process.env.GIT_COMMIT_SHA ?? "unknown",
    }, 1);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      await this.server.start();
      this.logger.info("Observability server started.", {
        host: this.config.host,
        port: this.config.port,
      });
    } catch (error) {
      this.started = false;
      const message = `Observability server failed to start on ${this.config.host}:${this.config.port}. ${safeMessage(error)}`;
      if (this.config.strictStartup) {
        throw new Error(message);
      }
      this.logger.warn(message);
    }
  }

  markReady(): void {
    this.ready = true;
    this.readinessReason = "ready";
    for (const worker of this.state.listWorkers()) {
      this.recordEvent({
        workerId: worker.workerId,
        repositoryName: worker.repositoryName,
        type: "worker_ready",
        status: "info",
        message: "Worker is ready.",
      });
    }
  }

  markNotReady(reason: string): void {
    this.ready = false;
    this.readinessReason = reason;
  }

  async stop(): Promise<void> {
    this.markNotReady("shutting down");
    await this.server.stop();
  }

  setWorkerState(input: {
    workerId: string;
    state: WorkerRuntimeState;
    repositoryName?: string;
    issueKey?: string;
    stage?: string;
    error?: string;
  }): void {
    this.guard(() => {
      this.state.update(input);
      this.metrics.setGauge("ai_developer_worker_up", { worker_id: input.workerId }, 1);
      for (const state of WORKER_STATES) {
        this.metrics.setGauge("ai_developer_worker_state", {
          worker_id: input.workerId,
          state,
        }, state === input.state ? 1 : 0);
      }
      this.metrics.setGauge("ai_developer_active_task", {
        worker_id: input.workerId,
        repository: input.repositoryName ?? "unknown",
      }, input.state === "processing" ? 1 : 0);
    });
  }

  heartbeat(workerId: string): void {
    this.guard(() => {
      this.state.heartbeat(workerId);
    });
  }

  setQueueDepth(repositoryName: string, queue: string, depth: number): void {
    this.guard(() => {
      this.state.setQueueDepth(repositoryName, queue, depth);
      this.metrics.setGauge("ai_developer_queue_depth", {
        repository: repositoryName,
        queue,
      }, depth);
      this.recordEvent({
        workerId: "unknown",
        repositoryName,
        type: "queue_polled",
        status: "info",
        message: `Queue ${queue} depth is ${depth}.`,
        details: { queue, depth },
      });
    });
  }

  recordEvent(event: TaskEventInput): void {
    this.guard(() => {
      this.events.append(event).then((stored) => {
        if (stored) {
          this.alerts.recordEvent(stored).catch((error) => {
            this.logger.warn("Alert evaluation failed.", {
              error: safeMessage(error),
            });
          });
        }
      }).catch((error) => {
        this.logger.warn("Observability event append failed.", {
          error: safeMessage(error),
        });
        this.metrics.incrementCounter("ai_developer_observability_dropped_events_total", {
          reason: "append_error",
        });
      });
    });
  }

  incrementCounter(name: string, labels?: MetricLabels, value?: number): void {
    this.guard(() => this.metrics.incrementCounter(name, labels, value));
  }

  observeHistogram(name: string, labels: MetricLabels, value: number): void {
    this.guard(() => this.metrics.observeHistogram(name, labels, value));
  }

  setGauge(name: string, labels: MetricLabels, value: number): void {
    this.guard(() => this.metrics.setGauge(name, labels, value));
  }

  recordTaskFinished(
    context: TaskTelemetryContext,
    outcome: "success" | "failed" | "waiting" | "processed",
    durationMs: number,
    message?: string,
  ): void {
    this.guard(() => {
      this.metrics.incrementCounter("ai_developer_tasks_total", {
        repository: context.repositoryName,
        status: outcome,
      });
      this.metrics.observeHistogram("ai_developer_task_duration_seconds", {
        repository: context.repositoryName,
        outcome,
      }, seconds(durationMs));
      this.recordEvent({
        workerId: context.workerId,
        repositoryName: context.repositoryName,
        issueKey: context.issueKey,
        branch: context.branch,
        mergeRequestUrl: context.mergeRequestUrl,
        mergeRequestIid: context.mergeRequestIid,
        type:
          outcome === "failed"
            ? "task_failed"
            : outcome === "waiting"
              ? "task_waiting"
              : "task_completed",
        status: outcome === "failed" ? "error" : outcome === "waiting" ? "warning" : "info",
        message: message ?? `Task ${outcome}.`,
        details: { durationSeconds: seconds(durationMs) },
      });
    });
  }

  recordCodexRun(input: {
    workerId: string;
    repositoryName: string;
    issueKey?: string;
    stage: string;
    durationMs: number;
    exitCode?: number;
    timedOut?: boolean;
  }): void {
    this.guard(() => {
      this.metrics.observeHistogram("ai_developer_codex_duration_seconds", {
        repository: input.repositoryName,
        stage: input.stage,
      }, seconds(input.durationMs));
      this.recordEvent({
        workerId: input.workerId,
        repositoryName: input.repositoryName,
        issueKey: input.issueKey,
        type: `${input.stage}_completed` as TaskEventInput["type"],
        status: input.exitCode && input.exitCode !== 0 ? "warning" : "info",
        message: `Codex ${input.stage} completed.`,
        details: {
          durationSeconds: seconds(input.durationMs),
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
          ...(input.timedOut ? { timedOut: true } : {}),
        },
      });
    });
  }

  recordValidationGate(input: {
    workerId: string;
    repositoryName: string;
    issueKey?: string;
    gate: string;
    status: "passed" | "failed" | "skipped";
    durationMs?: number;
    diagnostic?: string;
  }): void {
    this.guard(() => {
      if (input.durationMs !== undefined) {
        this.metrics.observeHistogram("ai_developer_validation_gate_duration_seconds", {
          repository: input.repositoryName,
          gate: input.gate,
        }, seconds(input.durationMs));
      }
      if (input.status === "failed") {
        this.metrics.incrementCounter("ai_developer_validation_gate_failures_total", {
          repository: input.repositoryName,
          gate: input.gate,
        });
      }
      this.recordEvent({
        workerId: input.workerId,
        repositoryName: input.repositoryName,
        issueKey: input.issueKey,
        type: "validation_completed",
        status: input.status === "failed" ? "error" : "info",
        message: `Validation gate ${input.gate} ${input.status}.`,
        details: {
          gate: input.gate,
          gateStatus: input.status,
          ...(input.durationMs !== undefined ? { durationSeconds: seconds(input.durationMs) } : {}),
          ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
        },
      });
    });
  }

  recordMergeRequest(input: {
    workerId: string;
    repositoryName: string;
    issueKey: string;
    branch: string;
    mergeRequestUrl: string;
    mergeRequestIid: number;
    outcome: "created" | "reused";
  }): void {
    this.guard(() => {
      if (input.outcome === "created") {
        this.metrics.incrementCounter("ai_developer_mr_created_total", {
          repository: input.repositoryName,
        });
      }
      this.recordEvent({
        workerId: input.workerId,
        repositoryName: input.repositoryName,
        issueKey: input.issueKey,
        branch: input.branch,
        mergeRequestUrl: input.mergeRequestUrl,
        mergeRequestIid: input.mergeRequestIid,
        type: "mr_ready",
        status: "info",
        message: `Merge request ${input.outcome}: ${input.mergeRequestUrl}`,
      });
    });
  }

  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.logger.warn("Observability operation failed.", {
        error: safeMessage(error),
      });
    }
  }
}

class DisabledObservabilityService implements ObservabilityService {
  readonly config = defaultObservabilityConfig();
  readonly metrics: MetricsRegistry = new NoopMetricsRegistry();
  readonly events: EventStore = new NoopEventStore();
  readonly state: WorkerStateRegistry = new NoopWorkerStateRegistry();
  readonly alerts: AlertService = new NoopAlertService();

  async start(): Promise<void> {}
  markReady(): void {}
  markNotReady(): void {}
  async stop(): Promise<void> {}
  setWorkerState(): void {}
  heartbeat(): void {}
  setQueueDepth(): void {}
  recordEvent(): void {}
  incrementCounter(): void {}
  observeHistogram(): void {}
  setGauge(): void {}
  recordTaskFinished(): void {}
  recordCodexRun(): void {}
  recordValidationGate(): void {}
  recordMergeRequest(): void {}
}

export const noopObservability = new DisabledObservabilityService();

export const createObservabilityService = (
  config: ObservabilityConfig | undefined,
  logger: Logger,
  repositories: RepositoryProfile[],
  taskTracker?: TaskTrackerClient,
  projectManager?: ProjectManagerApiDependencies,
): ObservabilityService => {
  const resolved = config ?? defaultObservabilityConfig();
  if (!resolved.enabled && !resolved.taskTrackerUi.enabled) {
    return noopObservability;
  }
  return new RuntimeObservabilityService(
    resolved,
    logger,
    repositories,
    taskTracker,
    projectManager,
  );
};
