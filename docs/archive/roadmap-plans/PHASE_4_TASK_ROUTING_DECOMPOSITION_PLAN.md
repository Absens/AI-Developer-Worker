# Phase 4 Task Routing and Decomposition Plan

_Актуально на 2026-04-26._

## Цель

Повысить success rate worker за счёт осознанного выбора режима работы до implementation: оценивать confidence, выбирать prompt profile под тип задачи, декомпозировать крупные epic-задачи и не брать задачи с незакрытыми dependencies.

Источник: `product_roadmap.md`, раздел `Фаза 4 - Task Routing и декомпозиция`.

## Результат фазы

- Analysis stage возвращает структурированное решение: confidence, task type, risks, missing context и recommended mode.
- Priority queue получает confidence signal и учитывает его при выборе задач.
- Worker выбирает prompt profile: frontend UI fix, backend endpoint, tests-only, refactor, dependency update, documentation.
- Низкая confidence не уходит в слепую implementation: задача переводится в clarification/manual hold или decomposition mode.
- `TASK_MODE=decompose` создаёт sub-issues в Tracker с acceptance criteria и dependency links.
- Worker не берёт задачу, если её `blockedBy` ещё не закрыты.
- Все routing/decomposition решения сохраняются в structured comments для аудита и восстановления после рестарта.

## Scope

В фазу входят:

- новая модель structured pre-analysis decision;
- расширение `buildAnalysisPrompt()` и parser для structured Codex output;
- prompt profiles и profile-aware prompt building;
- интеграция confidence score с `src/domain/priorityQueue.ts`;
- Tracker APIs для создания sub-issues и чтения/записи dependencies;
- dependency-aware filtering в `src/domain/fleetOrchestrator.ts`;
- tests для analysis parsing, profile selection, decomposition и dependency filtering.

В фазу не входят:

- project knowledge base из Phase 5;
- embeddings/RAG по кодовой базе из Phase 8;
- поддержка внешних trackers кроме Yandex Tracker;
- автоматическое планирование multi-step engineering pipeline;
- dashboard для отображения decomposition graph.

## Design Principles

- Phase 4 должен быть conservative gate перед implementation, а не ещё один способ запускать Codex на всё подряд.
- Structured output обязателен: свободный текст analysis не должен управлять routing.
- При неопределённости worker выбирает clarification или human hold, а не risky implementation.
- Prompt profiles должны быть конфигурируемыми, но MVP может иметь встроенные profiles.
- Dependency enforcement должен быть fail-closed: если blocker status неизвестен, задача не берётся.

## Milestone 4.1: Confidence Pre-Analysis

### Decision Model

Добавить типы в `src/models/types.ts`:

```typescript
export type TaskExecutionMode =
  | "implement"
  | "ask_clarification"
  | "decompose"
  | "human";

export type TaskType =
  | "frontend_ui_fix"
  | "backend_endpoint"
  | "tests_only"
  | "refactor"
  | "dependency_update"
  | "documentation"
  | "unknown";

export interface TaskAnalysisDecision {
  confidence: number;
  taskType: TaskType;
  recommendedMode: TaskExecutionMode;
  promptProfileId: string;
  expectedFiles: string[];
  expectedSubsystems: string[];
  riskFactors: string[];
  missingContext: string[];
  reasoning: string;
}
```

Validation rules:

- `confidence` is integer `0..100`;
- `recommendedMode` must match enum;
- `promptProfileId` must exist or fall back to `general`;
- if `recommendedMode=implement`, `confidence` must be above threshold;
- if `missingContext` is non-empty and confidence is low, mode must be `ask_clarification` or `human`.

### Configuration

Add optional config:

```env
TASK_MODE=auto
CONFIDENCE_IMPLEMENT_THRESHOLD=70
CONFIDENCE_HUMAN_THRESHOLD=40
CONFIDENCE_PRIORITY_WEIGHT=2
```

Modes:

- `auto`: use structured analysis decision;
- `implement`: force implementation if no hard blocker exists;
- `decompose`: force decomposition path;
- `analyze_only`: write analysis metadata and stop;
- `human`: move eligible tasks to manual hold after analysis.

