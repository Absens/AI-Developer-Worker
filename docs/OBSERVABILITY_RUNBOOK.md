# Наблюдаемость, API, метрики и уведомления

Воркер может запускать локальный HTTP-сервер для liveness/readiness, Prometheus-метрик, событий и человеческого API/Angular UI. По умолчанию observability **выключена**. Не публикуйте служебный интерфейс в Интернет без проверенной авторизации и reverse proxy.

## Быстрое включение

Для локального запуска начните с loopback-интерфейса:

```env
OBSERVABILITY_ENABLED=true
OBSERVABILITY_HOST=127.0.0.1
OBSERVABILITY_PORT=9464
METRICS_ENABLED=true
ALERTS_ENABLED=false
```

```bash
curl http://localhost:9464/healthz
curl http://localhost:9464/readyz
curl http://localhost:9464/metrics
```

При `WORKER_PREFLIGHT_ONLY=true` сервер не запускается; при `WORKER_RUN_ONCE=true` доступен лишь в течение одного цикла.

## HTTP endpoints

| Endpoint | Для чего |
| --- | --- |
| `/healthz` | Быстрая проверка «процесс жив»; без запросов в Tracker/GitLab/Codex |
| `/readyz` | Готовность: возвращает `503` до завершения проверок или при shutdown |
| `/metrics` | Метрики Prometheus при `METRICS_ENABLED=true` |
| `/tasks` | Angular-консоль (при включении UI и наличии собранных assets) |
| `/api` | JSON API для human workflow; требует авторизации |

Неизвестные пути возвращают `404`, неподдерживаемые HTTP-методы — `405`.

## Основная конфигурация

```env
OBSERVABILITY_ENABLED=false
OBSERVABILITY_HOST=127.0.0.1
OBSERVABILITY_PORT=9464
OBSERVABILITY_BASE_URL=http://localhost:9464
OBSERVABILITY_STRICT_STARTUP=true
OBSERVABILITY_REDACT_MAX_CHARS=4000
METRICS_ENABLED=true
METRICS_PATH=/metrics
HEALTH_PATH=/healthz
READY_PATH=/readyz
```

Консоль и API:

```env
TASK_TRACKER_UI_ENABLED=false
TASK_TRACKER_UI_PATH=/tasks
TASK_TRACKER_UI_API_PATH=/api
TASK_TRACKER_UI_ASSET_PATH=/tasks/assets
TASK_TRACKER_UI_STATIC_DIR=web/dist/task-tracker-console/browser
TASK_TRACKER_HUMAN_AUTH_MODE=trusted_proxy
TASK_TRACKER_TRUSTED_USER_HEADER=x-task-tracker-user
TASK_TRACKER_TRUSTED_ROLE_HEADER=x-task-tracker-role
TASK_TRACKER_AGENT_TOKEN=
TASK_TRACKER_SYSTEM_TOKEN=
```

Для `TASK_TRACKER_PROVIDER=internal` путь `/tasks` обслуживается из Angular bundle. Если assets отсутствуют, UI отдаёт `503`, но JSON API продолжает работать. `index.html` и SPA fallback не кэшируются, versioned JS/CSS получают immutable caching; отсутствующие assets возвращают `404`.

Локальная разработка:

```bash
npm --prefix web ci
npm run web:dev
```

Angular dev server: `http://127.0.0.1:4200/tasks`, прокси `/api` → backend `http://127.0.0.1:9464`. Production-сборка:

```bash
npm run web:typecheck
npm run web:test
npm run web:build
npm run web:e2e
```

Docker-образ собирает Angular и задаёт `TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser`.

**Авторизация:** Angular не сохраняет bearer tokens. Для локальной отладки допустим ограниченный localhost mode; для удалённого доступа — защищённый reverse proxy, который удаляет входящие от клиента служебные заголовки и самостоятельно добавляет проверенные идентификатор/роль, либо подставляет разрешённый `Authorization`. Роль, показанная в UI, **не заменяет backend access control**. Не допускайте прямого доступа к HTTP API с поддельными `x-task-tracker-*` заголовками.

## События

```env
OBSERVABILITY_EVENT_STORE=memory
OBSERVABILITY_EVENT_RETENTION=1000
# OBSERVABILITY_EVENT_STORE=file
# OBSERVABILITY_EVENT_STORE_FILE=/workspace/ai-developer-events/events.jsonl
```

Для file store используется ограниченный JSONL snapshot, который загружается при старте. Ошибки сохранения учитываются в `ai_developer_observability_dropped_events_total`, но не останавливают обработку задач.

Task timeline во внутреннем трекере — детальный аудит задачи. Observability event store — сводная телеметрия fleet. При изменении событий синхронизируйте [lifecycleMapping.ts](../src/observability/lifecycleMapping.ts), чтобы совпадали task ID, worker, repository, lease, переходы и категории ошибок.

## Уведомления и алерты

```env
ALERTS_ENABLED=false
ALERT_CHANNELS=webhook
ALERT_WEBHOOK_URL=https://alerts.example.test/webhook
ALERT_MIN_SEVERITY=warning
ALERT_DEDUP_WINDOW_SECONDS=900
ALERT_QUEUE_BLOCKED_CYCLES=3
ALERT_CODEX_TIMEOUT_WINDOW_SECONDS=3600
ALERT_CODEX_TIMEOUT_THRESHOLD=3
ALERT_VALIDATION_FAILURE_WINDOW_SECONDS=3600
ALERT_VALIDATION_FAILURE_THRESHOLD=3
```

