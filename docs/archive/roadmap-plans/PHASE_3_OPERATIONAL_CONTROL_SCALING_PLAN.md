# Phase 3 Operational Control and Scaling Plan

_Актуально на 2026-04-26._

## Цель

Перевести worker из режима одного supervised процесса для одного target repo в управляемый fleet: несколько репозиториев, безопасная координация worker instances и предсказуемый выбор задач по приоритету.

Источник: `product_roadmap.md`, раздел `Фаза 3 - Operational Control и масштабирование`.

## Результат фазы

- Worker поддерживает YAML/JSON project config с несколькими repositories.
- Старый `.env` single-repo режим остаётся совместимым как default profile.
- Каждая задача маршрутизируется в конкретный repository profile по queue/tag/component.
- Несколько worker instances не берут одну задачу и не работают одновременно в одном `repoPath`.
- Lock имеет lease/heartbeat и TTL, чтобы stale tasks возвращались в пул.
- Queue selection заменён scoring-моделью: priority, SLA/deadline, components/tags, manual override и readiness.
- Есть тесты на multi-repo routing, lock TTL и deterministic priority ordering.

## Scope

В фазу входят:

- новый config loader для fleet/project profiles;
- repository-scoped application context;
- lock abstraction с Tracker-comment backend и optional Redis/PostgreSQL backend;
- heartbeat/lease renewal;
- repo path exclusivity lock;
- priority scoring для candidate issues;
- tests и документация по запуску fleet.

В фазу не входят:

- web dashboard;
- Prometheus metrics и alerts из Phase 6;
- task routing по AI confidence из Phase 4;
- Jira/GitHub provider abstractions из Phase 7;
- auto-scaling orchestration outside Node process.

## Design Principles

- Сначала сохранить совместимость: существующие `.env` deployments не должны ломаться.
- Разделить global config и repository profile config.
- Не хранить production coordination state только в памяти процесса.
- Не делать Redis/PostgreSQL обязательными для MVP: Tracker comments остаются default lock backend.
- Все queue ordering rules должны быть deterministic и тестируемыми.

## Milestone 3.1: Multi-Repository Config

### Configuration Shape

Добавить optional переменную:

```env
WORKER_CONFIG_FILE=/workspace/worker.config.yaml
```

Первый MVP может поддержать JSON через standard library и YAML через небольшую dependency. Если dependency нежелательна, начать с JSON и оставить YAML как follow-up.

Recommended YAML shape:

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
  statusMapFile: config/trackerStatusMap.json

gitlab:
  urlEnv: GITLAB_URL
  tokenEnv: GITLAB_TOKEN

codex:
  homeEnv: CODEX_HOME
  cliCommand: codex
  timeoutSeconds: 1800

repositories:
  - name: client-application
    repoPath: /workspace/client-app
    gitlabProjectId: "42"
    gitRemoteName: origin
    baseBranch: main
    queues: ["FRONTEND"]
    tags: ["ai_dev"]
    testCommand: "npm test"
    lintCommand: "npm run lint"
    typeCheckCommand: "npm run typecheck"
    buildCommand: "npm run build"

  - name: backend-api
    repoPath: /workspace/backend
    gitlabProjectId: "43"
    gitRemoteName: origin
    baseBranch: develop
    queues: ["BACKEND"]
    tags: ["ai_dev"]
    testCommand: "go test ./..."
    lintCommand: "golangci-lint run"
```

### Data Model

Split current `AppConfig` into:

```typescript
interface GlobalWorkerConfig {
  workerId: string;
  pollIntervalMinutes: number;
  pollIntervalMs: number;
  runOnce: boolean;
  tracker: TrackerGlobalConfig;
  gitlab: GitLabGlobalConfig;
  codex: CodexGlobalConfig;
  coordination: CoordinationConfig;
  repositories: RepositoryProfile[];
}

interface RepositoryProfile {
  name: string;
  repoPath: string;
  gitlabProjectId: string;
  gitRemoteName: string;
  baseBranch: string;
  queues: string[];
  tags: string[];
  testCommand: string;
  lintCommand: string;
  typeCheckCommand?: string;
  buildCommand?: string;
  securityScanCommand?: string;
  sastCommand?: string;
  coverageCommand?: string;
  minCoveragePercent?: number;
}

interface RepositoryRuntimeConfig extends AppConfig {
  repositoryName: string;
}
```

`RepositoryRuntimeConfig` can be a compatibility bridge so existing `GitService`, `GitLabService`, `CodexRunner` and `WorkerOrchestrator` do not need a full rewrite in the first pass.

### Routing Rules

For each `TrackerIssue`, resolve candidate repository profiles by:

1. Tracker queue key matches `RepositoryProfile.queues`.
2. Required worker tag matches `RepositoryProfile.tags`.
3. Optional component-to-repo mapping if later added.
4. If more than one profile matches, select the highest score from priority queue rules.
5. If no profile matches, ignore issue and log at debug/info level.

### Application Structure

Current flow:

```text
loadConfig()
  -> buildApplication()
  -> one WorkerOrchestrator
