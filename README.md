# AI Developer Worker

Node.js/TypeScript worker that polls Yandex Tracker, runs `codex-cli` against one or more configured project repositories, validates the result, and creates or reuses a GitLab merge request.

## What it does

For each cycle the worker:

1. Restores an unfinished task for the current `WORKER_ID`, if one exists.
2. Otherwise selects an eligible Tracker issue by lease-aware priority scoring. In legacy `.env` mode this uses `TRACKER_DEFAULT_QUEUE` and `TRACKER_TAG`; in fleet mode it uses repository profiles from `WORKER_CONFIG_FILE`.
3. Runs structured task analysis, stores `AI ANALYSIS:`, chooses a prompt profile, and either implements, asks for clarification, decomposes, or parks the task for manual review.
4. Enforces `blockedBy` dependencies before acquiring leases or touching git state.
5. Moves the issue through logical statuses from `TRACKER_STATUS_MAP_FILE`.
6. Prepares `feature/ai-task-{tracker_id}` in the mounted local clone when implementation is allowed.
7. Runs structured `codex exec`, then tests and lint.
8. Commits, pushes, publishes an MR, and updates Tracker comments/status.

If Codex needs business clarification, it returns exactly one `AI_QUESTION:` line, the worker stores the Codex `threadId`, and later resumes that session after a human answer.

## Quick Start

1. Copy [.env.example](/C:/Users/gabba/projects/developer/.env.example) to `.env` and fill in Tracker/GitLab/Codex settings
2. Build the image: `docker build -t ai-developer-worker .`
3. Create a dedicated Docker `CODEX_HOME` and run `codex login` inside it
4. Mount a real target git clone into `/workspace/project`
5. First run with `WORKER_RUN_ONCE=true`
6. Switch to continuous mode only after the one-shot run succeeds

The container does not perform OAuth login on startup. If `CODEX_HOME` is missing or unauthenticated, startup fails before the worker touches Tracker.

## Development Commands

- `npm install` install dependencies
- `npm run typecheck` run TypeScript checks
- `npm test` run the full Vitest suite
- `npm run test:smoke` run the end-to-end smoke harness
- `npm run build` build production output into `dist/`
- `npm run dev` start the worker with `tsx` and load `.env`
- `npm run memory:validate` validate the file-backed memory store
- `npm run bootstrap:codex-home` copy an existing Codex auth directory into a target path or mounted volume

## Key Configuration

Required:

- `TRACKER_TOKEN`
- `TRACKER_ORG_ID`
- `TRACKER_STATUS_MAP_FILE`
- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`
- `GIT_REMOTE_NAME=origin` by default
- optional `GIT_REPOSITORY_TOKEN` and `GIT_REPOSITORY_URL` for HTTPS git auth bootstrap
- optional `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` for commit identity inside Docker
- `MAX_FIX_ATTEMPTS`
- `WORKER_ID`

Common optional values:

- `TRACKER_TAG=ai_dev`
- `TRACKER_DEFAULT_QUEUE=FRONTEND`
- `REPO_PATH=/workspace/project`
- `BASE_BRANCH=main`
- `POLL_INTERVAL_MINUTES=30`
- `CODEX_HOME=/codex-home`
- `CODEX_CLI_COMMAND=codex`
- `CODEX_CLI_ARGS_JSON=[]` for launcher/global Codex flags before `exec`
- `CODEX_SANDBOX=danger-full-access`
- `CODEX_MODEL=...`
- `CODEX_PROFILE=...`
- `CODEX_EXEC_ARGS_JSON=[]` for flags accepted by `codex exec --help`
- `CODEX_TIMEOUT_SECONDS=1800`
- `CODEX_PROGRESS_LOG_INTERVAL_SECONDS=30`
- `WORKER_RUN_ONCE=true|false`
- `HOST_CODEX_HOME=C:/Users/.../.codex` for optional Compose bootstrap on Windows
- `WORKER_CONFIG_FILE=/workspace/worker.config.yaml` for multi-repository fleet mode
- `LOCK_BACKEND=tracker`, `LOCK_TTL_SECONDS=900`, `LOCK_HEARTBEAT_SECONDS=60` for Tracker-comment leases
- `TASK_MODE=auto|implement|decompose|analyze_only|human` for Phase 4 routing
- `CONFIDENCE_IMPLEMENT_THRESHOLD=70`, `CONFIDENCE_HUMAN_THRESHOLD=40`, `CONFIDENCE_PRIORITY_WEIGHT=2`
- `DECOMPOSITION_DRY_RUN=true` for safe epic split previews
- `DEPENDENCY_ENFORCEMENT=true`, `DEPENDENCY_UNKNOWN_STATUS_POLICY=block` for blocked-task filtering
- `MEMORY_ENABLED=false`, `MEMORY_DIR=/workspace/ai-developer-memory` for Phase 5 repository memory

For Codex CLI 0.124.0, global flags such as `--search` and
`--ask-for-approval never` must go in `CODEX_CLI_ARGS_JSON`, for example
`["--search","--ask-for-approval","never"]`. `CODEX_EXEC_ARGS_JSON` is only
for exec-level flags such as `["--add-dir","/workspace/shared"]`.

## Documentation Map

- Environment variables and where to get them: [docs/ENV_CONFIGURATION.md](/C:/Users/gabba/projects/developer/docs/ENV_CONFIGURATION.md)
- Fleet config and operational coordination: [docs/FLEET_OPERATIONAL_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/FLEET_OPERATIONAL_RUNBOOK.md)
- Repository memory lifecycle: [docs/MEMORY_LIFECYCLE.md](/C:/Users/gabba/projects/developer/docs/MEMORY_LIFECYCLE.md)
- Local Docker behavior and prerequisites: [docs/LOCAL_DOCKER_RUN.md](/C:/Users/gabba/projects/developer/docs/LOCAL_DOCKER_RUN.md)
- Windows PowerShell copy-paste commands: [docs/WINDOWS_POWERSHELL_QUICKSTART.md](/C:/Users/gabba/projects/developer/docs/WINDOWS_POWERSHELL_QUICKSTART.md)
- Codex auth troubleshooting, including `refresh_token_reused`: [docs/CODEX_AUTH_TROUBLESHOOTING.md](/C:/Users/gabba/projects/developer/docs/CODEX_AUTH_TROUBLESHOOTING.md)
- Codex CLI update procedure and compatibility checks: [docs/CODEX_CLI_UPDATE_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/CODEX_CLI_UPDATE_RUNBOOK.md)
- Compose file: [compose.yaml](/C:/Users/gabba/projects/developer/compose.yaml)
- Contributor conventions: [AGENTS.md](/C:/Users/gabba/projects/developer/AGENTS.md)

## Notes

- Prefer a dedicated writable Docker volume for `CODEX_HOME` over binding the host `~/.codex` directly.
- For long-running workers, log in directly inside that dedicated `CODEX_HOME`; do not rely on a copied host `auth.json` while host Codex is also running.
- The worker expects the mounted target repository to already have working git fetch/pull/push credentials.
- If the mounted repository still uses an SSH remote, the worker can rewrite `origin` to HTTPS and use `GIT_REPOSITORY_TOKEN` or `GITLAB_TOKEN` for git auth.
- The worker also needs a git author identity. Either configure `user.name` and `user.email` in the mounted repository, or pass `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` into the container.
- The container installs `git`, `curl`, `jq`, `ripgrep`, and pinned `@openai/codex@0.124.0` by default. Override with `docker build --build-arg CODEX_CLI_VERSION=<version> ...` only after running the Codex CLI update runbook.
- `CODEX_API_KEY` can be used as a direct non-interactive auth source. If you only have `OPENAI_API_KEY`, persist it into `CODEX_HOME` first with `printenv OPENAI_API_KEY | codex login --with-api-key`.
