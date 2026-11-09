# Интеграционные тесты настоящего PostgreSQL

Команда: `npm run test:postgres`. В GitHub Actions она выполняется в обязательном job **PostgreSQL integration** с одноразовым сервисом PostgreSQL 16. `CI required` не может стать успешным, если этот job завершился ошибкой, был отменён или пропущен.

## Что проверяется

| Область | Проверяемый контракт |
| --- | --- |
| Миграции | Пустая схема, штатный migration runner, checksum, повторный запуск без изменений |
| Operational preflight | Отсутствие метаданных, ожидающая миграция, отсутствие индекса блокируют готовность |
| Одна задача, два воркера | Только один claim; разные pg.Pool и реальные backend PID |
| Один checkout | Две задачи не получают активные repository leases одновременно |
| Разные checkout | Независимые репозитории могут обрабатываться одновременно |
| Блокировка строки | Удерживаемый в другой транзакции `FOR UPDATE` не блокирует выбор свободной задачи; проверяется `SKIP LOCKED` |
| TTL и heartbeat | Истёкшие leases можно заменить; продлённые сохраняют владение |
| Старые полномочия | Старый worker/token не может обновить или освободить новый lease |
| Повторные операции | Release и claim с idempotency key не создают дубликаты |
| Переподключение | После закрытия пулов сохраняются задача, вопрос, ревизии, validation, MR и активные leases |

Используются production `PostgresTaskTrackerClient`, `runInternalTrackerMigrations` и `assertInternalTrackerOperational`. SQL-запросы не подменяются. Для TTL инъецируются часы клиента, чтобы тест не зависел от `sleep`; транзакции, соединения, блокировки и ограничения PostgreSQL настоящие.

## Изоляция и защита локального запуска

- Команда не загружает корневой `.env`. Требуется явно заданный `TASK_TRACKER_TEST_DATABASE_URL`.
- Допускаются только loopback-хосты (`127.0.0.1`, `localhost`, `::1`), имя БД с суффиксом `_test`, без query/fragment в URL. Это предохранитель от ошибки, **не доказательство**, что база одноразовая: не используйте production или туннель к нему.
- Каждый тест создаёт уникальную схему `ai_ci_<random>` и использует свой `search_path`. После теста закрываются пулы и удаляется **только эта сгенерированная схема**.
- Не используйте общую рабочую БД. Нужен отдельный локальный контейнер и пользователь с правом создания/удаления тестовых схем. При аварийном прекращении процесса схема может остаться до удаления одноразового контейнера.
- GitLab, Tracker, Codex и платные модели не вызываются. Сервисный пароль из workflow — демонстрационный пароль одноразовой БД, не production secret.

## Локальный запуск

Из корня репозитория установите зависимости и запустите отдельный контейнер:

```bash
npm ci
docker run --rm -d --name ai-developer-postgres-test -e POSTGRES_DB=ai_developer_ci_test -e POSTGRES_USER=tracker -e POSTGRES_PASSWORD=tracker -p 127.0.0.1:55432:5432 postgres:16-alpine
docker exec ai-developer-postgres-test pg_isready -U tracker -d ai_developer_ci_test
```

Продолжайте после успешного `pg_isready`. Bash:

```bash
TASK_TRACKER_TEST_DATABASE_URL=postgresql://tracker:tracker@127.0.0.1:55432/ai_developer_ci_test npm run test:postgres
```

PowerShell:

```powershell
$env:TASK_TRACKER_TEST_DATABASE_URL = "postgresql://tracker:tracker@127.0.0.1:55432/ai_developer_ci_test"
npm run test:postgres
Remove-Item Env:TASK_TRACKER_TEST_DATABASE_URL
```

После проверки остановите созданный для неё контейнер:

```bash
docker stop ai-developer-postgres-test
```

Суффикс `*.integration.ts` и отдельный `vitest.postgres.config.ts` отделяют набор от обычного `npm test`. Это позволяет запускать unit/smoke без БД, **но не делает PostgreSQL необязательным в CI**. Старые условные PostgreSQL-сценарии в обычном наборе не являются заменой этому job и не активируются массово.

## Почему отсутствие БД не станет зелёным статусом

`scripts/run-postgres-tests.ts` отказывает при отсутствии/небезопасном URL и сначала выполняет `SELECT 1`. Затем запускает только выделенный интеграционный набор. Ненулевой код, тайм-аут, отсутствие или повреждение JSON-отчёта считаются ошибкой. В отчёте должны быть реальные успешные assertions, совпадающие со счётчиком тестов, без skipped/todo/failed. `test.only` запрещён. Защитный runner дополнительно покрыт unit-тестами, включая реальные неуспешные subprocess-запуски без URL и с недоступной БД.

## Границы покрытия

Переподключение означает закрытие всех пулов и создание новых соединений с другим PostgreSQL backend PID. Это **не** убийство процесса worker, не перезапуск сервера PostgreSQL и не имитация сетевого разрыва. Не проверяются потеря heartbeat во время выполнения Codex, остановка исполнения при потере lease, чужая запись в checkout и production backup/restore. Эти сценарии требуют следующего изменения runtime и отдельных fault-injection тестов.

Production runtime, миграции, sandbox, зависимости и настройки авторизации этот PR не меняет. Подробнее: [CI](CI_RUNBOOK.md), [эксплуатация БД](INTERNAL_TRACKER_POSTGRES_RUNBOOK.md), [политика валидации](VALIDATION_POLICY.md).
