# CI foundation: дизайн

## Цель и согласованный объём

После PR #14–16 проверять каждый PR в `main` автоматически. Пользователь согласовал первый этап — CI foundation, без изменения executor security, quality gates целевых репозиториев и бизнес-логики.

## Решение

GitHub Actions на `ubuntu-24.04`, Node.js 22. Три независимых job: backend (typecheck, весь Vitest, включающий worker/Telegram smoke, build), web (typecheck, ChromeHeadless unit tests, build), web_e2e (Chromium, production Angular build, существующий mock-server). Завершающий `CI required` успешен только при `success` всех трёх job, даже если зависимость пропущена или отменена.

Альтернативы: один последовательный job проще, но медленнее и хуже локализует ошибки; отдельные workflows без общего gate усложняют защиту ветки. Выбран один workflow с параллельными job и стабильным именем обязательной проверки.

## Ограничения

Триггеры: `pull_request` в main, `push` в main, `merge_group`, ручной запуск. Без path-фильтров и `pull_request_target`. `contents: read`, checkout без сохранения credentials, официальные actions закреплены по полным SHA; никаких production secrets, Codex API, preflight или деплоя. Зависимости — только `npm ci` из двух существующих lockfile. Тайм-ауты, отмена предыдущего прогона того же PR, E2E-артефакты только из каталогов отчётов на 7 дней.

## Приёмка и границы доказательства

Синтаксис YAML, контракт событий/permissions, отрицательные сценарии общего gate и соответствие npm scripts проверяются отдельно. Полный baseline и новый workflow должны проверяться GitHub Actions; зелёный локальный контракт не равен зелёному проекту. Настройки защиты `main` отдельны от workflow: включать `CI required` как обязательный check после первого успешного запуска, не утверждать, что наличие файла активирует protection.
