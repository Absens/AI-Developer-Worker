# Telegram task intake, queue execution and Digital Twin

Этот документ фиксирует текущее состояние сценария: пользователь пишет
Telegram-боту, бот после подтверждения создает задачу, задача попадает в очередь
и выполняется воркером. Короткий вывод: создание задачи через Telegram уже есть,
но автоматическое попадание в execution queue сейчас не завершено. В режиме
Digital Twin создание executable tasks тоже пока не является рабочим
end-to-end path.

## Краткий статус

| Сценарий | Сейчас | Причина |
| --- | --- | --- |
| Private Telegram bot -> подтверждение -> internal task | Да | `create_task_draft` создает pending action, а подтверждение вызывает `TaskTrackerClient.createTask`. |
| Private Telegram bot -> подтверждение -> автоматическое выполнение воркером | Нет | Telegram-created task не получает `repoPathKey`, `baseBranch`, `queue` и `status=ready`; worker claim берет только `ready`/`claimed` executable tasks. |
| Telegram Business/Profile automation -> owner approval -> internal task | Частично | Business-сообщение может создать pending action для owner approval, если Digital Twin не перехватил сообщение. Ограничение по queue такое же. |
| Digital Twin -> задача -> очередь -> выполнение | Нет | Digital Twin сейчас отвечает в conversational Codex session и не имеет task-creation tool/intent boundary. |

## Как работает private bot path

`src/domain/telegramAssistant/intentRouter.ts` распознает фразы вида
`создай задачу`, `надо сделать`, `починить`, `добавить` как
`create_task_draft`. Intent помечен как `requiresConfirmation` и
`confirm_write`.

`src/domain/telegramAssistant/service.ts` проверяет Telegram actor, роль с
правом записи и лимит создания задач. После этого создается
`TelegramPendingAction` с inline-кнопками подтверждения и отмены. Подтверждение
может прийти через callback button или текст вроде `да`, `ок`, `создай`,
`подтверждаю`.

После подтверждения сервис вызывает internal `TaskTrackerClient.createTask`.
Созданная задача получает:

- `source.provider=telegram` и внешний ключ Telegram-сообщения;
- `createdBy.owner=external_source`;
- title/description/acceptance criteria из эвристического draft builder;
- `repositoryName`, если его удалось определить из сообщения или
  `TELEGRAM_DEFAULT_REPOSITORY`;
- Telegram snapshot и attachment refs.

Telegram Assistant не пишет через human HTTP API. В composition root
`src/app.ts` task tracker передается в Telegram Assistant только как internal
tracker client, поэтому создание задач требует `TASK_TRACKER_PROVIDER=internal`.
Preflight также явно проверяет эту связку.

## Почему задача не исполняется автоматически

Создание task record и попадание в worker execution queue - разные этапы.
Internal tracker считает задачу executable только после заполнения execution
fields и перевода в claimable status.

Минимальный набор execution fields:

- `repositoryName`;
- `repoPathKey`;
- `baseBranch`;
- `queue`.

Если `CreateTaskInput` содержит все эти поля, default initial status будет
`new`. Если каких-то execution fields нет, status будет `triage`. В обоих
случаях это еще не claimable execution item.

`InternalWorkerOrchestrator` вызывает `claimTask` с repository profiles. Claim
выбирает только задачи в статусах `ready` или `claimed`, с заполненными
`repositoryName` и `repoPathKey`, подходящим repository profile, без активных
blockers/leases и с пройденной approval policy. PostgreSQL adapter применяет тот
же фильтр на уровне SQL.

Текущий Telegram create path передает `repositoryName`, `tags` и
`acceptanceCriteria`, но не передает `repoPathKey`, `baseBranch`, `queue` и не
запрашивает `status=ready`. Поэтому результат после подтверждения - internal
task для triage/review, а не задача, которую воркер сразу подберет на
реализацию.

## Business/Profile automation path

Для Telegram Business/Secretary-сообщений включается отдельная policy через
`TELEGRAM_PROFILE_AUTOMATION_*`. Сообщение допускается к автоматизации только
после проверок business connection, owner allowlist, chat allowlist, возраста
сообщения и Telegram rights.

