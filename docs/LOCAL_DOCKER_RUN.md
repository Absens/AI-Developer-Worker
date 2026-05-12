# Local Docker Runbook

This document explains behavior, prerequisites, and failure modes for local Docker runs on any platform. If you are on Windows and want copy-paste PowerShell commands, use [docs/WINDOWS_POWERSHELL_QUICKSTART.md](/C:/Users/gabba/projects/developer/docs/WINDOWS_POWERSHELL_QUICKSTART.md).

## Short answer

If you just build the image and run the container without preparation, it will not reliably work immediately.

It will start successfully only if all of the following are already true:

1. `codex-cli` authentication is available inside the container through a writable `CODEX_HOME`.
2. The target repository is mounted into `/workspace/project`.
3. Tracker and GitLab credentials are present in `.env`.
4. Git inside the mounted project can fetch, commit, and push.
5. `CODEX_CLI_COMMAND`, `TEST_COMMAND`, and `LINT_COMMAND` are valid for the target project.
6. If the target repo has `husky` or other git hooks, decide whether to keep the default `GIT_COMMIT_NO_VERIFY=true`.

If `CODEX_HOME` is missing or not authenticated, the worker now fails fast on startup before touching Tracker.
The Docker image builds the Angular task tracker console during `docker build`
and includes it at `/workspace/web/dist/task-tracker-console/browser`.

## What happens on startup

When the container starts:

1. The worker loads env config.
2. It runs `codex login status` using `CODEX_HOME`.
3. If Codex auth is missing, startup fails immediately.
4. If auth is valid, the worker starts polling Tracker.
5. When it picks a task, it works in `/workspace/project`, runs `git`, then `codex`, then tests/lint, then push/MR creation.

So the container does not perform OAuth login by itself. It only reuses an existing authenticated Codex state.

## Recommended local setup

### 1. Confirm Codex access

On the host machine, this is a quick way to confirm that Codex is installed and
your account can authenticate:

```bash
codex login status
```

Expected result: output contains `Logged in`.

If not, authenticate on the host first:

```bash
codex login
```

or for headless flow:

```bash
codex login --device-auth
```

For the worker itself, still create a separate Docker `CODEX_HOME` and run
`codex login` inside that volume in step 4.

### 2. Prepare `.env`

Create `.env` from `.env.example` and set:

- Tracker credentials
- `TRACKER_ORG_HEADER`
- `TRACKER_DEFAULT_QUEUE`
- GitLab credentials
- `TRACKER_STATUS_MAP_FILE`
- `CODEX_CLI_COMMAND`
- `CODEX_CLI_ARGS_JSON`
- `CODEX_SANDBOX` (recommended: `danger-full-access` for this worker)
- `TEST_COMMAND`
- `LINT_COMMAND`
- `GIT_COMMIT_NO_VERIFY`
- `WORKER_ID`

At minimum, verify that:

- `CODEX_CLI_COMMAND exec --json` actually works in non-interactive mode
- `TEST_COMMAND` exists in the mounted target repo
- `LINT_COMMAND` exists in the mounted target repo
- `GIT_COMMIT_NO_VERIFY=false` only if you intentionally want repo hooks to run inside the worker

For `TRACKER_STATUS_MAP_FILE`, point to a JSON file. Inside that file, keep `statuses` aligned with the actual Tracker issue states. Treat `transition` as a matcher hint, not as a permanent execute-id.

For production internal tracker mode, set:

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_STORAGE=postgres
TASK_TRACKER_DATABASE_URL=postgres://tracker:tracker@postgres:5432/ai_developer_tasks
TASK_TRACKER_UI_ENABLED=true
TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy
```

Then apply migrations before starting the continuous worker:

```bash
docker compose run --rm worker npm run tracker:migrate
docker compose run --rm worker npm run preflight
```

Retention, backup/restore and rollback details are in
[docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md).

The Angular console is served at `/tasks` and its JSON API at `/api`. The old
embedded task UI is not present; if you enable the UI without a static bundle,
`/tasks` returns `503`. For browser access in production, put the worker behind
a trusted proxy that injects user and role headers. Bearer mode is for service
clients or proxy-injected `Authorization`, not for browser token storage.

### 3. Prepare the project mount

The worker expects a real git clone of the target project at:

```text
/workspace/project
```

So you must mount a real repository, not just any folder.

The repo must also already have working git credentials for:

- `git fetch`
- `git pull`
- `git push`

### 4. Prepare Codex auth for the container

Recommended mode: dedicated Docker volume.

Create the volume:

```bash
docker volume create codex-home
```

Log in directly inside that volume:

```powershell
docker run --rm -it `
  --entrypoint codex `
  -e CODEX_HOME=/codex-home `
  -v "codex-home:/codex-home" `
  ai-developer-worker `
  login --device-auth
```

