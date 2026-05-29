# Project Manager UI UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Project Manager goals, strategy output, linked-goal context, and queue navigation more discoverable, localized, and information-rich in the Angular console.

**Architecture:** Keep the existing backend routes and Angular standalone component structure. Add one small API enrichment for linked goal summaries, centralize Project Manager UI labels in `task-ui.ts`, then update the affected pages incrementally with focused tests. Preserve the current PrimeNG visual system and avoid introducing new dependencies.

**Tech Stack:** TypeScript ES modules, Node.js `TaskTrackerHumanApi`, Angular 20 standalone components, PrimeNG, Jasmine/Karma, Vitest, Playwright.

---

## Current Baseline

The console already has `/goals`, `/goals/:goalId`, proposal-linked goal badges, task-linked goal badges, strategy output, and Playwright smoke coverage. The main observed issue is that the `/goals` page defaults to `status=proposed`, so goals disappear after they become `approved` or `active` even though the backend can return them without a status filter.

## File Map

Backend:

- Modify `src/observability/taskTrackerHumanApi.ts`: enrich linked project goal summaries with `problemStatement` and `desiredOutcome`.
- Test `tests/humanTaskApi.test.ts`: verify proposal and task detail responses include the enriched goal summary fields.

Angular shared helpers:

- Modify `web/src/app/models/human-api.dto.ts`: extend `ProjectGoalSummaryDto`.
- Modify `web/src/app/services/task-mappers.ts`: map the enriched optional goal summary fields.
- Modify `web/src/app/utils/task-ui.ts`: add centralized Project Manager labels, severities, and helper formatters.
- Test `web/src/app/pages/workflow-pages.spec.ts`: cover the new UI behavior across pages.
- Test `web/src/app/services/project-goal.service.spec.ts`: cover enriched mapping where service-level tests are clearer.

Angular pages and components:

- Modify `web/src/app/pages/goals-page.component.ts`: default to all goals, persist filters in URL, improve empty state, enrich goal cards, and show strategy goal links/questions.
- Modify `web/src/app/pages/goal-detail-page.component.ts`: add lifecycle summary, next-step guidance, localized labels, and clearer audit rendering.
- Modify `web/src/app/pages/proposals-page.component.ts`: render richer linked-goal context.
- Modify `web/src/app/components/task-detail-panel.component.ts`: render richer linked-goal context.
- Modify `web/src/app/pages/queue-page.component.ts`: reduce mobile noise from empty groups.
- Modify `web/src/styles.scss`: add small reusable classes for goal summaries, lifecycle strips, and compact queue empty summaries.

E2E:

- Modify `web/e2e/mock-console-server.mjs`: return enriched project goal summaries and keep enough goal states to test the default `/goals` view.
- Modify `web/e2e/console-critical-flows.spec.ts`: cover approved/active goal visibility, richer linked-goal context, strategy questions/links, and mobile queue compaction.

---

## Task 1: Central Project Manager UI Labels

**Files:**

- Modify: `web/src/app/utils/task-ui.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing label coverage**

Add this test to the existing `describe('task UI labels', ...)` block in `web/src/app/pages/workflow-pages.spec.ts`:

```typescript
it('renders localized project manager labels', () => {
  expect(projectGoalStatusLabel('approved')).toBe('Одобрено');
  expect(projectGoalPriorityLabel('critical')).toBe('Критический');
  expect(projectGoalRiskLabel('medium')).toBe('Средний');
  expect(projectStrategyDimensionLabel('product_technical')).toBe('Продукт и техника');
  expect(projectStrategyNextStepLabel('create_goal')).toBe('Создать цель');
  expect(projectStrategyArchitectVerdictLabel('research_first')).toBe('Сначала исследовать');
  expect(projectConfidenceLabel(82)).toBe('Уверенность: 82%');
});
```

Update the import from `../utils/task-ui` in the same test file to include:

```typescript
  projectConfidenceLabel,
  projectGoalPriorityLabel,
  projectGoalRiskLabel,
  projectGoalStatusLabel,
  projectStrategyArchitectVerdictLabel,
  projectStrategyDimensionLabel,
  projectStrategyNextStepLabel,
```

- [ ] **Step 2: Run the failing label test**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: FAIL because the imported `projectGoalStatusLabel`, `projectGoalPriorityLabel`, `projectGoalRiskLabel`, `projectStrategyDimensionLabel`, `projectStrategyNextStepLabel`, `projectStrategyArchitectVerdictLabel`, and `projectConfidenceLabel` functions are not exported yet.

- [ ] **Step 3: Add the shared helper exports**

Append these exports to `web/src/app/utils/task-ui.ts` after `statusSeverity`:

```typescript
export const PROJECT_GOAL_STATUS_LABELS: Record<string, string> = {
  proposed: 'Предложено',
  approved: 'Одобрено',
  active: 'Активно',
  completed: 'Завершено',
  rejected: 'Отклонено',
  stale: 'Устарело',
};

export const PROJECT_GOAL_PRIORITY_LABELS: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  critical: 'Критический',
};

export const PROJECT_GOAL_RISK_LABELS: Record<string, string> = {
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
};

export const PROJECT_STRATEGY_DIMENSION_LABELS: Record<string, string> = {
  product: 'Продукт',
  technical: 'Техника',
  product_technical: 'Продукт и техника',
};

export const PROJECT_STRATEGY_NEXT_STEP_LABELS: Record<string, string> = {
  create_goal: 'Создать цель',
  research: 'Исследовать',
  ask_human: 'Спросить человека',
  defer: 'Отложить',
};

export const PROJECT_STRATEGY_ARCHITECT_VERDICT_LABELS: Record<string, string> = {
  pursue: 'Брать в работу',
  research_first: 'Сначала исследовать',
  defer: 'Отложить',
  reject: 'Отклонить',
};

export const projectGoalStatusLabel = (status: string): string =>
  PROJECT_GOAL_STATUS_LABELS[status] ?? statusLabel(status);

export const projectGoalStatusSeverity = (
  status: string,
): 'success' | 'info' | 'warn' | 'danger' | 'secondary' => {
  if (status === 'completed') {
    return 'success';
  }
  if (status === 'active' || status === 'approved') {
    return 'info';
  }
  if (status === 'proposed') {
    return 'warn';
  }
  if (status === 'rejected' || status === 'stale') {
    return 'danger';
  }
  return 'secondary';
};

export const projectGoalPriorityLabel = (priority: string): string =>
  PROJECT_GOAL_PRIORITY_LABELS[priority] ?? statusLabel(priority);

export const projectGoalPrioritySeverity = (
  priority: string,
): 'success' | 'info' | 'warn' | 'danger' | 'secondary' => {
  if (priority === 'critical') {
    return 'danger';
  }
  if (priority === 'high') {
    return 'warn';
  }
  return 'secondary';
};

export const projectGoalRiskLabel = (riskLevel: string): string =>
  PROJECT_GOAL_RISK_LABELS[riskLevel] ?? statusLabel(riskLevel);

export const projectGoalRiskSeverity = (
  riskLevel: string,
): 'success' | 'info' | 'warn' | 'danger' | 'secondary' => {
  if (riskLevel === 'high') {
    return 'danger';
  }
  if (riskLevel === 'medium') {
    return 'warn';
  }
  return 'success';
};

