# Docker-only server deployment plan

## Цель

Перевести сервис в режим, где для production-запуска не нужен checkout репозитория на host-машине. Оператор должен указывать GitLab repository URL, токены и параметры проверок, а сервис сам должен создавать и поддерживать checkout внутри Docker volume, запускать Codex CLI, выполнять проверки, публиковать branch/MR и отдавать админку через домен.

Целевое состояние:

- `TARGET_REPO_PATH` и bind mount host checkout больше не нужны.
- `HOST_CODEX_HOME` и копирование host `~/.codex` не используются в production.
- Все stateful данные находятся в Docker volumes или внешних managed сервисах.
- Админка доступна по HTTPS-домену через reverse proxy.
- Codex auth работает в headless/server-сценарии без ручного доступа к файловой системе host.

## Текущее состояние

Что уже есть:

- Docker image собирает worker и Angular console.
- `compose.yaml` поднимает `postgres`, `migrate` и `worker`.
- Worker умеет работать с `GIT_REPOSITORY_URL`, `GIT_REPOSITORY_TOKEN` и переписывать remote на HTTPS.
- `CODEX_API_KEY` уже может пропускать `codex login status` preflight.
- Альтернативно можно выполнить `codex login --device-auth` в dedicated Docker volume `codex-home`.
- Внутренний tracker и UI уже рассчитаны на PostgreSQL и `/tasks`.
- Observability server уже отдает `/healthz`, `/readyz`, `/metrics`, а Angular console использует `/tasks` и `/api/*`.

Что мешает полностью контейнерному серверному запуску:

- `compose.yaml` требует `TARGET_REPO_PATH` и монтирует готовый host checkout в `/workspace/project`.
- `RepositoryGitService.assertRepositoryReady()` предполагает, что `repoPath` уже является рабочим git checkout.
- Fleet config требует `repositories[].repoPath`.
- Repository lease сейчас привязан к нормализованному `repoPath`, а не к стабильному logical repository key.
- Docker image содержит только базовые инструменты (`node`, `git`, `curl`, `jq`, `ripgrep`, `openssh-client`). Для целевых репозиториев могут понадобиться отдельные runtimes: pnpm/yarn, Python, Go, Java, Docker CLI, browsers, Playwright dependencies и т.д.
- Production auth для админки пока описан как reverse-proxy concern, но готового compose-профиля с доменом, TLS и headers нет.

## Целевая архитектура

Минимальная production-схема:

```text
Internet
  |
  v
reverse-proxy container (Caddy/Traefik/Nginx, TLS, auth)
  |
  v
worker container
  |-- /tasks, /api, /metrics, /healthz, /readyz
  |-- codex exec
  |-- git clone/fetch/push
  |
  +-- repo-workspaces volume: /workspace/repos/<repository-key>
  +-- codex-home volume or CODEX_API_KEY secret
  +-- memory/events volumes
  |
postgres container or managed PostgreSQL
```

Recommended volumes:

- `tracker-postgres`: internal tracker database.
- `repo-workspaces`: cloned target repositories.
- `codex-home-worker-1`: Codex auth state if OAuth/device auth is used.
- `ai-developer-memory`: optional repository memory.
- `ai-developer-events`: optional JSONL observability event store.

Only the reverse proxy should publish public ports. The worker should listen on an internal Docker network.

## Repository URL mode

Add a first-class repository workspace lifecycle.

### Configuration changes

Keep backward compatibility with `REPO_PATH`, but add URL-first configuration:

```env
REPOSITORY_WORKSPACE_ROOT=/workspace/repos
GIT_REPOSITORY_URL=https://gitlab.example.com/group/project.git
REPOSITORY_NAME=group-project
BASE_BRANCH=main
```

For fleet config:

```yaml
repositories:
  - name: client-application
    gitRepositoryUrl: https://gitlab.example.com/platform/client-application.git
    checkoutPath: /workspace/repos/client-application
    gitlabProjectId: platform%2Fclient-application
    baseBranch: main
    queues: [FRONTEND]
    tags: [ai_dev]
    testCommand: npm test
    lintCommand: npm run lint
    typeCheckCommand: npm run typecheck
    buildCommand: npm run build
```

Plan:

