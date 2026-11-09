# Миграции внутреннего трекера

Миграции PostgreSQL создают схему internal task tracker. Ранние этапы `Phase 7A/7B` добавляют базовые таблицы, атомарную очередь `task_leases` и `idempotency_keys`. Последующие миграции покрывают execution records, интеграцию с Yandex, AI proposals и индексы/метаданные очистки.

## Применение

```bash
npm run tracker:migrate
npm run preflight
```

Номера применённых миграций хранятся в `internal_tracker_schema_migrations`. Production preflight обнаруживает отсутствие истории миграций, невыполненные миграции, недостающие индексы и отсутствие транзакционного `FOR UPDATE SKIP LOCKED`.

## Восстановление очереди

Expired, но ещё не released lease не должен навсегда блокировать очередь. В PostgreSQL claim-транзакции такие leases помечаются released до вставки нового lease. Частичные уникальные индексы защищают только активные записи.

**Не редактируйте уже применённые миграции.** Добавляйте новую миграцию и проверяйте совместимость со старой схемой, резервное копирование и порядок rollout.

Эксплуатационные инструкции — [PostgreSQL runbook](../../../../docs/INTERNAL_TRACKER_POSTGRES_RUNBOOK.md).

