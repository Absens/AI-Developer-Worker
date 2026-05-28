import { describe, expect, it } from "vitest";

import {
  DuplicateTaskProposalError,
  InMemoryTaskTrackerClient,
  ProposalPolicyError,
} from "../src/domain/taskTracker/index.js";
import type {
  ClaimTaskInput,
  ProposeTaskInput,
  TaskActor,
} from "../src/domain/taskTracker/index.js";

const human: TaskActor = {
  owner: "human",
  id: "reviewer-1",
};

const createClock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 3, 28, 10, tick++, 0));
};

const proposalInput = (
  overrides: Partial<ProposeTaskInput> = {},
): ProposeTaskInput => ({
  source: "ai_proposal",
  proposedBy: "worker-1",
  repositoryName: "developer",
  title: "Document retry behavior",
  description: "Add missing documentation for worker retry behavior.",
  proposalReason: "Repeated review comments ask for retry behavior details.",
  evidenceRefs: [
    {
      kind: "review_comment",
      ref: "gitlab://project/1/mr/7#note-12",
      summary: "Reviewer asked for retry docs twice.",
    },
  ],
  suggestedAcceptanceCriteria: ["Retry behavior is documented."],
  taskType: "documentation",
  autonomyLevel: "proposal_only",
  ...overrides,
});

const claimInput = (overrides: Partial<ClaimTaskInput> = {}): ClaimTaskInput => ({
  workerId: "worker-1",
  repositoryProfiles: [
    { name: "developer", repoPathKey: "developer", queues: ["AI_PROPOSALS"] },
  ],
  leaseTtlSeconds: 60,
  ...overrides,
});

describe("Phase 7G AI task proposals", () => {
  it("creates proposed tasks with evidence and keeps them out of the claim queue", async () => {
    const tracker = new InMemoryTaskTrackerClient({ now: createClock() });

    const task = await tracker.proposeTask(proposalInput());
    const claim = await tracker.claimNextTask(claimInput());

    expect(task.status).toBe("triage");
    expect(task.proposal).toMatchObject({
      supervisorStatus: "proposed",
      evidenceRefs: proposalInput().evidenceRefs,
      policyEvaluation: { decision: "requires_approval" },
    });
    expect(task.artifacts).toEqual([
      expect.objectContaining({ kind: "proposal_evidence", retentionClass: "audit" }),
    ]);
    expect(claim).toBeNull();
    expect(task.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "proposal_policy_decision" }),
      ]),
    );
  });

  it("does not claim a proposed task even if its task status was marked ready", async () => {
    const tracker = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await tracker.proposeTask(proposalInput());

    await tracker.markReady(task.id, "Manual status edit before proposal approval.");
    const claim = await tracker.claimNextTask(claimInput());

    expect(claim).toBeNull();
    await expect(tracker.getTask(task.id)).resolves.toMatchObject({
      status: "ready",
      proposal: { supervisorStatus: "proposed" },
    });
  });

  it("approves a proposal into the executable path and audits the decision", async () => {
    const tracker = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await tracker.proposeTask(proposalInput());

    await tracker.approveProposal(task.id, {
      actor: human,
      reason: "Looks safe.",
    });
    const approved = await tracker.getTask(task.id);
    const claim = await tracker.claimNextTask(claimInput());

    expect(approved.status).toBe("ready");
    expect(approved.proposal?.supervisorStatus).toBe("approved");
    expect(claim?.task.id).toBe(task.id);
    expect(approved.decisions.filter((decision) => decision.kind === "policy")).toHaveLength(2);
    expect(approved.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "task_proposal_approved" }),
        expect.objectContaining({ kind: "proposal_policy_decision" }),
      ]),
    );
  });

  it("rejects a proposal and prevents execution", async () => {
    const tracker = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await tracker.proposeTask(
      proposalInput({ title: "Add flaky test quarantine note" }),
    );

    await tracker.rejectProposal(task.id, {
      actor: human,
      reason: "Not useful enough.",
    });

    const rejected = await tracker.getTask(task.id);
    expect(rejected.status).toBe("cancelled");
    expect(rejected.proposal?.supervisorStatus).toBe("rejected");
    expect(await tracker.claimNextTask(claimInput())).toBeNull();
    expect(rejected.decisions.filter((decision) => decision.kind === "policy")).toHaveLength(2);
  });

  it("blocks proposals when the global kill switch is disabled", async () => {
    const tracker = new InMemoryTaskTrackerClient({
      autonomyPolicy: { aiProposalsEnabled: false },
    });

    await expect(tracker.proposeTask(proposalInput())).rejects.toThrow(
      ProposalPolicyError,
    );
  });

  it("blocks duplicate non-terminal proposals by title or evidence", async () => {
    const tracker = new InMemoryTaskTrackerClient({ now: createClock() });
    await tracker.proposeTask(proposalInput());

    await expect(
      tracker.proposeTask(
        proposalInput({
          description: "Different wording but same title.",
          evidenceRefs: [{ kind: "metric", ref: "review-retry-docs" }],
        }),
      ),
    ).rejects.toThrow(DuplicateTaskProposalError);

    await expect(
      tracker.proposeTask(
        proposalInput({
          title: "Different title",
          evidenceRefs: proposalInput().evidenceRefs,
        }),
      ),
    ).rejects.toThrow(DuplicateTaskProposalError);
  });

  it("auto-approves only low-risk proposals allowed by explicit repository policy", async () => {
    const tracker = new InMemoryTaskTrackerClient({
      now: createClock(),
      autonomyPolicy: {
        autoExecuteLowRiskEnabled: true,
        repositories: {
          developer: {
            autoExecuteLowRiskEnabled: true,
            allowedTaskTypes: ["documentation", "tests_only"],
            dailyProposalLimit: 10,
            windowProposalLimit: 10,
          },
        },
      },
    });

    const autoApproved = await tracker.proposeTask(
      proposalInput({ autonomyLevel: "auto_execute_low_risk" }),
    );
    const highRisk = await tracker.proposeTask(
      proposalInput({
        title: "Document authentication retry behavior",
        autonomyLevel: "auto_execute_low_risk",
        riskFactors: ["authentication-sensitive behavior"],
        evidenceRefs: [{ kind: "metric", ref: "auth-doc-gap" }],
      }),
    );

    expect(autoApproved.status).toBe("ready");
    expect(autoApproved.proposal?.supervisorStatus).toBe("auto_approved");
    expect(autoApproved.proposal?.policyEvaluation.decision).toBe("auto_approved");
    expect(highRisk.status).toBe("triage");
    expect(highRisk.proposal?.supervisorStatus).toBe("proposed");
    expect(highRisk.proposal?.policyEvaluation.reason).toMatch(/High-risk/);
  });
});