export const projectStrategyDimensionLabel = (dimension: string): string =>
  PROJECT_STRATEGY_DIMENSION_LABELS[dimension] ?? statusLabel(dimension);

export const projectStrategyNextStepLabel = (nextStep: string): string =>
  PROJECT_STRATEGY_NEXT_STEP_LABELS[nextStep] ?? statusLabel(nextStep);

export const projectStrategyArchitectVerdictLabel = (verdict: string): string =>
  PROJECT_STRATEGY_ARCHITECT_VERDICT_LABELS[verdict] ?? statusLabel(verdict);

export const projectConfidenceLabel = (confidence: number): string =>
  `Уверенность: ${Math.round(confidence)}%`;
```

- [ ] **Step 4: Run the label test again**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: PASS for the new localized project manager label test.

- [ ] **Step 5: Commit**

```powershell
git add web/src/app/utils/task-ui.ts web/src/app/pages/workflow-pages.spec.ts
git commit -m "Add localized project manager UI labels"
```

---

## Task 2: Goals Default View, URL Filters, And Empty State

**Files:**

- Modify: `web/src/app/pages/goals-page.component.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Replace the default-filter test with failing all-goals coverage**

In `web/src/app/pages/workflow-pages.spec.ts`, replace the test named `renders project goals with the default proposed filter and linked task counts` with:

```typescript
it('renders project goals without hiding approved goals by default', async () => {
  const http = await configure([GoalsPageComponent]);
  loadSession(http, pmOperatorSession);

  const fixture = TestBed.createComponent(GoalsPageComponent);
  fixture.detectChanges();

  const request = http.expectOne((entry) => entry.url === '/api/project-goals');
  expect(request.request.params.has('status')).toBeFalse();
  expect(request.request.params.has('repositoryName')).toBeFalse();
  request.flush(projectGoalList);
  http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });
  fixture.detectChanges();

  const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
  expect(text).toContain(projectGoal.title);
  expect(text).toContain(approvedProjectGoal.title);
  expect(text).toContain('Одобрено');
  expect(text).toContain('Показаны все цели');
});
```

Add this second test in the same `describe('GoalsPageComponent', ...)` block:

```typescript
it('explains empty filtered goal results and can switch back to all goals', async () => {
  const http = await configure([GoalsPageComponent]);
  loadSession(http, pmOperatorSession);

  const fixture = TestBed.createComponent(GoalsPageComponent);
  fixture.detectChanges();
  http.expectOne((entry) => entry.url === '/api/project-goals' && !entry.params.has('status')).flush({
    ...projectGoalList,
    goals: [approvedProjectGoal],
  });
  http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });

  const component = fixture.componentInstance as unknown as {
    statusFilter: { setValue: (value: string) => void };
    load: () => void;
  };
  component.statusFilter.setValue('proposed');
  component.load();
  http.expectOne((entry) => entry.url === '/api/project-goals' && entry.params.get('status') === 'proposed').flush({
    ...projectGoalList,
    goals: [],
  });
  http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;
  expect(element.textContent).toContain('Нет целей со статусом Предложено');
  element.querySelector<HTMLButtonElement>('[data-testid="goals-show-all"]')?.click();
  http.expectOne((entry) => entry.url === '/api/project-goals' && !entry.params.has('status')).flush(projectGoalList);
  http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });
});
```

Add this third test in the same `describe('GoalsPageComponent', ...)` block to cover URL hydration and URL writes:

Add this import near the other test imports in `web/src/app/pages/workflow-pages.spec.ts`:

```typescript
import { BehaviorSubject } from 'rxjs';
```

```typescript
it('hydrates goal filters from the URL, reacts to URL changes, and syncs later filter changes back to the URL', async () => {
  const queryParams = new BehaviorSubject(
    convertToParamMap({
      status: 'approved',
      repositoryName: 'developer',
    }),
  );
  const http = await configure(
    [GoalsPageComponent],
    [
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: queryParams.value,
          },
          queryParamMap: queryParams.asObservable(),
        },
      },
    ],
  );
  loadSession(http, pmOperatorSession);
  const router = TestBed.inject(Router);
  spyOn(router, 'navigate').and.resolveTo(true);

  const fixture = TestBed.createComponent(GoalsPageComponent);
  fixture.detectChanges();

  const initial = http.expectOne((entry) => entry.url === '/api/project-goals');
  expect(initial.request.params.get('status')).toBe('approved');
  expect(initial.request.params.get('repositoryName')).toBe('developer');
  initial.flush({ ...projectGoalList, goals: [approvedProjectGoal] });
  http.expectOne('/api/project-manager/analyses?repositoryName=developer&analysisKind=strategy').flush({ analyses: [] });

  queryParams.next(convertToParamMap({ status: 'active', repositoryName: 'developer' }));
  const routeChange = http.expectOne((entry) => entry.url === '/api/project-goals');
  expect(routeChange.request.params.get('status')).toBe('active');
  expect(routeChange.request.params.get('repositoryName')).toBe('developer');
  routeChange.flush({ ...projectGoalList, goals: [] });
  http.expectOne('/api/project-manager/analyses?repositoryName=developer&analysisKind=strategy').flush({ analyses: [] });

  const component = fixture.componentInstance as unknown as {
    repositoryFilter: { setValue: (value: string) => void };
    statusFilter: { setValue: (value: string) => void };
    load: () => void;
  };
  component.repositoryFilter.setValue('');
  component.statusFilter.setValue('all');
  component.load();

  expect(router.navigate).toHaveBeenCalledWith(
    [],
    jasmine.objectContaining({
      queryParams: {},
      replaceUrl: true,
    }),
  );
  http.expectOne((entry) => entry.url === '/api/project-goals' && !entry.params.has('status')).flush(projectGoalList);
  http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });
});
```

Add this fourth test in the same `describe('GoalsPageComponent', ...)` block so the all-goals view cannot start analysis for an accidental first repository:

```typescript
it('requires an explicit repository before running analysis from the all-goals view', async () => {
  const http = await configure([GoalsPageComponent]);
  loadSession(http, pmOperatorSession);

  const fixture = TestBed.createComponent(GoalsPageComponent);
  fixture.detectChanges();
  http.expectOne((entry) => entry.url === '/api/project-goals' && !entry.params.has('status')).flush(projectGoalList);
  http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });

  const component = fixture.componentInstance as unknown as {
    runAnalysis: () => void;
  };
  component.runAnalysis();
  fixture.detectChanges();

  http.expectNone('/api/project-manager/runs');
  expect((fixture.nativeElement as HTMLElement).textContent).toContain('Укажите репозиторий для анализа.');
});
```

Update the existing `lets operators run strategy mode and renders latest strategy opportunities` test so the initial goals request no longer expects `status=proposed`:

```typescript
http.expectOne((entry) => entry.url === '/api/project-goals' && !entry.params.has('status')).flush({
  goals: [],
  linkedTaskCounts: {},
  role: 'operator',
  generatedAt: now,
});
```

Update the existing `requests goals with repository and status filters and can run analysis for operators` test so its initial request no longer expects `status=proposed`:

```typescript
http.expectOne((entry) => entry.url === '/api/project-goals' && !entry.params.has('status')).flush(projectGoalList);
```

In the same test, after `component.runAnalysis()`, keep the selected `approved` filter in the refresh expectation:

```typescript
http.expectOne((entry) =>
  entry.url === '/api/project-goals' &&
  entry.params.get('repositoryName') === 'developer' &&
  entry.params.get('status') === 'approved',
).flush(projectGoalList);
```

- [ ] **Step 2: Run the failing goals tests**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: FAIL because `GoalsPageComponent` still initializes `statusFilter` to `proposed`, still requests `status=proposed`, does not render `goals-show-all`, does not hydrate/sync URL filters, and still infers an analysis repository from the first visible goal.

- [ ] **Step 3: Update imports in `GoalsPageComponent`**

Change the imports at the top of `web/src/app/pages/goals-page.component.ts` to include router query-param dependencies and shared Project Manager helpers:

```typescript
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';

import {
  canUseCapability,
  formatDate,
  projectGoalPriorityLabel,
  projectGoalPrioritySeverity,
  projectGoalRiskLabel,
  projectGoalRiskSeverity,
  projectGoalStatusLabel,
  projectGoalStatusSeverity,
  truncate,
} from '../utils/task-ui';
```

Keep the existing Angular, PrimeNG, DTO, service, and session imports.

- [ ] **Step 4: Change status options and component state**

In `GoalsPageComponent`, replace the `statusOptions`, `statusFilter`, and injected services block with:

```typescript
  private readonly goalsApi = inject(ProjectGoalService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statusOptions: { label: string; value: GoalStatusFilter }[] = [
    { label: 'Все', value: 'all' },
    { label: 'Предложено', value: 'proposed' },
    { label: 'Одобрено', value: 'approved' },
    { label: 'Активно', value: 'active' },
    { label: 'Завершено', value: 'completed' },
    { label: 'Отклонено', value: 'rejected' },
    { label: 'Устарело', value: 'stale' },
  ];
  protected readonly statusFilter = new FormControl<GoalStatusFilter>('all', { nonNullable: true });
```

- [ ] **Step 5: Persist goal filters in URL**

Replace `ngOnInit()` in `GoalsPageComponent` with:

```typescript
  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      if (!this.applyUrlFilters(params)) {
        return;
      }
      this.applyingUrl = true;
      this.load(false);
      this.loadStrategyAnalyses();
      this.applyingUrl = false;
    });
  }
```

Add this state and helper methods inside the class:

```typescript
  private applyingUrl = false;
  private urlFiltersInitialized = false;

  private applyUrlFilters(params: ParamMap): boolean {
    const requestedStatus = params.get('status');
    const nextStatus = this.statusOptions.some((option) => option.value === requestedStatus)
      ? (requestedStatus as GoalStatusFilter)
      : 'all';
    const nextRepositoryName = params.get('repositoryName') ?? '';
    const changed =
      !this.urlFiltersInitialized ||
      this.statusFilter.value !== nextStatus ||
      this.repositoryFilter.value !== nextRepositoryName;
    this.urlFiltersInitialized = true;
    if (!changed) {
      return false;
    }
    this.statusFilter.setValue(nextStatus, { emitEvent: false });
    this.repositoryFilter.setValue(nextRepositoryName, { emitEvent: false });
    return true;
  }

  private syncUrl(): void {
    if (this.applyingUrl || !this.urlFiltersInitialized) {
      return;
    }
    const repositoryName = this.repositoryFilter.value.trim();
    const status = this.statusFilter.value;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        ...(status !== 'all' ? { status } : {}),
        ...(repositoryName ? { repositoryName } : {}),
      },
      replaceUrl: true,
    });
  }
```

At the start of `load(refreshStrategyAnalyses = true)`, after `this.error.set(undefined);`, add:

```typescript
    this.syncUrl();
```

In `runAnalysis()`, replace the repository fallback:

```typescript
const repositoryName = this.repositoryFilter.value.trim() || this.goals()[0]?.repositoryName;
```

with an explicit repository requirement:

```typescript
const repositoryName = this.repositoryFilter.value.trim();
```

Keep the existing empty-repository error branch:

```typescript
if (!repositoryName) {
  this.error.set('Укажите репозиторий для анализа.');
  return;
}
```

- [ ] **Step 6: Add a visible active-filter summary and show-all action**

In the goals page template, after the filter `<div class="surface filter-grid filter-grid--compact">...</div>`, insert:

```angular-html
      <div class="muted" data-testid="goals-filter-summary">{{ goalFilterSummary() }}</div>
```

Replace the empty-state block with:

```angular-html
        <div class="empty-state surface">
          <i class="pi pi-sitemap" aria-hidden="true"></i>
          <h2>{{ emptyGoalTitle() }}</h2>
          <p>{{ emptyGoalDescription() }}</p>
          @if (statusFilter.value !== 'all') {
            <button
              pButton
              type="button"
              data-testid="goals-show-all"
              icon="pi pi-list"
              label="Показать все цели"
              severity="secondary"
              (click)="showAllGoals()"
            ></button>
          }
        </div>
```

Add these methods inside `GoalsPageComponent`:

```typescript
  protected showAllGoals(): void {
    this.statusFilter.setValue('all');
    this.load();
  }

  protected goalFilterSummary(): string {
    const repositoryName = this.repositoryFilter.value.trim();
    const status = this.statusFilter.value;
    const statusText = status === 'all' ? 'Показаны все цели' : `Статус: ${projectGoalStatusLabel(status)}`;
    return repositoryName ? `${statusText}; репозиторий: ${repositoryName}` : statusText;
  }

  protected emptyGoalTitle(): string {
    return this.statusFilter.value === 'all'
      ? 'Цели не найдены'
      : `Нет целей со статусом ${projectGoalStatusLabel(this.statusFilter.value)}`;
  }

  protected emptyGoalDescription(): string {
    return this.statusFilter.value === 'all'
      ? 'Запустите анализ Project Manager для репозитория или проверьте имя репозитория.'
      : 'Текущий фильтр скрывает цели в других состояниях. Переключитесь на все цели, чтобы увидеть одобренные, активные и завершенные цели.';
  }
```

- [ ] **Step 7: Replace local goal label/severity methods with shared helpers**

In `GoalsPageComponent`, replace the bodies of `goalStatusLabel`, `goalStatusSeverity`, `prioritySeverity`, and `riskSeverity` with:

```typescript
  protected goalStatusLabel(status: string): string {
    return projectGoalStatusLabel(status);
  }

  protected goalStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalStatusSeverity(status);
  }

  protected priorityLabel(priority: string): string {
    return projectGoalPriorityLabel(priority);
  }

  protected prioritySeverity(priority: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalPrioritySeverity(priority);
  }

  protected riskLabel(riskLevel: string): string {
    return projectGoalRiskLabel(riskLevel);
  }

  protected riskSeverity(riskLevel: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalRiskSeverity(riskLevel);
  }
```

Update the goal tags in the template from raw values to localized labels:

```angular-html
                  <p-tag [value]="'Приоритет: ' + priorityLabel(goal.priority)" [severity]="prioritySeverity(goal.priority)" />
                  <p-tag [value]="'Риск: ' + riskLabel(goal.riskLevel)" [severity]="riskSeverity(goal.riskLevel)" />
```

- [ ] **Step 8: Run the goals tests**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: PASS for the goals default view, empty-state, URL filter, and explicit analysis repository tests.

- [ ] **Step 9: Commit**

