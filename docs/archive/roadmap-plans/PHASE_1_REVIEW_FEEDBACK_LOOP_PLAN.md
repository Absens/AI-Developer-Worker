# Phase 1 Review Feedback Loop Plan

_Актуально на 2026-04-26._

## Цель

Замкнуть ручной этап после создания GitLab Merge Request: worker должен видеть unresolved review discussions, исправлять замечания, валидировать изменения, пушить новый commit и отвечать в MR thread.

Источник: `product_roadmap.md`, раздел `Фаза 1 - Review Feedback Loop`.

## Результат фазы

- Worker обнаруживает unresolved GitLab discussions в MR, который сам создал или переиспользует.
- Reviewer comments группируются по файлам, line ranges и темам.
- Уже обработанные discussion/comment ids сохраняются и не запускают повторную работу.
- Codex получает review-fix prompt с diff context и списком замечаний.
- После успешного fix cycle worker прогоняет validation, пушит новый commit и отвечает в MR thread.
- MR создаётся с содержательным description, testing summary, risks/notes и ссылками.
- Commit message становится осмысленным conventional commit с issue key.

## Scope

В фазу входят:

- расширение `GitLabService` для discussions и replies;
- review-cycle ветка в `WorkerOrchestrator`;
- новый prompt builder для review fixes;
- хранение processed review metadata в structured comments;
- генерация MR description;
- smart commit message helper;
- tests для GitLab client, comment protocol, orchestrator и smoke flow.

В фазу не входят:

- полноценные code owner approvals;
- автоматическое merge;
- advanced quality gates из Phase 2;
- multi-repository routing.

## Design Decision: Status Model

MVP должен сохранить совместимость с существующими `TRACKER_STATUS_MAP_FILE`.

Поэтому первый шаг:

- Tracker logical status остаётся `review`, когда MR ожидает человека;
- во время исправления worker временно переводит задачу в `in_progress`;
- structured `AI STATUS` comment содержит details `Fixing unresolved review discussions`.

Отдельный logical status `fixing_review` можно добавить позже как optional extension, но не как обязательное изменение Phase 1 MVP.

## Milestone 1.1: GitLab Discussions Monitor

### Data Model

Добавить типы в `src/models/types.ts`:

```typescript
interface MergeRequestDiscussion {
  id: string;
  individualNote: boolean;
  resolved: boolean;
  notes: MergeRequestNote[];
}

interface MergeRequestNote {
  id: number;
  body: string;
  authorUsername: string;
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  createdAt: string;
  position?: {
    newPath?: string;
    oldPath?: string;
    newLine?: number;
    oldLine?: number;
  };
}
```

### GitLab API Work

Расширить `src/integrations/gitlab/client.ts`:

- `getMergeRequestDiscussions(iid: number): Promise<MergeRequestDiscussion[]>`;
- `replyToDiscussion(iid: number, discussionId: string, body: string): Promise<void>`;
- `getCurrentUser(): Promise<{ username: string }>` для фильтрации комментариев самого worker;
- pagination для discussions, если GitLab возвращает несколько страниц.

### Filtering Rules

Monitor должен учитывать только:

- unresolved discussions;
- non-system notes;
- notes не от worker user;
- comments, которые ещё не отмечены как processed;
- comments в MR, связанном с текущей Tracker issue branch.

### Persistence

Добавить новый structured comment prefix в `commentProtocol.ts`:

```text
AI REVIEW:
```

Payload:

```json
{
  "worker": "worker-1",
  "issueKey": "FRONTEND-123",
  "mergeRequestIid": 17,
  "processedDiscussionIds": ["abc"],
  "processedNoteIds": [101, 102],
  "lastFixCommit": "..."
}
```

Хранить metadata в Tracker comments, чтобы worker мог восстановиться после рестарта без локальной базы.

### Acceptance Criteria

- Worker корректно получает unresolved discussions.
- Комментарии worker user не попадают в fix prompt.
- Повторный poll не обрабатывает уже recorded discussion/note ids.
- Restart worker не теряет processed review metadata.

## Milestone 1.2: Review Fix Cycle

### Flow

```text
review issue found
  -> find MR by branch
  -> fetch unresolved discussions
  -> if none: stay in review
  -> transition issue to in_progress
  -> run Codex review fix
  -> validate repository
  -> commit and push
  -> reply to MR discussions
  -> transition issue back to review
```

### Orchestrator Changes

В `src/domain/orchestrator.ts`:

- расширить discovery, чтобы worker мог брать свои задачи в `review`;
- найти MR по branch из `AI MR` comment или по task branch;
- добавить `handleReviewFeedback(issue, comments, mergeRequest)`;
- ограничить количество review fix attempts через `MAX_REVIEW_FIX_ATTEMPTS`, default равен `MAX_FIX_ATTEMPTS`;
- при неуспешной validation переводить задачу в `waiting_for_answer` или `failed` с diagnostic, чтобы не зациклиться.

### Prompt Changes

Добавить в `src/domain/promptBuilder.ts`:

- `buildReviewFixPrompt(issue, comments, reviewContext)`;
- включить grouped comments;
- включить MR URL, source branch, target branch;
- включить diff summary from base;
- явно попросить отвечать только изменениями в target repo и не резолвить thread вручную.

### Git Support

В `src/integrations/git/service.ts` может понадобиться:

- `getDiffFromBase(): Promise<string>`;
- `getChangedFilesFromBase(): Promise<string[]>`;
- `getHeadSha(): Promise<string>`.

### MR Replies

После успешного push:

- ответить в каждом discussion кратким сообщением;
- указать commit sha и validation summary;
- не помечать discussion resolved автоматически в MVP, если GitLab permissions или policy не подтверждены.

### Acceptance Criteria

- Unresolved review comment запускает fix cycle.
- Успешный fix создаёт новый commit и push в существующую MR branch.
- Worker отвечает в GitLab discussion с результатом.
- Один и тот же discussion не запускает бесконечные повторные фиксы.
- Failed review fix даёт понятный Tracker comment и controlled status.

## Milestone 1.3: MR Description Autogen

### Content

MR description должен содержать:

```markdown
## Summary

## Changed Files

## Testing

## Risks / Notes

## Links
```

### Implementation

Добавить helper, например `src/domain/mergeRequestDescription.ts`:

- вход: issue, branch, validation summary, changed files, worker id;
- deterministic fallback без Codex;
- optional Codex summary только если уже есть final message или safe structured output;
- links на Tracker issue, branch и worker id.

Расширить `GitLabService.createMergeRequest()` уже существующим `description?: string`.

### Acceptance Criteria

- Новый MR создаётся с description.
- Description не пустой даже при отсутствии Codex summary.
- Testing section отражает реально выполненные команды.
- Links section содержит Tracker issue key и branch.

## Milestone 1.4: Smart Commit Messages

### Rules

- Conventional commit: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`.
- Issue key в конце subject: `fix: handle empty tracker comments FRONTEND-123`.
- Fallback: `feat: implement FRONTEND-123`.
- Несколько коммитов разрешены только если изменения действительно независимы; MVP может оставить один commit с более качественным subject.

### Implementation

Добавить `src/domain/commitMessage.ts`:

- определить type по changed files и issue title;
- ограничить subject до разумной длины;
- удалить переносы, markdown и quotes;
- unit tests на fallback и sanitization.

### Acceptance Criteria

- Commit message больше не всегда `feat: implement ISSUE-KEY`.
- Небезопасный или пустой summary возвращает fallback.
- Existing publish flow остаётся idempotent.

## Verification

Минимальный набор команд:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

Дополнительно нужен интеграционный сценарий с mock GitLab discussions:

1. Создать MR.
2. Вернуть unresolved discussion из mock GitLab.
3. Проверить, что worker запускает review fix.
4. Проверить commit, push и reply payload.
5. Проверить, что повторный run не обрабатывает тот же discussion.

## Risks

| Risk | Mitigation |
| --- | --- |
| Статус `fixing_review` ломает status map пользователей | В MVP переиспользовать `in_progress` и structured details. |
| Worker отвечает на собственные comments | Получать current GitLab user и фильтровать author username. |
| Discussions повторно обрабатываются после restart | Хранить processed ids в Tracker structured comments. |
| Codex fix портит unrelated changes | Перед review fix синхронизировать branch и передавать только релевантный review context. |
| Infinite loop на одном замечании | Ввести `MAX_REVIEW_FIX_ATTEMPTS` и processed ids только после push/reply. |

## Definition of Done

- Review feedback loop работает в unit и smoke tests.
- MR description генерируется для новых MR.
- Commit message helper покрыт тестами.
- Existing clarification loop и initial implementation flow не регрессировали.
- Roadmap items `1.1`, `1.2`, `1.3`, `1.4` можно отметить как completed или MVP-completed.
