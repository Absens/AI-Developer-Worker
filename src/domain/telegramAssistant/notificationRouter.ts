import type { TelegramClient } from "../../integrations/telegram/index.js";
import {
  renderTelegramResponse,
  type TelegramResponse,
} from "../../integrations/telegram/renderer.js";
import { redactSecrets } from "../../observability/redaction.js";
import type { ObservabilityTelemetry } from "../../observability/service.js";
import type { Logger } from "../../utils/logger.js";
import { TelegramRetryAfterError } from "../../integrations/telegram/index.js";
import type {
  ClarificationQuestionRecord,
  TaskEvent,
  TaskRecord,
  TaskTrackerClient,
} from "../taskTracker/index.js";
import type { TelegramAssistantStore } from "./store.js";
import type { TelegramTaskSubscription } from "./types.js";

type TelegramNotificationLogger = Pick<Logger, "warn">;

export interface TelegramNotificationRouterOptions {
  store: TelegramAssistantStore;
  telegram: Pick<TelegramClient, "sendMessage">;
  taskTracker: Pick<TaskTrackerClient, "getTask">;
  logger?: TelegramNotificationLogger;
  observability?: Pick<ObservabilityTelemetry, "incrementCounter">;
  clock?: () => Date;
  retryStaleMs?: number;
}

const DEFAULT_RETRY_STALE_MS = 5 * 60 * 1000;

export class TelegramNotificationRouter {
  private readonly store: TelegramAssistantStore;
  private readonly telegram: Pick<TelegramClient, "sendMessage">;
  private readonly taskTracker: Pick<TaskTrackerClient, "getTask">;
  private readonly logger?: TelegramNotificationLogger;
  private readonly observability?: Pick<ObservabilityTelemetry, "incrementCounter">;
  private readonly clock: () => Date;
  private readonly retryStaleMs: number;

  public constructor(options: TelegramNotificationRouterOptions) {
    this.store = options.store;
    this.telegram = options.telegram;
    this.taskTracker = options.taskTracker;
    this.logger = options.logger;
    this.observability = options.observability;
    this.clock = options.clock ?? (() => new Date());
    this.retryStaleMs = options.retryStaleMs ?? DEFAULT_RETRY_STALE_MS;
  }

  public async scanSubscribedTasks(): Promise<void> {
    const subscriptions = await this.store.listAllTaskSubscriptions();
    const subscriptionsByTaskId = groupSubscriptionsByTaskId(subscriptions);

    for (const [taskId, taskSubscriptions] of subscriptionsByTaskId.entries()) {
      const task = await this.taskTracker.getTask(taskId);
      const sortedEvents = sortTaskEvents(task.events);
      for (const subscription of taskSubscriptions) {
        const events = eventsAfterSubscriptionWatermark(sortedEvents, subscription);
        for (const event of events) {
          await this.sendEventToSubscription(subscription, event, task);
        }
      }
    }
  }

  private async sendEventToSubscription(
    subscription: TelegramTaskSubscription,
    event: TaskEvent,
    task: TaskRecord,
  ): Promise<void> {
    const reservedAt = this.clock().toISOString();
    const staleAfter = addMilliseconds(reservedAt, this.retryStaleMs);
    const deliveryId = buildDeliveryId(subscription.id, event.id, reservedAt);
    const delivery = await this.store.reserveNotificationDelivery({
      id: deliveryId,
      subscriptionId: subscription.id,
      eventId: event.id,
      reservedAt,
      staleAfter,
    });
    if (!delivery) {
      return;
    }

    try {
      const openQuestion = getAwaitingHumanOpenQuestion(event, task);
      const rendered = renderTelegramResponse(
        renderEventNotification(event, task, openQuestion),
      );
      let promptMessageId: number | undefined;
      for (const text of rendered.messages) {
        const sent = await this.telegram.sendMessage({
          chatId: String(subscription.chatId),
          text,
          parseMode: rendered.parseMode,
          ...(rendered.disableWebPagePreview !== undefined
            ? { disableWebPagePreview: rendered.disableWebPagePreview }
            : {}),
        });
        promptMessageId ??= sent.message_id;
      }
      if (openQuestion) {
        const now = this.clock().toISOString();
        await this.store.upsertActiveTaskQuestionPrompt({
          id: buildActiveTaskQuestionPromptId(
            subscription.conversationKey,
            event.taskId,
            openQuestion.id,
          ),
          conversationKey: subscription.conversationKey,
          chatId: subscription.chatId,
          ...(subscription.userId !== undefined ? { userId: subscription.userId } : {}),
          taskId: event.taskId,
          questionId: openQuestion.id,
          ...(promptMessageId !== undefined ? { promptMessageId } : {}),
          status: "open",
          createdAt: now,
          updatedAt: now,
          expiresAt: addDays(now, 7),
        });
      }
      await this.store.completeNotificationDelivery(subscription.id, event.id, {
        deliveryId: delivery.id,
        status: "sent",
        completedAt: this.clock().toISOString(),
      });
      this.observability?.incrementCounter(
        "telegram_notification_delivery_total",
        { outcome: "sent" },
      );
    } catch (error) {
      this.observability?.incrementCounter(
        "telegram_notification_delivery_total",
        { outcome: "failed" },
      );
      if (error instanceof TelegramRetryAfterError) {
        this.observability?.incrementCounter("telegram_rate_limited_total", {
          direction: "outbound",
        });
        await waitForTelegramRetryAfter(error.retryAfterSeconds);
      }
      this.logger?.warn("Telegram notification delivery failed.", redactSecrets({
        subscriptionId: subscription.id,
        taskId: event.taskId,
        eventId: event.id,
        error: errorToMessage(error),
      }));
      throw error;
    }
  }
}

