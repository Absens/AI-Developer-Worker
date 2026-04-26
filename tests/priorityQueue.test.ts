import { describe, expect, it } from "vitest";

import {
  confidenceScoreFromComments,
  scoreAndSortCandidates,
  scoreCandidate,
} from "../src/domain/priorityQueue.js";
import {
  formatAnalysisComment,
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
import type {
  PriorityQueueConfig,
  RepositoryProfile,
  TrackerIssue,
} from "../src/models/types.js";

const config: PriorityQueueConfig = {
  manualOverrideTags: ["ai_priority"],
  priorityWeights: {
    blocker: 1000,
    critical: 700,
    high: 400,
    normal: 100,
    low: 0,
  },
  tagBoosts: {
    urgent: 250,
    low_risk: 50,
  },
  componentBoosts: {
    payments: 300,
  },
  deadlineBoost: {
    dueToday: 300,
    overdue: 600,
  },
  createdAtTieBreaker: "oldest",
};

const repository: RepositoryProfile = {
  name: "frontend",
  repoPath: "/workspace/frontend",
  gitlabProjectId: "1",
  gitRemoteName: "origin",
  baseBranch: "main",
  queues: ["FRONTEND"],
  tags: ["ai_dev"],
  testCommand: "npm test",
  lintCommand: "npm run lint",
};

const issue = (overrides: Partial<TrackerIssue>): TrackerIssue => ({
  id: overrides.key ?? "1",
  key: overrides.key ?? "FRONTEND-1",
  title: "Task",
  description: "Task description",
  createdAt: "2026-04-20T10:00:00.000Z",
  logicalStatus: "open",
  ...overrides,
});

describe("priority queue", () => {
  it("lets higher Tracker priority beat older low-priority tasks", () => {
    const sorted = scoreAndSortCandidates(
      [
        {
          issue: issue({
            key: "FRONTEND-1",
            priority: "low",
            createdAt: "2026-04-01T10:00:00.000Z",
          }),
          repository,
        },
        {
          issue: issue({
            key: "FRONTEND-2",
            priority: "high",
            createdAt: "2026-04-10T10:00:00.000Z",
          }),
          repository,
        },
      ],
      config,
      new Date("2026-04-26T10:00:00.000Z"),
    );

    expect(sorted[0]?.issue.key).toBe("FRONTEND-2");
  });

  it("gives manual override tags the highest boost", () => {
    const manual = scoreCandidate(
      issue({ priority: "low", tags: ["ai_dev", "ai_priority"] }),
      config,
      { now: new Date("2026-04-26T10:00:00.000Z") },
    );
    const blocker = scoreCandidate(issue({ priority: "blocker" }), config, {
      now: new Date("2026-04-26T10:00:00.000Z"),
    });

    expect(manual.total).toBeGreaterThan(blocker.total);
  });

  it("adds deadline, tag, and component boosts without crashing on missing fields", () => {
    expect(
      scoreCandidate(issue({}), config, {
        now: new Date("2026-04-26T10:00:00.000Z"),
      }).total,
    ).toBe(0);

    const scored = scoreCandidate(
      issue({
        priority: "normal",
        deadline: "2026-04-25",
        tags: ["urgent"],
        components: ["payments"],
      }),
      config,
      { now: new Date("2026-04-26T10:00:00.000Z") },
    );

    expect(scored).toMatchObject({
      priority: 100,
      deadline: 600,
      tags: 250,
      components: 300,
      total: 1250,
    });
  });

  it("uses deterministic oldest-created tie breaking", () => {
    const sorted = scoreAndSortCandidates(
      [
        {
          issue: issue({
            key: "FRONTEND-2",
            priority: "normal",
            createdAt: "2026-04-20T10:00:00.000Z",
          }),
          repository,
        },
        {
          issue: issue({
            key: "FRONTEND-1",
            priority: "normal",
            createdAt: "2026-04-19T10:00:00.000Z",
          }),
          repository,
        },
      ],
      config,
      new Date("2026-04-26T10:00:00.000Z"),
    );

    expect(sorted.map((candidate) => candidate.issue.key)).toEqual([
      "FRONTEND-1",
      "FRONTEND-2",
    ]);
  });

  it("adds stored analysis confidence into candidate ordering", () => {
    const highConfidence = formatAnalysisComment("worker-1", "FRONTEND-2", {
      confidence: 90,
      taskType: "unknown",
      recommendedMode: "implement",
      promptProfileId: "general",
      expectedFiles: [],
      expectedSubsystems: [],
      riskFactors: [],
      missingContext: [],
      reasoning: "Clear task.",
    });
    const sorted = scoreAndSortCandidates(
      [
        {
          issue: issue({ key: "FRONTEND-1", priority: "normal" }),
          repository,
        },
        {
          issue: issue({ key: "FRONTEND-2", priority: "normal" }),
          repository,
          comments: [
            {
              id: "1",
              text: highConfidence,
              createdAt: "2026-04-26T10:00:00.000Z",
              isSystem: false,
              metadata: parseServiceComment(highConfidence),
            },
          ],
        },
      ],
      { ...config, confidencePriorityWeight: 2 },
      new Date("2026-04-26T10:00:00.000Z"),
    );

    expect(sorted[0]?.issue.key).toBe("FRONTEND-2");
    expect(
      confidenceScoreFromComments(
        issue({ key: "FRONTEND-2" }),
        [
          {
            id: "1",
            text: highConfidence,
            createdAt: "2026-04-26T10:00:00.000Z",
            isSystem: false,
            metadata: parseServiceComment(highConfidence),
          },
        ],
        { ...config, confidencePriorityWeight: 2 },
      ),
    ).toBe(180);
  });
});
