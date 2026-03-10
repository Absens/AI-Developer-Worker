import { Logger } from "./logger.js";

export interface RetryOptions {
  retries: number;
  delayMs: number;
  factor?: number;
  shouldRetry?: (error: unknown) => boolean;
  label?: string;
  logger?: Logger;
}

const defaultShouldRetry = (error: unknown): boolean =>
  error instanceof Error && error.name === "TemporaryIntegrationError";

export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const factor = options.factor ?? 2;
  let attempt = 0;
  let delayMs = options.delayMs;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const shouldRetry = (options.shouldRetry ?? defaultShouldRetry)(error);
      if (!shouldRetry || attempt > options.retries) {
        throw error;
      }

      options.logger?.warn("Retrying operation after transient failure.", {
        label: options.label,
        attempt,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= factor;
    }
  }
};
