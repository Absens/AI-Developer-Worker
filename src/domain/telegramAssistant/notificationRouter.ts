import type { TelegramClient } from "../../integrations/telegram/index.js";
import {
  renderTelegramResponse,
  type TelegramResponse,
} from "../../integrations/telegram/renderer.js";
import { redactSecrets } from "../../observability/redaction.js";
import type { Logger } from "../../utils/logger.js";
import type {
  TaskEvent,
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
  clock?: () => Date;
  retryStaleMs?: number;
}

const DEFAULT_RETRY_STALE_MS = 5 * 60 * 1000;

export class TelegramNotificationRouter {
  private readonly store: TelegramAssistantStore;
  private readonly telegram: Pick<TelegramClient, "sendMessage">;
  private readonly taskTracker: Pick<TaskTrackerClient, "getTask">;
  private readonly logger?: TelegramNotificationLogger;
  private readonly clock: () => Date;
  private readonly retryStaleMs: number;

  public constructor(options: TelegramNotificationRouterOptions) {
    this.store = options.store;
    this.telegram = options.telegram;
    this.taskTracker = options.taskTracker;
    this.logger = options.logger;
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
          await this.sendEventToSubscription(subscription, event);
        }
      }
    }
  }

  private async sendEventToSubscription(
    subscription: TelegramTaskSubscription,
    event: TaskEvent,
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
      const rendered = renderTelegramResponse(renderEventNotification(event));
      for (const text of rendered.messages) {
        await this.telegram.sendMessage({
          chatId: String(subscription.chatId),
          text,
          parseMode: rendered.parseMode,
          ...(rendered.disableWebPagePreview !== undefined
            ? { disableWebPagePreview: rendered.disableWebPagePreview }
            : {}),
        });
      }
      await this.store.completeNotificationDelivery(subscription.id, event.id, {
        deliveryId: delivery.id,
        status: "sent",
        completedAt: this.clock().toISOString(),
      });
    } catch (error) {
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

const renderEventNotification = (event: TaskEvent): TelegramResponse => ({
  blocks: [
    { kind: "title", text: `${event.taskId}: ${event.kind}` },
    ...(event.message
      ? [{ kind: "paragraph" as const, text: event.message }]
      : []),
  ],
  disableWebPagePreview: true,
});

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

const addMilliseconds = (isoDate: string, milliseconds: number): string => {
  const date = new Date(isoDate);
  date.setTime(date.getTime() + Math.max(0, milliseconds));
  return date.toISOString();
};

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
