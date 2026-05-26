import { buildApplication } from "./app.js";
import { formatPreflightReport, hasPreflightFailures } from "./domain/preflight.js";
import { Logger } from "./utils/logger.js";

const main = async (): Promise<void> => {
  const {
    config,
    orchestrator,
    preflight,
    logger,
    observability,
    cleanup,
    assertCodexAuthenticated,
    assertRepositoryReady,
  } = buildApplication();
  if (config.preflightOnly) {
    const checks = await preflight.run();
    console.log(formatPreflightReport(checks));
    if (hasPreflightFailures(checks)) {
      process.exitCode = 1;
    }
    return;
  }

  await observability.start();
  observability.markNotReady("startup checks pending");
  const markStopping = (): void => {
    observability.markNotReady("shutting down");
    observability.setWorkerState({
      workerId: config.workerId,
      state: "shutting_down",
    });
  };
  process.on("SIGINT", markStopping);
  process.on("SIGTERM", markStopping);

  try {
    observability.setWorkerState({
      workerId: config.workerId,
      state: "starting",
    });
    await assertRepositoryReady();
    observability.incrementCounter("ai_developer_preflight_checks_total", {
      check: "repository_ready",
      status: "pass",
    });
    await assertCodexAuthenticated();
    observability.incrementCounter("ai_developer_preflight_checks_total", {
      check: "codex_auth",
      status: "pass",
    });
    cleanup.start();
    observability.markReady();
    if (config.runOnce) {
      await orchestrator.runOnce();
      logger.info("Worker completed a single run.");
      return;
    }

    await orchestrator.runForever();
  } catch (error) {
    observability.markNotReady(error instanceof Error ? error.message : String(error));
    observability.incrementCounter("ai_developer_preflight_checks_total", {
      check: "startup",
      status: "fail",
    });
    throw error;
  } finally {
    process.off("SIGINT", markStopping);
    process.off("SIGTERM", markStopping);
    await observability.stop();
    await cleanup.stop();
  }
};

const logger = new Logger();

main().catch((error) => {
  logger.error("Worker failed to start.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
