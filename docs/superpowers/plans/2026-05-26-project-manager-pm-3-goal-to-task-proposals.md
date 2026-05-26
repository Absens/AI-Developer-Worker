# Project Manager PM-3 Goal-to-Task Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit PM command that turns approved/active goals into bounded AI task proposals through `TaskTrackerClient.proposeTask`.

**Architecture:** Keep proposal construction in `src/domain/projectManager/taskProposalBuilder.ts`. Keep HTTP orchestration in `src/observability/taskTrackerHumanApi.ts`, where the endpoint loads a goal, builds proposal inputs, calls `proposeTask`, and creates idempotent `project_goal_tasks` links. No storage schema changes are required for PM-3 MVP.

**Tech Stack:** TypeScript ES modules, Vitest, existing in-memory task tracker, existing PM store, existing HTTP API test harness.

---

## Discovery Summary

- Roadmap Phase PM-3 requires reusing `TaskTrackerClient.proposeTask`, adding evidence refs, linking through `project_goal_tasks`, and limiting fan-out.
- PM-2 already implemented goal storage, lifecycle transitions, duplicate goal policy, analysis/run persistence, `ProjectGoal.suggestedTaskProposals`, and idempotent `linkGoalTask`.
- Existing proposal pipeline already handles idempotency keys, duplicate proposals, rate limits, policy decisions, evidence artifacts, and proposal approval/rejection.
- PM-3 needed details were missing from the roadmap/PM-2 plan: endpoint role, exact builder mapping, evidence ref encoding for PM internals, idempotency key format, and high-risk autonomy override.

## File Map

- Create `src/domain/projectManager/taskProposalBuilder.ts`: map stored goals to `ProposeTaskInput[]`.
- Modify `src/domain/projectManager/index.ts`: export the builder.
- Test `tests/projectManagerTaskProposalBuilder.test.ts`: domain builder behavior.
- Modify `src/observability/taskTrackerHumanApi.ts`: add the explicit propose-tasks endpoint.
- Test `tests/humanTaskApi.test.ts`: API status gating, role gating, dependency checks, create/link flow, and repeated idempotency.
- Update docs already created in `docs/superpowers/specs` and `docs/superpowers/plans`.

## Execution Plan

- [ ] **Task 1: Domain builder RED**
  - Add tests in `tests/projectManagerTaskProposalBuilder.test.ts`.
  - Verify `npm test -- tests/projectManagerTaskProposalBuilder.test.ts` fails because the builder does not exist.

- [ ] **Task 2: Domain builder GREEN**
  - Create `src/domain/projectManager/taskProposalBuilder.ts`.
  - Export it from `src/domain/projectManager/index.ts`.
  - Verify `npm test -- tests/projectManagerTaskProposalBuilder.test.ts` passes.

- [ ] **Task 3: API RED**
  - Add tests to `tests/humanTaskApi.test.ts` for:
    - proposed/rejected/completed/stale goals cannot create task proposals
    - operator can create proposals for an approved goal
    - developer cannot create proposals
    - repeated call returns the same task/link
    - missing PM store and missing task tracker return existing 503 errors
  - Verify focused API tests fail because the endpoint does not exist.

- [ ] **Task 4: API GREEN**
  - Add `configForRepository` to optional PM API dependencies.
  - Add `POST /api/project-goals/:id/commands/propose-tasks`.
  - Use `ProjectGoalTaskProposalBuilder`, `TaskTrackerClient.proposeTask`, and
    `ProjectManagerStore.linkGoalTask`.
  - Return `{ goal, tasks, proposals, taskLinks }`.
  - Verify focused API tests pass.

- [ ] **Task 5: Verification and review**
  - Run focused PM/proposal tests:
    `npm test -- tests/projectManagerTaskProposalBuilder.test.ts tests/humanTaskApi.test.ts tests/taskTrackerProposals.test.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts`
  - Run `npm run typecheck`.
  - Run `npm test`.
  - Request PM-3 code review subagent and fix Critical/Important findings.
