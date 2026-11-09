# CI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Проверять backend, Angular и E2E перед слиянием без доступа к production.
**Architecture:** Один GitHub Actions workflow, три независимых job, общий fail-closed gate `CI required`.
**Tech Stack:** GitHub Actions, Node.js 22, npm ci, Vitest, Angular/Karma, Playwright.
**Spec:** `docs/superpowers/specs/2026-11-09-ci-foundation-design.md`

## Global Constraints

- Не менять runtime, lockfile, sandbox и production credentials.
- Только read-only token, официальные actions по SHA, без path-фильтров.
- Документация на русском. Ветка реализации — `ci/foundation`, не `main`.

## Review Focus

- Пропущенная/отменённая зависимость не должна давать зелёный gate.
- Неизвестный/пустой результат и некорректный JSON должны завершаться ошибкой.
- Оба lockfile устанавливаются в UI job, браузеры доступны явно.
- PR из fork не должен получать secrets или writable checkout credentials.
- E2E сбой сохраняет диагностику; workflow не скрывает ошибки через continue-on-error.

## Задачи

- [x] Написать проверки YAML и общей проверки; подтвердить отказ до появления workflow.
- [x] Добавить `.github/workflows/ci.yml` и регрессионный тест `tests/ciWorkflow.test.ts`.
- [x] Проверить permissions, SHA, триггеры и отрицательные сценарии `CI required`.
- [x] Добавить `docs/CI_RUNBOOK.md` с командами, границами проверок и точной настройкой protection.
- [x] Создать PR и проверить первый удалённый прогон. После каждого нового commit сверять checks именно его ревизии.
- [ ] Администратор включает protection для `main`: обязательный `CI required`, PR-only, актуальность ветки, запрет force-push/deletion.

## Условия исполнения

Локальный контейнер не разрешает DNS GitHub/npm. Работа идёт в отдельном staging-каталоге и новой remote-ветке через GitHub connector; это не полный checkout. Полный запуск тестов выполняется в GitHub Actions. Первый run 42604215442 на commit a4b9915f22aa2d9127d2b2551834fe2f04660c15: Backend, Angular, Browser E2E, CI required — success. Результаты последующих запусков публикуются в PR. Отсутствие административного API нельзя обходить выдачей workflow расширенного токена.
