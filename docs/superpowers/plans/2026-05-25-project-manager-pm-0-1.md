# Project Manager PM-0/PM-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the disabled-by-default Project Manager Agent foundation: config, read-only project signal collection, project-analysis prompt/parser, in-memory analysis/run storage, and a read-only orchestrator that cannot create tasks.

**Architecture:** Add a separate `src/domain/projectManager/` bounded context and keep execution isolated from `InternalWorkerOrchestrator`. Phase PM-0/PM-1 must not call `TaskTrackerClient.proposeTask`, `createTask`, `markReady`, or any Git/GitLab write path. It should only read `TaskTrackerClient` state, call Codex for `PROJECT_ANALYSIS`, validate the response, and store analysis/run records in an in-memory PM store for later PM-2 persistence.

**Tech Stack:** TypeScript ES modules, Vitest, existing `CodexRunner`, existing internal `TaskTrackerClient`, existing config parser in `src/config.ts`.

---

## Scope

This plan implements only PM-0 and PM-1 from [docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md](../../PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md):

- PM domain contracts and guardrails.
- Disabled-by-default PM config.
- Read-only project signal snapshot.
- `PROJECT_ANALYSIS:` prompt and parser.
- `ProjectManagerOrchestrator.runAnalysisOnce(repositoryName)`.
- In-memory analysis/run storage for tests and future wiring.

Out of scope for this plan:

- PostgreSQL PM tables.
- Goal approval lifecycle.
- Goal-to-task proposal fan-out.
- UI pages.
- Scheduling.
- Automatic task creation.
- App startup execution.

## File Structure

- Create `src/domain/projectManager/types.ts`: PM domain types, config types, statuses, and constants.
- Create `src/domain/projectManager/analysisParser.ts`: parser and validator for `PROJECT_ANALYSIS:` responses.
- Create `src/domain/projectManager/signalCollector.ts`: read-only snapshot builder over `TaskTrackerClient`.
- Create `src/domain/projectManager/promptBuilder.ts`: project analysis prompt.
- Create `src/domain/projectManager/store.ts`: in-memory PM analysis/run store.
- Create `src/domain/projectManager/orchestrator.ts`: read-only PM analysis workflow.
- Create `src/domain/projectManager/index.ts`: exports.
- Modify `src/models/types.ts`: re-export PM config/domain types and add PM config fields to `AppConfig`, `GlobalWorkerConfig`, and `RepositoryProfile`.
- Modify `src/config.ts`: parse PM env/fleet config and pass it into repository runtime config.
- Modify `docs/ENV_CONFIGURATION.md`: document PM config.
- Modify `.env.example`: add disabled PM defaults.
- Create tests:
  - `tests/projectManagerAnalysis.test.ts`
  - `tests/projectManagerSignals.test.ts`
  - `tests/projectManagerPrompt.test.ts`
  - `tests/projectManagerOrchestrator.test.ts`
- Modify `tests/config.test.ts`: PM config parsing coverage.

## Task 1: Project Manager Domain Types And Analysis Parser

**Files:**
- Create: `src/domain/projectManager/types.ts`
- Create: `src/domain/projectManager/analysisParser.ts`
- Create: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerAnalysis.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/projectManagerAnalysis.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  PROJECT_ANALYSIS_MARKER,
  parseProjectAnalysisResponse,
} from "../src/domain/projectManager/index.js";

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
    });
  });

  it("rejects responses without the marker", () => {
    expect(parseProjectAnalysisResponse("summary only")).toBeUndefined();
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
    });
  });
});
```

- [ ] **Step 2: Run parser tests and verify they fail**

Run:

```bash
npm test -- tests/projectManagerAnalysis.test.ts
```

Expected: fail with module resolution errors for `../src/domain/projectManager/index.js`.

- [ ] **Step 3: Implement PM domain types**

Create `src/domain/projectManager/types.ts`:

```typescript
import type { AutonomyLevel, TaskType } from "../../models/types.js";
import type { EvidenceRef } from "../taskTracker/types.js";

export const PROJECT_ANALYSIS_MARKER = "PROJECT_ANALYSIS:";

export const PROJECT_GOAL_STATUSES = [
  "proposed",
  "approved",
  "active",
  "completed",
  "rejected",
  "stale",
] as const;

export type ProjectGoalStatus = (typeof PROJECT_GOAL_STATUSES)[number];

export const PROJECT_GOAL_PRIORITIES = [
  "low",
  "normal",
  "high",
  "critical",
] as const;

export type ProjectGoalPriority = (typeof PROJECT_GOAL_PRIORITIES)[number];

export const PROJECT_GOAL_RISK_LEVELS = ["low", "medium", "high"] as const;

export type ProjectGoalRiskLevel = (typeof PROJECT_GOAL_RISK_LEVELS)[number];

export const PROJECT_HEALTH_SIGNAL_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type ProjectHealthSignalSeverity =
  (typeof PROJECT_HEALTH_SIGNAL_SEVERITIES)[number];

export const PROJECT_MANAGER_TRIGGERS = [
  "manual",
  "schedule",
  "post_task_event",
] as const;

export type ProjectManagerTrigger = (typeof PROJECT_MANAGER_TRIGGERS)[number];

export interface ProjectTaskProposalDraft {
  title: string;
  description: string;
  taskType: TaskType;
  acceptanceCriteria: string[];
  expectedBlastRadius?: string;
  evidenceRefs: EvidenceRef[];
}

export interface ProjectHealthSignal {
  kind: string;
  severity: ProjectHealthSignalSeverity;
  title: string;
  description: string;
  evidenceRefs: EvidenceRef[];
  recommendation?: string;
}

export interface ProjectGoalDraft {
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  successMetrics: string[];
  evidenceRefs: EvidenceRef[];
  priority: ProjectGoalPriority;
  riskLevel: ProjectGoalRiskLevel;
  suggestedTaskProposals: ProjectTaskProposalDraft[];
}

export interface ProjectAnalysis {
  id: string;
  repositoryName: string;
  summary: string;
  healthSignals: ProjectHealthSignal[];
  proposedGoals: ProjectGoalDraft[];
  staleGoalIds: string[];
  replanReason?: string;
  createdAt: string;
}

export interface ParsedProjectAnalysis {
  summary: string;
  healthSignals: ProjectHealthSignal[];
  proposedGoals: ProjectGoalDraft[];
  staleGoalIds: string[];
  replanReason?: string;
}

