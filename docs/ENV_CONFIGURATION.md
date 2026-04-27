# Environment Configuration Guide

This guide consolidates every environment variable used by the worker code and the helper scripts in this repository.

The runtime application configuration is loaded in [src/config.ts](/C:/Users/gabba/projects/developer/src/config.ts). GitLab merge request integration is implemented in [src/integrations/gitlab/client.ts](/C:/Users/gabba/projects/developer/src/integrations/gitlab/client.ts) and uses only:

- `GITLAB_URL`
- `GITLAB_TOKEN`
- `GITLAB_PROJECT_ID`

The worker does not read GitLab CI/CD variables from a project automatically. You must provide values through `.env`, container `--env-file`, or explicit `-e KEY=value` overrides.

## How to build `.env`

1. Copy the template:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

2. Fill the required values from the table below.
3. Keep optional values unless you need to override defaults.
4. Run a one-shot start with `WORKER_RUN_ONCE=true` to validate the configuration before enabling the polling loop.

For Tracker statuses, the repository already includes an example file at [config/trackerStatusMap.example.json](/C:/Users/gabba/projects/developer/config/trackerStatusMap.example.json). In `.env`, point `TRACKER_STATUS_MAP_FILE` to that file and then replace the example statuses and transition hints with the real values from your Tracker workflow.

## Runtime variables used by the worker

