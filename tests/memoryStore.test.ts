import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileMemoryStore } from "../src/domain/memoryStore.js";
import type {
  FailureMemoryEntry,
  MemoryConfig,
  RepositoryKnowledgeBase,
} from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const cleanupPaths: string[] = [];

const createTempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "memory-store-test-"));
  cleanupPaths.push(path);
  return path;
};

const memoryConfig = (dir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig => ({
  enabled: true,
  dir,
  maxContextChars: 6000,
  strict: false,
  includeDraftRules: false,
  similarFailureLimit: 3,
  bootstrapOnStart: false,
  refreshOnPreflight: false,
  bootstrapCodexSandbox: "inherit",
  ...overrides,
});

class TestLogger extends Logger {
  readonly warnings: unknown[] = [];

  override warn(message: string, context?: unknown): void {
    this.warnings.push({ message, context });
  }
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("FileMemoryStore", () => {
  it("creates default per-repository files in an empty memory store", async () => {
    const dir = createTempDir();
    const store = new FileMemoryStore(memoryConfig(dir));

    const knowledge = await store.loadKnowledge("Client Application");

    expect(knowledge.repositoryName).toBe("Client Application");
    expect(knowledge.architectureMap).toEqual([]);
    expect(
      existsSync(join(dir, "repositories", "client-application", "knowledge.json")),
    ).toBe(true);
    expect(
      existsSync(join(dir, "repositories", "client-application", "prompt-rules.json")),
    ).toBe(true);
    expect(
      existsSync(join(dir, "repositories", "client-application", "metadata.json")),
    ).toBe(true);
  });

  it("saves valid knowledge and appends failure entries", async () => {
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
          body: "Feature screens live under src/pages.",
          source: "manual",
          sourceRefs: ["docs/README.md"],
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
    const failure: FailureMemoryEntry = {
      repositoryName: "client-application",
      issueKey: "DEV-1",
      taskType: "frontend_ui_fix",
      promptProfileId: "frontend_ui_fix",
      failureKind: "validation_exhausted",
      diagnosticSummary: "Tests failed.",
      affectedFiles: ["src/Button.tsx"],
      tags: ["ui"],
      createdAt: "2026-04-27T00:01:00.000Z",
    };

    await store.saveKnowledge(knowledge);
    await store.appendFailure(failure);

    await expect(store.loadKnowledge("client-application")).resolves.toMatchObject({
      architectureMap: [expect.objectContaining({ id: "arch-ui" })],
    });
    await expect(store.loadFailures("client-application")).resolves.toEqual([failure]);
  });

  it("disables a repository memory in fail-open mode when a file is corrupted", async () => {
    const dir = createTempDir();
    const logger = new TestLogger();
    const store = new FileMemoryStore(memoryConfig(dir), logger);
    await store.ensureRepository("client-application");
    writeFileSync(
      join(dir, "repositories", "client-application", "knowledge.json"),
      "{not-json",
      "utf8",
    );

    const knowledge = await store.loadKnowledge("client-application");
    await store.appendFailure({
      repositoryName: "client-application",
      issueKey: "DEV-1",
      taskType: "unknown",
      promptProfileId: "general",
      failureKind: "validation_exhausted",
      diagnosticSummary: "Should be skipped.",
      affectedFiles: [],
      tags: [],
      createdAt: "2026-04-27T00:01:00.000Z",
    });

    expect(knowledge.architectureMap).toEqual([]);
    expect(logger.warnings).toHaveLength(1);
    expect(
      readFileSync(
        join(dir, "repositories", "client-application", "failures.jsonl"),
        "utf8",
      ),
    ).toBe("");
  });

  it("throws on corrupted memory when strict mode is enabled", async () => {
    const dir = createTempDir();
    const store = new FileMemoryStore(memoryConfig(dir, { strict: true }));
    await store.ensureRepository("client-application");
    writeFileSync(
      join(dir, "repositories", "client-application", "knowledge.json"),
      "{not-json",
      "utf8",
    );

    await expect(store.loadKnowledge("client-application")).rejects.toThrow(
      /Invalid memory file/,
    );
  });
});