export interface ProjectManagerRun {
  id: string;
  repositoryName: string;
  trigger: ProjectManagerTrigger;
  status: "started" | "completed" | "failed";
  analysisId?: string;
  proposedGoalIds: string[];
  proposedTaskIds: string[];
  diagnostic?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ProjectManagerConfig {
  enabled: boolean;
  runOnce: boolean;
  intervalMinutes: number;
  maxGoalsPerRun: number;
  maxTaskProposalsPerGoal: number;
  defaultAutonomyLevel: AutonomyLevel;
  autoApproveLowRisk: boolean;
  allowedTaskTypes: TaskType[];
  repositoryScanEnabled: boolean;
  repositoryScanMaxFiles: number;
  requireHumanGoalApproval: boolean;
}

export interface RepositoryProjectManagerConfig {
  enabled?: boolean;
  focusAreas?: string[];
  allowedTaskTypes?: TaskType[];
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
}

export interface ProjectTaskSignal {
  id: string;
  title: string;
  status: string;
  repositoryName?: string;
  queue?: string;
  priority?: string;
  taskType?: string;
  updatedAt: string;
  latestAiSummary?: string;
  latestValidationSummary?: string;
  mergeRequestUrl?: string;
  blockerReason?: string;
  failedAgentRuns: number;
  failedValidations: number;
}

export interface ProjectSignalSnapshot {
  repositoryName: string;
  generatedAt: string;
  totalTasks: number;
  statusCounts: Record<string, number>;
  activeLeases: number;
  readyTasks: ProjectTaskSignal[];
  failedTasks: ProjectTaskSignal[];
  waitingForHuman: ProjectTaskSignal[];
  repeatedFailures: ProjectTaskSignal[];
  recentReviewTasks: ProjectTaskSignal[];
}
```

- [ ] **Step 4: Implement analysis parser**

Create `src/domain/projectManager/analysisParser.ts`:

```typescript
import type { EvidenceRef } from "../taskTracker/types.js";
import {
  PROJECT_ANALYSIS_MARKER,
  PROJECT_GOAL_PRIORITIES,
  PROJECT_GOAL_RISK_LEVELS,
  PROJECT_HEALTH_SIGNAL_SEVERITIES,
  type ParsedProjectAnalysis,
  type ProjectGoalPriority,
  type ProjectGoalRiskLevel,
  type ProjectHealthSignalSeverity,
} from "./types.js";
import type { TaskType } from "../../models/types.js";

const TASK_TYPES = new Set<TaskType>([
  "frontend_ui_fix",
  "backend_endpoint",
  "tests_only",
  "refactor",
  "dependency_update",
  "documentation",
  "unknown",
]);

const EVIDENCE_KINDS = new Set<EvidenceRef["kind"]>([
  "validation_failure",
  "review_comment",
  "ci_run",
  "security_finding",
  "memory_entry",
  "file",
  "metric",
  "external_url",
]);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((entry) => nonEmptyString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];

const evidenceRefs = (value: unknown): EvidenceRef[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: EvidenceRef[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const raw = entry as Record<string, unknown>;
    const kind = nonEmptyString(raw.kind) as EvidenceRef["kind"] | undefined;
    const ref = nonEmptyString(raw.ref);
    if (!kind || !EVIDENCE_KINDS.has(kind) || !ref) {
      return [];
    }
    refs.push({
      kind,
      ref,
      ...(nonEmptyString(raw.summary) ? { summary: nonEmptyString(raw.summary) } : {}),
    });
  }
  return refs;
};

const includesValue = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && values.includes(value as T);

const parseTaskProposalDrafts = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const proposals = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as Record<string, unknown>;
    const title = nonEmptyString(raw.title);
    const description = nonEmptyString(raw.description);
    const taskType = nonEmptyString(raw.taskType) as TaskType | undefined;
    if (!title || !description || !taskType || !TASK_TYPES.has(taskType)) {
      return undefined;
    }
    proposals.push({
      title,
      description,
      taskType,
      acceptanceCriteria: stringArray(raw.acceptanceCriteria),
      ...(nonEmptyString(raw.expectedBlastRadius)
        ? { expectedBlastRadius: nonEmptyString(raw.expectedBlastRadius) }
        : {}),
      evidenceRefs: evidenceRefs(raw.evidenceRefs),
    });
  }
  return proposals;
};

export const parseProjectAnalysisResponse = (
  message: string | undefined,
): ParsedProjectAnalysis | undefined => {
  const trimmed = message?.trim();
  if (!trimmed?.startsWith(PROJECT_ANALYSIS_MARKER)) {
    return undefined;
  }
  const payload = trimmed.slice(PROJECT_ANALYSIS_MARKER.length).trim();
  if (!payload.startsWith("{")) {
    return undefined;
  }
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const summary = nonEmptyString(raw.summary);
  if (!summary) {
    return undefined;
  }

  const healthSignals = [];
  for (const entry of Array.isArray(raw.healthSignals) ? raw.healthSignals : []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const signal = entry as Record<string, unknown>;
    const kind = nonEmptyString(signal.kind);
    const severity = signal.severity;
    const title = nonEmptyString(signal.title);
    const description = nonEmptyString(signal.description);
    if (
      !kind ||
      !includesValue<ProjectHealthSignalSeverity>(PROJECT_HEALTH_SIGNAL_SEVERITIES, severity) ||
      !title ||
      !description
    ) {
      return undefined;
    }
    healthSignals.push({
      kind,
      severity,
      title,
      description,
      evidenceRefs: evidenceRefs(signal.evidenceRefs),
      ...(nonEmptyString(signal.recommendation)
        ? { recommendation: nonEmptyString(signal.recommendation) }
        : {}),
    });
  }

  const proposedGoals = [];
  for (const entry of Array.isArray(raw.proposedGoals) ? raw.proposedGoals : []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const goal = entry as Record<string, unknown>;
    const title = nonEmptyString(goal.title);
    const problemStatement = nonEmptyString(goal.problemStatement);
    const desiredOutcome = nonEmptyString(goal.desiredOutcome);
    const priority = goal.priority;
    const riskLevel = goal.riskLevel;
    const suggestedTaskProposals = parseTaskProposalDrafts(goal.suggestedTaskProposals);
    if (
      !title ||
      !problemStatement ||
      !desiredOutcome ||
      !includesValue<ProjectGoalPriority>(PROJECT_GOAL_PRIORITIES, priority) ||
      !includesValue<ProjectGoalRiskLevel>(PROJECT_GOAL_RISK_LEVELS, riskLevel) ||
      !suggestedTaskProposals
    ) {
      return undefined;
    }
    proposedGoals.push({
      title,
      problemStatement,
      desiredOutcome,
      successMetrics: stringArray(goal.successMetrics),
      evidenceRefs: evidenceRefs(goal.evidenceRefs),
      priority,
      riskLevel,
      suggestedTaskProposals,
    });
  }

  return {
    summary,
    healthSignals,
    proposedGoals,
    staleGoalIds: stringArray(raw.staleGoalIds),
    ...(nonEmptyString(raw.replanReason) ? { replanReason: nonEmptyString(raw.replanReason) } : {}),
  };
};
```

- [ ] **Step 5: Export PM modules**

Create `src/domain/projectManager/index.ts`:

```typescript
export * from "./analysisParser.js";
export * from "./types.js";
```

- [ ] **Step 6: Run parser tests**

Run:

```bash
npm test -- tests/projectManagerAnalysis.test.ts
```

Expected: all tests in `projectManagerAnalysis.test.ts` pass.

- [ ] **Step 7: Commit task 1**

```bash
git add src/domain/projectManager/types.ts src/domain/projectManager/analysisParser.ts src/domain/projectManager/index.ts tests/projectManagerAnalysis.test.ts
git commit -m "feat: add project manager analysis contract"
```

## Task 2: Read-Only Project Signal Collector

**Files:**
- Create: `src/domain/projectManager/signalCollector.ts`
- Modify: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerSignals.test.ts`

- [ ] **Step 1: Write failing signal collector tests**

