export class Logger {
  info(message: string, context?: unknown): void {
    this.write("INFO", message, context);
  }

  warn(message: string, context?: unknown): void {
    this.write("WARN", message, context);
  }

  error(message: string, context?: unknown): void {
    this.write("ERROR", message, context);
  }

  private write(level: string, message: string, context?: unknown): void {
    const payload = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(context === undefined ? {} : { context }),
    };
    const line = JSON.stringify(payload);
    if (level === "ERROR") {
      console.error(line);
      return;
    }
    console.log(line);
  }
}
