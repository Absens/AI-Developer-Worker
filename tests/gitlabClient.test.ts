import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { GitLabApiClient } from "../src/integrations/gitlab/client.js";
import type { AppConfig } from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const servers: Array<ReturnType<typeof createServer>> = [];

const createConfig = (gitlabUrl: string): AppConfig => ({
  trackerToken: "tracker-token",
  trackerOrgHeader: "X-Cloud-Org-ID",
  trackerOrgId: "org-id",
  trackerDefaultQueue: "FRONTEND",
  trackerTag: "ai_dev",
  trackerStatusMap: {
    open: { statuses: ["Open"] },
    in_progress: { statuses: ["In Progress"], transition: "start" },
    waiting_for_answer: { statuses: ["Waiting"], transition: "wait" },
    review: { statuses: ["Review"], transition: "review" },
    failed: { statuses: ["Failed"], transition: "fail" },
    done: { statuses: ["Done"], transition: "done" },
  },
  trackerApiBaseUrl: "http://localhost:9999/v3",
  gitlabUrl,
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
  codexSelfReviewEnabled: false,
  codexSelfReviewMaxFixAttempts: 1,
  maxFixAttempts: 2,
  maxReviewFixAttempts: 2,
  workerId: "worker-1",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  runOnce: false,
  preflightOnly: false,
  preflightRunTargetCommands: true,
});

const readJsonBody = async (request: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
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

  return `http://127.0.0.1:${address.port}`;
};

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

describe("GitLabApiClient", () => {
  it("finds merged merge requests by source branch", async () => {
    const requests: string[] = [];
    const gitlabUrl = await startServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(`${method} ${url.pathname}?${url.searchParams.toString()}`);

      if (method === "GET" && url.pathname === "/api/v4/projects/1/merge_requests") {
        expect(url.searchParams.get("state")).toBe("all");
        expect(url.searchParams.get("source_branch")).toBe("feature/merged");
        expect(url.searchParams.get("order_by")).toBe("updated_at");
        expect(url.searchParams.get("sort")).toBe("desc");
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify([
            {
              id: 101,
              iid: 17,
              web_url: "https://gitlab/project/-/merge_requests/17",
              title: "Merged MR",
              source_branch: "feature/merged",
              target_branch: "main",
              state: "merged",
              merged_at: "2026-05-15T10:00:00.000Z",
              closed_at: null,
              updated_at: "2026-05-15T10:01:00.000Z",
            },
          ]),
        );
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new GitLabApiClient(createConfig(gitlabUrl), new Logger());
    const result = await client.findMergeRequestByBranch("feature/merged");

    expect(result).toMatchObject({
      iid: 17,
      sourceBranch: "feature/merged",
      targetBranch: "main",
      state: "merged",
      mergedAt: "2026-05-15T10:00:00.000Z",
      updatedAt: "2026-05-15T10:01:00.000Z",
    });
    expect(requests).toHaveLength(1);
  });

  it("keeps opened lookup limited to opened merge requests", async () => {
    const gitlabUrl = await startServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/api/v4/projects/1/merge_requests") {
        expect(url.searchParams.get("state")).toBe("opened");
        expect(url.searchParams.get("source_branch")).toBe("feature/open");
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify([
            {
              id: 102,
              iid: 18,
              web_url: "https://gitlab/project/-/merge_requests/18",
              title: "Open MR",
              source_branch: "feature/open",
              target_branch: "main",
              state: "opened",
            },
          ]),
        );
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new GitLabApiClient(createConfig(gitlabUrl), new Logger());
    const result = await client.findOpenMergeRequestByBranch("feature/open");

    expect(result).toMatchObject({
      iid: 18,
      sourceBranch: "feature/open",
      state: "opened",
    });
  });

  it("loads a merge request by iid", async () => {
    const gitlabUrl = await startServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/api/v4/projects/1/merge_requests/17") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            id: 101,
            iid: 17,
            web_url: "https://gitlab/project/-/merge_requests/17",
            title: "Merged MR",
            source_branch: "feature/merged",
            target_branch: "main",
            state: "merged",
            merged_at: "2026-05-15T10:00:00.000Z",
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new GitLabApiClient(createConfig(gitlabUrl), new Logger());
    const result = await client.getMergeRequest(17);

    expect(result).toMatchObject({
      iid: 17,
      sourceBranch: "feature/merged",
      targetBranch: "main",
      state: "merged",
    });
  });

  it("paginates merge request discussions and maps note fields", async () => {
    const pages: number[] = [];
    const discussions = Array.from({ length: 101 }, (_, index) => ({
      id: `discussion-${index + 1}`,
      individual_note: false,
      notes: [
        {
          id: index + 1,
          body: `Review note ${index + 1}`,
          author: { username: "reviewer" },
          system: false,
          resolvable: true,
          resolved: false,
          created_at: "2026-04-26T10:00:00.000Z",
          position: {
            new_path: "src/example.ts",
            new_line: index + 1,
          },
        },
      ],
    }));

    const gitlabUrl = await startServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/api/v4/projects/1/merge_requests/17/discussions") {
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(page === 1 ? discussions.slice(0, 100) : discussions.slice(100)));
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new GitLabApiClient(createConfig(gitlabUrl), new Logger());
    const result = await client.getMergeRequestDiscussions(17);

    expect(result).toHaveLength(101);
    expect(pages).toEqual([1, 2]);
    expect(result[0]).toMatchObject({
      id: "discussion-1",
      resolved: false,
      notes: [
        {
          id: 1,
          authorUsername: "reviewer",
          position: { newPath: "src/example.ts", newLine: 1 },
        },
      ],
    });
  });

  it("fetches current user and replies to discussions", async () => {
    const replies: any[] = [];
    const gitlabUrl = await startServer(async (request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/api/v4/user") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ username: "ai-worker" }));
        return;
      }

      if (
        method === "POST" &&
        url.pathname === "/api/v4/projects/1/merge_requests/17/discussions/abc/notes"
      ) {
        replies.push(await readJsonBody(request));
        response.statusCode = 201;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: 1 }));
        return;
      }

      response.statusCode = 404;
      response.end(`${method} ${url.pathname}`);
    });

    const client = new GitLabApiClient(createConfig(gitlabUrl), new Logger());

    await expect(client.getCurrentUser()).resolves.toEqual({ username: "ai-worker" });
    await client.replyToDiscussion(17, "abc", "Fixed in commit abc123.");

    expect(replies).toEqual([{ body: "Fixed in commit abc123." }]);
  });
});
