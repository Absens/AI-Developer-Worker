import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../src/app.js";

const STATUS_MAP = JSON.stringify({
  open: { statuses: ["Open"] },
  in_progress: { statuses: ["In Progress"], transition: "start" },
  waiting_for_answer: { statuses: ["Waiting"], transition: "wait" },
  review: { statuses: ["Review"], transition: "review" },
  failed: { statuses: ["Failed"] },
  done: { statuses: ["Done"], transition: "done" },
});

const runGit = (args: string[], cwd: string): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();

const createTempWorkspace = () => mkdtempSync(join(tmpdir(), "ai-worker-smoke-"));

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

const startMockServer = async () => {
  const trackerComments: Array<{ text: string }> = [];
  const transitions: string[] = [];
  const mergeRequests: Array<{
    sourceBranch: string;
    web_url: string;
    title: string;
    description?: string;
  }> = [];
  const searchBodies: any[] = [];
  const issue = {
    id: "1",
    key: "DEV-100",
    summary: "Smoke task",
    description: "Create a smoke artifact",
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    status: {
      key: "open",
      display: "Open",
    },
  };

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (method === "POST" && url.pathname === "/tracker/v3/issues/_search") {
      searchBodies.push(await readJsonBody(request));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify([issue]));
      return;
    }

    if (method === "GET" && url.pathname === "/tracker/v3/issues/DEV-100/transitions") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify([
          {
            id: "start",
            key: "start",
            display: "Start progress",
            to: {
              key: "inProgress",
              display: "In Progress",
            },
          },
          {
            id: "review",
            key: "review",
            display: "Send to review",
            to: {
              key: "review",
              display: "Review",
            },
          },
          {
            id: "wait",
            key: "wait",
            display: "Wait for answer",
            to: {
              key: "waiting",
              display: "Waiting",
            },
          },
          {
            id: "fail",
            key: "fail",
            display: "Fail",
            to: {
              key: "failed",
              display: "Failed",
            },
          },
        ]),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/tracker/v3/issues/DEV-100/comments") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          trackerComments.map((comment, index) => ({
            id: String(index + 1),
            text: comment.text,
            createdAt: new Date(Date.UTC(2026, 2, 10, 0, index, 0)).toISOString(),
            createdBy: { display: "worker" },
          })),
        ),
      );
      return;
    }

    if (method === "POST" && url.pathname === "/tracker/v3/issues/DEV-100/comments") {
      const body = await readJsonBody(request);
      trackerComments.push({ text: body.text });
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/tracker/v3/issues/DEV-100/transitions/") &&
      url.pathname.endsWith("/_execute")
    ) {
      const transition = url.pathname.split("/")[6];
      if (!transition) {
        response.statusCode = 400;
        response.end("Missing transition");
        return;
      }
      transitions.push(transition);
      if (transition === "start") {
        issue.status = { key: "inProgress", display: "In Progress" };
      } else if (transition === "review") {
        issue.status = { key: "review", display: "Review" };
      } else if (transition === "wait") {
        issue.status = { key: "waiting", display: "Waiting" };
      } else if (transition === "fail") {
        issue.status = { key: "failed", display: "Failed" };
      }
      response.statusCode = 204;
      response.end();
      return;
    }

    if (method === "GET" && url.pathname === "/gitlab/api/v4/projects/1/merge_requests") {
      const sourceBranch = url.searchParams.get("source_branch");
      const opened = mergeRequests.filter((mr) => mr.sourceBranch === sourceBranch);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          opened.map((mr, index) => ({
            id: index + 1,
            iid: index + 1,
            web_url: mr.web_url,
            title: mr.title,
            source_branch: mr.sourceBranch,
            target_branch: "main",
          })),
        ),
      );
      return;
    }

    if (method === "POST" && url.pathname === "/gitlab/api/v4/projects/1/merge_requests") {
      const body = await readJsonBody(request);
      const webUrl = "http://127.0.0.1/gitlab/project/-/merge_requests/1";
      mergeRequests.push({
        sourceBranch: body.source_branch,
        title: body.title,
        web_url: webUrl,
        description: body.description,
      });
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: 1,
          iid: 1,
          web_url: webUrl,
          title: body.title,
          source_branch: body.source_branch,
          target_branch: body.target_branch,
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(`${method} ${url.pathname}`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine mock server address.");
  }

  return {
    server,
    port: address.port,
    trackerComments,
    transitions,
    mergeRequests,
    searchBodies,
  };
};