```powershell
git add web/src/app/pages/goals-page.component.ts web/src/app/pages/workflow-pages.spec.ts web/src/app/utils/task-ui.ts
git commit -m "Improve project goals default filters"
```

---

## Task 3: Richer Goal List Cards

**Files:**

- Modify: `web/src/app/pages/goals-page.component.ts`
- Modify: `web/src/styles.scss`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing list-content assertions**

Extend the goals default-view test in `web/src/app/pages/workflow-pages.spec.ts` with these assertions:

```typescript
expect(text).toContain('Проблема');
expect(text).toContain(projectGoal.problemStatement);
expect(text).toContain('Ожидаемый результат');
expect(text).toContain(projectGoal.desiredOutcome);
expect(text).toContain('Метрики успеха');
expect(text).toContain(projectGoal.successMetrics[0]);
expect(text).toContain('Приоритет: Высокий');
expect(text).toContain('Риск: Средний');
```

- [ ] **Step 2: Run the failing goal-card test**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: FAIL because the list card only renders evidence and raw priority/risk values.

- [ ] **Step 3: Add goal card content sections**

In `web/src/app/pages/goals-page.component.ts`, inside each `.goal-row__main` after the field grid and before the evidence block, insert:

```angular-html
                <div class="goal-summary-grid">
                  <div class="summary-block">
                    <h3>Проблема</h3>
                    <p>{{ truncate(goal.problemStatement, 320) || 'Проблема не указана.' }}</p>
                  </div>
                  <div class="summary-block">
                    <h3>Ожидаемый результат</h3>
                    <p>{{ truncate(goal.desiredOutcome, 320) || 'Результат не указан.' }}</p>
                  </div>
                </div>

                <div class="summary-block">
                  <h3>Метрики успеха</h3>
                  @if (goal.successMetrics.length) {
                    <ul class="compact-list">
                      @for (metric of goal.successMetrics.slice(0, 3); track metric) {
                        <li>{{ metric }}</li>
                      }
                    </ul>
                  } @else {
                    <p>Метрики не указаны.</p>
                  }
                </div>
```

- [ ] **Step 4: Add responsive styling**

Append this block to `web/src/styles.scss` near the existing `.goal-row__main` styles:

```scss
.goal-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
```

Inside the existing `@media (max-width: 760px)` block, add `.goal-summary-grid` to the single-column selector list:

```scss
  .page__header,
  .filter-grid,
  .filter-grid--compact,
  .field-grid,
  .goal-summary-grid,
  .preview-grid {
    grid-template-columns: 1fr;
  }
```

- [ ] **Step 5: Run the goal-card test**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: PASS for the richer goal-card assertions.

- [ ] **Step 6: Commit**

```powershell
git add web/src/app/pages/goals-page.component.ts web/src/styles.scss web/src/app/pages/workflow-pages.spec.ts
git commit -m "Show richer project goal summaries"
```

---

## Task 4: Strategy Goal Links And Human Questions

**Files:**

- Modify: `web/src/app/pages/goals-page.component.ts`
- Modify: `web/src/styles.scss`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing strategy assertions**

In the test `lets operators run strategy mode and renders latest strategy opportunities`, add these expectations after the existing `Improve validation trust` assertion:

```typescript
expect((fixture.nativeElement as HTMLElement).textContent).toContain('Связанные цели');
expect((fixture.nativeElement as HTMLElement).textContent).toContain('Improve validation trust');
expect((fixture.nativeElement as HTMLElement).textContent).toContain('Вопросы человеку');
```

Update the test fixture strategy object in the same test so `questionsForHuman` contains:

```typescript
questionsForHuman: [
  {
    question: 'Should validation trust be product-facing?',
    whyItMatters: 'It changes whether the next goal is product or technical.',
    relatedOpportunityId: 'opp-1',
    relatedOpportunityTitle: 'Improve validation trust',
  },
],
```

- [ ] **Step 2: Run the failing strategy test**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: FAIL because `goalLinks` and `questionsForHuman` are not rendered.

- [ ] **Step 3: Use shared strategy labels**

Update the imports in `web/src/app/pages/goals-page.component.ts` to include:

```typescript
  projectConfidenceLabel,
  projectStrategyArchitectVerdictLabel,
  projectStrategyDimensionLabel,
  projectStrategyNextStepLabel,
```

Replace the opportunity heading and tags:

```angular-html
                      <span class="eyebrow">
                        {{ strategyDimensionLabel(opportunity.dimension) }} · {{ architectVerdictLabel(opportunity.architectVerdict) }}
                      </span>
```

```angular-html
                      <p-tag [value]="confidenceLabel(opportunity.confidence)" severity="info" />
                      <p-tag [value]="priorityLabel(opportunity.priority)" [severity]="prioritySeverity(opportunity.priority)" />
                      <p-tag [value]="nextStepLabel(opportunity.recommendedNextStep)" severity="secondary" />
```

Add these methods inside `GoalsPageComponent`:

```typescript
  protected strategyDimensionLabel(dimension: string): string {
    return projectStrategyDimensionLabel(dimension);
  }

  protected architectVerdictLabel(verdict: string): string {
    return projectStrategyArchitectVerdictLabel(verdict);
  }

  protected nextStepLabel(nextStep: string): string {
    return projectStrategyNextStepLabel(nextStep);
  }

  protected confidenceLabel(confidence: number): string {
    return projectConfidenceLabel(confidence);
  }
```

- [ ] **Step 4: Render goal links and human questions**

Inside the `@if (analysis.strategy; as strategy) { ... }` block, after the opportunities block, insert:

```angular-html
            @if (strategy.goalLinks.length) {
              <div class="strategy-subsection">
                <h3>Связанные цели</h3>
                <div class="goal-badge-list">
                  @for (link of strategy.goalLinks; track link.sourceOpportunityId + link.proposedGoalTitle) {
                    <div class="goal-badge">
                      <span class="goal-badge__title">{{ link.proposedGoalTitle }}</span>
                      <span class="muted">Источник: {{ link.sourceOpportunityId }}</span>
                      @if (link.evidenceRefs.length) {
                        <span class="muted">{{ evidenceSummaryFromRefs(link.evidenceRefs) }}</span>
                      }
                    </div>
                  }
                </div>
              </div>
            }

            @if (strategy.questionsForHuman.length) {
              <div class="strategy-subsection">
                <h3>Вопросы человеку</h3>
                <div class="goal-badge-list">
                  @for (question of strategy.questionsForHuman; track question.question) {
                    <div class="goal-badge">
                      <span class="goal-badge__title">{{ question.question }}</span>
                      <span>{{ question.whyItMatters }}</span>
                      @if (question.relatedOpportunityTitle) {
                        <span class="muted">{{ question.relatedOpportunityTitle }}</span>
                      }
                    </div>
                  }
                </div>
              </div>
            }
```

Import `EvidenceRefDto` from `../models/human-api.dto` and add:

```typescript
  protected evidenceSummaryFromRefs(evidenceRefs: EvidenceRefDto[]): string {
    return truncate(
      evidenceRefs
        .map((evidence) => evidence.summary || `${evidence.kind}: ${evidence.ref}`)
        .filter(Boolean)
        .join(' '),
      220,
    );
  }
```

- [ ] **Step 5: Add strategy subsection styling**

Add to the component `styles` array in `GoalsPageComponent`:

