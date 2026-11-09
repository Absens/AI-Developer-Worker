# Execution Environment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; approved scope is implemented inline on security/execution-environment.

**Goal:** Изолировать передаваемые env для project/Codex/Git без изменения основного workflow.

**Architecture:** Pure builder в src/utils/executionEnvironment.ts; shell по умолчанию использует project, явный env заменяет наследование. Auth helper и Git adapter строят профильное окружение. Операторские дополнительные имена валидируются, нет wildcard или legacy inherit.

**Tech Stack:** TypeScript, Node.js 22, Vitest, существующий GitHub Actions CI.

**Spec:** ../specs/2026-11-09-execution-environment.md

## Ограничения

Не менять зависимости, sandbox CLI, БД, quality gate policy, branch protection и main. Документация по-русски. GitHub branch — изолированная область работы; локально доступна только staging-копия изменяемых файлов, полный npm прогон выполняется CI.

## Review focus

Windows casing и повторные PATH; отсутствующая/пустая env-переменная; неверный wildcard/credential allowlist; сохранность Codex OAuth/API-key пути; Git hooks/local commands без network auth env.

## 1. Зафиксировать RED

- [ ] Добавить tests/executionEnvironment.test.ts с настоящими child processes и фиктивными секретами.
- [ ] Запустить существующий CI на tests-only commit. Проверить, что ошибки именно в наследовании секретов.

## 2. Реализовать профили

- [ ] Добавить buildExecutionEnvironment(profile, overrides?, source?, platform?) и тесты системных переменных, allowlists, запрещённых ключей, Windows.
- [ ] Изменить src/utils/shell.ts: env ?? buildExecutionEnvironment("project"), без process.env overlay.
- [ ] Изменить src/integrations/codex/auth.ts: полный codex env, CODEX_HOME из config.
- [ ] Изменить src/integrations/git/service.ts: полный git env, auth только fetch/pull/push/ls-remote.
- [ ] Добавить adapter/regression-тесты; проверить preflight и quality gates через существующий общий shell.

## 3. Проверить и описать

- [ ] Документировать env migration, профили, ограничения и примеры, сослаться из docs/README.md.
- [ ] Проверить финальный diff, прогнать backend typecheck/tests/build и Angular/E2E через CI на последнем SHA.
- [ ] Обновить PR реальными результатами, оставить merge владельцу.
