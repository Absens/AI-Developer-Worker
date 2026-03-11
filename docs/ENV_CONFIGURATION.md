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
| `GITLAB_TOKEN` | Yes | None | Create a GitLab access token that can read and create merge requests in the target project. For one repository, prefer a GitLab project access token over a personal token. The token must be valid for `GET` and `POST` calls to `/api/v4/projects/:id/merge_requests`, so in practice give it `api` scope and repository write access for that project. |
| `GITLAB_PROJECT_ID` | Yes | None | Use the numeric or URL-encoded project ID accepted by the GitLab REST API. You can copy it from the project page or query it through the GitLab API once you know the project path. |
| `REPO_PATH` | No | `/workspace/project` | Keep the default in Docker. Override only if the worker should use another local checkout path. |
| `BASE_BRANCH` | No | `main` | Set the branch that feature branches and merge requests should target. |
| `POLL_INTERVAL_MINUTES` | No | `30` | Choose how often the worker polls Tracker. Must be a positive integer. |
| `CODEX_HOME` | No | `~/.codex` on the current machine | Use a writable Codex auth directory. In Docker, this should usually be the mounted volume path, for example `/codex-home`. |
| `CODEX_CLI_COMMAND` | No | `codex` | Use the executable that starts Codex CLI. Keep `codex` unless you need a wrapper launcher. |
| `CODEX_CLI_ARGS_JSON` | No | `[]` | JSON array of arguments passed before `exec`. Keep empty for standard installs. |
| `CODEX_MODEL` | No | None | Optional explicit Codex model name if you want reproducible runs. |
| `CODEX_PROFILE` | No | None | Optional profile name from the local Codex configuration. |
| `CODEX_SANDBOX` | No | `danger-full-access` | Choose one of `read-only`, `workspace-write`, or `danger-full-access`. |
| `CODEX_EXEC_ARGS_JSON` | No | `[]` | JSON array of extra arguments passed to `codex exec`. |
| `CODEX_QUESTION_MARKER` | No | `AI_QUESTION:` | Keep the default unless you intentionally changed the worker comment protocol. |
| `TEST_COMMAND` | No | `npm test` | Set the exact test command that should run inside the mounted target repository. |
| `LINT_COMMAND` | No | `npm run lint` | Set the exact lint command that should run inside the mounted target repository. |
| `MAX_FIX_ATTEMPTS` | Yes | None | Positive integer. Choose how many automated fix attempts the worker may perform for one task. |
| `WORKER_ID` | Yes | None | Stable identifier for this worker instance. Use a unique value per running worker, for example `worker-1` or `gitlab-bot-prod-1`. |
| `WORKER_RUN_ONCE` | No | `false` | Set to `true` for a single validation cycle or local smoke run. |

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
| `CODEX_API_KEY` | [src/integrations/codex/auth.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/auth.ts) | If set, the worker skips `codex login status` and assumes API key based Codex auth. |
| `OPENAI_API_KEY` | [src/integrations/codex/auth.ts](/C:/Users/gabba/projects/developer/src/integrations/codex/auth.ts) | Same behavior as `CODEX_API_KEY`; accepted as an alternative auth source for Codex CLI. |
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

## Recommended validation flow

1. Fill `.env`.
2. Run `codex login status` on the host, or set `CODEX_API_KEY` / `OPENAI_API_KEY`.
3. Start the worker once with `WORKER_RUN_ONCE=true`.
4. Fix any missing variable reported by startup.

The config loader fails fast for missing required variables, so startup errors are the quickest way to catch an incomplete `.env`.