| Variable | Required | Default | How to get the value |
| --- | --- | --- | --- |
| `TRACKER_TOKEN` | Yes | None | Create or reuse a Yandex Tracker API token for the service account or user that should read issues, post comments, and move statuses. |
| `TRACKER_ORG_ID` | Yes | None | Take the organization ID that matches your Tracker installation. It must match the header type in `TRACKER_ORG_HEADER`. |
| `TRACKER_ORG_HEADER` | No | `X-Cloud-Org-ID` | Keep the default for Yandex Cloud Tracker. Use `X-Org-ID` only if your Tracker installation requires that header. |
| `TRACKER_DEFAULT_QUEUE` | No | `FRONTEND` | Use the Tracker queue key the worker should poll. Take it from the queue settings in Tracker. |
| `TRACKER_TAG` | No | `ai_dev` | Pick the issue tag that marks tasks eligible for the worker. Create the tag in Tracker if it does not exist yet. |
| `TRACKER_API_BASE_URL` | No | `https://api.tracker.yandex.net/v3` | Keep the default unless you are using a non-standard Tracker endpoint or a test stub. |
| `TRACKER_STATUS_MAP_FILE` | Yes | None | Path to a JSON file that maps the worker logical states to your real Tracker statuses. The `statuses` values in that file must exactly match the issue state names visible in Tracker. |
| `GITLAB_URL` | Yes | None | Use the base URL of your GitLab instance, for example `https://gitlab.example.com`. Do not append `/api/v4`; the client adds that part itself. |
| `GITLAB_TOKEN` | Yes | None | Create a GitLab access token that can read and create merge requests, read MR discussions, read the current user, and post discussion replies in the target project. For one repository, prefer a GitLab project access token over a personal token. In practice give it `api` scope and repository write access for that project. |
| `GITLAB_PROJECT_ID` | Yes | None | Use the numeric or URL-encoded project ID accepted by the GitLab REST API. You can copy it from the project page or query it through the GitLab API once you know the project path. |
| `GIT_AUTHOR_NAME` | No | None | Optional git commit author name for the worker process. Use this in Docker if the mounted repository does not already have `git config user.name` set. |
| `GIT_AUTHOR_EMAIL` | No | None | Optional git commit author email for the worker process. Use this in Docker if the mounted repository does not already have `git config user.email` set. |
| `GIT_COMMIT_NO_VERIFY` | No | `true` | Controls whether worker commits use `git commit --no-verify`. Keep the default unless you intentionally want the worker to run target-repo git hooks such as `husky` or `lint-staged`. |
| `REPO_PATH` | No | `/workspace/project` | Keep the default in Docker. Override only if the worker should use another local checkout path. |
| `BASE_BRANCH` | No | `main` | Set the branch that feature branches and merge requests should target. |
| `POLL_INTERVAL_MINUTES` | No | `30` | Choose how often the worker polls Tracker. Must be a positive integer. |
| `WORKER_CONFIG_FILE` | No | None | Optional YAML or JSON fleet config. When omitted, the `.env` values are bridged into one default repository profile. See [docs/FLEET_OPERATIONAL_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/FLEET_OPERATIONAL_RUNBOOK.md). |
| `LOCK_BACKEND` | No | `tracker` | Coordination backend. Phase 3 MVP supports `tracker`; `redis` and `postgres` fail fast until implemented. |
| `LOCK_TTL_SECONDS` | No | `900` | Lease TTL for task and repository locks. Expired leases do not block another worker. |
| `LOCK_HEARTBEAT_SECONDS` | No | `60` | Interval for lease renewal during Codex, validation, and publish work. |
| `LOCK_REDIS_URL` | No | None | Reserved for future Redis lock backend. |
| `LOCK_POSTGRES_URL` | No | None | Reserved for future PostgreSQL lock backend. |
| `CODEX_HOME` | No | `~/.codex` on the current machine | Use a writable Codex auth directory. In Docker, this should usually be the mounted volume path, for example `/codex-home`. |
| `CODEX_CLI_COMMAND` | No | `codex` | Use the executable that starts Codex CLI. Keep `codex` unless you need a wrapper launcher. |
| `CODEX_CLI_ARGS_JSON` | No | `[]` | JSON array of launcher/global Codex arguments passed before `exec`. Use this for flags such as `--search` or `--ask-for-approval never`. |
| `CODEX_MODEL` | No | None | Optional explicit Codex model name if you want reproducible runs. |
| `CODEX_PROFILE` | No | None | Optional profile name from the local Codex configuration. |
| `CODEX_SANDBOX` | No | `danger-full-access` | Choose one of `read-only`, `workspace-write`, or `danger-full-access`. |
| `CODEX_EXEC_ARGS_JSON` | No | `[]` | JSON array of extra arguments accepted by `codex exec --help`, such as `--add-dir /workspace/shared`. Do not put launcher/global flags here. |
| `CODEX_TIMEOUT_SECONDS` | No | `1800` | Hard timeout for one `codex exec` process. If the timeout is reached, the worker terminates that Codex process and treats the run as failed. |
| `CODEX_LOG_FULL_EVENTS` | No | `false` | When `true`, the worker logs each raw JSONL event emitted by `codex exec --json`. Enable this for container-level debugging if the default event summaries are not enough. |
| `CODEX_QUESTION_MARKER` | No | `AI_QUESTION:` | Keep the default unless you intentionally changed the worker comment protocol. |
| `TASK_MODE` | No | `auto` | Phase 4 routing mode. `auto` follows structured `AI_ANALYSIS`; `implement` forces implementation; `decompose` runs decomposition; `analyze_only` writes analysis metadata and stops; `human` parks tasks in manual hold. |
| `CONFIDENCE_IMPLEMENT_THRESHOLD` | No | `70` | Minimum analysis confidence for automatic implementation in `TASK_MODE=auto`. |
| `CONFIDENCE_HUMAN_THRESHOLD` | No | `40` | Analysis confidence below this value is routed to manual hold. |
| `CONFIDENCE_PRIORITY_WEIGHT` | No | `2` | Multiplier used by fleet priority scoring when a task already has an `AI ANALYSIS` comment. |
| `DECOMPOSITION_MAX_SUBTASKS` | No | `8` | Maximum number of subtasks accepted from an `AI_DECOMPOSITION` plan. |
| `DECOMPOSITION_CREATE_ISSUES` | No | `true` | When `false`, decomposition writes a dry-run comment instead of creating Tracker issues. |
| `DECOMPOSITION_DRY_RUN` | No | `false` | Forces decomposition to write the proposed plan only. |
| `DECOMPOSITION_DEFAULT_SUBTASK_TAG` | No | `ai_dev` | Tag added to Tracker sub-issues created by decomposition. |
| `DECOMPOSITION_SUBTASK_TITLE_PREFIX` | No | `[AI split]` | Prefix added to created sub-issue titles. |
| `TRACKER_PARENT_LINK_TYPE` | No | `relates` | Tracker relationship used to link decomposition sub-issues to their parent. |
| `TRACKER_BLOCKED_BY_LINK_TYPE` | No | `is blocked by` | Tracker relationship used for dependency links and dependency filtering. |
| `DEPENDENCY_ENFORCEMENT` | No | `true` | When enabled, tasks with unresolved `blockedBy` dependencies are skipped before lease acquisition. |
| `DEPENDENCY_UNKNOWN_STATUS_POLICY` | No | `block` | Policy for dependencies whose status cannot be determined: `block`, `warn`, or `ignore`. |
| `MEMORY_ENABLED` | No | `false` | Enables Phase 5 repository memory. Keep disabled until `npm run memory:validate` passes for `MEMORY_DIR`. |
| `MEMORY_DIR` | No | `/workspace/ai-developer-memory` | Local memory store outside the target repository. The worker writes per-repository files under `repositories/<sanitized RepositoryProfile.name>/`. |
| `MEMORY_MAX_CONTEXT_CHARS` | No | `6000` | Hard character budget for the memory context section injected into analysis and implementation prompts. |
| `MEMORY_STRICT` | No | `false` | When `false`, corrupted repository memory is disabled with a warning. When `true`, invalid memory blocks processing. |
| `MEMORY_INCLUDE_DRAFT_RULES` | No | `false` | Includes draft prompt rules in prompts. Leave disabled for normal operation; approved rules are included automatically. |
| `MEMORY_SIMILAR_FAILURE_LIMIT` | No | `3` | Maximum number of similar failure memory entries included in one prompt context bundle. |
| `MEMORY_BOOTSTRAP_ON_START` | No | `false` | Reserved for the post-MVP bootstrap flow. The MVP validates storage and consumes manually maintained memory. |
| `MEMORY_REFRESH_ON_PREFLIGHT` | No | `false` | Reserved for the post-MVP refresh flow. The legacy typo `MEMORY_REFRESH_ON_PRELIGHT` is also accepted. |
| `MEMORY_BOOTSTRAP_CODEX_SANDBOX` | No | `inherit` | Reserved for bootstrap. Accepted values are `inherit`, `read-only`, `workspace-write`, and `danger-full-access`. |
| `OBSERVABILITY_ENABLED` | No | `false` | Starts the Phase 6 observability HTTP server for health, readiness, metrics, dashboard API, and alerts. |
| `OBSERVABILITY_HOST` | No | `127.0.0.1` | Interface for the observability server. Use `0.0.0.0` only on trusted internal networks or behind a private proxy. |
| `OBSERVABILITY_PORT` | No | `9464` | Port for all observability endpoints. `METRICS_PORT` is accepted as a backward-compatible alias. |
| `OBSERVABILITY_BASE_URL` | No | `http://<host>:<port>` | Base URL used by the HTTP router and alert dashboard links. |
| `OBSERVABILITY_STRICT_STARTUP` | No | `true` | When true, a port bind failure fails startup. When false, the worker logs a warning and keeps processing. |
| `OBSERVABILITY_REDACT_MAX_CHARS` | No | `4000` | Maximum diagnostic length after secret redaction in events, API payloads, and alerts. |
| `METRICS_ENABLED` | No | `true` | Enables Prometheus text output on the observability server. |
| `METRICS_PATH` | No | `/metrics` | Path for Prometheus text exposition. |
| `HEALTH_PATH` | No | `/healthz` | Liveness endpoint path. |
| `READY_PATH` | No | `/readyz` | Readiness endpoint path. |
| `OBSERVABILITY_EVENT_STORE` | No | `memory` | Event store backend: `memory` or `file`. |
| `OBSERVABILITY_EVENT_STORE_FILE` | No | None | JSONL file used when `OBSERVABILITY_EVENT_STORE=file`. |
| `OBSERVABILITY_EVENT_RETENTION` | No | `1000` | Bounded recent event retention count. |
| `DASHBOARD_ENABLED` | No | `false` | Enables the read-only dashboard and `/api/*` endpoints. |
| `DASHBOARD_PATH` | No | `/dashboard` | Dashboard HTML path. |
| `DASHBOARD_REFRESH_SECONDS` | No | `10` | Browser polling interval for dashboard API refreshes. |
| `DASHBOARD_API_PATH` | No | `/api` | Read-only dashboard API path prefix. |
| `DASHBOARD_BEARER_TOKEN` | No | None | Optional bearer token protecting `/dashboard` and `/api/*`. |
| `ALERTS_ENABLED` | No | `false` | Enables event-based alert evaluation and notification sinks. |
| `ALERT_CHANNELS` | No | None | Comma-separated channels: `webhook`, `slack`, `telegram`. |
| `ALERT_WEBHOOK_URL` | No | None | Generic JSON webhook URL for `ALERT_CHANNELS=webhook`. |
| `SLACK_WEBHOOK_URL` | No | None | Slack incoming webhook URL for `ALERT_CHANNELS=slack`. |
| `TELEGRAM_BOT_TOKEN` | No | None | Telegram bot token for `ALERT_CHANNELS=telegram`. |
| `TELEGRAM_CHAT_ID` | No | None | Telegram chat id for `ALERT_CHANNELS=telegram`. |
| `ALERT_MIN_SEVERITY` | No | `warning` | Minimum notification severity: `info`, `warning`, or `error`. |
| `ALERT_DEDUP_WINDOW_SECONDS` | No | `900` | Suppresses repeated alerts with the same rule/repository/issue/stage key. |
| `ALERT_QUEUE_BLOCKED_CYCLES` | No | `3` | Queue-blocked cycles before a warning alert is emitted. |
| `ALERT_CODEX_TIMEOUT_WINDOW_SECONDS` | No | `3600` | Rolling window for repeated Codex timeout alerts. |
| `ALERT_CODEX_TIMEOUT_THRESHOLD` | No | `3` | Timeout count needed inside the rolling window. |
| `ALERT_VALIDATION_FAILURE_WINDOW_SECONDS` | No | `3600` | Rolling window for repeated validation failure alerts. |
| `ALERT_VALIDATION_FAILURE_THRESHOLD` | No | `3` | Validation failure count needed inside the rolling window. |
| `ALERT_WORKER_STALE_SECONDS` | No | `300` | Reserved threshold for worker stale snapshots. |
| `TEST_COMMAND` | No | `npm test` | Set the exact test command that should run inside the mounted target repository. |
| `LINT_COMMAND` | No | `npm run lint` | Set the exact lint command that should run inside the mounted target repository. |
| `TYPE_CHECK_COMMAND` | No | None | Optional typecheck gate. When set, runs before lint and tests and blocks publish on failure. |
| `BUILD_COMMAND` | No | None | Optional build gate. When set, runs after lint/tests and blocks publish on failure. |
| `SECURITY_SCAN_COMMAND` | No | None | Optional command-based security scan gate, for example `npm audit --audit-level=high`. Non-zero exit blocks publish. |
| `SAST_COMMAND` | No | None | Optional command-based SAST gate, for example `semgrep ci`. Output is kept as generic diagnostic text. |
| `COVERAGE_COMMAND` | No | None | Optional coverage gate command. The worker expects an Istanbul/Vitest-style summary from `COVERAGE_REPORT_FILE` or stdout. |
| `MIN_COVERAGE_PERCENT` | No | None | Optional overall line coverage threshold from `0` to `100`. When set, lower coverage blocks publish. |
| `COVERAGE_REPORT_FILE` | No | None | Optional coverage summary path relative to `REPO_PATH`, for example `coverage/coverage-summary.json`. Preferred over parsing stdout. |
| `VISUAL_REGRESSION_COMMAND` | No | None | Optional command-based visual regression gate. The worker does not assume Playwright or any frontend stack. |
| `VISUAL_REGRESSION_ARTIFACTS_DIR` | No | None | Optional artifact path included in validation summaries and MR notes when the visual regression gate is configured. |
| `MAX_FIX_ATTEMPTS` | Yes | None | Positive integer. Choose how many automated fix attempts the worker may perform for one task. |
| `MAX_REVIEW_FIX_ATTEMPTS` | No | `MAX_FIX_ATTEMPTS` | Positive integer. Choose how many validation repair attempts the worker may perform while addressing unresolved GitLab review discussions. |
| `WORKER_ID` | Yes | None | Stable identifier for this worker instance. Use a unique value per running worker, for example `worker-1` or `gitlab-bot-prod-1`. |
| `WORKER_RUN_ONCE` | No | `false` | Set to `true` for a single validation cycle or local smoke run. |
| `WORKER_PREFLIGHT_ONLY` | No | `false` | Set to `true` to run only the preflight report and exit without processing Tracker issues. `npm run preflight` sets this mode automatically. |
| `TRACKER_PREFLIGHT_ISSUE_KEY` | No | None | Optional sandbox Tracker issue key. When set, preflight verifies write permission by adding a neutral comment to this issue. When omitted, Tracker write preflight is reported as `WARN` and no write is attempted. |
| `GITLAB_PREFLIGHT_SOURCE_BRANCH` | No | None | Optional sandbox source branch. When set, preflight finds or creates a draft/test merge request from this branch to verify MR write permission. When omitted, GitLab write preflight is reported as `WARN` and no write is attempted. |
| `PREFLIGHT_RUN_TARGET_COMMANDS` | No | `true` | Controls whether preflight runs `TEST_COMMAND` and `LINT_COMMAND` in `REPO_PATH`. Set to `false` when those commands are too expensive for a startup check. |
| `TARGET_ISSUE_KEY` | No | None | Manual run mode. When set, `WorkerOrchestrator.runOnce()` loads only this Tracker issue, skips the normal queue scan, and still respects structured worker locks. |

