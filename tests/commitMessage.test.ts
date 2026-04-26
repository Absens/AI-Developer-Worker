import { describe, expect, it } from "vitest";

import { buildCommitMessage } from "../src/domain/commitMessage.js";
import type { TrackerIssue } from "../src/models/types.js";

const issue = (overrides: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: "1",
  key: "DEV-1",
  title: "Add import workflow",
  description: "Implement the import workflow",
  ...overrides,
});

describe("buildCommitMessage", () => {
  it("uses a sanitized summary and appends the issue key", () => {
    expect(
      buildCommitMessage({
        issue: issue(),
        changedFiles: ["src/importer.ts"],
        summary: "Implemented `CSV` import.\n\n",
      }),
    ).toBe("feat: implemented CSV import DEV-1");
  });

  it("falls back when the summary is empty or generic", () => {
    expect(
      buildCommitMessage({
        issue: issue(),
        changedFiles: ["src/importer.ts"],
        summary: "Implementation complete",
      }),
    ).toBe("feat: implement DEV-1");
  });

  it("infers docs and fix commit types", () => {
    expect(
      buildCommitMessage({
        issue: issue({ title: "Document Docker setup" }),
        changedFiles: ["docs/LOCAL_DOCKER_RUN.md"],
        summary: "Update Docker runbook",
      }),
    ).toBe("docs: update Docker runbook DEV-1");

    expect(
      buildCommitMessage({
        issue: issue({ title: "Fix empty tracker comments" }),
        changedFiles: ["src/integrations/tracker/client.ts"],
        summary: "Handle empty comment payloads",
      }),
    ).toBe("fix: handle empty comment payloads DEV-1");
  });
});