```scss
      .strategy-subsection {
        display: grid;
        gap: 0.5rem;
      }

      .strategy-subsection h3 {
        margin: 0;
        font-size: 1rem;
      }
```

- [ ] **Step 6: Run the strategy test**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: PASS for the strategy goal links and human questions assertions.

- [ ] **Step 7: Commit**

```powershell
git add web/src/app/pages/goals-page.component.ts web/src/app/pages/workflow-pages.spec.ts
git commit -m "Render strategy links and questions"
```

---

## Task 5: Enrich Linked Goal Summary API Contract

**Files:**

- Modify: `src/observability/taskTrackerHumanApi.ts`
- Modify: `web/src/app/models/human-api.dto.ts`
- Modify: `web/src/app/services/task-mappers.ts`
- Test: `tests/humanTaskApi.test.ts`
- Test: `web/src/app/services/project-goal.service.spec.ts`

- [ ] **Step 1: Add failing backend assertions**

In `tests/humanTaskApi.test.ts`, in the `allows operators to create project goal task proposals and links idempotently` test, update the proposal response expectation so the first linked goal summary includes the same goal context created by the local `createProjectGoal()` helper:

```typescript
expect(proposals.body.proposals[0]).toMatchObject({
  id: first.body.tasks[0].id,
  projectGoals: [
    {
      id: goal.id,
      title: goal.title,
      status: "approved",
      priority: "normal",
      riskLevel: "low",
      repositoryName: "developer",
      problemStatement: "Operators cannot see enough project-level context.",
      desiredOutcome: "Project-level goals are visible and reviewable.",
    },
  ],
  proposal: {
    supervisorStatus: "proposed",
    suggestedAcceptanceCriteria: [
      "Repeated PM proposal command returns the same task.",
      "Repeated PM proposal command returns the same goal-task link.",
    ],
  },
});
```

In the same test, replace the exact task-detail `projectGoals` equality with an `expect.objectContaining` assertion so adding optional summary fields does not make the test brittle:

```typescript
expect(detail.body.projectGoals).toEqual([
  expect.objectContaining({
    id: goal.id,
    title: goal.title,
    status: "approved",
    priority: "normal",
    riskLevel: "low",
    repositoryName: "developer",
    problemStatement: "Operators cannot see enough project-level context.",
    desiredOutcome: "Project-level goals are visible and reviewable.",
  }),
]);
```

- [ ] **Step 2: Run the failing backend tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts
```

Expected: FAIL because `summarizeProjectGoal` does not include `problemStatement` or `desiredOutcome`.

- [ ] **Step 3: Enrich backend goal summaries**

In `src/observability/taskTrackerHumanApi.ts`, replace `summarizeProjectGoal` with:

```typescript
  private summarizeProjectGoal(goal: ProjectGoal): Record<string, unknown> {
    return {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      priority: goal.priority,
      riskLevel: goal.riskLevel,
      repositoryName: goal.repositoryName,
      problemStatement: goal.problemStatement,
      desiredOutcome: goal.desiredOutcome,
    };
  }
```

- [ ] **Step 4: Extend Angular DTO and mapper**

In `web/src/app/models/human-api.dto.ts`, add optional fields to `ProjectGoalSummaryDto`:

```typescript
export interface ProjectGoalSummaryDto {
  id: string;
  title: string;
  status: ProjectGoalStatusDto;
  priority: ProjectGoalPriorityDto;
  riskLevel: ProjectGoalRiskLevelDto;
  repositoryName: string;
  problemStatement?: string;
  desiredOutcome?: string;
}
```

In `web/src/app/services/task-mappers.ts`, replace `mapProjectGoalSummary` with:

```typescript
export const mapProjectGoalSummary = (value: unknown): ProjectGoalSummaryDto => {
  const raw = record(value);
  return {
    id: stringValue(raw['id']),
    title: stringValue(raw['title']),
    status: stringValue(raw['status'], 'proposed') as ProjectGoalStatusDto,
    priority: stringValue(raw['priority'], 'normal') as ProjectGoalPriorityDto,
    riskLevel: stringValue(raw['riskLevel'], 'medium') as ProjectGoalRiskLevelDto,
    repositoryName: stringValue(raw['repositoryName']),
    ...(optionalString(raw['problemStatement'])
      ? { problemStatement: optionalString(raw['problemStatement']) }
      : {}),
    ...(optionalString(raw['desiredOutcome']) ? { desiredOutcome: optionalString(raw['desiredOutcome']) } : {}),
  };
};
```

- [ ] **Step 5: Add service mapper coverage**

In `web/src/app/services/project-goal.service.spec.ts`, import `mapTaskDetailResponse` from `./task-mappers`:

```typescript
import { mapTaskDetailResponse } from './task-mappers';
```

Add this mapper-specific test inside `describe('ProjectGoalService', ...)`:

```typescript
it('maps enriched project goal summaries on task detail responses', () => {
  const response = mapTaskDetailResponse({
    ...readyTaskDetail,
    projectGoals: [
      {
        id: projectGoal.id,
        title: projectGoal.title,
        status: projectGoal.status,
        priority: projectGoal.priority,
        riskLevel: projectGoal.riskLevel,
        repositoryName: projectGoal.repositoryName,
        problemStatement: projectGoal.problemStatement,
        desiredOutcome: projectGoal.desiredOutcome,
      },
    ],
  });

  expect(response.projectGoals?.[0].problemStatement).toBe(projectGoal.problemStatement);
  expect(response.projectGoals?.[0].desiredOutcome).toBe(projectGoal.desiredOutcome);
});
```

- [ ] **Step 6: Run backend and Angular mapper tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts
npm --prefix web run test -- --include src/app/services/project-goal.service.spec.ts
```

Expected: PASS for enriched backend and Angular mapping tests.

- [ ] **Step 7: Commit**

```powershell
git add src/observability/taskTrackerHumanApi.ts tests/humanTaskApi.test.ts web/src/app/models/human-api.dto.ts web/src/app/services/task-mappers.ts web/src/app/services/project-goal.service.spec.ts
git commit -m "Enrich linked project goal summaries"
```

---

## Task 6: Rich Linked Goal Context On Proposals And Tasks

**Files:**

- Modify: `web/src/app/pages/proposals-page.component.ts`
- Modify: `web/src/app/components/task-detail-panel.component.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Update fixtures for enriched goal summaries**

In `web/src/app/testing/human-api.fixtures.ts`, ensure every `projectGoals: [projectGoal]` summary use keeps `problemStatement` and `desiredOutcome`. The existing `projectGoal` fixture already has full fields, so no new fixture object is required.

- [ ] **Step 2: Add failing proposal and task assertions**

In the `renders linked parent project goals for proposal responses` test, add:

```typescript
expect(element.textContent).toContain(projectGoal.desiredOutcome);
```

In the `renders linked parent project goals in task details` test, add:

```typescript
expect(text).toContain(projectGoal.desiredOutcome);
```

- [ ] **Step 3: Run failing linked-goal UI tests**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: FAIL because linked goal badges only render title, status, and risk.

- [ ] **Step 4: Render richer proposal goal cards**

In `web/src/app/pages/proposals-page.component.ts`, inside the linked goal `<a class="goal-badge"...>`, replace the contents with:

```angular-html
                          <span class="goal-badge__title">{{ goal.title }}</span>
                          @if (goal.desiredOutcome) {
                            <span>{{ truncate(goal.desiredOutcome, 220) }}</span>
                          }
                          <span class="tag-row tag-row--compact">
                            <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                            <p-tag [value]="'Приоритет: ' + priorityLabel(goal.priority)" [severity]="prioritySeverity(goal.priority)" />
                            <p-tag [value]="'Риск: ' + riskLabel(goal.riskLevel)" [severity]="riskSeverity(goal.riskLevel)" />
                          </span>