const groupSubscriptionsByTaskId = (
  subscriptions: TelegramTaskSubscription[],
): Map<string, TelegramTaskSubscription[]> => {
  const grouped = new Map<string, TelegramTaskSubscription[]>();
  for (const subscription of subscriptions) {
    const taskSubscriptions = grouped.get(subscription.taskId);
    if (taskSubscriptions) {
      taskSubscriptions.push(subscription);
      continue;
    }
    grouped.set(subscription.taskId, [subscription]);
  }
  return grouped;
};

const renderEventNotification = (
  event: TaskEvent,
  task: TaskRecord,
  openQuestion?: ClarificationQuestionRecord,
): TelegramResponse => {
  if (event.kind === "merge_request_recorded") {
    const mergeRequestUrl = event.payload?.mergeRequestUrl;
    const body = typeof mergeRequestUrl === "string"
      ? mergeRequestUrl
      : event.message;
    return {
      blocks: [
        { kind: "title", text: `${event.taskId}: Реализация готова` },
        ...(body ? [{ kind: "paragraph" as const, text: body }] : []),
      ],
      disableWebPagePreview: true,
    };
  }

  if (event.kind === "task_status_changed" && event.payload?.to === "done") {
    return {
      blocks: [
        { kind: "title", text: `${event.taskId}: Задача завершена` },
        ...(event.message
          ? [{ kind: "paragraph" as const, text: event.message }]
          : []),
      ],
      disableWebPagePreview: true,
    };
  }

  if (
    event.kind === "task_status_changed" &&
    event.payload?.to === "awaiting_human"
  ) {
    const questionText = openQuestion
      ? describeClarificationQuestion(openQuestion)
      : event.message;
    return {
      blocks: [
        { kind: "title", text: `${task.id}: Нужен ответ` },
        ...(questionText
          ? [{ kind: "paragraph" as const, text: questionText }]
          : []),
      ],
      disableWebPagePreview: true,
    };
  }

  return {
    blocks: [
      { kind: "title", text: `${event.taskId}: ${event.kind}` },
      ...(event.message
        ? [{ kind: "paragraph" as const, text: event.message }]
        : []),
    ],
    disableWebPagePreview: true,
  };
};

const getAwaitingHumanOpenQuestion = (
  event: TaskEvent,
  task: TaskRecord,
): ClarificationQuestionRecord | undefined => {
  if (
    event.kind !== "task_status_changed" ||
    event.payload?.to !== "awaiting_human"
  ) {
    return undefined;
  }
  return latestOpenClarificationQuestion(task);
};

const latestOpenClarificationQuestion = (
  task: TaskRecord,
): ClarificationQuestionRecord | undefined =>
  task.clarificationQuestions
    .filter((question) => question.status === "open")
    .sort(compareClarificationQuestionsNewestFirst)[0];

const compareClarificationQuestionsNewestFirst = (
  left: ClarificationQuestionRecord,
  right: ClarificationQuestionRecord,
): number =>
  right.createdAt.localeCompare(left.createdAt) ||
  right.id.localeCompare(left.id);

const describeClarificationQuestion = (
  question: ClarificationQuestionRecord,
): string => {
  const directQuestion = question.question.question.trim();
  if (directQuestion) {
    return directQuestion;
  }

  const summary = question.question.summary.trim();
  if (summary) {
    return summary;
  }

  return question.question.blockingReason;
};

const sortTaskEvents = (events: TaskEvent[]): TaskEvent[] =>
  [...events].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id),
  );

const eventsAfterSubscriptionWatermark = (
  events: TaskEvent[],
  subscription: TelegramTaskSubscription,
): TaskEvent[] => {
  if (!subscription.lastNotifiedEventId) {
    return events;
  }

  const watermarkIndex = events.findIndex(
    (event) => event.id === subscription.lastNotifiedEventId,
  );
  if (watermarkIndex === -1) {
    // Without the watermarked event timestamp, sending any retained event risks a duplicate.
    return [];
  }

  return events.slice(watermarkIndex + 1);
};

const buildDeliveryId = (
  subscriptionId: string,
  eventId: string,
  reservedAt: string,
): string => `telegram-notification:${subscriptionId}:${eventId}:${reservedAt}`;

const buildActiveTaskQuestionPromptId = (
  conversationKey: string,
  taskId: string,
  questionId: string,
): string => `telegram-question:${conversationKey}:${taskId}:${questionId}`;

const addMilliseconds = (isoDate: string, milliseconds: number): string => {
  const date = new Date(isoDate);
  date.setTime(date.getTime() + Math.max(0, milliseconds));
  return date.toISOString();
};

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + Math.max(0, days));
  return date.toISOString();
};

const waitForTelegramRetryAfter = async (retryAfterSeconds: number): Promise<void> => {
  const milliseconds = Math.min(Math.max(0, retryAfterSeconds), 60) * 1000;
  if (milliseconds <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
