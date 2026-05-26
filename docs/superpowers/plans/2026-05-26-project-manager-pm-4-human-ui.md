# Project Manager PM-4 Human UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the PM-4 human UI for project goals, goal actions, linked task proposals, and goal traceability in the Angular console.

**Architecture:** Add small backend response enrichments for goal/task links, then build Angular DTOs, services, `/goals`, `/goals/:goalId`, and parent-goal badges on proposals and task detail. Keep all PM work creation behind the existing `propose-tasks` endpoint and the existing task proposal approval path.

**Tech Stack:** TypeScript ES modules, Node.js `TaskTrackerHumanApi`, PM in-memory/PostgreSQL stores, Angular 20 standalone components, PrimeNG, Vitest, Karma/Jasmine, Playwright.

---

## Current Baseline

PM-3 is merged to `main`. The backend already supports listing/getting goals,
approve/reject, manual PM runs, and explicit task proposal generation through
`POST /api/project-goals/:id/commands/propose-tasks`.

The Angular console already has:

- `web/src/app/app.routes.ts`
- `web/src/app/app.ts`
- `web/src/app/models/human-api.dto.ts`
- `web/src/app/services/task-mappers.ts`
- `web/src/app/services/api-client.service.ts`
- `web/src/app/services/proposal.service.ts`
- `web/src/app/pages/proposals-page.component.ts`
- `web/src/app/components/task-detail-panel.component.ts`
- `web/src/app/pages/workflow-pages.spec.ts`
- `web/e2e/mock-console-server.mjs`
- `web/e2e/console-critical-flows.spec.ts`

## File Map

Backend:

- Modify `src/domain/projectManager/store.ts`: add batch lookup for goal-task
  links by task id.
- Modify `src/integrations/internalTracker/postgresProjectManagerStore.ts`:
  implement the batch lookup.
- Modify `src/observability/taskTrackerHumanApi.ts`: add PM-4 capabilities,
  complete/stale routes, goal list counts, linked task summaries, and linked
  goal summaries on proposal/task responses.
- Modify `tests/humanTaskApi.test.ts`: backend API coverage.

Angular:

- Modify `web/src/app/models/human-api.dto.ts`: add PM DTOs and optional linked
  goal fields.
- Modify `web/src/app/services/task-mappers.ts`: add PM mappers and parse
  optional linked goal fields.
- Create `web/src/app/services/project-goal.service.ts`: goal list/detail and
  command API wrapper.
- Modify `web/src/app/testing/human-api.fixtures.ts`: add PM goal fixtures.
- Modify `web/src/app/app.ts`: add goals nav item.
- Modify `web/src/app/app.routes.ts`: add `/goals` and `/goals/:goalId`.
- Create `web/src/app/pages/goals-page.component.ts`: goals list.
- Create `web/src/app/pages/goal-detail-page.component.ts`: goal detail and
  actions.
- Modify `web/src/app/pages/proposals-page.component.ts`: linked goal badges.
- Modify `web/src/app/components/task-detail-panel.component.ts`: parent goal
  section.
- Modify `web/src/app/pages/workflow-pages.spec.ts`: Angular workflow tests.
- Modify `web/src/app/app.spec.ts`: nav capability test if needed.

E2E:

- Modify `web/e2e/mock-console-server.mjs`: mock project goals endpoints,
  capabilities, goal links, and proposal generation.
- Modify `web/e2e/console-critical-flows.spec.ts`: PM-4 critical flows.

Docs:

- Update `docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md` PM-4 status after
  implementation completes and tests pass.

---

## Task 1: Backend Goal Link Lookup And Capabilities

**Files:**

- Modify: `src/domain/projectManager/store.ts`
- Modify: `src/integrations/internalTracker/postgresProjectManagerStore.ts`
- Modify: `src/observability/taskTrackerHumanApi.ts`
- Test: `tests/humanTaskApi.test.ts`
- Test: `tests/projectManagerGoalStore.test.ts`
- Test: `tests/projectManagerPostgresStore.test.ts`

- [ ] **Step 1: Add failing store tests for task-id link lookup**

Add in-memory coverage to `tests/projectManagerGoalStore.test.ts`:

```typescript
it("lists project goal task links by task ids", async () => {
  const store = new InMemoryProjectManagerStore({ now: clock.now });
  const [goal] = await store.createGoalsFromAnalysis({
    sourceAnalysisId: "analysis-1",
    sourceRunId: "run-1",
    repositoryName: "developer",
    goals: [goalDraft()],
  });
  const first = await store.linkGoalTask({
    goalId: goal.id,
    taskId: "task-1",
    linkType: "proposed_task",
  });
  await store.linkGoalTask({
    goalId: goal.id,
    taskId: "task-2",
    linkType: "proposed_task",
  });

  await expect(store.listGoalTaskLinksForTaskIds(["task-1", "missing"])).resolves.toEqual([
    first,
  ]);
  await expect(store.listGoalTaskLinksForTaskIds([])).resolves.toEqual([]);
});
```

Add matching PostgreSQL coverage to `tests/projectManagerPostgresStore.test.ts`
inside the existing database-gated block:

```typescript
it("lists goal task links by task ids", async () => {
  const [goal] = await store.createGoalsFromAnalysis({
    sourceAnalysisId: "analysis-pg-links",
    sourceRunId: "run-pg-links",
    repositoryName: "developer",
    goals: [goalDraft({ title: "Link lookup goal" })],
  });
  const first = await store.linkGoalTask({
    goalId: goal.id,
    taskId: "task-pg-1",
    linkType: "proposed_task",
  });
  await store.linkGoalTask({
    goalId: goal.id,
    taskId: "task-pg-2",
    linkType: "proposed_task",
  });

  await expect(store.listGoalTaskLinksForTaskIds(["task-pg-1", "missing"])).resolves.toEqual([
    first,
  ]);
});
```

- [ ] **Step 2: Run the failing focused store tests**

Run:

```powershell
npm test -- tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts
```

Expected: TypeScript/test failure because `listGoalTaskLinksForTaskIds` is not
defined yet.

- [ ] **Step 3: Implement the store interface and in-memory method**

In `src/domain/projectManager/store.ts`, extend `ProjectManagerStore`:

```typescript
listGoalTaskLinksForTaskIds(taskIds: string[]): Promise<ProjectGoalTaskLink[]>;
```

Add to `InMemoryProjectManagerStore`:

```typescript
public async listGoalTaskLinksForTaskIds(
  taskIds: string[],
): Promise<ProjectGoalTaskLink[]> {
  if (taskIds.length === 0) {
    return [];
  }
  const taskIdSet = new Set(taskIds);
  return [...this.goalTaskLinks.values()]
    .filter((link) => taskIdSet.has(link.taskId))
    .map((link) => structuredClone(link));
}
```

- [ ] **Step 4: Implement the PostgreSQL method**

In `src/integrations/internalTracker/postgresProjectManagerStore.ts`, add:

```typescript
public async listGoalTaskLinksForTaskIds(
  taskIds: string[],
): Promise<ProjectGoalTaskLink[]> {
  if (taskIds.length === 0) {
    return [];
  }
  const result = await this.pool.query(
    `
      SELECT id, goal_id, task_id, link_type, created_at
      FROM project_goal_tasks
      WHERE task_id = ANY($1::text[])
      ORDER BY created_at ASC, id ASC
    `,
    [taskIds],
  );
  return result.rows.map(mapProjectGoalTaskLinkRow);
}
```

Use the existing row mapper name if it differs; keep the SQL aligned with the
PM-2 table column names.

- [ ] **Step 5: Run the focused store tests again**

Run:

```powershell
npm test -- tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts
```

Expected: in-memory tests pass; PostgreSQL integration block runs only when
`TASK_TRACKER_TEST_DATABASE_URL` is set.

- [ ] **Step 6: Add failing API tests for PM-4 capabilities and commands**

In `tests/humanTaskApi.test.ts`, extend the session capability assertions:

```typescript
expect(session.body.capabilities).toMatchObject({
  canReadProjectGoals: true,
  canApproveProjectGoals: true,
  canProposeProjectGoalTasks: true,
  canCompleteProjectGoals: true,
  canMarkProjectGoalsStale: true,
});
```

Add tests:

```typescript
it("allows developers to complete active project goals", async () => {
  const { baseUrl, projectManagerStore, close } = await startApi();
  try {
    const goal = await createProjectGoal(projectManagerStore, { status: "approved" });
    await projectManagerStore.activateGoal(goal.id, { actor: human });

    const response = await requestJson(
      baseUrl,
      `/api/project-goals/${goal.id}/commands/complete`,
      { method: "POST", headers: developerHeaders },
    );

    expect(response.status).toBe(200);
    expect(response.body.goal.status).toBe("completed");
  } finally {
    await close();
  }
});

it("allows developers to mark project goals stale with a reason", async () => {
  const { baseUrl, projectManagerStore, close } = await startApi();
  try {
    const goal = await createProjectGoal(projectManagerStore);

    const response = await requestJson(
      baseUrl,
      `/api/project-goals/${goal.id}/commands/stale`,
      {
        method: "POST",
        headers: developerHeaders,
        body: JSON.stringify({ reason: "Superseded by a newer plan." }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.goal).toMatchObject({
      status: "stale",
      staleReason: "Superseded by a newer plan.",
    });
  } finally {
    await close();
  }
});
```

