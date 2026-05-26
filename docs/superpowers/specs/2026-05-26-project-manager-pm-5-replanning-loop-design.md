# Project Manager PM-5 Replanning Loop Design

## Context

PM-0 through PM-4 established the Project Manager Agent as a planning layer
over the internal task tracker. The system can collect read-only project
signals, ask Codex for a `PROJECT_ANALYSIS`, store analyses/runs/goals, approve
goals, generate bounded task proposals from approved or active goals, and show
goal context in the Angular console.

PM-5 adds the next loop: after work happens, the Project Manager can re-analyze
active goals and classify whether each goal should continue, be split, be
paused, be completed, create follow-up work, or ask a human for direction.

## Goal

Build a minimal manual/event-ready replanning loop without a scheduler. The loop
must be callable by a human/operator or by future task events, store its
decisions, expose them through the human API and console, and preserve the
existing proposal-only safety model.

## Non-Goals

PM-5 does not implement daily/weekly scheduling, background timers, GitLab or
Yandex webhooks, capacity planning, sprint planning, cross-repository planning,
or automatic execution of generated tasks.

PM-5 does not let replanning bypass proposal approval. Any follow-up work is
stored as proposed goals or task proposal drafts and must still flow through the
existing goal approval and task proposal approval path.

## Replan Triggers

PM-5 supports these trigger sources at the domain/API boundary:

- manual: operator explicitly runs a replan from the console or API
- post_task_event: future worker/orchestrator event hook calls the same
  `runReplanOnce` method after a task fails, receives review feedback, or
  reaches a terminal state

The scheduler trigger remains defined by the existing `ProjectManagerTrigger`
type, but PM-5 does not add a runtime scheduler.

## Replan Decisions

Each active or approved goal can receive one decision:

- `continue`: the goal remains valid and no immediate action is needed
- `split`: the goal is too broad and should be represented by smaller proposed
  follow-up goals
- `pause`: the goal should remain active/approved but should not create new
  proposals until a later replan
- `mark_completed`: the goal can be completed because its linked tasks are done
- `create_follow_up`: create one or more evidence-backed proposed goals for
  follow-up work
- `ask_human`: record a question or diagnostic for human decision, without
  mutating task state

Decisions are stored in the analysis record and appended to the goal audit
timeline. The audit event kind is `project_goal_replan_classified`.

## Data Model

Add PM domain types:

