# Project Manager PM-5 Replanning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual/event-ready Project Manager replanning loop without a scheduler.

**Architecture:** Extend the PM domain with a `PROJECT_REPLAN` contract, persist replan classifications with analyses and goal audit events, add `runReplanOnce` to the orchestrator, expose it through the existing project-manager run API, and surface decisions in the Angular goal detail page. Keep all task work behind existing goal approval and task proposal approval flows.

**Tech Stack:** TypeScript ES modules, Node.js domain services, PM in-memory/PostgreSQL stores, Observability human API, Angular standalone components, PrimeNG, Vitest, Karma/Jasmine, Playwright.

---

## Current Baseline

PM-4 is on `main` at `9f3c94b`. Existing relevant files:

- `src/domain/projectManager/types.ts`
- `src/domain/projectManager/promptBuilder.ts`
- `src/domain/projectManager/analysisParser.ts`
- `src/domain/projectManager/analysisPolicy.ts`
- `src/domain/projectManager/signalCollector.ts`
- `src/domain/projectManager/orchestrator.ts`
- `src/domain/projectManager/store.ts`
- `src/integrations/internalTracker/migrations/0007_project_manager_goals.sql`
- `src/integrations/internalTracker/postgresProjectManagerStore.ts`
- `src/observability/taskTrackerHumanApi.ts`
- `web/src/app/services/project-goal.service.ts`
- `web/src/app/pages/goal-detail-page.component.ts`
- `web/e2e/mock-console-server.mjs`
- `web/e2e/console-critical-flows.spec.ts`

## File Map

Domain:

- Modify `src/domain/projectManager/types.ts`: add replan marker, decisions,
  classification types, analysis fields, and audit event kind.
- Modify `src/domain/projectManager/analysisParser.ts`: parse
  `PROJECT_REPLAN` output.
- Modify `src/domain/projectManager/analysisPolicy.ts`: validate replan output
  against known active goals and existing PM limits.
- Modify `src/domain/projectManager/promptBuilder.ts`: add replan prompt
  builder.
- Create `src/domain/projectManager/replanSnapshot.ts`: build active-goal and
  linked-task snapshot for replanning.
- Modify `src/domain/projectManager/orchestrator.ts`: add `runReplanOnce` and
  metrics.
- Modify `src/domain/projectManager/store.ts`: persist replan analysis fields
  and append replan audit events.
- Modify `src/domain/projectManager/index.ts`: export new types/helpers.

PostgreSQL:

- Create `src/integrations/internalTracker/migrations/0008_project_manager_replans.sql`.
- Modify `src/integrations/internalTracker/postgresProjectManagerStore.ts`.

API:

- Modify `src/observability/taskTrackerHumanApi.ts`: support `mode: "replan"`
  in `POST /api/project-manager/runs`.

Angular:

- Modify `web/src/app/models/human-api.dto.ts`.
- Modify `web/src/app/services/task-mappers.ts`.
- Modify `web/src/app/services/project-goal.service.ts`.
- Modify `web/src/app/pages/goal-detail-page.component.ts`.
- Modify `web/src/app/pages/workflow-pages.spec.ts`.

E2E:

- Modify `web/e2e/mock-console-server.mjs`.
- Modify `web/e2e/console-critical-flows.spec.ts`.

Docs:

- Modify `docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md`.

---

## Task 1: Replan Domain Contract, Parser, Prompt, And Policy

**Files:**

- Modify: `src/domain/projectManager/types.ts`
- Modify: `src/domain/projectManager/analysisParser.ts`
- Modify: `src/domain/projectManager/analysisPolicy.ts`
- Modify: `src/domain/projectManager/promptBuilder.ts`
- Modify: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerAnalysis.test.ts`
- Test: `tests/projectManagerPrompt.test.ts`

- [ ] **Step 1: Add failing parser tests for `PROJECT_REPLAN`**

Add to `tests/projectManagerAnalysis.test.ts`:

```typescript
it("parses valid PROJECT_REPLAN output", () => {
  const parsed = parseProjectReplanResponse(
    `PROJECT_REPLAN: ${JSON.stringify({
      summary: "Linked task failed; propose a smaller follow-up.",
      healthSignals: [],
      proposedGoals: [],
      staleGoalIds: [],
      replanReason: "manual: failed linked task",
      previousAnalysisId: "pm_analysis_1",
      goalReplans: [
        {
          goalId: "pm_goal_1",
          decision: "create_follow_up",
          rationale: "The linked task failed twice.",
          evidenceRefs: [
            {
              kind: "validation_failure",
              ref: "task_1:quality_gate_run_2",
              summary: "Tests failed twice.",
            },
          ],
          followUpGoals: [],
        },
      ],
    })}`,
  );

  expect(parsed).toMatchObject({
    replanReason: "manual: failed linked task",
    previousAnalysisId: "pm_analysis_1",
    goalReplans: [
      {
        goalId: "pm_goal_1",
        decision: "create_follow_up",
        rationale: "The linked task failed twice.",
      },
    ],
  });
});