- [ ] **Step 7: Implement PM-4 capabilities and commands**

In `TaskTrackerHumanApi.buildSession`, add:

```typescript
canProposeProjectGoalTasks:
  canRole("operator") && hasProjectManagerStore && Boolean(this.input.tracker),
canCompleteProjectGoals: canRole("developer") && hasProjectManagerStore,
canMarkProjectGoalsStale: canRole("developer") && hasProjectManagerStore,
```

In `handleProjectManagerRoute`, add:

```typescript
if (suffix === "/commands/complete") {
  if (request.method !== "POST") {
    text(response, 405, "method not allowed");
    return true;
  }
  const auth = this.requireAuth(request, "developer");
  await this.readOptionalJson(request);
  const goal = await this.requireProjectManagerStore().completeGoal(goalId, {
    actor: auth.actor,
  });
  json(response, 200, { goal });
  return true;
}

if (suffix === "/commands/stale") {
  if (request.method !== "POST") {
    text(response, 405, "method not allowed");
    return true;
  }
  const auth = this.requireAuth(request, "developer");
  const body = requireObject(await this.readJson(request), "request body");
  const goal = await this.requireProjectManagerStore().markGoalStale(goalId, {
    actor: auth.actor,
    staleReason: requiredString(body.reason, "reason"),
  });
  json(response, 200, { goal });
  return true;
}
```

- [ ] **Step 8: Run focused API tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts tests/projectManagerGoalStore.test.ts
```

Expected: tests pass.

- [ ] **Step 9: Commit Task 1**

```powershell
git add src/domain/projectManager/store.ts src/integrations/internalTracker/postgresProjectManagerStore.ts src/observability/taskTrackerHumanApi.ts tests/humanTaskApi.test.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts
git commit -m "feat: expose project goal ui lifecycle api"
```

---

## Task 2: Backend Response Enrichment For Linked Goals And Tasks

**Files:**

- Modify: `src/observability/taskTrackerHumanApi.ts`
- Test: `tests/humanTaskApi.test.ts`

- [ ] **Step 1: Add failing API tests for linked goal data**

Add tests covering:

```typescript
it("includes linked task counts in project goal list responses", async () => {
  const { baseUrl, tracker, projectManagerStore, close } = await startApi();
  try {
    const goal = await createProjectGoal(projectManagerStore, { status: "approved" });
    const proposed = await tracker.proposeTask({
      repositoryName: "developer",
      repoPathKey: "developer",
      title: "PM linked proposal",
      description: "Created for linked count coverage.",
      source: "ai_proposal",
      proposedBy: "project_manager_agent",
      proposalReason: "Coverage",
      autonomyLevel: "proposal_only",
      approvalPolicy: "project_manager_goal_policy",
      evidenceRefs: [],
      idempotencyKey: "pm-linked-count",
    });
    await projectManagerStore.linkGoalTask({
      goalId: goal.id,
      taskId: proposed.id,
      linkType: "proposed_task",
    });

    const response = await requestJson(baseUrl, "/api/project-goals", {
      headers: viewerHeaders,
    });

    expect(response.body.linkedTaskCounts[goal.id]).toBe(1);
  } finally {
    await close();
  }
});
```

Add tests for `GET /api/project-goals/:id`, `GET /api/proposals`, and
`GET /api/tasks/:id` to assert `linkedTasks` or `projectGoals` are returned.

- [ ] **Step 2: Run the failing API tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts
```

Expected: assertions fail because PM-4 linked response fields are absent.

- [ ] **Step 3: Add compact project goal summary helper**

In `TaskTrackerHumanApi`, add:

```typescript
private summarizeProjectGoal(goal: ProjectGoal): Record<string, unknown> {
  return {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    priority: goal.priority,
    riskLevel: goal.riskLevel,
    repositoryName: goal.repositoryName,
  };
}
```

Import `ProjectGoal` from `src/domain/projectManager/types.ts`.

- [ ] **Step 4: Enrich `GET /api/project-goals`**

After loading goals:

```typescript
const linkedTaskCounts = Object.fromEntries(
  await Promise.all(
    goals.map(async (goal) => [
      goal.id,
      (await this.requireProjectManagerStore().listGoalTaskLinks(goal.id)).length,
    ]),
  ),
);
```

Return:

```typescript
json(response, 200, {
  goals,
  linkedTaskCounts,
  role: auth.role,
  generatedAt: new Date().toISOString(),
});
```

- [ ] **Step 5: Enrich goal detail with linked task summaries**

After loading `taskLinks`, if `this.input.tracker` exists, call
`tracker.getTask(link.taskId)` for each link and summarize with the existing task
summary helper. Ignore missing tasks only if `getTask` throws a not-found style
error already used elsewhere; otherwise let unexpected errors surface.

Return:

```typescript
json(response, 200, { goal, auditEvents, taskLinks, linkedTasks });
```

- [ ] **Step 6: Enrich proposals and task detail with parent goals**

Use `projectManagerStore.listGoalTaskLinksForTaskIds(taskIds)` and `getGoal` to
attach compact `projectGoals` arrays.

For proposals:

```typescript
const summaries = await this.summarizeTasksWithProjectGoals(tasks);
json(response, 200, {
  proposals: summaries.map((task) => this.summarizeProposal(task)),
  role: auth.role,
  generatedAt: new Date().toISOString(),
});
```

Implement the helper so the existing proposal summary fields remain unchanged
and only optional `projectGoals` are added.

For task detail:

```typescript
json(response, 200, {
  task,
  summary,
  activeLeases,
  children,
  latestValidation,
  latestMergeRequest,
  diagnostics,
  projectGoals,
});
```

- [ ] **Step 7: Run focused backend tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts tests/taskTrackerProposals.test.ts
```

Expected: tests pass and existing proposal behavior remains unchanged.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src/observability/taskTrackerHumanApi.ts tests/humanTaskApi.test.ts
git commit -m "feat: add project goal context to human api"
```

---

## Task 3: Angular DTOs, Mappers, Fixtures, And Service

**Files:**

- Modify: `web/src/app/models/human-api.dto.ts`
- Modify: `web/src/app/services/task-mappers.ts`
- Create: `web/src/app/services/project-goal.service.ts`
- Modify: `web/src/app/testing/human-api.fixtures.ts`
- Test: `web/src/app/services/task-api.service.spec.ts` or create
  `web/src/app/services/project-goal.service.spec.ts`

- [ ] **Step 1: Add DTOs**

Add these interfaces to `human-api.dto.ts`:

```typescript
export type ProjectGoalStatusDto = 'proposed' | 'approved' | 'active' | 'completed' | 'rejected' | 'stale';
export type ProjectGoalPriorityDto = 'low' | 'normal' | 'high' | 'critical';
export type ProjectGoalRiskLevelDto = 'low' | 'medium' | 'high';

export interface ProjectGoalDto {
  id: string;
  sourceAnalysisId: string;
  sourceRunId?: string;
  repositoryName: string;
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  successMetrics: string[];
  evidenceRefs: EvidenceRefDto[];
  status: ProjectGoalStatusDto;
  priority: ProjectGoalPriorityDto;
  riskLevel: ProjectGoalRiskLevelDto;
  suggestedTaskProposals: ProjectTaskProposalDraftDto[];
  approvedAt?: string;
  activatedAt?: string;
  completedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  staleAt?: string;
  staleReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskProposalDraftDto {
  title: string;
  description: string;
  taskType: string;
  acceptanceCriteria: string[];
  expectedBlastRadius?: string;
  evidenceRefs: EvidenceRefDto[];
}

export interface ProjectGoalSummaryDto {
  id: string;
  title: string;
  status: ProjectGoalStatusDto;
  priority: ProjectGoalPriorityDto;
  riskLevel: ProjectGoalRiskLevelDto;
  repositoryName: string;
}

export interface ProjectGoalAuditEventDto {
  id: string;
  goalId: string;
  kind: string;
  actor?: ActorDto;
  message?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectGoalTaskLinkDto {
  id: string;
  goalId: string;
  taskId: string;
  linkType: string;
  createdAt: string;
}

export interface ProjectGoalListResponseDto {
  goals: ProjectGoalDto[];
  linkedTaskCounts: Record<string, number>;
  role: SessionRoleDto;
  generatedAt: string;
}

export interface ProjectGoalDetailResponseDto {
  goal: ProjectGoalDto;
  auditEvents: ProjectGoalAuditEventDto[];
  taskLinks: ProjectGoalTaskLinkDto[];
  linkedTasks: TaskSummaryDto[];
}

export interface ProjectGoalCommandResponseDto {
  goal: ProjectGoalDto;
}

export interface ProjectGoalProposeTasksResponseDto {
  goal: ProjectGoalDto;
  tasks: TaskDetailDto[];
  proposals: unknown[];
  taskLinks: ProjectGoalTaskLinkDto[];
}
```