Create `tests/projectManagerSignals.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/index.js";
import type { CreateTaskInput, TaskActor } from "../src/domain/taskTracker/index.js";
import { collectProjectSignals } from "../src/domain/projectManager/index.js";

const human: TaskActor = { owner: "human", id: "user-1" };

const baseTaskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  title: "Improve proposal workflow",
  description: "Make proposal workflow easier to operate.",
  createdBy: human,
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  components: ["worker"],
  taskType: "tests_only",
  acceptanceCriteria: ["Regression coverage exists."],
  ...overrides,
});

describe("project manager signal collector", () => {
  it("collects read-only task health signals for one repository", async () => {
    const tracker = new InMemoryTaskTrackerClient({
      now: () => new Date("2026-05-25T10:00:00.000Z"),
    });
    const ready = await tracker.createTask(
      baseTaskInput({ id: "ready-task", status: "ready", priority: "high" }),
    );
    const failed = await tracker.createTask(
      baseTaskInput({ id: "failed-task", status: "ready", title: "Failed task" }),
    );
    await tracker.recordAgentRun(failed.id, {
      workerId: "worker-1",
      stage: "implementation",
      status: "failed",
      diagnostic: "Implementation failed.",
    });
    await tracker.recordValidation(failed.id, {
      workerId: "worker-1",
      status: "failed",
      validation: {
        changed: true,
        testsPassed: false,
        lintPassed: true,
        gates: [],
        diagnostic: "Unit test failed.",
      },
      summary: "Unit test failed.",
    });
    await tracker.recordValidation(failed.id, {
      workerId: "worker-1",
      status: "failed",
      validation: {
        changed: true,
        testsPassed: false,
        lintPassed: true,
        gates: [],
        diagnostic: "Unit test failed again.",
      },
      summary: "Unit test failed again.",
    });
    await tracker.setStatus(failed.id, "failed", "Exhausted fix attempts.");
    const waiting = await tracker.createTask(
      baseTaskInput({ id: "waiting-task", status: "ready", title: "Waiting task" }),
    );
    await tracker.setStatus(waiting.id, "awaiting_human", "Needs answer.");

    const snapshot = await collectProjectSignals({
      taskTracker: tracker,
      repositoryName: "developer",
      now: new Date("2026-05-25T10:30:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      repositoryName: "developer",
      generatedAt: "2026-05-25T10:30:00.000Z",
      totalTasks: 3,
      statusCounts: {
        ready: 1,
        failed: 1,
        awaiting_human: 1,
      },
    });
    expect(snapshot.readyTasks).toEqual([
      expect.objectContaining({ id: ready.id, priority: "high" }),
    ]);
    expect(snapshot.failedTasks).toEqual([
      expect.objectContaining({
        id: failed.id,
        failedAgentRuns: 1,
        failedValidations: 2,
        latestValidationSummary: "Unit test failed again.",
      }),
    ]);
    expect(snapshot.repeatedFailures).toEqual([
      expect.objectContaining({ id: failed.id, failedValidations: 2 }),
    ]);
    expect(snapshot.waitingForHuman).toEqual([
      expect.objectContaining({ id: waiting.id }),
    ]);
  });

  it("ignores tasks from other repositories", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    await tracker.createTask(baseTaskInput({ id: "local", repositoryName: "developer" }));
    await tracker.createTask(baseTaskInput({ id: "other", repositoryName: "other" }));

    const snapshot = await collectProjectSignals({
      taskTracker: tracker,
      repositoryName: "developer",
      now: new Date("2026-05-25T10:00:00.000Z"),
    });

    expect(snapshot.totalTasks).toBe(1);
    expect(snapshot.readyTasks.map((task) => task.id)).not.toContain("other");
  });
});
```

- [ ] **Step 2: Run signal tests and verify they fail**

Run:

```bash
npm test -- tests/projectManagerSignals.test.ts
```

Expected: fail because `collectProjectSignals` is not exported.

- [ ] **Step 3: Implement signal collector**

Create `src/domain/projectManager/signalCollector.ts`:

```typescript
import type {
  ProjectSignalSnapshot,
  ProjectTaskSignal,
} from "./types.js";
import type {
  TaskLeaseRecord,
  TaskRecord,
  TaskTrackerClient,
} from "../taskTracker/types.js";

const latestByCreatedAt = <T extends { createdAt: string }>(
  values: readonly T[],
): T | undefined =>
  [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

const latestAgentSummary = (task: TaskRecord): string | undefined => {
  const latest = [...task.agentRuns].sort((left, right) =>
    (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt),
  )[0];
  return latest?.finalMessage ?? latest?.diagnostic;
};

const openQuestionSummary = (task: TaskRecord): string | undefined =>
  [...task.clarificationQuestions]
    .reverse()
    .find((question) => question.status === "open")?.question.blockingReason;

const taskSignal = (task: TaskRecord): ProjectTaskSignal => {
  const latestValidation = latestByCreatedAt(task.qualityGateRuns);
  const latestMr = latestByCreatedAt(task.mergeRequests);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.repositoryName ? { repositoryName: task.repositoryName } : {}),
    ...(task.queue ? { queue: task.queue } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
    taskType: task.taskType,
    updatedAt: task.updatedAt,
    ...(latestAgentSummary(task) ? { latestAiSummary: latestAgentSummary(task) } : {}),
    ...(latestValidation?.summary ?? latestValidation?.diagnostic
      ? { latestValidationSummary: latestValidation.summary ?? latestValidation.diagnostic }
      : {}),
    ...(latestMr?.mergeRequest.url ? { mergeRequestUrl: latestMr.mergeRequest.url } : {}),
    ...(openQuestionSummary(task) ? { blockerReason: openQuestionSummary(task) } : {}),
    failedAgentRuns: task.agentRuns.filter((run) => run.status === "failed").length,
    failedValidations: task.qualityGateRuns.filter((run) => run.status === "failed").length,
  };
};

const countStatuses = (tasks: readonly TaskRecord[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
};

const activeRepositoryLeases = (
  leases: readonly TaskLeaseRecord[],
  repositoryName: string,
): number =>
  leases.filter(
    (lease) =>
      !lease.releasedAt &&
      lease.repositoryName === repositoryName &&
      Date.parse(lease.expiresAt) > Date.now(),
  ).length;

export const collectProjectSignals = async (input: {
  taskTracker: TaskTrackerClient;
  repositoryName: string;
  now?: Date;
  limit?: number;
}): Promise<ProjectSignalSnapshot> => {
  const now = input.now ?? new Date();
  const [tasks, leases] = await Promise.all([
    input.taskTracker.listTasks({
      repositoryName: input.repositoryName,
      limit: input.limit ?? 500,
    }),
    input.taskTracker.listActiveLeases(),
  ]);
  const sorted = [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const signals = sorted.map(taskSignal);

  return {
    repositoryName: input.repositoryName,
    generatedAt: now.toISOString(),
    totalTasks: tasks.length,
    statusCounts: countStatuses(tasks),
    activeLeases: activeRepositoryLeases(leases, input.repositoryName),
    readyTasks: signals.filter((task) => task.status === "ready"),
    failedTasks: signals.filter((task) => task.status === "failed"),
    waitingForHuman: signals.filter((task) => task.status === "awaiting_human"),
    repeatedFailures: signals.filter(
      (task) => task.failedAgentRuns > 1 || task.failedValidations > 1,
    ),
    recentReviewTasks: signals.filter(
      (task) => task.status === "review" || task.status === "human_testing",
    ),
  };
};
```

- [ ] **Step 4: Export signal collector**

Modify `src/domain/projectManager/index.ts`:

```typescript
export * from "./analysisParser.js";
export * from "./signalCollector.js";
export * from "./types.js";
```

- [ ] **Step 5: Run signal tests**

Run:

```bash
npm test -- tests/projectManagerSignals.test.ts
```

Expected: all tests in `projectManagerSignals.test.ts` pass.

- [ ] **Step 6: Commit task 2**

```bash
git add src/domain/projectManager/signalCollector.ts src/domain/projectManager/index.ts tests/projectManagerSignals.test.ts
git commit -m "feat: collect project manager signals"
```

## Task 3: Project Analysis Prompt Builder

**Files:**
- Create: `src/domain/projectManager/promptBuilder.ts`
- Modify: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerPrompt.test.ts`

- [ ] **Step 1: Write failing prompt tests**

Create `tests/projectManagerPrompt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  buildProjectAnalysisPrompt,
  PROJECT_ANALYSIS_MARKER,
  type ProjectSignalSnapshot,
} from "../src/domain/projectManager/index.js";

const snapshot: ProjectSignalSnapshot = {
  repositoryName: "developer",
  generatedAt: "2026-05-25T10:00:00.000Z",
  totalTasks: 2,
  statusCounts: { ready: 1, failed: 1 },
  activeLeases: 0,
  readyTasks: [
    {
      id: "ready-task",
      title: "Add docs",
      status: "ready",
      updatedAt: "2026-05-25T09:00:00.000Z",
      failedAgentRuns: 0,
      failedValidations: 0,
    },
  ],
  failedTasks: [
    {
      id: "failed-task",
      title: "Fix tests",
      status: "failed",
      updatedAt: "2026-05-25T09:30:00.000Z",
      latestValidationSummary: "Unit test failed.",
      failedAgentRuns: 1,
      failedValidations: 2,
    },
  ],
  waitingForHuman: [],
  repeatedFailures: [],
  recentReviewTasks: [],
};

