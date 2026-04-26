import { describe, expect, it } from "vitest";

import {
  buildAnalysisPrompt,
  buildImplementationPrompt,
} from "../src/domain/promptBuilder.js";
import { getPromptProfile } from "../src/domain/promptProfiles.js";
import type { TaskAnalysisDecision, TrackerIssue } from "../src/models/types.js";

const issue: TrackerIssue = {
  id: "1",
  key: "FRONTEND-1",
  title: "Fix Button",
  description: "Button has broken focus styles.",
};

const decision: TaskAnalysisDecision = {
  confidence: 88,
  taskType: "frontend_ui_fix",
  recommendedMode: "implement",
  promptProfileId: "frontend_ui_fix",
  expectedFiles: ["src/Button.tsx"],
  expectedSubsystems: ["ui"],
  riskFactors: ["visual regression"],
  missingContext: [],
  reasoning: "Localized component fix.",
};

describe("prompt builder", () => {
  it("asks analysis for structured AI_ANALYSIS output", () => {
    const prompt = buildAnalysisPrompt(issue, []);

    expect(prompt).toContain("AI_ANALYSIS:");
    expect(prompt).toContain('"confidence": 82');
    expect(prompt).not.toContain("READY_FOR_IMPLEMENTATION");
  });

  it("includes prompt profile and analysis context in implementation prompts", () => {
    const prompt = buildImplementationPrompt(
      issue,
      [],
      getPromptProfile("frontend_ui_fix"),
      decision,
    );

    expect(prompt).toContain("Prompt profile: frontend_ui_fix");
    expect(prompt).toContain("Structured analysis:");
    expect(prompt).toContain("Visual regression");
  });
});