Add optional `projectGoals?: ProjectGoalSummaryDto[]` to
`ProposalSummaryDto` and `TaskDetailResponseDto`.

- [ ] **Step 2: Add mappers**

In `task-mappers.ts`, add `mapProjectGoal`, `mapProjectGoalSummary`,
`mapProjectGoalListResponse`, `mapProjectGoalDetailResponse`, and
`mapProjectGoalProposeTasksResponse`. Reuse `stringArray`, `records`,
`mapActor`, `mapTaskSummary`, and the existing evidence mapper pattern.

- [ ] **Step 3: Add ProjectGoalService**

Create `web/src/app/services/project-goal.service.ts`:

```typescript
import { HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import {
  ProjectGoalCommandResponseDto,
  ProjectGoalDetailResponseDto,
  ProjectGoalListResponseDto,
  ProjectGoalProposeTasksResponseDto,
} from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import {
  mapProjectGoalCommandResponse,
  mapProjectGoalDetailResponse,
  mapProjectGoalListResponse,
  mapProjectGoalProposeTasksResponse,
} from './task-mappers';

@Injectable({ providedIn: 'root' })
export class ProjectGoalService {
  private readonly api = inject(ApiClient);

  list(input: { repositoryName?: string; status?: string } = {}): Observable<ProjectGoalListResponseDto> {
    let params = new HttpParams();
    if (input.repositoryName) {
      params = params.set('repositoryName', input.repositoryName);
    }
    if (input.status) {
      params = params.set('status', input.status);
    }
    return this.api.get<unknown>('/project-goals', params).pipe(map(mapProjectGoalListResponse));
  }

  get(goalId: string): Observable<ProjectGoalDetailResponseDto> {
    return this.api.get<unknown>(`/project-goals/${goalId}`).pipe(map(mapProjectGoalDetailResponse));
  }

  approve(goalId: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api.post<Record<string, never>, unknown>(`/project-goals/${goalId}/commands/approve`, {}).pipe(
      map(mapProjectGoalCommandResponse),
    );
  }

  reject(goalId: string, reason: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api.post<{ reason: string }, unknown>(`/project-goals/${goalId}/commands/reject`, { reason }).pipe(
      map(mapProjectGoalCommandResponse),
    );
  }

  proposeTasks(goalId: string): Observable<ProjectGoalProposeTasksResponseDto> {
    return this.api.post<Record<string, never>, unknown>(`/project-goals/${goalId}/commands/propose-tasks`, {}).pipe(
      map(mapProjectGoalProposeTasksResponse),
    );
  }

  complete(goalId: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api.post<Record<string, never>, unknown>(`/project-goals/${goalId}/commands/complete`, {}).pipe(
      map(mapProjectGoalCommandResponse),
    );
  }

  markStale(goalId: string, reason: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api.post<{ reason: string }, unknown>(`/project-goals/${goalId}/commands/stale`, { reason }).pipe(
      map(mapProjectGoalCommandResponse),
    );
  }

  runAnalysis(repositoryName: string): Observable<unknown> {
    return this.api.post<{ repositoryName: string }, unknown>('/project-manager/runs', { repositoryName });
  }
}
```

- [ ] **Step 4: Add fixtures**

In `human-api.fixtures.ts`, add `projectGoal`, `approvedProjectGoal`,
`projectGoalDetail`, and `projectGoalList`.

- [ ] **Step 5: Add service/mapping tests**

Create `web/src/app/services/project-goal.service.spec.ts` covering list, get,
approve, reject, proposeTasks, complete, markStale, and runAnalysis URLs/bodies.

- [ ] **Step 6: Run Angular typecheck and service tests**

Run:

```powershell
npm run web:typecheck
npm run web:test -- --include web/src/app/services/project-goal.service.spec.ts
```

If the Angular test runner does not support `--include` in this repo, run:

```powershell
npm run web:test
```

- [ ] **Step 7: Commit Task 3**

```powershell
git add web/src/app/models/human-api.dto.ts web/src/app/services/task-mappers.ts web/src/app/services/project-goal.service.ts web/src/app/services/project-goal.service.spec.ts web/src/app/testing/human-api.fixtures.ts
git commit -m "feat: add project goal web api client"
```