```

Target MVP:

```text
loadFleetConfig()
  -> buildFleetApplication()
  -> one FleetOrchestrator
       -> RepositoryWorkerContext[]
```

Suggested files:

- `src/config.ts`: keep `.env` single-repo loader and add fleet loader facade.
- `src/domain/fleetOrchestrator.ts`: global polling/routing loop.
- `src/domain/repositoryContext.ts`: factory for repository-scoped services.
- `src/models/types.ts`: global config and repository profile types.

### Backward Compatibility

If `WORKER_CONFIG_FILE` is absent:

- build one `RepositoryProfile` from existing env variables;
- keep current behavior and existing tests passing;
- `TRACKER_DEFAULT_QUEUE` and `TRACKER_TAG` map to one profile.

### Acceptance Criteria

- Existing `.env` single-repo startup still works.
- `WORKER_CONFIG_FILE` with two repositories creates two repository contexts.
- Candidate issue from `FRONTEND` routes to `client-application`.
- Candidate issue from `BACKEND` routes to `backend-api`.
- Wrong or duplicate repository names fail config validation.
- Missing repo path or GitLab project id fails config validation with actionable message.

## Milestone 3.2: Stronger Worker Coordination

### Lock Model

Current lock through Tracker structured comments is enough for MVP but has no TTL. Phase 3 adds a lease contract:

```typescript
interface TaskLease {
  issueKey: string;
  workerId: string;
  repositoryName: string;
  repoPath: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  token: string;
}

interface LockBackend {
  acquireTaskLease(input: AcquireTaskLeaseInput): Promise<TaskLease | null>;
  renewTaskLease(lease: TaskLease): Promise<TaskLease>;
  releaseTaskLease(lease: TaskLease): Promise<void>;
  getActiveLease(issueKey: string): Promise<TaskLease | null>;
  acquireRepositoryLease(input: AcquireRepositoryLeaseInput): Promise<TaskLease | null>;
}
```

### Tracker Comment Backend MVP

Add structured comment prefix:

```text
AI LEASE:
```

Payload:

```json
{
  "worker": "worker-1",
  "issueKey": "FRONTEND-123",
  "repositoryName": "client-application",
  "repoPath": "/workspace/client-app",
  "acquiredAt": "2026-04-26T10:00:00.000Z",
  "expiresAt": "2026-04-26T10:15:00.000Z",
  "heartbeatAt": "2026-04-26T10:05:00.000Z",
  "token": "lease-uuid"
}
```

Rules:

- newest non-expired lease wins;
- same worker can renew its own lease;
- another worker may acquire only after `expiresAt`;
- release writes a final lease comment with `releasedAt`;
- stale `AI STATUS` comments no longer block work if lease is expired.

### Optional Production Backend

Add config:

```env
LOCK_BACKEND=tracker
LOCK_TTL_SECONDS=900
LOCK_HEARTBEAT_SECONDS=60
LOCK_REDIS_URL=
LOCK_POSTGRES_URL=
```

MVP supports only `tracker`. Redis/PostgreSQL contracts and config validation can be added with no-op unsupported errors:

- `LOCK_BACKEND=redis` fails clearly until implemented;
- same for `postgres`.

### Repository Path Exclusivity

Prevent two workers from mutating the same checkout at once:

- acquire repository lease before checkout/commit/push;
- lease key should include normalized `repoPath`;
- release after processing or on controlled failure;
- heartbeat while Codex or validation commands run.

### Heartbeat

Worker must renew leases during long operations:

- Codex analysis;
- Codex implementation/fix;
- validation gates;
- push/MR operations.

Implementation options:

- generic `withLeaseHeartbeat(lease, callback)`;
- interval renews every `LOCK_HEARTBEAT_SECONDS`;
- if renew fails, stop processing and move task to waiting/manual hold rather than pushing ambiguous changes.

### Acceptance Criteria

- Active non-expired lease blocks another worker.
- Expired lease does not block another worker.
- Worker renews lease during long-running task.
- Two issues targeting same `repoPath` do not run concurrently.
- Lease metadata survives process restart because it is stored in Tracker comments.
- Existing `AI STATUS` lock behavior remains readable for old comments but no longer the only source of truth.

## Milestone 3.3: Priority Queue

### Scoring Inputs

Replace "oldest open task wins" with deterministic scoring:

| Signal | Direction | Notes |
| --- | --- | --- |
| Tracker priority | Higher priority wins | Map Tracker values into numeric weights. |
| Deadline/SLA | Earlier deadline wins | Missing deadline gets neutral score. |
| Components | Configurable boost | Example: production blocker components. |
| Tags | Configurable boost or penalty | Example: `urgent`, `low_risk`, `needs_design`. |
| Manual override | Highest boost | Example: tag `ai_priority`. |
| Stale lease | Penalty until expired | Prevent thrashing. |
| Repository availability | Required filter | If repo lease unavailable, skip for now. |

Confidence score from Phase 4 is out of scope, but the scoring model should reserve a field for it.

### Config

Add optional scoring config:

```yaml
priorityQueue:
  manualOverrideTags: ["ai_priority"]
  priorityWeights:
    blocker: 1000
    critical: 700
    high: 400
    normal: 100
    low: 0
  tagBoosts:
    urgent: 250
    low_risk: 50
  componentBoosts:
    payments: 300
  deadlineBoost:
    dueToday: 300
    overdue: 600
  createdAtTieBreaker: oldest
