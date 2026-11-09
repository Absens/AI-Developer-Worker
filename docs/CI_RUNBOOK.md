# CI: автоматические проверки перед слиянием

Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Что запускается

| Job | Проверки |
| --- | --- |
| `Backend` | Node.js 22, `npm ci`, `npm run typecheck`, `npm test`, `npm run build` |
| `Angular` | `npm ci` в корне и `npm --prefix web ci`, ChromeHeadless, Angular typecheck/unit tests/build |
| `Browser E2E` | Оба lockfile, Chromium с системными зависимостями, production build Angular и Playwright против существующего mock API |
| **`CI required`** | Успешен, только когда все три job завершились с `success` |

`npm test` уже включает `tests/worker.smoke.test.ts` и Telegram smoke; отдельный повтор того же smoke-набора не нужен. Браузерные тесты используют `web/e2e/mock-console-server.mjs`, а не production API. CI не проверяет реальную авторизацию Codex, живой GitLab/Yandex или production PostgreSQL и не заменяет эксплуатационный preflight.

Результаты `failure`, `cancelled`, `skipped`, отсутствующий job или некорректный JSON не считаются успехом. Контракт workflow и 68 комбинаций gate проверяются в [`tests/ciWorkflow.test.ts`](../tests/ciWorkflow.test.ts).

## Когда запускается

- Открытие/обновление PR в `main` (включая draft).
- Push в `main`, включая результат merge.
- `merge_group` для совместимости с merge queue.
- Ручной `workflow_dispatch`, после появления workflow в default branch.

Path-фильтров нет: документационный PR также получает обязательный статус, иначе protection может ожидать никогда не запустившуюся проверку. Устаревший прогон того же PR/event/ref отменяется; новый проверяет текущую ревизию.

## Окружение и безопасность

GitHub-hosted `ubuntu-24.04`, Node.js 22. Только `contents: read`, `persist-credentials: false`; actions закреплены полным SHA. У завершающего job нет разрешений и нет checkout. Не используются `pull_request_target`, secrets, preflight, запуск воркера или обращения к платным моделям. Для PR из fork могут потребоваться обычные разрешения запуска Actions со стороны владельца.

Время каждого job ограничено. Npm cache содержит скачанные пакеты, а не `node_modules`; установка выполняется через lockfile. Версии приложения и зависимостей этим PR не обновляются.

## Диагностика сбоя

Откройте Actions → CI → проблемный job/step. `CI required` выводит состояния всех трёх зависимостей; он не скрывает исходную причину. При ошибке E2E сохраняется artifact `browser-e2e-<run_id>-<run_attempt>` с HTML-отчётом, trace и скриншотами из `web/playwright-report/` и `web/test-results/`. Срок хранения — 7 дней; скрытые файлы и весь checkout не загружаются.

При падении проверки исправляйте причину; не добавляйте `continue-on-error`, `|| true` или исключения тестов ради зелёного статуса. Отсутствие Chrome или невозможность загрузить Chromium — ошибка окружения, а не причина пропускать тесты.

## Как включить защиту main

**Workflow не активирует защиту ветки автоматически.** Изменение settings требует администратора; токен рабочего CI специально не получает таких полномочий.

После первого успешного прогона:

1. Settings → Rules → Rulesets: создайте активное правило для `refs/heads/main` (или эквивалентное Branch protection).
2. Включите **Require a pull request before merging** и **Require status checks to pass**.
3. Добавьте точное имя проверки **`CI required`**, источник — GitHub Actions. Не переименовывайте его без синхронного обновления ruleset.
4. Включите **Require branches to be up to date before merging**, запрет force-push и удаления `main`. Проверьте bypass-список: обход правил не должен быть случайно доступен всем.
5. Обязательное одобрение reviewer включайте только при наличии второго участника. Для единственного владельца обязательный чужой approval заблокирует его собственные PR.

Проверьте на тестовом PR: красный `CI required` блокирует merge; после исправления и зелёного прогона merge разрешён. Если проверка ещё не появилась в списке, дождитесь первого завершённого run, а не создавайте правило с другим именем.

## Локальное воспроизведение

Backend:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Frontend:

```bash
npm --prefix web ci
npm run web:typecheck
npm run web:test
npm run web:build
```

E2E (из корня; Chromium устанавливается из версии Playwright lockfile):

```bash
(cd web && npx --no-install playwright install --with-deps chromium)
npm --prefix web run e2e -- --reporter=list,html --forbid-only
```

Только контракт CI:

```bash
npx vitest run tests/ciWorkflow.test.ts
```

Это проверки самого AI-Developer. Quality gates чужих целевых репозиториев, изоляция executor и SHA-bound validation — отдельные изменения, не часть этого этапа.

## Источники

[GitHub: required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [Playwright CI](https://playwright.dev/docs/ci-intro). Контроль зависимых job использует `always()` + проверку каждого `needs.*.result`.
