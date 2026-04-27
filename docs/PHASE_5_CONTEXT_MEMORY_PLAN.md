# Phase 5 Context and Memory Plan

_Актуально на 2026-04-27._

## Цель

Перестать начинать каждую задачу с нуля: дать worker repository-specific knowledge base, собирать dynamic prompt из правил проекта, профиля задачи, прошлых ошибок и релевантной памяти, а затем отдельно добавить извлечение устойчивых уроков из review/merge feedback.

Источник: `product_roadmap.md`, раздел `Фаза 5 - Context и Memory`.

## Результат фазы

- Для каждого repository profile есть структурированная knowledge base: architecture map, entry points, code patterns, test strategy, known pitfalls и conventions.
- MVP: analysis и implementation prompts получают ограниченный memory context bundle; fix, review-fix и decomposition подключаются после стабилизации MVP.
- MVP: worker записывает failure memory для проваленных validation/fix paths.
- Post-MVP: worker умеет обновлять memory после merge: сравнивает исходный worker diff, финальный merge diff и review feedback.
- Post-MVP: reviewer preferences сохраняются как draft или approved rules, не смешиваясь с одноразовыми замечаниями.
- Dynamic prompt собирается из `AGENTS.md`, `CONTRIBUTING.md`, `.editorconfig`, task type, repo profile, prompt profile, knowledge base и прошлых похожих failures.
- Memory хранится вне target repo по умолчанию и не коммитит project knowledge в пользовательский код без явного решения.

## Scope

В фазу входят:

- file-backed `MemoryStore` с per-repository structured files;
- bootstrap/generation knowledge base из target repo docs и lightweight repository scan;
- memory context retrieval без embeddings;
- failure memory для повторяющихся validation/Codex/decomposition ошибок;
- post-MVP review learning после merge;
- dynamic prompt assembly layer над `src/domain/promptBuilder.ts`;
- config, tests и runbook для memory lifecycle.

В фазу не входят:

- embeddings/RAG индекс по файлам и символам из Phase 8;
- web UI для редактирования memory;
- автоматическое изменение `AGENTS.md` в target repo;
- cross-company/shared memory между разными installations;
- обучение модели или fine-tuning.

## Recommended MVP Cut For Next Session

Начинать новую сессию нужно не со всего Phase 5, а с узкого MVP:

1. Add memory config with `MEMORY_ENABLED=false` default.
2. Add `MemoryStore`, per-repo path resolution and schema validation.
3. Add `PromptContextBundle` formatting with approved manual `knowledge.json` and `prompt-rules.json`.
4. Wire memory context into `buildAnalysisPrompt()` and `buildImplementationPrompt()` only.
5. Append `FailureMemoryEntry` when validation/fix attempts are exhausted.
6. Add `memory:validate` and documentation for storage/cleanup/manual rule approval.

MVP should not implement merge-diff review learning, auto-promotion, embeddings, source-tree RAG, or automatic `AGENTS.md` edits.

## Design Principles

- Memory должна быть полезной, но не авторитетнее текущего кода и свежих инструкций.
- Память должна быть auditable: каждая learned rule имеет source, дату, confidence и approval state.
- По умолчанию memory хранится вне target repo, чтобы не менять кодовую базу клиента.
- Prompt context должен иметь строгий budget, иначе memory ухудшит качество вместо улучшения.
- Memory validation is fail-open by default: corrupted memory disables memory for that repository with a warning. Fail-closed behavior requires explicit `MEMORY_STRICT=true`.
- Review learning сначала создаёт draft rules; auto-apply не входит в MVP и может включаться только отдельным конфигом после ручного approval workflow.

## Milestone 5.1: Project Knowledge Base

### Storage

Добавить config:

```env
MEMORY_ENABLED=true
MEMORY_DIR=/workspace/ai-developer-memory
MEMORY_MAX_CONTEXT_CHARS=6000
MEMORY_STRICT=false
MEMORY_INCLUDE_DRAFT_RULES=false
MEMORY_SIMILAR_FAILURE_LIMIT=3
MEMORY_BOOTSTRAP_ON_START=false
MEMORY_REFRESH_ON_PRELIGHT=false
MEMORY_BOOTSTRAP_CODEX_SANDBOX=inherit
```

Per-repository layout:

```text
MEMORY_DIR/
  repositories/
    client-application/
      knowledge.json
      prompt-rules.json
      failures.jsonl
      review-learning.jsonl
      metadata.json
```

Repository key should come from sanitized `RepositoryProfile.name`, not raw `repoPath`, so memory survives path changes. Store the original repository name and `gitlabProjectId` in `metadata.json`; if two profiles normalize to the same key, fail config validation with an actionable error.

### Data Model

Add types in `src/models/types.ts`:

```typescript
export interface RepositoryKnowledgeBase {
  repositoryName: string;
  schemaVersion: 1;
  updatedAt: string;
  architectureMap: KnowledgeSection[];
  entryPoints: KnowledgeSection[];
  codePatterns: KnowledgeSection[];
  testStrategy: KnowledgeSection[];
  knownPitfalls: KnowledgeSection[];
  conventions: KnowledgeSection[];
}

export interface KnowledgeSection {
  id: string;
  title: string;
  body: string;
  source: "repo_docs" | "worker_observation" | "review_learning" | "manual";
  sourceRefs: string[];
  tags: string[];
  taskTypes: TaskType[];
  confidence: number;
  updatedAt: string;
}
```

### Memory Store

Create `src/domain/memoryStore.ts`:

```typescript
export interface MemoryStore {
  loadKnowledge(repositoryName: string): Promise<RepositoryKnowledgeBase>;
  saveKnowledge(knowledge: RepositoryKnowledgeBase): Promise<void>;
  appendFailure(entry: FailureMemoryEntry): Promise<void>;
  appendReviewLearning(entry: ReviewLearningEntry): Promise<void>;
  loadPromptRules(repositoryName: string): Promise<PromptRule[]>;
}
```

MVP implementation:

- JSON files for current state;
- JSONL for append-only observations;
- atomic write through temp file + rename;
- schema version validation;
- corrupted memory file disables memory for that repository with actionable `WARN` when `MEMORY_STRICT=false`;
- corrupted memory file fails the worker before implementation only when `MEMORY_STRICT=true`.

### Bootstrap Sources

Knowledge bootstrap should inspect only small, high-signal files:

- `AGENTS.md`;
- `CONTRIBUTING.md`;
- `README.md`;
- `.editorconfig`;
- package/build config names such as `package.json`, `tsconfig.json`, `vitest.config.*`;
- existing docs folder summaries when files are small enough.

Do not scan full source tree into memory in Phase 5. That belongs to Phase 8 RAG.

### Bootstrap Flow

```text
repository context startup or preflight
  -> load existing knowledge
  -> if missing and bootstrap enabled:
       read known docs/config files
       build summary with Codex analysis-only prompt
       validate RepositoryKnowledgeBase JSON
       verify target repo has no new git changes when git is available
       write knowledge.json
  -> if exists:
       validate schema
       log age and section counts
```

`MEMORY_BOOTSTRAP_CODEX_SANDBOX=inherit` means bootstrap uses the same Codex sandbox policy as the worker. This deliberately allows `danger-full-access` installations, because that risk is already accepted operationally. The guardrail is the analysis-only prompt contract, structured JSON validation and a post-bootstrap git cleanliness check, not a mandatory read-only sandbox. Installations that want stricter bootstrap isolation can set `MEMORY_BOOTSTRAP_CODEX_SANDBOX=read-only`.

### Acceptance Criteria

- Worker can load an empty memory store and create default per-repo files.
- Bootstrap generates structured knowledge for one repository without modifying target repo.
- Invalid memory schema disables memory with a clear warning by default, or blocks implementation when `MEMORY_STRICT=true`.
- Knowledge sections can be filtered by `taskType`, tags and repository.
- Existing worker flow works when `MEMORY_ENABLED=false`.

