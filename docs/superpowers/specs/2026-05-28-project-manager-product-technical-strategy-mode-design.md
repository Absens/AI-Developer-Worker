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
PROJECT_STRATEGY: {"summary":"...","analysisLenses":[...],"opportunities":[...],"proposedGoals":[...],"questionsForHuman":[...]}
```

The strategy output should be stored as a `ProjectAnalysis`-compatible analysis
record with additional strategy metadata. The run record itself should also
store the PM mode (`analysis`, `replan`, or `strategy`) so failed runs are still
auditable by mode even when no analysis record is created.

A separate `ProjectStrategyAnalysis` aggregate is unnecessary for the first
implementation because strategy runs share the same repository, run, goal
materialization, and audit boundaries as analysis runs.

The recommended first slice is:

1. Add a strategy snapshot builder with an explicit `ProjectStrategySnapshot`
   contract. It should reuse current project signals and add compact
   repository, goal, proposal, and product-context fields that are already
   available.
2. Add `buildProjectStrategyPrompt`.
3. Add parser and policy validation for `PROJECT_STRATEGY`.
4. Let strong `proposedGoals` materialize through the same
   `createGoalsFromAnalysis` path as `analysis`.
5. Keep `opportunities` as stored/readable strategy metadata, not executable
   work.

Reasoning: this gives useful PM guidance quickly while preserving the existing
approval path. Product ideas become visible, but work still enters the system
through goals and task proposals.

## Cognitive Lens Architecture

Strategy mode should use cognitive modes as an internal prompt architecture, not
as a large user-facing mode library. The Project Manager should run a fixed
multi-lens analysis pipeline and then return a compact, policy-checkable JSON
result.

The first version should use these lenses:

- `strategic`: baseline framing for direction, leverage, cost of delay, and
  second-order effects.
- `defamiliarizing`: challenge the current framing and identify hidden
  assumptions in product, process, and architecture.
- `empathic`: examine user, operator, reviewer, and developer impact.
- `executive`: convert broad opportunities into small, reviewable goals and
  task proposal outlines.
- `red_team`: attack opportunities for weak evidence, edge cases, hidden cost,
  implementation risk, and likely misunderstanding.
- `sober_architect`: final feasibility, support cost, and trade-off filter.
- `synthetic`: assemble the final answer into the required schema without
  carrying speculative intermediate ideas forward.

`associative` can be used only as a bounded expansion step inside
`defamiliarizing`, for example to look for non-obvious product or technical
angles. It should never be the final decision lens.

`alien` should not be part of the default Project Manager loop. It is useful as
a power-user research prompt, but it is too unconstrained for recurring PM
analysis. If added later, it should be an explicit manual research mode that
cannot materialize goals.

The recommended internal sequence is:

```text
1. Strategic framing
2. Product and technical opportunity discovery
3. Defamiliarizing reframing
4. Empathic impact check
5. Executive conversion to actionable goals
6. Red Team rejection and risk reduction
7. Sober Architect final decision
8. Synthetic JSON output
```

This sequence is intentionally asymmetric. Creative lenses expand the search
space, but `red_team` and `sober_architect` are mandatory gates before any
`proposedGoals` are emitted.

The prompt should not expose chain-of-thought. Instead, it should return short
audit summaries that explain which evaluation lenses affected the final answer.
This gives humans useful review context without storing hidden reasoning.

Suggested run-level field:

```json
{
  "analysisLenses": [
    {
      "lens": "strategy|reframing|empathy|execution|risk|architecture|synthesis",
      "summary": "string"
    }
  ]
}
```

Suggested opportunity-level fields:

```json
{
  "opportunityId": "stable short id unique within the strategy response",
  "redTeamNotes": ["string"],
  "architectVerdict": "pursue|research_first|defer|reject"
}
```

`architectVerdict` should drive goal materialization:

- `pursue`: can become a proposed goal if evidence and policy checks pass.
- `research_first`: should become a human question or research opportunity, not
  executable work.
- `defer`: keep visible as context, but do not create a goal.
- `reject`: include only when useful to explain why an attractive idea was not
  pursued.

The UI should not initially present all cognitive modes as choices. A future
power-user UI can expose a small set of action labels mapped to internal lenses:

- "Find opportunities" -> `strategic` + `defamiliarizing` +
  `sober_architect`.
- "Reframe product" -> `defamiliarizing` + bounded `associative` +
  `synthetic`.
- "Review risks" -> `red_team` + `sober_architect`.
- "Build action plan" -> `executive` + `synthetic`.

For the first implementation, prefer a single fixed strategy pipeline. This
keeps the operator experience simple and makes outputs easier to test.

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

The first version should stay read-only and use data the system already has, but
it should not overload `ProjectSignalSnapshot`. Add a separate
`ProjectStrategySnapshot` so the prompt, tests, and future UI can distinguish
operational health inputs from strategy inputs.

Suggested first-version snapshot shape:

```json
{
  "repositoryName": "string",
  "generatedAt": "ISO timestamp",
  "strategyBrief": "string optional",
  "projectSignals": "ProjectSignalSnapshot",
  "recentAnalyses": [
    {
      "id": "string",
      "analysisKind": "analysis|replan|strategy",
      "summary": "string",
      "createdAt": "ISO timestamp"
    }
  ],
  "goals": [
    {
      "id": "string",
      "status": "proposed|approved|active|completed|rejected|stale",
      "title": "string",
      "priority": "low|normal|high|critical",
      "riskLevel": "low|medium|high",
      "summary": "string",
      "linkedTaskOutcomes": [
        {
          "taskId": "string",
          "status": "string",
          "latestValidationSummary": "string optional",
          "failedAgentRuns": 0,
          "failedValidations": 0
        }
      ]
    }
  ],
  "proposalBacklog": {
    "proposed": 0,
    "approved": 0,
    "autoApproved": 0,
    "rejected": 0,
    "stale": 0
  },
  "taskTypeSummary": {
    "counts": { "task type": 0 },
    "unknownTaskTypeCount": 0
  },
  "repositoryProfile": {
    "baseBranch": "string optional",
    "queue": "string optional",
    "tags": ["string"],
    "focusAreas": ["string"],
    "allowedProjectManagerTaskTypes": ["task type"]
  },
  "productContext": {
    "knownUsersOrRoles": ["string"],
    "knownWorkflows": ["string"],
    "knownProductSignals": ["string"],
    "missingProductSignals": ["string"]
  }
}
```

The snapshot should include compact summaries rather than full records. The
initial implementation can leave `productContext` fields empty when no explicit
product data exists; the prompt should turn that absence into questions instead
of inventing product claims.

The data sources are:

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

The brief is optional. It should be trimmed, capped at 2,000 characters, stored
with the analysis metadata, and treated as context rather than an instruction to
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
  "analysisLenses": [
    {
      "lens": "strategy|reframing|empathy|execution|risk|architecture|synthesis",
      "summary": "string"
    }
  ],
  "opportunities": [
    {
      "opportunityId": "opp-1",
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
      "rationale": "string",
      "redTeamNotes": ["string"],
      "architectVerdict": "pursue|research_first|defer|reject"
    }
  ],
  "proposedGoals": [
    {
      "sourceOpportunityId": "opp-1",
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
      "relatedOpportunityId": "string optional",
      "relatedOpportunityTitle": "string"
    }
  ]
}
```

