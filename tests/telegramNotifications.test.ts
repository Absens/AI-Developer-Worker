import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTelegramAssistantStore,
  TelegramNotificationRouter,
} from "../src/domain/telegramAssistant/index.js";
import type {
  TaskEvent,
  TaskRecord,
} from "../src/domain/taskTracker/index.js";
import type { TelegramMessage } from "../src/integrations/telegram/index.js";

const baseTime = "2026-05-30T08:00:00.000Z";
const laterTime = "2026-05-30T08:00:01.000Z";
const latestTime = "2026-05-30T08:00:02.000Z";

const telegramMessage = (messageId: number, chatId: number): TelegramMessage => ({
  message_id: messageId,
  date: 1,
  chat: { id: chatId, type: "private" },
});

const taskEvent = (overrides: Partial<TaskEvent> = {}): TaskEvent => ({
  id: overrides.id ?? "event-1",
  taskId: overrides.taskId ?? "TASK-1",
  kind: overrides.kind ?? "status_changed",
  source: overrides.source ?? "worker_agent",
  message: overrides.message ?? "Task moved to review.",
  createdAt: overrides.createdAt ?? baseTime,
  ...overrides,
});

const taskFixture = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: overrides.id ?? "TASK-1",
  title: overrides.title ?? "Task",
  description: overrides.description ?? "Task description.",
  source: { kind: "native" },
  createdBy: { owner: "human", id: "user-1" },
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: [],
  components: [],
  priority: "normal",
  status: "review",
  taskType: "backend_endpoint",
  acceptanceCriteria: [],
  constraints: [],
  riskFactors: [],
  missingContext: [],
  externalRefs: [],
  fieldOwners: [],
  revisions: [],
  events: overrides.events ?? [taskEvent({ taskId: overrides.id ?? "TASK-1" })],
  comments: [],
  decisions: [],
  plans: [],
  dependencies: [],
  artifacts: [],
  agentRuns: [],
  qualityGateRuns: [],
  mergeRequests: [],
  clarificationQuestions: [],
  humanAnswers: [],
  decompositionDecisions: [],
  reviewMetadata: [],
  memoryContextRefs: [],
  createdAt: overrides.createdAt ?? baseTime,
  updatedAt: overrides.updatedAt ?? baseTime,
  ...overrides,
});

