import { describe, expect, it } from "vitest";

import {
  getPromptProfile,
  selectPromptProfile,
} from "../src/domain/promptProfiles.js";
import type { TaskAnalysisDecision, TrackerIssue } from "../src/models/types.js";

const issue = (overrides: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: "1",
  key: "FRONTEND-1",
  title: "Fix responsive button layout",
  description: "The component breaks keyboard focus styling.",
  logicalStatus: "open",
  tags: ["ai_dev"],
  ...overrides,
});

const analysis = (
  overrides: Partial<TaskAnalysisDecision> = {},
): TaskAnalysisDecision => ({
  confidence: 90,
  taskType: "backend_endpoint",
  recommendedMode: "implement",
  promptProfileId: "backend_endpoint",
  expectedFiles: [],
  expectedSubsystems: [],
  riskFactors: [],
  missingContext: [],
  reasoning: "Endpoint task.",
  ...overrides,
});

describe("prompt profiles", () => {
  it("uses explicit analysis profile before heuristics", () => {
    expect(selectPromptProfile(issue(), analysis()).id).toBe("backend_endpoint");
  });

  it("falls back to general when analysis has an unknown profile", () => {
    expect(
      selectPromptProfile(
        issue(),
        analysis({ promptProfileId: "missing", taskType: "unknown" }),
      ).id,
    ).toBe("general");
  });

  it("uses issue heuristics when no analysis decision is available", () => {
    expect(selectPromptProfile(issue()).id).toBe("frontend_ui_fix");
  });

  it("merges repository overrides into built-in profiles", () => {
    const profile = getPromptProfile("frontend_ui_fix", {
      frontend_ui_fix: {
        validationFocus: ["Run visual regression command when configured."],
      },
    });

    expect(profile.validationFocus).toContain(
      "Run visual regression command when configured.",
    );
    expect(profile.validationFocus).toContain(
      "Run configured lint, tests, and visual regression checks when available.",
    );
  });
});
