# Phase 7G - AI Proposals Plan

## Goal

Add controlled AI-created task proposals after the internal tracker runtime is
stable.

AI should be able to propose useful work with evidence, but proposed work must
not enter the executable queue without approval or an explicit low-risk policy.

## What Is In Scope

- `proposeTask`.
- Proposal metadata.
- Evidence refs.
- Duplicate detection.
- Approval and rejection workflow.
- `supervisorStatus` and `approvalPolicy` fields for proposal lifecycle.
- Autonomy policy evaluator.
- Global kill switch.
- Per-repository autonomy limits.
- Per-task-type allowlist.
- Daily/window proposal limits.
- Cleanup for stale or rejected proposals.
- Proposal review view or API if Phase 7F UI exists.
- Policy decision audit event for every proposal, approval, rejection, and
  auto-approval.

## What Is Out Of Scope

- Enabling broad autonomous execution by default.
- Autonomous high-risk tasks.
- Autonomous security, auth, payments, DB migrations, public API changes,
  broad refactors, or multi-repository changes.
- Replacing human product planning.

## Current Code To Touch

- `src/domain/taskTracker/`
- `src/domain/analysisDecision.ts`
- `src/domain/memoryStore.ts` if memory findings become evidence.
- `src/observability/` if repeated failures become proposal signals.
- `src/config.ts`
- UI/API modules from Phase 7F if present.
- Tests for policy and proposal behavior.

## New Types And API

```typescript
export type AutonomyLevel =
  | "proposal_only"
  | "auto_triage"
  | "auto_execute_low_risk";

export interface EvidenceRef {
  kind:
    | "validation_failure"
    | "review_comment"
    | "ci_run"
    | "security_finding"
    | "memory_entry"
    | "file"
    | "metric"
    | "external_url";
  ref: string;
  summary?: string;
}

export interface ProposeTaskInput {
  source: "ai_proposal";
  proposedBy: string;
  repositoryName: string;
  title: string;
  description: string;
  proposalReason: string;
  evidenceRefs: EvidenceRef[];
  suggestedAcceptanceCriteria: string[];
  taskType?: string;
  promptProfileId?: string;
  riskFactors?: string[];
  expectedBlastRadius?: string;
  autonomyLevel: AutonomyLevel;
  approvalPolicy?: string;
  idempotencyKey?: string;
}
```

Extend `TaskTrackerClient` with:

```typescript
proposeTask(input: ProposeTaskInput): Promise<TaskRecord>;
approveProposal(taskId: string, input: ApproveProposalInput): Promise<void>;
rejectProposal(taskId: string, input: RejectProposalInput): Promise<void>;
```

Proposal records must preserve:

- `supervisorStatus`: `proposed`, `approved`, `rejected`, `auto_approved`;
- `approvalPolicy`;
- policy evaluation result and reason;
- stale/rejected cleanup owner;
- evidence refs as artifact refs or external refs, not raw secret-bearing logs.

## Storage Shape

Add or activate persisted storage for:

- `task_proposals`;
- proposal evidence refs;
- proposal duplicate signatures;
- autonomy policy evaluations;
- proposal rate-limit windows;
- stale/rejected proposal cleanup metadata.

## Default Policy

Initial production default:

```text
auto_execute_low_risk = disabled globally
```

Allowed only by explicit repository policy for:

- documentation;
- tests-only changes without production code;
- small dependency patch/minor updates;
- flaky test fixes;
- formatting/lint-only fixes.

Always disabled for:

- security-sensitive code;
- authentication;
- payments;
- database migrations;
- public API changes;
- broad refactors;
- multi-repository changes.

## Proposal Sources

Start with a small set:

1. repeated validation failures;
2. repeated review comments;
3. flaky tests;
4. dependency updates;
5. memory findings.

Security scanner and observability alerts can be added later if the policy model
is stable.

## Implementation Order

1. Add proposal schema and types.
2. Add global kill switch config.
3. Add repository autonomy policy config.
4. Implement `proposeTask`.
5. Implement duplicate detection.
6. Implement approval and rejection.
7. Record policy decision audit events.
8. Ensure proposals do not enter executable queue unless approved or explicitly
   auto-approved by policy.
9. Add proposal list/review API and UI if Phase 7F exists.
10. Add tests.

## Duplicate Detection

Minimum duplicate signals:

- same repository;
- similar normalized title;
- same evidence ref;
- same dependency package and target version for dependency updates;
- same failing test id for flaky test proposals;
- existing non-terminal proposal/task with matching signature.

Duplicate detection should block or merge proposals before creating executable
work.

## Tests

Add tests for:

- proposal is created in `triage` or `proposed` state;
- proposal does not enter claim queue by default;
- approval moves proposal to executable path;
- rejection prevents execution;
- every proposal, approval, rejection, and auto-approval writes a policy audit
  event;
- global kill switch blocks new proposals;
- duplicate proposal is rejected or merged;
- `auto_execute_low_risk` works only when repository policy allows it;
- high-risk task types are never auto-approved.

## Acceptance Criteria

- AI can create proposal tasks with evidence refs.
- Proposed tasks do not enter executable queue without approval or explicit
  low-risk policy.
- Duplicate proposals are controlled.
- Every approval/rejection is audited.
- Every policy decision is stored with evidence refs and reason.
- Global kill switch disables proposals and auto-execution.
- Policy prevents high-risk autonomous work.
- `npm run typecheck` passes.
- `npm test` passes.

## Rollback And Fallback

Disable with:

```env
AI_PROPOSALS_ENABLED=false
AUTO_EXECUTE_LOW_RISK_ENABLED=false
```

Existing human-created and Yandex-imported tasks should continue to work.

## Open Questions

- Which proposal source should be implemented first?
- Should rejected proposals be retained forever, retained for a fixed period, or
  compacted into audit summaries?
- Should approval be per task, per repository policy, or both?
- What similarity threshold is acceptable for duplicate detection?
- Should proposal evidence include raw logs, redacted summaries, or artifact
  references only?

## Suggested Codex Task

```text
Implement Phase 7G from docs/phase-7/PHASE_7G_AI_PROPOSALS_PLAN.md.
Add AI proposal creation, policy controls, duplicate detection, and approval
workflow. Keep auto-execution disabled by default.
```
