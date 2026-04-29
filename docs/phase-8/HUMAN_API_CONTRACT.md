# Phase 8 Human API Contract

This document is the contract between the Angular console and the existing
Node.js human task API. Phase plans may add fields, but frontend code should not
consume backend internals directly or infer response shapes from raw
`TaskRecord`.

## Baseline Paths

Use these defaults unless a deployment overrides them through environment
configuration:

| Purpose | Default |
| --- | --- |
| Angular app route | `/tasks` |
| Human JSON API prefix | `/api` |
| Angular workspace | `web/` |
| Angular app name | `task-tracker-console` |
| Built static directory | `web/dist/task-tracker-console/browser` |
| Angular asset route | `/tasks/assets` |

In development, the Angular dev server should proxy `/api` to the existing
Node.js observability server. In production, the Node.js server remains the API
and static asset host.

Phase 8A static serving is enabled by `TASK_TRACKER_UI_STATIC_DIR`. When it is
set, the Node.js server validates the directory at startup, serves Angular files
under `/tasks`, serves assets under `/tasks/assets`, and falls back to
`index.html` for Angular deep links. `/api/...`, `/metrics`, `/healthz`, and
`/readyz` keep route precedence. During Phase 8A only, if
`TASK_TRACKER_UI_ENABLED=true` and no static directory is configured, `/tasks`
serves the old embedded HTML UI as a temporary compatibility fallback.

## Auth Contract

The backend is always the security boundary. The frontend may hide or disable
controls, but every mutation must still be rejected by backend role checks when
the caller is not authorized.

Supported roles:

| Role | Intended UI capability |
| --- | --- |
| `viewer` | Read queues, task detail, proposals, and operations. |
| `developer` | Create/update tasks, answer questions, resume, cancel, approve/reject proposals, approve decomposition mirroring. |
| `operator` | Developer capabilities plus hold, retry, force reanalysis, and operations actions. |
| `admin` | All current capabilities and future admin-only controls. |

Supported auth modes:

| Mode | Browser behavior |
| --- | --- |
| `trusted_proxy` | Browser requests carry trusted user/role headers injected by a reverse proxy. |
| `bearer` | Intended for scripts, service clients, or reverse proxies that inject `Authorization`; do not add an in-app token entry field in Phase 8. |
| `localhost` | Development-only mode; loopback requests can act as admin. |

The Angular app must bootstrap auth state from:

```text
GET /api/session
```

Minimum response:

```typescript
export interface SessionDto {
  user: {
    id: string;
    displayName?: string;
    service: "human" | "system" | "agent" | "localhost" | "anonymous";
  };
  role: "viewer" | "developer" | "operator" | "admin";
  authMode: "trusted_proxy" | "bearer" | "localhost";
  capabilities: Record<string, boolean>;
  apiPath: string;
  uiPath: string;
  generatedAt: string;
}
```

At minimum, `capabilities` must include:

```text
canReadTasks
canCreateTask
canUpdateTask
canAnswer
canResume
canCancel
canHold
canRetry
canForceReanalysis
canApproveProposal
canRejectProposal
canApproveDecomposition
canReadOperations
canCreateSystemTask
```

## Standard Error Shape

All human API errors consumed by Angular should use:

```typescript
export interface ApiErrorDto {
  status: "error";
  error: string;
  details?: unknown;
}
```

Responses must use `cache-control: no-store` for JSON API routes. The UI should
render the `error` field and avoid exposing raw `details` unless a future admin
diagnostic view explicitly allows it.

## Endpoint Matrix

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/session` | viewer | Bootstrap current user, role, paths, and capabilities. |
| `GET` | `/api/tasks` | viewer | List tasks with filters. |
| `POST` | `/api/tasks` | developer or admin system token | Create human or system task. |
| `POST` | `/api/tasks:bulk-create` | admin system token | Bulk-create system tasks. |
| `GET` | `/api/tasks/{taskId}` | viewer | Task detail. |
| `GET` | `/api/tasks/{taskId}/events` | viewer | Task lifecycle events. |
| `GET` | `/api/tasks/{taskId}/comments` | viewer | Comments, questions, and answers. |
| `GET` | `/api/tasks/{taskId}/agent-context-preview` | viewer | Agent context preview. |
| `POST` | `/api/tasks/{taskId}/revisions` | developer | Human task revision. |
| `POST` | `/api/tasks/{taskId}/attachments` | developer | Register attachment/link metadata. |
| `POST` | `/api/tasks/{taskId}/answers` | developer | Record human answer, optionally with resume command. |
| `POST` | `/api/tasks/{taskId}/commands/mark-ready` | developer | Mark task ready. |
| `POST` | `/api/tasks/{taskId}/commands/resume` | developer | Resume task by moving it to ready. |
| `POST` | `/api/tasks/{taskId}/commands/cancel` | developer | Cancel task. |
| `POST` | `/api/tasks/{taskId}/commands/approve-decomposition` | developer | Approve child mirroring decision. |
| `POST` | `/api/tasks/{taskId}/commands/approve-proposal` | developer | Approve AI proposal. |
| `POST` | `/api/tasks/{taskId}/commands/reject-proposal` | developer | Reject AI proposal. |
| `POST` | `/api/tasks/{taskId}/commands/hold` | operator | Put task on hold. |
| `POST` | `/api/tasks/{taskId}/commands/retry` | operator | Queue failed/blocked work for retry. |
| `POST` | `/api/tasks/{taskId}/commands/force-reanalysis` | operator | Record manual reanalysis request. |
| `GET` | `/api/proposals` | viewer | List AI proposals. |
| `POST` | `/api/proposals` | operator | Create AI proposal through API. |
| `GET` | `/api/operations` | viewer | Operations snapshot. |

## List Tasks

Request:

```text
GET /api/tasks?status=ready&status=failed&repository=developer&queue=DEV&priority=normal&worker=worker-1&tag=ai_dev&limit=100
```

Response:

```typescript
export interface TaskListResponseDto {
  tasks: TaskSummaryDto[];
  role: SessionDto["role"];
  generatedAt: string;
}