---

## Task 4: Goals List Page And Navigation

**Files:**

- Modify: `web/src/app/app.ts`
- Modify: `web/src/app/app.routes.ts`
- Create: `web/src/app/pages/goals-page.component.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`
- Test: `web/src/app/app.spec.ts`

- [ ] **Step 1: Add failing Angular tests**

In `workflow-pages.spec.ts`, add:

```typescript
describe('GoalsPageComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders project goals with filters and linked task counts', async () => {
    const http = await configure([GoalsPageComponent]);
    loadSession(http, operatorSession);

    const fixture = TestBed.createComponent(GoalsPageComponent);
    fixture.detectChanges();
    http.expectOne((entry) => entry.url === '/api/project-goals' && entry.params.get('status') === 'proposed').flush(projectGoalList);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Цели проекта');
    expect(text).toContain(projectGoal.title);
    expect(text).toContain('developer');
    expect(text).toContain('Связанные задачи');
    expect(text).toContain('1');
  });
});
```

In `app.spec.ts`, assert the nav item appears only when
`canReadProjectGoals` is true.

- [ ] **Step 2: Add route and nav**

In `app.routes.ts`, import `GoalsPageComponent` and add before `:taskId`:

```typescript
{ path: 'goals', component: GoalsPageComponent, title: 'Project goals' },
```

In `app.ts`, add:

```typescript
{
  label: 'Цели',
  icon: 'pi pi-sitemap',
  route: '/goals',
  testId: 'nav-goals',
  capability: 'canReadProjectGoals',
},
```

- [ ] **Step 3: Implement `GoalsPageComponent`**

The component should:

- default status filter to `proposed`
- support status options `proposed`, `approved`, `active`, `completed`,
  `rejected`, `stale`, and all
- support a repository text filter
- show loading/error/empty states
- link each goal title to `/goals/:goalId`
- show status, priority, risk, repository, linked count, source run id, updated
  time, and a compact evidence summary
- show "Запустить анализ" only with `canRunProjectManager`

Use PrimeNG modules already used by `ProposalsPageComponent`: `ButtonModule`,
`MessageModule`, `ProgressSpinnerModule`, `SelectModule`, `TagModule`, and
`ReactiveFormsModule`.

- [ ] **Step 4: Run focused Angular tests**

Run:

```powershell
npm run web:test
npm run web:typecheck
```

- [ ] **Step 5: Commit Task 4**

```powershell
git add web/src/app/app.ts web/src/app/app.routes.ts web/src/app/pages/goals-page.component.ts web/src/app/pages/workflow-pages.spec.ts web/src/app/app.spec.ts
git commit -m "feat: add project goals list page"
```

---

## Task 5: Goal Detail Page And Actions

**Files:**

- Modify: `web/src/app/app.routes.ts`
- Create: `web/src/app/pages/goal-detail-page.component.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing detail/action tests**

Add tests asserting:

- detail loads `/api/project-goals/:id`
- evidence refs, success metrics, suggested drafts, audit events, and linked
  tasks render
- approve calls `/api/project-goals/:id/commands/approve`
- reject requires a reason and calls `/commands/reject`
- propose tasks calls `/commands/propose-tasks` only for operator sessions and
  approved/active goals
- complete calls `/commands/complete` for active goals
- stale requires a reason and calls `/commands/stale`

- [ ] **Step 2: Add the detail route**

In `app.routes.ts`, add before `:taskId`:

```typescript
{ path: 'goals/:goalId', component: GoalDetailPageComponent, title: 'Project goal detail' },
```

- [ ] **Step 3: Implement `GoalDetailPageComponent`**

The component should:

- read `goalId` from `ActivatedRoute`
- call `ProjectGoalService.get(goalId)`
- render lifecycle tags and timestamps
- render problem statement, desired outcome, success metrics, evidence refs,
  suggested task drafts, linked tasks, and audit timeline
- use dialogs for reject and stale reason input
- use existing `MessageService` toast pattern for action success/failure
- refresh detail after every successful action
- keep action buttons hidden when role or status does not allow the command

Action visibility:

- approve: `canApproveProjectGoals && status === 'proposed'`
- reject: `canApproveProjectGoals && status === 'proposed'`
- propose tasks:
  `canProposeProjectGoalTasks && (status === 'approved' || status === 'active')`
- complete: `canCompleteProjectGoals && status === 'active'`
- stale:
  `canMarkProjectGoalsStale && !['completed', 'rejected', 'stale'].includes(status)`
- run analysis: `canRunProjectManager`

- [ ] **Step 4: Run focused Angular tests**

Run:

```powershell
npm run web:test
npm run web:typecheck
```

- [ ] **Step 5: Commit Task 5**

```powershell
git add web/src/app/app.routes.ts web/src/app/pages/goal-detail-page.component.ts web/src/app/pages/workflow-pages.spec.ts
git commit -m "feat: add project goal detail workflow"
```

---

## Task 6: Show Parent Goals On Proposals And Task Detail

**Files:**

- Modify: `web/src/app/pages/proposals-page.component.ts`
- Modify: `web/src/app/components/task-detail-panel.component.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing UI tests for linked goal badges**

