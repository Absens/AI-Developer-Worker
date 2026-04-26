# Fleet Operational Runbook

Phase 3 adds opt-in fleet mode through `WORKER_CONFIG_FILE`. When the variable is absent, the worker keeps the legacy single-repository `.env` profile.

## Minimal YAML Config

```yaml
worker:
  id: worker-1
  pollIntervalMinutes: 10
  runOnce: false

tracker:
  tokenEnv: TRACKER_TOKEN
  orgIdEnv: TRACKER_ORG_ID
  orgHeader: X-Cloud-Org-ID
  apiBaseUrl: https://api.tracker.yandex.net/v3
  statusMapFile: config/trackerStatusMap.example.json

gitlab:
  urlEnv: GITLAB_URL
  tokenEnv: GITLAB_TOKEN

codex:
  homeEnv: CODEX_HOME
  cliCommand: codex
  timeoutSeconds: 1800

coordination:
  lockBackend: tracker
  ttlSeconds: 900
  heartbeatSeconds: 60

priorityQueue:
  manualOverrideTags: [ai_priority]
  priorityWeights:
    blocker: 1000
    critical: 700
    high: 400
    normal: 100
    low: 0
  tagBoosts:
    urgent: 250
  componentBoosts:
    payments: 300
  deadlineBoost:
    dueToday: 300
    overdue: 600
  createdAtTieBreaker: oldest

repositories:
  - name: client-application
    repoPath: /workspace/client-app
    gitlabProjectId: "42"
    gitRemoteName: origin
    baseBranch: main
    queues: [FRONTEND]
    tags: [ai_dev]
    testCommand: npm test
    lintCommand: npm run lint
    typeCheckCommand: npm run typecheck
    buildCommand: npm run build

  - name: backend-api
    repoPath: /workspace/backend
    gitlabProjectId: "43"
    gitRemoteName: origin
    baseBranch: develop
    queues: [BACKEND]
    tags: [ai_dev]
    testCommand: go test ./...
    lintCommand: golangci-lint run
```

Start with:

```bash
WORKER_CONFIG_FILE=/workspace/worker.config.yaml npm run dev
```

PowerShell:

```powershell
$env:WORKER_CONFIG_FILE = "C:\workspace\worker.config.yaml"
npm run dev
```

## Routing

The fleet orchestrator fetches candidates for every repository `queues` and `tags` pair. A Tracker issue routes to a repository when its queue key matches the profile and, when returned by Tracker, its tags intersect the profile tags.

If more than one eligible issue exists, selection uses deterministic scoring:

- Tracker priority weight.
- Deadline boost for overdue or due-today issues.
- Configured tag and component boosts.
- Manual override tags such as `ai_priority`.
- Oldest `createdAt` tie-break by default.

If the highest-scored candidate cannot acquire a lease, the worker tries the next candidate in the sorted list.

## Coordination

The MVP lock backend is Tracker comments. Each active task writes structured `AI LEASE:` comments with:

- task lease for the issue key;
- repository lease keyed by normalized `repoPath`;
- `expiresAt`, `heartbeatAt`, worker id, repository name, and token.

Defaults:

```env
LOCK_BACKEND=tracker
LOCK_TTL_SECONDS=900
LOCK_HEARTBEAT_SECONDS=60
```

`LOCK_BACKEND=redis` and `LOCK_BACKEND=postgres` are reserved and fail fast until those backends are implemented.

## Operational Caveats

- Use a unique `worker.id` or `WORKER_ID` per running process.
- Use one stable `repoPath` per checkout. If two profiles intentionally point at the same checkout, the repository lease serializes work.
- Tracker comment locks are durable across process restarts, but not a strongly atomic distributed transaction. Keep TTL short enough for recovery and heartbeat shorter than TTL.
- Expired `AI LEASE:` comments do not block acquisition. Released lease comments make the latest lease inactive immediately.
- Legacy `AI STATUS:` comments remain readable in single-repository orchestration, but fleet scheduling uses leases as the coordination source.

## Validation

Recommended checks after changing fleet config:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```
