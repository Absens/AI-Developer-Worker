import { Pool } from "pg";

import {
  InMemoryTaskTrackerClient,
  type TaskTrackerClient,
} from "../../domain/taskTracker/index.js";
import type { AutonomyPolicyConfig, TaskTrackerConfig } from "../../models/types.js";
import { PostgresTaskTrackerClient } from "./postgresTaskTracker.js";

export const createInternalTaskTrackerClient = (
  config: TaskTrackerConfig | undefined,
  autonomyPolicy?: AutonomyPolicyConfig,
): TaskTrackerClient | undefined => {
  if (config?.provider !== "internal") {
    return undefined;
  }

  if (config.internal.storage === "memory") {
    return new InMemoryTaskTrackerClient({
      autonomyPolicy,
      redactionEnabled: config.internal.operational.redactionEnabled,
    });
  }

  const pool = new Pool({ connectionString: config.internal.databaseUrl });
  return new PostgresTaskTrackerClient(pool, {
    autonomyPolicy,
    redactionEnabled: config.internal.operational.redactionEnabled,
  });
};
