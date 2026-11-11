# Managed settings — Implementation Plan

> Use superpowers:executing-plans; TDD перед каждой функциональной частью.

**Goal:** подключение проектов через интерфейс и обновление runtime на границе задач.
**Architecture:** PostgreSQL registry + settings service + безопасный GitLab/workspace adapter + managed runtime + существующий human API/Angular.
**Tech Stack:** TypeScript, pg, Node crypto, Angular/PrimeNG, Vitest; без новых dependencies.
**Spec:** docs/superpowers/specs/2026-11-11-managed-settings.md

## Global Constraints

Не менять main. Старый env/fleet режим совместим. Токены только шифрованно, ключ извне. Сырые внешние ошибки и токены не отдавать. URL по allowlist, пути только под workspace root. Текущие задания не менять посреди исполнения. Русские пояснения.

## Review Focus

Секреты/редиректы; потерянные concurrent edits; пауза и старые сессии; symlink/path traversal; нулевой реестр и отсутствующий Codex; failure одного проекта.

## Tasks

- [x] 1. Registry/model/service: tests RED → schema/store/version/crypto/validation → GREEN.
- [x] 2. GitLab/checkouts: tests RED → no redirects, bounded commands, managed workspace → GREEN.
- [x] 3. HTTP/bootstrap/runtime: tests RED → admin routes, empty boot, apply snapshots → GREEN.
- [ ] 4. Angular: подключение, выбор репозитория, создание/редактирование, статусы, project selector → types/build/browser checks.
- [ ] 5. PostgreSQL integration tests, полный regression, документация и пакет патча.

## Delivery

GitHub connector в этой сессии read-only. Готовить локальный patch относительно PR22; не утверждать push или зелёный remote CI. Исходный snapshot: eb0be082 (merge ref main940077b4 + PR22 9c829f27). Временный snapshot workflow удалить из итогового diff.

## Проверка реализации 11 ноября 2026

Backend: 1296 passed, 17 прежних условных DB-тестов skipped, 80 файлов. Backend typecheck/build, Angular typecheck/build и компиляция web spec-файлов успешны. Добавлены 56 backend-регрессий; также включено исправление EPIPE при раннем завершении дочернего процесса, воспроизведённое отдельным тестом.

Шаг 4: UI реализован и собирается; browser unit/E2E не подтверждены — Chromium блокирует локальную навигацию (`ERR_BLOCKED_BY_ADMINISTRATOR`). Шаг 5: добавлены пять настоящих PostgreSQL integration-сценариев, но БД в рабочей среде недоступна, strict runner корректно отказался пропускать прогон. До получения зелёного обязательного CI изменения не готовы к merge.

Ручной review выполнен; независимый reviewer не запускался. Опубликованной реализации в GitHub нет: подготовлен патч к существующему Draft PR #22.