This lets the container use the same OpenAI account with its own independent
Codex auth state instead of reusing a copied host `auth.json`.

If you use [compose.yaml](/C:/Users/gabba/projects/developer/compose.yaml), you
can log in into the Compose volume without running the normal entrypoint:

```powershell
docker compose run --rm --entrypoint codex worker login --device-auth
```

The compose entrypoint can still bootstrap from `HOST_CODEX_HOME` when
`/codex-home/auth.json` is missing. Treat that as a convenience for short local
debugging, not as the preferred long-running worker auth flow. If host Codex is
also running, a copied `auth.json` can later fail with `refresh_token_reused`.
See [docs/CODEX_AUTH_TROUBLESHOOTING.md](/C:/Users/gabba/projects/developer/docs/CODEX_AUTH_TROUBLESHOOTING.md).

## First local test

Run one cycle first:

```bash
docker run --rm \
  --env-file .env \
  -e WORKER_RUN_ONCE=true \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  -v /absolute/path/to/project:/workspace/project \
  ai-developer-worker
```

This is the safest way to validate:

- Codex auth is visible in the container
- env is correct
- repo mount is correct
- git credentials work
- the worker can start without auth/config failures

Only after that should you run the continuous loop.

## Continuous local run

```bash
docker run --rm \
  --env-file .env \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  -v /absolute/path/to/project:/workspace/project \
  ai-developer-worker
```

## When it will work immediately

It will work immediately if:

- you already have a valid `.env`,
- you already initialized `codex-home` with worker-specific Codex auth,
- your mounted project is a working git clone,
- that clone already has valid remote auth,
- your configured commands are correct for that project.

In that case, yes: build image, run container, and it should start working without extra manual steps.

## When it will not work immediately

It will not work immediately if at least one of these is missing:

- no Codex auth inside container
- no repo mounted into `/workspace/project`
- wrong `.env`
- wrong `TRACKER_STATUS_MAP_FILE`
- broken `CODEX_CLI_COMMAND`
- missing `TEST_COMMAND` or `LINT_COMMAND`
- no git push access from inside the mounted repo

Most likely first-time failure modes are:

1. `codex login status` fails because `CODEX_HOME` is empty.
2. `git pull` or `git push` fails because repo credentials are not set up.
3. test/lint commands do not exist in the target project.
4. repository git hooks assume a developer workstation environment and should be bypassed with `GIT_COMMIT_NO_VERIFY=true`.

## Direct host bind mount option

This also works for local debugging:

```bash
docker run --rm \
  --env-file .env \
  -e CODEX_HOME=/codex-home \
  -v /absolute/path/to/your/.codex:/codex-home \
  -v /absolute/path/to/project:/workspace/project \
  ai-developer-worker
```

But it is not the default recommendation because:

- the container writes into the same auth state as the host,
- refresh-token updates can interfere with the host login state,
- it increases the blast radius if the container environment is compromised.

Use it only for short-lived local debugging when that tradeoff is acceptable.

## Practical recommendation

For local bring-up, do this in order:

1. `codex login status` on the host.
2. Fill in `.env`.
3. Create a dedicated `codex-home` volume and run `codex login` inside it.
4. Run the container once with `WORKER_RUN_ONCE=true`.
5. Inspect logs.
6. Switch to continuous run only after the one-shot run succeeds.

For the exact Windows PowerShell command sequence, see [docs/WINDOWS_POWERSHELL_QUICKSTART.md](/C:/Users/gabba/projects/developer/docs/WINDOWS_POWERSHELL_QUICKSTART.md).
