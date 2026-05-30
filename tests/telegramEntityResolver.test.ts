import { describe, expect, it } from "vitest";

import {
  resolveTelegramTaskCandidates,
  summarizeTaskForTelegram,
} from "../src/domain/telegramAssistant/index.js";
import type { TaskRecord } from "../src/domain/taskTracker/index.js";

const baseTime = "2026-05-30T08:00:00.000Z";

const taskFixture = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: overrides.id ?? "task_1",
  title: overrides.title ?? "Task",
  description: overrides.description ?? "Task description.",
  source: { kind: "native" },
  createdBy: { owner: "human", id: "user-1" },
  repositoryName: overrides.repositoryName ?? "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: overrides.tags ?? [],
  components: overrides.components ?? [],
  priority: "normal",
  status: overrides.status ?? "ready",
  taskType: "backend_endpoint",
  acceptanceCriteria: [],
  constraints: [],
  riskFactors: [],
  missingContext: [],
  externalRefs: overrides.externalRefs ?? [],
  fieldOwners: [],
  revisions: [],
  events: overrides.events ?? [],
  comments: [],
  decisions: [],
  plans: [],
  dependencies: [],
  artifacts: [],
  agentRuns: [],
  qualityGateRuns: [],
  mergeRequests: overrides.mergeRequests ?? [],
  clarificationQuestions: overrides.clarificationQuestions ?? [],
  humanAnswers: [],
  decompositionDecisions: [],
  reviewMetadata: [],
  memoryContextRefs: [],
  createdAt: overrides.createdAt ?? baseTime,
  updatedAt: overrides.updatedAt ?? baseTime,
  ...overrides,
});

describe("resolveTelegramTaskCandidates", () => {
  it("prefers direct task id matches", () => {
    const tasks = [
      taskFixture({ id: "task_1", title: "Регистрация" }),
      taskFixture({ id: "task_2", title: "Оплата" }),
    ];

    expect(resolveTelegramTaskCandidates("что там task_2", tasks)[0]?.task.id).toBe("task_2");
  });

  it("matches Russian topic words in title and description", () => {
    const tasks = [
      taskFixture({ id: "task_1", title: "Починить регистрацию по email" }),
      taskFixture({ id: "task_2", title: "Обновить README" }),
    ];

    expect(resolveTelegramTaskCandidates("что там по регистрации", tasks)[0]?.task.id).toBe(
      "task_1",
    );
  });

  it("sorts equal matches by most recently updated task", () => {
    const tasks = [
      taskFixture({
        id: "task_old",
        title: "Регистрация через email",
        updatedAt: "2026-05-29T08:00:00.000Z",
      }),
      taskFixture({
        id: "task_new",
        title: "Регистрация через SSO",
        updatedAt: "2026-05-30T08:00:00.000Z",
      }),
    ];

    expect(resolveTelegramTaskCandidates("статус регистрации", tasks)[0]?.task.id).toBe(
      "task_new",
    );
  });
});

describe("summarizeTaskForTelegram", () => {
  it("builds a compact escaped task response with status, latest event and MR", () => {
    const response = summarizeTaskForTelegram(
      taskFixture({
        id: "task_7",
        title: "Починить <регистрацию>",
        status: "review",
        repositoryName: "developer",
        events: [
          {
            id: "event-1",
            taskId: "task_7",
            kind: "status_changed",
            source: "worker_agent",
            message: "MR открыт, ждем review",
            createdAt: "2026-05-30T08:10:00.000Z",
          },
        ],
        mergeRequests: [
          {
            id: "mr-1",
            taskId: "task_7",
            workerId: "worker-1",
            branch: "ai/task-7",
            outcome: "created",
            mergeRequest: {
              id: 15,
              iid: 15,
              url: "https://gitlab.example/mr/15",
              title: "Починить регистрацию",
              sourceBranch: "ai/task-7",
              targetBranch: "main",
            },
            createdAt: "2026-05-30T08:15:00.000Z",
          },
        ],
      }),
    );

    expect(response.disableWebPagePreview).toBe(true);
    expect(response.blocks).toEqual(
      expect.arrayContaining([
        { kind: "title", text: "task_7: Починить <регистрацию>" },
        { kind: "field", label: "Статус", value: "review" },
        { kind: "field", label: "Репозиторий", value: "developer" },
        { kind: "paragraph", text: "Последнее событие: MR открыт, ждем review" },
        {
          kind: "link",
          label: "MR !15: Починить регистрацию",
          url: "https://gitlab.example/mr/15",
        },
      ]),
    );
  });
});
