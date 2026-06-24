# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Node.js/TypeScript worker that polls Yandex Tracker or an internal task tracker, runs Codex CLI, validates a target repository, and opens GitLab merge requests. It also includes an observability/human API surface, an Angular internal tracker console, Telegram Assistant support, and Project Manager automation.

- `src/` runtime code
- `src/domain/` orchestration and prompt building
- `src/domain/taskTracker/` internal task tracker domain contracts and policies
- `src/domain/projectManager/` Project Manager analysis, goals, replanning, and proposal logic
- `src/domain/telegramAssistant/` Telegram Assistant dialogue and notification workflows
- `src/integrations/` Tracker, internal tracker, Yandex bridge, GitLab, Git, Telegram, and Codex adapters
- `src/observability/` health/readiness, metrics, alerts, event storage, and human task API
- `src/utils/` shared helpers such as shell execution, retry, and logging
- `tests/` Vitest unit and smoke tests
- `web/` Angular human console for internal task tracker workflows
- `scripts/` operational helpers, including Codex auth bootstrap
- `docs/` runbooks for Docker and Windows/PowerShell usage
- `docs/ARCHITECTURE.md` architecture map for runtime flows, module boundaries, and common change paths

## Build, Test, and Development Commands

- `npm install` installs dependencies
- `npm run typecheck` runs strict TypeScript checks without emitting files
- `npm test` runs the full Vitest suite
- `npm run test:smoke` runs the end-to-end smoke test with mock Tracker/GitLab and real git flow
- `npm run build` builds the production bundle into `dist/`
- `npm run dev` starts the worker with `tsx`
- `npm run preflight` checks config, Codex auth, git, Tracker, GitLab, and target commands without processing the queue
- `npm run tracker:migrate` applies PostgreSQL migrations for the internal task tracker
- `npm run verify:codex-cli` checks the installed Codex CLI contract expected by the worker
- `npm run web:typecheck`, `npm run web:test`, `npm run web:build`, and `npm run web:e2e` validate the Angular console
- `npm run bootstrap:codex-home` copies an existing Codex auth directory into a target path or mounted volume

## Coding Style & Naming Conventions

Use TypeScript with ES modules, 2-space indentation, semicolons, and explicit types on public interfaces. Prefer small modules and keep business logic in `src/domain/`, not in transport or shell adapters. Use `PascalCase` for classes, `camelCase` for functions and variables, and kebab-free filenames like `promptBuilder.ts` or `commentProtocol.ts`.

There is no formatter configured yet; keep style consistent with the existing codebase and run `npm run typecheck` before submitting changes.

## Testing Guidelines

Tests use Vitest. Add unit tests next to the affected behavior in `tests/*.test.ts`. Use descriptive names such as `codexAuth.test.ts` or `worker.smoke.test.ts`. For runtime or auth changes, prefer both a focused unit test and a smoke-path assertion when feasible.

## Commit & Pull Request Guidelines

Current history uses short imperative commit messages, for example `Update environment configuration and documentation for Docker setup`. Follow that style, keep subject lines concise, and group related changes in one commit. If a change affects worker behavior, mention Tracker/GitLab/Codex impact in the PR description and include exact verification commands, for example `npm test` and `npm run build`.

## Security & Configuration Tips

Do not commit `.env`, `.codex-home/`, or any Codex auth state. In Docker, prefer a dedicated writable `CODEX_HOME` volume over binding the host `~/.codex` directly. Validate `TRACKER_STATUS_MAP_FILE`, `CODEX_CLI_COMMAND`, `TEST_COMMAND`, `LINT_COMMAND`, and any optional quality gate commands against the real target repository before running the worker continuously.
