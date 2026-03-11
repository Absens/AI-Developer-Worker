# Windows PowerShell Quickstart

This document is the Windows command companion to [docs/LOCAL_DOCKER_RUN.md](/C:/Users/gabba/projects/developer/docs/LOCAL_DOCKER_RUN.md). Use the local Docker runbook for detailed behavior, prerequisites, and failure analysis.

## Before you start

Make sure the prerequisites from [docs/LOCAL_DOCKER_RUN.md](/C:/Users/gabba/projects/developer/docs/LOCAL_DOCKER_RUN.md) are satisfied. Most importantly: host Codex auth must already exist, `.env` must be valid, and the mounted target repo must be a working git clone with push access.

## Copy-paste steps

### 1. Check Codex login on the host

```powershell
codex login status
```

Expected result: output contains `Logged in`.

### 2. Go to the worker project

```powershell
Set-Location C:\Users\gabba\projects\developer
```

### 3. Build the image

```powershell
docker build -t ai-developer-worker .
```

### 4. Create a dedicated Docker volume for Codex auth

```powershell
docker volume create codex-home
```

### 5. Create `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Set these fields carefully:

- `HOST_CODEX_HOME`
- `TARGET_REPO_PATH`

Minimum fields to verify:

- `TRACKER_TOKEN`
- `TRACKER_ORG_ID`
- `TRACKER_ORG_HEADER`
- `TRACKER_DEFAULT_QUEUE`
- `TRACKER_STATUS_MAP_FILE`
- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`
- `CODEX_CLI_COMMAND`
- `CODEX_CLI_ARGS_JSON`
- `CODEX_SANDBOX` (recommended: `danger-full-access`)
- `TEST_COMMAND`
- `LINT_COMMAND`
- `WORKER_ID`

For `TRACKER_STATUS_MAP_FILE`, use a path to a JSON file. In that file, `statuses` should match the real Tracker states. `transition` is only a hint used to find an allowed workflow transition.

With Compose, the worker now copies auth automatically from `HOST_CODEX_HOME` into the named Docker volume on the first start if `/codex-home/auth.json` is missing.

### 6. Set the path to the target project

Replace this path with the repository the worker should modify:

```powershell
$TargetRepo = "C:\ABSOLUTE\PATH\TO\YOUR\PROJECT"
```

This must be a real git clone with working fetch/pull/push credentials.

### 8. First run: one-shot

```powershell
docker run --rm `
  --env-file .env `
  -e WORKER_RUN_ONCE=true `
  -e CODEX_HOME=/codex-home `
  -v "codex-home:/codex-home" `
  -v "${TargetRepo}:/workspace/project" `
  ai-developer-worker
```

Use this first run to confirm:

- Codex auth is visible in the container
- Tracker config is valid
- GitLab config is valid
- the mounted project path is correct
- git credentials inside that mounted repo work
- `CODEX_CLI_COMMAND`, `TEST_COMMAND`, and `LINT_COMMAND` are correct

### 9. Continuous run

```powershell
docker run --rm `
  --env-file .env `
  -e CODEX_HOME=/codex-home `
  -v "codex-home:/codex-home" `
  -v "${TargetRepo}:/workspace/project" `
  ai-developer-worker
```

## Compose option

You can also use [compose.yaml](/C:/Users/gabba/projects/developer/compose.yaml). Set both `HOST_CODEX_HOME` and `TARGET_REPO_PATH` in `.env` first, then run:

Use slash-style path syntax there, for example:

```env
HOST_CODEX_HOME=C:/Users/your-user/.codex
TARGET_REPO_PATH=C:/work/my-project
```

```powershell
docker compose up --build
```

For a one-shot run, override `WORKER_RUN_ONCE=true` in `.env` before starting Compose.

## Direct host auth mount

For short local debugging you can mount the host `.codex` directly:

```powershell
docker run --rm `
  --env-file .env `
  -e WORKER_RUN_ONCE=true `
  -e CODEX_HOME=/codex-home `
  -v "${env:USERPROFILE}\.codex:/codex-home" `
  -v "${TargetRepo}:/workspace/project" `
  ai-developer-worker
```

This is less safe than the dedicated `codex-home` volume because the container writes into the same auth state as the host.

## Most common first-run failures

1. `Codex CLI is not authenticated`:
   `CODEX_HOME` was not mounted or the copied auth state is missing/invalid.
2. `git pull` or `git push` fails:
   the mounted repo does not have working remote credentials.
3. tests or lint fail immediately:
   `TEST_COMMAND` or `LINT_COMMAND` do not match the target project.
4. Tracker/GitLab HTTP errors:
   `.env` contains wrong credentials or wrong URLs.