1. Make `repoPath` optional when `gitRepositoryUrl` is present.
2. Derive `repoPath` from `REPOSITORY_WORKSPACE_ROOT` plus sanitized repository name.
3. Keep explicit `repoPath` for local/backward-compatible launches.
4. Use repository `name` or canonical repository URL as the lease key, not the absolute checkout path.

### Workspace bootstrap

Add a `RepositoryWorkspaceService` before `RepositoryGitService.assertRepositoryReady()`:

1. Ensure `REPOSITORY_WORKSPACE_ROOT` exists.
2. Resolve a stable checkout path for the repository.
3. If path does not contain `.git`, run `git clone --branch <baseBranch> <url> <repoPath>` using the same HTTPS auth extraheader mechanism.
4. If path already contains `.git`, validate that `origin` matches the configured URL or rewrite it.
5. Configure `git config --global --add safe.directory <repoPath>` inside the container.
6. Configure commit identity from `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`.
7. Run `git fetch --all --prune`.
8. Refuse to continue if the checkout is dirty on a non-task branch.
9. Expose clear preflight diagnostics for clone/auth/branch failures.

Important behavior:

- Do not delete or reset an existing checkout automatically.
- Add an explicit maintenance command later, for example `npm run repo:reset -- <repository-name>`, if corrupted checkouts need cleanup.
- Preserve task branches across restarts so the worker can resume safely.

## Target repository toolchains

The worker can clone any Git repository, but it cannot reliably test any repository unless the required runtime exists in the container.

MVP approach:

- Keep one worker image, but allow a deployment-specific Dockerfile to extend it.
- Document examples:
  - Node frontend image with `pnpm`, browsers and Playwright dependencies.
  - Go backend image.
  - Python backend image.
- Treat `TEST_COMMAND`, `LINT_COMMAND`, `TYPE_CHECK_COMMAND`, `BUILD_COMMAND` as commands executed inside that image.

Next step after MVP:

- Add per-repository `executorImage` support.
- Worker schedules Codex/validation in a short-lived executor container with mounted `repo-workspaces`, `codex-home`, memory and artifacts.
- Avoid mounting the Docker socket into the main worker unless there is a clear isolation design and security review.

## Codex authorization strategy

Production recommendation:

1. Prefer `CODEX_API_KEY` as a Docker secret or environment secret for headless server operation.
2. Keep `CODEX_HOME=/codex-home` writable, but do not depend on copying host auth.
3. Remove `HOST_CODEX_HOME` from production compose.
4. Keep OAuth/device auth as an explicit maintenance flow, not startup behavior.

Supported modes:

### Mode A: API key auth

Use this for server deployments where secrets are managed by Docker, CI/CD, Vault or a cloud secret manager.

```env
CODEX_API_KEY=...
CODEX_HOME=/codex-home
```

The current code already treats `CODEX_API_KEY` as sufficient for auth preflight. Add a stronger preflight check that runs a minimal non-mutating `codex exec` probe when feasible, because simply seeing the env var does not prove that the installed Codex CLI accepts it.

### Mode B: dedicated Codex OAuth volume

Use this when API key auth is not desired.

```bash
docker compose run --rm --entrypoint codex worker login --device-auth
docker compose run --rm --entrypoint codex worker login status
```

Rules:

- One active worker gets one dedicated `CODEX_HOME` volume.
- Do not share the same `auth.json` between host Codex and worker Codex.
- Do not copy host `~/.codex` for long-running workers.
- For multiple workers, use separate volumes: `codex-home-worker-1`, `codex-home-worker-2`, etc.

### Mode C: persisted API-key login

If only `OPENAI_API_KEY` is available:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

Wrap this in a documented one-shot init/maintenance command rather than doing it implicitly on every container start.

## Server admin access through a domain

Use the existing Angular console under `/tasks` as the primary admin UI.

Required runtime settings:

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_STORAGE=postgres
TASK_TRACKER_DATABASE_URL=postgres://tracker:tracker@postgres:5432/ai_developer_tasks
TASK_TRACKER_UI_ENABLED=true
TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy

OBSERVABILITY_ENABLED=true
OBSERVABILITY_HOST=0.0.0.0
OBSERVABILITY_PORT=9464

