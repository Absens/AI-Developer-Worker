# Внутренний трекер: PostgreSQL и эксплуатация

В production-режиме `TASK_TRACKER_PROVIDER=internal` состояние задач и выполнение очереди хранятся в PostgreSQL. Режим `yandex` остаётся отдельным вариантом runtime и не требует этой БД.

## Включение

```env
TASK_TRACKER_PROVIDER=internal
TASK_TRACKER_STORAGE=postgres
TASK_TRACKER_DATABASE_URL=postgres://tracker:YOUR_PASSWORD@postgres:5432/ai_developer_tasks
TASK_INTAKE_MODE=standalone
YANDEX_SYNC_ENABLED=false
```

Указанный URL **пример**. Включайте отдельного пользователя и надёжный пароль; значение `tracker:tracker` из демонстрационного `compose.yaml` нельзя оставлять для внешне доступной production-БД.

Если Yandex выступает источником/зеркалом задач:

```env
TASK_INTAKE_MODE=yandex_integration
YANDEX_SYNC_ENABLED=true
TRACKER_TOKEN=...
TRACKER_ORG_ID=...
TRACKER_STATUS_MAP_FILE=./config/trackerStatusMap.example.json
```

Также поддерживаются `hybrid`, `system_only` и `ai_proposed`; настройку смотрите в [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md).

## Миграции и preflight

Перед первым запуском и после обновления версии:

```bash
npm run tracker:migrate
npm run preflight
```

Preflight выявляет недоступность базы, отсутствующую метаинформацию миграций, ожидающие миграции, отсутствие обязательных таблиц/индексов и поддержки атомарного `FOR UPDATE SKIP LOCKED` для claim очереди.

## Хранение и очистка

```env
TASK_TRACKER_RETENTION_RAW_LOG_DAYS=30
TASK_TRACKER_RETENTION_ARTIFACT_DAYS=30
TASK_TRACKER_RETENTION_FAILED_ARTIFACT_DAYS=90
TASK_TRACKER_RETENTION_HISTORY_DAYS=365
TASK_TRACKER_CLEANUP_ENABLED=true
TASK_TRACKER_CLEANUP_INTERVAL_SECONDS=3600
TASK_TRACKER_METRICS_ENABLED=true
TASK_TRACKER_REDACTION_ENABLED=true
```

Cleanup удаляет устаревшие сырые логи, метаданные validation artifacts, старые released leases и неактуальные proposals. Краткая история задач и решений остаётся в `tasks`, `task_events`, `task_decisions` и связанных таблицах.

## Доступ к UI/API

Для интерфейса за пределами localhost необходима настроенная авторизация. Используйте `TASK_TRACKER_SYSTEM_TOKEN` / `TASK_TRACKER_AGENT_TOKEN` и проверенную конфигурацию reverse proxy. Не совмещайте `TASK_TRACKER_HUMAN_AUTH_MODE=localhost` с публичным `TASK_TRACKER_UI_BIND_HOST=0.0.0.0`.

## Резервные копии

Создавайте бэкапы встроенными средствами PostgreSQL, храните их отдельно от основного сервера и периодически проверяйте восстановление.

```bash
pg_dump "$TASK_TRACKER_DATABASE_URL" --format=custom --file=ai-developer-tasks.dump
```

Для демонстрационного Compose:

```bash
docker compose exec postgres pg_dump -U tracker -d ai_developer_tasks --format=custom --file=/tmp/ai-developer-tasks.dump
docker compose cp postgres:/tmp/ai-developer-tasks.dump ./ai-developer-tasks.dump
```

## Восстановление

Восстанавливайте в заранее подготовленную пустую/изолированную базу: `--clean` удаляет существующие объекты и данные.

```bash
pg_restore --clean --if-exists --dbname "$TASK_TRACKER_DATABASE_URL" ai-developer-tasks.dump
npm run preflight
```

Для Compose (после остановки воркера и проверки целевой БД):

```bash
docker compose cp ./ai-developer-tasks.dump postgres:/tmp/ai-developer-tasks.dump
docker compose exec postgres pg_restore --clean --if-exists -U tracker -d ai_developer_tasks /tmp/ai-developer-tasks.dump
docker compose run --rm worker npm run preflight
```

## Откат режима

Можно временно вернуться к `TASK_TRACKER_PROVIDER=yandex`, отключив internal cleanup/metrics. **Не удаляйте PostgreSQL volume**, пока не завершены перенос задач, сверка статусов и сохранение audit history.

Подробнее о миграциях — [README схемы](../src/integrations/internalTracker/migrations/README.md).

