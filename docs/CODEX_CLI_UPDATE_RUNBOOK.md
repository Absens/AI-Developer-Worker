# Обновление Codex CLI: инструкция для сопровождающего

При изменении версии `@openai/codex` недостаточно пересобрать Docker: важны auth, формат JSONL, `exec`, `resume`, `review` и обработка ошибок. Эта инструкция описывает процедуру обновления без потери совместимости воркера.

В `Dockerfile` зафиксирован `@openai/codex@0.167.0`. Для воспроизводимых production-сборок указывайте точную проверенную версию.

## На какие контракты опирается воркер

1. `codex login status` возвращает код `0` при успешной авторизации.
2. `codex exec --json` выдаёт JSONL-события в `stdout`.
3. `codex exec --output-last-message <file>` сохраняет финальный ответ.
4. `thread.started.thread_id` даёт идентификатор для `codex exec resume <threadId>`.
5. `--sandbox`, `--model`, `--profile` поддерживаются запуском `exec`.
6. `codex exec --help` / `resume --help` позволяют передать `--image` для скриншотов Tracker.
7. Необязательная самопроверка использует `codex exec review` с `--base`, `--uncommitted`, `--json`, `--output-last-message`, `--skip-git-repo-check`, `--ephemeral`.

Сломанный CLI-контракт может проявиться **только во время исполнения** при успешно прошедшей TypeScript-сборке.

## Какие файлы менять вместе

- [Dockerfile](../Dockerfile) — pin версии.
- [src/config.ts](../src/config.ts) — аргументы и проверки конфигурации.
- [auth.ts](../src/integrations/codex/auth.ts) — проверка авторизации.
- [runner.ts](../src/integrations/codex/runner.ts) — запуск, JSONL и resume.
- [orchestrator.ts](../src/domain/orchestrator.ts) и [internalWorkerOrchestrator.ts](../src/domain/internalWorkerOrchestrator.ts) — интеграция runtime.
- [codexRunner.test.ts](../tests/codexRunner.test.ts), [worker.smoke.test.ts](../tests/worker.smoke.test.ts) — регрессии.
- [`.env.example`](../.env.example), [README](../README.md) и [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md) — операционные объяснения.

## Порядок обновления

### 1. Сверьте установленную и целевую версии

```bash
npm view @openai/codex@latest version
codex --version
codex --help
codex exec --help
codex exec resume --help
codex exec review --help
codex login status --help
```

