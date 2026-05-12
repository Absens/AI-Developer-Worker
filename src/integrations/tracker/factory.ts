import type { TaskTrackerClient } from "../../domain/taskTracker/index.js";
import type { AppConfig, TrackerClient } from "../../models/types.js";
import type { Logger } from "../../utils/logger.js";
import { InternalTrackerRuntimeGuardClient } from "../internalTracker/runtimeGuardTrackerClient.js";
import { YandexTrackerClient } from "./client.js";

export const createRuntimeTrackerClient = (
  config: AppConfig,
  logger: Logger,
  internalTaskTracker?: TaskTrackerClient,
): TrackerClient => {
  if (config.taskTracker?.provider === "internal") {
    return new InternalTrackerRuntimeGuardClient(internalTaskTracker);
  }

  return new YandexTrackerClient(config, logger);
};
