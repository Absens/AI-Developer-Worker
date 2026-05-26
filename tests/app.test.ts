import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../src/app.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("application wiring", () => {
  it("builds internal task tracker mode without Yandex direct config", () => {
    const app = buildApplication({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_DATABASE_URL: "postgres://tracker:secret@localhost/tasks",
      TASK_INTAKE_MODE: "standalone",
      YANDEX_SYNC_ENABLED: "false",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(app.config.taskTracker).toMatchObject({
      provider: "internal",
      internal: {
        storage: "postgres",
        intakeMode: "standalone",
        yandexSyncEnabled: false,
      },
    });
    expect(app.taskTracker).toBeDefined();
  });

  it("wires project manager API dependencies when only a repository enables project manager", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-app-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        worker: { id: "worker-1" },
        taskTracker: { provider: "internal", storage: "memory" },
        repositories: [
          {
            name: "developer",
            repoPath: "/workspace/developer",
            gitlabProjectId: "123",
            queues: ["DEV"],
            projectManager: { enabled: true },
          },
          {
            name: "disabled",
            repoPath: "/workspace/disabled",
            gitlabProjectId: "456",
            queues: ["DEV"],
            projectManager: { enabled: false },
          },
        ],
      }),
      "utf8",
    );

    const app = buildApplication({
      WORKER_CONFIG_FILE: configFile,
      NODE_ENV: "test",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });

    expect(app.config.projectManager?.enabled).toBe(false);
    expect("repositories" in app.config).toBe(true);
    if (!("repositories" in app.config)) {
      throw new Error("Expected fleet config.");
    }
    expect(app.config.repositories[0]?.projectManager?.enabled).toBe(true);
    expect(app.projectManager?.store).toBeDefined();
    expect(app.projectManager?.runner).toBeDefined();
    await expect(
      app.projectManager?.runner?.runAnalysisOnce({
        repositoryName: "missing",
        trigger: "manual",
      }),
    ).rejects.toThrow(/Project manager repository not found: missing/);
    await expect(
      app.projectManager?.runner?.runAnalysisOnce({
        repositoryName: "disabled",
        trigger: "manual",
      }),
    ).rejects.toThrow(/Project manager is not enabled for repository: disabled/);
  });
});