## Preflight mode

Run the safe preflight report with:

```bash
npm run preflight
```

or:

```bash
WORKER_PREFLIGHT_ONLY=true npm run dev
```

PowerShell:

```powershell
$env:WORKER_PREFLIGHT_ONLY = "true"
npm run dev
```

The report always uses this order: config load, Codex auth, git repository, Tracker read, Tracker write, GitLab read, GitLab write, target commands. Missing `TRACKER_PREFLIGHT_ISSUE_KEY` or `GITLAB_PREFLIGHT_SOURCE_BRANCH` does not fail preflight; those write checks are reported as `WARN` and no production issue or merge request is mutated.

For a strict sandbox run, set both sandbox variables:

```env
TRACKER_PREFLIGHT_ISSUE_KEY=FRONTEND-42
GITLAB_PREFLIGHT_SOURCE_BRANCH=preflight/worker-check
```

`PREFLIGHT_RUN_TARGET_COMMANDS=false` skips `TEST_COMMAND` and `LINT_COMMAND` and reports that check as `WARN`.

## Quality gates

Before publishing or updating a merge request, the worker first verifies that the target repository has changes. It then runs quality gates in this fail-fast order:

```text
typecheck -> lint -> tests -> build -> security_scan -> sast -> coverage -> visual_regression
```