export interface TaskSummaryDto {
  id: string;
  title: string;
  status: TaskStatusDto;
  repositoryName?: string;
  repoPathKey?: string;
  queue?: string;
  priority?: string;
  activeWorker?: string;
  blockerReason?: string;
  latestAiSummary?: string;
  latestValidationSummary?: string;
  mergeRequestUrl?: string;
  branch?: string;
  tags?: string[];
  updatedAt: string;
}
```

`TaskStatusDto` is:

```text
new
triage
ready
claimed
analyzing
awaiting_human
decomposing
implementing
validating
review
fixing_review
blocked
done
failed
cancelled
```

## Create Task

Human task creation request:

```typescript
export interface CreateTaskRequestDto {
  title: string;
  description: string;
  humanSummary?: string;
  repositoryName?: string;
  repoPathKey?: string;
  baseBranch?: string;
  queue?: string;
  priority?: string;
  tags?: string[];
  components?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  riskFactors?: string[];
  missingContext?: string[];
  taskType?:
    | "frontend_ui_fix"
    | "backend_endpoint"
    | "tests_only"
    | "refactor"
    | "dependency_update"
    | "documentation";
  promptProfileId?: string;
  status?: TaskStatusDto;
  idempotencyKey?: string;
}

export interface CreateTaskResponseDto {
  task: TaskDetailDto;
  idempotent: boolean;
}
```

For human-created drafts, omit `status` and let the backend create the default
draft status. For "create ready", send `status: "ready"` after client-side
validation passes. System task creation with `idempotencyKey` requires the
configured system token and should not be exposed as a normal browser workflow.

## Task Detail

Response:

```typescript
export interface TaskDetailResponseDto {
  task: TaskDetailDto;
  summary: TaskSummaryDto;
  activeLeases: LeaseDto[];
  children: ChildTaskSummaryDto[];
  latestValidation?: ValidationSummaryDto;
  latestMergeRequest?: MergeRequestSummaryDto;
  diagnostics: TaskDiagnosticsDto;
}
```

The backend may still include a raw-compatible `task` payload during early
Phase 8 work, but Angular services must map it into a bounded `TaskDetailDto`
before components render it.

`TaskDetailDto` must include only fields required by the UI:

```typescript
export interface TaskDetailDto extends TaskSummaryDto {
  description: string;
  humanSummary?: string;
  acceptanceCriteria: string[];
  constraints: string[];
  riskFactors: string[];
  missingContext: string[];
  baseBranch?: string;
  businessStatus?: string;
  createdAt: string;
  createdBy?: ActorDto;
  clarificationQuestions: ClarificationQuestionDto[];
  humanAnswers: HumanAnswerDto[];
  comments: TaskCommentDto[];
  events: TimelineEventDto[];
}
```

Shared DTO minimums:

```typescript
export interface ActorDto {
  owner: string;
  id: string;
  displayName?: string;
}

export interface LeaseDto {
  id: string;
  kind: string;
  taskId?: string;
  repositoryName?: string;
  workerId: string;
  expiresAt: string;
  heartbeatAt?: string;
  releasedAt?: string;
}

