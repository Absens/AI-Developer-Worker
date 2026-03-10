export class TemporaryIntegrationError extends Error {
  override readonly cause?: unknown;
  readonly retryAfterMs?: number;

  constructor(message: string, cause?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = "TemporaryIntegrationError";
    this.cause = cause;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class PermanentTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentTaskError";
  }
}
