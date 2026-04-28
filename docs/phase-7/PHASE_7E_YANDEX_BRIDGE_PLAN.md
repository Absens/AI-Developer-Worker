# Phase 7E - Yandex Bridge Plan

## Goal

Keep Yandex Tracker as an optional external source and mirror while the internal
AI Task Tracker remains the canonical runtime state store.

Workers must not receive Yandex issues directly in this mode. The bridge imports
or updates internal tasks, and workers operate on internal `taskId` values.

## What Is In Scope

- Define `ExternalTaskSource`.
- Import Yandex issues into internal tasks.
- Create `TaskRevision` when relevant Yandex fields change.
- Store raw Yandex snapshot for diagnostics.
- Export compact digest comments to Yandex.
- Sync status from internal task status to Yandex logical status.
- Import human comments.
- Import `/resume`, `/skip`, `/cancel`.
- Import direct answer to the latest AI question.
- Maintain sync cursors.
- Keep current Yandex direct mode as fallback.

## What Is Out Of Scope

- Jira, GitHub Issues, Linear, or YouTrack providers.
- Mirroring the full internal technical timeline to Yandex.
- Writing `AI LEASE` comments in internal mode.
- Replacing GitLab review as the review source of truth.
- Human UI beyond what previous phases already provide.

## Current Code To Touch

- `src/integrations/tracker/client.ts`
- `src/integrations/tracker/commentProtocol.ts`
- New `src/integrations/yandexBridge/` modules.
- `src/models/types.ts`
- `src/config.ts`
- Tests in `tests/trackerClient.test.ts`, `tests/commentProtocol.test.ts`, and
  new bridge tests.

## New Types And API

```typescript
export interface ExternalTaskSource {
  importCandidates(input: ImportCandidatesInput): Promise<ExternalIssueSnapshot[]>;
  exportDigest(input: ExportDigestInput): Promise<void>;
  transitionExternal(input: ExternalTransitionInput): Promise<void>;
}
```

Add:

- `ExternalIssueSnapshot`;
- `ExportDigestInput`;
- `ExternalTransitionInput`;
- `SyncCursor`;
- `ImportedHumanCommand`;
- `ExternalFieldOwnership`.

## Import Rules

Import should be idempotent by:

```text
(provider, externalKey)
```

For Yandex:

- `provider = yandex_tracker`;
- `externalKey = issue.key`;
- raw payload is stored for diagnostics;
- title, description, priority, deadline, tags, components, queue and status are
  mapped into internal task fields or revisions;
- changed human input creates a `TaskRevision`;
- significant changes set `requiresReanalysis=true`.

The bridge should not directly rewrite active execution state. It should record
the new revision and mark the task as context-changed for internal handling.

## Export Rules

Export compact digest events only:

- task started;
- AI question;
- MR ready;
- failed with compact diagnostic;
- done;
- decomposition summary and external child links if mirroring is enabled.

Do not export:

- internal lease events;
- every heartbeat;
- full agent logs;
- every low-level timeline event.

## Status Sync

Suggested mapping:

| Internal status | Yandex logical status |
| --- | --- |
| `ready` | `in_progress` or no transition until claim, configurable |
| `claimed` | `in_progress` |
| `analyzing` | `in_progress` |
| `implementing` | `in_progress` |
| `validating` | `in_progress` |
| `fixing_review` | `in_progress` |
| `awaiting_human` | `waiting_for_answer` |
| `review` | `review` |
| `done` | `done` |
| `failed` | `failed` |
| `blocked` | `open` or `waiting_for_answer`, configurable |
| `cancelled` | `failed` or external-specific cancelled status |

Status sync must be idempotent and write an internal audit event with the
external transition result.

## Command Import Rules

Yandex comments can become internal protocol messages:

- `/resume` -> `HumanCommand.resume`;
- `/skip` -> `HumanCommand.skip`;
- `/cancel` -> `HumanCommand.cancel`;
- human text after the latest AI question -> `HumanAnswer`;
- normal comment -> human discussion comment.

The bridge must avoid importing its own digest comments as human commands.

## Implementation Order

1. Define `ExternalTaskSource` and Yandex bridge types.
2. Add sync cursor storage.
3. Implement idempotent import.
4. Implement revision creation for changed Yandex input.
5. Implement command/comment import.
6. Implement digest export.
7. Implement status sync.
8. Add bridge tests.
9. Add smoke path:
   `mock Yandex -> internal tracker -> worker -> mock GitLab -> Yandex digest`.

## Tests

Add tests for:

- repeated import does not create duplicate tasks;
- changed Yandex description creates a revision;
- changed Yandex priority/deadline/tags update derived fields;
- `/resume` comment imports as an internal command;
- bridge ignores its own digest comments;
- digest export is idempotent;
- status sync writes expected Yandex transition;
- Yandex direct mode still passes current tests.

## Acceptance Criteria

- In `yandex_integration` mode, workers operate on internal tasks only.
- Yandex issue remains visible and receives compact status/comment digests.
- No `AI LEASE` comments are required in Yandex for internal mode.
- Human answer can come from internal UI/API or Yandex comment.
- Current direct Yandex fallback remains available.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run test:smoke` passes or a bridge smoke equivalent passes.

## Rollback And Fallback

Use:

```env
TASK_TRACKER_PROVIDER=yandex
```

to return to direct Yandex behavior.

Disable bridge with:

```env
YANDEX_SYNC_ENABLED=false
```

for standalone/internal deployments.

## Open Questions

- How exactly should `requiresReanalysis` be computed?
- Should Yandex `ready` transition happen on internal `ready` or only after
  worker claim?
- How should deleted or moved Yandex issues be represented internally?
- Should imported comments preserve Yandex author ids or display names?
- What is the retry/backoff policy for failed digest export?

## Suggested Codex Task

```text
Implement Phase 7E from docs/phase-7/PHASE_7E_YANDEX_BRIDGE_PLAN.md.
Add the optional Yandex bridge so Yandex is a source/mirror, not the worker
runtime store. Keep Yandex direct mode as fallback.
```