Перед обновлением проверьте изменения MCP, песочницы, авторизации и non-interactive JSONL в [официальном журнале релизов Codex](https://learn.chatgpt.com/docs/changelog).

### 2. Выполните статическую проверку контракта

```bash
npm run verify:codex-cli
```

При проверке конкретной версии через npm launcher:

```bash
CODEX_CLI_COMMAND=npx CODEX_CLI_ARGS_JSON='["-y","@openai/codex@0.167.0"]' npm run verify:codex-cli
```

Проверьте наличие `exec`, `exec resume`, `review`, `--json`, `--output-last-message`, `--sandbox`, `--model`, `--profile`, `--image` и всех флагов ревью. Набор актуален для существующего в репозитории контракта; в новой версии CLI он может отличаться.

### 3. Проверьте авторизацию

```bash
codex login status
```

Воркер поддерживает собственный `CODEX_HOME` с действующей сессией или `CODEX_API_KEY` согласно текущему preflight. Один `OPENAI_API_KEY` сам по себе может быть недостаточен для прохождения preflight; для сохранения ключа в Codex CLI:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

**Не печатайте реальный API-ключ через `echo` и не переносите общий `auth.json` между активными средами.** При проблемах см. [auth troubleshooting](CODEX_AUTH_TROUBLESHOOTING.md).

### 4. Проверьте JSONL и файловый ответ

Используйте временный безопасный каталог, не production checkout:

```bash
codex exec --json --output-last-message /tmp/codex-last.txt --skip-git-repo-check "say hello"
```

Убедитесь, что: `stdout` содержит JSONL, событие `thread.started` содержит `thread_id`, итог записан в файл, ошибки имеют ожидаемые `error.message` или `message`. Если контракт изменён — обновите `src/integrations/codex/runner.ts` и тесты.

### 5. Проверьте продолжение сессии

```bash
codex exec resume <threadId> "continue"
```

Проверьте позицию `resume` в аргументах и перенос `threadId`. Изменения требуют согласованной правки runner и orchestrators.

### 6. Сверьте конфигурацию

| Переменная | Назначение |
| --- | --- |
| `CODEX_CLI_COMMAND` | Исполняемый файл или launcher |
| `CODEX_CLI_ARGS_JSON` | Глобальные аргументы **до** `exec` |
| `CODEX_EXEC_ARGS_JSON` | Аргументы самого `codex exec` |
| `CODEX_SANDBOX` | Режим sandbox |
| `CODEX_MODEL`, `CODEX_PROFILE` | Выбор модели/профиля |
| `CODEX_QUESTION_MARKER` | Маркер уточняющего вопроса |

Пример `CODEX_CLI_ARGS_JSON` — `["--search","--ask-for-approval","never"]`. Пример `CODEX_EXEC_ARGS_JSON` — `["--add-dir","/workspace/shared"]`.

При `CODEX_PROFILE=ci` Codex загружает `$CODEX_HOME/ci.config.toml` поверх базового `config.toml`. Если настройки ещё хранятся в секции `[profiles.ci]`, перенесите их в отдельный файл профиля и удалите из базового файла старую секцию и строку `profile = "ci"`. В Docker файл профиля должен быть в `CODEX_HOME` воркера. [Настройка профилей в OpenAI Docs](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles).

## Обязательные проверки перед выпуском

```bash
npm run verify:codex-cli
npm run typecheck
npm test
npm run build
npx vitest run tests/codexAuth.test.ts tests/codexRunner.test.ts tests/orchestrator.test.ts tests/worker.smoke.test.ts
```

Сборка и статическая проверка контейнера для версии, зафиксированной в репозитории:

```bash
docker build -t ai-developer-worker:codex-0.167.0 .
docker run --rm --entrypoint codex ai-developer-worker:codex-0.167.0 --version
docker run --rm --entrypoint codex ai-developer-worker:codex-0.167.0 exec --help
docker run --rm --entrypoint npm ai-developer-worker:codex-0.167.0 run verify:codex-cli
```

Live-контракт с реальной авторизацией запускайте только в одноразовой изолированной среде:

```bash
docker run --rm -e CODEX_CONTRACT_LIVE=1 -e CODEX_HOME=/tmp/codex-home -v codex-home:/tmp/codex-home --entrypoint npm ai-developer-worker:codex-0.167.0 run verify:codex-cli
```

## Диагностика таймаутов Codex в Docker

При повторных таймаутах или алерте `codex_timeouts_repeated` запустите команду из каталога Compose-проекта с работающим сервисом `worker`.

```bash
docker compose exec -T worker codex doctor --network-only --json
```

Команда использует окружение и `CODEX_HOME` запущенного контейнера. В JSON-отчёте смотрите `overallStatus` и `checks`, чтобы различить проблемы конфигурации, сетевого окружения, HTTP-доступа к провайдеру и WebSocket Responses. Флаг `--network-only` доступен с Codex CLI `0.166.0`. [Справочник Codex CLI](https://learn.chatgpt.com/docs/cli/reference#codex-doctor)

Если `doctor` проходит, а воркер продолжает получать таймауты, проверьте, что необходимые переменные прокси, TLS и адреса провайдера входят в `WORKER_CODEX_ENV_ALLOWLIST`. Воркер фильтрует окружение дочернего процесса Codex. [Окружение запуска воркера](EXECUTION_ENVIRONMENT.md)

## Риски и откат

Самые частые поломки после обновления: новый exit code `login status`, несовместимые JSONL event types, пустой `--output-last-message`, другой порядок аргументов `resume`, новые разрешения sandbox, интерактивный first-run setup и несовместимый `review`.

Сборка с предыдущей зафиксированной версией:

```bash
docker build --build-arg CODEX_CLI_VERSION=0.149.1 -t ai-developer-worker:codex-0.149.1 .
```

Использовать предыдущую версию в production можно **только если она всё ещё поддерживается и проверена**. Решение о выпуске принимается по результатам тестов, а не по факту успешной Docker-сборки.

