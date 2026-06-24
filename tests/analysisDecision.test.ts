import { describe, expect, it } from "vitest";

import {
  createClarificationFromAnalysis,
  parseTaskAnalysisDecision,
} from "../src/domain/analysisDecision.js";

describe("analysis decision parsing", () => {
  it("parses a valid AI_ANALYSIS line", () => {
    const decision = parseTaskAnalysisDecision(
      'AI_ANALYSIS: {"confidence":82,"taskType":"frontend_ui_fix","recommendedMode":"implement","promptProfileId":"frontend_ui_fix","expectedFiles":["src/Button.tsx"],"expectedSubsystems":["ui"],"riskFactors":["visual regression"],"missingContext":[],"reasoning":"Clear localized UI task."}',
    );

    expect(decision).toEqual({
      confidence: 82,
      taskType: "frontend_ui_fix",
      recommendedMode: "implement",
      promptProfileId: "frontend_ui_fix",
      expectedFiles: ["src/Button.tsx"],
      expectedSubsystems: ["ui"],
      riskFactors: ["visual regression"],
      missingContext: [],
      reasoning: "Clear localized UI task.",
    });
  });

  it("parses raw JSON output from Codex output-schema runs", () => {
    const decision = parseTaskAnalysisDecision(
      '{"confidence":91,"taskType":"documentation","recommendedMode":"implement","promptProfileId":"documentation","expectedFiles":["README.md"],"expectedSubsystems":["docs"],"riskFactors":[],"missingContext":[],"reasoning":"Documentation-only change with clear scope."}',
    );

    expect(decision).toMatchObject({
      confidence: 91,
      taskType: "documentation",
      recommendedMode: "implement",
      promptProfileId: "documentation",
    });
  });

  it("fails invalid output safely", () => {
    expect(parseTaskAnalysisDecision("READY_FOR_IMPLEMENTATION")).toBeUndefined();
    expect(
      parseTaskAnalysisDecision(
        'AI_ANALYSIS: {"confidence":101,"recommendedMode":"implement"}',
      ),
    ).toBeUndefined();
  });

  it("routes low-confidence implementation decisions away from implementation", () => {
    const decision = parseTaskAnalysisDecision(
      'AI_ANALYSIS: {"confidence":45,"taskType":"unknown","recommendedMode":"implement","promptProfileId":"general","expectedFiles":[],"expectedSubsystems":[],"riskFactors":[],"missingContext":["Need API contract"],"reasoning":"Missing context."}',
      { implementThreshold: 70, humanThreshold: 40 },
    );

    expect(decision?.recommendedMode).toBe("ask_clarification");
    expect(createClarificationFromAnalysis(decision!).question).toBe("Need API contract");
  });
});
