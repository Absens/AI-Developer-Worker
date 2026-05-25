# Project Manager PM-2 Goal Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class Project Manager goals with storage, lifecycle commands, duplicate policy, API access, and PostgreSQL schema support.

**Architecture:** Extend the existing `ProjectManagerStore` as the PM persistence boundary. Keep PM storage separate from `TaskTrackerClient`; PM-2 may store/approve/reject goals and link goals to tasks, but must not create task proposals or executable tasks. Use in-memory storage for unit/API tests and a separate `PostgresProjectManagerStore` adapter beside the internal tracker.

**Tech Stack:** TypeScript ES modules, Vitest, Node HTTP API, PostgreSQL migration SQL, existing internal tracker migration runner.

---

## File Map

- Modify `src/domain/projectManager/types.ts`: add `ProjectGoal`, lifecycle metadata, audit event, filters, and link types.
- Modify `src/domain/projectManager/store.ts`: expand interface and in-memory implementation for goals, transitions, audit events, and links.
- Create `src/domain/projectManager/goalPolicy.ts`: duplicate signature and materialization policy helpers.
- Modify `src/domain/projectManager/orchestrator.ts`: after analysis persistence, materialize non-duplicate proposed goals and complete the run with IDs.
- Test `tests/projectManagerGoalStore.test.ts`: lifecycle and duplicate behavior for in-memory store/policy.
- Modify `tests/projectManagerOrchestrator.test.ts`: PM run creates proposed goals and skips duplicates without task mutations.
- Create `src/integrations/internalTracker/postgresProjectManagerStore.ts`: PostgreSQL `ProjectManagerStore` adapter.
- Create `src/integrations/internalTracker/migrations/0007_project_manager_goals.sql`: PM tables/indexes.
- Modify `src/integrations/internalTracker/migrations.ts` and `src/integrations/internalTracker/index.ts`: export/check new PM storage and schema relations.
- Modify `tests/hardening.test.ts`: migration/preflight coverage for PM-2 tables/indexes.
- Modify `src/observability/taskTrackerHumanApi.ts`, `src/observability/server.ts`, `src/observability/service.ts`, `src/app.ts`: optional PM store/runner wiring and HTTP routes.
- Modify `tests/humanTaskApi.test.ts`: goal read/approve/reject/run role tests.
- Update `docs/ENV_CONFIGURATION.md` or roadmap only if runtime behavior wording changes.

## Task 1: Goal Types, In-Memory Store, And Policy

**Files:**
- Modify: `src/domain/projectManager/types.ts`
- Modify: `src/domain/projectManager/store.ts`
- Create: `src/domain/projectManager/goalPolicy.ts`
- Modify: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerGoalStore.test.ts`

- [ ] **Step 1: Write failing goal store tests**

Add tests that:

- create proposed goals from drafts and expose `status: "proposed"`;
- append `project_goal_created`, `project_goal_approved`, `project_goal_rejected`, and `project_goal_stale` audit events;
- reject invalid lifecycle transitions such as approving a rejected goal;
- compute the same duplicate signature for equivalent titles/evidence order;
- skip duplicate non-terminal goals while allowing a new goal after the prior one is `rejected`, `stale`, or `completed`.

Run:

```bash
npm test -- tests/projectManagerGoalStore.test.ts
```

Expected before implementation: TypeScript/test failures because goal store methods and policy do not exist.

- [ ] **Step 2: Implement domain types**

Add these concepts to `src/domain/projectManager/types.ts`:

```ts
export const PROJECT_GOAL_TERMINAL_STATUSES = ["completed", "rejected", "stale"] as const;