```typescript
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

Extend `ProjectAnalysis` and `ParsedProjectAnalysis` with:

```typescript
previousAnalysisId?: string;
goalReplans: ProjectGoalReplanClassification[];
```

PostgreSQL stores these fields in `project_analyses.previous_analysis_id` and
`project_analyses.goal_replans jsonb`.

## Replan Snapshot

The replan prompt receives a compact snapshot with:

- normal project signal snapshot from `collectProjectSignals`
- active and approved goals for the repository
- linked task ids per goal
- linked task status/title/updated time
- goal audit summary
- previous analysis id and summary when available
- explicit `replanReason`

The snapshot must stay read-only. The orchestrator may call task tracker read
methods such as `listTasks` and `getTask`, but must not call `createTask`,
`proposeTask`, proposal approvals, status mutations, leases, or worker runtime
methods during replan analysis.

## Prompt Contract

Add a `PROJECT_REPLAN:` marker. Codex must return one line:

```text
PROJECT_REPLAN: { ...json... }
```

The JSON shape is:

```json
{
  "summary": "Replan summary",
  "healthSignals": [],
  "proposedGoals": [],
  "staleGoalIds": [],
  "replanReason": "manual: failed linked task",
  "previousAnalysisId": "pm_analysis_123",
  "goalReplans": [
    {
      "goalId": "pm_goal_123",
      "decision": "create_follow_up",
      "rationale": "Linked task failed twice; propose a smaller tests-only follow-up.",
      "evidenceRefs": [
        {
          "kind": "validation_failure",
          "ref": "task_123:quality_gate_run_456",
          "summary": "Same test failed twice"
        }
      ],
      "followUpGoals": [
        {
          "title": "Stabilize focused regression coverage",
          "problemStatement": "The original goal is blocked by a repeated validation failure.",
          "desiredOutcome": "A smaller tests-only goal resolves the failure before broader work continues.",
          "successMetrics": ["The linked failing test passes in the next run"],
          "evidenceRefs": [],
          "priority": "high",
          "riskLevel": "low",
          "suggestedTaskProposals": []
        }
      ],
      "humanQuestion": "Only set when decision is ask_human."
    }
  ]
}
```

## Policy

Replan policy validates:

- at most 20 `goalReplans`
- every `goalId` belongs to an approved or active goal in the current repository
- every decision is one of the allowed values
- every `followUpGoals` entry satisfies the existing project analysis policy
- `ask_human` requires `humanQuestion`
- `mark_completed` is only applied automatically when the goal is active and
  all linked tasks are `done`
- `mark_completed` with no linked tasks, failed tasks, cancelled tasks, or
  non-terminal tasks is recorded as an audit decision but does not complete the
  goal
- high-risk follow-up goals remain proposed and never create executable tasks

The orchestrator may auto-complete a goal only for the safe `mark_completed`
case above. Other decisions only record audit metadata and/or create proposed
goals through `createGoalsFromAnalysis`.

## Runtime Flow

1. `runReplanOnce({ repositoryName, reason, trigger })` checks
   `ProjectManagerConfig.enabled`.
2. It starts a `ProjectManagerRun` with `trigger` defaulting to `manual`.
3. It collects the replan snapshot.
4. It builds a `PROJECT_REPLAN` prompt and runs Codex read-only.
5. It parses and validates the response.
6. It records a `ProjectAnalysis` with `replanReason`, `previousAnalysisId`,
   `goalReplans`, and any proposed follow-up goals.
7. It materializes proposed follow-up goals through `createGoalsFromAnalysis`.
8. It appends one `project_goal_replan_classified` audit event per
   classification.
9. It completes safe `mark_completed` goals.
10. It completes the PM run with the analysis id and proposed goal ids.
11. It records metrics for run outcome, goal decisions, created goals, and
    replan count.

Failed parser/policy/Codex runs mark the PM run failed and preserve the
diagnostic.

## API

Extend `POST /api/project-manager/runs` to accept:

```json
{
  "repositoryName": "developer",
  "mode": "replan",
  "replanReason": "manual review after linked task failure"
}
```

Behavior:

- `mode` defaults to `"analysis"` for backward compatibility
- `mode: "analysis"` calls existing `runAnalysisOnce`
- `mode: "replan"` calls `runReplanOnce`
- role remains `operator+`
- response shape remains `{ result }`

The goal detail response already includes audit events; PM-5 adds the new audit
event kind and optional `goalReplans` data on analysis-backed responses.

## Angular UI

Keep UI minimal:

- Add `ProjectGoalService.runReplan(repositoryName, replanReason)`.
- On `/goals/:goalId`, show a "Запустить replan" action for `operator+`.
- Use a small dialog/textarea for `replanReason`.
- After success, refresh goal detail and show a toast.
- Render `project_goal_replan_classified` audit events in the existing audit
  timeline with decision and rationale from payload.

The list page can continue to use the existing "Запустить анализ" action. PM-5
does not add a separate roadmap editor.

## Metrics

Add metrics through `MetricsRegistry`:

- `ai_developer_project_manager_runs_total` with labels `repository`, `mode`,
  `trigger`, `status`
- `ai_developer_project_goals_total` with labels `repository`, `status`,
  `source`
- `ai_developer_project_goal_duration_seconds` histogram with labels
  `repository`, `status`
- `ai_developer_project_task_proposals_total` with labels `repository`,
  `source`
- `ai_developer_project_replans_total` with labels `repository`, `decision`

PM-5 must at least increment run/replan/goal counters from the orchestrator.
Duration histograms can be recorded when goals are completed.

## Testing

Backend/domain tests:

- parser accepts valid `PROJECT_REPLAN` and rejects invalid markers/decisions
- policy rejects unknown goal ids, too many classifications, and invalid
  follow-up goals
- orchestrator stores a completed replan run without task mutations
- failed linked task can produce `create_follow_up` or `ask_human`
- safe `mark_completed` completes only active goals whose linked tasks are all
  `done`
- unsafe `mark_completed` records audit only and leaves the goal active
- metrics are emitted for replan runs and decisions

Store tests:

- in-memory and PostgreSQL persist `goalReplans` and `previousAnalysisId`
- audit event `project_goal_replan_classified` persists payload

API tests:

- operator can run `mode: "replan"`
- viewer/developer cannot run replan
- missing `replanReason` for replan returns a validation error
- existing analysis mode remains compatible

Angular tests:

- goal detail shows replan action only with `canRunProjectManager`
- replan dialog posts `{ repositoryName, mode: "replan", replanReason }`
- audit timeline renders replan decision/rationale payload

E2E:

- operator opens a goal, runs replan, sees replan audit event after refresh
- viewer can see audit but cannot run replan

## Acceptance Criteria

- Manual replan can be triggered without adding a scheduler.
- Replan decisions are stored, auditable, and visible on goal detail.
- Replan never calls task creation or proposal approval paths directly.
- Safe completion is automatic only for active goals with all linked tasks done.
- Follow-up work remains proposed and must pass the existing approval workflow.
- Existing PM analysis runs, goals UI, proposals UI, and worker flows remain
  compatible.
- Required verification passes: focused PM tests, root typecheck, root tests,
  web typecheck, web tests, and web e2e.
