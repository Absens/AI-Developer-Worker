# Project Manager Subsystem Roadmap

_Актуально на 2026-05-25._

## Краткое решение

Подсистема project manager должна стать отдельным AI-слоем над уже существующим internal task tracker. Ее задача - не писать код напрямую, а периодически анализировать проект, формулировать цели, предлагать эпики и задачи, следить за выполнением, пересматривать план после новых событий и безопасно передавать работу существующим worker-ам через `TaskTrackerClient.proposeTask`.

Рекомендуемое рабочее название: **Project Manager Agent**.

Главная продуктовая идея:

```text
Project signals -> Project analysis -> Goals -> Task proposals -> Human/policy approval -> Worker execution -> Re-analysis
```

По умолчанию агент работает в режиме `proposal_only`: он может предлагать цели и задачи, но не должен автоматически отправлять их в executable queue без approval или явно включенной low-risk policy.

## Текущий baseline проекта

В проекте уже есть значительная часть foundation для такой роли:

- `TASK_TRACKER_PROVIDER=internal` и PostgreSQL-backed internal tracker с задачами, revisions, events, decisions, plans, steps, dependencies, leases, artifacts, agent runs и quality gate runs.
- `TaskTrackerClient.proposeTask`, `approveProposal`, `rejectProposal`, duplicate detection, rate limits и autonomy policy для AI-created tasks.
- `InternalWorkerOrchestrator`, который уже берет internal tasks через atomic claim/lease, запускает analysis/implementation/decomposition/review-fix и пишет structured state обратно в tracker.
- `buildAnalysisPrompt`, `buildDecompositionPrompt`, prompt profiles и confidence policy для решения "implement / ask / decompose / human".
- Repository memory: knowledge, prompt rules, failures, review learning and dynamic prompt context.
- Observability и operations UI: очередь, failed tasks, waiting for human, worker heartbeats, active leases, repeated failures.
- Angular console: queue view, task detail, create task, proposals page, operations page.
- Yandex bridge как optional external source/mirror, а не обязательный runtime store.

Это означает, что Project Manager Agent не нужно начинать как отдельный трекер или новый worker pipeline. Его лучше строить как **supervisor/planning subsystem**, которая использует existing task tracker как source of truth.

## Главные пробелы

Сейчас система умеет обрабатывать уже заданную работу и поддерживает AI proposals, но не имеет полноценного project-management цикла:

- Нет сущностей `ProjectGoal`, `ProjectAnalysis`, `ProjectRoadmap`, `ProjectManagerRun`.
- AI proposal сейчас описывает одну задачу, но не связывает ее с целью, эпиком, метрикой здоровья проекта или долгосрочным планом.
- Нет регулярного read-only анализа репозитория, backlog-а, failures, review feedback, memory и operations metrics как единого "состояния проекта".
- Нет UI для целей, roadmap-а, approval на уровне цели/эпика и просмотра причин, почему агент предложил работу.
- Нет replanning loop: после failed tasks, blockers, merged MR, new review feedback или изменения внешней задачи система не пересчитывает цели и порядок работ.
- Нет отдельной политики бюджетов для PM-агента: сколько задач он может предложить, какие области проекта трогать, какую автономию разрешить, когда обязательно нужен человек.

## Product Goals

1. Дать системе возможность самой находить полезную работу: технический долг, документацию, тестовые пробелы, повторяющиеся failures, security/update tasks, follow-ups после review.
2. Разделить стратегическое планирование и исполнение кода: PM-агент предлагает, worker реализует, человек или policy утверждает.
3. Сохранить auditability: каждая цель, задача, evidence ref, policy decision и replan должны быть объяснимы.
4. Поддержать периодический цикл "анализ -> план -> задачи -> исполнение -> анализ заново".
5. Не сломать текущий safe model: direct Yandex mode и internal worker path должны остаться rollback-compatible.

## Non-goals для MVP

- Делать полноценную замену Jira/Yandex с канбаном, спринтами и resource planning.
- Разрешать AI самостоятельно менять production-critical код без approval.
- Автоматически создавать десятки задач без rate limits и duplicate detection.
- Строить multi-repository strategic planning в первой версии.
- Давать PM-агенту прямой доступ к git write operations. Код меняют только existing worker-и через обычный task pipeline.

## Предлагаемая архитектура

