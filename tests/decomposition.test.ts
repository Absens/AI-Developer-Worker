import { describe, expect, it } from "vitest";

import {
  formatSubtaskDescription,
  parseDecompositionPlan,
} from "../src/domain/decomposition.js";

describe("decomposition parsing", () => {
  it("parses a valid AI_DECOMPOSITION plan", () => {
    const plan = parseDecompositionPlan(
      'AI_DECOMPOSITION: {"parentIssueKey":"DEV-1","summary":"Split the epic.","subtasks":[{"temporaryId":"api","title":"Build API","description":"Create endpoint.","queue":"BACKEND","tags":["ai_dev"],"acceptanceCriteria":["Endpoint returns 200"],"recommendedPromptProfileId":"backend_endpoint"},{"temporaryId":"ui","title":"Build UI","description":"Create screen.","tags":["ai_dev"],"acceptanceCriteria":["Screen renders"],"recommendedPromptProfileId":"frontend_ui_fix"}],"dependencies":[{"blockedTaskTemporaryId":"ui","blockingTaskTemporaryId":"api","reason":"UI needs API."}],"risks":["Integration risk"]}',
      { parentIssueKey: "DEV-1", maxSubtasks: 8 },
    );

    expect(plan?.subtasks).toHaveLength(2);
    expect(plan?.dependencies[0]).toMatchObject({
      blockedTaskTemporaryId: "ui",
      blockingTaskTemporaryId: "api",
    });
  });

  it("rejects plans over the configured subtask limit", () => {
    const plan = parseDecompositionPlan(
      'AI_DECOMPOSITION: {"parentIssueKey":"DEV-1","summary":"Too much.","subtasks":[{"temporaryId":"a","title":"A","description":"A","tags":[],"acceptanceCriteria":[],"recommendedPromptProfileId":"general"},{"temporaryId":"b","title":"B","description":"B","tags":[],"acceptanceCriteria":[],"recommendedPromptProfileId":"general"}],"dependencies":[],"risks":[]}',
      { parentIssueKey: "DEV-1", maxSubtasks: 1 },
    );

    expect(plan).toBeUndefined();
  });

  it("formats acceptance criteria and textual dependencies for sub-issues", () => {
    expect(
      formatSubtaskDescription(
        "DEV-1",
        {
          temporaryId: "ui",
          title: "Build UI",
          description: "Create screen.",
          tags: ["ai_dev"],
          acceptanceCriteria: ["Screen renders"],
          recommendedPromptProfileId: "frontend_ui_fix",
        },
        { dependencyNotes: ["Blocked by DEV-2: UI needs API."] },
      ),
    ).toContain("Blocked by DEV-2");
  });
});