it("rejects PROJECT_REPLAN classifications with unsupported decisions", () => {
  expect(() =>
    parseProjectReplanResponse(
      `PROJECT_REPLAN: ${JSON.stringify({
        summary: "Bad decision.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        replanReason: "manual",
        goalReplans: [
          {
            goalId: "pm_goal_1",
            decision: "delete_goal",
            rationale: "Unsupported.",
            evidenceRefs: [],
            followUpGoals: [],
          },
        ],
      })}`,
    ),
  ).toThrow(/decision/);
});
```

- [ ] **Step 2: Add failing prompt test**

Add to `tests/projectManagerPrompt.test.ts`:

```typescript
it("builds a read-only project replan prompt with active goals and linked tasks", () => {
  const prompt = buildProjectReplanPrompt({
    snapshot: {
      repositoryName: "developer",
      generatedAt: "2026-05-26T00:00:00.000Z",
      replanReason: "manual: failed linked task",
      previousAnalysisId: "pm_analysis_1",
      projectSignals: {
        repositoryName: "developer",
        generatedAt: "2026-05-26T00:00:00.000Z",
        totalTasks: 1,
        statusCounts: { failed: 1 },
        activeLeases: 0,
        readyTasks: [],
        failedTasks: [],
        waitingForHuman: [],
        repeatedFailures: [],
        recentReviewTasks: [],
      },
      goals: [
        {
          goal: {
            id: "pm_goal_1",
            title: "Stabilize proposal workflow",
            status: "active",
            priority: "high",
            riskLevel: "low",
            repositoryName: "developer",
          },
          linkedTasks: [
            {
              id: "task_1",
              title: "Fix regression",
              status: "failed",
              updatedAt: "2026-05-26T00:00:00.000Z",
            },
          ],
          auditEvents: [],
        },
      ],
    },
    maxGoalsPerRun: 2,
    maxTaskProposalsPerGoal: 1,
    allowedTaskTypes: ["documentation", "tests_only"],
  });

  expect(prompt).toContain("Mode: project-management-replan-only");
  expect(prompt).toContain("PROJECT_REPLAN:");
  expect(prompt).toContain("Do not create executable tasks directly");
  expect(prompt).toContain("manual: failed linked task");
  expect(prompt).toContain("pm_goal_1");
});
```

- [ ] **Step 3: Run the failing tests**

Run:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts
```

Expected: compile failures for missing replan parser/prompt/types.

- [ ] **Step 4: Add replan types**

In `src/domain/projectManager/types.ts`, add:

```typescript
export const PROJECT_REPLAN_MARKER = "PROJECT_REPLAN:";

export const PROJECT_GOAL_REPLAN_DECISIONS = [
  "continue",
  "split",
  "pause",
  "mark_completed",
  "create_follow_up",
  "ask_human",
] as const;

export type ProjectGoalReplanDecision =
  (typeof PROJECT_GOAL_REPLAN_DECISIONS)[number];

export interface ProjectGoalReplanClassification {
  goalId: string;
  decision: ProjectGoalReplanDecision;
  rationale: string;
  evidenceRefs: EvidenceRef[];
  followUpGoals: ProjectGoalDraft[];
  humanQuestion?: string;
}
```

Extend `ProjectAnalysis` and `ParsedProjectAnalysis`:

```typescript
previousAnalysisId?: string;
goalReplans: ProjectGoalReplanClassification[];
```

Add `project_goal_replan_classified` to
`PROJECT_GOAL_AUDIT_EVENT_KINDS`.

- [ ] **Step 5: Implement `parseProjectReplanResponse`**

In `src/domain/projectManager/analysisParser.ts`, import the new marker and
decision constants. Reuse existing object/string/evidence parsing helpers and
add:

```typescript
export const parseProjectReplanResponse = (
  message: string,
): ParsedProjectAnalysis | undefined => {
  const payload = extractMarkerPayload(message, PROJECT_REPLAN_MARKER);
  if (!payload) {
    return undefined;
  }
  const parsed = parseJsonObject(payload);
  return {
    summary: requiredString(parsed.summary, "summary"),
    healthSignals: parseHealthSignals(parsed.healthSignals),
    proposedGoals: parseGoalDrafts(parsed.proposedGoals),
    staleGoalIds: optionalStringArray(parsed.staleGoalIds),
    replanReason: requiredString(parsed.replanReason, "replanReason"),
    previousAnalysisId: optionalString(parsed.previousAnalysisId),
    goalReplans: parseGoalReplans(parsed.goalReplans),
  };
};
```

If helper names differ in the current parser, use the existing local helpers and
keep the output shape identical.

- [ ] **Step 6: Add replan policy validation**

In `src/domain/projectManager/analysisPolicy.ts`, add:

```typescript
export interface AssertProjectReplanWithinPolicyInput {
  parsed: ParsedProjectAnalysis;
  config: ProjectManagerConfig;
  activeGoalIds: Set<string>;
}

export const assertProjectReplanWithinPolicy = (
  input: AssertProjectReplanWithinPolicyInput,
): void => {
  assertProjectAnalysisWithinPolicy(input.parsed, input.config);
  if (input.parsed.goalReplans.length > 20) {
    throw new Error("Project replan may contain at most 20 goalReplans.");
  }
  for (const replan of input.parsed.goalReplans) {
    if (!input.activeGoalIds.has(replan.goalId)) {
      throw new Error(`Unknown or inactive project goal in replan: ${replan.goalId}`);
    }
    if (replan.decision === "ask_human" && !replan.humanQuestion?.trim()) {
      throw new Error("ask_human replan decisions require humanQuestion.");
    }
  }
};
```

- [ ] **Step 7: Add `buildProjectReplanPrompt`**

In `src/domain/projectManager/promptBuilder.ts`, add `ProjectReplanSnapshot`
types or import them from Task 3 when that file exists. For this task, define
the exported input type beside the builder:

```typescript
export interface BuildProjectReplanPromptInput {
  snapshot: ProjectReplanSnapshot;
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
  allowedTaskTypes?: TaskType[];
  focusAreas?: string[];
  maxSnapshotChars?: number;
}
```

Implement a prompt with these required lines:

```typescript
"Mode: project-management-replan-only",
"Analyze active project goals against linked task outcomes.",
"Guardrails:",
"- Analyze only the provided snapshot.",
"- Do not modify files.",
"- Do not create executable tasks directly.",
"- Follow-up work must be proposed goals or proposal drafts only.",
"Required output:",
"Reply with exactly one line starting with PROJECT_REPLAN: followed by compact JSON matching this schema.",
```

- [ ] **Step 8: Export new symbols**

In `src/domain/projectManager/index.ts`, ensure these are exported:

```typescript
export {
  parseProjectReplanResponse,
} from "./analysisParser.js";
export {
  assertProjectReplanWithinPolicy,
} from "./analysisPolicy.js";
export {
  buildProjectReplanPrompt,
} from "./promptBuilder.js";
```

