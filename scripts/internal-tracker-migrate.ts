import { Pool } from "pg";

import {
  getInternalTrackerMigrationStatus,
  runInternalTrackerMigrations,
} from "../src/integrations/internalTracker/index.js";

const databaseUrl = process.env.TASK_TRACKER_DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("TASK_TRACKER_DATABASE_URL is required.");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const ran = await runInternalTrackerMigrations(pool);
    const status = await getInternalTrackerMigrationStatus(pool);
    if (ran.length === 0) {
      console.log("Internal tracker schema is already up to date.");
    } else {
      console.log(
        `Applied internal tracker migrations: ${ran.map((migration) => migration.filename).join(", ")}`,
      );
    }
    console.log(`Applied versions: ${status.applied.join(", ")}`);
  } finally {
    await pool.end();
  }
}
