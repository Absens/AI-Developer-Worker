# Окружение дочерних процессов и миграция

## Что изменилось

В runtime worker больше нет неявного `env: { ...process.env, ...options.env }`. Перед вызовом `spawn` формируется отдельное окружение. Это уменьшает случайную передачу токенов worker в Codex и команды целевого репозитория.

**Это не песочница и не защита от произвольного кода с теми же правами пользователя.** Этот PR не меняет `CODEX_SANDBOX`, файловую систему, сеть, пользователей, права Docker или политики инструментов Codex.

## Профили

| Профиль | Где используется | Что доступно |
| --- | --- | --- |
| `project` | `runShellCommand` / `runCommand` без явного env: quality gates, test/lint/build и target commands preflight | Системный минимум и точные имена из `WORKER_PROJECT_ENV_ALLOWLIST` |
| `codex` | `getCodexShellEnv`: login status, exec, resume, review; через тот же runner — Telegram и Project Manager | Системный минимум, `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME` из AppConfig и разрешённые оператором имена |
| `git` | `RepositoryGitService` | Системный минимум, Git author/committer identity и `WORKER_GIT_ENV_ALLOWLIST`. Сгенерированный адаптером HTTP auth header добавляется **только** для `fetch`, `pull`, `push`, `ls-remote` |

Локальные `status`, `diff`, `rev-parse`, `add`, `commit`, `checkout` и `remote get-url` не получают сгенерированные `GIT_CONFIG_*` auth-переменные. Это не запрещает Git читать credential helpers из файлов и не защищает hooks/filters, которые запускаются внутри сетевых Git-операций.

Системный минимум включает PATH, HOME/пользовательские и временные каталоги, Windows SystemRoot/ComSpec/Pathext, локаль, CI и настройки терминала. Полный список — в [executionEnvironment.ts](../src/utils/executionEnvironment.ts). Произвольные токены, proxy, SDK/toolchain-переменные и настройки приложения автоматически не копируются.

`codex --help` проверки из preflight не требуют авторизации и используют минимальное `project` окружение; нестандартный wrapper, которому необходима своя переменная даже для `--help`, требует её разрешения также в этом профиле. Ручная утилита `scripts/verify-codex-cli-contract.mjs` находится вне runtime worker и не покрывается этой границей.

## Настройки оператора

Три переменные читаются builder-ом из окружения процесса worker (после стандартной загрузки `.env`). Они не являются полями задания и не должны приниматься от пользователя/модели через task payload. Они применяются ко всему worker, а не задают per-project ACL.

| Переменная | По умолчанию | Формат |
| --- | --- | --- |
| `WORKER_PROJECT_ENV_ALLOWLIST` | пусто | Точные имена через запятую |
| `WORKER_CODEX_ENV_ALLOWLIST` | пусто | Точные имена через запятую |
| `WORKER_GIT_ENV_ALLOWLIST` | пусто | Точные имена через запятую |

Пример конфигурации; укажите значения нужных переменных отдельно в окружении worker:

```dotenv
# Без секретов: параметры тестов и отдельного toolchain
WORKER_PROJECT_ENV_ALLOWLIST=NODE_ENV,APP_TEST_BASE_URL,JAVA_HOME

# Только при необходимости корпоративного proxy или своего provider endpoint
WORKER_CODEX_ENV_ALLOWLIST=HTTPS_PROXY,NO_PROXY,OPENAI_BASE_URL
WORKER_GIT_ENV_ALLOWLIST=HTTPS_PROXY,NO_PROXY,SSL_CERT_FILE
```

Минимальный пример для копирования находится в [config/execution-environment.env.example](../config/execution-environment.env.example). Он **не загружается автоматически**: перенесите нужные строки в `.env` worker или настройки контейнера. Не заменяйте им весь `.env`.

Каждое разрешение — осознанная выдача значения дочернему процессу. Например, `NPM_TOKEN` для private registry можно разрешить проектному профилю, но после этого код тестов/сборки сможет его прочитать. Предпочтительны отдельные read-only краткоживущие токены, а не учётные данные управления всей системой. Не разрешайте лишние значения всем репозиториям одного worker.

### Что не разрешается

Не поддерживаются `*`, префиксные маски, записи `NAME=value` или пустые элементы между запятыми. Неизвестное имя без значения просто не добавляется; пустое значение существующей переменной сохраняется.