- [ ] **Step 9: Run focused tests**

Run:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts
npm run typecheck
```

Expected: parser/prompt tests pass and TypeScript compiles.

- [ ] **Step 10: Commit Task 1**

```powershell
git add src/domain/projectManager/types.ts src/domain/projectManager/analysisParser.ts src/domain/projectManager/analysisPolicy.ts src/domain/projectManager/promptBuilder.ts src/domain/projectManager/index.ts tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts
git commit -m "feat: add project manager replan contract"
```

---

## Task 2: Store Replan Persistence And Goal Audit Events

**Files:**

- Modify: `src/domain/projectManager/store.ts`
- Create: `src/integrations/internalTracker/migrations/0008_project_manager_replans.sql`
- Modify: `src/integrations/internalTracker/postgresProjectManagerStore.ts`
- Test: `tests/projectManagerGoalStore.test.ts`
- Test: `tests/projectManagerPostgresStore.test.ts`

- [ ] **Step 1: Add failing in-memory store tests**

Add to `tests/projectManagerGoalStore.test.ts`:

```typescript
it("records replan analysis fields and goal replan audit events", async () => {
  const store = new InMemoryProjectManagerStore({ now: clock.now });
  const [goal] = await store.createGoalsFromAnalysis({
    sourceAnalysisId: "analysis-1",
    sourceRunId: "run-1",
    repositoryName: "developer",
    goals: [goalDraft()],
  });
  await store.approveGoal(goal.id, { actor });
  await store.activateGoal(goal.id, { actor });

  const analysis = await store.recordAnalysis({
    repositoryName: "developer",
    summary: "Replan found a follow-up.",
    healthSignals: [],
    proposedGoals: [],
    staleGoalIds: [],
    replanReason: "manual: failed linked task",
    previousAnalysisId: "analysis-1",
    goalReplans: [
      {
        goalId: goal.id,
        decision: "create_follow_up",
        rationale: "Linked task failed.",
        evidenceRefs: [],
        followUpGoals: [],
      },
    ],
  });
  await store.recordGoalReplanClassification({
    goalId: goal.id,
    analysisId: analysis.id,
    classification: analysis.goalReplans[0]!,
  });

  expect(analysis).toMatchObject({
    previousAnalysisId: "analysis-1",
    replanReason: "manual: failed linked task",
    goalReplans: [expect.objectContaining({ decision: "create_follow_up" })],
  });
  await expect(store.listGoalEvents(goal.id)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "project_goal_replan_classified",
        payload: expect.objectContaining({
          analysisId: analysis.id,
          decision: "create_follow_up",
          rationale: "Linked task failed.",
        }),
      }),
    ]),
  );
});
```

- [ ] **Step 2: Add failing PostgreSQL tests**

Add equivalent coverage to `tests/projectManagerPostgresStore.test.ts` inside
the database-gated suite. Use a unique title such as
`"Postgres replan persistence goal"`.

- [ ] **Step 3: Run failing store tests**

Run:

```powershell
npm test -- tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts
```

Expected: missing `recordGoalReplanClassification` and missing analysis fields.

- [ ] **Step 4: Extend store interface and in-memory implementation**

In `src/domain/projectManager/store.ts`, extend `RecordProjectAnalysisInput`
through the type changes from Task 1 and add:

```typescript
export interface RecordGoalReplanClassificationInput {
  goalId: string;
  analysisId: string;
  classification: ProjectGoalReplanClassification;
}
```

Add to `ProjectManagerStore`:

```typescript
recordGoalReplanClassification(
  input: RecordGoalReplanClassificationInput,
): Promise<ProjectGoalAuditEvent>;
```

Update in-memory `recordAnalysis` to include:

```typescript
...(input.previousAnalysisId ? { previousAnalysisId: input.previousAnalysisId } : {}),
goalReplans: structuredClone(input.goalReplans ?? []),
```

Implement:

```typescript
public async recordGoalReplanClassification(
  input: RecordGoalReplanClassificationInput,
): Promise<ProjectGoalAuditEvent> {
  this.requireGoal(input.goalId);
  const event = this.appendGoalEvent(input.goalId, {
    kind: "project_goal_replan_classified",
    message: input.classification.rationale,
    payload: {
      analysisId: input.analysisId,
      decision: input.classification.decision,
      rationale: input.classification.rationale,
      evidenceRefs: structuredClone(input.classification.evidenceRefs),
      followUpGoals: structuredClone(input.classification.followUpGoals),
      ...(input.classification.humanQuestion
        ? { humanQuestion: input.classification.humanQuestion }
        : {}),
    },
  });
  return structuredClone(event);
}
```

Adjust `appendGoalEvent` to return the created event.

- [ ] **Step 5: Add migration**

Create `src/integrations/internalTracker/migrations/0008_project_manager_replans.sql`:

```sql
ALTER TABLE project_analyses
  ADD COLUMN IF NOT EXISTS previous_analysis_id text NULL,
  ADD COLUMN IF NOT EXISTS goal_replans jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS project_analyses_previous_analysis_idx
  ON project_analyses(previous_analysis_id)
  WHERE previous_analysis_id IS NOT NULL;
