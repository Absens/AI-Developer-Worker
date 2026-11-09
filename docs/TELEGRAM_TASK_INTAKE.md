# Telegram: создание задач, выполнение и Digital Twin

Telegram Assistant — дополнительный интерфейс к **внутреннему** task tracker. Пользователь описывает задачу, бот готовит черновик, запрашивает подтверждение, создаёт internal task и при разрешённой политике переводит её в `ready`. Исполняет задачу обычный `InternalWorkerOrchestrator` — отдельного «Telegram-исполнителя» нет.

## Что поддерживается

| Сценарий | Условие |
| --- | --- |
| Личный чат → подтверждение → `ready` | Пользователь имеет право записи, создание задач включено, выбран репозиторий, риск low/medium |
| Личный чат → риск high → согласование | Должен быть настроен owner/admin с личным чатом |
| Business/Profile → создание задачи | Разрешена автоматизация, определяется репозиторий и владелец подтверждает заявку |
| Business/Digital Twin → явная задача | `create_task_draft` перехватывается до свободного ответа Digital Twin; обязательно согласование |
| Business/Digital Twin → обычное сообщение | Долговременная сессия Codex только при разрешении владельца и подходящей политике |
| Ответ на вопрос агента | Для подписанной задачи в `awaiting_human` ответ записывается как human input |

## Личный чат: жизненный цикл

1. `src/domain/telegramAssistant/intentRouter.ts` распознаёт фразы «создай задачу», «надо сделать», «починить», «добавить» и выбирает `create_task_draft`.
2. `TelegramAssistantService` проверяет права, `TELEGRAM_TASK_CREATION_ENABLED`, лимиты и идентификатор сообщения.
3. По имени, очереди, тегу или `TELEGRAM_DEFAULT_REPOSITORY` выбирается repository profile. При неоднозначности бот запрашивает уточнение.
4. Формируется исполняемый draft с `repositoryName`, `repoPathKey`, `baseBranch`, `queue`, критериями приёмки, тегами и факторами риска.
5. Пользователь подтверждает карточку кнопкой или допустимым текстом («да», «ок», «создай», «подтверждаю»).
6. Задача создаётся через `TaskTrackerClient`, чат подписывается на уведомления и, если политика позволяет, вызывается `markReady()`.

Все записи идут через внутренний `TaskTrackerClient`. Telegram Assistant не обращается к human HTTP API и требует `TASK_TRACKER_PROVIDER=internal`.

## Данные задачи и claim

В задаче сохраняются профиль репозитория, ключ пути, base branch, queue, `telegram`- и risk-теги, acceptance criteria и ссылки на Telegram message. Сейчас `repoPathKey` совпадает с `RepositoryProfile.name`. После `markReady()` задачу получает `InternalWorkerOrchestrator.claimTask()` при обычной обработке очереди.

## Оценка риска и подтверждение

Риск определяется правилами, а не только свободным ответом модели:

- **Low**: документация, тесты, текстовые изменения.
- **Medium**: ограниченные исправления и функции.
- **High**: авторизация, безопасность, финансы, удаление данных, инфраструктура/деплой, широкие неоднозначные изменения.

Подтверждённые low/medium заявки доверенного пользователя могут перейти в `ready`. High-risk заявки передаются owner/admin. **Если получатель согласования не настроен, автоматического исполнения не происходит.**

Это policy для intake, а не гарантия безопасности автономного кода; отделяйте полномочия агента от прав на принятие задач.

## Business/Profile и Digital Twin

`TELEGRAM_PROFILE_AUTOMATION_*` проверяет Business connection, allowlists владельца и чата, возраст сообщения и права Telegram (`can_reply`). При включённом `TELEGRAM_PROFILE_AUTOMATION_REQUIRE_OWNER_APPROVAL=true` бот передаёт исполняемый draft **в личный чат владельца**, а не подтверждает выполнение внешнему отправителю. Повторная доставка одного сообщения не должна создавать дубли благодаря idempotent pending action и external refs.

`TELEGRAM_DIGITAL_TWIN_*` поддерживает длительные сессии Codex на контакт, версионирование persona, audit records и retention controls. Явная просьба создать задачу обрабатывается **до** `assistantCodex.answerAsDigitalTwin`. Таким образом Digital Twin не получает бесконтрольный tool на создание/исполнение задач.

Держите этот режим выключенным до документированного согласия владельца, политики хранения текста, шифрования audit и проверки прав `can_reply`.

## Возобновление и уведомления

Подписчики получают события `ready`, `claimed`, сохранения MR, `awaiting_human`, ошибок и принятия результата. При вопросе агента уведомление сохраняет активный prompt конкретной задачи. Ответ пользователя относится именно к нему; при `TELEGRAM_CONFIRM_WRITE_ACTIONS=true` перед записью требуется отдельное подтверждение.

## Операционные ограничения

- `TELEGRAM_TASK_CREATION_ENABLED=false` блокирует draft, pending actions и создание задач.
- `TELEGRAM_CONFIRM_WRITE_ACTIONS=true` включает подтверждение write actions.
- Права записи задаются `TELEGRAM_DEVELOPER_USER_IDS`, `TELEGRAM_OPERATOR_USER_IDS`, `TELEGRAM_ADMIN_USER_IDS`.
- Для Business/Profile обязательны явные allowlists и согласие владельца.
- В группах по умолчанию безопаснее обрабатывать только упоминания и ответы; не включайте чтение всех сообщений без согласия участников.

## Проверка

```bash
npx vitest run tests/telegramExecutableTaskDraft.test.ts tests/telegramAssistant.test.ts tests/telegramProfileAutomation.test.ts tests/telegramNotifications.test.ts tests/taskTrackerQueue.test.ts
npm run typecheck
```

См. [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md), [Docker](LOCAL_DOCKER_RUN.md), [наблюдаемость](OBSERVABILITY_RUNBOOK.md).