describe("TelegramNotificationRouter", () => {
  it("sends task notifications once per task event for subscribed task", async () => {
    const store = new InMemoryTelegramAssistantStore();
    await store.upsertTaskSubscription({
      id: "sub-1",
      taskId: "TASK-1",
      conversationKey: "bot_private:100",
      chatId: 100,
      userId: 200,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const task = taskFixture({
      id: "TASK-1",
      events: [
        taskEvent({
          id: "event-1",
          taskId: "TASK-1",
          kind: "status_changed",
          message: "Moved to review <check>.",
        }),
        taskEvent({
          id: "event-2",
          taskId: "TASK-1",
          kind: "comment_added",
          message: "Reviewer left feedback.",
          createdAt: laterTime,
        }),
      ],
    });
    const getTask = vi.fn(async (taskId: string): Promise<TaskRecord> => {
      expect(taskId).toBe("TASK-1");
      return task;
    });
    const sendMessage = vi.fn(async () => telegramMessage(9001, 100));
    const router = new TelegramNotificationRouter({
      store,
      taskTracker: { getTask },
      telegram: { sendMessage },
      clock: () => new Date(baseTime),
    });

    await router.scanSubscribedTasks();
    await router.scanSubscribedTasks();

    expect(getTask).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      chatId: "100",
      parseMode: "HTML",
      disableWebPagePreview: true,
      text: expect.stringContaining("<b>TASK-1: status_changed</b>"),
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      text: expect.stringContaining("Moved to review &lt;check&gt;."),
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chatId: "100",
      text: expect.stringContaining("<b>TASK-1: comment_added</b>"),
    }));
    await expect(store.listTaskSubscriptionsForTask("TASK-1")).resolves.toEqual([
      expect.objectContaining({
        id: "sub-1",
        lastNotifiedEventId: "event-2",
      }),
    ]);
  });

  it("retries notification delivery when sendMessage fails before marking sent", async () => {
    let now = new Date(baseTime);
    const store = new InMemoryTelegramAssistantStore({
      now: () => now,
    });
    await store.upsertTaskSubscription({
      id: "sub-retry",
      taskId: "TASK-2",
      conversationKey: "bot_private:101",
      chatId: 101,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const task = taskFixture({
      id: "TASK-2",
      events: [
        taskEvent({
          id: "event-retry",
          taskId: "TASK-2",
          kind: "validation_failed",
          message: "Validation failed.",
        }),
      ],
    });
    const getTask = vi.fn(async (): Promise<TaskRecord> => task);
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram send failed"))
      .mockResolvedValueOnce(telegramMessage(9002, 101));
    const router = new TelegramNotificationRouter({
      store,
      taskTracker: { getTask },
      telegram: { sendMessage },
      clock: () => now,
      retryStaleMs: 0,
    });

    await expect(router.scanSubscribedTasks()).rejects.toThrow("telegram send failed");
    await expect(store.listTaskSubscriptionsForTask("TASK-2")).resolves.toEqual([
      expect.not.objectContaining({ lastNotifiedEventId: "event-retry" }),
    ]);

    now = new Date(laterTime);
    await router.scanSubscribedTasks();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    await expect(store.listTaskSubscriptionsForTask("TASK-2")).resolves.toEqual([
      expect.objectContaining({
        id: "sub-retry",
        lastNotifiedEventId: "event-retry",
      }),
    ]);
  });

  it("does not reserve or send events at or before a subscription watermark", async () => {
    const store = new InMemoryTelegramAssistantStore();
    await store.upsertTaskSubscription({
      id: "sub-watermark",
      taskId: "TASK-3",
      conversationKey: "bot_private:102",
      chatId: 102,
      createdAt: baseTime,
      updatedAt: laterTime,
      lastNotifiedEventId: "event-watermark",
    });
    const task = taskFixture({
      id: "TASK-3",
      events: [
        taskEvent({
          id: "event-old",
          taskId: "TASK-3",
          kind: "analysis_started",
          message: "Analysis started.",
          createdAt: baseTime,
        }),
        taskEvent({
          id: "event-watermark",
          taskId: "TASK-3",
          kind: "analysis_completed",
          message: "Analysis completed.",
          createdAt: laterTime,
        }),
        taskEvent({
          id: "event-new",
          taskId: "TASK-3",
          kind: "review_requested",
          message: "Review requested.",
          createdAt: latestTime,
        }),
      ],
    });
    const reserveNotificationDelivery = vi.spyOn(
      store,
      "reserveNotificationDelivery",
    );
    const getTask = vi.fn(async (): Promise<TaskRecord> => task);
    const sendMessage = vi.fn(async () => telegramMessage(9003, 102));
    const router = new TelegramNotificationRouter({
      store,
      taskTracker: { getTask },
      telegram: { sendMessage },
      clock: () => new Date(latestTime),
    });

    await router.scanSubscribedTasks();

    expect(reserveNotificationDelivery).toHaveBeenCalledOnce();
    expect(reserveNotificationDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "sub-watermark",
        eventId: "event-new",
      }),
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "102",
      text: expect.stringContaining("<b>TASK-3: review_requested</b>"),
    }));
    await expect(store.listTaskSubscriptionsForTask("TASK-3")).resolves.toEqual([
      expect.objectContaining({
        id: "sub-watermark",
        lastNotifiedEventId: "event-new",
      }),
    ]);
  });

  it("renders MR ready and done lifecycle notifications with product titles", async () => {
    const store = new InMemoryTelegramAssistantStore();
    await store.upsertTaskSubscription({
      id: "sub-lifecycle",
      taskId: "TASK-4",
      conversationKey: "bot_private:103",
      chatId: 103,
      userId: 203,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const task = taskFixture({
      id: "TASK-4",
      events: [
        taskEvent({
          id: "event-mr",
          taskId: "TASK-4",
          kind: "merge_request_recorded",
          message: "MR is ready.",
          payload: { mergeRequestUrl: "https://gitlab.example/mr/4" },
        }),
        taskEvent({
          id: "event-done",
          taskId: "TASK-4",
          kind: "task_status_changed",
          message: "All checks passed.",
          payload: { from: "review", to: "done" },
          createdAt: laterTime,
        }),
      ],
    });
    const sendMessage = vi.fn(async () => telegramMessage(9004, 103));
    const router = new TelegramNotificationRouter({
      store,
      taskTracker: { getTask: vi.fn(async (): Promise<TaskRecord> => task) },
      telegram: { sendMessage },
      clock: () => new Date(baseTime),
    });

    await router.scanSubscribedTasks();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      chatId: "103",
      disableWebPagePreview: true,
      text: expect.stringContaining("Реализация готова"),
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      text: expect.stringContaining("https://gitlab.example/mr/4"),
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      text: expect.stringContaining("Задача завершена"),
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      text: expect.stringContaining("All checks passed."),
    }));
  });

  it("stores an active task question prompt when awaiting human notification is sent", async () => {
    const store = new InMemoryTelegramAssistantStore({
      now: () => new Date(baseTime),
    });
    await store.upsertTaskSubscription({
      id: "sub-awaiting",
      taskId: "TASK-5",
      conversationKey: "bot_private:104",
      chatId: 104,
      userId: 204,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const task = taskFixture({
      id: "TASK-5",
      status: "awaiting_human",
      events: [
        taskEvent({
          id: "event-awaiting",
          taskId: "TASK-5",
          kind: "task_status_changed",
          payload: { from: "claimed", to: "awaiting_human" },
          message: "Need clarification.",
        }),
      ],
      clarificationQuestions: [
        {
          id: "question-old",
          taskId: "TASK-5",
          workerId: "worker-1",
          question: {
            summary: "Old summary",
            blockingReason: "Old reason",
            question: "Old question?",
            options: [],
            resumeHint: "Reply to continue.",
          },
          status: "open",
          createdAt: baseTime,
        },
        {
          id: "question-latest",
          taskId: "TASK-5",
          workerId: "worker-1",
          question: {
            summary: "Choose implementation",
            blockingReason: "AI needs a product decision.",
            question: "Use option A?",
            options: ["Yes", "No"],
            resumeHint: "Reply to continue.",
          },
          status: "open",
          createdAt: latestTime,
        },
      ],
    });
    const sendMessage = vi.fn(async () => telegramMessage(9104, 104));
    const router = new TelegramNotificationRouter({
      store,
      taskTracker: { getTask: vi.fn(async (): Promise<TaskRecord> => task) },
      telegram: { sendMessage },
      clock: () => new Date(baseTime),
    });

    await router.scanSubscribedTasks();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Нужен ответ"),
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Use option A?"),
    }));
    await expect(
      store.getActiveTaskQuestionPrompt("bot_private:104"),
    ).resolves.toMatchObject({
      id: "telegram-question:bot_private:104:TASK-5:question-latest",
      conversationKey: "bot_private:104",
      chatId: 104,
      userId: 204,
      taskId: "TASK-5",
      questionId: "question-latest",
      promptMessageId: 9104,
      status: "open",
      createdAt: baseTime,
      updatedAt: baseTime,
      expiresAt: "2026-06-06T08:00:00.000Z",
    });
    await expect(store.listTaskSubscriptionsForTask("TASK-5")).resolves.toEqual([
      expect.objectContaining({
        id: "sub-awaiting",
        lastNotifiedEventId: "event-awaiting",
      }),
    ]);
  });
});