```

Add `project_analyses_previous_analysis_idx` to
`REQUIRED_INTERNAL_TRACKER_INDEXES` in `migrations.ts`.

- [ ] **Step 6: Update PostgreSQL mapping and methods**

In `postgresProjectManagerStore.ts`, extend `ProjectAnalysisRow` with
`previous_analysis_id` and `goal_replans`. Update `mapAnalysisRow`:

```typescript
previousAnalysisId: row.previous_analysis_id ?? undefined,
goalReplans: parseJsonArray(row.goal_replans),
```

Update `recordAnalysis` SQL:

```sql
INSERT INTO project_analyses (
  id, repository_name, summary, health_signals, proposed_goals,
  stale_goal_ids, replan_reason, previous_analysis_id, goal_replans, created_at
)
VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10)
```

Bind `input.previousAnalysisId ?? null` and
`JSON.stringify(input.goalReplans ?? [])`.

Implement `recordGoalReplanClassification` by inserting into
`project_goal_events` with `kind='project_goal_replan_classified'` and the same
payload shape used by the in-memory store.

- [ ] **Step 7: Run store tests**

Run:

```powershell
npm test -- tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts
```

Expected: in-memory tests pass; PostgreSQL tests run when
`TASK_TRACKER_TEST_DATABASE_URL` is set.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src/domain/projectManager/store.ts src/integrations/internalTracker/migrations.ts src/integrations/internalTracker/migrations/0008_project_manager_replans.sql src/integrations/internalTracker/postgresProjectManagerStore.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts
git commit -m "feat: persist project manager replan decisions"
```

---

## Task 3: Replan Snapshot Builder

**Files:**

- Create: `src/domain/projectManager/replanSnapshot.ts`
- Modify: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerSignals.test.ts`

- [ ] **Step 1: Add failing snapshot tests**

Add to `tests/projectManagerSignals.test.ts`:

```typescript
it("collects active goals with linked task summaries for replanning", async () => {
  const task = taskRecord({
    id: "task-linked",
    title: "Linked failed task",
    status: "failed",
    repositoryName: "developer",
  });
  const tracker = trackerWithTasks([task]);
  const store = new InMemoryProjectManagerStore({ now: () => new Date(baseTime) });
  const [goal] = await store.createGoalsFromAnalysis({
    sourceAnalysisId: "analysis-1",
    sourceRunId: "run-1",
    repositoryName: "developer",
    goals: [goalDraft({ title: "Stabilize linked task" })],
  });
  await store.approveGoal(goal.id, { actor });
  await store.activateGoal(goal.id, { actor });
  await store.linkGoalTask({
    goalId: goal.id,
    taskId: task.id,
    linkType: "proposed_task",
  });

  const snapshot = await collectProjectReplanSnapshot({
    taskTracker: tracker,
    store,
    repositoryName: "developer",
    replanReason: "manual: failed linked task",
    now: () => new Date(baseTime),
  });

  expect(snapshot.goals).toEqual([
    expect.objectContaining({
      goal: expect.objectContaining({ id: goal.id, status: "active" }),
      linkedTasks: [
        expect.objectContaining({
          id: "task-linked",
          title: "Linked failed task",
          status: "failed",
        }),
      ],
    }),
  ]);
});
```

- [ ] **Step 2: Run failing snapshot tests**

Run:

```powershell
npm test -- tests/projectManagerSignals.test.ts
```

Expected: missing `collectProjectReplanSnapshot`.

- [ ] **Step 3: Implement snapshot types and builder**

Create `src/domain/projectManager/replanSnapshot.ts`:

```typescript
import type { TaskTrackerClient, TaskRecord } from "../taskTracker/types.js";
import { collectProjectSignals } from "./signalCollector.js";
import type { ProjectManagerStore } from "./store.js";
import type { ProjectGoal, ProjectGoalAuditEvent, ProjectSignalSnapshot } from "./types.js";

export interface ProjectReplanTaskSummary {
  id: string;
  title: string;
  status: string;
  repositoryName?: string;
  updatedAt: string;
  latestValidationSummary?: string;
  latestAiSummary?: string;
}

export interface ProjectReplanGoalSnapshot {
  goal: Pick<ProjectGoal, "id" | "title" | "status" | "priority" | "riskLevel" | "repositoryName" | "updatedAt">;
  linkedTasks: ProjectReplanTaskSummary[];
  auditEvents: ProjectGoalAuditEvent[];
}

export interface ProjectReplanSnapshot {
  repositoryName: string;
  generatedAt: string;
  replanReason: string;
  previousAnalysisId?: string;
  projectSignals: ProjectSignalSnapshot;
  goals: ProjectReplanGoalSnapshot[];
}
```

Implement `collectProjectReplanSnapshot`:

```typescript
const taskSummary = (task: TaskRecord): ProjectReplanTaskSummary => ({
  id: task.id,
  title: task.title,
  status: task.status,
  repositoryName: task.repositoryName,
  updatedAt: task.updatedAt,
  latestValidationSummary: task.qualityGateRuns.at(-1)?.summary,
  latestAiSummary: task.agentRuns.at(-1)?.summary,
});

export const collectProjectReplanSnapshot = async (input: {
  taskTracker: TaskTrackerClient;
  store: ProjectManagerStore;
  repositoryName: string;
  replanReason: string;
  now?: () => Date;
}): Promise<ProjectReplanSnapshot> => {
  const projectSignals = await collectProjectSignals({
    taskTracker: input.taskTracker,
    repositoryName: input.repositoryName,
  });
  const analyses = await input.store.listAnalyses();
  const previousAnalysis = analyses
    .filter((analysis) => analysis.repositoryName === input.repositoryName)
    .at(-1);
  const goals = await input.store.listGoals({
    repositoryName: input.repositoryName,
    status: ["approved", "active"],
  });
  const goalSnapshots = await Promise.all(
    goals.map(async (goal) => {
      const links = await input.store.listGoalTaskLinks(goal.id);
      const linkedTasks = await Promise.all(
        links.map(async (link) => taskSummary(await input.taskTracker.getTask(link.taskId))),
      );
      return {
        goal: {
          id: goal.id,
          title: goal.title,
          status: goal.status,
          priority: goal.priority,
          riskLevel: goal.riskLevel,
          repositoryName: goal.repositoryName,
          updatedAt: goal.updatedAt,
        },
        linkedTasks,
        auditEvents: await input.store.listGoalEvents(goal.id),
      };
    }),
  );
  return {
    repositoryName: input.repositoryName,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    replanReason: input.replanReason,
    ...(previousAnalysis ? { previousAnalysisId: previousAnalysis.id } : {}),
    projectSignals,
    goals: goalSnapshots,
  };
};
```

- [ ] **Step 4: Export snapshot builder**

In `src/domain/projectManager/index.ts`:

```typescript
export {
  collectProjectReplanSnapshot,
  type ProjectReplanSnapshot,
} from "./replanSnapshot.js";
```

- [ ] **Step 5: Run snapshot tests**

Run:

```powershell
npm test -- tests/projectManagerSignals.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit Task 3**