TASK_TRACKER_SYSTEM_TOKEN=...
TASK_TRACKER_AGENT_TOKEN=...
```

Reverse proxy responsibilities:

- Terminate TLS for `https://admin.example.com`.
- Forward `/tasks`, `/api`, `/metrics`, `/healthz`, `/readyz` to the worker.
- Protect browser access with SSO, Basic Auth, mTLS or another trusted auth layer.
- Inject trusted identity headers expected by the backend, for example:
  - `x-task-tracker-user`
  - `x-task-tracker-role`
- Keep `/metrics` private or expose it only to Prometheus on an internal network.

Do not expose the worker container directly to the internet.

## Compose target

Create a production compose variant, for example `compose.server.yaml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    volumes:
      - tracker-postgres:/var/lib/postgresql/data

  migrate:
    image: ai-developer-worker:server
    env_file: [.env.server]
    depends_on:
      postgres:
        condition: service_healthy
    command: ["node", "--import", "tsx", "scripts/internal-tracker-migrate.ts"]
    restart: "no"

  worker:
    image: ai-developer-worker:server
    env_file: [.env.server]
    depends_on:
      migrate:
        condition: service_completed_successfully
    volumes:
      - repo-workspaces:/workspace/repos
      - codex-home-worker-1:/codex-home
      - ai-developer-memory:/workspace/ai-developer-memory
      - ai-developer-events:/workspace/ai-developer-events
    expose:
      - "9464"

  proxy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - worker

volumes:
  tracker-postgres:
  repo-workspaces:
  codex-home-worker-1:
  ai-developer-memory:
  ai-developer-events:
  caddy-data:
  caddy-config:
```

This compose file should not contain `TARGET_REPO_PATH` or `HOST_CODEX_HOME`.

## Implementation phases

### Phase 1: URL-first repository bootstrap

Files to touch:

- `src/models/types.ts`
- `src/config.ts`
- `src/integrations/git/service.ts`
- new `src/integrations/git/workspace.ts`
- `src/app.ts`
- `src/domain/preflight.ts`
- `tests/config.test.ts`
- `tests/gitService.test.ts`
- new `tests/repositoryWorkspace.test.ts`
- `tests/worker.smoke.test.ts`

Tasks:

1. Add `REPOSITORY_WORKSPACE_ROOT` and optional `REPOSITORY_NAME`.
2. Allow `repoPath` to be derived when `GIT_REPOSITORY_URL` is set.
3. Add workspace bootstrap logic for clone/existing checkout validation.
4. Share HTTPS auth env construction between clone, fetch and push.
5. Update preflight to distinguish clone failures from repository readiness failures.
6. Add smoke test that starts from a bare remote URL and no pre-created checkout.

Acceptance criteria:

- Worker can start with only `GIT_REPOSITORY_URL`, `GIT_REPOSITORY_TOKEN`, `REPOSITORY_WORKSPACE_ROOT` and normal GitLab settings.
- A fresh `repo-workspaces` volume receives a valid clone.
- A restarted worker reuses the existing clone.
- Existing local `REPO_PATH` behavior still works.

### Phase 2: Production compose without host mounts

Files to touch:

- `compose.server.yaml`
- `deploy/Caddyfile.example`
- `docs/LOCAL_DOCKER_RUN.md`
- `docs/ENV_CONFIGURATION.md`
- `docs/CODEX_AUTH_TROUBLESHOOTING.md`
- `README.md`

Tasks:

1. Add `compose.server.yaml` with `repo-workspaces`, `codex-home`, PostgreSQL and reverse proxy volumes.
2. Remove host Codex bootstrap from the server path.
3. Keep current `compose.yaml` as local legacy/dev compose, or rename it to `compose.local.yaml`.
4. Document `.env.server` with URL-first repository settings.
5. Document one-shot commands for migrations, preflight, Codex login and first run.

Acceptance criteria:

- `docker compose -f compose.server.yaml up -d` does not require a host repository path.
- `docker compose -f compose.server.yaml run --rm worker npm run preflight` verifies clone, Codex auth, GitLab and target commands.
- Admin UI is reachable through the proxy on the configured domain.

### Phase 3: Admin auth and domain hardening

Files to touch:

- `deploy/Caddyfile.example` or `deploy/nginx.conf.example`
- `docs/OBSERVABILITY_RUNBOOK.md`
- `docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md`
- possibly `src/domain/preflight.ts`

Tasks:

1. Add reverse proxy examples for TLS and trusted headers.
2. Add preflight checks that reject public UI exposure without `TASK_TRACKER_SYSTEM_TOKEN` and `TASK_TRACKER_AGENT_TOKEN`.
3. Document role mapping for admin/operator/viewer.
4. Keep metrics internal by default.

Acceptance criteria:

- Public browser traffic never reaches the worker directly.
- UI write actions require a trusted authenticated identity.
- `/readyz` reports not-ready when startup clone/auth checks fail.

### Phase 4: Fleet and multi-repository support

Files to touch:

- `src/config.ts`
- `src/domain/lockBackend.ts`
- `src/domain/fleetOrchestrator.ts`
- `src/domain/repositoryContext.ts`
- `docs/FLEET_OPERATIONAL_RUNBOOK.md`
- fleet-related tests

Tasks:

1. Make `repositories[].gitRepositoryUrl` enough to derive checkout path.
2. Add stable `repositoryKey` or `repoPathKey` derived from repository name.
3. Change repository leases to use stable repository key, not absolute checkout path.
4. Support per-repository token env references if one global token is not enough.
5. Add smoke coverage for two repositories in one `repo-workspaces` volume.

Acceptance criteria:

- Fleet mode can manage multiple URL-configured repositories without host mounts.
- Changing checkout root does not invalidate repository memory or lease identity.
- Two profiles cannot accidentally resolve to the same checkout path unless explicitly configured.

### Phase 5: Executor/runtime strategy

Files to touch:

- `src/models/types.ts`
- `src/config.ts`
- new executor integration files
- Docker/deploy docs

Tasks:

1. Decide whether MVP production deployments extend the worker image or use separate executor images.
2. Add `executorImage` only if there is a clear isolation design.
3. Define artifact paths for validation logs and Codex raw logs outside the target checkout.
4. Document per-stack image recipes.

Acceptance criteria:

- Target repository commands run in a reproducible container environment.
- Operators do not need to install language runtimes on the server host.
- The worker image does not silently claim support for repositories whose runtime is missing.

## Operational runbook after implementation

First server setup:

1. Build or pull the production worker image.
2. Create `.env.server` with GitLab, Tracker/internal tracker, Codex and repository URL settings.
3. Start PostgreSQL.
4. Run migrations.
5. Initialize Codex auth:
   - Prefer setting `CODEX_API_KEY` as a secret, or
   - run `codex login --device-auth` into the worker-specific `codex-home` volume.
6. Run preflight.
7. Start worker and proxy.
8. Verify:
   - `https://admin.example.com/tasks`
   - `https://admin.example.com/readyz`
   - internal Prometheus scrape for `/metrics`

Routine operations:

- Rotate GitLab and Codex secrets through Docker/secret manager, then restart worker.
- Back up PostgreSQL with `pg_dump`.
- Back up `codex-home` only if OAuth mode is used and the backup is encrypted.
- Do not back up `repo-workspaces` as critical data; it can be recreated from Git.
- Monitor clone/fetch failures, Codex timeout rate, validation failure rate and queue age.

## Main risks

- Codex auth can fail silently if only an env var is checked. Add a real CLI probe for production preflight.
- Cloned repositories may require tooling not present in the base image. Treat runtime images as part of repository onboarding.
- Long-lived dirty checkouts can block work. Provide explicit maintenance/reset commands instead of automatic destructive cleanup.
- Exposing `/api` without trusted proxy auth would allow task mutation from the internet. Keep the worker private and let the proxy own browser auth.
- Multiple workers sharing one `CODEX_HOME` OAuth volume can trigger token reuse failures. Use API key auth or one auth volume per active worker.

## Recommended MVP scope

Implement these first:

1. URL-first clone into `repo-workspaces` volume for single-repository mode.
2. Server compose without `TARGET_REPO_PATH` and `HOST_CODEX_HOME`.
3. Codex production auth documentation with `CODEX_API_KEY` as the preferred path.
4. Caddy or Nginx reverse proxy example for `admin.example.com`.
5. Smoke test proving no host checkout is required.

Leave these for the next iteration:

- Dynamic repository onboarding from the UI.
- Per-repository executor containers.
- SSH deploy keys.
- Automatic GitLab project ID discovery from repository URL.
- Horizontal worker fleet with multiple Codex auth volumes.