## Milestone 5.2: Learning From Review (Post-MVP)

This milestone should start only after the MVP memory context path is implemented and useful in real tasks. It requires GitLab merge-state polling, MR diff/commit retrieval and a clear event that tells the worker a review is actually merged or done.

### Learning Sources

Use existing Phase 1 review loop data plus GitLab merge state:

- unresolved/resolved review discussions;
- worker fix commits;
- final merged MR diff;
- validation failures and fix attempts;
- human comments in Tracker;
- final merge result if reviewer changed worker output before merge.

### GitLab API Extensions

Extend `GitLabService` as needed:

```typescript
getMergeRequest(iid: number): Promise<MergeRequestInfo & { state: string; mergedAt?: string }>;
getMergeRequestDiff(iid: number): Promise<string>;
getMergeRequestCommits(iid: number): Promise<MergeRequestCommit[]>;
```

If GitLab permissions are incomplete, learning should skip with `WARN` and not affect task completion.

### Review Learning Entry

```typescript
export interface ReviewLearningEntry {
  repositoryName: string;
  issueKey: string;
  mergeRequestIid: number;
  taskType: TaskType;
  promptProfileId: string;
  source: "review_discussion" | "merge_diff" | "validation_failure";
  observation: string;
  recommendedRule?: string;
  affectedFiles: string[];
  tags: string[];
  confidence: number;
  approvalState: "draft" | "approved" | "rejected";
  createdAt: string;
}
```

### Extraction Flow

```text
MR merged or task marked done
  -> fetch review discussions and final diff
  -> compare worker branch diff with final merge diff
  -> identify repeated reviewer preferences and final manual edits
  -> create ReviewLearningEntry records
  -> optionally promote high-confidence repeated entries into prompt rules
```

### Promotion Rules

Add config:

```env
MEMORY_REVIEW_LEARNING_MODE=off
MEMORY_AUTO_PROMOTE_MIN_OCCURRENCES=3
MEMORY_AUTO_PROMOTE_MIN_CONFIDENCE=85
```

Modes:

- `off`: do not collect review learning;
- `draft`: write entries, never affect prompts until approved;
- `auto`: promote repeated high-confidence rules automatically. Not part of MVP.

Promotion guardrails:

- never promote one-off stylistic comments immediately;
- never promote rules tied to a single file unless source says it is a project convention;
- never overwrite manual approved rules automatically;
- include source MR links in promoted rule metadata.

### Prompt Rules

```typescript
export interface PromptRule {
  id: string;
  repositoryName: string;
  title: string;
  instruction: string;
  taskTypes: TaskType[];
  promptProfileIds: string[];
  sourceEntryIds: string[];
  confidence: number;
  approvalState: "draft" | "approved";
  createdAt: string;
  updatedAt: string;
}
```

Only `approved` rules affect prompts unless `MEMORY_INCLUDE_DRAFT_RULES=true`.

### Approval Workflow

MVP approval is intentionally file-based:

- `prompt-rules.json` may contain manual `approved` rules and generated `draft` rules.
- `memory:validate` checks schema, duplicate ids, dangling `sourceEntryIds` and invalid task/profile ids.
- A human approves a rule by editing `approvalState` to `approved` and keeping the source metadata intact.
- The worker never overwrites manual approved rules during learning or promotion.

Automatic promotion is post-MVP and must keep manual approvals authoritative.

### Acceptance Criteria

- After a merged MR, worker can append review learning entries.
- Draft learning entries do not change prompts by default.
- Repeated high-confidence approved rules appear in future prompt context.
- Learning failures do not break MR completion or task status updates.
- A manual approved rule remains stable across later auto-learning runs.

## Milestone 5.3: Dynamic System Prompt