### Новый доменный слой

Добавить директорию:

```text
src/domain/projectManager/
  types.ts
  signalCollector.ts
  projectAnalyzer.ts
  goalPlanner.ts
  taskProposalBuilder.ts
  projectManagerPolicy.ts
  projectManagerOrchestrator.ts
  promptBuilder.ts
```

Ответственность модулей:

| Модуль | Ответственность |
| --- | --- |
| `signalCollector.ts` | Собирает read-only сигналы: active tasks, failed tasks, repeated validation failures, review feedback, stale waiting tasks, repository memory, optional dependency/security reports. |
| `projectAnalyzer.ts` | Строит structured анализ состояния проекта без создания задач. |
| `goalPlanner.ts` | Превращает анализ в набор целей, эпиков или focus areas. |
| `taskProposalBuilder.ts` | Создает task proposal drafts с evidence refs, acceptance criteria, risk и expected blast radius. |
| `projectManagerPolicy.ts` | Применяет лимиты, allowlist task types, risk gates, duplicate rules и approval mode. |
| `projectManagerOrchestrator.ts` | Запускает periodic/manual PM cycle и пишет результаты в tracker/API. |
| `promptBuilder.ts` | Отдельные prompts для project analysis, goal planning и replan. |

### Новые сущности

Минимальная модель:

```typescript
interface ProjectGoal {
  id: string;
  repositoryName: string;
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  successMetrics: string[];
  evidenceRefs: EvidenceRef[];
  status: "proposed" | "approved" | "active" | "completed" | "rejected" | "stale";
  priority: "low" | "normal" | "high" | "critical";
  riskLevel: "low" | "medium" | "high";
  createdBy: "project_manager_agent" | "human";
  createdAt: string;
  updatedAt: string;
}

interface ProjectAnalysis {
  id: string;
  repositoryName: string;
  summary: string;
  healthSignals: ProjectHealthSignal[];
  proposedGoals: ProjectGoalDraft[];
  staleGoalIds: string[];
  replanReason?: string;
  createdAt: string;
}

interface ProjectManagerRun {
  id: string;
  repositoryName: string;
  trigger: "manual" | "schedule" | "post_task_event";
  status: "started" | "completed" | "failed";
  analysisId?: string;
  proposedGoalIds: string[];
  proposedTaskIds: string[];
  diagnostic?: string;
  startedAt: string;
  completedAt?: string;
}
```

Связь с существующими задачами:

```text
project_goals -> project_goal_tasks -> tasks
```

При создании задачи Project Manager Agent должен вызывать existing `proposeTask`, а не вставлять executable task напрямую. В `evidenceRefs` нужно добавлять ссылки на goal, analysis, failed validation, review comment, memory entry, file или metric.

### Runtime flow

```text
1. Trigger
   - manual: человек нажал "Analyze project"
   - schedule: PROJECT_MANAGER_INTERVAL_MINUTES
   - event: повторная ошибка, merged MR, stale waiting task, new memory entry

2. Signal collection
   - tracker.listTasks()
   - listActiveLeases()
   - latest qualityGateRuns / agentRuns / decisions
   - memory context summaries
   - optional repository read-only scan

3. Project analysis
   - AI получает compact structured snapshot
   - возвращает PROJECT_ANALYSIS JSON
   - runtime валидирует schema

4. Goal planning
   - AI предлагает 1-5 goals
   - policy фильтрует high-risk и duplicates
   - goals сохраняются как proposed

5. Task proposal generation
   - для approved/auto-approved low-risk goals создаются task proposals
   - используется existing `TaskTrackerClient.proposeTask`

6. Execution handoff
   - человек approve proposal или policy auto-approves low-risk
   - existing worker забирает ready task

7. Replanning
   - PM run сравнивает actual state с goal outcome
   - предлагает continue / pause / split / cancel / create follow-up
```

## Конфигурация

Добавить отдельный namespace, чтобы не смешивать PM-автономию с task-level autonomy:

```env
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

Fleet config extension:

```yaml
repositories:
  - name: developer
    projectManager:
      enabled: true
      focusAreas:
        - test coverage
        - documentation freshness
        - repeated validation failures
      allowedTaskTypes:
        - documentation
        - tests_only
      maxGoalsPerRun: 3
      maxTaskProposalsPerGoal: 4
