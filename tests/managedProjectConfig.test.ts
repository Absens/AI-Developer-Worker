import { resolve } from "node:path";
import { expect, it } from "vitest";

import { buildQualityGates } from "../src/domain/qualityGates.js";
import { loadManagedBootstrap } from "../src/domain/settings/bootstrap.js";
import type { ManagedExecutionSnapshot } from "../src/domain/settings/runtime.js";
import type { ProjectDefinition } from "../src/domain/settings/types.js";
import { buildManagedProjectRuntimeConfig } from "../src/managedApplication.js";

it("uses the pinned gates and repair budget instead of newly saved settings", () => {
  const repoPath = resolve("managed-checkout-fixture");
  const { fleet } = loadManagedBootstrap({
    SETTINGS_WORKSPACE_ROOT: repoPath,
    SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
    SETTINGS_GITLAB_ORIGINS: "https://gitlab.test",
    TASK_TRACKER_DATABASE_URL: "postgresql://test:test@127.0.0.1/managed_test",
  });
  const original: ProjectDefinition = {
    name: "Project",
    gitlabProjectId: "42",
    connectionId: "connection",
    baseBranch: "main",
    testCommand: "test",
    lintCommand: "lint",
    timeoutSeconds: 60,
    maxFixAttempts: 2,
  };
  const pinned: ProjectDefinition = {
    ...original,
    securityScanCommand: "scan",
    sastCommand: "analyze",
    coverageCommand: "cover",
    coverageReportFile: "coverage/summary.json",
    minCoveragePercent: 82.5,
    visualRegressionCommand: "compare",
    maxReviewFixAttempts: 0,
  };
  const active = { revision: 2, definition: pinned, cloneUrl: "https://gitlab.test/team/repo.git" };
  const snapshot: ManagedExecutionSnapshot = {
    active,
    connection: { id: "connection", origin: "https://gitlab.test", token: "fixture-token", revision: 1 },
    project: {
      id: "project",
      revision: 3,
      desired: { ...pinned, coverageCommand: "latest-coverage", maxReviewFixAttempts: 4 },
      enabled: true,
      active,
      status: "pending",
    },
  };

  const { profile, config } = buildManagedProjectRuntimeConfig(fleet, repoPath, snapshot);

  expect(profile.repoPath).toBe(repoPath);
  expect(buildQualityGates(config).filter(({ command }) => command).map(({ id, command }) => [id, command]))
    .toEqual([
      ["lint", "lint"],
      ["tests", "test"],
      ["security_scan", "scan"],
      ["sast", "analyze"],
      ["coverage", "cover"],
      ["visual_regression", "compare"],
    ]);
  expect(config).toMatchObject({
    coverageReportFile: "coverage/summary.json",
    coverageReportWorkspaceOnly: true,
    minCoveragePercent: 82.5,
    maxFixAttempts: 2,
    maxReviewFixAttempts: 0,
  });
  expect(buildManagedProjectRuntimeConfig(fleet, repoPath, {
    ...snapshot,
    active: { ...active, definition: original },
  }).config.maxReviewFixAttempts).toBe(original.maxFixAttempts);
});
