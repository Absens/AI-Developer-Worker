# Память проектов: хранение, проверка и очистка

Подсистема memory хранит знания о целевых репозиториях в локальных файлах. По умолчанию она **выключена** и при включении носит рекомендательный характер: текущие файлы репозитория, задания Tracker и новые комментарии человека имеют приоритет над памятью.

## Структура

Укажите writable каталог **вне** целевого git checkout:

```env
MEMORY_ENABLED=true
MEMORY_DIR=/workspace/ai-developer-memory
```

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

Идентификатор памяти основан на нормализованном `RepositoryProfile.name`, а не `repoPath`: изменения пути checkout не ломают привязку. Если имена двух профилей дают одинаковый ключ, fleet startup завершается ошибкой.

## Валидация

```bash
npm run memory:validate
```

Проверяются схемы JSON, строки JSONL, уникальность ID правил и ссылки `sourceEntryIds`. Токены Tracker/GitLab не нужны.

- При `MEMORY_STRICT=false` повреждённая память конкретного репозитория отключается с предупреждением.
- При `MEMORY_STRICT=true` обработка задачи блокируется при невалидной памяти.

## Знания и правила

`knowledge.json` содержит компактные устойчивые факты: архитектуру, точки входа, соглашения, особенности тестирования и известные ловушки. Не помещайте туда секреты и устаревающие догадки.

`prompt-rules.json` — ручные и выученные правила. По умолчанию влияют на промпты только записи с `approvalState: "approved"`. Пример:

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

`MEMORY_INCLUDE_DRAFT_RULES=true` используйте только в контролируемом эксперименте: иначе черновики игнорируются.

## Память ошибок

Если все автоматические попытки исправления исчерпаны и quality gates не пройдены, воркер добавляет краткую запись в `failures.jsonl`. Аналогичные ошибки включаются в будущий контекст только при совпадении репозитория, типа задачи и профиля промпта.

## Очистка

Остановите воркер. Чтобы сбросить память одного проекта, удалите только `MEMORY_DIR/repositories/<repository-key>/`. Чтобы очистить неудачные попытки, достаточно обнулить `failures.jsonl`, сохранив `knowledge.json` и утверждённые правила.

Локальная memory **не равна** общей корпоративной памяти и не синхронизируется автоматически между серверами.

