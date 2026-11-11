import { buildManagedApplication } from "./managedApplication.js";
import { buildApplication, runApplicationRuntime } from "./app.js";
import { formatPreflightReport, hasPreflightFailures } from "./domain/preflight.js";
import { Logger } from "./utils/logger.js";

const main = async (): Promise<void> => {
  const application = process.env.MANAGED_SETTINGS_ENABLED === "true"
    ? await buildManagedApplication()
    : buildApplication();
  const { config, preflight } = application;
  if ("preflightOnly" in config && config.preflightOnly) {
    try {
      const checks = await preflight.run();
      console.log(formatPreflightReport(checks));
      if (hasPreflightFailures(checks)) process.exitCode = 1;
    } finally {
      if (process.env.MANAGED_SETTINGS_ENABLED === "true") await application.cleanup.stop();
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