describe("project manager prompt builder", () => {
  it("builds an analysis-only prompt with guardrails", () => {
    const prompt = buildProjectAnalysisPrompt({
      snapshot,
      maxGoalsPerRun: 3,
      maxTaskProposalsPerGoal: 2,
      allowedTaskTypes: ["documentation", "tests_only"],
      focusAreas: ["test coverage"],
    });

    expect(prompt).toContain("Mode: project-management-analysis-only");
    expect(prompt).toContain(`Reply with exactly one line starting with ${PROJECT_ANALYSIS_MARKER}`);
    expect(prompt).toContain("Do not create executable tasks directly.");
    expect(prompt).toContain("documentation, tests_only");
    expect(prompt).toContain("\"repositoryName\":\"developer\"");
    expect(prompt).toContain("\"failed-task\"");
  });

  it("truncates large snapshots deterministically", () => {
    const prompt = buildProjectAnalysisPrompt({
      snapshot: {
        ...snapshot,
        failedTasks: Array.from({ length: 100 }, (_, index) => ({
          id: `failed-${index}`,
          title: `Failed ${index}`,
          status: "failed",
          updatedAt: "2026-05-25T09:30:00.000Z",
          failedAgentRuns: 1,
          failedValidations: 1,
        })),
      },
      maxSnapshotChars: 800,
    });

    expect(prompt).toContain("[snapshot truncated");
  });
});
```

- [ ] **Step 2: Run prompt tests and verify they fail**

Run:

```bash
npm test -- tests/projectManagerPrompt.test.ts
```

Expected: fail because `buildProjectAnalysisPrompt` is not exported.

- [ ] **Step 3: Implement prompt builder**

Create `src/domain/projectManager/promptBuilder.ts`:

```typescript
import type { TaskType } from "../../models/types.js";
import {
  PROJECT_ANALYSIS_MARKER,
  type ProjectSignalSnapshot,
} from "./types.js";

const DEFAULT_MAX_SNAPSHOT_CHARS = 12_000;

const compactJson = (value: unknown, maxChars: number): string => {
  const raw = JSON.stringify(value);
  if (raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, maxChars)}[snapshot truncated at ${maxChars} chars]`;
};

export const buildProjectAnalysisPrompt = (input: {
  snapshot: ProjectSignalSnapshot;
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
  allowedTaskTypes?: TaskType[];
  focusAreas?: string[];
  maxSnapshotChars?: number;
}): string => {
  const maxGoalsPerRun = input.maxGoalsPerRun ?? 5;
  const maxTaskProposalsPerGoal = input.maxTaskProposalsPerGoal ?? 5;
  const allowedTaskTypes = input.allowedTaskTypes ?? [
    "documentation",
    "tests_only",
    "dependency_update",
  ];
  const focusAreas = input.focusAreas ?? [];
  const snapshot = compactJson(
    input.snapshot,
    input.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS,
  );

  return `Mode: project-management-analysis-only

Repository: ${input.snapshot.repositoryName}

Project snapshot:
${snapshot}

Focus areas:
${focusAreas.length > 0 ? focusAreas.map((area) => `- ${area}`).join("\n") : "- none configured"}

Limits:
- Max proposed goals: ${maxGoalsPerRun}
- Max task proposals per goal: ${maxTaskProposalsPerGoal}
- Allowed task types: ${allowedTaskTypes.join(", ")}

Requirements:
1. Analyze only the provided project snapshot.
2. Do not modify repository files.
3. Do not create executable tasks directly.
4. Do not call external services.
5. Propose goals only when evidence is concrete.
6. Prefer small, reviewable, low-risk goals.
7. Do not propose more than ${maxGoalsPerRun} goals.
8. Do not propose more than ${maxTaskProposalsPerGoal} task proposals per goal.
9. Suggested task proposals must use only these taskType values: ${allowedTaskTypes.join(", ")}.
10. Reply with exactly one line starting with ${PROJECT_ANALYSIS_MARKER} followed by one compact JSON object.

Required JSON schema:
{
  "summary": "Short project state summary.",
  "healthSignals": [
    {
      "kind": "repeated_validation_failure",
      "severity": "medium",
      "title": "Short signal title",
      "description": "Evidence-backed explanation.",
      "evidenceRefs": [
        {
          "kind": "validation_failure",
          "ref": "task-id:quality-gate-run-id",
          "summary": "Short evidence summary"
        }
      ],
      "recommendation": "Recommended next action."
    }
  ],
  "proposedGoals": [
    {
      "title": "Goal title",
      "problemStatement": "What is wrong or missing.",
      "desiredOutcome": "Measurable target state.",
      "successMetrics": ["Specific metric or observable outcome"],
      "priority": "normal",
      "riskLevel": "low",
      "evidenceRefs": [],
      "suggestedTaskProposals": [
        {
          "title": "Task proposal title",
          "description": "Focused implementation scope.",
          "taskType": "tests_only",
          "acceptanceCriteria": ["Observable completion criterion"],
          "expectedBlastRadius": "tests only",
          "evidenceRefs": []
        }
      ]
    }
  ],
  "staleGoalIds": [],
  "replanReason": "Optional reason when this is a replan."
}`;
};
```

- [ ] **Step 4: Export prompt builder**

Modify `src/domain/projectManager/index.ts`:

```typescript
export * from "./analysisParser.js";
export * from "./promptBuilder.js";
export * from "./signalCollector.js";
export * from "./types.js";
```

- [ ] **Step 5: Run prompt tests**

Run:

```bash
npm test -- tests/projectManagerPrompt.test.ts
```

Expected: all tests in `projectManagerPrompt.test.ts` pass.

- [ ] **Step 6: Commit task 3**

```bash
git add src/domain/projectManager/promptBuilder.ts src/domain/projectManager/index.ts tests/projectManagerPrompt.test.ts
git commit -m "feat: build project manager analysis prompt"
```

## Task 4: In-Memory Store And Read-Only Orchestrator

**Files:**
- Create: `src/domain/projectManager/store.ts`
- Create: `src/domain/projectManager/orchestrator.ts`
- Modify: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerOrchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator tests**

