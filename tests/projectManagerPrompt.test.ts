import { describe, expect, it } from "vitest";

import {
  buildProjectAnalysisPrompt,
  type ProjectSignalSnapshot,
} from "../src/domain/projectManager/index.js";

const buildSnapshot = (
  overrides: Partial<ProjectSignalSnapshot> = {},
): ProjectSignalSnapshot => ({
  repositoryName: "worker-repo",
  generatedAt: "2026-05-25T12:00:00.000Z",
  totalTasks: 3,
  statusCounts: {
    failed: 1,
    open: 2,
  },
  activeLeases: 0,
  readyTasks: [],
  failedTasks: [
    {
      id: "TASK-42",
      title: "Fix repeated validation failure",
      status: "failed",
      repositoryName: "worker-repo",
      updatedAt: "2026-05-25T11:00:00.000Z",
      failedAgentRuns: 2,
      failedValidations: 3,
    },
  ],
  waitingForHuman: [],
  repeatedFailures: [],
  recentReviewTasks: [],
  ...overrides,
});

describe("project manager prompt builder", () => {
  it("includes analysis-only guardrails", () => {
    const prompt = buildProjectAnalysisPrompt({ snapshot: buildSnapshot() });

    expect(prompt).toContain("Mode: project-management-analysis-only");
    expect(prompt).toContain("Analyze only the provided snapshot");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Do not call external services");
    expect(prompt).toContain("Evidence-backed goals only");
    expect(prompt).toContain("Obey limits");
  });

  it("requires exactly one PROJECT_ANALYSIS response line", () => {
    const prompt = buildProjectAnalysisPrompt({ snapshot: buildSnapshot() });

    expect(prompt).toContain(
      "Reply with exactly one line starting with PROJECT_ANALYSIS:",
    );
  });

  it("says not to create executable tasks directly", () => {
    const prompt = buildProjectAnalysisPrompt({ snapshot: buildSnapshot() });

    expect(prompt).toContain("Do not create executable tasks directly");
  });

  it("includes allowed task types and focus areas", () => {
    const prompt = buildProjectAnalysisPrompt({
      snapshot: buildSnapshot(),
      allowedTaskTypes: ["documentation", "tests_only"],
      focusAreas: ["validation stability", "operator docs"],
    });

    expect(prompt).toContain("Allowed task types: documentation, tests_only");
    expect(prompt).toContain("Focus areas: validation stability, operator docs");
    expect(prompt).toContain("task proposals must use allowed task types");
  });

  it("includes compact JSON snapshot with repository name and failed task id", () => {
    const prompt = buildProjectAnalysisPrompt({ snapshot: buildSnapshot() });
    const compactSnapshot = JSON.stringify(buildSnapshot());

    expect(prompt).toContain(compactSnapshot);
    expect(prompt).toContain('"repositoryName":"worker-repo"');
    expect(prompt).toContain('"id":"TASK-42"');
  });

  it("includes the required JSON response schema", () => {
    const prompt = buildProjectAnalysisPrompt({ snapshot: buildSnapshot() });

    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"healthSignals"');
    expect(prompt).toContain('"proposedGoals"');
    expect(prompt).toContain('"staleGoalIds"');
    expect(prompt).toContain('"replanReason"');
  });

  it("truncates large snapshots deterministically", () => {
    const snapshot = buildSnapshot({
      failedTasks: [
        {
          id: "TASK-42",
          title: "A".repeat(200),
          status: "failed",
          updatedAt: "2026-05-25T11:00:00.000Z",
          failedAgentRuns: 2,
          failedValidations: 3,
        },
      ],
    });

    const firstPrompt = buildProjectAnalysisPrompt({
      snapshot,
      maxSnapshotChars: 120,
    });
    const secondPrompt = buildProjectAnalysisPrompt({
      snapshot,
      maxSnapshotChars: 120,
    });

    expect(firstPrompt).toBe(secondPrompt);
    expect(firstPrompt).toContain("[snapshot truncated at 120 chars]");
    expect(firstPrompt).not.toContain("A".repeat(200));
  });
});
