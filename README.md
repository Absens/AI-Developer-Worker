# AI Developer Worker

Single-process Node.js/TypeScript worker that polls Yandex Tracker, runs `codex-cli` against a mounted project repository, validates the result, and creates or reuses a GitLab merge request.

## What it does

For each cycle the worker:

1. Restores an unfinished task for the current `WORKER_ID`, if one exists.
2. Otherwise selects the earliest eligible Tracker issue with tag `TRACKER_TAG`.
3. Moves the issue through logical statuses from `TRACKER_STATUS_MAP`.
4. Prepares `feature/ai-task-{tracker_id}` in the mounted local clone.
5. Runs structured `codex exec`, then tests and lint.
6. Commits, pushes, publishes an MR, and updates Tracker comments/status.

If Codex needs business clarification, it returns exactly one `AI_QUESTION:` line, the worker stores the Codex `threadId`, and later resumes that session after a human answer.

## Quick Start

1. Verify host auth: `codex login status`
2. Copy [.env.example](/C:/Users/gabba/projects/developer/.env.example) to `.env` and fill in Tracker/GitLab/Codex settings
3. Build the image: `docker build -t ai-developer-worker .`
4. Prepare a writable authenticated `CODEX_HOME`
5. Mount a real target git clone into `/workspace/project`
6. First run with `WORKER_RUN_ONCE=true`
7. Switch to continuous mode only after the one-shot run succeeds

The container does not perform OAuth login on startup. If `CODEX_HOME` is missing or unauthenticated, startup fails before the worker touches Tracker.

## Development Commands

- `npm install` install dependencies
- `npm run typecheck` run TypeScript checks
- `npm test` run the full Vitest suite
- `npm run test:smoke` run the end-to-end smoke harness
- `npm run build` build production output into `dist/`
- `npm run dev` start the worker with `tsx`
- `npm run bootstrap:codex-home` copy an existing Codex auth directory into a target path or mounted volume

## Key Configuration

Required:

- `TRACKER_TOKEN`
- `TRACKER_ORG_ID`
- `TRACKER_STATUS_MAP`
- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`
- `MAX_FIX_ATTEMPTS`
- `WORKER_ID`

Common optional values:

- `TRACKER_TAG=ai_dev`
- `REPO_PATH=/workspace/project`
- `BASE_BRANCH=main`
- `POLL_INTERVAL_MINUTES=30`
- `CODEX_HOME=/codex-home`
- `CODEX_CLI_COMMAND=codex`
- `CODEX_SANDBOX=danger-full-access`
- `CODEX_MODEL=...`
- `CODEX_PROFILE=...`
- `CODEX_EXEC_ARGS_JSON=[]`
- `WORKER_RUN_ONCE=true|false`

## Documentation Map

- Local Docker behavior and prerequisites: [docs/LOCAL_DOCKER_RUN.md](/C:/Users/gabba/projects/developer/docs/LOCAL_DOCKER_RUN.md)
- Windows PowerShell copy-paste commands: [docs/WINDOWS_POWERSHELL_QUICKSTART.md](/C:/Users/gabba/projects/developer/docs/WINDOWS_POWERSHELL_QUICKSTART.md)
- Compose example: [compose.example.yaml](/C:/Users/gabba/projects/developer/compose.example.yaml)
- Contributor conventions: [AGENTS.md](/C:/Users/gabba/projects/developer/AGENTS.md)

## Notes

- Prefer a dedicated writable Docker volume for `CODEX_HOME` over binding the host `~/.codex` directly.
- The worker expects the mounted target repository to already have working git fetch/pull/push credentials.
- The container installs `git`, `curl`, `jq`, `ripgrep`, and `@openai/codex`.