`LINT_COMMAND` and `TEST_COMMAND` keep their defaults. The other gates are skipped unless their command environment variable is set. Any configured gate that exits non-zero blocks publishing and feeds the gate command, stdout, and stderr back into the Codex fix prompt.

Coverage parsing supports this Istanbul/Vitest-style summary:

```json
{
  "total": {
    "lines": {
      "pct": 82.5
    }
  }
}
```

Set `COVERAGE_REPORT_FILE` when possible so the worker reads a stable report file from `REPO_PATH`. If it is omitted, the worker tries to parse the coverage command stdout as the same JSON shape.

## Target issue mode

Use this mode for manual debugging of one Tracker task:

```env
TARGET_ISSUE_KEY=FRONTEND-42
WORKER_RUN_ONCE=true
```

With `TARGET_ISSUE_KEY` set, the worker does not call the usual queue/tag candidate search. It loads the target issue directly, checks structured `AI STATUS` locks, resumes only matching `/resume` clarification flows, and processes unresolved GitLab review discussions when the target issue is already in `review`.

## Phase 4 task routing

Before implementation, Codex must now return one structured line:

```text
AI_ANALYSIS: {"confidence":82,"taskType":"frontend_ui_fix","recommendedMode":"implement","promptProfileId":"frontend_ui_fix",...}
```

