import { buildApplication } from "./app.js";
import { Logger } from "./utils/logger.js";

const main = async (): Promise<void> => {
  const {
    config,
    orchestrator,
    logger,
    assertCodexAuthenticated,
    assertRepositoryReady,
  } = buildApplication();
  await assertRepositoryReady();
  await assertCodexAuthenticated();
  if (config.runOnce) {
    await orchestrator.runOnce();
    logger.info("Worker completed a single run.");
    return;
  }

  await orchestrator.runForever();
};

const logger = new Logger();

main().catch((error) => {
  logger.error("Worker failed to start.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