`proposedGoals` should be a subset of high-confidence opportunities. The prompt
should say that an opportunity does not need to become a goal immediately.
Only opportunities with `architectVerdict: "pursue"` should be eligible for goal
materialization.

`sourceOpportunityId` is required for every `proposedGoals` entry in
`PROJECT_STRATEGY`. It gives policy a stable machine link instead of relying
only on title matching or evidence overlap. The existing `ProjectGoalDraft`
storage shape does not need to persist this field in `project_goals`; it can be
used during parsing/policy validation and retained in `strategyGoalLinks`
metadata.

## Prompt Improvements

The current PM prompts are intentionally minimal. Strategy mode should use
stronger instructions:

- Follow the cognitive lens sequence: strategic framing, reframing, empathy,
  execution, risk, architecture, synthesis.
- Use creative and reframing lenses to generate options, but apply `red_team`
  and `sober_architect` before emitting any `proposedGoals`.
- Return only short lens summaries, not hidden reasoning or long internal
  deliberation.
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
- max analysis lenses per run: 7;
- max red team notes per opportunity: 5;
- unique `opportunityId` per opportunity;
- required `sourceOpportunityId` per proposed goal;
- opportunity text fields bounded by the existing PM text limits.

Policy should reject:

- opportunities without evidence refs;
- duplicate or missing opportunity ids;
- `create_goal` opportunities with confidence below 60;
- `create_goal` opportunities whose `architectVerdict` is not `pursue`;
- proposed goals without a valid `sourceOpportunityId`;
- proposed goals whose `sourceOpportunityId` points to an opportunity whose
  `architectVerdict` is not `pursue`;