In the proposals page test fixture, include:

```typescript
projectGoals: [
  {
    id: 'pm_goal_1',
    title: 'Stabilize proposal workflow',
    status: 'approved',
    priority: 'high',
    riskLevel: 'low',
    repositoryName: 'developer',
  },
],
```

Assert the proposals page contains the goal title and a link to
`/goals/pm_goal_1`.

In the task detail test, add `projectGoals` to the task detail response and
assert the parent goal section renders.

- [ ] **Step 2: Render parent goal badges on proposals**

In `ProposalsPageComponent`, below the tag row, render:

```html
@if (proposal.projectGoals?.length) {
  <div class="linked-goals">
    @for (goal of proposal.projectGoals; track goal.id) {
      <a [routerLink]="['/goals', goal.id]" class="linked-goal">
        <i class="pi pi-sitemap" aria-hidden="true"></i>
        <span>{{ goal.title }}</span>
        <p-tag [value]="goal.riskLevel" severity="secondary" />
      </a>
    }
  </div>
}
```

- [ ] **Step 3: Render parent goals on task detail**

In `TaskDetailPanelComponent`, add a compact section near summary metadata:

```html
@if (detail()?.projectGoals?.length) {
  <section class="detail-section">
    <h3>Цели проекта</h3>
    <div class="linked-goals">
      @for (goal of detail()?.projectGoals; track goal.id) {
        <a [routerLink]="['/goals', goal.id]" class="linked-goal">
          <i class="pi pi-sitemap" aria-hidden="true"></i>
          <span>{{ goal.title }}</span>
          <p-tag [value]="goal.status" severity="secondary" />
        </a>
      }
    </div>
  </section>
}
```

Import `RouterLink` if the component does not already import it.

- [ ] **Step 4: Run Angular tests**

Run:

```powershell
npm run web:test
npm run web:typecheck
```

- [ ] **Step 5: Commit Task 6**

```powershell
git add web/src/app/pages/proposals-page.component.ts web/src/app/components/task-detail-panel.component.ts web/src/app/pages/workflow-pages.spec.ts
git commit -m "feat: show project goal context in console"
```

---

## Task 7: Playwright PM-4 Critical Flow

**Files:**

- Modify: `web/e2e/mock-console-server.mjs`
- Modify: `web/e2e/console-critical-flows.spec.ts`

- [ ] **Step 1: Extend mock server capabilities**

In `capabilitiesFor`, add:

```javascript
canReadProjectGoals: canRole(role, 'viewer'),
canApproveProjectGoals: canRole(role, 'developer'),
canProposeProjectGoalTasks: canRole(role, 'operator'),
canCompleteProjectGoals: canRole(role, 'developer'),
canMarkProjectGoalsStale: canRole(role, 'developer'),
canRunProjectManager: canRole(role, 'operator'),
```

- [ ] **Step 2: Add mock project goal state and routes**

Add a `state.projectGoals` map with one proposed low-risk goal and implement:

- `GET /api/project-goals`
- `GET /api/project-goals/:id`
- `POST /api/project-goals/:id/commands/approve`
- `POST /api/project-goals/:id/commands/reject`
- `POST /api/project-goals/:id/commands/propose-tasks`
- `POST /api/project-goals/:id/commands/complete`
- `POST /api/project-goals/:id/commands/stale`
- `POST /api/project-manager/runs`

The mock `propose-tasks` route should create a proposed task with
`proposal.supervisorStatus = 'proposed'`, link it to the goal, and return the
same response shape as the backend.

- [ ] **Step 3: Add Playwright PM-4 flow**

In `console-critical-flows.spec.ts`, add:

```typescript
test('runs project goal review and proposal handoff workflow', async ({ browser }) => {
  const operator = await newRolePage(browser, 'operator');
  const page = operator.page;

  await page.goto('/goals');
  await expect(page.getByTestId('goals-page')).toBeVisible();
  await page.getByRole('link', { name: /Stabilize proposal workflow/ }).click();
  await expect(page.getByTestId('goal-detail-page')).toBeVisible();
  await page.getByTestId('goal-approve').click();
  await page.getByTestId('goal-propose-tasks').click();
  await expect(page.getByText(/Task proposals created/i)).toBeVisible();

  await page.goto('/proposals');
  await expect(page.getByText(/Stabilize proposal workflow/)).toBeVisible();
  await page.getByTestId(/proposal-approve-/).first().click();
  await page.getByTestId('proposal-reason').fill('Approved PM generated task.');
  await page.getByTestId('proposal-confirm').click();

  await page.goto('/');
  await expect(page.getByText(/PM generated proposal/)).toBeVisible();
  await operator.close();
});
```

Adjust labels to the final Russian UI strings and stable test ids used in the
components.

- [ ] **Step 4: Add viewer readonly Playwright coverage**

Assert a viewer can open `/goals` and `/goals/:id`, but cannot see approve,
reject, propose, complete, or stale buttons.

- [ ] **Step 5: Run E2E**

Run:

```powershell
npm run web:e2e
```

- [ ] **Step 6: Commit Task 7**

```powershell
git add web/e2e/mock-console-server.mjs web/e2e/console-critical-flows.spec.ts
git commit -m "test: cover project manager goal console flow"
```

---

## Task 8: Final Verification And Roadmap Update

**Files:**

- Modify: `docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md`

- [ ] **Step 1: Update roadmap status**

Under `### Phase PM-4 - Human UI for goals and roadmap`, add:

```markdown
**Status:** implemented in `<branch-name>`. PM-4 adds Angular goals list/detail
views, goal lifecycle actions, explicit task proposal creation from approved or
active goals, and linked goal context on proposals and task detail.
```

- [ ] **Step 2: Run backend focused tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts tests/projectManagerTaskProposalBuilder.test.ts
```

Expected: all non-database-gated tests pass. If `TASK_TRACKER_TEST_DATABASE_URL`
is unset, explicitly note PostgreSQL integration tests are skipped.

- [ ] **Step 3: Run full backend verification**

Run:

```powershell
npm run typecheck
npm test
```

Expected: TypeScript passes and Vitest passes.

- [ ] **Step 4: Run full web verification**

Run:

```powershell
npm run web:typecheck
npm run web:test
npm run web:e2e
```

Expected: Angular typecheck, unit tests, build, and Playwright pass.

- [ ] **Step 5: Check generated artifacts**

Run:

```powershell
git status --short
```

If `web/test-results/` appears after Playwright, remove only that generated
directory after verifying it is inside the workspace:

```powershell
$target = Resolve-Path -LiteralPath 'web\test-results' -ErrorAction Stop
$root = (Resolve-Path -LiteralPath '.').Path
if (-not $target.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove outside workspace: $($target.Path)"
}
Remove-Item -LiteralPath $target.Path -Recurse -Force
```

- [ ] **Step 6: Request code review subagent**

Ask a review subagent to inspect the full PM-4 diff against `main`, focusing on:

- PM safety invariants
- role/capability enforcement
- no `createTask` path from goals UI
- Angular action visibility matching backend roles
- API response compatibility
- Playwright mock realism

Fix Critical/Important findings before final.

- [ ] **Step 7: Commit final docs/status update**

```powershell
git add docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md
git commit -m "docs: update project manager pm4 status"
```

---

## Safety Checklist

- [ ] PM-4 does not call `TaskTrackerClient.createTask`.
- [ ] Goal-derived work still enters through `proposeTask`.
- [ ] Proposal approval still uses the existing proposal review workflow.
- [ ] Viewer sessions cannot mutate goals or proposals.
- [ ] Developer sessions cannot fan out task proposals from goals.
- [ ] Operator sessions can create proposals but not bypass proposal approval.
- [ ] High-risk goals remain proposal-only via PM-3 builder behavior.
- [ ] Repeated propose-tasks calls remain idempotent.
- [ ] Existing task/proposal/operations pages remain compatible when PM store is absent.

## Final Expected Verification

Run these before claiming PM-4 complete:

```powershell
npm run typecheck
npm test
npm run web:typecheck
npm run web:test
npm run web:e2e
```

If `TASK_TRACKER_TEST_DATABASE_URL` is unset, mention that real PostgreSQL
integration tests were skipped by design.