The worker stores that decision as an `AI ANALYSIS:` Tracker comment and uses it for routing and restart recovery. Invalid analysis output fails safely into manual hold.

`TASK_MODE=auto` applies the confidence thresholds. Low-confidence tasks below `CONFIDENCE_HUMAN_THRESHOLD` move to `waiting_for_answer` with `manual_hold`. Tasks below `CONFIDENCE_IMPLEMENT_THRESHOLD` do not start implementation unless `TASK_MODE=implement` is explicitly set.

`TASK_MODE=decompose` or an analysis decision with `recommendedMode=decompose` runs the decomposition prompt. `DECOMPOSITION_DRY_RUN=true` writes the proposed plan as an `AI DECOMPOSITION:` comment without creating issues. Create mode uses Tracker issue creation plus `TRACKER_PARENT_LINK_TYPE` and `TRACKER_BLOCKED_BY_LINK_TYPE` for parent/dependency links.

Dependency filtering runs before leases are acquired. The worker reads `blockedBy` issue fields and Tracker links when available; blockers must have logical status `done` unless `DEPENDENCY_UNKNOWN_STATUS_POLICY` is relaxed.

## Phase 5 memory MVP

Repository memory is off by default. When `MEMORY_ENABLED=true`, analysis and implementation prompts receive a compact `Repository context` section assembled from approved `prompt-rules.json`, manual `knowledge.json`, and similar `failures.jsonl` entries. Fix, review-fix, decomposition, bootstrap, and review-learning promotion are intentionally outside the MVP path.