- proposed goals whose evidence does not overlap the referenced opportunity;
- high-risk proposed goals with more than one suggested task proposal;
- high-risk proposed goals whose suggested task proposals use task types other
  than `documentation` or `tests_only` unless the goal has critical priority and
  direct validation, review, or task-failure evidence;
- unknown task types outside `PROJECT_MANAGER_ALLOWED_TASK_TYPES_JSON`.

The confidence threshold should start hardcoded in policy and become configurable
only after the mode proves useful.

Evidence overlap should compare normalized `(kind, ref)` pairs. Summaries are
human context and should not be used as the identity key.

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
  "result": {
    "run": { "id": "pm_run_...", "status": "completed", "mode": "strategy" },
    "analysis": { "id": "pm_analysis_...", "analysisKind": "strategy" },
    "strategy": {
      "summary": "...",
      "analysisLenses": [],
      "opportunities": [],
      "goalLinks": [],
      "questionsForHuman": []
    }
  }
}
```

Keep the existing `{ "result": ... }` envelope used by the PM run endpoint so
current UI and API clients do not need a response-shape migration just to add the
new mode.

The role should match current PM run permissions: `operator+`.

Add a read endpoint for stored PM analyses so strategy results are not visible
only in the immediate POST response:

```http
GET /api/project-manager/analyses?repositoryName=client-application&analysisKind=strategy
```

Response:

```json
{
  "analyses": [
    {
      "id": "pm_analysis_...",
      "repositoryName": "client-application",
      "analysisKind": "strategy",
      "summary": "...",
      "strategy": {
        "summary": "...",
        "analysisLenses": [],
        "opportunities": [],
        "goalLinks": [],
        "questionsForHuman": []
      },
      "createdAt": "ISO timestamp"
    }
  ]
}
```

`viewer+` can read analyses. `operator+` is still required to create new PM
runs.

## Storage Design

Store run mode on every `ProjectManagerRun`:

- `mode: "analysis" | "replan" | "strategy"`.

This must be on the run record, not only the analysis record, because failed
runs may never produce a `ProjectAnalysis`. PostgreSQL should add a non-null
`mode` text column to `project_manager_runs` with a check constraint and
backfill existing rows as `analysis` when no better historical signal exists.
New `startRun` calls should require mode explicitly instead of inferring it
later.

Use the existing `ProjectAnalysis` storage boundary and add optional fields:
  - `strategyAnalysisLenses`;
  - `strategyOpportunities`;
  - `strategyGoalLinks`;
  - `strategyQuestions`;
  - `strategyBrief`;
  - `analysisKind: "analysis" | "replan" | "strategy"`.

This keeps strategy runs near existing PM history and avoids another top-level
store while the product value is being validated.

PostgreSQL can store the strategy fields in `project_analyses` as JSONB columns.
`analysisKind` should be a non-null text column with a check constraint. Existing
analysis rows can be backfilled as `replan` when `replan_reason` is present and
`analysis` otherwise. In-memory store can add optional properties to the
existing analysis record.

`strategyGoalLinks` should preserve the strategy-only link between an
opportunity and each proposed goal draft:

```json
[
  {
    "sourceOpportunityId": "opp-1",
    "proposedGoalTitle": "string",
    "evidenceRefs": []
  }
]
```

Do not persist `sourceOpportunityId` on `project_goals` in the first
implementation unless goal-source traceability later needs it in the goal detail
view. `strategyGoalLinks` retains the opportunity-to-goal relationship without
changing the goal storage contract.

If strategy mode grows into portfolio planning, split it later into
`project_strategy_analyses` and `project_strategy_opportunities`.

## Goal Materialization

Only `proposedGoals` from the strategy response should create `ProjectGoal`
records. Raw `opportunities` are advisory and should not create goals by
themselves.

Before materialization, policy must verify that each proposed goal references a
valid `pursue` opportunity through `sourceOpportunityId` and has overlapping
evidence with that opportunity. The materialization step should strip
strategy-only fields before passing drafts to `createGoalsFromAnalysis`.

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
- Show the latest strategy run results from
  `GET /api/project-manager/analyses?analysisKind=strategy` in a compact section
  on the goals or operations page:
  - summary;
  - short lens summaries as review context;
  - opportunities grouped by dimension;
  - confidence, priority, risk, recommended next step, architect verdict;
  - red team notes for opportunities with meaningful risk;
  - linked proposed goals;
  - questions for human.

The immediate POST response can optimistically render the completed strategy
result, but the page should refresh from the read endpoint so results remain
available after navigation or reload.

Avoid building a full roadmap board in the first implementation. The existing
goal list/detail flow is enough once strategic opportunities can materialize as
goals. Also avoid exposing all cognitive modes as user controls in the first
slice. The fixed strategy pipeline should be visible through its outputs, not
through a complex configuration surface.

## Safety Invariants

- Strategy mode runs Codex with `sandbox: "read-only"`.
- Strategy mode does not modify repository files.
- Strategy mode does not call external services.
- If the Codex runner cannot enforce network isolation, "does not call external
  services" is a prompt and operational invariant rather than a sandbox
  guarantee. Document that limitation in the implementation and add a runner
  option later if the CLI exposes network-off execution.
- Strategy mode should analyze only the bounded `ProjectStrategySnapshot`.
  Allowing Codex to inspect repository files directly is out of scope for the
  first version unless a separate bounded repository scan is added to the
  snapshot builder.
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
- parser validates `analysisLenses`, `redTeamNotes`, and `architectVerdict`
  bounds;
- parser requires unique `opportunityId` values and `sourceOpportunityId` on
  every strategy proposed goal;
- policy rejects low-confidence `create_goal` opportunities;
- policy rejects `create_goal` opportunities without a `pursue` architect
  verdict;
- policy rejects proposed goals with missing or unknown `sourceOpportunityId`;
- policy rejects proposed goals not backed by opportunity evidence;
- policy rejects proposed goals backed only by deferred, rejected, or
  research-first opportunities;
- policy rejects high-risk proposed goals with broad executable task proposal
  fan-out;
- orchestrator records strategy runs and materializes only `proposedGoals`;
- storage preserves `strategyGoalLinks` after strategy-only fields are stripped
  before goal creation;
- failed runs still persist `ProjectManagerRun.mode = "strategy"`;
- repeated strategy runs do not duplicate non-terminal goals.

API tests:

- operator can run `mode: "strategy"`;
- developer/viewer cannot run strategy;
- missing/oversized strategy brief is rejected with a clear error;
- run response preserves the existing `{ result: ... }` envelope;
- viewer can read stored strategy analyses through the PM analyses read endpoint;
- unavailable PM dependencies return the same style of 503 as analysis/replan.

UI tests:

- manual run form can choose strategy mode and send strategy brief;
- strategy results render grouped opportunities and compact lens summaries from
  the analyses read endpoint;
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
2. Add shared types for strategy opportunities, lens summaries, questions, and
   strategy proposed goals with `sourceOpportunityId`.
3. Add parser and policy validation for `PROJECT_STRATEGY` with tests,
   including opportunity-goal linking rules.
4. Add storage migrations for `ProjectManagerRun.mode`,
   `ProjectAnalysis.analysisKind`, and strategy metadata fields.
5. Add `ProjectStrategySnapshot` collection with compact goal, proposal,
   repository profile, and product-context summaries.
6. Add `buildProjectStrategyPrompt` and the orchestrator strategy path.
7. Add API support for `mode: "strategy"` while preserving the existing
   `{ result: ... }` run response envelope.
8. Add the PM analyses read endpoint for persisted strategy results.
9. Add minimal UI controls and rendering.
10. Add Playwright critical flow.

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
