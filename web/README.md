# Консоль задач (Angular/PrimeNG)

Это веб-интерфейс внутреннего task tracker. Он показывает задачи, историю исполнения и действия человека, используя API Node.js-воркера.

## Разработка

Сначала запустите Node.js observability/human API на `127.0.0.1:9464`, затем:

```bash
npm --prefix web ci
npm run web:dev
```

Angular dev server доступен по `http://127.0.0.1:4200/tasks`. Запросы `/api` проксируются к backend через `web/proxy.conf.json`.

## Проверки и сборка

```bash
npm run web:typecheck
npm run web:test
npm run web:build
npm run web:e2e
```

Браузерные E2E-тесты используют Playwright и требуют установленного browser runtime. Они проверяют сценарии задач, статусы с учётом ролей, переходы по глубоким ссылкам, базовую доступность и адаптивность.

Production-сборка находится в `web/dist/task-tracker-console/browser`. Чтобы Node.js выдавал её по `/tasks`:

```env
TASK_TRACKER_UI_STATIC_DIR=web/dist/task-tracker-console/browser
```

## Аутентификация

Angular-клиент **не хранит bearer-токены**. Используйте разрешённый localhost-режим для разработки или закрытый reverse proxy, который проверяет пользователя и передаёт доверенные заголовки/авторизацию на backend. Нельзя публиковать UI/API с произвольно подставляемыми клиентом служебными заголовками.

Общие правила доступа и запуска — в [руководстве по наблюдаемости](../docs/OBSERVABILITY_RUNBOOK.md) и [конфигурации](../docs/ENV_CONFIGURATION.md).