```

Import and use shared helpers from `../utils/task-ui`:

```typescript
  projectGoalPriorityLabel,
  projectGoalPrioritySeverity,
  projectGoalRiskLabel,
  projectGoalRiskSeverity,
  projectGoalStatusLabel,
  projectGoalStatusSeverity,
```

Replace local label/severity method bodies with shared helper wrappers and add:

```typescript
  protected goalStatusLabel(status: string): string {
    return projectGoalStatusLabel(status);
  }

  protected goalStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalStatusSeverity(status);
  }

  protected priorityLabel(priority: string): string {
    return projectGoalPriorityLabel(priority);
  }

  protected prioritySeverity(priority: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalPrioritySeverity(priority);
  }

  protected riskLabel(riskLevel: string): string {
    return projectGoalRiskLabel(riskLevel);
  }

  protected riskSeverity(riskLevel: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalRiskSeverity(riskLevel);
  }
```

- [ ] **Step 5: Render richer task detail goal cards**

In `web/src/app/components/task-detail-panel.component.ts`, inside the linked goal `<a class="goal-badge"...>`, replace the contents with:

```angular-html
                          <span class="goal-badge__title">{{ goal.title }}</span>
                          @if (goal.desiredOutcome) {
                            <span>{{ truncate(goal.desiredOutcome, 220) }}</span>
                          }
                          <span class="tag-row tag-row--compact">
                            <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                            <p-tag [value]="'Приоритет: ' + priorityLabel(goal.priority)" [severity]="prioritySeverity(goal.priority)" />
                            <p-tag [value]="'Риск: ' + riskLabel(goal.riskLevel)" [severity]="riskSeverity(goal.riskLevel)" />
                          </span>
```

Import shared helpers from `../utils/task-ui`:

```typescript
  projectGoalPriorityLabel,
  projectGoalPrioritySeverity,
  projectGoalRiskLabel,
  projectGoalRiskSeverity,
  projectGoalStatusLabel,
  projectGoalStatusSeverity,
```

Replace local label/severity method bodies with shared helper wrappers and add:

```typescript
  protected goalStatusLabel(status: string): string {
    return projectGoalStatusLabel(status);
  }

  protected goalStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalStatusSeverity(status);
  }

  protected priorityLabel(priority: string): string {
    return projectGoalPriorityLabel(priority);
  }

  protected prioritySeverity(priority: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalPrioritySeverity(priority);
  }

  protected riskLabel(riskLevel: string): string {
    return projectGoalRiskLabel(riskLevel);
  }

  protected riskSeverity(riskLevel: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalRiskSeverity(riskLevel);
  }
```

- [ ] **Step 6: Run linked-goal UI tests**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: PASS for proposal and task linked-goal context assertions.

- [ ] **Step 7: Commit**

```powershell
git add web/src/app/pages/proposals-page.component.ts web/src/app/components/task-detail-panel.component.ts web/src/app/pages/workflow-pages.spec.ts
git commit -m "Show richer linked goal context"
```

---

## Task 7: Goal Detail Lifecycle, Next Step, And Audit Copy

**Files:**

- Modify: `web/src/app/pages/goal-detail-page.component.ts`
- Modify: `web/src/styles.scss`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing lifecycle assertions**

In the `loads and renders project goal detail traceability sections` test, add:

```typescript
expect(text).toContain('Состояние цели');
expect(text).toContain('Следующий шаг');
expect(text).toContain('Одобрить или отклонить цель');
expect(text).toContain('Аудит цели');
expect(text).toContain('Цель предложена');
const headerText = (fixture.nativeElement as HTMLElement).querySelector('.page__header')?.textContent ?? '';
expect(headerText).toContain('Приоритет: Высокий');
expect(headerText).toContain('Риск: Средний');
expect(headerText).not.toContain('Приоритет: high');
expect(headerText).not.toContain('Риск: medium');
```

In the reject/stale tests, after flushing rejected or stale goal details, assert:

```typescript
fixture.detectChanges();
expect((fixture.nativeElement as HTMLElement).textContent).toContain('Причина отклонения');
expect((fixture.nativeElement as HTMLElement).textContent).toContain('No longer matches roadmap.');
```

For the stale test, use:

```typescript
fixture.detectChanges();
expect((fixture.nativeElement as HTMLElement).textContent).toContain('Причина устаревания');
expect((fixture.nativeElement as HTMLElement).textContent).toContain('Superseded by newer analysis.');
```

- [ ] **Step 2: Run the failing goal-detail tests**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: FAIL because lifecycle and localized audit labels are not rendered.

- [ ] **Step 3: Import shared helpers**

In `web/src/app/pages/goal-detail-page.component.ts`, update the `../utils/task-ui` import to include:

```typescript
  projectGoalPriorityLabel,
  projectGoalPrioritySeverity,
  projectGoalRiskLabel,
  projectGoalRiskSeverity,
  projectGoalStatusLabel,
  projectGoalStatusSeverity,
```

- [ ] **Step 4: Add lifecycle summary above metadata**

Inside `<article class="surface workflow-detail">`, before the metadata section, insert:

```angular-html
            <section class="detail-section goal-lifecycle">
              <h2>Состояние цели</h2>
              <div class="tag-row">
                <p-tag [value]="goalStatusLabel(currentDetail.goal.status)" [severity]="goalStatusSeverity(currentDetail.goal.status)" />
                <p-tag [value]="'Приоритет: ' + priorityLabel(currentDetail.goal.priority)" [severity]="prioritySeverity(currentDetail.goal.priority)" />
                <p-tag [value]="'Риск: ' + riskLabel(currentDetail.goal.riskLevel)" [severity]="riskSeverity(currentDetail.goal.riskLevel)" />
              </div>
              <div class="summary-block">
                <h3>Следующий шаг</h3>
                <p>{{ nextStepText(currentDetail.goal) }}</p>
              </div>
              @if (currentDetail.goal.rejectionReason) {
                <div class="summary-block">
                  <h3>Причина отклонения</h3>
                  <p>{{ currentDetail.goal.rejectionReason }}</p>
                </div>
              }
              @if (currentDetail.goal.staleReason) {
                <div class="summary-block">
                  <h3>Причина устаревания</h3>
                  <p>{{ currentDetail.goal.staleReason }}</p>
                </div>
              }
            </section>
```

- [ ] **Step 5: Rename audit section and localize audit event names**

Change the audit heading from `Аудит` to:

```angular-html
              <h2>Аудит цели</h2>
```

Change the audit event strong text:

```angular-html
                      <strong>{{ auditEventLabel(event.kind) }}</strong>