describe("worker smoke", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("processes a task end-to-end against mock Tracker and GitLab while skipping repo hooks by default", async () => {
    const workspace = createTempWorkspace();
    cleanupPaths.push(workspace);

    const remotePath = join(workspace, "remote.git");
    const seedPath = join(workspace, "seed");
    const repoPath = join(workspace, "project");
    const hooksPath = join(workspace, "hooks");
    const codexScriptPath = join(workspace, "codex-smoke.js");
    const statusMapFilePath = join(workspace, "trackerStatusMap.json");

    runGit(["init", "--bare", remotePath], workspace);
    runGit(["init", "--initial-branch=main", seedPath], workspace);
    runGit(["config", "user.email", "smoke@example.com"], seedPath);
    runGit(["config", "user.name", "Smoke Worker"], seedPath);
    writeFileSync(join(seedPath, "README.md"), "# seed\n", "utf8");
    runGit(["add", "README.md"], seedPath);
    runGit(["commit", "-m", "seed"], seedPath);
    runGit(["remote", "add", "origin", remotePath], seedPath);
    runGit(["push", "-u", "origin", "main"], seedPath);
    runGit(["symbolic-ref", "HEAD", "refs/heads/main"], remotePath);

    runGit(["clone", "--branch", "main", remotePath, repoPath], workspace);
    runGit(["config", "user.email", "worker@example.com"], repoPath);
    runGit(["config", "user.name", "AI Worker"], repoPath);
    mkdirSync(hooksPath, { recursive: true });
    writeFileSync(
      join(hooksPath, "pre-commit"),
      "#!/bin/sh\necho hook should not run >&2\nexit 1\n",
      "utf8",
    );
    chmodSync(join(hooksPath, "pre-commit"), 0o755);
    runGit(["config", "core.hooksPath", hooksPath], repoPath);

    writeFileSync(
      codexScriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
        "const stdin = fs.readFileSync(0, 'utf8');",
        "const isAnalysis = stdin.includes('Mode: analysis-only');",
        "const target = path.join(process.cwd(), 'smoke-output.txt');",
        "if (outputPath) {",
        "  fs.writeFileSync(outputPath, isAnalysis ? 'READY_FOR_IMPLEMENTATION\\n' : 'implementation complete\\n', 'utf8');",
        "}",
        "if (!isAnalysis) {",
        "  fs.writeFileSync(target, 'generated by codex smoke\\n', 'utf8');",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-smoke' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(statusMapFilePath, STATUS_MAP, "utf8");

    const mockServer = await startMockServer();
    try {
      const env = {
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_DEFAULT_QUEUE: "FRONTEND",
        TRACKER_TAG: "ai_dev",
        TRACKER_API_BASE_URL: `http://127.0.0.1:${mockServer.port}/tracker/v3`,
        TRACKER_STATUS_MAP_FILE: statusMapFilePath,
        GITLAB_URL: `http://127.0.0.1:${mockServer.port}/gitlab`,
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "1",
        REPO_PATH: repoPath,
        BASE_BRANCH: "main",
        POLL_INTERVAL_MINUTES: "30",
        CODEX_CLI_COMMAND: "node",
        CODEX_CLI_ARGS_JSON: JSON.stringify([codexScriptPath]),
        TEST_COMMAND: `node -e "process.exit(0)"`,
        LINT_COMMAND: `node -e "process.exit(0)"`,
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
        WORKER_RUN_ONCE: "true",
      };

      const { orchestrator } = buildApplication(env);
      const outcome = await orchestrator.runOnce();

      expect(outcome).toBe("processed");
      expect(readFileSync(join(repoPath, "smoke-output.txt"), "utf8")).toContain(
        "generated by codex smoke",
      );
      expect(runGit(["branch", "--show-current"], repoPath)).toBe("feature/ai-task-DEV-100");
      expect(runGit(["rev-list", "--count", "main..HEAD"], repoPath)).toBe("1");
      expect(runGit(["log", "-1", "--pretty=%s"], repoPath)).toBe("feat: implement DEV-100");
      expect(mockServer.searchBodies).toEqual([
        { query: '"Queue": "FRONTEND" AND "Tags": "ai_dev"' },
        { query: '"Queue": "FRONTEND" AND "Tags": "ai_dev"' },
      ]);
      expect(mockServer.transitions).toEqual(["start", "review"]);
      expect(mockServer.mergeRequests).toHaveLength(1);
      expect(mockServer.mergeRequests[0]?.description).toContain("## Summary");
      expect(mockServer.mergeRequests[0]?.description).toContain("## Testing");
      expect(mockServer.mergeRequests[0]?.description).toContain("Build: skipped");
      expect(mockServer.mergeRequests[0]?.description).toContain("DEV-100");
      expect(
        mockServer.trackerComments.some((comment) => comment.text.startsWith("AI MR:")),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        mockServer.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