```powershell
git add src/domain/projectManager/replanSnapshot.ts src/domain/projectManager/index.ts tests/projectManagerSignals.test.ts
git commit -m "feat: collect project manager replan snapshots"
```

---

## Task 4: Orchestrator Replan Flow And Metrics

**Files:**

- Modify: `src/domain/projectManager/orchestrator.ts`
- Test: `tests/projectManagerOrchestrator.test.ts`

- [ ] **Step 1: Add failing orchestrator tests**

Add a readonly tracker fixture whose `getTask` returns linked tasks but all
mutating methods throw. Add tests:

```typescript
it("stores a completed replan run and audit decisions without mutating tasks", async () => {
  const tracker = readonlyTrackerWithGetTask([
    baseTask({ id: "task-linked", status: "failed", title: "Linked failed task" }),
  ]);
  const store = new InMemoryProjectManagerStore({ now: () => new Date(baseTime) });
  const [goal] = await store.createGoalsFromAnalysis({
    sourceAnalysisId: "analysis-1",
    sourceRunId: "run-1",
    repositoryName: "developer",
    goals: [validGoal()],
  });
  await store.approveGoal(goal.id, { actor: { owner: "human", id: "dev-1" } });
  await store.activateGoal(goal.id, { actor: { owner: "human", id: "dev-1" } });
  await store.linkGoalTask({ goalId: goal.id, taskId: "task-linked", linkType: "proposed_task" });
  const codex = new FakeCodexRunner(
    codexExecution(
      `PROJECT_REPLAN: ${JSON.stringify({
        summary: "Failed linked task needs a smaller follow-up.",
        healthSignals: [],
        proposedGoals: [validGoal({ title: "Smaller follow-up goal" })],
        staleGoalIds: [],
        replanReason: "manual: failed linked task",
        previousAnalysisId: "analysis-1",
        goalReplans: [
          {
            goalId: goal.id,
            decision: "create_follow_up",
            rationale: "Linked task failed.",
            evidenceRefs: [],
            followUpGoals: [],
          },
        ],
      })}`,
    ),
  );
  const orchestrator = new ProjectManagerOrchestrator({
    taskTracker: tracker,
    codex,
    store,
    config,
  });

  const result = await orchestrator.runReplanOnce({
    repositoryName: "developer",
    replanReason: "manual: failed linked task",
  });

  expect(result.run).toMatchObject({ trigger: "manual", status: "completed" });
  expect(result.analysis.goalReplans).toHaveLength(1);
  await expect(store.listGoals({ repositoryName: "developer" })).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: goal.id, status: "active" }),
      expect.objectContaining({ title: "Smaller follow-up goal", status: "proposed" }),
    ]),
  );
  await expect(store.listGoalEvents(goal.id)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "project_goal_replan_classified" }),
    ]),
  );
  expectTrackerMutationsUnused(tracker);
});
```

Add another test for safe completion:

```typescript
it("completes active goals only when mark_completed has all linked tasks done", async () => {
  const tracker = readonlyTrackerWithGetTask([
    baseTask({ id: "task-done", status: "done" }),
  ]);
  const store = new InMemoryProjectManagerStore({ now: () => new Date(baseTime) });
  const [goal] = await createActiveGoalWithLink(store, "task-done");
  const codex = new FakeCodexRunner(
    codexExecution(
      `PROJECT_REPLAN: ${JSON.stringify({
        summary: "Goal is done.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        replanReason: "manual: all linked work done",
        goalReplans: [
          {
            goalId: goal.id,
            decision: "mark_completed",
            rationale: "All linked tasks are done.",
            evidenceRefs: [],
            followUpGoals: [],
          },
        ],
      })}`,
    ),
  );
  const orchestrator = new ProjectManagerOrchestrator({ taskTracker: tracker, codex, store, config });

  await orchestrator.runReplanOnce({
    repositoryName: "developer",
    replanReason: "manual: all linked work done",
  });

  await expect(store.getGoal(goal.id)).resolves.toMatchObject({ status: "completed" });
});
```

- [ ] **Step 2: Run failing orchestrator tests**

Run:

```powershell
npm test -- tests/projectManagerOrchestrator.test.ts
```

Expected: `runReplanOnce` is missing.

- [ ] **Step 3: Add metrics to orchestrator input**

In `orchestrator.ts`, import `MetricsRegistry` and `NoopMetricsRegistry`.
Extend input:

```typescript
metrics?: MetricsRegistry;
```

Store:

```typescript
private readonly metrics: MetricsRegistry;
```

Constructor:

```typescript
this.metrics = input.metrics ?? new NoopMetricsRegistry();
```

- [ ] **Step 4: Implement `runReplanOnce`**

Add interfaces:

```typescript
export interface RunProjectReplanOnceInput {
  repositoryName: string;
  replanReason: string;
  trigger?: ProjectManagerTrigger;
}

export interface RunProjectReplanOnceResult {
  run: ProjectManagerRun;
  analysis: ProjectAnalysis;
}
```

Implement:

```typescript
public async runReplanOnce(
  input: RunProjectReplanOnceInput,
): Promise<RunProjectReplanOnceResult> {
  if (!this.config.enabled) {
    throw new Error("Project manager is disabled.");
  }
  if (!input.replanReason.trim()) {
    throw new Error("replanReason is required.");
  }
  const run = await this.store.startRun({
    repositoryName: input.repositoryName,
    trigger: input.trigger ?? "manual",
  });
  try {
    const snapshot = await collectProjectReplanSnapshot({
      taskTracker: this.taskTracker,
      store: this.store,
      repositoryName: input.repositoryName,
      replanReason: input.replanReason,
    });
    const prompt = buildProjectReplanPrompt({
      snapshot,
      maxGoalsPerRun: this.config.maxGoalsPerRun,
      maxTaskProposalsPerGoal: this.config.maxTaskProposalsPerGoal,
      allowedTaskTypes: this.config.allowedTaskTypes,
      focusAreas: this.focusAreas,
    });
    const execution = await this.codex.runInitial(prompt, undefined, {
      sandbox: "read-only",
    });
    if (execution.process.exitCode !== 0) {
      throw new Error(`Codex project replan failed with exit code ${execution.process.exitCode}.`);
    }
    const parsed = parseProjectReplanResponse(execution.finalMessage);
    if (!parsed) {
      throw new Error("Codex response must be valid PROJECT_REPLAN output.");
    }
    assertProjectReplanWithinPolicy({
      parsed,
      config: this.config,
      activeGoalIds: new Set(snapshot.goals.map((entry) => entry.goal.id)),
    });
    const analysis = await this.store.recordAnalysis({
      repositoryName: input.repositoryName,
      ...parsed,
    });
    const goals = await this.store.createGoalsFromAnalysis({
      repositoryName: input.repositoryName,
      sourceAnalysisId: analysis.id,
      sourceRunId: run.id,
      goals: analysis.proposedGoals,
    });
    await this.applyReplanClassifications(analysis.id, parsed.goalReplans, snapshot);
    const completedRun = await this.store.completeRun(run.id, {
      analysisId: analysis.id,
      proposedGoalIds: goals.map((goal) => goal.id),
      proposedTaskIds: [],
    });
    this.recordProjectManagerRunMetric(input.repositoryName, "replan", input.trigger ?? "manual", "completed");
    return { run: completedRun, analysis };
  } catch (error) {
    await this.store.failRun(run.id, diagnosticFor(error));
    this.recordProjectManagerRunMetric(input.repositoryName, "replan", input.trigger ?? "manual", "failed");
    throw error;
  }
}
```

- [ ] **Step 5: Implement safe classification application**

Add private helpers:

```typescript
private async applyReplanClassifications(
  analysisId: string,
  classifications: ProjectGoalReplanClassification[],
  snapshot: ProjectReplanSnapshot,
): Promise<void> {
  const snapshotByGoalId = new Map(snapshot.goals.map((entry) => [entry.goal.id, entry]));
  for (const classification of classifications) {
    await this.store.recordGoalReplanClassification({
      goalId: classification.goalId,
      analysisId,
      classification,
    });
    this.metrics.incrementCounter("ai_developer_project_replans_total", {
      repository: snapshot.repositoryName,
      decision: classification.decision,
    });
    if (classification.decision === "mark_completed") {
      const goalSnapshot = snapshotByGoalId.get(classification.goalId);
      if (goalSnapshot && this.canCompleteGoalFromSnapshot(goalSnapshot)) {
        await this.store.completeGoal(classification.goalId, {
          actor: { owner: "system", id: "project-manager-replan" },
        });
      }
    }
  }
}

private canCompleteGoalFromSnapshot(snapshot: ProjectReplanGoalSnapshot): boolean {
  return snapshot.goal.status === "active" &&
    snapshot.linkedTasks.length > 0 &&
    snapshot.linkedTasks.every((task) => task.status === "done");
}
```

- [ ] **Step 6: Add metric helpers**

```typescript
private recordProjectManagerRunMetric(
  repositoryName: string,
  mode: "analysis" | "replan",
  trigger: ProjectManagerTrigger,
  status: "completed" | "failed",
): void {
  this.metrics.incrementCounter("ai_developer_project_manager_runs_total", {
    repository: repositoryName,
    mode,
    trigger,
    status,
  });
}
```

Call it from existing `runAnalysisOnce` success/failure too with
`mode: "analysis"`.

- [ ] **Step 7: Run orchestrator tests**

Run:

```powershell
npm test -- tests/projectManagerOrchestrator.test.ts
npm run typecheck
```

- [ ] **Step 8: Commit Task 4**

```powershell
git add src/domain/projectManager/orchestrator.ts tests/projectManagerOrchestrator.test.ts
git commit -m "feat: add project manager replan orchestrator"
```

---

## Task 5: Human API Replan Mode

**Files:**

- Modify: `src/observability/taskTrackerHumanApi.ts`
- Test: `tests/humanTaskApi.test.ts`

- [ ] **Step 1: Add failing API tests**

Add to `tests/humanTaskApi.test.ts`:

```typescript
it("allows operators to run project manager replans", async () => {
  const runner = {
    runAnalysisOnce: vi.fn(),
    runReplanOnce: vi.fn(async () => ({
      run: { id: "pm_run_replan", repositoryName: "developer", trigger: "manual", status: "completed", proposedGoalIds: [], proposedTaskIds: [], startedAt: now, completedAt: now },
      analysis: { id: "pm_analysis_replan", repositoryName: "developer", summary: "Replanned.", healthSignals: [], proposedGoals: [], staleGoalIds: [], replanReason: "manual", goalReplans: [], createdAt: now },
    })),
  };
  const { baseUrl } = await createServer(new InMemoryTaskTrackerClient(), {}, {
    store: new InMemoryProjectManagerStore(),
    runner,
  });

  const response = await requestJson(baseUrl, "/api/project-manager/runs", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      repositoryName: "developer",
      mode: "replan",
      replanReason: "manual: failed linked task",
    }),
  });

  expect(response.status).toBe(200);
  expect(runner.runReplanOnce).toHaveBeenCalledWith({
    repositoryName: "developer",
    trigger: "manual",
    replanReason: "manual: failed linked task",
  });
});

it("rejects replans without a reason", async () => {
  const { baseUrl } = await createServer(new InMemoryTaskTrackerClient(), {}, {
    store: new InMemoryProjectManagerStore(),
    runner: fakeProjectManagerRunner(),
  });

  const response = await requestJson(baseUrl, "/api/project-manager/runs", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ repositoryName: "developer", mode: "replan" }),
  });

  expect(response.status).toBe(400);
});
```

