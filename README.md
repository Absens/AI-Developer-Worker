# AI Developer Worker

Single-process Node.js/TypeScript worker that polls Yandex Tracker, applies changes through `codex-cli`, validates the target repository, and opens or reuses a GitLab Merge Request.

## What it does

For each cycle the worker:

1. Restores an unfinished task for the current `WORKER_ID`, if one exists.
2. Otherwise selects the earliest eligible Tracker issue with tag `TRACKER_TAG`.
3. Moves the issue through logical statuses using `TRACKER_STATUS_MAP`.
4. Prepares `feature/ai-task-{tracker_id}` in the local repo clone.
5. Runs `CODEX_COMMAND` with the generated task prompt over stdin.
6. Verifies repo changes, runs tests, then lint.
7. Commits, pushes, creates or reuses an MR in GitLab.
8. Writes service comments back to Tracker and moves the task to `review`.

If Codex needs more business context, it must emit a line starting with `AI_QUESTION:`. The worker will post `AI QUESTION`, switch the task to `waiting_for_answer`, and resume later from the same branch after a human reply appears.

## Configuration

Required environment variables:

- `TRACKER_TOKEN`
- `TRACKER_ORG_ID`
- `TRACKER_STATUS_MAP`
- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`
- `CODEX_COMMAND`
- `MAX_FIX_ATTEMPTS`
- `WORKER_ID`

Optional environment variables:

- `TRACKER_TAG` default `ai_dev`
- `TRACKER_API_BASE_URL` default `https://api.tracker.yandex.net/v3`
- `REPO_PATH` default `/workspace/project`
- `BASE_BRANCH` default `main`
- `POLL_INTERVAL_MINUTES` default `30`
- `CODEX_HOME` default `~/.codex` on the current runtime user
- `CODEX_CLI_COMMAND` default `codex`
- `TEST_COMMAND` default `npm test`
- `LINT_COMMAND` default `npm run lint`
- `CODEX_QUESTION_MARKER` default `AI_QUESTION:`
- `WORKER_RUN_ONCE` default `false`

Example configuration is in [.env.example](/C:/Users/gabba/projects/developer/.env.example).

`TRACKER_STATUS_MAP` must be a JSON object keyed by logical status. Example:

```json
{
  "open": { "statuses": ["Open"] },
  "in_progress": { "statuses": ["In Progress"], "transition": "start" },
  "waiting_for_answer": { "statuses": ["Waiting"], "transition": "wait" },
  "review": { "statuses": ["Review"], "transition": "review" },
  "failed": { "statuses": ["Failed"], "transition": "fail" },
  "done": { "statuses": ["Done"], "transition": "done" }
}
```

## Local development

Install dependencies:

```bash
npm install
```

Run static checks and tests:

```bash
npm run typecheck
npm test
```

Bootstrap a dedicated Codex auth directory or Docker volume from the current machine:

```bash
npm run bootstrap:codex-home
```

By default this copies `~/.codex` into a local `.codex-home/` directory. Override the paths with `SOURCE_CODEX_HOME` and `TARGET_CODEX_HOME` when bootstrapping a Docker volume.

Build the production bundle:

```bash
npm run build
```

Run the worker once for smoke/debug scenarios:

```bash
WORKER_RUN_ONCE=true npm run dev
```

Run the long-lived worker:

```bash
npm run dev
```

## Smoke / E2E harness

The repository includes a smoke test that creates:

- a temporary bare git remote and local clone,
- a mock Yandex Tracker HTTP server,
- a mock GitLab HTTP server,
- a fake Codex command that writes a file into the repo.

Run it with:

```bash
npm run test:smoke
```

This verifies the real git flow, Tracker comments/status transitions, MR creation, and idempotent worker wiring without calling external systems.

## Codex authentication in Docker

The worker expects `codex-cli` to already be logged in. It does not initiate OAuth during task processing.

Recommended approach:

1. Keep your existing local Codex login on the host in `~/.codex`.
2. Copy that state once into a dedicated Docker volume.
3. Mount that volume into the worker as writable `CODEX_HOME`.

Why this is the default:

- avoids baking `auth.json` into the image,
- avoids leaking credentials through env vars,
- reduces the chance that container refresh-token writes interfere with the host login state.

Create the dedicated volume:

```bash
docker volume create codex-home
```

Bootstrap the volume from the current host `~/.codex` using the image helper:

```bash
docker run --rm \
  -v /absolute/path/to/your/.codex:/host-codex:ro \
  -v codex-home:/codex-home \
  -e SOURCE_CODEX_HOME=/host-codex \
  -e TARGET_CODEX_HOME=/codex-home \
  ai-developer-worker \
  node scripts/bootstrap-codex-home.mjs
```

The worker will then run `codex login status` during startup. If login is missing or invalid, the process fails before touching Tracker tasks.

Advanced option:

- direct bind mount of the host `~/.codex` into the container also works for local debugging;
- it is not the default because simultaneous host/container token refresh can lead to auth-state conflicts.

Example advanced bind mount:

```bash
docker run --rm \
  --env-file .env \
  -e CODEX_HOME=/codex-home \
  -v /absolute/path/to/your/.codex:/codex-home \
  -v /absolute/path/to/project:/workspace/project \
  ai-developer-worker
```

## Docker

Build the image:

```bash
docker build -t ai-developer-worker .
```

Recommended worker run with dedicated Codex volume:

```bash
docker run --rm \
  --env-file .env \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  -v /absolute/path/to/project:/workspace/project \
  ai-developer-worker
```

Run one smoke-style cycle inside the container:

```bash
docker run --rm \
  --env-file .env \
  -e WORKER_RUN_ONCE=true \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  -v /absolute/path/to/project:/workspace/project \
  ai-developer-worker
```

Run the continuous worker:

```bash
docker run --rm \
  --env-file .env \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  -v /absolute/path/to/project:/workspace/project \
  ai-developer-worker
```

An example Compose file is available in [compose.example.yaml](/C:/Users/gabba/projects/developer/compose.example.yaml).

A practical step-by-step local run guide is in [docs/LOCAL_DOCKER_RUN.md](/C:/Users/gabba/projects/developer/docs/LOCAL_DOCKER_RUN.md).

The container installs `git`, `curl`, `jq`, `ripgrep`, and `@openai/codex`.