```

## Roadmap

### Phase PM-0 - Product contract and guardrails

**Цель:** зафиксировать границы роли project manager и не дать ей обойти existing task safety model.

Работы:

- Описать domain contract: `ProjectGoal`, `ProjectAnalysis`, `ProjectManagerRun`, goal-task links.
- Добавить policy decisions: `goal_requires_approval`, `goal_auto_approved`, `task_proposal_allowed`, `task_proposal_blocked`, `duplicate_goal`.
- Решить, какие signals доступны MVP: task tracker state, validation failures, review feedback, memory, repository file inventory.
- Зафиксировать kill switch: `PROJECT_MANAGER_ENABLED=false` по умолчанию.
- Зафиксировать правило: PM-агент создает только goals/proposals, executable tasks появляются через existing approval/policy path.

Acceptance criteria:

- Документированы статусы goal lifecycle.
- Есть migration plan без изменения existing worker behavior.
- Есть список high-risk областей, где всегда нужен человек.

### Phase PM-1 - Read-only project analysis

**Цель:** получить безопасный анализ проекта без создания целей и задач.

Работы:

- Добавить `ProjectSignalCollector`, который строит compact snapshot по repository.
- Добавить `buildProjectAnalysisPrompt`.
- Добавить parser/validator для `PROJECT_ANALYSIS:` JSON.
- Добавить `ProjectManagerOrchestrator.runAnalysisOnce(repositoryName)`.
- Сохранять `ProjectAnalysis` и `ProjectManagerRun` в memory/in-memory implementation first, затем PostgreSQL.
- Добавить CLI или internal API endpoint для manual run.

Testing:

- Unit tests на signal collection, prompt formatting, parser validation.
- Smoke test с in-memory tracker: несколько failed/ready/waiting задач -> read-only analysis -> no task proposals created.

### Phase PM-2 - Goal model and storage

**Цель:** сохранить цели как first-class objects, которые можно approve/reject и связывать с задачами.

Работы:

- Добавить migrations: `project_goals`, `project_analyses`, `project_manager_runs`, `project_goal_tasks`.
- Добавить repository interfaces рядом с internal tracker storage.
- Добавить `ProjectGoalPolicy` с duplicate detection по repository + normalized title + evidence.
- Добавить audit events for goal created/approved/rejected/stale.
- Добавить API:
  - `GET /api/project-goals`
  - `GET /api/project-goals/:id`
  - `POST /api/project-goals/:id/commands/approve`
  - `POST /api/project-goals/:id/commands/reject`
  - `POST /api/project-manager/runs`

Testing:

- Unit tests на lifecycle transitions.
- PostgreSQL migration test.
- API role tests: viewer can read, developer/operator can approve depending on chosen policy, admin can force stale/cancel.

### Phase PM-3 - Goal-to-task proposals

**Цель:** PM-агент предлагает конкретные задачи через уже существующий proposal pipeline.

Работы:

- Добавить `TaskProposalBuilder`, который превращает approved goal в 1-N `ProposeTaskInput`.
- В каждый proposal добавлять evidence refs:
  - `external_url` или `metric` для analysis/run;
  - `memory_entry`, `validation_failure`, `review_comment`, `file` по источникам;
  - `external_url`/internal ref на `ProjectGoal`.
- Переиспользовать existing `proposeTask`, duplicate detection, autonomy policy и approvals UI.
- Добавить `projectGoalId` в proposal payload или через `project_goal_tasks` link после создания task.
- Ограничить fan-out: максимум задач на goal и максимум proposals за PM run.

Testing:

- Unit tests: goal with repeated validation failures creates focused tests-only proposal.
- Unit tests: high-risk goal creates proposal-only tasks, not auto-approved tasks.
- Duplicate tests: повторный PM run не создает дубль той же задачи.

### Phase PM-4 - Human UI for goals and roadmap

**Цель:** дать человеку рабочий экран управления целями, а не только список AI proposals.

Работы:

- Добавить Angular route `/goals`.
- Goal list: status, repository, priority, risk, linked tasks, latest run, evidence summary.
- Goal detail: problem statement, desired outcome, success metrics, evidence refs, proposed tasks, decisions, timeline.
- Actions: approve goal, reject goal, request reanalysis, create task proposals, mark goal stale/completed.
- На proposals page показать linked goal title and risk.
- В task detail показать parent goal.

Testing:

- Angular unit tests для goal pages and role capabilities.
- Playwright critical flow: run analysis mock -> approve goal -> generated proposals visible -> approve proposal -> task appears in queue.

### Phase PM-5 - Replanning loop

**Цель:** сделать цикл "анализировать проект заново" управляемым и полезным.

Triggers:

- Scheduled daily/weekly run.
- Task failed after max fix attempts.
- Repeated validation failures.
- Review feedback generated follow-up.
- Goal has all linked tasks done.
- Goal blocked or stale for configurable period.
- Human command: force project reanalysis.

Работы:

- Добавить `replanReason` and previous analysis comparison.
- PM run должен классифицировать active goals:
  - continue;
  - split;
  - pause;
  - mark completed;
  - create follow-up;
  - ask human.
- Добавить digest events and alerts для managers.
- Добавить metrics:
  - `ai_developer_project_manager_runs_total`
  - `ai_developer_project_goals_total`
  - `ai_developer_project_goal_duration_seconds`
  - `ai_developer_project_task_proposals_total`
  - `ai_developer_project_replans_total`

Testing:

- Unit tests на replan classifications.
- Smoke test: failed task -> PM run proposes smaller follow-up or asks human depending on risk.
- Metrics tests.

### Phase PM-6 - Controlled low-risk autonomy

**Цель:** разрешить ограниченную автоматическую постановку задач только там, где это безопасно.

Default policy:

- `PROJECT_MANAGER_AUTO_APPROVE_LOW_RISK=false`.
- Auto-approval можно включить только per repository.
- Разрешенные типы: docs, tests-only, flaky test fixes, small dependency patch/minor update, lint-only cleanup.
- Запрещенные области: auth, secrets, security-sensitive code, payments, DB migrations, public API changes, broad refactors, cross-repository work.

Работы:

- Добавить separate PM policy budgets:
  - max auto-approved goals per day;
  - max auto-approved task proposals per day;
  - max total expected changed files;
  - required confidence threshold;
  - required evidence count.
- Добавить dry-run mode: PM run показывает, что было бы создано.
- Добавить emergency stop: disable PM runs and auto approvals without stopping worker execution.

Testing:

- Policy matrix tests.
- Regression tests that high-risk text blocks auto-approval.
- Rate-limit tests.

### Phase PM-7 - Advanced project intelligence

**Цель:** расширить качество анализа после безопасного MVP.

Направления:

- Repository health index: stale docs, weak test areas, repeated flaky tests, outdated dependencies, risky modules.
- RAG/index integration for codebase-aware planning.
- Cross-repository goals after single-repo flow is stable.
- Goal templates: release readiness, hardening sprint, test coverage sprint, dependency refresh.
- Capacity-aware planning: worker count, queue depth, average task duration, failure rate.
- Manager digest: weekly project health summary and recommended next focus.

## Suggested initial MVP slice

Самый практичный первый срез:

1. `PROJECT_MANAGER_RUN_ONCE=true` manual read-only analysis.
2. Store `ProjectAnalysis` and `ProjectManagerRun`.
3. Generate proposed goals, but require human approval.
4. From approved goal, generate task proposals through existing `proposeTask`.
5. Reuse current proposals page for task-level approval before building full goals UI.

Это даст ценность быстро и не изменит existing worker execution path.

## Пример PM prompt contract

```text
Mode: project-management-analysis-only