- [ ] **Step 2: Run failing API tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts
```

Expected: runner type/API route does not support `runReplanOnce`.

- [ ] **Step 3: Extend API dependency type**

In `taskTrackerHumanApi.ts`, extend `ProjectManagerApiDependencies.runner`:

```typescript
runReplanOnce(input: {
  repositoryName: string;
  trigger?: ProjectManagerTrigger;
  replanReason: string;
}): Promise<unknown>;
```

- [ ] **Step 4: Route by mode**

In `/api/project-manager/runs` handling:

```typescript
const mode = optionalString(body.mode) ?? "analysis";
if (mode === "replan") {
  const result = await this.requireProjectManagerRunner().runReplanOnce({
    repositoryName: requiredString(body.repositoryName, "repositoryName"),
    trigger: "manual",
    replanReason: requiredString(body.replanReason, "replanReason"),
  });
  json(response, 200, { result });
  return true;
}
if (mode !== "analysis") {
  throw new Error("mode must be one of: analysis, replan.");
}
```

Keep the existing analysis path unchanged after this block.

- [ ] **Step 5: Run API tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit Task 5**

```powershell
git add src/observability/taskTrackerHumanApi.ts tests/humanTaskApi.test.ts
git commit -m "feat: expose project manager replan api"
```

---

## Task 6: Angular Goal Detail Replan UI

**Files:**

- Modify: `web/src/app/models/human-api.dto.ts`
- Modify: `web/src/app/services/task-mappers.ts`
- Modify: `web/src/app/services/project-goal.service.ts`
- Modify: `web/src/app/pages/goal-detail-page.component.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`
- Test: `web/src/app/services/project-goal.service.spec.ts`

- [ ] **Step 1: Add failing service test**

In `project-goal.service.spec.ts`, add:

```typescript
it('runs project replans with mode and reason', () => {
  service.runReplan('developer', 'manual: failed linked task').subscribe();

  const request = http.expectOne('/api/project-manager/runs');
  expect(request.request.method).toBe('POST');
  expect(request.request.body).toEqual({
    repositoryName: 'developer',
    mode: 'replan',
    replanReason: 'manual: failed linked task',
  });
  request.flush({ result: { run: { id: 'pm_run_1' } } });
});
```

- [ ] **Step 2: Add failing component test**

In `workflow-pages.spec.ts`, add a goal detail test:

```typescript
it('lets operators run replans from goal detail and renders replan audit events', async () => {
  const http = await configure([GoalDetailPageComponent], [
    { provide: ActivatedRoute, useValue: routeWithParam('goalId', approvedProjectGoal.id) },
  ]);
  loadSession(http, pmOperatorSession);

  const fixture = TestBed.createComponent(GoalDetailPageComponent);
  fixture.detectChanges();
  http.expectOne(`/api/project-goals/${approvedProjectGoal.id}`).flush({
    ...goalDetailWith(approvedProjectGoal),
    auditEvents: [
      {
        id: 'evt-replan',
        goalId: approvedProjectGoal.id,
        kind: 'project_goal_replan_classified',
        message: 'Linked task failed.',
        payload: { decision: 'create_follow_up', rationale: 'Linked task failed.' },
        createdAt: now,
      },
    ],
  });
  fixture.detectChanges();

  expect((fixture.nativeElement as HTMLElement).textContent).toContain('create_follow_up');
  (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="goal-run-replan"]')?.click();
  fixture.detectChanges();
  const textarea = (fixture.nativeElement as HTMLElement).querySelector<HTMLTextAreaElement>('[data-testid="goal-replan-reason"]')!;
  textarea.value = 'manual: failed linked task';
  textarea.dispatchEvent(new Event('input'));
  (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="goal-replan-confirm"]')?.click();

  const request = http.expectOne('/api/project-manager/runs');
  expect(request.request.body).toEqual({
    repositoryName: 'developer',
    mode: 'replan',
    replanReason: 'manual: failed linked task',
  });
});
```

- [ ] **Step 3: Implement service method**

In `project-goal.service.ts`:

```typescript
runReplan(repositoryName: string, replanReason: string): Observable<unknown> {
  return this.api.post<{ repositoryName: string; mode: string; replanReason: string }, unknown>(
    '/project-manager/runs',
    { repositoryName, mode: 'replan', replanReason },
  );
}
```

- [ ] **Step 4: Add DTO typing for audit payload**

In `human-api.dto.ts`, keep `ProjectGoalAuditEventDto.payload` as
`Record<string, unknown>` and add no extra hard dependency. In
`task-mappers.ts`, ensure payload is preserved as a plain record.

- [ ] **Step 5: Implement goal detail UI**

In `goal-detail-page.component.ts`:

- Add a `goal-run-replan` button visible when `canRunProjectManager()`.
- Add a dialog with textarea `data-testid="goal-replan-reason"` and confirm
  button `data-testid="goal-replan-confirm"`.
- On confirm, reject empty reasons locally and call
  `this.goalsApi.runReplan(this.detail()?.goal.repositoryName ?? '', reason)`.
- Refresh detail after success.
- In audit rendering, if `event.kind === 'project_goal_replan_classified'`,
  display `event.payload?.['decision']` and `event.payload?.['rationale']`.

- [ ] **Step 6: Run Angular tests**

Run:

```powershell
npm run web:test
npm run web:typecheck
```

- [ ] **Step 7: Commit Task 6**

```powershell
git add web/src/app/models/human-api.dto.ts web/src/app/services/task-mappers.ts web/src/app/services/project-goal.service.ts web/src/app/pages/goal-detail-page.component.ts web/src/app/pages/workflow-pages.spec.ts web/src/app/services/project-goal.service.spec.ts
git commit -m "feat: add project goal replan controls"
```

---

## Task 7: Playwright Replan Flow

**Files:**

- Modify: `web/e2e/mock-console-server.mjs`
- Modify: `web/e2e/console-critical-flows.spec.ts`

- [ ] **Step 1: Extend mock server**

In `mock-console-server.mjs`, update `POST /api/project-manager/runs`:

```javascript
if (body.mode === 'replan') {
  const goal = state.projectGoals.get('pm-goal-low-risk');
  const events = state.goalEvents.get(goal.id) || [];
  events.push({
    id: `goal-event-${goal.id}-replan-${events.length + 1}`,
    goalId: goal.id,
    kind: 'project_goal_replan_classified',
    message: body.replanReason,
    payload: {
      decision: 'create_follow_up',
      rationale: 'Mock replan found a smaller follow-up after linked task status changed.',
    },
    createdAt: now(),
  });
  state.goalEvents.set(goal.id, events);
  json(response, 200, {
    result: {
      run: {
        id: `pm-run-replan-${Date.now()}`,
        repositoryName: body.repositoryName || 'developer',
        trigger: 'manual',
        status: 'completed',
        proposedGoalIds: [],
        proposedTaskIds: [],
        startedAt: now(),
        completedAt: now(),
      },
      analysis: {
        id: `pm-analysis-replan-${Date.now()}`,
        repositoryName: body.repositoryName || 'developer',
        summary: 'Mock replan completed.',
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        replanReason: body.replanReason,
        goalReplans: [],
        createdAt: now(),
      },
    },
  });
  return;
}
```

- [ ] **Step 2: Add Playwright replan test**

In `console-critical-flows.spec.ts`, add:

```typescript
test('runs a manual project goal replan without exposing it to viewers', async ({ browser }) => {
  const operator = await newRolePage(browser, 'operator');
  const page = operator.page;

  await page.goto('/tasks/goals/pm-goal-low-risk');
  await expect(page.getByTestId('goal-detail-page')).toBeVisible();
  await page.getByTestId('goal-run-replan').click();
  await page.getByTestId('goal-replan-reason').fill('manual: linked task failed');
  await page.getByTestId('goal-replan-confirm').click();
  await expect(page.getByTestId('goal-detail-page')).toContainText('create_follow_up');
  await operator.close();

  const viewer = await newRolePage(browser, 'viewer');
  await viewer.page.goto('/tasks/goals/pm-goal-low-risk');
  await expect(viewer.page.getByTestId('goal-detail-page')).toBeVisible();
  await expect(viewer.page.getByTestId('goal-run-replan')).toHaveCount(0);
  await viewer.close();
});
```

- [ ] **Step 3: Run E2E**

Run:

```powershell
npm run web:e2e
```

- [ ] **Step 4: Commit Task 7**

```powershell
git add web/e2e/mock-console-server.mjs web/e2e/console-critical-flows.spec.ts
git commit -m "test: cover project manager replan flow"
```

---

## Task 8: Final Docs, Verification, And Review

**Files:**

- Modify: `docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md`

- [ ] **Step 1: Update PM-5 roadmap status**

Under `### Phase PM-5 - Replanning loop`, add:

```markdown
**Status:** implemented in `<branch-name>`. PM-5 adds a manual/event-ready
replanning loop without a scheduler, stores replan classifications, records goal
audit events, exposes replan through the human API, and shows replan decisions
in the goals UI.
```

- [ ] **Step 2: Run focused PM tests**

Run:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts tests/projectManagerSignals.test.ts tests/projectManagerOrchestrator.test.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts tests/humanTaskApi.test.ts
```

If `TASK_TRACKER_TEST_DATABASE_URL` is unset, note that real PostgreSQL
integration tests are skipped.

- [ ] **Step 3: Run full backend checks**

Run:

```powershell
npm run typecheck
npm test
```

- [ ] **Step 4: Run full web checks**

Run:

```powershell
npm run web:typecheck
npm run web:test
npm run web:e2e
```

- [ ] **Step 5: Remove generated Playwright output**

Run:

```powershell
if (Test-Path 'web/test-results') {
  $target = Resolve-Path -LiteralPath 'web/test-results'
  $root = Resolve-Path -LiteralPath '.'
  if (-not $target.Path.StartsWith($root.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove outside workspace: $($target.Path)"
  }
  Remove-Item -LiteralPath $target.Path -Recurse -Force
}
```

- [ ] **Step 6: Request code review subagent**

Ask a review subagent to inspect the PM-5 diff for:

- replan safety invariants
- no direct `createTask`/`proposeTask`/approval bypass in replan
- policy validation for goal ids and `mark_completed`
- PostgreSQL migration compatibility
- API backward compatibility for `mode` defaulting to analysis
- Angular role gating
- Playwright mock realism

Fix Critical and Important findings.

- [ ] **Step 7: Commit final status docs**

```powershell
git add docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md
git commit -m "docs: update project manager pm5 status"
```

---

## Safety Checklist

- [ ] PM-5 does not add a scheduler.
- [ ] Replan orchestrator uses Codex with `sandbox: "read-only"`.
- [ ] Replan does not call `TaskTrackerClient.createTask`.
- [ ] Replan does not call `TaskTrackerClient.proposeTask`.
- [ ] Replan does not approve or reject task proposals.
- [ ] Follow-up work is represented as proposed goals or task proposal drafts.
- [ ] `mark_completed` auto-completes only active goals with at least one linked
  task and all linked tasks in `done`.
- [ ] Viewer cannot trigger replans.
- [ ] Developer cannot trigger replans unless they have operator role.
- [ ] Existing `POST /api/project-manager/runs` analysis mode remains backward
  compatible.

## Final Expected Verification

Run before claiming PM-5 complete:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts tests/projectManagerSignals.test.ts tests/projectManagerOrchestrator.test.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts tests/humanTaskApi.test.ts
npm run typecheck
npm test
npm run web:typecheck
npm run web:test
npm run web:e2e
```

If `TASK_TRACKER_TEST_DATABASE_URL` is unset, explicitly report that PostgreSQL
integration tests were skipped.
