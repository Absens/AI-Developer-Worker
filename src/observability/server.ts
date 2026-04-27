import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ObservabilityConfig } from "../models/types.js";
import type { AlertService } from "./alerts.js";
import type { EventStore } from "./events.js";
import type { MetricsRegistry } from "./metrics.js";
import type { WorkerStateRegistry } from "./state.js";
import { renderDashboardHtml } from "./dashboardAssets.js";

export interface ReadinessState {
  ready: boolean;
  reason: string;
}

interface ObservabilityServerInput {
  config: ObservabilityConfig;
  metrics: MetricsRegistry;
  events: EventStore;
  state: WorkerStateRegistry;
  alerts: AlertService;
  readiness: () => ReadinessState;
  repositories: () => string[];
}

const json = (response: ServerResponse, statusCode: number, body: unknown): void => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};

const text = (
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void => {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
};

const parseLimit = (url: URL, defaultValue: number): number => {
  const raw = url.searchParams.get("limit");
  if (!raw) {
    return defaultValue;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    return defaultValue;
  }
  return Math.min(value, 200);
};

const hasDashboardAuth = (request: IncomingMessage, config: ObservabilityConfig): boolean => {
  const token = config.dashboard.bearerToken;
  if (!token) {
    return true;
  }
  return request.headers.authorization === `Bearer ${token}`;
};

export class ObservabilityHttpServer {
  private server: Server | undefined;

  constructor(private readonly input: ObservabilityServerInput) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        json(response, 500, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
      this.server?.listen(this.input.config.port, this.input.config.host);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  address(): AddressInfo | string | null {
    return this.server?.address() ?? null;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET") {
      text(response, 405, "method not allowed");
      return;
    }

    const url = new URL(request.url ?? "/", this.input.config.baseUrl);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const { config } = this.input;

    if (path === config.health.path) {
      json(response, 200, { status: "ok" });
      return;
    }

    if (path === config.health.readinessPath) {
      const readiness = this.input.readiness();
      json(response, readiness.ready ? 200 : 503, {
        status: readiness.ready ? "ok" : "not_ready",
        reason: readiness.reason,
      });
      return;
    }

    if (config.metrics.enabled && path === config.metrics.path) {
      text(
        response,
        200,
        this.input.metrics.renderPrometheus(),
        "text/plain; version=0.0.4; charset=utf-8",
      );
      return;
    }

    const dashboardPath = config.dashboard.path;
    const apiPath = config.dashboard.apiPath;
    if (config.dashboard.enabled && (path === dashboardPath || path === `${dashboardPath}/`)) {
      if (!hasDashboardAuth(request, config)) {
        text(response, 401, "unauthorized");
        return;
      }
      text(
        response,
        200,
        renderDashboardHtml({
          apiPath: config.dashboard.apiPath,
          refreshSeconds: config.dashboard.refreshSeconds,
        }),
        "text/html; charset=utf-8",
      );
      return;
    }

    if (config.dashboard.enabled && (path === apiPath || path.startsWith(`${apiPath}/`))) {
      if (!hasDashboardAuth(request, config)) {
        text(response, 401, "unauthorized");
        return;
      }
      await this.handleApi(path.slice(apiPath.length) || "/", url, response);
      return;
    }

    text(response, 404, "not found");
  }

  private async handleApi(
    path: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const repositoryName = url.searchParams.get("repository") ?? undefined;
    if (path === "/workers") {
      json(response, 200, {
        workers: this.input.state.listWorkers(),
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (path === "/tasks/recent") {
      json(response, 200, {
        tasks: await this.input.events.listTaskSummaries({
          limit: parseLimit(url, 50),
          repositoryName,
        }),
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (path === "/failures/recent") {
      json(response, 200, {
        failures: await this.input.events.listFailures({
          limit: parseLimit(url, 50),
          repositoryName,
        }),
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (path === "/repositories") {
      const repositories = await this.repositorySummaries();
      json(response, 200, {
        repositories,
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (path === "/metrics/summary") {
      const repositories = await this.repositorySummaries();
      const totals = repositories.reduce(
        (accumulator, repository) => {
          accumulator.activeTasks += repository.activeTaskCount;
          accumulator.failedTasks24h += repository.failures24h;
          accumulator.completedTasks24h += repository.tasksCompleted24h;
          accumulator.terminalTasks24h += repository.tasksCompleted24h + repository.failures24h;
          if (repository.averageTaskDurationSeconds !== undefined) {
            accumulator.durationSum += repository.averageTaskDurationSeconds;
            accumulator.durationCount += 1;
          }
          return accumulator;
        },
        {
          activeTasks: 0,
          failedTasks24h: 0,
          completedTasks24h: 0,
          terminalTasks24h: 0,
          durationSum: 0,
          durationCount: 0,
        },
      );
      json(response, 200, {
        repositories,
        totals: {
          activeTasks: totals.activeTasks,
          successRatePercent:
            totals.terminalTasks24h === 0
              ? 100
              : Math.round((totals.completedTasks24h / totals.terminalTasks24h) * 10000) /
                100,
          failedTasks24h: totals.failedTasks24h,
          ...(totals.durationCount > 0
            ? {
                averageTaskDurationSeconds:
                  Math.round((totals.durationSum / totals.durationCount) * 100) / 100,
              }
            : {}),
        },
        alerts: this.input.alerts.listRecent(5),
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    text(response, 404, "not found");
  }

  private async repositorySummaries() {
    const workers = this.input.state.listWorkers();
    return this.input.events.summarizeRepositories({
      repositories: this.input.repositories(),
      queues: this.input.state.listQueues(),
      activeTasks: workers.filter((worker) => worker.state === "processing"),
    });
  }
}
