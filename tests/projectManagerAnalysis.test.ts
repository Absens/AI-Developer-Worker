import { describe, expect, it } from "vitest";

import {
  PROJECT_ANALYSIS_MARKER,
  PROJECT_REPLAN_MARKER,
  PROJECT_STRATEGY_MARKER,
  assertProjectReplanWithinPolicy,
  assertProjectStrategyWithinPolicy,
  parseProjectAnalysisResponse,
  parseProjectReplanResponse,
  parseProjectStrategyResponse,
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

const config = buildProjectManagerConfig();

const validReplanGoal = (title: string): Record<string, unknown> => ({
  title,
  problemStatement: `${title} problem statement.`,
  desiredOutcome: `${title} desired outcome.`,
  successMetrics: [`${title} metric`],
  priority: "normal",
  riskLevel: "low",
  evidenceRefs: [
    {
      kind: "file",
      ref: "docs/runbook.md",
    },
  ],
  suggestedTaskProposals: [
    {
      title: `${title} task`,
      description: `${title} task description.`,
      taskType: "documentation",
      acceptanceCriteria: [`${title} criterion`],
      evidenceRefs: [
        {
          kind: "file",
          ref: "docs/runbook.md",
        },
      ],
    },
  ],
});

describe("project manager strategy parser", () => {
  it("parses valid PROJECT_STRATEGY output", () => {
    const parsed = parseProjectStrategyResponse(
      `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
        summary: "Strategy found one technical opportunity.",
        analysisLenses: [
          { lens: "strategy", summary: "Validation evidence is weak." },
          { lens: "risk", summary: "Keep scope tests-only first." },
        ],
        opportunities: [
          {
            opportunityId: "opp-validation",
            dimension: "technical",
            title: "Make validation evidence trustworthy",
            problemStatement: "Recent PM outputs rely on no-op validation summaries.",
            userOrBusinessImpact: "Operators cannot trust completion signals.",
            technicalImpact: "Validation confidence is overstated.",
            evidenceRefs: [
              { kind: "snapshot", ref: "projectSignals.repeatedFailures", summary: "Repeated validation failures exist." },
            ],
            confidence: 82,
            priority: "high",
            riskLevel: "medium",
            recommendedNextStep: "create_goal",
            rationale: "Direct snapshot evidence supports a bounded tests-only goal.",
            redTeamNotes: ["Avoid broad CI rewrites."],
            architectVerdict: "pursue",
          },
        ],
        proposedGoals: [
          {
            sourceOpportunityId: "opp-validation",
            title: "Improve validation evidence quality",
            problemStatement: "PM analysis can treat weak validation commands as strong evidence.",
            desiredOutcome: "PM prompts and tests distinguish weak validation evidence from real checks.",
            successMetrics: ["Prompt tests cover no-op validation commands."],
            evidenceRefs: [
              { kind: "snapshot", ref: "projectSignals.repeatedFailures", summary: "Repeated validation failures exist." },
            ],
            priority: "high",
            riskLevel: "medium",
            suggestedTaskProposals: [
              {
                title: "Add PM validation evidence tests",
                description: "Cover no-op validation command handling in PM prompt tests.",
                taskType: "tests_only",
                acceptanceCriteria: ["Tests fail before prompt hardening and pass after it."],
                expectedBlastRadius: "Prompt tests only.",
                evidenceRefs: [
                  { kind: "snapshot", ref: "projectSignals.repeatedFailures", summary: "Repeated validation failures exist." },
                ],
              },
            ],
          },
        ],
        questionsForHuman: [
          {
            question: "Which user workflow should strategy mode optimize first?",
            whyItMatters: "The snapshot has weak product context.",
            relatedOpportunityId: "opp-validation",
            relatedOpportunityTitle: "Make validation evidence trustworthy",
          },
        ],
      })}`,
    );

    expect(parsed).toMatchObject({
      summary: "Strategy found one technical opportunity.",
      opportunities: [
        {
          opportunityId: "opp-validation",
          architectVerdict: "pursue",
          recommendedNextStep: "create_goal",
        },
      ],
      proposedGoals: [
        {
          sourceOpportunityId: "opp-validation",
          title: "Improve validation evidence quality",
        },
      ],
    });
  });

  it("rejects PROJECT_STRATEGY proposed goals without sourceOpportunityId", () => {
    const parsed = parseProjectStrategyResponse(
      `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
        summary: "Invalid strategy.",
        analysisLenses: [],
        opportunities: [],
        proposedGoals: [
          {
            title: "Missing source opportunity",
            problemStatement: "No link.",
            desiredOutcome: "Rejected.",
            successMetrics: ["Rejected."],
            evidenceRefs: [{ kind: "snapshot", ref: "x", summary: "x" }],
            priority: "normal",
            riskLevel: "low",
            suggestedTaskProposals: [],
          },
        ],
        questionsForHuman: [],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("rejects PROJECT_STRATEGY output without analysisLenses", () => {
    const parsed = parseProjectStrategyResponse(
      `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
        summary: "Strategy output is missing required lens summaries.",
        opportunities: [],
        proposedGoals: [],
        questionsForHuman: [],
      })}`,
    );

    expect(parsed).toBeUndefined();
  });

  it("rejects low-confidence create_goal opportunities", () => {
    const parsed = parseProjectStrategyResponse(
      `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
        summary: "Low confidence strategy.",
        analysisLenses: [],
        opportunities: [
          {
            opportunityId: "opp-low",
            dimension: "technical",
            title: "Low confidence",
            problemStatement: "Weak evidence.",
            userOrBusinessImpact: "Unknown.",
            technicalImpact: "Unknown.",
            evidenceRefs: [{ kind: "snapshot", ref: "x", summary: "x" }],
            confidence: 59,
            priority: "normal",
            riskLevel: "low",
            recommendedNextStep: "create_goal",
            rationale: "Too weak.",
            redTeamNotes: [],
            architectVerdict: "pursue",
          },
        ],
        proposedGoals: [],
        questionsForHuman: [],
      })}`,
    );

    expect(parsed).toBeDefined();
    expect(() =>
      assertProjectStrategyWithinPolicy({
        parsed: parsed!,
        config,
      }),
    ).toThrow(/confidence below 60/i);
  });

  it("rejects proposed strategy goals without overlapping opportunity evidence", () => {
    const parsed = parseProjectStrategyResponse(
      `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
        summary: "Evidence mismatch.",
        analysisLenses: [],
        opportunities: [
          {
            opportunityId: "opp-1",
            dimension: "technical",
            title: "Opportunity",
            problemStatement: "Problem.",
            userOrBusinessImpact: "Operator impact.",
            technicalImpact: "Technical impact.",
            evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failed tasks." }],
            confidence: 80,
            priority: "high",
            riskLevel: "medium",
            recommendedNextStep: "create_goal",
            rationale: "Supported.",
            redTeamNotes: [],
            architectVerdict: "pursue",
          },
        ],
        proposedGoals: [
          {
            sourceOpportunityId: "opp-1",
            title: "Mismatched evidence goal",
            problemStatement: "Goal evidence does not overlap.",
            desiredOutcome: "Rejected.",
            successMetrics: ["Rejected."],
            evidenceRefs: [{ kind: "task", ref: "unrelated-task", summary: "Unrelated." }],
            priority: "high",
            riskLevel: "medium",
            suggestedTaskProposals: [],
          },
        ],
        questionsForHuman: [],
      })}`,
    );

    expect(parsed).toBeDefined();
    expect(() =>
      assertProjectStrategyWithinPolicy({
        parsed: parsed!,
        config,
      }),
    ).toThrow(/evidence/i);
  });

  it("rejects proposed strategy goals sourced from non-create_goal opportunities", () => {
    const parsed = parseProjectStrategyResponse(
      `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
        summary: "Research-only opportunity should not materialize goals.",
        analysisLenses: [],
        opportunities: [
          {
            opportunityId: "opp-research",
            dimension: "technical",
            title: "Research validation failures",
            problemStatement: "The signal needs investigation before a goal is created.",
            userOrBusinessImpact: "Operators need confidence in the chosen next step.",
            technicalImpact: "Premature goals may optimize the wrong behavior.",
            evidenceRefs: [
              { kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failed tasks need triage." },
            ],
            confidence: 86,
            priority: "high",
            riskLevel: "medium",
            recommendedNextStep: "research",
            rationale: "Architect wants more research before materialization.",
            redTeamNotes: [],
            architectVerdict: "pursue",
          },
        ],
        proposedGoals: [
          {
            sourceOpportunityId: "opp-research",
            title: "Create premature validation goal",
            problemStatement: "This should be rejected because the source is research-only.",
            desiredOutcome: "No goal is materialized for research-only opportunities.",
            successMetrics: ["Policy rejects non-create_goal source opportunities."],
            evidenceRefs: [
              { kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failed tasks need triage." },
            ],
            priority: "high",
            riskLevel: "medium",
            suggestedTaskProposals: [],
          },
        ],
        questionsForHuman: [],
      })}`,
    );

    expect(parsed).toBeDefined();
    expect(() =>
      assertProjectStrategyWithinPolicy({
        parsed: parsed!,
        config,
      }),
    ).toThrow(/recommendedNextStep|create_goal/);
  });
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

  it("accepts task and snapshot evidence refs from project analysis", () => {
    const parsed = parseProjectAnalysisResponse(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Repository snapshot has actionable project signals.",
        healthSignals: [
          {
            kind: "operations",
            severity: "low",
            title: "No blocked queue",
            description: "Snapshot reports no failed or waiting tasks.",
            evidenceRefs: [
              {
                kind: "snapshot",
                ref: "statusCounts",
                summary: "failed=0, waiting=0",
              },
            ],
          },
        ],
        proposedGoals: [
          {
            title: "Improve task metadata quality",
            problemStatement: "Recent tasks lack useful classification metadata.",
            desiredOutcome: "Task metadata is more useful for project analysis.",
            successMetrics: ["Future tasks avoid unknown task type when evidence exists"],
            priority: "low",
            riskLevel: "low",
            evidenceRefs: [
              {
                kind: "task",
                ref: "yt_FRONTEND-2027.taskType",
                summary: "taskType=unknown",
              },
            ],
            suggestedTaskProposals: [
              {
                title: "Document task classification guidance",
                description: "Add lightweight guidance for frontend task classification.",
                taskType: "documentation",
                acceptanceCriteria: ["Guidance covers frontend UI behavior changes"],
                evidenceRefs: [
                  {
                    kind: "task",
                    ref: "yt_FRONTEND-2027",
                  },
                ],
              },
            ],
          },
        ],
        staleGoalIds: [],
      })}`,
    );

    expect(parsed?.healthSignals[0]?.evidenceRefs[0]?.kind).toBe("snapshot");
    expect(parsed?.proposedGoals[0]?.evidenceRefs[0]?.kind).toBe("task");
    expect(
      parsed?.proposedGoals[0]?.suggestedTaskProposals[0]?.evidenceRefs[0]?.kind,
    ).toBe("task");
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

  it("rejects replans with more aggregate materializable goals than configured", () => {
    const parsed = parseProjectReplanResponse(
      `${PROJECT_REPLAN_MARKER} ${JSON.stringify({
        summary: "Too many follow-up goals.",
        healthSignals: [],
        proposedGoals: [validReplanGoal("Top-level follow-up")],
        staleGoalIds: [],
        replanReason: "Testing aggregate follow-up goal limits.",
        goalReplans: [
          {
            goalId: "goal-active",
            decision: "create_follow_up",
            rationale: "Create the first nested follow-up.",
            evidenceRefs: [],
            followUpGoals: [validReplanGoal("Nested follow-up one")],
          },
          {
            goalId: "goal-approved",
            decision: "create_follow_up",
            rationale: "Create the second nested follow-up.",
            evidenceRefs: [],
            followUpGoals: [validReplanGoal("Nested follow-up two")],
          },
        ],
      })}`,
    );

    expect(parsed).toBeDefined();
    expect(() =>
      assertProjectReplanWithinPolicy({
        parsed: parsed!,
        config: buildProjectManagerConfig({ maxGoalsPerRun: 2 }),
        activeGoalIds: ["goal-active", "goal-approved"],
      }),
    ).toThrow(/at most 2 materializable goals/);
  });
});
