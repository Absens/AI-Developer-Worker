# Project Manager Product and Technical Strategy Mode Design

## Context

The current Project Manager subsystem has two AI modes:

- `analysis`: reads an internal task snapshot and proposes evidence-backed project goals.
- `replan`: reads approved/active goals plus linked tasks and classifies what to do with existing goals.

Both modes are operational. They reason from queue health, failures, review state,
validation summaries, active leases, and linked goal execution. This is useful for
delivery hygiene, but it is narrower than product strategy. A product/technical
strengthening pass needs to ask a different question:

> What should we improve in the product and its technical foundation, even if it
> is not currently represented as a failed task or active goal?

This design adds a separate PM mode for that question instead of overloading
`analysis` or `replan`.

## Goal

Add a manual, read-only Project Manager strategy mode that identifies product and
technical improvement opportunities, ranks them by impact and evidence quality,
and optionally materializes the strongest opportunities as normal proposed
`ProjectGoal` records for human approval.

The mode should improve PM output quality without weakening the existing safety
model:

- no direct executable task creation;
- no repository writes;
- no external service calls from the PM prompt;
- no bypass of goal approval or proposal approval;
- bounded output, duplicate protection, and evidence requirements.

## Non-Goals

This mode is not a product analytics platform. It does not ingest telemetry,
customer interviews, support tickets, revenue metrics, or usage funnels unless
those inputs are later added as explicit read-only signals.

This mode is not a scheduler. It should be callable manually first through the
existing `POST /api/project-manager/runs` shape.

This mode does not replace `analysis` or `replan`. It complements them:

- `analysis` answers: "What project-health goals should we propose from current
  task tracker state?"
- `replan` answers: "What should happen to already approved/active goals?"
- `strategy` answers: "What product and technical opportunities should we
  consider next?"

## Recommended Approach

Use a new explicit run mode: `mode: "strategy"`.

The implementation should add a new prompt contract and parser marker:

```text
PROJECT_STRATEGY: {"summary":"...","opportunities":[...],"proposedGoals":[...],"questionsForHuman":[...]}
```

The strategy output should be stored as a `ProjectAnalysis`-compatible run with
additional strategy metadata. A separate `ProjectStrategyAnalysis` aggregate is
unnecessary for the first implementation because strategy runs share the same
repository, run, goal materialization, and audit boundaries as analysis runs.

The recommended first slice is:

1. Add a strategy snapshot builder that reuses current project signals and adds
   compact repository/product context fields that are already available.
2. Add `buildProjectStrategyPrompt`.
3. Add parser and policy validation for `PROJECT_STRATEGY`.
4. Let strong `proposedGoals` materialize through the same
   `createGoalsFromAnalysis` path as `analysis`.
5. Keep `opportunities` as stored/readable strategy metadata, not executable
   work.

Reasoning: this gives useful PM guidance quickly while preserving the existing
approval path. Product ideas become visible, but work still enters the system
through goals and task proposals.

## Alternatives Considered

### Alternative A: Strengthen Existing `analysis` Prompt Only

This is the smallest change. Add product/technical instructions to
`buildProjectAnalysisPrompt` and keep the current `PROJECT_ANALYSIS` schema.

Trade-off: it blurs operational project health with strategic opportunity
discovery. The model may start proposing broader goals during ordinary health
analysis, which makes repeated runs noisier and harder to evaluate.

### Alternative B: Add `strategy` Mode With Existing `ProjectGoalDraft` Only

This adds `mode: "strategy"` but asks the model to return only `proposedGoals`.

Trade-off: simple storage, but weak product reasoning. Operators would see final
goals without a structured opportunity layer explaining product impact,
technical impact, confidence, or why the model deferred other ideas.

### Alternative C: Add `strategy` Mode With Structured Opportunities

This adds a separate prompt and response shape containing both opportunities and
optional proposed goals.

Trade-off: more parser/storage/UI work, but clearer semantics. It separates
strategic reasoning from goal materialization and gives humans a better review
surface.

Recommendation: Alternative C.

## Strategy Snapshot

The first version should stay read-only and use data the system already has:

- current `ProjectSignalSnapshot`;
- recent project analyses and replan summaries;
- approved/active/completed/stale goals;
- linked task outcomes;
- recent review/human-testing tasks;
- repeated failures and failed validations;
- task types and unknown task type frequency;
- proposal backlog and approval/rejection patterns;
- repository profile metadata: queues, tags, base branch, focus areas, allowed
  PM task types;
- optional operator-provided strategy brief from the run request.

The request body can include a bounded manual brief:

```json
{
  "repositoryName": "client-application",
  "mode": "strategy",
  "strategyBrief": "Focus on curator workflow quality and developer velocity."
}
```

