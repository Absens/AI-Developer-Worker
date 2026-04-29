import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, relative, resolve } from "node:path";

import type { ObservabilityConfig, TaskTrackerClient } from "../models/types.js";
import type { AlertService } from "./alerts.js";
import type { EventStore } from "./events.js";
import type { MetricsRegistry } from "./metrics.js";
import type { WorkerStateRegistry } from "./state.js";
import { renderDashboardHtml } from "./dashboardAssets.js";
import { redactSecrets } from "./redaction.js";
import { TaskTrackerHumanApi } from "./taskTrackerHumanApi.js";
import { renderTaskTrackerUiHtml } from "./taskTrackerUiAssets.js";

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
  taskTracker?: TaskTrackerClient;
}

const json = (response: ServerResponse, statusCode: number, body: unknown): void => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(redactSecrets(body)));
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

const buffer = (
  response: ServerResponse,
  statusCode: number,
  body: Buffer,
  contentType: string,
): void => {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
};

const contentTypeForPath = (path: string): string => {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
};

const isInsideDirectory = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
  private readonly taskTrackerHumanApi: TaskTrackerHumanApi;

  constructor(private readonly input: ObservabilityServerInput) {
    this.taskTrackerHumanApi = new TaskTrackerHumanApi({
      config: input.config.taskTrackerUi,
      taskTracker: input.taskTracker,
      state: input.state,
      repositories: input.repositories,
    });
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await this.assertStaticBundle();

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
    const url = new URL(request.url ?? "/", this.input.config.baseUrl);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const { config } = this.input;

    if (path === config.health.path) {
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }
      json(response, 200, { status: "ok" });
      return;
    }

    if (path === config.health.readinessPath) {
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }
      const readiness = this.input.readiness();
      json(response, readiness.ready ? 200 : 503, {
        status: readiness.ready ? "ok" : "not_ready",
        reason: readiness.reason,
      });
      return;
    }

    if (config.metrics.enabled && path === config.metrics.path) {
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }
      text(
        response,
        200,
        this.input.metrics.renderPrometheus(),
        "text/plain; version=0.0.4; charset=utf-8",
      );
      return;
    }

    if (config.taskTrackerUi.enabled && this.taskTrackerHumanApi.isApiRoute(path)) {
      await this.taskTrackerHumanApi.handle(request, path, url, response);
      return;
    }

    if (config.taskTrackerUi.enabled && this.isTaskTrackerUiRoute(path)) {
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }
      await this.serveTaskTrackerUi(path, response);
      return;
    }

    const dashboardPath = config.dashboard.path;
    const apiPath = config.dashboard.apiPath;
    if (config.dashboard.enabled && (path === dashboardPath || path === `${dashboardPath}/`)) {
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }
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
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }
      if (!hasDashboardAuth(request, config)) {
        text(response, 401, "unauthorized");
        return;
      }
      await this.handleApi(path.slice(apiPath.length) || "/", url, response);
      return;
    }

    text(response, 404, "not found");
  }

  private async assertStaticBundle(): Promise<void> {
    const staticDir = this.input.config.taskTrackerUi.staticDir;
    if (!this.input.config.taskTrackerUi.enabled || !staticDir) {
      return;
    }

    const root = resolve(staticDir);
    const indexPath = resolve(root, "index.html");
    try {
      const directoryStat = await stat(root);
      if (!directoryStat.isDirectory()) {
        throw new Error("not a directory");
      }
      const indexStat = await stat(indexPath);
      if (!indexStat.isFile()) {
        throw new Error("index.html is not a file");
      }
    } catch (error) {
      throw new Error(
        `Angular static bundle is not available at ${root}. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private isTaskTrackerUiRoute(path: string): boolean {
    const uiPath = this.input.config.taskTrackerUi.path;
    return path === uiPath || path.startsWith(`${uiPath}/`);
  }

  private async serveTaskTrackerUi(
    path: string,
    response: ServerResponse,
  ): Promise<void> {
    const { taskTrackerUi } = this.input.config;
    if (!taskTrackerUi.staticDir) {
      if (path === taskTrackerUi.path) {
        text(
          response,
          200,
          renderTaskTrackerUiHtml({
            apiPath: taskTrackerUi.apiPath,
          }),
          "text/html; charset=utf-8",
        );
        return;
      }
      text(response, 404, "Angular static bundle is not configured.");
      return;
    }

    const root = resolve(taskTrackerUi.staticDir);
    const relativeUrlPath =
      path === taskTrackerUi.path ? "" : path.slice(taskTrackerUi.path.length + 1);
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(relativeUrlPath);
    } catch {
      text(response, 400, "invalid static asset path");
      return;
    }

    const indexPath = resolve(root, "index.html");
    const candidatePath = decodedPath ? resolve(root, decodedPath) : indexPath;
    if (!isInsideDirectory(root, candidatePath)) {
      text(response, 400, "invalid static asset path");
      return;
    }

    try {
      const fileStat = await stat(candidatePath);
      if (fileStat.isFile()) {
        buffer(response, 200, await readFile(candidatePath), contentTypeForPath(candidatePath));
        return;
      }
    } catch {
      // Missing files fall through to either a clear asset 404 or Angular index fallback.
    }

    const isAssetPath =
      path === taskTrackerUi.assetPath || path.startsWith(`${taskTrackerUi.assetPath}/`);
    if (isAssetPath || extname(decodedPath)) {
      text(response, 404, "Angular static asset not found.");
      return;
    }

    buffer(response, 200, await readFile(indexPath), "text/html; charset=utf-8");
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