Create `tests/projectManagerOrchestrator.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  InMemoryProjectManagerStore,
  ProjectManagerOrchestrator,
  PROJECT_ANALYSIS_MARKER,
} from "../src/domain/projectManager/index.js";
import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/index.js";
import type { CreateTaskInput, TaskActor } from "../src/domain/taskTracker/index.js";
import type {
  CodexExecution,
  CodexRunner,
  CodexRunObserver,
  CodexRunOptions,
  CodexReviewRunOptions,
} from "../src/models/types.js";

const human: TaskActor = { owner: "human", id: "user-1" };

const baseTaskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  title: "Improve project manager docs",
  description: "Document project manager behavior.",
  createdBy: human,
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  components: ["worker"],
  taskType: "documentation",
  acceptanceCriteria: ["Docs describe behavior."],
  ...overrides,
});

class FakeCodexRunner implements CodexRunner {
  prompts: string[] = [];

  constructor(private readonly finalMessage: string) {}

  async runInitial(
    prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexRunOptions,
  ): Promise<CodexExecution> {
    this.prompts.push(prompt);
    return {
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage: this.finalMessage,
      threadId: "pm-thread-1",
    };
  }

  async runFix(): Promise<CodexExecution> {
    throw new Error("Project manager orchestrator must not run fixes.");
  }

  async runResume(): Promise<CodexExecution> {
    throw new Error("Project manager orchestrator must not resume implementation threads.");
  }

  async runReview(
    _prompt: string,
    _observer?: CodexRunObserver,
    _options?: CodexReviewRunOptions,
  ): Promise<CodexExecution> {
    throw new Error("Project manager orchestrator must not run code review.");
  }
}

describe("project manager orchestrator", () => {
  it("runs read-only project analysis and stores run records", async () => {
    const taskTracker = new InMemoryTaskTrackerClient();
    await taskTracker.createTask(baseTaskInput({ id: "doc-task", status: "ready" }));
    const codex = new FakeCodexRunner(
      `${PROJECT_ANALYSIS_MARKER} ${JSON.stringify({
        summary: "Docs need PM configuration coverage.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
      })}`,
    );
    const store = new InMemoryProjectManagerStore({
      now: () => new Date("2026-05-25T10:00:00.000Z"),
    });
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker,
      codex,
      store,
      config: {
        enabled: true,
        runOnce: false,
        intervalMinutes: 1440,
        maxGoalsPerRun: 5,
        maxTaskProposalsPerGoal: 5,
        defaultAutonomyLevel: "proposal_only",
        autoApproveLowRisk: false,
        allowedTaskTypes: ["documentation", "tests_only", "dependency_update"],
        repositoryScanEnabled: false,
        repositoryScanMaxFiles: 200,
        requireHumanGoalApproval: true,
      },
    });

    const run = await orchestrator.runAnalysisOnce({
      repositoryName: "developer",
      trigger: "manual",
    });

    expect(run).toMatchObject({
      repositoryName: "developer",
      trigger: "manual",
      status: "completed",
      proposedGoalIds: [],
      proposedTaskIds: [],
    });
    expect(codex.prompts).toHaveLength(1);
    expect(codex.prompts[0]).toContain("project-management-analysis-only");
    expect(store.listAnalyses("developer")).toEqual([
      expect.objectContaining({
        repositoryName: "developer",
        summary: "Docs need PM configuration coverage.",
      }),
    ]);
    expect(await taskTracker.listTasks({ repositoryName: "developer" })).toHaveLength(1);
  });

  it("stores failed runs when Codex returns invalid analysis", async () => {
    const taskTracker = new InMemoryTaskTrackerClient();
    const store = new InMemoryProjectManagerStore({
      now: () => new Date("2026-05-25T10:00:00.000Z"),
    });
    const orchestrator = new ProjectManagerOrchestrator({
      taskTracker,
      codex: new FakeCodexRunner("invalid output"),
      store,
      config: {
        enabled: true,
        runOnce: false,
        intervalMinutes: 1440,
        maxGoalsPerRun: 5,
        maxTaskProposalsPerGoal: 5,
        defaultAutonomyLevel: "proposal_only",
        autoApproveLowRisk: false,
        allowedTaskTypes: ["documentation", "tests_only", "dependency_update"],
        repositoryScanEnabled: false,
        repositoryScanMaxFiles: 200,
        requireHumanGoalApproval: true,
      },
    });

    await expect(
      orchestrator.runAnalysisOnce({
        repositoryName: "developer",
        trigger: "manual",
      }),
    ).rejects.toThrow(/valid PROJECT_ANALYSIS/);

    expect(store.listRuns("developer")).toEqual([
      expect.objectContaining({
        repositoryName: "developer",
        status: "failed",
        diagnostic: expect.stringContaining("valid PROJECT_ANALYSIS"),
      }),
    ]);
  });
});
```

- [ ] **Step 2: Run orchestrator tests and verify they fail**

Run:

```bash
npm test -- tests/projectManagerOrchestrator.test.ts
```

Expected: fail because `InMemoryProjectManagerStore` and `ProjectManagerOrchestrator` do not exist.

- [ ] **Step 3: Implement in-memory PM store**

Create `src/domain/projectManager/store.ts`:

```typescript
import { randomUUID } from "node:crypto";

import type {
  ParsedProjectAnalysis,
  ProjectAnalysis,
  ProjectManagerRun,
  ProjectManagerTrigger,
} from "./types.js";

export interface ProjectManagerStore {
  startRun(input: {
    repositoryName: string;
    trigger: ProjectManagerTrigger;
  }): ProjectManagerRun;
  completeRun(
    runId: string,
    input: {
      analysisId: string;
      proposedGoalIds?: string[];
      proposedTaskIds?: string[];
    },
  ): ProjectManagerRun;
  failRun(runId: string, diagnostic: string): ProjectManagerRun;
  recordAnalysis(input: {
    repositoryName: string;
    analysis: ParsedProjectAnalysis;
  }): ProjectAnalysis;
  listRuns(repositoryName?: string): ProjectManagerRun[];
  listAnalyses(repositoryName?: string): ProjectAnalysis[];
}

export class InMemoryProjectManagerStore implements ProjectManagerStore {
  private readonly runs = new Map<string, ProjectManagerRun>();
  private readonly analyses = new Map<string, ProjectAnalysis>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  startRun(input: {
    repositoryName: string;
    trigger: ProjectManagerTrigger;
  }): ProjectManagerRun {
    const startedAt = this.now().toISOString();
    const run: ProjectManagerRun = {
      id: `pm_run_${randomUUID()}`,
      repositoryName: input.repositoryName,
      trigger: input.trigger,
      status: "started",
      proposedGoalIds: [],
      proposedTaskIds: [],
      startedAt,
    };
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  completeRun(
    runId: string,
    input: {
      analysisId: string;
      proposedGoalIds?: string[];
      proposedTaskIds?: string[];
    },
  ): ProjectManagerRun {
    const run = this.requireRun(runId);
    const completed: ProjectManagerRun = {
      ...run,
      status: "completed",
      analysisId: input.analysisId,
      proposedGoalIds: [...(input.proposedGoalIds ?? [])],
      proposedTaskIds: [...(input.proposedTaskIds ?? [])],
      completedAt: this.now().toISOString(),
    };
    this.runs.set(runId, structuredClone(completed));
    return structuredClone(completed);
  }

  failRun(runId: string, diagnostic: string): ProjectManagerRun {
    const run = this.requireRun(runId);
    const failed: ProjectManagerRun = {
      ...run,
      status: "failed",
      diagnostic,
      completedAt: this.now().toISOString(),
    };
    this.runs.set(runId, structuredClone(failed));
    return structuredClone(failed);
  }

  recordAnalysis(input: {
    repositoryName: string;
    analysis: ParsedProjectAnalysis;
  }): ProjectAnalysis {
    const createdAt = this.now().toISOString();
    const analysis: ProjectAnalysis = {
      id: `pm_analysis_${randomUUID()}`,
      repositoryName: input.repositoryName,
      summary: input.analysis.summary,
      healthSignals: structuredClone(input.analysis.healthSignals),
      proposedGoals: structuredClone(input.analysis.proposedGoals),
      staleGoalIds: [...input.analysis.staleGoalIds],
      ...(input.analysis.replanReason ? { replanReason: input.analysis.replanReason } : {}),
      createdAt,
    };
    this.analyses.set(analysis.id, structuredClone(analysis));
    return structuredClone(analysis);
  }

  listRuns(repositoryName?: string): ProjectManagerRun[] {
    return [...this.runs.values()]
      .filter((run) => !repositoryName || run.repositoryName === repositoryName)
      .map((run) => structuredClone(run));
  }

  listAnalyses(repositoryName?: string): ProjectAnalysis[] {
    return [...this.analyses.values()]
      .filter((analysis) => !repositoryName || analysis.repositoryName === repositoryName)
      .map((analysis) => structuredClone(analysis));
  }

  private requireRun(runId: string): ProjectManagerRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Project manager run ${runId} not found.`);
    }
    return run;
  }
}
```

- [ ] **Step 4: Implement read-only orchestrator**

Create `src/domain/projectManager/orchestrator.ts`:

```typescript
import type { CodexRunner } from "../../models/types.js";
import type { TaskTrackerClient } from "../taskTracker/types.js";
import { parseProjectAnalysisResponse } from "./analysisParser.js";
import { buildProjectAnalysisPrompt } from "./promptBuilder.js";
import { collectProjectSignals } from "./signalCollector.js";
import type { ProjectManagerStore } from "./store.js";
import type {
  ProjectManagerConfig,
  ProjectManagerRun,
  ProjectManagerTrigger,
} from "./types.js";