The brief is optional. It should be treated as context, not an instruction to
ignore evidence.

## Product vs Technical Dimensions

Each opportunity should identify its dominant dimension:

- `product`: user workflow, UX clarity, onboarding, task completion, operator
  visibility, documentation that changes user behavior.
- `technical`: reliability, test coverage, CI quality, dependency hygiene,
  architecture, observability, maintainability.
- `product_technical`: technical work with clear product leverage, such as
  reducing failure rate in a user-critical flow or making role permissions safer.

The prompt should explicitly discourage speculative product claims. If the
snapshot lacks product evidence, the model should either:

- frame the idea as a technical opportunity with possible product impact; or
- return a `questionsForHuman` entry asking for product context.

## Response Contract

Keep machine contract fields in English. Human-facing string values follow the
same language behavior as the current PM prompts until a separate language
configuration is added.

Suggested JSON schema:

```json
{
  "summary": "string",
  "opportunities": [
    {
      "dimension": "product|technical|product_technical",
      "title": "string",
      "problemStatement": "string",
      "userOrBusinessImpact": "string",
      "technicalImpact": "string",
      "evidenceRefs": [
        { "kind": "task|snapshot|metric|file|external_url|validation_failure|review_comment|memory_entry", "ref": "string", "summary": "string" }
      ],
      "confidence": 0,
      "priority": "low|normal|high|critical",
      "riskLevel": "low|medium|high",
      "recommendedNextStep": "create_goal|research|ask_human|defer",
      "rationale": "string"
    }
  ],
  "proposedGoals": [
    {
      "title": "string",
      "problemStatement": "string",
      "desiredOutcome": "string",
      "successMetrics": ["string"],
      "evidenceRefs": [
        { "kind": "task|snapshot|metric|file|external_url|validation_failure|review_comment|memory_entry", "ref": "string", "summary": "string" }
      ],
      "priority": "low|normal|high|critical",
      "riskLevel": "low|medium|high",
      "suggestedTaskProposals": [
        {
          "title": "string",
          "description": "string",
          "taskType": "allowed task type",
          "acceptanceCriteria": ["string"],
          "expectedBlastRadius": "string",
          "evidenceRefs": [
            { "kind": "task|snapshot|metric|file|external_url|validation_failure|review_comment|memory_entry", "ref": "string", "summary": "string" }
          ]
        }
      ]
    }
  ],
  "questionsForHuman": [
    {
      "question": "string",
      "whyItMatters": "string",
      "relatedOpportunityTitle": "string"
    }
  ]
}
```

`proposedGoals` should be a subset of high-confidence opportunities. The prompt
should say that an opportunity does not need to become a goal immediately.

## Prompt Improvements

The current PM prompts are intentionally minimal. Strategy mode should use
stronger instructions:

- Separate observed evidence from inference.
- Do not treat placeholder validation commands as strong quality evidence.
- Prefer opportunities with direct evidence from tasks, reviews, failures,
  validation summaries, or linked goals.
- Include product impact only when the snapshot supports it; otherwise state the
  missing product signal as a human question.
- Prefer small, reviewable goals over broad roadmap themes.
- Suggest at most one or two concrete task proposals per goal unless the
  evidence clearly supports more.
- Make acceptance criteria objectively checkable.
- Avoid proposing code work for unclear product ideas; propose research or a
  human question first.
- Explicitly label low-confidence opportunities as `research`, `ask_human`, or
  `defer`.

The existing `analysis` and `replan` prompts should also receive smaller
quality improvements:

- "Do not create goals from weak or missing evidence."
- "If the snapshot only shows no-op validation commands, treat validation
  confidence as weak."
- "Avoid duplicate goals that differ only in wording."
- "Prefer tests-only or documentation proposals when the evidence points to
  validation/reporting/documentation gaps."
- "Keep goal scope small enough for one or two task proposals."

## Policy and Validation

Add hard limits similar to existing PM analysis policy:

- max opportunities per run: 10;
- max questions for human: 5;
- max evidence refs per opportunity: 10;
- max proposed goals: existing `maxGoalsPerRun`;
- max task proposals per goal: existing `maxTaskProposalsPerGoal`;
- confidence integer: 0 through 100;
- opportunity text fields bounded by the existing PM text limits.

Policy should reject:

- opportunities without evidence refs;
- `create_goal` opportunities with confidence below 60;
- proposed goals whose evidence does not overlap at least one opportunity;
- high-risk proposed goals that include broad executable task proposals;
- unknown task types outside `PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON`.

The confidence threshold should start hardcoded in policy and become configurable
only after the mode proves useful.

## API Shape

Extend the existing PM run endpoint:

```http
POST /api/project-manager/runs
```

Request:

```json
{
  "repositoryName": "client-application",
  "mode": "strategy",
  "strategyBrief": "Find product and technical improvements for the curator tracker workflow."
}
```

Response:

```json
{
  "run": { "id": "pm_run_...", "status": "completed" },
  "analysis": { "id": "pm_analysis_..." },
  "strategy": {
    "summary": "...",
    "opportunities": [],
    "questionsForHuman": []
  }
}
```

The role should match current PM run permissions: `operator+`.

## Storage Design

Use the existing `ProjectAnalysis` storage boundary and add optional fields:
  - `strategyOpportunities`;
  - `strategyQuestions`;
  - `strategyBrief`;
  - `analysisKind: "analysis" | "replan" | "strategy"`.

This keeps strategy runs near existing PM history and avoids another top-level
store while the product value is being validated.

PostgreSQL can store the new fields in `project_analyses` as JSONB columns.
In-memory store can add optional properties to the existing analysis record.

If strategy mode grows into portfolio planning, split it later into
`project_strategy_analyses` and `project_strategy_opportunities`.

## Goal Materialization

Only `proposedGoals` from the strategy response should create `ProjectGoal`
records. Raw `opportunities` are advisory and should not create goals by
themselves.

The normal duplicate goal policy still applies. A strategy run should not create
another non-terminal goal with the same normalized title and evidence signature.

Goal-derived tasks remain unchanged:

```text
strategy run -> proposed goals -> human approves goal -> propose-tasks -> proposal approval -> worker execution
```

No strategy path should call `createTask`.

## UI Design

Initial UI can be minimal:

- Add `strategy` as a selectable mode in the existing manual PM run action.
- Add optional strategy brief input.
- Show strategy run results in a compact section on the goals or operations page:
  - summary;
  - opportunities grouped by dimension;
  - confidence, priority, risk, recommended next step;
  - linked proposed goals;
  - questions for human.

Avoid building a full roadmap board in the first implementation. The existing
goal list/detail flow is enough once strategic opportunities can materialize as
goals.

## Safety Invariants

- Strategy mode runs Codex with `sandbox: "read-only"`.
- Strategy mode does not modify repository files.
- Strategy mode does not call external services.
- Strategy mode does not create executable tasks.
- Strategy mode may only create proposed goals through the same store path as
  `analysis`.
- Strategy-created goals still require the existing human approval flow.
- Strategy-created task proposals still require `POST /api/project-goals/:id/commands/propose-tasks`.
- Proposal approval remains the existing task proposal workflow.
- Viewer remains read-only.
- Developer cannot fan out PM task proposals.
- Operator can run strategy and propose tasks, but cannot bypass proposal
  approval.

## Testing Strategy

Backend unit tests:

- prompt includes strategy-specific guardrails and response schema;
- parser accepts valid `PROJECT_STRATEGY` and rejects invalid markers, invalid
  JSON, missing evidence, invalid dimensions, invalid next steps;
- policy rejects low-confidence `create_goal` opportunities;
- policy rejects proposed goals not backed by opportunity evidence;
- orchestrator records strategy runs and materializes only `proposedGoals`;
- repeated strategy runs do not duplicate non-terminal goals.

API tests:

- operator can run `mode: "strategy"`;
- developer/viewer cannot run strategy;
- missing/oversized strategy brief is rejected with a clear error;
- unavailable PM dependencies return the same style of 503 as analysis/replan.

UI tests:

- manual run form can choose strategy mode and send strategy brief;
- strategy results render grouped opportunities;
- strategy-created goals appear in `/goals`;
- no UI path calls `POST /api/tasks` for strategy output.

E2E:

- run strategy with a mock response;
- verify opportunities are visible;
- approve a strategy-created goal;
- propose tasks from that goal;
- approve proposal through existing proposals flow;
- verify task appears in queue.

## Rollout Plan

1. Prompt-only quality pass for existing `analysis` and `replan`.
2. Add strategy parser/policy/types with tests.
3. Add strategy snapshot and orchestrator path.
4. Add storage fields for strategy metadata.
5. Add API support for `mode: "strategy"`.
6. Add minimal UI controls and rendering.
7. Add Playwright critical flow.

This order keeps prompt quality improvements independently shippable and keeps
the new mode behind explicit manual invocation.

## Product Operating Guidance

Operators should use strategy mode when they want roadmap-quality suggestions,
not when they need immediate queue triage.

Good strategy brief examples:

- "Find product and technical improvements for the curator tracker workflow."
- "Focus on reducing review churn and making validation evidence trustworthy."
- "Look for small improvements that increase operator confidence in PM-created work."

Poor strategy brief examples:

- "Create tasks for everything."
- "Rewrite the app."
- "Find growth ideas" without product context or evidence.

When product evidence is weak, the desired behavior is to ask focused human
questions rather than invent product claims.