```

Add methods:

```typescript
  protected nextStepText(goal: ProjectGoalDto): string {
    if (goal.status === 'proposed') {
      return 'Одобрить или отклонить цель после проверки проблемы, результата, метрик и доказательств.';
    }
    if (goal.status === 'approved') {
      return 'Предложить задачи из черновиков или запустить перепланирование, если контекст изменился.';
    }
    if (goal.status === 'active') {
      return 'Проверить связанные задачи и завершить цель после выполнения метрик успеха.';
    }
    if (goal.status === 'completed') {
      return 'Цель завершена. Используйте аудит и связанные задачи как историю исполнения.';
    }
    if (goal.status === 'rejected') {
      return 'Цель отклонена. Причина отклонения зафиксирована ниже.';
    }
    if (goal.status === 'stale') {
      return 'Цель устарела. Запустите новый анализ, если нужен обновленный план.';
    }
    return 'Проверьте состояние цели и выберите доступное действие.';
  }

  protected auditEventLabel(kind: string): string {
    const labels: Record<string, string> = {
      project_goal_created: 'Цель предложена',
      goal_proposed: 'Цель предложена',
      project_goal_approved: 'Цель одобрена',
      goal_approved: 'Цель одобрена',
      project_goal_activated: 'Цель активирована',
      tasks_proposed: 'Задачи предложены',
      project_goal_completed: 'Цель завершена',
      goal_completed: 'Цель завершена',
      project_goal_rejected: 'Цель отклонена',
      goal_rejected: 'Цель отклонена',
      project_goal_stale: 'Цель устарела',
      goal_marked_stale: 'Цель устарела',
      project_goal_replan_classified: 'Перепланирование классифицировано',
    };
    return labels[kind] ?? statusLabel(kind);
  }
```

- [ ] **Step 6: Replace local goal label/severity methods**

Update the header tags so they use the same localized priority and risk labels as the lifecycle block:

```angular-html
              <p-tag [value]="'Приоритет: ' + priorityLabel(currentGoal.priority)" [severity]="prioritySeverity(currentGoal.priority)" />
              <p-tag [value]="'Риск: ' + riskLabel(currentGoal.riskLevel)" [severity]="riskSeverity(currentGoal.riskLevel)" />
```

Replace method bodies and add priority/risk label wrappers:

```typescript
  protected goalStatusLabel(status: string): string {
    return projectGoalStatusLabel(status);
  }

  protected goalStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalStatusSeverity(status);
  }

  protected priorityLabel(priority: string): string {
    return projectGoalPriorityLabel(priority);
  }

  protected prioritySeverity(priority: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalPrioritySeverity(priority);
  }

  protected riskLabel(riskLevel: string): string {
    return projectGoalRiskLabel(riskLevel);
  }

  protected riskSeverity(riskLevel: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalRiskSeverity(riskLevel);
  }
```

- [ ] **Step 7: Add lifecycle styling**

Append to `web/src/styles.scss` near other goal styles:

```scss
.goal-lifecycle {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--console-border);
}
```

- [ ] **Step 8: Run goal-detail tests**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: PASS for lifecycle, next-step, rejection, stale, and audit label assertions.

- [ ] **Step 9: Commit**

```powershell
git add web/src/app/pages/goal-detail-page.component.ts web/src/styles.scss web/src/app/pages/workflow-pages.spec.ts
git commit -m "Clarify project goal lifecycle details"
```

---

## Task 8: Compact Queue Groups On Mobile And Empty-Heavy Views

**Files:**

- Modify: `web/src/app/pages/queue-page.component.ts`
- Modify: `web/src/styles.scss`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing queue grouping coverage**

Replace the test `renders a queue group for every known task status` with:

```typescript
it('renders task groups first and summarizes empty queue groups', async () => {
  const http = await configure([QueuePageComponent]);
  loadSession(http, viewerSession);

  const fixture = TestBed.createComponent(QueuePageComponent);
  fixture.detectChanges();

  http.expectOne((entry) => entry.url === '/api/tasks').flush({
    tasks: [readyTask],
    role: 'viewer',
    generatedAt: '2026-04-29T08:00:00.000Z',
  });
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;
  const groups = [...element.querySelectorAll<HTMLElement>('.surface.queue-group')];
  expect(groups.length).toBe(1);
  expect(groups[0].querySelector('h2')?.textContent?.trim()).toBe('Готова');
  expect(element.textContent).toContain('Пустые группы');
  expect(element.textContent).toContain('Новая');
  expect(element.textContent).toContain('Ошибка');
});
```

- [ ] **Step 2: Run the failing queue test**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: FAIL because the component still renders every known status as a full card.

- [ ] **Step 3: Split non-empty and empty groups**

In `QueuePageComponent`, add:

```typescript
  protected readonly visibleGroups = computed<QueueGroup[]>(() =>
    this.groups().filter((group) => group.tasks.length > 0),
  );

  protected readonly emptyGroups = computed<QueueGroup[]>(() =>
    this.groups().filter((group) => group.tasks.length === 0),
  );