export interface ProjectManagerOrchestratorInput {
  taskTracker: TaskTrackerClient;
  codex: CodexRunner;
  store: ProjectManagerStore;
  config: ProjectManagerConfig;
  focusAreas?: string[];
}

export class ProjectManagerOrchestrator {
  constructor(private readonly input: ProjectManagerOrchestratorInput) {}

  async runAnalysisOnce(options: {
    repositoryName: string;
    trigger?: ProjectManagerTrigger;
  }): Promise<ProjectManagerRun> {
    if (!this.input.config.enabled) {
      throw new Error("Project manager is disabled.");
    }

    const run = this.input.store.startRun({
      repositoryName: options.repositoryName,
      trigger: options.trigger ?? "manual",
    });

    try {
      const snapshot = await collectProjectSignals({
        taskTracker: this.input.taskTracker,
        repositoryName: options.repositoryName,
      });
      const prompt = buildProjectAnalysisPrompt({
        snapshot,
        maxGoalsPerRun: this.input.config.maxGoalsPerRun,
        maxTaskProposalsPerGoal: this.input.config.maxTaskProposalsPerGoal,
        allowedTaskTypes: this.input.config.allowedTaskTypes,
        focusAreas: this.input.focusAreas,
      });
      const execution = await this.input.codex.runInitial(prompt);
      if (execution.process.exitCode !== 0) {
        throw new Error(
          execution.process.stderr.trim() || `Codex exited with ${execution.process.exitCode}.`,
        );
      }
      const parsed = parseProjectAnalysisResponse(execution.finalMessage);
      if (!parsed) {
        throw new Error("Codex did not return a valid PROJECT_ANALYSIS response.");
      }
      const analysis = this.input.store.recordAnalysis({
        repositoryName: options.repositoryName,
        analysis: parsed,
      });
      return this.input.store.completeRun(run.id, {
        analysisId: analysis.id,
        proposedGoalIds: [],
        proposedTaskIds: [],
      });
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      this.input.store.failRun(run.id, diagnostic);
      throw error;
    }
  }
}
```

- [ ] **Step 5: Export store and orchestrator**

Modify `src/domain/projectManager/index.ts`:

```typescript
export * from "./analysisParser.js";
export * from "./orchestrator.js";
export * from "./promptBuilder.js";
export * from "./signalCollector.js";
export * from "./store.js";
export * from "./types.js";
```

- [ ] **Step 6: Run orchestrator tests**

Run:

```bash
npm test -- tests/projectManagerOrchestrator.test.ts
```

Expected: all tests in `projectManagerOrchestrator.test.ts` pass.

- [ ] **Step 7: Commit task 4**

```bash
git add src/domain/projectManager/store.ts src/domain/projectManager/orchestrator.ts src/domain/projectManager/index.ts tests/projectManagerOrchestrator.test.ts
git commit -m "feat: add read-only project manager orchestrator"
```

## Task 5: Disabled-By-Default Configuration

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Append these tests inside `describe("config", () => { ... })` in `tests/config.test.ts`:

```typescript
  it("defaults project manager configuration to disabled", () => {
    const statusMapFile = createStatusMapFile();
    const config = loadConfig({
      TRACKER_TOKEN: "tracker-token",
      TRACKER_ORG_ID: "org-id",
      TRACKER_STATUS_MAP_FILE: statusMapFile,
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.projectManager).toEqual({
      enabled: false,
      runOnce: false,
      intervalMinutes: 1440,
      maxGoalsPerRun: 5,
      maxTaskProposalsPerGoal: 5,
      defaultAutonomyLevel: "proposal_only",
      autoApproveLowRisk: false,
      allowedTaskTypes: ["documentation", "tests_only", "dependency_update"],
      repositoryScanEnabled: false,
      repositoryScanMaxFiles: 200,
      requireHumanGoalApproval: true,
    });
  });

  it("parses project manager environment configuration", () => {
    const config = loadConfig({
      TASK_TRACKER_PROVIDER: "internal",
      TASK_TRACKER_STORAGE: "memory",
      NODE_ENV: "test",
      PROJECT_MANAGER_ENABLED: "true",
      PROJECT_MANAGER_RUN_ONCE: "true",
      PROJECT_MANAGER_INTERVAL_MINUTES: "60",
      PROJECT_MANAGER_MAX_GOALS_PER_RUN: "3",
      PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL: "2",
      PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL: "auto_triage",
      PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK: "false",
      PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON: "[\"documentation\",\"tests_only\"]",
      PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED: "true",
      PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES: "50",
      PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL: "true",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_PROJECT_ID: "123",
      MAX_FIX_ATTEMPTS: "2",
      WORKER_ID: "worker-1",
    });

    expect(config.projectManager).toEqual({
      enabled: true,
      runOnce: true,
      intervalMinutes: 60,
      maxGoalsPerRun: 3,
      maxTaskProposalsPerGoal: 2,
      defaultAutonomyLevel: "auto_triage",
      autoApproveLowRisk: false,
      allowedTaskTypes: ["documentation", "tests_only"],
      repositoryScanEnabled: true,
      repositoryScanMaxFiles: 50,
      requireHumanGoalApproval: true,
    });
  });

  it("rejects enabled project manager outside internal task tracker mode", () => {
    const statusMapFile = createStatusMapFile();

    expect(() =>
      loadConfig({
        TRACKER_TOKEN: "tracker-token",
        TRACKER_ORG_ID: "org-id",
        TRACKER_STATUS_MAP_FILE: statusMapFile,
        PROJECT_MANAGER_ENABLED: "true",
        GITLAB_URL: "https://gitlab.example.com/",
        GITLAB_TOKEN: "gitlab-token",
        GITLAB_PROJECT_ID: "123",
        MAX_FIX_ATTEMPTS: "2",
        WORKER_ID: "worker-1",
      }),
    ).toThrow(/PROJECT_MANAGER_ENABLED=true requires TASK_TRACKER_PROVIDER=internal/);
  });

  it("parses repository project manager overrides from fleet config", () => {
    const statusMapFile = createStatusMapFile();
    const directory = mkdtempSync(join(tmpdir(), "ai-worker-pm-config-"));
    cleanupPaths.push(directory);
    const configFile = join(directory, "worker.config.yaml");
    writeFileSync(
      configFile,
      [
        "worker:",
        "  id: worker-pm",
        "taskTracker:",
        "  provider: internal",
        "  storage: memory",
        "projectManager:",
        "  enabled: true",
        "  maxGoalsPerRun: 4",
        "repositories:",
        "  - name: developer",
        "    repoPath: /workspace/developer",
        "    gitlabProjectId: \"123\"",
        "    baseBranch: main",
        "    queues: [DEV]",
        "    tags: [ai_dev]",
        "    testCommand: npm test",
        "    lintCommand: npm run lint",
        "    projectManager:",
        "      enabled: true",
        "      focusAreas:",
        "        - test coverage",
        "      allowedTaskTypes:",
        "        - documentation",
        "      maxGoalsPerRun: 2",
      ].join("\n"),
      "utf8",
    );

    const config = loadFleetConfig({
      WORKER_CONFIG_FILE: configFile,
      NODE_ENV: "test",
      GITLAB_URL: "https://gitlab.example.com/",
      GITLAB_TOKEN: "gitlab-token",
    });

    expect(config.projectManager?.enabled).toBe(true);
    expect(config.projectManager?.maxGoalsPerRun).toBe(4);
    expect(config.repositories[0]?.projectManager).toEqual({
      enabled: true,
      focusAreas: ["test coverage"],
      allowedTaskTypes: ["documentation"],
      maxGoalsPerRun: 2,
    });
  });
```

- [ ] **Step 2: Run config tests and verify they fail**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: fail because `projectManager` is not present in parsed config.

- [ ] **Step 3: Add PM config types to models**

Modify `src/models/types.ts`:

```typescript
import type {
  ProjectManagerConfig,
  RepositoryProjectManagerConfig,
} from "../domain/projectManager/types.js";
```

Add `projectManager?: RepositoryProjectManagerConfig;` to `RepositoryProfile`.

Add `projectManager?: ProjectManagerConfig;` to `AppConfig` and `GlobalWorkerConfig`.

Add these exports near the existing task tracker re-exports:

```typescript
export type {
  ParsedProjectAnalysis,
  ProjectAnalysis,
  ProjectGoalDraft,
  ProjectGoalPriority,
  ProjectGoalRiskLevel,
  ProjectHealthSignal,
  ProjectManagerConfig,
  ProjectManagerRun,
  ProjectManagerTrigger,
  ProjectSignalSnapshot,
  ProjectTaskProposalDraft,
  ProjectTaskSignal,
  RepositoryProjectManagerConfig,
} from "../domain/projectManager/types.js";
```

- [ ] **Step 4: Add PM config parsing**

Modify `src/config.ts`.

Add import:

```typescript
import type {
  ProjectManagerConfig,
  RepositoryProjectManagerConfig,
} from "./domain/projectManager/types.js";
```

Add defaults near existing defaults:

```typescript
const DEFAULT_PROJECT_MANAGER_CONFIG: ProjectManagerConfig = {
  enabled: false,
  runOnce: false,
  intervalMinutes: 1440,
  maxGoalsPerRun: 5,
  maxTaskProposalsPerGoal: 5,
  defaultAutonomyLevel: "proposal_only",
  autoApproveLowRisk: false,
  allowedTaskTypes: ["documentation", "tests_only", "dependency_update"],
  repositoryScanEnabled: false,
  repositoryScanMaxFiles: 200,
  requireHumanGoalApproval: true,
};
```

Add helpers:

```typescript
const parseAutonomyLevel = (
  input: unknown,
  key: string,
  defaultValue: ProjectManagerConfig["defaultAutonomyLevel"],
): ProjectManagerConfig["defaultAutonomyLevel"] => {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    return defaultValue;
  }
  if (
    value === "proposal_only" ||
    value === "auto_triage" ||
    value === "auto_execute_low_risk"
  ) {
    return value;
  }
  throw new ConfigurationError(
    `${key} must be one of: proposal_only, auto_triage, auto_execute_low_risk.`,
  );
};

