import { describe, expect, it } from "vitest";

import {
  PROJECT_ANALYSIS_MARKER,
  PROJECT_REPLAN_MARKER,
  assertProjectReplanWithinPolicy,
  parseProjectAnalysisResponse,
  parseProjectReplanResponse,
  type ProjectManagerConfig,
} from "../src/domain/projectManager/index.js";

const buildProjectManagerConfig = (
  overrides: Partial<ProjectManagerConfig> = {},
): ProjectManagerConfig => ({
  enabled: true,
  runOnce: true,
  intervalMinutes: 60,
  maxGoalsPerRun: 5,
  maxTaskProposalsPerGoal: 3,
  defaultAutonomyLevel: "proposal_only",
  autoApproveLowRisk: false,
  allowedTaskTypes: ["documentation", "tests_only"],
  repositoryScanEnabled: false,
  repositoryScanMaxFiles: 100,
  requireHumanGoalApproval: true,
  ...overrides,
});

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
      goalReplans: [],
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
      goalReplans: [],
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

describe("project manager replan parser", () => {
  it("parses a valid PROJECT_REPLAN response", () => {
    const parsed = parseProjectReplanResponse(
      `${PROJECT_REPLAN_MARKER} ${JSON.stringify({
        previousAnalysisId: "analysis-1",
        summary: "Replan active project goals after linked task failures.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: ["goal-stale"],
        replanReason: "TASK-42 failed validation twice.",
        goalReplans: [
          {
            goalId: "goal-active",
            decision: "ask_human",
            rationale: "Acceptance scope needs product confirmation.",
            evidenceRefs: [
              {
                kind: "metric",
                ref: "TASK-42",
                summary: "linked task is waiting for human input",
              },
            ],
            followUpGoals: [],
            humanQuestion: "Should goal-active keep the original acceptance scope?",
          },
          {
            goalId: "goal-follow",
            decision: "create_follow_up",
            rationale: "The validation failure revealed a separate docs gap.",
            evidenceRefs: [
              {
                kind: "validation_failure",
                ref: "TASK-43:quality-1",
              },
            ],
            followUpGoals: [
              {
                title: "Document validation retry behavior",
                problemStatement: "Operators lack retry guidance.",
                desiredOutcome: "Retry behavior is documented.",
                successMetrics: ["Runbook covers validation retry behavior"],
                priority: "normal",
                riskLevel: "low",
                evidenceRefs: [
                  {
                    kind: "validation_failure",
                    ref: "TASK-43:quality-1",
                  },
                ],
                suggestedTaskProposals: [
                  {
                    title: "Add retry docs",
                    description: "Document validation retry steps.",
                    taskType: "documentation",
                    acceptanceCriteria: ["Retry docs are present"],
                    evidenceRefs: [
                      {
                        kind: "validation_failure",
                        ref: "TASK-43:quality-1",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })}`,
    );

    expect(parsed).toEqual({
      previousAnalysisId: "analysis-1",
      summary: "Replan active project goals after linked task failures.",
      healthSignals: [],
      proposedGoals: [],
      staleGoalIds: ["goal-stale"],
      replanReason: "TASK-42 failed validation twice.",
      goalReplans: [
        expect.objectContaining({
          goalId: "goal-active",
          decision: "ask_human",
          humanQuestion: "Should goal-active keep the original acceptance scope?",
        }),
        expect.objectContaining({
          goalId: "goal-follow",
          decision: "create_follow_up",
          followUpGoals: [
            expect.objectContaining({
              title: "Document validation retry behavior",
            }),
          ],
        }),
      ],
    });
  });

  it("rejects unsupported replan decisions", () => {
    const parsed = parseProjectReplanResponse(
      `${PROJECT_REPLAN_MARKER} ${JSON.stringify({
        summary: "Invalid decision.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        replanReason: "Testing unsupported decisions.",
        goalReplans: [
          {
            goalId: "goal-active",
            decision: "delete",
            rationale: "Unsupported.",
            evidenceRefs: [],
            followUpGoals: [],
          },
        ],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("rejects unknown active goal ids in replan policy", () => {
    const parsed = parseProjectReplanResponse(
      `${PROJECT_REPLAN_MARKER} ${JSON.stringify({
        summary: "Unknown goal.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        replanReason: "Testing unknown goals.",
        goalReplans: [
          {
            goalId: "goal-missing",
            decision: "continue",
            rationale: "Keep going.",
            evidenceRefs: [],
            followUpGoals: [],
          },
        ],
      })}`,
    );

    expect(parsed).toBeDefined();
    expect(() =>
      assertProjectReplanWithinPolicy({
        parsed: parsed!,
        config: buildProjectManagerConfig(),
        activeGoalIds: ["goal-active"],
      }),
    ).toThrow(/unknown or inactive/);
  });

  it("requires a human question for ask_human replan decisions in policy", () => {
    const parsed = parseProjectReplanResponse(
      `${PROJECT_REPLAN_MARKER} ${JSON.stringify({
        summary: "Question missing.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        replanReason: "Testing human question validation.",
        goalReplans: [
          {
            goalId: "goal-active",
            decision: "ask_human",
            rationale: "Needs input.",
            evidenceRefs: [],
            followUpGoals: [],
          },
        ],
      })}`,
    );

    expect(parsed).toBeDefined();
    expect(() =>
      assertProjectReplanWithinPolicy({
        parsed: parsed!,
        config: buildProjectManagerConfig(),
        activeGoalIds: ["goal-active"],
      }),
    ).toThrow(/humanQuestion/);
  });
});
