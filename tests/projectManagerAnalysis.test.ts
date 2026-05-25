import { describe, expect, it } from "vitest";

import {
  PROJECT_ANALYSIS_MARKER,
  parseProjectAnalysisResponse,
} from "../src/domain/projectManager/index.js";

describe("project manager analysis parser", () => {
  it("parses a valid PROJECT_ANALYSIS response", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Repository has repeated validation failures.",
        healthSignals: [
          {
            kind: "repeated_validation_failure",
            severity: "medium",
            title: "Repeated proposal tests fail",
            description: "Two recent failed validation runs mention proposals.",
            evidenceRefs: [
              {
                kind: "validation_failure",
                ref: "task-1:quality-1",
                summary: "proposal approval failed twice",
              },
            ],
            recommendation: "Add focused regression coverage.",
          },
        ],
        proposedGoals: [
          {
            title: "Stabilize proposal workflow",
            problemStatement: "Proposal workflow has repeated validation failures.",
            desiredOutcome: "Proposal workflow tests are stable.",
            successMetrics: ["No repeated proposal validation failures for 7 days"],
            priority: "high",
            riskLevel: "low",
            evidenceRefs: [
              {
                kind: "validation_failure",
                ref: "task-1:quality-1",
              },
            ],
            suggestedTaskProposals: [
              {
                title: "Add proposal retry regression test",
                description: "Cover proposal approval idempotency.",
                taskType: "tests_only",
                acceptanceCriteria: ["Focused test covers approval retry"],
                expectedBlastRadius: "tests only",
                evidenceRefs: [
                  {
                    kind: "validation_failure",
                    ref: "task-1:quality-1",
                  },
                ],
              },
            ],
          },
        ],
        staleGoalIds: ["goal-old"],
      })}`,
    );

    expect(parsed).toEqual({
      summary: "Repository has repeated validation failures.",
      healthSignals: [
        expect.objectContaining({
          kind: "repeated_validation_failure",
          severity: "medium",
          evidenceRefs: [
            {
              kind: "validation_failure",
              ref: "task-1:quality-1",
              summary: "proposal approval failed twice",
            },
          ],
        }),
      ],
      proposedGoals: [
        expect.objectContaining({
          title: "Stabilize proposal workflow",
          priority: "high",
          riskLevel: "low",
          suggestedTaskProposals: [
            expect.objectContaining({
              taskType: "tests_only",
              acceptanceCriteria: ["Focused test covers approval retry"],
            }),
          ],
        }),
      ],
      staleGoalIds: ["goal-old"],
    });
  });

  it("rejects responses without the marker", () => {
    expect(parseProjectAnalysisResponse("summary only")).toBeUndefined();
  });

  it("rejects responses where the marker is not the exact prefix", () => {
    expect(
      parseProjectAnalysisResponse(
        ` ${PROJECT_ANALYSIS_MARKER} {"summary":"Leading whitespace"}`,
      ),
    ).toBeUndefined();
  });

  it("rejects invalid priority and risk values", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Invalid goal values.",
        healthSignals: [],
        proposedGoals: [
          {
            title: "Bad goal",
            problemStatement: "Bad priority.",
            desiredOutcome: "Should be rejected.",
            successMetrics: ["Rejected"],
            priority: "urgent",
            riskLevel: "extreme",
            evidenceRefs: [],
            suggestedTaskProposals: [],
          },
        ],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("defaults optional arrays to empty arrays", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "No proposed goals.",
      })}`,
    );

    expect(parsed).toEqual({
      summary: "No proposed goals.",
      healthSignals: [],
      proposedGoals: [],
      staleGoalIds: [],
    });
  });

  it("rejects nested task proposals missing acceptance criteria", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Invalid nested proposal.",
        proposedGoals: [
          {
            title: "Stabilize proposal workflow",
            problemStatement: "Proposal workflow has repeated validation failures.",
            desiredOutcome: "Proposal workflow tests are stable.",
            successMetrics: ["No repeated proposal validation failures for 7 days"],
            priority: "high",
            riskLevel: "low",
            evidenceRefs: [
              {
                kind: "validation_failure",
                ref: "task-1:quality-1",
              },
            ],
            suggestedTaskProposals: [
              {
                title: "Add proposal retry regression test",
                description: "Cover proposal approval idempotency.",
                taskType: "tests_only",
                evidenceRefs: [
                  {
                    kind: "validation_failure",
                    ref: "task-1:quality-1",
                  },
                ],
              },
            ],
          },
        ],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("rejects nested task proposals missing evidence refs", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Invalid nested proposal.",
        proposedGoals: [
          {
            title: "Stabilize proposal workflow",
            problemStatement: "Proposal workflow has repeated validation failures.",
            desiredOutcome: "Proposal workflow tests are stable.",
            successMetrics: ["No repeated proposal validation failures for 7 days"],
            priority: "high",
            riskLevel: "low",
            evidenceRefs: [
              {
                kind: "validation_failure",
                ref: "task-1:quality-1",
              },
            ],
            suggestedTaskProposals: [
              {
                title: "Add proposal retry regression test",
                description: "Cover proposal approval idempotency.",
                taskType: "tests_only",
                acceptanceCriteria: ["Focused test covers approval retry"],
              },
            ],
          },
        ],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("rejects health signals missing evidence refs", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Invalid health signal.",
        healthSignals: [
          {
            kind: "repeated_validation_failure",
            severity: "medium",
            title: "Repeated proposal tests fail",
            description: "Two recent failed validation runs mention proposals.",
          },
        ],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("rejects proposed goals missing success metrics", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Invalid goal.",
        proposedGoals: [
          {
            title: "Stabilize proposal workflow",
            problemStatement: "Proposal workflow has repeated validation failures.",
            desiredOutcome: "Proposal workflow tests are stable.",
            priority: "high",
            riskLevel: "low",
            evidenceRefs: [
              {
                kind: "validation_failure",
                ref: "task-1:quality-1",
              },
            ],
            suggestedTaskProposals: [],
          },
        ],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("rejects proposed goals missing evidence refs", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Invalid goal.",
        proposedGoals: [
          {
            title: "Stabilize proposal workflow",
            problemStatement: "Proposal workflow has repeated validation failures.",
            desiredOutcome: "Proposal workflow tests are stable.",
            successMetrics: ["No repeated proposal validation failures for 7 days"],
            priority: "high",
            riskLevel: "low",
            suggestedTaskProposals: [],
          },
        ],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });
});
