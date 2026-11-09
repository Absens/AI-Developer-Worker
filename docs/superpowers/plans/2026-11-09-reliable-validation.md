# Reliable validation — план реализации

> Выполнение: superpowers:executing-plans; тесты до изменения runtime.

**Цель:** закрыть fail-open mandatory gates и обход проверок при восстановлении существующего MR.
**Архитектура:** усилить общий quality gate runner и направить recovery MR через обычный pipeline. Без кеша и миграций.
**Стек:** TypeScript, Vitest, существующий GitHub Actions.
**Спецификация:** `docs/superpowers/specs/2026-11-09-reliable-validation-design.md`.

## Ограничения

Не менять CI, production credentials, зависимости, lockfiles, БД и политики sandbox. Объяснения на русском. Main не изменять напрямую; отдельный PR.

## Задача 1 — регрессионные тесты

- Создать `tests/reliableValidation.test.ts`: пустые/пробельные required commands; fail-fast; optional skips; пустой/неполный/дублированный результат; timeout; recovery успешного/падающего MR и смена конфигурации после предыдущего успеха.
- Сохранить spec/plan; открыть draft PR с тестами без изменения runtime.
- Запустить текущий CI. Ожидается падение новых регрессий по описанным причинам, не ошибки типов/импортов.

## Задача 2 — исправление

- `src/domain/qualityGates.ts`: нормализовать required commands, missing command → failed, усилить success predicate, учитывать timeout.
- `src/domain/internalWorkerOrchestrator.ts`: убрать shortcut и неиспользуемый `publishExisting`; existing MR проходит общий validation/fix/publish с `outcome=reused`.
- Обновить русский runbook с поведением recovery и ограничениями.
- Прогнать весь CI, не ослабляя существующие тесты. Ожидается success backend, Angular, E2E и CI required.

## Финальная проверка

Проверить diff, сохранение окружения из #18, optional-gate совместимость, отсутствие schema/dependency изменений, успешные и отказные task transitions. Отдельно подтвердить, что SHA-кеш не добавлен и неконфигурируемые внешние изменения checkout не объявлены покрытыми. Зафиксировать реальные результаты и пропуски тестов в PR; merge оставить владельцу.
