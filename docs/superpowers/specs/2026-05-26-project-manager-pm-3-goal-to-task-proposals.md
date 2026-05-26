# Project Manager PM-3 Goal-to-Task Proposals Design

## Goal

Phase PM-3 lets an explicit operator command turn an approved or active
`ProjectGoal` into one or more AI task proposals through the existing
`TaskTrackerClient.proposeTask` pipeline. PM-3 must not create executable tasks
directly.

## Scope

PM-3 includes:

- A domain builder that maps `ProjectGoal.suggestedTaskProposals` to bounded
  `ProposeTaskInput` values.
- Evidence enrichment with goal, analysis, run, goal-level evidence, and nested
  proposal draft evidence refs.
- Idempotency keys based on goal id and stable draft identity.
- A human API command:
  `POST /api/project-goals/:id/commands/propose-tasks`.
- Goal-task links with `linkType: "proposed_task"` after each successful
  `proposeTask` result.

PM-3 excludes:

- Calling `createTask`.
- Approving task proposals.
- Writing to Yandex Tracker, GitLab, or target repositories.
- Automatically generating task proposals as a side effect of goal approval.
- Scheduling or automatic PM runs.

## Builder Contract

The builder accepts a stored `ProjectGoal` plus PM proposal config:

- `maxTaskProposalsPerGoal`
- `defaultAutonomyLevel`

It returns `ProposeTaskInput[]` with:

- `source: "ai_proposal"`
- `proposedBy: "project_manager_agent"`
- `repositoryName` from the goal
- title, description, task type, acceptance criteria, and blast radius from the
  nested draft
- `proposalReason` summarizing the parent goal, problem, desired outcome, and
  success metrics
- evidence refs from:
  - goal-level `evidenceRefs`
  - `external_url: urn:project-manager:goal:<goalId>`
  - `external_url: urn:project-manager:analysis:<analysisId>`
  - `external_url: urn:project-manager:run:<runId>` when available
  - nested draft `evidenceRefs`
- `idempotencyKey` with a stable `pm-goal-task:<goalId>:<draft-index>:<hash>`
  format
- `autonomyLevel` from PM config, defaulting to `proposal_only`

High-risk goals are forced to `proposal_only` even when config requests
`auto_execute_low_risk`. This keeps high-risk PM work inside the existing task
proposal approval path.

## API Contract

`POST /api/project-goals/:id/commands/propose-tasks`

Access: `operator+`.

Reasoning: the command creates AI task proposals and can fan out into multiple
tracker records. It is closer to the existing `POST /api/proposals` endpoint
than to goal approval/rejection, so `developer+` is too broad.

Behavior:

- Requires project manager store dependencies.
- Requires an internal task tracker dependency.
- Loads the goal by id.
- Allows only `approved` and `active` goals.
- Builds bounded proposal inputs.
- Calls `TaskTrackerClient.proposeTask` for each input.
- Links each returned task to the goal with `linkType: "proposed_task"`.
- Returns `{ goal, tasks, proposals, taskLinks }`.

Repeated calls are safe: `proposeTask` idempotency returns an existing task for
the same key, and `linkGoalTask` returns the existing link for the same
goal/task/link tuple.

## Safety Invariants

- PM-3 never calls `createTask`.
- PM-3 never calls `approveProposal` or `rejectProposal`.
- PM analysis remains read-only.
- Goal approval and rejection semantics from PM-2 are unchanged.
- Task execution remains controlled by the existing proposal policy and human
  approval path.
- Duplicate PM command calls must not create duplicate task proposals or links.
