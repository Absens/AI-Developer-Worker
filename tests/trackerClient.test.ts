import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { YandexTrackerClient } from "../src/integrations/tracker/client.js";
import type { AppConfig } from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const STATUS_MAP: AppConfig["trackerStatusMap"] = {
  open: { statuses: ["Open"] },
  in_progress: { statuses: ["In Progress"], transition: "start" },
  waiting_for_answer: {
    statuses: ["Waiting for answer"],
    transition: "need-info",
  },
  review: { statuses: ["Review"], transition: "review-transition" },
  failed: { statuses: ["Failed"], transition: "fail" },
  done: { statuses: ["Done"], transition: "done" },
};

const servers: Array<ReturnType<typeof createServer>> = [];

const createConfig = (trackerApiBaseUrl: string, overrides: Partial<AppConfig> = {}): AppConfig => ({
  trackerToken: "tracker-token",
  trackerOrgHeader: "X-Cloud-Org-ID",
  trackerOrgId: "org-id",
  trackerDefaultQueue: "FRONTEND",
  trackerTag: "ai_dev",
  trackerStatusMap: STATUS_MAP,
  trackerApiBaseUrl,
  gitlabUrl: "https://gitlab.example.com",
  gitlabToken: "gitlab-token",
  gitlabProjectId: "1",
  gitRemoteName: "origin",
  gitRepositoryToken: "gitlab-token",
  gitRepositoryUsername: "oauth2",
  gitCommitNoVerify: true,
  repoPath: process.cwd(),
  baseBranch: "main",
  pollIntervalMinutes: 30,
  pollIntervalMs: 30 * 60 * 1000,
  codexHome: "/codex-home",
  codexCliCommand: "codex",
  codexCliArgs: [],
  codexSandbox: "workspace-write",
  codexExecArgs: [],
  codexTimeoutMs: 30 * 60 * 1000,
  codexProgressLogIntervalMs: 30 * 1000,
  codexLogFullEvents: false,
  codexQuestionMarker: "AI_QUESTION:",
  maxFixAttempts: 2,
  maxReviewFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
  ...overrides,
});

const readJsonBody = async (request: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const startServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<string> => {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine mock server address.");
  }

  return `http://127.0.0.1:${address.port}/v3`;
};