export interface ValidationSummaryDto {
  id?: string;
  workerId?: string;
  status: string;
  summary?: string;
  diagnostic?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface MergeRequestSummaryDto {
  id?: string | number;
  iid?: string | number;
  url?: string;
  title?: string;
  branch?: string;
  sourceBranch?: string;
  targetBranch?: string;
  outcome?: string;
  createdAt: string;
}

export interface ClarificationQuestionDto {
  id: string;
  summary?: string;
  blockingReason?: string;
  question: string;
  options?: string[];
  resumeHint?: string;
  createdAt: string;
}

export interface HumanAnswerDto {
  id: string;
  questionId?: string;
  author?: ActorDto;
  body: string;
  command?: unknown;
  createdAt: string;
}

export interface TaskCommentDto {
  id: string;
  author?: ActorDto;
  body: string;
  createdAt: string;
}

export interface TimelineEventDto {
  id?: string;
  kind: string;
  source?: string;
  actor?: ActorDto;
  message?: string;
  createdAt: string;
}

export interface ChildTaskSummaryDto extends TaskSummaryDto {
  dependencyReason?: string;
  externalMirrorStatus?: "mirrored" | "internal_only" | string;
}

export interface TaskDiagnosticsDto {
  latestFailure?: unknown;
  failedRuns?: unknown[];
  repeatedValidationFailures: number;
}
```

## Commands

Use this matrix for button visibility, disabled states, confirmations, and
tests. Backend transition validation remains authoritative.

| Command | Min role | UI statuses | Reason required in UI | Expected effect |
| --- | --- | --- | --- | --- |
| `mark-ready` | developer | `new`, `triage`, `blocked` | recommended | Task becomes `ready`. |
| `resume` | developer | `awaiting_human`, `blocked` | recommended | Task becomes `ready`. |
| `cancel` | developer | any non-terminal status | yes | Task becomes `cancelled` where transition is valid. |
| `approve-decomposition` | developer | parent task with child tasks | yes | Manual decision records child mirroring approval. |
| `approve-proposal` | developer | proposal with `supervisorStatus=proposed` | yes | Proposal becomes approved; task becomes executable when policy allows. |
| `reject-proposal` | developer | proposal with `supervisorStatus=proposed` | yes | Proposal becomes rejected. |
| `hold` | operator | `ready`, `claimed`, `analyzing`, `awaiting_human`, `implementing`, `validating`, `review` | yes | Task becomes `blocked` where transition is valid. |
| `retry` | operator | `failed`, `blocked` | yes | Task becomes `ready` where transition is valid. |
| `force-reanalysis` | operator | any non-terminal status | yes | Records a manual reanalysis request; it is not a guaranteed restart by itself. |

Terminal statuses are `done` and `cancelled`.

Command response:

```typescript
export interface CommandResponseDto {
  task: TaskDetailDto;
}
```

If the backend still returns a raw-compatible task record, Angular services must
map it into the same bounded DTO used by task detail components.

## Proposals

Response:

```typescript
export interface ProposalListResponseDto {
  proposals: ProposalSummaryDto[];
  role: SessionDto["role"];
  generatedAt: string;
}

export interface ProposalSummaryDto extends TaskSummaryDto {
  proposal: {
    supervisorStatus: "proposed" | "approved" | "rejected" | string;
    approvalPolicy?: string;
    autonomyLevel?: string;
    proposedBy?: string;
    proposalReason?: string;
    policyDecision?: string;
    policyReason?: string;
    evidenceRefs?: EvidenceRefDto[];
    createdAt: string;
  };
}

export interface EvidenceRefDto {
  kind: string;
  ref: string;
  summary?: string;
}
```

Approve/reject visibility must use `proposal.supervisorStatus`, not task status
alone.

## Operations Snapshot

Response:

```typescript
export interface OperationsSnapshotDto {
  workers: WorkerSnapshotDto[];
  leases: LeaseDto[];
  repositories: string[];
  queueDepth: QueueDepthDto[];
  failedTasks: TaskSummaryDto[];
  repeatedFailures: TaskSummaryDto[];
  waitingForHuman: TaskSummaryDto[];
  generatedAt: string;
}
```

Repeated failure grouping should be backend-owned. If the backend does not yet
provide a richer repeated-failure DTO, the UI may render the task summaries but
must not derive secret-bearing diagnostics from raw logs.

## Display Safety

Angular components must render allowlisted fields, not arbitrary JSON dumps.
Rules:

- truncate long diagnostic text in list/table views;
- render agent context preview in a dialog or panel with a visible max height;
- never show secret-bearing raw environment, tokens, or full command output;
- prefer links to task detail over expanding large nested payloads in tables;
- keep redaction on the backend even when the UI hides fields.

## Canonical Test Fixture Set

Frontend tests, E2E tests, and backend contract tests should reuse a shared
fixture shape with:

- one `ready` task;
- one `new` draft task;
- one `awaiting_human` task with a clarification question;
- one `failed` task with a failed agent run and validation diagnostic;
- one task with latest validation and merge request summaries;
- one AI proposal in `proposed` supervisor state;
- one parent task with a child dependency;
- one active worker and one active task lease;
- at least one viewer, developer, operator, and admin auth case.

Fixtures must avoid real secrets and external service credentials.