```

### Tracker Model Extensions

Extend `TrackerIssue`:

```typescript
interface TrackerIssue {
  priority?: string;
  deadline?: string;
  components?: string[];
  tags?: string[];
}
```

Update `YandexTrackerClient` mapping to fill these fields when the API returns them. Missing fields should not fail issue parsing.

### Selection Algorithm

1. Fetch candidate issues per queue/profile.
2. Filter out non-open issues.
3. Filter out active leases.
4. Route issues to repository profiles.
5. Score each candidate.
6. Sort by score descending.
7. Tie-break by oldest `createdAt`.
8. Try to acquire task lease and repository lease.
9. If lease acquisition fails, try next candidate.

### Acceptance Criteria

- Higher Tracker priority beats older low-priority tasks.
- Manual override tag beats normal priority.
- Overdue task receives configured boost.
- Sorting is stable and deterministic.
- If top candidate lease acquisition fails, worker attempts the next candidate.
- Missing priority/deadline/components/tags does not crash selection.

## Migration Plan

1. Add new config types and bridge old `.env` into one repository profile.
2. Add tests proving old config output is equivalent to current `AppConfig`.
3. Introduce `FleetOrchestrator` while keeping `WorkerOrchestrator` repository-scoped.
4. Add Tracker lease backend but keep old structured status parsing as fallback.
5. Add repository path lease.
6. Replace candidate sorting with priority queue scoring.
7. Document fleet config and operational runbook.

## Testing Plan

Add or update:

- `tests/config.test.ts`: fleet config parsing, duplicate repository names, `.env` compatibility.
- `tests/orchestrator.test.ts`: repository routing and lease-aware selection.
- `tests/commentProtocol.test.ts`: `AI LEASE` parse/format and expiration rules.
- `tests/trackerClient.test.ts`: priority/deadline/components/tags mapping.
- `tests/worker.smoke.test.ts`: two mock repositories and deterministic task selection.
- New `tests/priorityQueue.test.ts`: scoring and tie-breaks.
- New `tests/lockBackend.test.ts`: acquire, renew, release, expired lease behavior.

## Verification

Minimum commands:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

Manual scenarios:

1. Start with old `.env`; worker behaves as single-repo worker.
2. Start with two-repo config; `FRONTEND` task goes to frontend repo and `BACKEND` task goes to backend repo.
3. Start two worker processes; only one acquires a task lease.
4. Simulate stale lease by setting expired `AI LEASE`; another worker can take the task.
5. Create two eligible tasks with different priority; higher score wins.

## Risks

| Risk | Mitigation |
| --- | --- |
| Multi-repo config forces large rewrite | Keep `WorkerOrchestrator` repository-scoped and add `FleetOrchestrator` above it. |
| Tracker-comment leases are eventually consistent | Use tokenized lease payloads, short heartbeat interval and retry next candidate on conflict. |
| Two workers mutate same checkout | Add repository path lease before git operations. |
| YAML dependency adds supply-chain surface | Start with JSON if dependency policy is strict; YAML can be optional. |
| Priority scoring becomes opaque | Log candidate score breakdown and cover scoring with focused tests. |
| Existing deployments break on config changes | Treat `WORKER_CONFIG_FILE` as opt-in and keep old env parsing path. |

## Definition of Done

- Fleet config can run multiple repository profiles from one worker process.
- Existing single-repo `.env` mode remains supported and tested.
- Task and repository leases prevent duplicate work under concurrent workers.
- Expired leases allow automatic recovery without manual cleanup.
- Priority queue scoring replaces oldest-task-only selection.
- Documentation includes a fleet config example and operational caveats.
- Roadmap items `3.1`, `3.2` and `3.3` can be marked as completed or MVP-completed.
