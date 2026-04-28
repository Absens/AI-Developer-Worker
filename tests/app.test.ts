import { describe, expect, it } from "vitest";

import { buildApplication } from "../src/app.js";

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
});
