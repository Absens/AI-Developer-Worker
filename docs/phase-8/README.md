# Phase 8 - Angular Human Operations Console Roadmap

_Created on 2026-04-29 after Phase 7 internal tracker implementation._

## Purpose

Phase 7 made the internal AI task tracker usable from the backend: tasks,
leases, worker execution, Yandex bridge, human API, AI proposals, PostgreSQL
storage, retention, redaction, metrics, and runbooks.

The current human UI is intentionally minimal and embedded as server-rendered
HTML with hand-written DOM code. Phase 8 turns that MVP into a proper
operations console built with Angular and PrimeNG while preserving the existing
Node.js worker/runtime boundaries.

The goal is not to build a Jira clone. The goal is a focused operator and
developer console for creating AI work, supervising execution, answering
questions, approving proposals, diagnosing failures, and watching fleet health.

## Product Direction

Build the first screen as the actual console, not a landing page.

The UI should feel like a dense operational tool:

- task queues and filters are always close at hand;
- task detail, validation, MR, timeline, and questions are easy to scan;
- risky mutations are explicit and confirmed;
- failed and waiting states are visually prominent;
- proposal approval is controlled and auditable;
- operators should not need to read database rows, raw logs, or Yandex comments
  for normal supervision.

## Technology Direction

- Frontend framework: Angular.
- Component library: PrimeNG.
- Theme system: PrimeNG theme preset configured through the current PrimeNG
  provider API.
- Icons: PrimeNG/PrimeIcons where useful, or PrimeNG built-in icon support.
- Forms: Angular reactive forms.
- Routing: Angular Router.
- API access: typed Angular services around the existing human API.
- Backend: existing Node.js observability/task tracker server.

At implementation time, pin compatible Angular and PrimeNG versions together
instead of relying on broad semver ranges. PrimeNG installation and theme setup
should follow the official PrimeNG documentation for the selected major
version.

References:

- Angular CLI `ng new`: <https://angular.dev/cli/new>
- PrimeNG installation: <https://v20.primeng.org/installation>
- PrimeNG configuration: <https://v20.primeng.org/configuration>

## Accepted Baseline Decisions

These decisions remove ambiguity for Phase 8 implementation. Change them only
by updating this roadmap and the phase plans together.

- Frontend directory: `web/`.
- Angular application name: `task-tracker-console`.
- Dependency layout: `web/` owns its own `package.json` and lockfile; the root
  `package.json` exposes delegating scripts such as `web:dev`, `web:build`,
  `web:test`, `web:typecheck`, and, in Phase 8D, `web:e2e`.
- Production app path: `TASK_TRACKER_UI_PATH=/tasks`.
- Human API path: `TASK_TRACKER_UI_API_PATH=/api`.
- Static bundle path:
  `TASK_TRACKER_UI_STATIC_DIR=web/dist/task-tracker-console/browser`.
- Angular assets are served under `/tasks/assets`; generated JS/CSS chunks are
  served under the Angular app path.
- Angular browser URLs stay under the app path: `/tasks`, `/tasks/new`,
  `/tasks/:taskId`, `/tasks/proposals`, `/tasks/operations`, and a not-found
  route inside the app shell.
- API and health routes keep precedence over frontend route fallback:
  `/api/...`, `/metrics`, `/healthz`, and `/readyz` must never be swallowed by
  Angular static serving.
- Phase 8A introduces Angular static serving and may keep the old embedded UI
  as a compatibility fallback when no static bundle is configured. Phase 8B
  makes the Angular task workflow the usable UI. Phase 8D removes or fully
  disables the embedded UI code path.
- Bearer auth is not implemented as an in-app token entry field in Phase 8.
  Browser deployments should use trusted proxy headers, localhost development,
  or a reverse proxy that injects Authorization.

## Contract Documents

Implementation must keep `HUMAN_API_CONTRACT.md` current. It is the source of
truth for frontend DTOs, endpoint paths, auth roles, command behavior,
operations snapshots, display safety, and canonical test fixtures.

## Execution Rules

- Complete phases in order.
- Do not rewrite the worker runtime or tracker storage while implementing the
  frontend.
- Keep `TASK_TRACKER_PROVIDER=yandex` direct mode working.
- Do not maintain dual runtime UI paths after Phase 8D; before then, any
  fallback must be explicit and documented in the phase being implemented.
- Treat the human API as the source of truth; do not let the Angular app depend
  on in-process internals.
- Prefer typed DTOs over exposing raw `TaskRecord` everywhere.
- Do not consider a phase complete if the implementation changes human API
  shapes without updating `HUMAN_API_CONTRACT.md` and the related tests.
- Run at least `npm run typecheck` and `npm test` after backend-facing changes.
- Run the frontend build/test commands introduced by this phase before marking
  the frontend phase complete.
- Use the canonical fixture set from `HUMAN_API_CONTRACT.md` for frontend,
  backend contract, and E2E tests.
- Commit each phase separately with a short imperative commit message.

## Phase Index

| Phase | Plan | Primary Outcome |
| --- | --- | --- |
| Contract | `HUMAN_API_CONTRACT.md` | Shared API, auth, DTO, command, operations, safety, and fixture contract. |
| 8A | `PHASE_8A_FRONTEND_FOUNDATION_PLAN.md` | Angular workspace, PrimeNG shell, typed API boundary, and static serving path. |
| 8B | `PHASE_8B_TASK_WORKFLOW_UI_PLAN.md` | Queue, task detail, create task, answer/resume, proposal review, and decomposition list. |
| 8C | `PHASE_8C_OPERATIONS_CONSOLE_PLAN.md` | Workers, leases, failures, metrics summaries, diagnostics, and operator views. |
| 8D | `PHASE_8D_FRONTEND_PRODUCTION_HARDENING_PLAN.md` | Auth alignment, packaging, E2E tests, accessibility, visual regression, docs, and old UI removal. |

## Global Cut Lines

The first usable Angular console should exist by the end of Phase 8B:

- a human can list and filter tasks;
- a human can create a task;
- a human can open task detail;
- a human can preview agent context;
- a human can mark a task ready;
- a human can answer a question and resume execution;
- a human can approve or reject AI proposals;
- a human can see MR and validation summaries.

Operations visibility becomes first-class by the end of Phase 8C.

The Angular console is not production-ready until Phase 8D:

- write actions are protected by the same auth model as the human API;
- Docker/local runbooks explain how the UI is built and served;
- E2E coverage verifies the critical workflows;
- accessibility and responsive layout pass a baseline review;
- the old embedded task UI is removed or no longer routed.

## Suggested Codex Prompt Pattern

Use this prompt for each phase:

```text
Read docs/phase-8/README.md, docs/phase-8/HUMAN_API_CONTRACT.md, and
docs/phase-8/PHASE_8X_..._PLAN.md. Implement only that phase.
Use Angular and PrimeNG for the frontend.
Preserve the existing Node.js backend and current Yandex direct mode.
Run the verification commands listed in the plan and summarize the result.
```
