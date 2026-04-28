# Phase 7 - AI-native Task Tracker Roadmap

_Derived from `docs/PHASE_7_AI_NATIVE_TASK_TRACKER_CONCEPT.md` on 2026-04-28._

## Purpose

This directory splits the Phase 7 concept into executable implementation plans.
Each plan is intended to be handed to Codex as a separate task and completed
before moving to the next phase.

The goal is to avoid building a full task tracker before the worker can use it.
The phases are ordered as vertical slices:

1. establish the internal tracker domain;
2. add atomic coordination;
3. wire the new provider behind a flag;
4. migrate worker execution;
5. restore Yandex Tracker compatibility through a bridge;
6. add the human UI;
7. add AI proposals and autonomy controls;
8. harden production storage, retention, metrics, and runbooks.

## Execution Rules

- Complete phases in order.
- Do not pull work from later phases into an earlier phase unless a plan says it
  is required.
- Keep `TASK_TRACKER_PROVIDER=yandex` behavior working until the fallback is
  intentionally removed in a future roadmap.
- After each phase, run at least `npm run typecheck` and `npm test`.
- Run `npm run test:smoke` when a phase changes worker orchestration, Git,
  GitLab, Yandex integration, or end-to-end task flow.
- Do not accept an in-memory tracker as a production internal provider. In-memory
  storage is only for unit tests, local smoke paths, and explicit test adapters.
- Commit each phase separately with a short imperative commit message.

## Phase Index

| Phase | Plan | Primary Outcome |
| --- | --- | --- |
| 7A | `PHASE_7A_TRACKER_CORE_PLAN.md` | Internal task domain and storage foundation. |
| 7B | `PHASE_7B_ATOMIC_QUEUE_PLAN.md` | Atomic claim and lease queue. |
| 7C | `PHASE_7C_PROVIDER_FLAG_PLAN.md` | Internal tracker selectable behind a feature flag. |
| 7D | `PHASE_7D_WORKER_MIGRATION_PLAN.md` | Worker can execute a task through internal tracker state. |
| 7E | `PHASE_7E_YANDEX_BRIDGE_PLAN.md` | Yandex becomes source/mirror, not runtime state store. |
| 7F | `PHASE_7F_HUMAN_UI_PLAN.md` | Minimal human workflow UI/API. |
| 7G | `PHASE_7G_AI_PROPOSALS_PLAN.md` | Controlled AI-created task proposals. |
| 7H | `PHASE_7H_OPERATIONAL_HARDENING_PLAN.md` | Production storage, retention, metrics, and runbooks. |

## Recommended Codex Prompt Pattern

Use this prompt for each phase:

```text
Read docs/phase-7/PHASE_7X_..._PLAN.md and implement only that phase.
Do not implement later phases. Preserve current Yandex direct mode.
Run the verification commands listed in the plan and summarize the result.
```

## Global Cut Lines

The first usable internal runtime should exist by the end of Phase 7D:

- a task can be created internally;
- a worker can claim it;
- the worker can run analysis, implementation, validation and MR publish;
- structured state is stored in the internal tracker;
- Yandex is not required for that flow.

The worker-facing surface should be workflow-first, not CRUD-first. The
TypeScript `TaskTrackerClient` is the first internal boundary, but the same
operations must map cleanly to agent HTTP endpoints for claim, events,
decisions, questions, validation, merge request publication, heartbeat, and
release before the tracker is considered externally operable.

Yandex compatibility returns in Phase 7E. Human usability arrives in Phase 7F.
Autonomy and AI-created work are deliberately postponed until Phase 7G.

## Production Cut Lines

The internal tracker is not production-ready until:

- PostgreSQL-backed storage is implemented for tasks, revisions, events,
  comments, decisions, plans, steps, leases, dependencies, artifacts, proposals,
  and sync cursors;
- the staged schema additions from 7B, 7D, 7E, 7G, and 7H have been applied,
  even if 7A starts with only the core table skeleton;
- claim and lease operations use database transactions and cannot be backed by
  the in-memory adapter outside tests;
- restart recovery uses persisted DB state, including active runs, plans,
  leases, and review/validation records;
- retention, redaction, preflight, metrics, backup/restore, and auth alignment
  are completed in Phase 7H.
