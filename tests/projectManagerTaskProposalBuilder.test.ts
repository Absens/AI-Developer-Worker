import { describe, expect, it } from "vitest";

import {
  buildProjectGoalTaskProposalInputs,
  type ProjectGoal,
} from "../src/domain/projectManager/index.js";

const baseGoal = (overrides: Partial<ProjectGoal> = {}): ProjectGoal => ({
  id: "pm_goal_1",
  sourceAnalysisId: "pm_analysis_1",
  sourceRunId: "pm_run_1",
  repositoryName: "developer",
  status: "approved",
  title: "Stabilize proposal workflow",
  problemStatement: "Repeated validation failures show proposal workflow regressions.",
  desiredOutcome: "Proposal approval and duplicate behavior has regression coverage.",
  successMetrics: ["No repeated proposal failures for 7 days"],
  evidenceRefs: [
    {
      kind: "validation_failure",
      ref: "quality-gate:proposal-tests",
      summary: "Proposal tests failed twice.",
    },
    {
      kind: "file",
      ref: "tests/taskTrackerProposals.test.ts",
    },
  ],
  priority: "high",
  riskLevel: "low",
  suggestedTaskProposals: [
    {
      title: "Add proposal idempotency regression coverage",
      description: "Cover repeated proposal creation for PM-generated tasks.",
      taskType: "tests_only",
      acceptanceCriteria: [
        "Repeated PM proposal command returns the same task.",
        "Repeated PM proposal command returns the same goal-task link.",
      ],
      expectedBlastRadius: "tests only",
      evidenceRefs: [
        {
          kind: "file",
          ref: "tests/humanTaskApi.test.ts",
        },
        {
          kind: "validation_failure",
          ref: "quality-gate:proposal-tests",
          summary: "Duplicate evidence should be deduplicated.",
        },
      ],
    },
    {
      title: "Document proposal policy",
      description: "Document PM proposal policy in the operator runbook.",
      taskType: "documentation",
      acceptanceCriteria: ["Runbook documents PM proposal safety."],
      evidenceRefs: [{ kind: "file", ref: "docs/ENV_CONFIGURATION.md" }],
    },
  ],
  duplicateSignature: "goal-signature",
  approvedBy: { owner: "human", id: "dev-1" },
  approvedAt: "2026-05-26T08:00:00.000Z",
  createdAt: "2026-05-26T07:00:00.000Z",
  updatedAt: "2026-05-26T08:00:00.000Z",
  ...overrides,
});

describe("ProjectGoal task proposal builder", () => {
  it("turns nested goal drafts into bounded ProposeTaskInput values with PM evidence", () => {
    const [proposal] = buildProjectGoalTaskProposalInputs({
      goal: baseGoal(),
      config: {
        maxTaskProposalsPerGoal: 1,
        defaultAutonomyLevel: "auto_triage",
      },
    });

    expect(proposal).toMatchObject({
      source: "ai_proposal",
      proposedBy: "project_manager_agent",
      repositoryName: "developer",
      title: "Add proposal idempotency regression coverage",
      description: "Cover repeated proposal creation for PM-generated tasks.",
      proposalReason: expect.stringContaining("Project goal: Stabilize proposal workflow"),
      suggestedAcceptanceCriteria: [
        "Repeated PM proposal command returns the same task.",
        "Repeated PM proposal command returns the same goal-task link.",
      ],
      taskType: "tests_only",
      expectedBlastRadius: "tests only",
      autonomyLevel: "auto_triage",
      approvalPolicy: "project_manager_goal_policy",
      priority: "high",
    });
    expect(proposal?.proposalReason).toContain(
      "Desired outcome: Proposal approval and duplicate behavior has regression coverage.",
    );
    expect(proposal?.proposalReason).toContain(
      "Success metrics: No repeated proposal failures for 7 days",
    );
    expect(proposal?.idempotencyKey).toMatch(
      /^pm-goal-task:pm_goal_1:0:[a-f0-9]{16}$/,
    );
    expect(proposal?.riskFactors).toEqual(["Project goal risk level: low"]);
    expect(proposal?.evidenceRefs).toEqual([
      {
        kind: "validation_failure",
        ref: "quality-gate:proposal-tests",
        summary: "Proposal tests failed twice.",
      },
      {
        kind: "file",
        ref: "tests/taskTrackerProposals.test.ts",
      },
      {
        kind: "external_url",
        ref: "urn:project-manager:goal:pm_goal_1",
        summary: "Project Manager goal: Stabilize proposal workflow",
      },
      {
        kind: "external_url",
        ref: "urn:project-manager:analysis:pm_analysis_1",
        summary: "Project Manager analysis for goal pm_goal_1",
      },
      {
        kind: "external_url",
        ref: "urn:project-manager:run:pm_run_1",
        summary: "Project Manager run for goal pm_goal_1",
      },
      {
        kind: "file",
        ref: "tests/humanTaskApi.test.ts",
      },
    ]);
  });

  it("keeps idempotency keys stable and distinct across proposal drafts", () => {
    const proposals = buildProjectGoalTaskProposalInputs({
      goal: baseGoal(),
      config: {
        maxTaskProposalsPerGoal: 5,
        defaultAutonomyLevel: "proposal_only",
      },
    });
    const repeated = buildProjectGoalTaskProposalInputs({
      goal: baseGoal(),
      config: {
        maxTaskProposalsPerGoal: 5,
        defaultAutonomyLevel: "proposal_only",
      },
    });

    expect(proposals).toHaveLength(2);
    expect(repeated.map((proposal) => proposal.idempotencyKey)).toEqual(
      proposals.map((proposal) => proposal.idempotencyKey),
    );
    expect(new Set(proposals.map((proposal) => proposal.idempotencyKey)).size).toBe(2);
  });

  it("forces high-risk goals to proposal_only even when config allows auto execution", () => {
    const [proposal] = buildProjectGoalTaskProposalInputs({
      goal: baseGoal({ riskLevel: "high" }),
      config: {
        maxTaskProposalsPerGoal: 5,
        defaultAutonomyLevel: "auto_execute_low_risk",
      },
    });

    expect(proposal?.autonomyLevel).toBe("proposal_only");
    expect(proposal?.riskFactors).toEqual(["Project goal risk level: high"]);
  });
});