### Structured Comment

Add new prefix in `commentProtocol.ts`:

```text
AI ANALYSIS:
```

Payload:

```json
{
  "worker": "worker-1",
  "issueKey": "FRONTEND-123",
  "confidence": 82,
  "taskType": "frontend_ui_fix",
  "recommendedMode": "implement",
  "promptProfileId": "frontend_ui_fix",
  "expectedFiles": ["src/components/Button.tsx"],
  "expectedSubsystems": ["ui", "forms"],
  "riskFactors": ["visual regression risk"],
  "missingContext": [],
  "reasoning": "Localized UI fix with clear acceptance criteria."
}
```

### Codex Contract

Update `buildAnalysisPrompt()` to request exactly one structured response:

```text
AI_ANALYSIS: {"confidence": 82, ...}
```

Clarification remains available, but should become a routing decision:

- `recommendedMode=ask_clarification`;
- `missingContext` describes blockers;
- worker converts this into the existing `AI QUESTION` flow.

### Orchestrator Behavior

In `src/domain/orchestrator.ts`:

1. Run analysis.
2. Parse `TaskAnalysisDecision`.
3. Write `AI ANALYSIS` comment.
4. Apply task mode policy:
   - `implement`: continue to implementation with selected profile;
   - `ask_clarification`: create `AI QUESTION` and move to `waiting_for_answer`;
   - `decompose`: invoke decomposition flow;
   - `human`: move to `waiting_for_answer` with `manual_hold`.
5. Use previous analysis comment on restart if it is still current.

### Priority Queue Integration

`src/domain/priorityQueue.ts` already reserves `confidence` in `CandidateScore`. Phase 4 should feed it:

- fetch latest `AI ANALYSIS` comment when available;
- calculate `confidenceScore = confidence * CONFIDENCE_PRIORITY_WEIGHT`;
- penalize low-confidence tasks unless manual override tag exists;
- do not run expensive analysis for every queue item on each poll in MVP.

### Acceptance Criteria

- Valid `AI_ANALYSIS` output controls the next mode.
- Invalid or missing structured output fails safely into clarification/manual hold.
- Low confidence below `CONFIDENCE_HUMAN_THRESHOLD` does not start implementation.
- `TASK_MODE=analyze_only` writes analysis metadata and stops without git changes.
- Priority queue can use stored confidence when ordering candidates.

## Milestone 4.2: Task Routing and Prompt Profiles

### Built-In Profiles

Create `src/domain/promptProfiles.ts` with built-in profiles:

| Profile | Intended task |
| --- | --- |
| `frontend_ui_fix` | UI behavior, styling, accessibility, component fixes. |
| `backend_endpoint` | API handlers, validation, persistence, service logic. |
| `tests_only` | Missing or failing tests without production changes unless needed. |
| `refactor` | Internal structure changes with behavior preservation. |
| `dependency_update` | Package updates, lockfiles, migration notes. |
| `documentation` | README, runbooks, comments, docs-only changes. |
| `general` | Safe fallback profile. |

### Profile Shape

```typescript
export interface PromptProfile {
  id: string;
  taskType: TaskType;
  matchHints: string[];
  implementationInstructions: string[];
  validationFocus: string[];
  riskChecklist: string[];
}
```

### Config Override

Add optional repository profile config:

```yaml
repositories:
  - name: client-application
    promptProfiles:
      frontend_ui_fix:
        validationFocus:
          - "Run visual regression command when configured."
          - "Check responsive behavior for touched components."
```

MVP can support merge-overrides only for existing profile ids. Arbitrary custom profiles can be a follow-up.

### Prompt Builder Changes

Update `src/domain/promptBuilder.ts`:

- `buildImplementationPrompt(issue, comments, profile, analysisDecision)`;
- `buildFixPrompt(issue, validation, profile, analysisDecision)`;
- `buildReviewFixPrompt(issue, comments, reviewContext, profile, analysisDecision)`;
- include task-specific instructions and risk checklist;
- keep clarification JSON contract unchanged.