Run `npm run memory:validate` before enabling memory in production. The lifecycle, schema examples, approval workflow, and cleanup procedure are documented in [docs/MEMORY_LIFECYCLE.md](/C:/Users/gabba/projects/developer/docs/MEMORY_LIFECYCLE.md).

## Phase 6 observability MVP

Observability is off by default. When `OBSERVABILITY_ENABLED=true`, the worker starts one HTTP server for `/healthz`, `/readyz`, `/metrics`, optional dashboard/API, and optional alerts. The server starts before startup checks and readiness becomes `ok` only after repository and Codex auth checks pass.

Recommended rollout:

```env
OBSERVABILITY_ENABLED=true
METRICS_ENABLED=true
DASHBOARD_ENABLED=false
ALERTS_ENABLED=false
```

Then enable dashboard on a trusted interface:

```env
DASHBOARD_ENABLED=true
DASHBOARD_BEARER_TOKEN=change-me
```

Full endpoint contracts, Prometheus scrape examples, Docker/Compose snippets, and alert setup are documented in [docs/OBSERVABILITY_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/OBSERVABILITY_RUNBOOK.md).

## Fleet mode

Set `WORKER_CONFIG_FILE` to a YAML or JSON file when one worker process should manage multiple repositories. The config file owns repository-specific values such as `repoPath`, `gitlabProjectId`, queues, tags, base branch, and quality gate commands. Global secrets can still be referenced through environment variables with fields such as `tracker.tokenEnv`, `tracker.orgIdEnv`, `gitlab.urlEnv`, and `gitlab.tokenEnv`.