Implementation order note: build this immediately after Milestone 5.1 for the MVP. The review-learning milestone above remains post-MVP even though it is numbered earlier in the roadmap.

### Context Bundle

Create `src/domain/promptContext.ts`:

```typescript
export interface PromptContextBundle {
  repositoryName: string;
  taskType: TaskType;
  promptProfileId: string;
  instructionSources: PromptInstructionSource[];
  knowledgeSections: KnowledgeSection[];
  promptRules: PromptRule[];
  similarFailures: FailureMemoryEntry[];
  contextBudgetChars: number;
}
```

Sources in priority order:

1. Current system/developer instructions and runtime safety rules.
2. `AGENTS.md` and repository instruction files.
3. Task-specific Tracker issue and comments.
4. Phase 4 `TaskAnalysisDecision`.
5. Prompt profile.
6. Approved repository prompt rules.
7. Knowledge sections relevant to task type/profile.
8. Similar failures and review learning summaries.

### Prompt Assembly

Refactor `src/domain/promptBuilder.ts`:

- keep existing task-specific prompt functions;
- add optional `PromptContextBundle`;
- format memory into a compact `Repository context` section;
- enforce `MEMORY_MAX_CONTEXT_CHARS`;
- log which memory sections were included by id;
- do not include raw large docs or full diffs in memory context.
- MVP wiring: pass the bundle only to `buildAnalysisPrompt()` and `buildImplementationPrompt()`.
- Post-MVP wiring: extend `buildFixPrompt()`, `buildReviewFixPrompt()` and `buildDecompositionPrompt()` after prompt size and usefulness are verified.

### Similar Failure Memory

Capture failures from:

- validation gate failures after max attempts;
- Codex timeouts;
- failed review fix loops;
- manual hold after low confidence;
- dependency/decomposition failures.

Entry:

```typescript
export interface FailureMemoryEntry {
  repositoryName: string;
  issueKey: string;
  taskType: TaskType;
  promptProfileId: string;
  failureKind: string;
  diagnosticSummary: string;
  resolutionSummary?: string;
  affectedFiles: string[];
  tags: string[];
  createdAt: string;
}
```

Retrieval MVP:

- match by repository, task type and prompt profile;
- boost overlapping tags/components/expected files;
- return top `MEMORY_SIMILAR_FAILURE_LIMIT`, default `3`;
- no embeddings in Phase 5.

### Acceptance Criteria

- Prompts include repository context when memory is enabled.
- Context bundle respects character budget.
- Prompt output is deterministic for the same memory inputs.
- Disabling memory returns prompts equivalent to Phase 4 behavior.
- Similar past failures appear only when task type/profile overlap.
- MVP proves the context path on analysis and implementation prompts before extending all prompt builders.

## Operational Commands

Add npm scripts or CLI modes:

```bash
npm run memory:validate
npm run memory:bootstrap
npm run memory:promote-rules
```

MVP minimum is `memory:validate`. `memory:bootstrap` is useful but can follow once the store and prompt context are stable. `memory:promote-rules` is post-MVP because automatic promotion should not exist before the manual approval workflow is proven.

If adding scripts is too much for MVP, expose equivalent env-driven modes:

```env
WORKER_MEMORY_BOOTSTRAP_ONLY=true
WORKER_MEMORY_VALIDATE_ONLY=true
```

Expected behavior:

- validate checks all memory files for schema and dangling source ids;
- bootstrap creates or refreshes `knowledge.json`;
- promote-rules promotes eligible draft review learning entries only when review learning is enabled.

## Migration Plan

1. Add memory config with `MEMORY_ENABLED=false` default for safe rollout.
2. Add `MemoryStore`, per-repo key sanitization and schema tests.
3. Add validation-only command and default fail-open memory loading.
4. Add prompt context bundle formatting without changing prompt behavior by default.
5. Enable memory context in analysis prompt only.
6. Enable memory context in implementation prompt.
7. Add failure memory writes after exhausted validation/fix attempts.
8. Document storage, cleanup and manual approval workflow. This is the MVP completion point.
9. Add optional knowledge bootstrap command and git cleanliness guard.
10. Extend memory context to fix/review/decomposition prompts after prompt budget validation.
11. Add review learning extraction after merged MR detection.
12. Add prompt rule promotion in draft mode first, then optional auto mode.

