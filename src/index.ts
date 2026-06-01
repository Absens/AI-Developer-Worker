import { buildApplication, runApplicationRuntime } from "./app.js";
import { formatPreflightReport, hasPreflightFailures } from "./domain/preflight.js";
import { Logger } from "./utils/logger.js";

const main = async (): Promise<void> => {
  const application = buildApplication();
  const { config, preflight } = application;
  if (config.preflightOnly) {
    const checks = await preflight.run();
    console.log(formatPreflightReport(checks));
    if (hasPreflightFailures(checks)) {
      process.exitCode = 1;
    }
    return;
  }

  await runApplicationRuntime(application);
};

const logger = new Logger();

main().catch((error) => {
  logger.error("Worker failed to start.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
