import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildRepositoryRuntimeConfig, loadConfig, loadFleetConfig } from "../src/config.js";
import { InternalWorkerOrchestrator } from "../src/domain/internalWorkerOrchestrator.js";
import {
  qualityGatesPassed,
  runQualityGates,
  type QualityGateCommandRunner,
} from "../src/domain/qualityGates.js";
import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/index.js";
import type {
  AppConfig,
  CodexRunner,
  GitLabService,
  GitService,
  MergeRequestInfo,
  QualityGateResult,
} from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const directories: string[] = [];
const succeed = 'node -e "process.exit(0)"';
const fail = 'node -e "process.exit(1)"';
const taskId = "validation-recovery";

const createDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "reliable-validation-"));
  directories.push(directory);
  return directory;
};

const environment = (directory: string): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  TASK_TRACKER_PROVIDER: "internal",
  TASK_TRACKER_STORAGE: "memory",
  TASK_TRACKER_LOCAL_SMOKE: "true",
  TASK_INTAKE_MODE: "standalone",
  YANDEX_SYNC_ENABLED: "false",
  LOCK_BACKEND: "none",
  TRACKER_TOKEN: "test-tracker-token",
  TRACKER_ORG_ID: "test-org",
  TRACKER_STATUS_MAP_FILE: resolve("config/trackerStatusMap.example.json"),
  TRACKER_DEFAULT_QUEUE: "DEV",
  TRACKER_IMAGE_CONTEXT_ENABLED: "false",
  GITLAB_URL: "https://gitlab.example.test",
  GITLAB_TOKEN: "test-gitlab-token",
  GITLAB_PROJECT_ID: "1",
  REPO_PATH: directory,
  CODEX_SANDBOX: "workspace-write",
  WORKER_ID: "validation-test-worker",
  MAX_FIX_ATTEMPTS: "1",
  TEST_COMMAND: succeed,
  LINT_COMMAND: succeed,
});

const configFor = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...loadConfig(environment(createDirectory())),
  ...overrides,
});

const successfulRunner: QualityGateCommandRunner = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
});