Fleet mode uses `AI LEASE:` Tracker comments for task and repository leases. The task lease prevents duplicate processing of one issue, while the repository lease serializes mutations of the same checkout path. Full examples and caveats are in [docs/FLEET_OPERATIONAL_RUNBOOK.md](/C:/Users/gabba/projects/developer/docs/FLEET_OPERATIONAL_RUNBOOK.md).

## `TRACKER_STATUS_MAP_FILE` format

The file must contain a JSON object with all six logical states used by the worker:

- `open`
- `in_progress`
- `waiting_for_answer`
- `review`
- `failed`
- `done`

Example:

```json
{
  "open": {
    "statuses": ["Open"]
  },
  "in_progress": {
    "statuses": ["In Progress"],
    "transition": "start"
  },
  "waiting_for_answer": {
    "statuses": ["Waiting for answer"],
    "transition": "need-info"
  },
  "review": {
    "statuses": ["In Review"],
    "transition": "review"
  },
  "failed": {
    "statuses": ["Failed"],
    "transition": "fail"
  },
  "done": {
    "statuses": ["Done"],
    "transition": "done"
  }
}
```

`statuses` are used to recognize the current state of an issue. `transition` is a hint used to match one of the transitions returned by Tracker for that issue.

## Extra variables used outside `src/config.ts`

These are not part of the main runtime config object, but they are still read directly in repository code:

| Variable | Where it is used | Purpose |
| --- | --- | --- |
| `HOST_CODEX_HOME` | [compose.yaml](/C:/Users/gabba/projects/developer/compose.yaml) | Host Codex auth directory mounted read-only into `/host-codex` so Compose can auto-bootstrap `/codex-home` on first start. |
| `TARGET_REPO_PATH` | [compose.yaml](/C:/Users/gabba/projects/developer/compose.yaml) | Host path mounted into `/workspace/project` when you run through Docker Compose. |
| `CODEX_API_KEY` | [src/integrations/codex/auth.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/auth.ts) | If set, the worker skips `codex login status` and assumes direct API-key based Codex auth. |
| `OPENAI_API_KEY` | Operational setup | Does not skip the worker auth preflight by itself. To use it with Codex auth storage, run `printenv OPENAI_API_KEY \| codex login --with-api-key` before starting the worker. |
| `SOURCE_CODEX_HOME` | [scripts/bootstrap-codex-home.mjs](/C:/Users/gabba/projects/developer/scripts/bootstrap-codex-home.mjs) | Source directory copied by the bootstrap script. Defaults to the current user's `~/.codex`. |
| `TARGET_CODEX_HOME` | [scripts/bootstrap-codex-home.mjs](/C:/Users/gabba/projects/developer/scripts/bootstrap-codex-home.mjs) | Destination directory written by the bootstrap script. Defaults to `.codex-home` in the current repo. |

## GitLab values: fastest way to obtain them

### `GITLAB_URL`

Take the root URL you already use in the browser for the GitLab web UI.

Example:

```env
GITLAB_URL=https://gitlab.example.com
```

### `GITLAB_TOKEN`

Recommended choice:

1. Use a project access token when the worker should touch only one repository.
2. Use a personal access token only when the worker must work across multiple projects and a project token is too narrow.
3. Keep the token in both `GITLAB_TOKEN` and `GIT_REPOSITORY_TOKEN` if you want the same credential to be used for GitLab API calls and git fetch/push over HTTPS.

