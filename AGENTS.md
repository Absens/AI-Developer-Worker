# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Node.js/TypeScript worker that polls Yandex Tracker, runs `codex-cli`, validates a target repository, and opens GitLab merge requests.

- `src/` runtime code
- `src/domain/` orchestration and prompt building
- `src/integrations/` Tracker, GitLab, Git, and Codex adapters
- `src/utils/` shared helpers such as shell execution, retry, and logging
- `tests/` Vitest unit and smoke tests
- `scripts/` operational helpers, including Codex auth bootstrap
- `docs/` runbooks for Docker and Windows/PowerShell usage

## Build, Test, and Development Commands

- `npm install` installs dependencies
- `npm run typecheck` runs strict TypeScript checks without emitting files
- `npm test` runs the full Vitest suite
- `npm run test:smoke` runs the end-to-end smoke test with mock Tracker/GitLab and real git flow
- `npm run build` builds the production bundle into `dist/`
- `npm run dev` starts the worker with `tsx`
- `npm run bootstrap:codex-home` copies an existing Codex auth directory into a target path or mounted volume

## Coding Style & Naming Conventions

Use TypeScript with ES modules, 2-space indentation, semicolons, and explicit types on public interfaces. Prefer small modules and keep business logic in `src/domain/`, not in transport or shell adapters. Use `PascalCase` for classes, `camelCase` for functions and variables, and kebab-free filenames like `promptBuilder.ts` or `commentProtocol.ts`.

There is no formatter configured yet; keep style consistent with the existing codebase and run `npm run typecheck` before submitting changes.

## Testing Guidelines

Tests use Vitest. Add unit tests next to the affected behavior in `tests/*.test.ts`. Use descriptive names such as `codexAuth.test.ts` or `worker.smoke.test.ts`. For runtime or auth changes, prefer both a focused unit test and a smoke-path assertion when feasible.

## Commit & Pull Request Guidelines

Current history uses short imperative commit messages, for example `Update environment configuration and documentation for Docker setup`. Follow that style, keep subject lines concise, and group related changes in one commit. If a change affects worker behavior, mention Tracker/GitLab/Codex impact in the PR description and include exact verification commands, for example `npm test` and `npm run build`.

## Security & Configuration Tips

Do not commit `.env`, `.codex-home/`, or any Codex auth state. In Docker, prefer a dedicated writable `CODEX_HOME` volume over binding the host `~/.codex` directly. Validate `TRACKER_STATUS_MAP_FILE`, `CODEX_COMMAND`, `TEST_COMMAND`, and `LINT_COMMAND` against the real target repository before running the worker continuously.
