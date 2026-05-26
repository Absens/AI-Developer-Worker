import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, relative, resolve } from "node:path";

import type { ObservabilityConfig, TaskTrackerClient } from "../models/types.js";
import type { MetricsRegistry } from "./metrics.js";
import type { WorkerStateRegistry } from "./state.js";
import { redactSecrets } from "./redaction.js";
import {
  TaskTrackerHumanApi,
  type ProjectManagerApiDependencies,
} from "./taskTrackerHumanApi.js";

export interface ReadinessState {
  ready: boolean;
  reason: string;
}

interface ObservabilityServerInput {
  config: ObservabilityConfig;
  metrics: MetricsRegistry;
  state: WorkerStateRegistry;
  readiness: () => ReadinessState;
  repositories: () => string[];
  taskTracker?: TaskTrackerClient;
  projectManager?: ProjectManagerApiDependencies;
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
  cacheControl = "no-store",
): void => {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": cacheControl,
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
    case ".txt":
      return "text/plain; charset=utf-8";
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

const HASHED_ASSET_PATTERN = /(?:[.-])[a-z0-9]{8,}(?:\.|$)/i;
const CACHEABLE_ASSET_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".ico",
  ".jpg",
  ".jpeg",
  ".js",
  ".json",
  ".png",
  ".svg",
  ".webp",
  ".woff2",
]);

const cacheControlForStaticPath = (
  filePath: string,
  isAssetPath: boolean,
): string => {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".html") {
    return "no-store";
  }
  if (CACHEABLE_ASSET_EXTENSIONS.has(extension) && HASHED_ASSET_PATTERN.test(filePath)) {
    return "public, max-age=31536000, immutable";
  }
  if (isAssetPath || CACHEABLE_ASSET_EXTENSIONS.has(extension)) {
    return "public, max-age=300";
  }
  return "no-store";
};

const isInsideDirectory = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export class ObservabilityHttpServer {
  private server: Server | undefined;
  private readonly taskTrackerHumanApi: TaskTrackerHumanApi;

  constructor(private readonly input: ObservabilityServerInput) {
    this.taskTrackerHumanApi = new TaskTrackerHumanApi({
      config: input.config.taskTrackerUi,
      taskTracker: input.taskTracker,
      projectManager: input.projectManager,
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
      text(response, 503, "Angular static bundle is not configured.");
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
    const isAssetPath =
      path === taskTrackerUi.assetPath || path.startsWith(`${taskTrackerUi.assetPath}/`);
    if (!isInsideDirectory(root, candidatePath)) {
      text(response, 400, "invalid static asset path");
      return;
    }

    try {
      const fileStat = await stat(candidatePath);
      if (fileStat.isFile()) {
        buffer(
          response,
          200,
          await readFile(candidatePath),
          contentTypeForPath(candidatePath),
          cacheControlForStaticPath(candidatePath, isAssetPath),
        );
        return;
      }
    } catch {
      // Missing files fall through to either a clear asset 404 or Angular index fallback.
    }

    if (isAssetPath || extname(decodedPath)) {
      text(response, 404, "Angular static asset not found.");
      return;
    }

    buffer(
      response,
      200,
      await readFile(indexPath),
      "text/html; charset=utf-8",
      "no-store",
    );
  }

}