## Testing Plan

Add or update:

- `tests/memoryStore.test.ts`: load/save, atomic write, schema validation, corrupted files.
- `tests/memoryConfig.test.ts` or `tests/config.test.ts`: memory defaults, strict mode, context budget and repository key collisions.
- `tests/promptContext.test.ts`: retrieval, budget enforcement, deterministic formatting.
- `tests/promptBuilder.test.ts`: memory-enabled and memory-disabled prompts.
- `tests/orchestrator.test.ts`: failure memory append and memory-disabled baseline behavior.
- `tests/worker.smoke.test.ts`: memory disabled baseline and memory enabled with small fixture.

Post-MVP tests:

- `tests/knowledgeBootstrap.test.ts`: repo docs scan, generated knowledge validation and git cleanliness guard.
- `tests/reviewLearning.test.ts`: draft entry creation, permission-error skip and promotion guardrails.

## Verification

Minimum commands:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

Manual scenarios:

1. `MEMORY_ENABLED=false` keeps Phase 4 behavior.
2. `memory:validate` accepts a small valid repository memory fixture.
3. Memory-enabled analysis prompt includes relevant architecture/conventions sections.
4. Memory-enabled implementation prompt includes approved prompt rules.
5. A validation failure appends a failure memory entry.
6. Oversized memory files are trimmed to budget rather than overflowing prompt context.
7. Invalid memory schema disables memory with a warning when `MEMORY_STRICT=false`.
8. Invalid memory schema blocks processing when `MEMORY_STRICT=true`.

Post-MVP manual scenarios:

1. `memory:bootstrap` creates knowledge files for a repository profile without leaving target repo git changes.
2. A merged MR creates draft review learning entries.
3. Approved prompt rule appears in the next fix/review/decomposition prompt.

## Risks

| Risk | Mitigation |
| --- | --- |
| Stale memory misleads Codex | Track `updatedAt`, source refs and confidence; prefer current repo files over memory. |
| Review learning overfits one reviewer comment | Draft-first workflow and auto-promotion only after repeated high-confidence occurrences. |
| Memory leaks sensitive project details | Store under configured local `MEMORY_DIR`, document backup/retention, do not print full memory in logs. |
| Prompt becomes too large | Hard character budget and deterministic section ranking. |
| Corrupted memory blocks production unexpectedly | Configurable fail-open/fail-closed behavior, validation command and actionable diagnostics. |
| Bootstrap scans too much code | Limit Phase 5 bootstrap to docs/config files; defer codebase RAG to Phase 8. |
| Bootstrap runs with `danger-full-access` in some installations | Treat this as an explicit operational choice; use analysis-only prompt contract, structured output validation and target repo git cleanliness checks. |

## Definition of Done

MVP done:

- Memory config exists with `MEMORY_ENABLED=false` default and `MEMORY_STRICT=false` fail-open default.
- File-backed per-repository memory store can load, save and validate memory files.
- Prompt context bundle integrates approved memory into analysis and implementation prompts.
- Failure memory records failed automation patterns.
- Memory disabled mode preserves Phase 4 behavior.
- Documentation explains storage, validation, manual approval and cleanup.

Full Phase 5 done:

- Per-repository knowledge base exists and can be bootstrapped/validated.
- Prompt context bundle integrates approved memory into all main prompt paths.
- Failure memory records failed automation patterns.
- Review learning records draft preferences after merge and can promote approved prompt rules.
- Memory disabled mode preserves Phase 4 behavior.
- Documentation explains storage, approval and cleanup.
- Roadmap items `5.1`, `5.2` and `5.3` can be marked completed or MVP-completed.