const parseRepositoryProjectManagerConfig = (
  value: unknown,
  path: string,
): RepositoryProjectManagerConfig | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = asRecord(value, path);
  return {
    ...(raw.enabled !== undefined
      ? { enabled: optionalBoolean(raw.enabled, `${path}.enabled`, false) }
      : {}),
    ...(raw.focusAreas !== undefined
      ? { focusAreas: optionalStringArrayValue(raw.focusAreas, `${path}.focusAreas`, []) }
      : {}),
    ...(raw.allowedTaskTypes !== undefined
      ? {
          allowedTaskTypes: parseTaskTypeArray(
            raw.allowedTaskTypes,
            `${path}.allowedTaskTypes`,
            DEFAULT_PROJECT_MANAGER_CONFIG.allowedTaskTypes,
          ),
        }
      : {}),
    ...(raw.maxGoalsPerRun !== undefined
      ? {
          maxGoalsPerRun: optionalPositiveInt(
            raw.maxGoalsPerRun,
            `${path}.maxGoalsPerRun`,
            DEFAULT_PROJECT_MANAGER_CONFIG.maxGoalsPerRun,
          ),
        }
      : {}),
    ...(raw.maxTaskProposalsPerGoal !== undefined
      ? {
          maxTaskProposalsPerGoal: optionalPositiveInt(
            raw.maxTaskProposalsPerGoal,
            `${path}.maxTaskProposalsPerGoal`,
            DEFAULT_PROJECT_MANAGER_CONFIG.maxTaskProposalsPerGoal,
          ),
        }
      : {}),
  };
};
```

Add root parser:

```typescript
const parseProjectManagerConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: Record<string, unknown>,
  taskTracker?: TaskTrackerConfig,
): ProjectManagerConfig => {
  const enabled = env.PROJECT_MANAGER_ENABLED?.trim()
    ? parseBooleanFlag(
        env.PROJECT_MANAGER_ENABLED,
        "PROJECT_MANAGER_ENABLED",
        DEFAULT_PROJECT_MANAGER_CONFIG.enabled,
      )
    : optionalBoolean(
        rawValue?.enabled,
        "projectManager.enabled",
        DEFAULT_PROJECT_MANAGER_CONFIG.enabled,
      );
  if (enabled && taskTracker?.provider !== "internal") {
    throw new ConfigurationError(
      "PROJECT_MANAGER_ENABLED=true requires TASK_TRACKER_PROVIDER=internal.",
    );
  }
  return {
    enabled,
    runOnce: env.PROJECT_MANAGER_RUN_ONCE?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_RUN_ONCE,
          "PROJECT_MANAGER_RUN_ONCE",
          DEFAULT_PROJECT_MANAGER_CONFIG.runOnce,
        )
      : optionalBoolean(
          rawValue?.runOnce,
          "projectManager.runOnce",
          DEFAULT_PROJECT_MANAGER_CONFIG.runOnce,
        ),
    intervalMinutes: env.PROJECT_MANAGER_INTERVAL_MINUTES?.trim()
      ? parsePositiveInt(
          env.PROJECT_MANAGER_INTERVAL_MINUTES,
          "PROJECT_MANAGER_INTERVAL_MINUTES",
        )
      : optionalPositiveInt(
          rawValue?.intervalMinutes,
          "projectManager.intervalMinutes",
          DEFAULT_PROJECT_MANAGER_CONFIG.intervalMinutes,
        ),
    maxGoalsPerRun: env.PROJECT_MANAGER_MAX_GOALS_PER_RUN?.trim()
      ? parsePositiveInt(
          env.PROJECT_MANAGER_MAX_GOALS_PER_RUN,
          "PROJECT_MANAGER_MAX_GOALS_PER_RUN",
        )
      : optionalPositiveInt(
          rawValue?.maxGoalsPerRun,
          "projectManager.maxGoalsPerRun",
          DEFAULT_PROJECT_MANAGER_CONFIG.maxGoalsPerRun,
        ),
    maxTaskProposalsPerGoal: env.PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL?.trim()
      ? parsePositiveInt(
          env.PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL,
          "PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL",
        )
      : optionalPositiveInt(
          rawValue?.maxTaskProposalsPerGoal,
          "projectManager.maxTaskProposalsPerGoal",
          DEFAULT_PROJECT_MANAGER_CONFIG.maxTaskProposalsPerGoal,
        ),
    defaultAutonomyLevel: env.PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL?.trim()
      ? parseAutonomyLevel(
          env.PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL,
          "PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL",
          DEFAULT_PROJECT_MANAGER_CONFIG.defaultAutonomyLevel,
        )
      : parseAutonomyLevel(
          rawValue?.defaultAutonomyLevel,
          "projectManager.defaultAutonomyLevel",
          DEFAULT_PROJECT_MANAGER_CONFIG.defaultAutonomyLevel,
        ),
    autoApproveLowRisk: env.PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK,
          "PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK",
          DEFAULT_PROJECT_MANAGER_CONFIG.autoApproveLowRisk,
        )
      : optionalBoolean(
          rawValue?.autoApproveLowRisk,
          "projectManager.autoApproveLowRisk",
          DEFAULT_PROJECT_MANAGER_CONFIG.autoApproveLowRisk,
        ),
    allowedTaskTypes: env.PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON?.trim()
      ? parseTaskTypeArrayEnv(
          env.PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON,
          "PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON",
          DEFAULT_PROJECT_MANAGER_CONFIG.allowedTaskTypes,
        )
      : parseTaskTypeArray(
          rawValue?.allowedTaskTypes,
          "projectManager.allowedTaskTypes",
          DEFAULT_PROJECT_MANAGER_CONFIG.allowedTaskTypes,
        ),
    repositoryScanEnabled: env.PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED,
          "PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED",
          DEFAULT_PROJECT_MANAGER_CONFIG.repositoryScanEnabled,
        )
      : optionalBoolean(
          rawValue?.repositoryScanEnabled,
          "projectManager.repositoryScanEnabled",
          DEFAULT_PROJECT_MANAGER_CONFIG.repositoryScanEnabled,
        ),
    repositoryScanMaxFiles: env.PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES?.trim()
      ? parsePositiveInt(
          env.PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES,
          "PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES",
        )
      : optionalPositiveInt(
          rawValue?.repositoryScanMaxFiles,
          "projectManager.repositoryScanMaxFiles",
          DEFAULT_PROJECT_MANAGER_CONFIG.repositoryScanMaxFiles,
        ),
    requireHumanGoalApproval: env.PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL?.trim()
      ? parseBooleanFlag(
          env.PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL,
          "PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL",
          DEFAULT_PROJECT_MANAGER_CONFIG.requireHumanGoalApproval,
        )
      : optionalBoolean(
          rawValue?.requireHumanGoalApproval,
          "projectManager.requireHumanGoalApproval",
          DEFAULT_PROJECT_MANAGER_CONFIG.requireHumanGoalApproval,
        ),
  };
};
```

Wire parsing:

- In `loadFleetConfigFromFile`, read `const projectManager = optionalRecord(root.projectManager, "projectManager");`.
- Parse `const taskTracker = parseTaskTrackerConfig(...)` before project manager.
- Add `projectManager: parseProjectManagerConfig(env, projectManager, taskTracker)` to the returned `GlobalWorkerConfig`.
- In single-repository config path, add `projectManager` to the returned config and to `buildSingleRepositoryFleetConfig` result.
- In `parseRepositoryProfile`, read `projectManager: parseRepositoryProjectManagerConfig(raw.projectManager, "repositories[index].projectManager")` using the actual path string already used by the function.
- In `buildRepositoryRuntimeConfig`, pass `projectManager: globalConfig.projectManager`.

- [ ] **Step 5: Run config tests**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: all tests in `config.test.ts` pass.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript completes with exit code 0.

- [ ] **Step 7: Commit task 5**

```bash
git add src/models/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: add project manager configuration"
```

## Task 6: Documentation And Final Verification

**Files:**
- Modify: `.env.example`
- Modify: `docs/ENV_CONFIGURATION.md`
- Test: all PM tests and typecheck

- [ ] **Step 1: Update `.env.example`**

Add this disabled-by-default block near the AI proposal/internal tracker settings:

```env
# Project Manager Agent is disabled by default. It can perform read-only project
# analysis when TASK_TRACKER_PROVIDER=internal, but this phase does not create
# goals or task proposals automatically.
PROJECT_MANAGER_ENABLED=false
PROJECT_MANAGER_RUN_ONCE=false
PROJECT_MANAGER_INTERVAL_MINUTES=1440
PROJECT_MANAGER_MAX_GOALS_PER_RUN=5
PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL=5
PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL=proposal_only
PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK=false
PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON=["documentation","tests_only","dependency_update"]
PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED=false
PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES=200
PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL=true
```

- [ ] **Step 2: Update environment documentation**

Modify `docs/ENV_CONFIGURATION.md` and add a section:

```markdown
## Project Manager Agent