const passingResults = async (): Promise<QualityGateResult[]> => {
  const config = configFor();
  return runQualityGates(config, { cwd: config.repoPath, commandRunner: successfulRunner });
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("fail-closed quality gates", () => {
  it.each([
    ["lint", "lintCommand"],
    ["tests", "testCommand"],
  ] as const)("fails when required %s has no command", async (id, key) => {
    const config = configFor({ [key]: "" });
    const results = await runQualityGates(config, {
      cwd: config.repoPath,
      commandRunner: successfulRunner,
    });
    expect(results.find((result) => result.id === id)?.status).toBe("failed");
    expect(qualityGatesPassed(results)).toBe(false);
  });

  it.each([
    ["lint", "lintCommand"],
    ["tests", "testCommand"],
  ] as const)("rejects whitespace-only required %s without running that command", async (id, key) => {
    const executed: string[] = [];
    const config = configFor({ [key]: " \t\n " });
    const results = await runQualityGates(config, {
      cwd: config.repoPath,
      commandRunner: async (command) => {
        executed.push(command);
        return successfulRunner(command, { cwd: config.repoPath });
      },
    });
    expect(results.find((result) => result.id === id)?.status).toBe("failed");
    expect(executed.every((command) => command.trim().length > 0)).toBe(true);
    expect(qualityGatesPassed(results)).toBe(false);
  });

  it("does not run later commands after a missing required gate", async () => {
    const executed: string[] = [];
    const config = configFor({ lintCommand: "", buildCommand: "build-command" });
    const results = await runQualityGates(config, {
      cwd: config.repoPath,
      commandRunner: async (command) => {
        executed.push(command);
        return successfulRunner(command, { cwd: config.repoPath });
      },
    });
    expect(executed).toEqual([]);
    expect(results.find((result) => result.id === "tests")?.diagnostic).toContain("blocked by");
    expect(results.find((result) => result.id === "build")?.status).toBe("skipped");
    expect(qualityGatesPassed(results)).toBe(false);
  });

  it("still permits genuinely unconfigured optional gates", async () => {
    const results = await passingResults();
    expect(results.find((result) => result.id === "build")?.status).toBe("skipped");
    expect(qualityGatesPassed(results)).toBe(true);
  });

  it("does not accept an empty validation result", () => {
    expect(qualityGatesPassed([])).toBe(false);
  });

  it.each(["lint", "tests"])("rejects results without the required %s evidence", async (id) => {
    const results = (await passingResults()).filter((result) => result.id !== id);
    expect(qualityGatesPassed(results)).toBe(false);
  });

  it.each(["lint", "tests"])("rejects skipped required %s evidence", async (id) => {
    const results = (await passingResults()).map((result): QualityGateResult =>
      result.id === id ? { ...result, status: "skipped" } : result,
    );
    expect(qualityGatesPassed(results)).toBe(false);
  });

  it.each(["lint", "tests"])("rejects duplicate required %s evidence", async (id) => {
    const results = await passingResults();
    const duplicate = results.find((result) => result.id === id);
    if (!duplicate) throw new Error(`Missing fixture gate ${id}`);
    expect(qualityGatesPassed([...results, duplicate])).toBe(false);
  });

  it("does not accept a configured optional gate that was skipped", async () => {
    const results = (await passingResults()).map((result): QualityGateResult =>
      result.id === "build" ? { ...result, command: "build-command" } : result,
    );
    expect(qualityGatesPassed(results)).toBe(false);
  });

  it("does not accept a timeout even if a runner reports exit code zero", async () => {
    const config = configFor();
    const results = await runQualityGates(config, {
      cwd: config.repoPath,
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: true }),
    });
    expect(results.find((result) => result.id === "lint")?.status).toBe("failed");
    expect(results.find((result) => result.id === "lint")?.diagnostic).toMatch(/timed out/i);
    expect(qualityGatesPassed(results)).toBe(false);
  });
});

const recoveredTask = async (overrides: Partial<AppConfig> = {}) => {
  const directory = createDirectory();
  const fleet = loadFleetConfig(environment(directory));
  const profile = fleet.repositories[0];
  if (!profile) throw new Error("Missing test repository profile");
  const config: AppConfig = {
    ...buildRepositoryRuntimeConfig(fleet, profile),
    maxFixAttempts: 0,
    ...overrides,
  };
  const branch = `feature/ai-task-${taskId}`;
  const mergeRequest: MergeRequestInfo = {
    id: 19,
    iid: 19,
    url: "https://gitlab.example.test/project/-/merge_requests/19",
    title: "Existing unverified MR",
    sourceBranch: branch,
    targetBranch: "main",
    state: "opened",
  };
  const writes: string[] = [];
  const git: GitService = {
    assertRepositoryReady: async () => {},
    getCurrentBranch: async () => branch,
    hasChanges: async () => false,
    hasDiffFromBase: async () => true,
    syncBaseBranch: async () => {},
    checkoutBranch: async (name) => name,
    checkoutTaskBranch: async () => branch,
    getDiffFromBase: async () => "diff --git a/code.ts b/code.ts",
    getChangedFilesFromBase: async () => ["code.ts"],
    getHeadSha: async () => "a".repeat(40),
    commit: async () => { writes.push("commit"); },
    push: async () => { writes.push("push"); },
  };
  const gitlab: GitLabService = {
    checkReadAccess: async () => {},
    checkMergeRequestWriteAccess: async () => { throw new Error("Unexpected write-access probe"); },
    findMergeRequestByBranch: async () => mergeRequest,
    getMergeRequest: async () => mergeRequest,
    findOpenMergeRequestByBranch: async () => mergeRequest,
    getMergeRequestDiscussions: async () => [],
    replyToDiscussion: async () => { writes.push("reply"); },
    getCurrentUser: async () => ({ username: "test-worker" }),
    createMergeRequest: async () => { throw new Error("Existing MR must not be duplicated"); },
  };
  const codex: CodexRunner = {
    runInitial: async () => ({
      process: { exitCode: 0, stdout: "", stderr: "" },
      finalMessage: "READY_FOR_IMPLEMENTATION",
      threadId: "test-thread",
    }),
    runFix: async () => { throw new Error("Fix budget is zero in this scenario"); },
    runResume: async () => { throw new Error("Fix budget is zero in this scenario"); },
    runReview: async () => { throw new Error("Independent review is outside this scenario"); },
  };
  const tracker = new InMemoryTaskTrackerClient();
  await tracker.createTask({
    id: taskId,
    title: "Recovered implementation",
    description: "Validate the existing committed change before declaring the MR ready.",
    createdBy: { owner: "human", id: "test-user" },
    repositoryName: profile.name,
    repoPathKey: profile.name,
    baseBranch: profile.baseBranch,
    queue: profile.queues[0] ?? "DEV",
    tags: profile.tags,
    status: "ready",
    taskType: "unknown",
    acceptanceCriteria: ["Current configured checks pass."],
  });
  const orchestrator = new InternalWorkerOrchestrator(
    fleet,
    [{ profile, config, git, gitlab, codex }],
    tracker,
    new Logger(),
  );
  return { directory, config, tracker, orchestrator, writes };
};