Доступные каналы: `webhook`, `slack` (`SLACK_WEBHOOK_URL`), `telegram` (`TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`). Канал однонаправленных alerts **отличается** от Telegram Assistant, которому нужен отдельный `TELEGRAM_ASSISTANT_BOT_TOKEN` и права на операции с задачами.

## Fleet YAML

```yaml
observability:
  enabled: true
  host: 0.0.0.0
  port: 9464
  baseUrl: http://worker-1.internal:9464
  strictStartup: true
  metrics:
    enabled: true
    path: /metrics
  health:
    path: /healthz
    readinessPath: /readyz
alerts:
  enabled: true
  minSeverity: warning
  channels:
    - type: webhook
      urlEnv: ALERT_WEBHOOK_URL
```

Адрес `0.0.0.0` в примере допустим только внутри защищённой сети/прокси, не как публичный сервис.

## Prometheus

Пример scrape:

```yaml
scrape_configs:
  - job_name: ai-developer
    static_configs:
      - targets: [worker-1:9464, worker-2:9464]
```

Полезные метрики:

- `ai_developer_worker_state`, `ai_developer_active_task`, `ai_developer_tasks_total`;
- `ai_developer_task_duration_seconds_bucket`, `ai_developer_codex_duration_seconds_bucket`;
- `ai_developer_validation_gate_failures_total`, `ai_developer_queue_depth`, `ai_developer_alerts_total`;
- `ai_developer_task_tracker_queue_depth`, `ai_developer_task_tracker_claim_latency_seconds_bucket`;
- `ai_developer_task_tracker_lease_conflicts_total`, `ai_developer_task_tracker_sync_lag_seconds`;
- `ai_developer_task_tracker_cleanup_deleted_total`, `ai_developer_task_tracker_proposals`.

Telegram-метрики (без текста сообщений и ключей задач в labels): `telegram_updates_received_total`, `telegram_updates_processed_total{outcome}`, `telegram_messages_sent_total{outcome}`, `telegram_intents_total{intent,outcome}`, `telegram_codex_turns_total{intent,outcome}`, `telegram_pending_actions_total{state}`, `telegram_rate_limited_total{direction}`, `telegram_processing_duration_seconds{intent}`, `telegram_queued_messages_total{outcome}`, `telegram_notification_delivery_total{outcome}` и `telegram_polling_lease_skipped_total`.

Для здоровья Bot API следите за `telegram_updates_processed_total{outcome="failure"}` и `telegram_rate_limited_total`; для зависших подтверждений — `telegram_pending_actions_total{state="pending"}`. `direction="inbound"` относится к getUpdates/webhook и пользовательским лимитам, `outbound` — к sendMessage/callback retry-after.

Не добавляйте в метрики/labels имена задач, команды, локальные пути, тексты логов и секреты.

## Docker и проверки доступности

Пример Compose-фрагмента:

```yaml
ports:
  - "9464:9464"
environment:
  OBSERVABILITY_ENABLED: "true"
  OBSERVABILITY_HOST: "0.0.0.0"
  OBSERVABILITY_PORT: "9464"
  METRICS_ENABLED: "true"
```

Для Kubernetes liveness: `GET /healthz`; readiness: `GET /readyz` на порту `9464`.

## Telegram Assistant: эксплуатация и безопасность

Preflight проверяет `TELEGRAM_ASSISTANT_ENABLED`, token, совместимость с internal tracker, HTTPS base URL для webhook и доступность route. Предупреждает об пустых allowlists, отсутствии ролей записи, `groupMode=all_messages`, небезопасном Business/Profile auto-reply и неправильной конфигурации Q&A.

- Chat/user allowlist разрешает чтение, действия на запись требуют отдельных developer/operator/admin user IDs и подтверждения.
- Ссылки на сообщения, pending actions и subscriptions хранятся в течение `TELEGRAM_CONVERSATION_RETENTION_DAYS` и очищаются по расписанию.
- Доступ к внутренним данным из Business chats возможен только при согласии владельца, `can_reply`, правилах чтения и Q&A.
- `TELEGRAM_PROFILE_AUTOMATION_REQUIRE_OWNER_APPROVAL=true` — рекомендуемая политика для реального окружения.
- `TELEGRAM_DIGITAL_TWIN_*` создаёт долговременные Codex-сессии; заранее определите согласие, persona version, reset policy, параметры шифрования и `TELEGRAM_DIGITAL_TWIN_REDACTED_RETENTION_DAYS` / `TELEGRAM_DIGITAL_TWIN_FULL_TEXT_RETENTION_DAYS`.
- События задач (`ready`, `claimed`, `awaiting_human`, MR, failed, done) возвращаются подписчикам без сырых логов. Ответ в активном Telegram prompt соотносится с конкретным вопросом задачи и при необходимости требует `TELEGRAM_CONFIRM_WRITE_ACTIONS=true`.

Документация Telegram Bot API: [getUpdates](https://core.telegram.org/bots/api#getupdates), [setWebhook](https://core.telegram.org/bots/api#setwebhook), [sendMessage](https://core.telegram.org/bots/api#sendmessage), [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery), [privacy mode](https://core.telegram.org/bots/features#privacy-mode), [Business users](https://core.telegram.org/bots/features#business-users).

## Отключение

```env
ALERTS_ENABLED=false
OBSERVABILITY_ENABLED=false
```

Если human API/UI настроен отдельно, изменение `OBSERVABILITY_ENABLED` может быть недостаточным для его отключения: проверьте `TASK_TRACKER_UI_ENABLED` и reverse proxy. При отключении HTTP-сервера не удаляйте данные PostgreSQL или историю задач.