Нельзя явно наследовать служебные credentials `GITLAB_*`, `TRACKER_*`, `TASK_TRACKER_*`, `TELEGRAM_*`, `WORKER_*`, `ALERT_*`, `SLACK_*`, `YANDEX_*`, `GIT_REPOSITORY_TOKEN`; нельзя передать модельные credentials в `project`/`git`. Для Codex разрешены его auth-параметры и отдельно разрешённые параметры провайдера.

Переменные внедрения исполняемого кода и конфигурации, например `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, `ENV`, `LD_*`, `DYLD_*`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG*`, отклоняются. Полный перечень в builder. Только доверенный Git-адаптер может явно сформировать свои `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` для операции с remote. Это не произвольный allowlist для Git-конфигурации.

Ошибочная конфигурация завершает построение окружения ошибкой **до запуска процесса**, без вывода значений секретов. На Windows имена сравниваются без учёта регистра; конфликтующие значения `PATH`/`Path` отклоняются, чтобы результат не зависел от порядка ключей.

## Обновление существующей установки

1. На тестовом worker сохраните текущую версию/конфигурацию. Определите только имена переменных, на которые реально опираются test/lint/build, Codex wrapper и Git; не публикуйте `printenv` со значениями.
2. Оставьте allowlists пустыми для первого прогона. Разрешайте точные необходимые имена только в соответствующем профиле. TLS/CA, proxy, Java/Go/Python, private registry и пользовательские тестовые настройки больше не наследуются автоматически.
3. Проверьте `npm run preflight` и обычную ограниченную задачу в тестовом репозитории. Помните: preflight может выполнять настроенные target commands и специальные проверки записи, а `WORKER_RUN_ONCE=true` — это **не dry-run**.
4. Проверьте реальную авторизацию Codex, Git fetch/push, качество сборок и результаты MR. Затем раскатывайте на остальные worker instances.
5. При несовместимости исправляйте конкретное разрешение. Режим широкого legacy-наследования намеренно не добавлен. При необходимости отката верните предыдущую проверенную версию, понимая, что с ней возвращается старый риск передачи окружения.

Авторизация по API-ключу и OAuth/device auth поддерживается по прежнему контракту: `CODEX_API_KEY` доступен CLI; один `OPENAI_API_KEY` не отключает проверку `login status`; `CODEX_HOME` берётся из конфигурации и не переопределяется через `extraEnv`.

## Контракт для разработчиков

`ShellOptions.env` теперь означает **полное доверенное окружение**, а не overlay. Без `env` используется `project`. Для добавления переменной при вызове helper используйте builder, иначе не будет даже гарантированного PATH:

```ts
const env = buildExecutionEnvironment("project", { APP_TEST_MODE: "isolated" });
await runCommand({ command: "node", args: ["script.js"], cwd, env });
```

Явный `env` у низкоуровневого shell считается доверенным контрактом: не передавайте туда task input или `{ ...process.env }`. Builder умеет валидировать профиль, но не является перехватчиком всех возможных OS вызовов. Новые runtime launch sites должны использовать эти helpers и иметь regression test.

## Остаточные риски

Код всё ещё может читать доступный `.env`, checkout, домашний каталог, `.npmrc`, `.gitconfig`, `auth.json`, сокеты и окружение доступных процессов; может обращаться в сеть. API-ключ модели доступен самому Codex CLI, а политика передачи его внутренним subprocess определяется CLI, не этим helper. Hooks, фильтры и helpers Git во время сетевых команд могут видеть переданный network auth. Нужны отдельные OS/container boundary, scoped credentials и защита конфигурации worker от записи исполнителя.

## Проверки

```bash
npx vitest run tests/executionEnvironment.test.ts tests/executionEnvironmentProfiles.test.ts tests/gitExecutionEnvironment.test.ts tests/codexAuth.test.ts tests/codexRunner.test.ts tests/gitService.test.ts tests/worker.smoke.test.ts
npm run typecheck
npm test
npm run build
```

Тесты используют только фиктивные sentinel secrets. Проверяются реальные дочерние процессы, точные allowlists, исключение worker/model credentials, поиск node по PATH, Windows casing, Codex config home и разделение Git network/local операций. Существующие smoke-сценарии используют реальные локальные Git-репозитории и mock Codex/Tracker/GitLab. Живые production-интеграции этим прогоном не доказываются.
