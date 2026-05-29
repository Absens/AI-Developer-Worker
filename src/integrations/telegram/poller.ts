import { redactSecrets } from "../../observability/redaction.js";
import type { Logger } from "../../utils/logger.js";
import type { TelegramClient } from "./client.js";
import { TelegramRetryAfterError } from "./client.js";
import type { TelegramUpdate } from "./types.js";

type TelegramPollerLogger = Pick<Logger, "info" | "warn" | "error">;

export interface TelegramUpdateHandler {
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface TelegramUpdatePollerOptions {
  client: Pick<TelegramClient, "getUpdates">;
  getOffset: () => Promise<number | undefined>;
  handler: TelegramUpdateHandler;
  intervalSeconds: number;
  withPollingLease: <T>(operation: () => Promise<T>) => Promise<T | undefined>;
  logger?: TelegramPollerLogger;
}

export class TelegramUpdatePoller {
  private readonly client: Pick<TelegramClient, "getUpdates">;
  private readonly getOffset: () => Promise<number | undefined>;
  private readonly handler: TelegramUpdateHandler;
  private readonly intervalSeconds: number;
  private readonly withPollingLease: <T>(
    operation: () => Promise<T>,
  ) => Promise<T | undefined>;
  private readonly logger?: TelegramPollerLogger;
  private loopPromise?: Promise<void>;
  private stopping = false;
  private activeTimer?: NodeJS.Timeout;
  private resolveActiveTimer?: () => void;

  public constructor(options: TelegramUpdatePollerOptions) {
    this.client = options.client;
    this.getOffset = options.getOffset;
    this.handler = options.handler;
    this.intervalSeconds = Math.max(Math.floor(options.intervalSeconds), 1);
    this.withPollingLease = options.withPollingLease;
    this.logger = options.logger;
  }

  public start(): void {
    if (this.loopPromise) {
      return;
    }

    this.stopping = false;
    const loop = this.runLoop();
    this.loopPromise = loop;
    void loop.finally(() => {
      if (this.loopPromise === loop) {
        this.loopPromise = undefined;
      }
    });
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.resolveActiveTimer?.();
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = undefined;
    }
    await this.loopPromise;
  }

  public async runOnce(): Promise<void> {
    try {
      await this.withPollingLease(async () => {
        const offset = await this.getOffset();
        const updates = await this.client.getUpdates({
          ...(offset !== undefined ? { offset } : {}),
          timeoutSeconds: this.intervalSeconds,
        });
        for (const update of updates) {
          if (this.stopping) {
            return;
          }
          await this.handler.handleUpdate(update);
        }
      });
    } catch (error) {
      if (error instanceof TelegramRetryAfterError) {
        this.logger?.warn("Telegram polling was rate limited.", {
          retryAfterSeconds: error.retryAfterSeconds,
        });
        await this.wait(error.retryAfterSeconds * 1000);
        return;
      }

      this.logger?.warn("Telegram polling iteration failed.", redactSecrets({
        error: errorToMessage(error),
      }));
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.runOnce();
      if (!this.stopping) {
        await this.wait(this.intervalSeconds * 1000);
      }
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    if (milliseconds <= 0 || this.stopping) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.resolveActiveTimer = resolve;
      this.activeTimer = setTimeout(resolve, milliseconds);
    }).finally(() => {
      this.resolveActiveTimer = undefined;
      if (this.activeTimer) {
        clearTimeout(this.activeTimer);
        this.activeTimer = undefined;
      }
    });
  }
}

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