describe("existing MR recovery must validate current code", () => {
  it("runs real current checks and records validation before reusing an MR", async () => {
    const fixture = await recoveredTask();
    const marker = join(fixture.directory, "checks.txt");
    fixture.config.testCommand = `node -e "require('node:fs').writeFileSync('checks.txt', 'tests ran')"`;
    await fixture.orchestrator.runOnce();
    const task = await fixture.tracker.getTask(taskId);
    expect(task.status).toBe("review");
    expect(task.qualityGateRuns).toHaveLength(1);
    expect(task.qualityGateRuns[0]?.status).toBe("passed");
    expect(task.mergeRequests).toHaveLength(1);
    expect(task.mergeRequests[0]?.outcome).toBe("reused");
    expect(task.mergeRequests[0]?.validationSummary).toContain("Tests");
    expect(readFileSync(marker, "utf8")).toBe("tests ran");
    expect(task.agentRuns.some((run) => run.stage === "implementation")).toBe(false);
  });

  it.each(["lintCommand", "testCommand", "buildCommand"] as const)(
    "does not publish the existing MR when current %s fails",
    async (command) => {
      const fixture = await recoveredTask({ [command]: fail });
      await fixture.orchestrator.runOnce();
      const task = await fixture.tracker.getTask(taskId);
      expect(task.status).toBe("failed");
      expect(task.qualityGateRuns.at(-1)?.status).toBe("failed");
      expect(task.mergeRequests).toHaveLength(0);
      expect(fixture.writes).toEqual([]);
    },
  );

  it("does not trust a previous green result after validation configuration changes", async () => {
    const fixture = await recoveredTask({ testCommand: fail });
    await fixture.tracker.recordValidation(taskId, {
      workerId: "old-worker",
      status: "passed",
      validation: {
        changed: true,
        testsPassed: true,
        lintPassed: true,
        gates: await passingResults(),
        diagnostic: "",
      },
      summary: "Old checks passed before current configuration changed.",
    });
    await fixture.orchestrator.runOnce();
    const task = await fixture.tracker.getTask(taskId);
    expect(task.status).toBe("failed");
    expect(task.qualityGateRuns).toHaveLength(2);
    expect(task.qualityGateRuns.at(-1)?.status).toBe("failed");
    expect(task.mergeRequests).toHaveLength(0);
    expect(fixture.writes).toEqual([]);
  });
});