Requirements:
1. Analyze only the provided project snapshot.
2. Do not modify repository files.
3. Do not create executable tasks directly.
4. Reply with exactly one line starting with PROJECT_ANALYSIS: followed by compact JSON.
5. Propose goals only when evidence is concrete.
6. Prefer small, reviewable, low-risk goals.
```

Required JSON shape:

```json
{
  "summary": "Project has repeated validation failures around internal tracker proposals and stale docs for PM autonomy.",
  "healthSignals": [
    {
      "kind": "repeated_validation_failure",
      "severity": "medium",
      "evidenceRefs": [
        {
          "kind": "validation_failure",
          "ref": "task_123:quality_gate_run_456",
          "summary": "Same unit test failed twice"
        }
      ],
      "recommendation": "Create focused tests-only stabilization task."
    }
  ],
  "proposedGoals": [
    {
      "title": "Stabilize internal tracker proposal workflow",
      "problemStatement": "Repeated validation failures indicate proposal workflow regressions.",
      "desiredOutcome": "Proposal approval/rejection flow has focused regression coverage and no repeated failures.",
      "successMetrics": ["No repeated validation failures for proposal tests over 7 days"],
      "priority": "high",
      "riskLevel": "low",
      "suggestedTaskProposals": [
        {
          "title": "Add regression coverage for proposal approval retries",
          "taskType": "tests_only",
          "acceptanceCriteria": ["Focused test covers retry idempotency", "npm test passes"],
          "expectedBlastRadius": "tests only"
        }
      ]
    }
  ]
}
```

## Implementation touchpoints

| Area | Current files | Expected changes |
| --- | --- | --- |
| Domain types | `src/domain/taskTracker/types.ts` | Add PM domain types in separate `src/domain/projectManager/types.ts`; avoid bloating task tracker types until links are needed. |
| Storage | `src/integrations/internalTracker/migrations/*`, `postgresTaskTracker.ts`, `inMemoryTaskTracker.ts` | Add PM storage tables and repository/client implementation. Keep existing task tracker methods stable. |
| Orchestration | `src/domain/internalWorkerOrchestrator.ts` | Do not add PM logic here except event hooks later. Create `ProjectManagerOrchestrator`. |
| Proposals | `src/domain/taskTracker/autonomyPolicy.ts`, `TaskTrackerClient.proposeTask` | Reuse for task-level proposals; add PM-specific policy before calling `proposeTask`. |
| Prompts | `src/domain/promptBuilder.ts` | Keep worker prompts separate; add PM prompts under `src/domain/projectManager/promptBuilder.ts`. |
| Config | `src/config.ts`, `src/models/types.ts`, `docs/ENV_CONFIGURATION.md` | Add PM config namespace and docs. |
| API | `src/observability/taskTrackerHumanApi.ts` | Add goals and PM run endpoints or split human API into focused route modules before it grows further. |
| UI | `web/src/app/pages/*`, `web/src/app/services/*` | Add goals pages/services; enhance proposal/task detail with goal links. |
| Tests | `tests/*`, `web/src/app/pages/*spec.ts`, `web/e2e/*` | Add focused PM tests plus one end-to-end approval flow. |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scope creep into full PM suite | MVP only covers AI-work goals and task proposals. No sprint/resource planning first. |
| Too many low-value AI tasks | Strict evidence requirements, duplicate detection, rate limits and human approval by default. |
| Unsafe autonomous work | PM cannot execute code; it only creates proposals. Auto-execution remains low-risk and explicit. |
| Orchestrator complexity | Keep PM orchestrator separate from worker execution orchestrators. Communicate through tracker APIs. |
| Human UI becomes noisy | Group proposed tasks under goals and show policy/evidence summaries first. |
| Replanning loops churn tasks | Use stale thresholds, goal status transitions and "no duplicate proposal" checks. |
| PostgreSQL schema growth | Keep PM tables isolated and linked by ids; do not overload `tasks` table with strategic fields. |

## 30/60/90 day plan

### First 30 days

- Finalize PM domain model and policy.
- Build read-only project analysis run.
- Store analysis/run records.
- Add manual API endpoint and unit tests.
- Keep task creation disabled.

### 60 days

- Add goal storage and approval flow.
- Generate task proposals from approved goals through existing `proposeTask`.
- Add minimal UI support by reusing proposals page plus goal links.
- Add duplicate/rate-limit coverage.

### 90 days

- Add dedicated goals UI.
- Add replanning triggers for failed tasks, stale goals and completed linked tasks.
- Add manager digest metrics/alerts.
- Enable controlled low-risk auto-approval only for explicitly configured repositories.

## MVP acceptance criteria

- A manager/operator can manually run project analysis for one repository.
- The analysis is stored with evidence and can be reviewed later.
- PM-generated goals require approval by default.
- Approved goals can produce task proposals through existing `TaskTrackerClient.proposeTask`.
- PM-created proposals are visible in current proposals workflow and preserve evidence refs.
- Duplicate PM runs do not create duplicate goals or duplicate task proposals.
- Existing Yandex direct mode and internal worker execution tests continue to pass.
- No PM path can directly modify a target repository or bypass quality gates.
- PM autonomy can be disabled globally without disabling normal worker task execution.