The Project Manager Agent is disabled by default and currently supports the PM-0/PM-1 read-only analysis foundation only. It requires `TASK_TRACKER_PROVIDER=internal` when enabled. In this phase it reads internal task tracker state, builds a project signal snapshot, asks Codex for a `PROJECT_ANALYSIS:` response, validates the response, and stores the analysis/run in the in-memory PM store used by the orchestrator. It does not create goals, task proposals, tasks, branches, commits, merge requests, or tracker comments.

| Variable | Default | Description |
| --- | --- | --- |
| `PROJECT_MANAGER_ENABLED` | `false` | Enables the Project Manager Agent foundation. Requires internal task tracker mode. |
| `PROJECT_MANAGER_RUN_ONCE` | `false` | Reserved for a future operational entrypoint. The PM-0/PM-1 implementation exposes `ProjectManagerOrchestrator.runAnalysisOnce` for controlled wiring and tests. |
| `PROJECT_MANAGER_INTERVAL_MINUTES` | `1440` | Reserved scheduling interval for later phases. |
| `PROJECT_MANAGER_MAX_GOALS_PER_RUN` | `5` | Maximum goals the analysis prompt asks Codex to propose. |
| `PROJECT_MANAGER_MAX_TASK_PROPOSALS_PER_GOAL` | `5` | Maximum task proposal drafts per proposed goal in the analysis response. |
| `PROJECT_MANAGER_DEFAULT_AUTONOMY_LEVEL` | `proposal_only` | Default autonomy level for future task proposal generation. |
| `PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK` | `false` | Reserved low-risk approval gate for later phases. |
| `PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON` | `["documentation","tests_only","dependency_update"]` | Task types the analysis prompt may suggest for future task proposal drafts. |
| `PROJECT_MANAGER_REPOSITORY_SCAN_ENABLED` | `false` | Reserved for future read-only repository scanning. |
| `PROJECT_MANAGER_REPOSITORY_SCAN_MAX_FILES` | `200` | Reserved file scan limit for future repository snapshots. |
| `PROJECT_MANAGER_REQUIRE_HUMAN_GOAL_APPROVAL` | `true` | Reserved guardrail for PM-2 goal approval. |
```

- [ ] **Step 3: Run focused PM tests**

Run:

```bash
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerSignals.test.ts tests/projectManagerPrompt.test.ts tests/projectManagerOrchestrator.test.ts
```

Expected: all focused PM tests pass.

- [ ] **Step 4: Run config tests**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: `config.test.ts` passes.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript completes with exit code 0.

- [ ] **Step 6: Run full test suite**

Run:

```bash
npm test
```

Expected: full Vitest suite passes.

- [ ] **Step 7: Commit task 6**

```bash
git add .env.example docs/ENV_CONFIGURATION.md
git commit -m "docs: document project manager configuration"
```

## Self-Review Checklist

- PM-0 guardrail is preserved: no new code path creates executable tasks.
- `ProjectManagerOrchestrator` calls only `listTasks`, `listActiveLeases`, `codex.runInitial`, and PM store methods.
- No changes are made to `InternalWorkerOrchestrator` or direct Yandex runtime behavior.
- `PROJECT_MANAGER_ENABLED` defaults to `false`.
- Enabling Project Manager requires `TASK_TRACKER_PROVIDER=internal`.
- PM config is available in single-repo and fleet config paths.
- The first implementation is testable without PostgreSQL.
- Later PM-2 storage can replace or complement `InMemoryProjectManagerStore` without changing parser/prompt/signal collector contracts.

## Execution Handoff

Plan complete when this file exists and passes markdown self-review. Execute with:

1. **Subagent-Driven (recommended)** - one implementation subagent per task, followed by spec compliance review and code quality review.
2. **Inline Execution** - use `superpowers:executing-plans` in this session if subagents are unavailable.

Recommended next action: execute Task 1 with a fresh implementation subagent, then review before moving to Task 2.
