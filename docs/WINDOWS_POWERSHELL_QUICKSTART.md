# Windows PowerShell Quickstart

## What to expect

The container does not perform OAuth login by itself.

It will work immediately only if:

1. `codex login status` works on the host.
2. You mount a writable authenticated `CODEX_HOME` into the container.
3. You mount a real git clone into `/workspace/project`.
4. `.env` contains valid Tracker and GitLab settings.
5. `CODEX_COMMAND`, `TEST_COMMAND`, and `LINT_COMMAND` are valid for the mounted project.

If those prerequisites are missing, startup will fail early, usually before the worker touches Tracker.

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

### 5. Copy current host Codex auth into that volume

```powershell
docker run --rm `
  -v "${env:USERPROFILE}\.codex:/host-codex:ro" `
  -v "codex-home:/codex-home" `
  -e SOURCE_CODEX_HOME=/host-codex `
  -e TARGET_CODEX_HOME=/codex-home `
  ai-developer-worker `
  node scripts/bootstrap-codex-home.mjs
```

### 6. Create `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Minimum fields to verify:

- `TRACKER_TOKEN`
- `TRACKER_ORG_ID`
- `TRACKER_STATUS_MAP`
- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`
- `CODEX_COMMAND`
- `TEST_COMMAND`
- `LINT_COMMAND`
- `WORKER_ID`

### 7. Set the path to the target project

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
- `CODEX_COMMAND`, `TEST_COMMAND`, and `LINT_COMMAND` are correct

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

You can also use [compose.example.yaml](/C:/Users/gabba/projects/developer/compose.example.yaml). Set `TARGET_REPO_PATH` in `.env` first, then run:

Use slash-style path syntax there, for example:

```env
TARGET_REPO_PATH=C:/work/my-project
```

```powershell
docker compose -f compose.example.yaml up --build
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
