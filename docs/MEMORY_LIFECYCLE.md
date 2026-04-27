# Memory Lifecycle Runbook

Phase 5 memory is a local, file-backed repository knowledge store. It is disabled by default and is advisory when enabled: current Tracker instructions, current repository files, and fresh human comments remain authoritative.

## Storage Layout

Set `MEMORY_DIR` to a writable directory outside the target repository:

```env
MEMORY_ENABLED=true
MEMORY_DIR=/workspace/ai-developer-memory
```

The worker stores one directory per sanitized `RepositoryProfile.name`:

```text
MEMORY_DIR/
  repositories/
    client-application/
      metadata.json
      knowledge.json
      prompt-rules.json
      failures.jsonl
      review-learning.jsonl
```

The repository key is based on the profile name, not `repoPath`, so memory survives checkout path changes. Fleet startup rejects repository names that normalize to the same key.

## Validation

Run:

```bash
npm run memory:validate
```

The command checks JSON schemas, JSONL rows, duplicate prompt rule IDs, and prompt rule `sourceEntryIds`. It does not require Tracker or GitLab credentials.

Runtime behavior:

- `MEMORY_STRICT=false` disables memory for only the corrupted repository and logs `WARN`.
- `MEMORY_STRICT=true` fails task processing when memory is invalid.

## Manual Knowledge And Rules

`knowledge.json` contains structured sections such as architecture map, entry points, code patterns, test strategy, known pitfalls, and conventions. Add only concise, durable repository facts.

`prompt-rules.json` contains manual or learned rules. Only `approved` rules affect prompts by default:

```json
[
  {
    "id": "rule-ui-tests",
    "repositoryName": "client-application",
    "title": "Keep UI test scope focused",
    "instruction": "When changing a shared component, update the focused component test before broad snapshots.",
    "taskTypes": ["frontend_ui_fix"],
    "promptProfileIds": ["frontend_ui_fix"],
    "sourceEntryIds": [],
    "confidence": 85,
    "approvalState": "approved",
    "createdAt": "2026-04-27T00:00:00.000Z",
    "updatedAt": "2026-04-27T00:00:00.000Z"
  }
]
```

Set `MEMORY_INCLUDE_DRAFT_RULES=true` only for controlled experiments. Draft rules are otherwise ignored.

## Failure Memory

When implementation validation still fails after automated fix attempts are exhausted, the worker appends a compact entry to `failures.jsonl`. Future analysis and implementation prompts include similar failures only when repository, task type, and prompt profile match.

## Cleanup

To reset memory for one repository, stop the worker and remove that repository directory under `MEMORY_DIR/repositories/`. To clear only repeated failure hints, truncate `failures.jsonl` and keep `knowledge.json` plus approved `prompt-rules.json`.