For Git over HTTPS, this worker defaults `GIT_REPOSITORY_USERNAME` to `oauth2`. Keep that value for GitLab PAT, project access token, or group access token unless your GitLab instance requires another non-empty username.

### `GITLAB_PROJECT_ID`

Use one of these sources:

1. The project overview page in GitLab, where the project ID is usually displayed.
2. The project path, encoded for the GitLab API.
3. A one-time API lookup if you already have the token:

```bash
curl --header "PRIVATE-TOKEN: <token>" \
  "https://gitlab.example.com/api/v4/projects/<url-encoded-group%2Fproject>"
```

## Example for `platform/client-application`

If the worker should operate on `https://repo.tools-indigolab.ru/platform/client-application.git`, the `.env` fragment should look like this:

```env
GITLAB_URL=https://repo.tools-indigolab.ru
GITLAB_TOKEN=your-project-access-token
GITLAB_PROJECT_ID=platform%2Fclient-application
GIT_REMOTE_NAME=origin
GIT_REPOSITORY_TOKEN=your-project-access-token
GIT_REPOSITORY_USERNAME=oauth2
GIT_REPOSITORY_URL=https://repo.tools-indigolab.ru/platform/client-application.git
TARGET_REPO_PATH=C:/Users/gabba/projects/client-application
REPO_PATH=/workspace/project
BASE_BRANCH=main
```

`GITLAB_PROJECT_ID` can be either the numeric project ID from GitLab UI or the URL-encoded path `platform%2Fclient-application`.

Then take the `id` from the response.

### `GITLAB_TOKEN`

Create a token for the account or bot that will own the merge requests. Because the worker code lists open merge requests and creates new ones, the token must be allowed to call the merge request API for the target project.

Practical checklist:

- Use a dedicated bot or service account if possible.
- Grant only the access required for the target project.
- Validate the token before starting the worker:

```bash
curl --header "PRIVATE-TOKEN: <token>" \
  "https://gitlab.example.com/api/v4/projects/<project-id>/merge_requests?state=opened"
```

If that request succeeds, the same token shape should work for the worker's read path. You should also verify it can create a merge request in your environment before relying on it in production.

## Git commit identity inside Docker

The worker can fetch and push with repository credentials and still fail later on `git commit` if git author identity is missing in the mounted checkout. This usually appears as `Author identity unknown` and a fallback host like `root@container-id.(none)`.

Use one of these approaches:

1. Configure the mounted repository itself:

```bash
git -C /path/to/repo config user.name "AI Worker"
git -C /path/to/repo config user.email "ai-worker@example.com"
```

2. Or pass identity through the worker environment:

```env
GIT_AUTHOR_NAME=AI Worker
GIT_AUTHOR_EMAIL=ai-worker@example.com
```

The worker startup now checks `git var GIT_AUTHOR_IDENT`, so this misconfiguration should fail fast before task processing starts.

## Git hooks on worker commits

The worker already validates repository state with `TEST_COMMAND` and `LINT_COMMAND`. To avoid failures caused by developer-local hook stacks inside mounted repos, worker commits default to `git commit --no-verify`.

Use this default unless you intentionally want repository hooks to run inside the worker:

```env
GIT_COMMIT_NO_VERIFY=true
```

If your target repository requires its hooks even for automation, set:

```env
GIT_COMMIT_NO_VERIFY=false
```

Accepted values are `true`, `false`, `1`, `0`, `yes`, and `no`.

## Recommended validation flow

1. Fill `.env`.
2. Run `codex login status` on the host, set `CODEX_API_KEY`, or persist `OPENAI_API_KEY` with `printenv OPENAI_API_KEY | codex login --with-api-key`.
3. Start the worker once with `WORKER_RUN_ONCE=true`.
4. Fix any missing variable reported by startup.

The config loader fails fast for missing required variables, so startup errors are the quickest way to catch an incomplete `.env`.
