import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileMemoryStore } from "../src/domain/memoryStore.js";
import {
  buildPromptContextBundle,
  formatPromptContextBundle,
} from "../src/domain/promptContext.js";
import type { MemoryConfig, RepositoryKnowledgeBase } from "../src/models/types.js";

const cleanupPaths: string[] = [];

const createTempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "prompt-context-test-"));
  cleanupPaths.push(path);
  return path;
};

const memoryConfig = (dir: string): MemoryConfig => ({
  enabled: true,
  dir,
  maxContextChars: 300,
  strict: false,
  includeDraftRules: false,
  similarFailureLimit: 1,
  bootstrapOnStart: false,
  refreshOnPreflight: false,
  bootstrapCodexSandbox: "inherit",
});

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("prompt context", () => {
  it("retrieves approved context deterministically and respects the character budget", async () => {
    const dir = createTempDir();
    const store = new FileMemoryStore(memoryConfig(dir));
    const knowledge: RepositoryKnowledgeBase = {
      repositoryName: "client-application",
      schemaVersion: 1,
      updatedAt: "2026-04-27T00:00:00.000Z",
      architectureMap: [
        {
          id: "arch-ui",
          title: "UI architecture",
          body: "Feature screens live under src/pages and shared components live under src/components.",
          source: "manual",
          sourceRefs: ["README.md"],
          tags: ["ui"],
          taskTypes: ["frontend_ui_fix"],
          confidence: 90,
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      entryPoints: [],
      codePatterns: [],
      testStrategy: [],
      knownPitfalls: [],
      conventions: [],
    };
    await store.saveKnowledge(knowledge);
    writeFileSync(
      join(dir, "repositories", "client-application", "prompt-rules.json"),
      JSON.stringify([
        {
          id: "rule-approved",
          repositoryName: "client-application",
          title: "Keep UI tests focused",
          instruction: "When changing UI, update focused component tests first.",
          taskTypes: ["frontend_ui_fix"],
          promptProfileIds: ["frontend_ui_fix"],
          sourceEntryIds: [],
          confidence: 85,
          approvalState: "approved",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
        {
          id: "rule-draft",
          repositoryName: "client-application",
          title: "Draft",
          instruction: "Draft rules stay out by default.",
          taskTypes: ["frontend_ui_fix"],
          promptProfileIds: ["frontend_ui_fix"],
          sourceEntryIds: [],
          confidence: 50,
          approvalState: "draft",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
      ]),
      "utf8",
    );
    await store.appendFailure({
      repositoryName: "client-application",
      issueKey: "DEV-1",
      taskType: "frontend_ui_fix",
      promptProfileId: "frontend_ui_fix",
      failureKind: "validation_exhausted",
      diagnosticSummary: "Snapshot test failed after changing Button.",
      affectedFiles: ["src/Button.tsx"],
      tags: ["ui"],
      createdAt: "2026-04-27T00:01:00.000Z",
    });
    await store.appendFailure({
      repositoryName: "client-application",
      issueKey: "DEV-2",
      taskType: "documentation",
      promptProfileId: "documentation",
      failureKind: "validation_exhausted",
      diagnosticSummary: "Docs lint failed.",
      affectedFiles: ["README.md"],
      tags: ["docs"],
      createdAt: "2026-04-27T00:02:00.000Z",
    });

    const bundle = await buildPromptContextBundle({
      store,
      repositoryName: "client-application",
      taskType: "frontend_ui_fix",
      promptProfileId: "frontend_ui_fix",
      expectedFiles: ["src/Button.tsx"],
      tags: ["ui"],
      contextBudgetChars: 300,
      includeDraftRules: false,
      similarFailureLimit: 1,
    });
    const formatted = formatPromptContextBundle(bundle);

    expect(bundle.promptRules.map((rule) => rule.id)).toEqual(["rule-approved"]);
    expect(bundle.knowledgeSections.map((section) => section.id)).toEqual(["arch-ui"]);
    expect(bundle.similarFailures.map((failure) => failure.issueKey)).toEqual(["DEV-1"]);
    expect(formatted).toContain("Repository context:");
    expect(formatted).not.toContain("rule-draft");
    expect(formatted.length).toBeLessThanOrEqual(300);
    expect(formatPromptContextBundle(bundle)).toBe(formatted);
  });
});