```

In the template, replace:

```angular-html
              @for (group of groups(); track group.status) {
```

with:

```angular-html
              @for (group of visibleGroups(); track group.status) {
```

Remove the inner empty group branch:

```angular-html
                  @if (group.tasks.length === 0) {
                    <p class="muted">В этой группе нет задач.</p>
                  } @else {
```

and remove its matching closing `}` so every rendered group contains the task list.

After the `@for (group of visibleGroups(); ...)` block, insert:

```angular-html
              @if (emptyGroups().length) {
                <section class="surface queue-empty-summary">
                  <header class="queue-group__header">
                    <h2>Пустые группы</h2>
                    <p-tag [value]="String(emptyGroups().length)" severity="secondary" />
                  </header>
                  <div class="tag-row">
                    @for (group of emptyGroups(); track group.status) {
                      <p-tag [value]="group.label" severity="secondary" />
                    }
                  </div>
                </section>
              }
```

- [ ] **Step 4: Add compact empty summary styling**

Append to `web/src/styles.scss` near `.queue-group`:

```scss
.queue-empty-summary {
  min-height: 0;
}
```

- [ ] **Step 5: Run queue tests**

Run:

```powershell
npm --prefix web run test -- --include src/app/pages/workflow-pages.spec.ts
```

Expected: PASS for the compact queue grouping behavior.

- [ ] **Step 6: Commit**

```powershell
git add web/src/app/pages/queue-page.component.ts web/src/styles.scss web/src/app/pages/workflow-pages.spec.ts
git commit -m "Compact empty queue groups"
```

---

## Task 9: E2E Coverage And Final Verification

**Files:**

- Modify: `web/e2e/mock-console-server.mjs`
- Modify: `web/e2e/console-critical-flows.spec.ts`

- [ ] **Step 1: Enrich mock goal summaries**

In `web/e2e/mock-console-server.mjs`, replace `summarizeProjectGoal` with:

```javascript
const summarizeProjectGoal = (goal) => ({
  id: goal.id,
  title: goal.title,
  status: goal.status,
  priority: goal.priority,
  riskLevel: goal.riskLevel,
  repositoryName: goal.repositoryName,
  problemStatement: goal.problemStatement,
  desiredOutcome: goal.desiredOutcome,
});
```

- [ ] **Step 2: Add an approved goal to the mock initial state**

After the existing `putGoal({ id: 'pm-goal-low-risk', ... })` call in `createInitialState`, add:

```javascript
  putGoal(
    {
      id: 'pm-goal-approved-visible',
      sourceAnalysisId: 'analysis-pm-approved',
      sourceRunId: 'pm-run-approved',
      repositoryName: 'developer',
      title: 'Keep approved goals visible',
      problemStatement: 'Approved goals are hidden when the goals page defaults to proposed-only filtering.',
      desiredOutcome: 'Operators can see approved goals without changing filters.',
      successMetrics: ['The default goals page includes approved goals.'],
      evidenceRefs: [{ kind: 'ui_audit', ref: 'goals-default-filter' }],
      status: 'approved',
      priority: 'high',
      riskLevel: 'medium',
      suggestedTaskProposals: [],
      createdAt: fixedNow,
      updatedAt: fixedNow,
      approvedAt: fixedNow,
    },
    [
      {
        id: 'goal-event-pm-goal-approved-visible-1',
        goalId: 'pm-goal-approved-visible',
        kind: 'project_goal_approved',
        actor: { owner: 'agent', id: 'project-manager', displayName: 'Project Manager' },
        message: 'Project Manager approved visibility goal.',
        createdAt: fixedNow,
      },
    ],
  );
```

- [ ] **Step 3: Add E2E assertions for default goal visibility**

In `web/e2e/console-critical-flows.spec.ts`, add this test after the existing project goal review test:

```typescript
  test('shows approved goals by default with richer goal content', async ({ browser }) => {
    const operator = await newRolePage(browser, 'operator');
    const page = operator.page;

    await page.goto('/tasks/goals');
    await expect(page.getByTestId('goals-page')).toBeVisible();
    await expect(page.getByText('Keep approved goals visible')).toBeVisible();
    await expect(page.getByText('Approved goals are hidden')).toBeVisible();
    await expect(page.getByText('Operators can see approved goals')).toBeVisible();
    await expect(page.getByTestId('goals-filter-summary')).toContainText('Показаны все цели');

    await operator.close();
  });
```

- [ ] **Step 4: Add E2E assertions for strategy links and questions**

In the test `operator runs strategy mode and sees a strategy-created goal`, add these assertions immediately after the existing first assertion for `Improve validation trust` and before filling `goals-strategy-brief`. These assertions must run against the initial stored strategy analysis, because clicking `goals-run-strategy` prepends a new latest analysis:

```typescript
await expect(page.getByTestId('goals-strategy-summary')).toContainText('Связанные цели');
await expect(page.getByTestId('goals-strategy-summary')).toContainText('Вопросы человеку');
```

Update the mock initial `projectAnalyses[0].strategy` so it has a non-empty `goalLinks` and `questionsForHuman`:

```javascript
          goalLinks: [
            {
              sourceOpportunityId: 'opp-validation',
              proposedGoalTitle: 'Improve validation trust',
              evidenceRefs: [{ kind: 'snapshot', ref: 'validation-trust' }],
            },
          ],
          questionsForHuman: [
            {
              question: 'Should validation trust be exposed to product users?',
              whyItMatters: 'It changes whether the next goal is product-facing or internal.',
              relatedOpportunityId: 'opp-validation',
              relatedOpportunityTitle: 'Improve validation trust',
            },
          ],
```

- [ ] **Step 5: Add E2E mobile queue compaction assertion**

In the visual smoke test, after `await page.goto('/tasks');`, add:

```typescript
await expect(page.locator('.queue-empty-summary')).toBeVisible();
await expect(page.locator('.queue-empty-summary')).toContainText('Назначена');
const renderedQueueGroups = page.locator('.surface.queue-group');
const renderedQueueGroupCount = await renderedQueueGroups.count();
expect(renderedQueueGroupCount).toBeGreaterThan(0);
expect(renderedQueueGroupCount).toBeLessThan(16);
for (const group of await renderedQueueGroups.all()) {
  await expect(group.locator('.task-row').first()).toBeVisible();
}
```

- [ ] **Step 6: Add visual smoke coverage for goals and goal detail on narrow screens**

In the same visual smoke test, after the existing narrow queue screenshot assertion, add:

```typescript
    await page.goto('/tasks/goals');
    await expect(page.getByTestId('goals-filter-summary')).toContainText('Показаны все цели');
    await expect(page.getByTestId('goals-page')).toContainText('Проблема');
    await expect(page.getByTestId('goals-page')).toContainText('Ожидаемый результат');
    const narrowGoals = await page.screenshot({
      path: testInfo.outputPath('narrow-goals.png'),
      fullPage: true,
    });
    expect(narrowGoals.byteLength).toBeGreaterThan(1000);

    await page.goto('/tasks/goals/pm-goal-low-risk');
    await expect(page.getByTestId('goal-detail-page')).toContainText('Состояние цели');
    await expect(page.getByTestId('goal-detail-page')).toContainText('Следующий шаг');
    const narrowGoalDetail = await page.screenshot({
      path: testInfo.outputPath('narrow-goal-detail.png'),
      fullPage: true,
    });
    expect(narrowGoalDetail.byteLength).toBeGreaterThan(1000);
```

- [ ] **Step 7: Run full verification**

Run:

```powershell
npm run typecheck
npm test
npm --prefix web run typecheck
npm --prefix web run test
npm --prefix web run e2e
npm run build
```

Expected:

```text
npm run typecheck: exits 0
npm test: exits 0
npm --prefix web run typecheck: exits 0
npm --prefix web run test: exits 0
npm --prefix web run e2e: 9 passed
npm run build: exits 0
```

- [ ] **Step 8: Commit**

```powershell
git add web/e2e/mock-console-server.mjs web/e2e/console-critical-flows.spec.ts
git commit -m "Cover project manager UI improvements"
```

---

## Final Acceptance Criteria

- `/tasks/goals` no longer hides approved or active goals by default.
- The goals empty state names the active filter and offers a one-click path back to all goals.
- Goal cards show problem statement, desired outcome, success metrics, localized priority, and localized risk.
- Strategy output shows opportunities, goal links, and questions for humans with localized labels.
- Task and proposal linked-goal cards explain why the linked goal matters by showing desired outcome.
- Goal detail shows lifecycle state, next step, rejection/stale reasons, and localized audit labels.
- Mobile queue views show task-bearing groups first and summarize empty groups compactly.
- Unit, typecheck, build, and Playwright e2e verification all pass.

## Self-Review Checklist

- Spec coverage: Tasks 2 through 8 map directly to the eight audit findings; Task 1 supports localization across those findings; Task 5 provides the backend data needed for linked-goal context; Task 9 verifies the complete workflow.
- Placeholder scan: The plan contains concrete file paths, code snippets, commands, and expected results for each task.
- Type consistency: `ProjectGoalSummaryDto.problemStatement` and `ProjectGoalSummaryDto.desiredOutcome` are optional in Angular, emitted by backend summaries, and consumed defensively in task/proposal linked-goal cards.
- Review fixes applied: Task 2 updates every existing `status=proposed` goal test affected by the default `all` filter, covers initial URL hydration plus later query-param changes, and requires an explicit analysis repository; Task 5 uses backend fixture strings and non-brittle linked-goal assertions; Task 6 now replaces all linked-goal label and severity wrappers, including `riskSeverity`; Task 7 localizes both lifecycle tags and goal-detail header tags; Task 9 pins strategy link/question assertions before the latest strategy analysis changes and adds stricter mobile queue/goals/detail visual smoke coverage.