export interface ProjectGoal {
  id: string;
  repositoryName: string;
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  successMetrics: string[];
  evidenceRefs: EvidenceRef[];
  priority: ProjectGoalPriority;
  riskLevel: ProjectGoalRiskLevel;
  status: ProjectGoalStatus;
  sourceAnalysisId: string;
  sourceRunId?: string;
  duplicateSignature: string;
  approvedBy?: TaskActor;
  approvedAt?: string;
  rejectedBy?: TaskActor;
  rejectedAt?: string;
  rejectionReason?: string;
  staleReason?: string;
  staleAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

Also add `ProjectGoalAuditEvent`, `ProjectGoalTaskLink`, `ListProjectGoalsInput`, `CreateProjectGoalInput`, `ApproveProjectGoalInput`, `RejectProjectGoalInput`, `MarkProjectGoalStaleInput`, and `LinkProjectGoalTaskInput`.

- [ ] **Step 3: Implement goal policy**

Create `src/domain/projectManager/goalPolicy.ts` with:

```ts
export const normalizeProjectGoalTitle = (title: string): string =>
  title.trim().toLowerCase().replace(/\s+/g, " ");

export const buildProjectGoalDuplicateSignature = (input: {
  repositoryName: string;
  title: string;
  evidenceRefs: EvidenceRef[];
}): string => { /* stable hash of repository/title/evidence identity */ };
```

Use `node:crypto` SHA-256 and include sorted unique evidence identities `${kind}:${ref.trim().toLowerCase()}`.

- [ ] **Step 4: Extend `ProjectManagerStore` and in-memory implementation**

Add store methods:

```ts
createGoalsFromAnalysis(input: CreateProjectGoalsFromAnalysisInput): Promise<ProjectGoal[]>;
listGoals(input?: ListProjectGoalsInput): Promise<ProjectGoal[]>;
getGoal(goalId: string): Promise<ProjectGoal>;
approveGoal(goalId: string, input: ApproveProjectGoalInput): Promise<ProjectGoal>;
rejectGoal(goalId: string, input: RejectProjectGoalInput): Promise<ProjectGoal>;
markGoalStale(goalId: string, input: MarkProjectGoalStaleInput): Promise<ProjectGoal>;
listGoalEvents(goalId: string): Promise<ProjectGoalAuditEvent[]>;
linkGoalTask(input: LinkProjectGoalTaskInput): Promise<ProjectGoalTaskLink>;
listGoalTaskLinks(goalId: string): Promise<ProjectGoalTaskLink[]>;
```

`createGoalsFromAnalysis` must skip duplicate non-terminal goals and return only newly created goals.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- tests/projectManagerGoalStore.test.ts
npm run typecheck
```

Commit:

```bash
git add src/domain/projectManager tests/projectManagerGoalStore.test.ts
git commit -m "feat: add project manager goal store"
```

## Task 2: Orchestrator Goal Materialization

**Files:**
- Modify: `src/domain/projectManager/orchestrator.ts`
- Test: `tests/projectManagerOrchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator tests**

Add tests proving:

- a successful PM analysis records proposed goals and `run.proposedGoalIds`;
- duplicate analysis output does not create duplicate non-terminal goals;
- task tracker mutating methods remain unused.

Run:

```bash
npm test -- tests/projectManagerOrchestrator.test.ts
```

Expected before implementation: proposed goal IDs are empty.

- [ ] **Step 2: Materialize goals after analysis**

In `runAnalysisOnce`, after `recordAnalysis`, call:

```ts
const goals = await this.store.createGoalsFromAnalysis({
  repositoryName: input.repositoryName,
  analysisId: analysis.id,
  runId: run.id,
  goals: analysis.proposedGoals,
});
```

Then complete the run with `proposedGoalIds: goals.map((goal) => goal.id)` and keep `proposedTaskIds: []`.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm test -- tests/projectManagerOrchestrator.test.ts tests/projectManagerGoalStore.test.ts
npm run typecheck
```

Commit:

```bash
git add src/domain/projectManager tests/projectManagerOrchestrator.test.ts
git commit -m "feat: materialize project manager goals"
```

## Task 3: PostgreSQL PM Store And Migration

**Files:**
- Create: `src/integrations/internalTracker/postgresProjectManagerStore.ts`
- Create: `src/integrations/internalTracker/migrations/0007_project_manager_goals.sql`
- Modify: `src/integrations/internalTracker/migrations.ts`
- Modify: `src/integrations/internalTracker/index.ts`
- Test: `tests/projectManagerPostgresStore.test.ts`
- Modify: `tests/hardening.test.ts`

- [ ] **Step 1: Write failing adapter/migration tests**

Add tests for SQL mapping using a mock `PostgresQueryable`, plus migration preflight relation coverage.

Run:

```bash
npm test -- tests/projectManagerPostgresStore.test.ts tests/hardening.test.ts
```

Expected before implementation: missing module/migration relations.

- [ ] **Step 2: Add migration**

Create `0007_project_manager_goals.sql` with tables and indexes:

- `project_manager_runs`
- `project_analyses`
- `project_goals`
- `project_goal_events`
- `project_goal_tasks`
- `project_goals_active_duplicate_signature_unique_idx`
- repository/time/status indexes for list APIs.

Use JSONB for evidence and health signal payloads; keep status/check constraints explicit.

- [ ] **Step 3: Implement `PostgresProjectManagerStore`**

Implement all `ProjectManagerStore` methods using `PostgresQueryable`. Keep transactions around `createGoalsFromAnalysis` so duplicate checks and inserts are atomic.

- [ ] **Step 4: Register exports and operational checks**

Export `PostgresProjectManagerStore` from `src/integrations/internalTracker/index.ts` and add PM relations to `REQUIRED_INTERNAL_TRACKER_TABLES` / `REQUIRED_INTERNAL_TRACKER_INDEXES`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- tests/projectManagerPostgresStore.test.ts tests/hardening.test.ts
npm run typecheck
```

Commit:

```bash
git add src/integrations/internalTracker tests/projectManagerPostgresStore.test.ts tests/hardening.test.ts
git commit -m "feat: add project manager postgres storage"
```

## Task 4: Human API For Goals And Manual PM Runs

**Files:**
- Modify: `src/observability/taskTrackerHumanApi.ts`
- Modify: `src/observability/server.ts`
- Modify: `src/observability/service.ts`
- Modify: `src/app.ts`
- Test: `tests/humanTaskApi.test.ts`

- [ ] **Step 1: Write failing API tests**

Add tests for:

- viewer can `GET /api/project-goals`;
- viewer cannot approve/reject;
- developer can approve/reject proposed goals;
- operator can `POST /api/project-manager/runs`;
- PM routes return `503` when PM dependencies are absent;
- run endpoint does not require `TaskTrackerClient` if PM runner is present.

Run:

```bash
npm test -- tests/humanTaskApi.test.ts
```

Expected before implementation: routes are not recognized.

- [ ] **Step 2: Add optional PM dependencies**

Introduce an optional dependency shape:

```ts
interface ProjectManagerApiDependencies {
  store: ProjectManagerStore;
  runner?: Pick<ProjectManagerOrchestrator, "runAnalysisOnce">;
}
```

Thread it through `ObservabilityHttpServer` and `TaskTrackerHumanApi`. Keep all existing constructor arguments optional/backward compatible.

- [ ] **Step 3: Add routes**

Update `isApiRoute` and `handle` for:

- `/project-goals`
- `/project-goals/:id`
- `/project-goals/:id/commands/approve`
- `/project-goals/:id/commands/reject`
- `/project-manager/runs`

Use roles: viewer for reads, developer for approve/reject, operator for runs.

- [ ] **Step 4: Wire runtime app dependencies**

When `projectManager.enabled` and internal tracker mode are active, create a `ProjectManagerStore` matching storage mode:

- memory -> `InMemoryProjectManagerStore`
- postgres -> `PostgresProjectManagerStore`

Pass it to observability. If full PM runner construction needs more app wiring, keep runner optional and expose store-backed goal APIs now; tests cover explicit runner injection.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- tests/humanTaskApi.test.ts
npm run typecheck
```

Commit:

```bash
git add src/observability src/app.ts tests/humanTaskApi.test.ts
git commit -m "feat: expose project manager goal API"
```

## Task 5: Integration Verification And Docs

**Files:**
- Modify if needed: `docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md`
- Modify if needed: `docs/ENV_CONFIGURATION.md`

- [ ] **Step 1: Run focused PM suite**

```bash
npm test -- tests/projectManagerGoalStore.test.ts tests/projectManagerOrchestrator.test.ts tests/projectManagerPostgresStore.test.ts tests/humanTaskApi.test.ts tests/hardening.test.ts
```

- [ ] **Step 2: Run full verification**

```bash
npm run typecheck
npm test
git diff --check
```

- [ ] **Step 3: Request final subagent code review**

Review range should start at the PM-2 base commit before implementation and end at current HEAD. Critical/Important findings must be fixed before completion.

- [ ] **Step 4: Commit final docs or review fixes**

If docs changed:

```bash
git add docs
git commit -m "docs: update project manager pm2 status"
```

If review fixes changed code, commit with a focused fix message.
