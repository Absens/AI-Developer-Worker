import { defineConfig } from "vitest/config";

// Dedicated command: database tests are never silently skipped in this suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/postgres/**/*.integration.ts"],
    pool: "threads",
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    clearMocks: true,
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