### Routing Rules

Profile selection order:

1. Explicit `promptProfileId` from valid analysis decision.
2. Repository config override by Tracker component/tag.
3. Built-in heuristic by issue title/description.
4. `general` fallback.

### Acceptance Criteria

- Each built-in task type maps to a profile.
- Implementation prompt changes based on selected profile.
- Unknown profile id falls back to `general` and logs warning.
- Repository profile override can alter instructions without code changes.
- Existing implementation and review fix flows still work with `general`.

## Milestone 4.3: Epic Decomposition

### Configuration

Add:

```env
TASK_MODE=decompose
DECOMPOSITION_MAX_SUBTASKS=8
DECOMPOSITION_CREATE_ISSUES=true
DECOMPOSITION_DRY_RUN=false
```

Repository config can optionally define:

```yaml
decomposition:
  defaultSubtaskTag: ai_dev
  subtaskTitlePrefix: "[AI split]"
  maxSubtasks: 8
```

### Data Model

```typescript
export interface DecompositionPlan {
  parentIssueKey: string;
  summary: string;
  subtasks: SubtaskDraft[];
  dependencies: TaskDependencyDraft[];
  risks: string[];
}

export interface SubtaskDraft {
  temporaryId: string;
  title: string;
  description: string;
  queue?: string;
  tags: string[];
  acceptanceCriteria: string[];
  recommendedPromptProfileId: string;
}

export interface TaskDependencyDraft {
  blockedTaskTemporaryId: string;
  blockingTaskTemporaryId: string;
  reason: string;
}
```

### Tracker API Extensions

Extend `TrackerClient`:

```typescript
createIssue(input: CreateTrackerIssueInput): Promise<TrackerIssue>;
linkIssue(input: LinkTrackerIssueInput): Promise<void>;
getIssueLinks(issueKey: string): Promise<TrackerIssueLink[]>;
```

Yandex Tracker link type names should be configurable because installations differ:

```env
TRACKER_PARENT_LINK_TYPE=relates
TRACKER_BLOCKED_BY_LINK_TYPE=is blocked by
```

### Decomposition Flow

```text
parent issue selected
  -> analysis recommends decompose or TASK_MODE=decompose
  -> buildDecompositionPrompt()
  -> parse DecompositionPlan
  -> validate max subtasks, titles, descriptions, dependencies
  -> dry-run comment or create sub-issues
  -> link sub-issues to parent
  -> link dependencies between sub-issues
  -> move parent to waiting/manual_hold or done, depending config
```

### Structured Comment

Add:

```text
AI DECOMPOSITION:
```

Payload:

```json
{
  "worker": "worker-1",
  "parentIssueKey": "FRONTEND-100",
  "createdIssueKeys": ["FRONTEND-101", "FRONTEND-102"],
  "dryRun": false,
  "summary": "Split notifications into data, API, realtime, UI tasks."
}
```

### Safety Rules

- Never create more than `DECOMPOSITION_MAX_SUBTASKS`.
- Do not create issues if required queue/project data is missing.
- Do not create duplicate sub-issues if an `AI DECOMPOSITION` comment already exists with created keys.
- Dry run writes a Tracker comment with proposed subtasks and stops.
- Parent issue should not be implemented directly after successful decomposition.

### Acceptance Criteria

- `TASK_MODE=decompose` produces a valid decomposition plan.
- Dry-run mode creates no Tracker issues and posts the proposed plan.
- Create mode creates sub-issues and records their keys.
- Re-running decomposition on the same parent is idempotent.
- Dependency links are created when supported, otherwise documented in subtask descriptions and warning comment.

## Milestone 4.4: Dependencies Between Tasks

### Tracker Issue Extensions

Extend `TrackerIssue`:

```typescript
blockedBy?: string[];
blocks?: string[];
```

Status resolution:

- dependency is closed if logical status is `done`;
- dependency is acceptable if linked issue no longer exists only when config allows it;
- dependency is blocking if status cannot be determined.

### Configuration

Add:

```env
DEPENDENCY_ENFORCEMENT=true
DEPENDENCY_UNKNOWN_STATUS_POLICY=block
```

Policies:

- `block`: skip task when dependency status is unknown;
- `warn`: allow task but write warning;
- `ignore`: do not enforce dependencies.

### Fleet Filtering

In `src/domain/fleetOrchestrator.ts`, filter candidates before scoring:

1. Load issue dependencies from Tracker issue fields or links.
2. Resolve each blocker status.
3. If any blocker is not done, skip candidate.
4. Log blocker keys and status.
5. Optionally write a structured `AI STATUS` comment only when the task was otherwise top candidate, to avoid noisy comments.

### Acceptance Criteria

- Worker does not process a task whose `blockedBy` issue is not `done`.
- Once all blockers are `done`, task becomes eligible.
- Unknown blocker status follows configured policy.
- Dependency filtering works before lease acquisition and git checkout.
- Decomposition-created dependencies are honored by normal queue processing.

## Migration Plan

1. Add analysis decision parser and tests without changing runtime behavior.
2. Add `AI ANALYSIS` comment support and `TASK_MODE=analyze_only`.
3. Wire confidence thresholds into `WorkerOrchestrator`.
4. Add built-in prompt profiles and route implementation prompts through `general` fallback.
5. Enable confidence score in priority queue from stored analysis.
6. Add decomposition dry-run mode.
7. Add Tracker issue creation/linking and create mode.
8. Add dependency fields and dependency-aware candidate filtering.
9. Document config and operational behavior.

## Testing Plan

Add or update:

- `tests/analysisDecision.test.ts`: parser validation, fallback and thresholds.
- `tests/promptProfiles.test.ts`: profile selection and config overrides.
- `tests/promptBuilder.test.ts`: profile-aware implementation/fix prompts.
- `tests/decomposition.test.ts`: plan parsing, dry-run, idempotency and max subtask enforcement.
- `tests/trackerClient.test.ts`: create issue, links and dependency mapping.
- `tests/fleetOrchestrator.test.ts`: dependency filtering and confidence-aware scoring.
- `tests/priorityQueue.test.ts`: confidence score contribution.
- `tests/worker.smoke.test.ts`: analyze-only and decompose dry-run scenarios.

## Verification

Minimum commands:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

Manual scenarios:

1. `TASK_MODE=analyze_only` writes `AI ANALYSIS` and makes no git changes.
2. Low-confidence task moves to `waiting_for_answer` with a concrete question.
3. Frontend issue selects `frontend_ui_fix` profile and prompt includes profile-specific checks.
4. `TASK_MODE=decompose DECOMPOSITION_DRY_RUN=true` posts proposed subtasks only.
5. Decomposition create mode creates sub-issues once and remains idempotent on rerun.
6. Task with open `blockedBy` issue is skipped; after blocker reaches `done`, it becomes eligible.

## Risks

| Risk | Mitigation |
| --- | --- |
| Codex emits malformed analysis JSON | Strict parser, retry once if useful, then manual hold with diagnostic. |
| Confidence score becomes false precision | Use thresholds as routing guardrails, not as automatic truth. |
| Prompt profiles overfit early task examples | Keep `general` fallback and make profiles configurable per repository. |
| Decomposition creates duplicate or low-quality issues | Require structured plan validation, max subtasks and idempotency through `AI DECOMPOSITION`. |
| Tracker link APIs differ by installation | Make link type names configurable and fall back to textual dependency records. |
| Dependency checks increase Tracker API load | Cache blocker status within one poll cycle and batch where API allows. |

## Definition of Done

- Structured confidence pre-analysis controls task mode.
- Prompt profile selection affects implementation, fix and review-fix prompts.
- Decomposition dry-run and create modes are implemented and tested.
- Task dependencies are read, enforced and honored by normal queue processing.
- Priority queue uses stored confidence when available.
- Documentation and `.env.example` describe new Phase 4 config.
- Roadmap items `4.1`, `4.2`, `4.3` and `4.4` can be marked completed or MVP-completed.