Если Digital Twin выключен или недоступен, а сообщение распознано как
`create_task_draft`, service может создать pending action для owner private chat
при `TELEGRAM_PROFILE_AUTOMATION_REQUIRE_OWNER_APPROVAL=true`. Owner
подтверждает создание уже в приватном чате с ботом, после чего используется тот
же `TaskTrackerClient.createTask`.

Ограничение не меняется: созданная task остается неисполняемой, пока не получит
execution fields и status `ready`.

## Digital Twin path

`TELEGRAM_DIGITAL_TWIN_*` - перспективное направление поверх Telegram Assistant,
но текущая реализация является conversational/session layer:

- хранит per-contact Codex thread/session state;
- отвечает через `assistantCodex.answerAsDigitalTwin`;
- ведет audit/delivery state;
- соблюдает owner consent, allowlists, Telegram business rights и retention.

Когда business message проходит policy и Digital Twin включен с auto-reply,
service сначала передает сообщение в `prepareDigitalTwinTurn`. Это происходит
раньше ветки `create_task_draft`. То есть активный Digital Twin перехватывает
eligible business message как conversational turn, а не как команду постановки
задачи.

В Digital Twin сейчас нет tool boundary, который позволял бы безопасно сказать:
`создай draft задачи`, показать owner confirmation, затем записать task в
internal tracker и отправить ее в execution queue. Такой boundary нужен до
production-включения сценария "TWIN создает задачи".

## Что нужно добавить для полного end-to-end сценария

Есть два безопасных product path.

### Консервативный intake path

1. Telegram или Digital Twin создает только triage task после подтверждения.
2. Человек в internal UI/API выбирает repository profile, уточняет
   `repoPathKey`, `baseBranch`, `queue`, acceptance criteria и риски.
3. Человек переводит задачу в `ready`.
4. `InternalWorkerOrchestrator` подбирает задачу обычным claim flow.

Этот путь уже близок к текущему поведению и минимизирует риск случайной
автоматической разработки из чата.

### Auto-queue path после подтверждения

1. Добавить явную policy: какие Telegram actors/roles могут создавать
   executable tasks.
2. На подтверждении резолвить repository profile в `repositoryName`,
   `repoPathKey`, `baseBranch` и `queue`.
3. Если profile найден однозначно и policy разрешает auto execution, создавать
   task с execution fields и затем переводить ее в `ready` через тот же domain
   workflow, который уже проверяет readiness.
4. Если profile неоднозначен или риски выше лимита, оставлять задачу в `triage`.
5. Для Digital Twin добавить отдельный explicit action: Twin может предложить
   task draft, но owner должен подтвердить sender, title, description,
   repository profile и auto-execution decision до записи task.

## Implementation gaps to track

- Runtime path должен явно применять `TELEGRAM_TASK_CREATION_ENABLED`; сейчас
  config и preflight знают про флаг, но task creation branch нужно проверять
  отдельно перед созданием pending action.
- Runtime path должен явно соблюдать `TELEGRAM_CONFIRM_WRITE_ACTIONS`, если
  этот флаг должен быть не только config/preflight контрактом.
- Для auto-queue нужен mapping из Telegram context в repository profile, а не
  только `TELEGRAM_DEFAULT_REPOSITORY`.
- Для TWIN нужен tool/intent boundary с owner approval; нельзя позволять
  conversational answer напрямую создавать executable tasks.
- Нужны тесты на private bot -> ready task, business owner approval -> ready
  task, Digital Twin proposed task -> owner confirmation, disabled task
  creation, ambiguous repository profile и отсутствие execution fields.

## Existing verification points

Релевантные существующие тесты:

- `tests/telegramAssistant.test.ts` проверяет pending action, подтверждение и
  вызов `createTask` для Telegram draft;
- `tests/telegramAssistant.smoke.test.ts` покрывает smoke-path создания задачи
  через подтверждение;
- `tests/telegramProfileAutomation.test.ts` покрывает profile automation и
  Digital Twin session behavior;
- `tests/taskTrackerQueue.test.ts` покрывает claim queue semantics.

При изменении этого сценария минимально запускайте:

```bash
npx vitest run tests/telegramAssistant.test.ts tests/telegramProfileAutomation.test.ts tests/taskTrackerQueue.test.ts
npm run typecheck
```