const buildIssues = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    key: `DEV-${String(index + 1).padStart(3, "0")}`,
    summary: `Task ${index + 1}`,
    description: `Description ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 2, 10, 0, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 2, 10, 0, index, 0)).toISOString(),
    status: {
      key: "open",
      display: "Open",
    },
  }));

const buildComments = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    text: `Comment ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 2, 10, 1, index, 0)).toISOString(),
    createdBy: { display: "worker" },
    isSystem: false,
  }));

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) {
      continue;
    }

    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("YandexTrackerClient", () => {
  it("paginates search and comments and uses the configured org header", async () => {
    const issues = buildIssues(101);
    const comments = buildComments(101);
    const seenHeaders: Array<{ org?: string; cloudOrg?: string }> = [];
    const seenSearchPages: number[] = [];
    const seenCommentPages: number[] = [];
    const searchBodies: any[] = [];

    const trackerApiBaseUrl = await startServer(async (request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      seenHeaders.push({
        org: request.headers["x-org-id"] as string | undefined,
        cloudOrg: request.headers["x-cloud-org-id"] as string | undefined,
      });

      if (method === "POST" && url.pathname === "/v3/issues/_search") {
        const page = Number(url.searchParams.get("page"));
        seenSearchPages.push(page);
        searchBodies.push(await readJsonBody(request));

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(page === 1 ? issues.slice(0, 100) : issues.slice(100)));
        return;
      }

      if (method === "GET" && url.pathname === "/v3/issues/DEV-001/comments") {
        const page = Number(url.searchParams.get("page"));
        seenCommentPages.push(page);

        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            comments: page === 1 ? comments.slice(0, 100) : comments.slice(100),
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new YandexTrackerClient(
      createConfig(trackerApiBaseUrl, { trackerOrgHeader: "X-Org-ID" }),
      new Logger(),
    );

    const foundIssues = await client.findCandidateIssues();
    const foundComments = await client.getComments("DEV-001");

    expect(foundIssues).toHaveLength(101);
    expect(foundIssues[0]?.key).toBe("DEV-001");
    expect(foundIssues.at(-1)?.key).toBe("DEV-101");
    expect(foundComments).toHaveLength(101);
    expect(seenSearchPages).toEqual([1, 2]);
    expect(seenCommentPages).toEqual([1, 2]);
    expect(searchBodies).toEqual([
      { query: '"Queue": "FRONTEND" AND "Tags": "ai_dev"' },
      { query: '"Queue": "FRONTEND" AND "Tags": "ai_dev"' },
    ]);
    expect(seenHeaders.every((headers) => headers.org === "org-id")).toBe(true);
    expect(seenHeaders.every((headers) => headers.cloudOrg === undefined)).toBe(true);
  });

  it("keeps regular UI reply comments as human comments even with internal transport metadata", async () => {
    const trackerApiBaseUrl = await startServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/v3/issues/DEV-003/comments") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            comments: [
              {
                id: "1",
                text: "/resume B",
                createdAt: "2026-03-12T08:07:17.880+0000",
                createdBy: { display: "Maxim Malyshev" },
                transport: "internal",
                summonees: [{ id: "worker-1" }],
              },
            ],
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new YandexTrackerClient(createConfig(trackerApiBaseUrl), new Logger());
    const comments = await client.getComments("DEV-003");

    expect(comments).toHaveLength(1);
    expect(comments[0]?.author).toBe("Maxim Malyshev");
    expect(comments[0]?.isSystem).toBe(false);
  });

  it("maps priority, deadline, components, tags, and queue from search responses", async () => {
    const searchBodies: any[] = [];
    const trackerApiBaseUrl = await startServer(async (request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "POST" && url.pathname === "/v3/issues/_search") {
        searchBodies.push(await readJsonBody(request));
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify([
            {
              id: "1",
              key: "BACKEND-1",
              summary: "Priority task",
              description: "Description",
              createdAt: "2026-04-26T10:00:00.000Z",
              status: { key: "open", display: "Open" },
              queue: { key: "BACKEND" },
              priority: { key: "critical", display: "Critical" },
              deadline: "2026-04-27",
              components: [{ display: "payments" }],
              tags: ["ai_dev", "urgent"],
            },
          ]),
        );
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new YandexTrackerClient(createConfig(trackerApiBaseUrl), new Logger());
    const issues = await client.findCandidateIssues({ queue: "BACKEND", tag: "urgent" });

    expect(searchBodies).toEqual([{ query: '"Queue": "BACKEND" AND "Tags": "urgent"' }]);
    expect(issues[0]).toMatchObject({
      key: "BACKEND-1",
      queue: "BACKEND",
      priority: "critical",
      deadline: "2026-04-27",
      components: ["payments"],
      tags: ["ai_dev", "urgent"],
    });
  });

  it("resolves transitions from the issue transition list instead of using the hint as execute id", async () => {
    const requests: string[] = [];

    const trackerApiBaseUrl = await startServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(`${method} ${url.pathname}`);

      if (method === "GET" && url.pathname === "/v3/issues/DEV-1/transitions") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify([
            {
              id: "42",
              key: "review-workflow",
              display: "Send to review",
              to: {
                key: "review",
                display: "Review",
              },
            },
          ]),
        );
        return;
      }

      if (method === "POST" && url.pathname === "/v3/issues/DEV-1/transitions/42/_execute") {
        response.statusCode = 204;
        response.end();
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new YandexTrackerClient(createConfig(trackerApiBaseUrl), new Logger());

    await client.transition("DEV-1", "review");

    expect(requests).toEqual([
      "GET /v3/issues/DEV-1/transitions",
      "POST /v3/issues/DEV-1/transitions/42/_execute",
    ]);
  });

  it("retries tracker requests on 429 responses", async () => {
    let attempts = 0;

    const trackerApiBaseUrl = await startServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/v3/issues/DEV-2") {
        attempts += 1;
        if (attempts === 1) {
          response.statusCode = 429;
          response.setHeader("Retry-After", "0");
          response.end("rate limit");
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            id: "2",
            key: "DEV-2",
            summary: "Task 2",
            description: "Description 2",
            createdAt: "2026-03-10T00:00:00.000Z",
            updatedAt: "2026-03-10T00:00:00.000Z",
            status: {
              key: "open",
              display: "Open",
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new YandexTrackerClient(createConfig(trackerApiBaseUrl), new Logger());
    const issue = await client.getIssue("DEV-2");

    expect(issue.key).toBe("DEV-2");
    expect(attempts).toBe(2);
  });
});
