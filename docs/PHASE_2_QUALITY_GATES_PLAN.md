# Phase 2 Quality Gates Plan

_Актуально на 2026-04-26._

## Цель

Сделать MR ближе к production-ready до review: заменить hardcoded tests/lint validation на расширяемую систему quality gates с typecheck, build, security scan, coverage и будущим visual regression.

Источник: `product_roadmap.md`, раздел `Фаза 2 - Quality Gates и публикация`.

## Результат фазы

- Validation pipeline поддерживает ordered gates и fail-fast behavior.
- `TYPE_CHECK_COMMAND` и `BUILD_COMMAND` доступны как optional gates.
- Security/SAST gates доступны через command-based interface.
- Coverage gate умеет проверять минимальный общий процент.
- Validation summary попадает в fix prompts и MR description.
- Существующие `TEST_COMMAND` и `LINT_COMMAND` остаются совместимыми.

## Scope

В фазу входят:

- расширение конфигурации;
- новая модель `QualityGate` и `QualityGateResult`;
- замена hardcoded `validateRepositoryState()` на gate runner;
- обновление fix prompts и MR description;
- parser для MVP coverage summary;
- tests для config, gate runner, orchestrator behavior и smoke flow.

В фазу не входят:

- diff coverage;
- обязательная привязка к конкретному SAST tool;
- полноценный visual regression framework для всех repo types;
- multi-repository profiles из Phase 3.

## Milestone 2.1: Type Check Gate

### Configuration

Добавить:

```env
TYPE_CHECK_COMMAND=npm run typecheck
```

Если переменная не задана, gate пропускается.

### Execution Order

Primary fail-fast order:

```text
typecheck -> lint -> tests
```

Существующие defaults сохраняются:

- `LINT_COMMAND=npm run lint`;
- `TEST_COMMAND=npm test`.

### Implementation

1. Добавить `typeCheckCommand?: string` в `AppConfig`.
2. Создать `src/domain/qualityGates.ts`.
3. Описать gate:

```typescript
interface QualityGate {
  id: string;
  label: string;
  command: string;
  required: boolean;
}

interface QualityGateResult {
  id: string;
  label: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  diagnostic: string;
}
```

4. Обновить `ValidationResult`, чтобы хранить массив gate results и общий diagnostic.
5. Обновить `buildFixPrompt()` так, чтобы Codex видел failing gate, command, stdout/stderr.

### Acceptance Criteria

- Если `TYPE_CHECK_COMMAND` задан и падает, lint/tests не запускаются.
- Если `TYPE_CHECK_COMMAND` не задан, behavior tests/lint остаётся прежним.
- Failing typecheck вызывает fix attempt.

## Milestone 2.2: Build Verification

### Configuration

Добавить:

```env
BUILD_COMMAND=npm run build
```

### Execution Order

Build запускается после primary checks:

```text
typecheck -> lint -> tests -> build
```

### Implementation

- Добавить `buildCommand?: string` в `AppConfig`.
- Добавить `build` gate в ordered gates после tests.
- В MR description Testing section показывать build status отдельно.
- В failure diagnostic указывать, что build не является test failure, но блокирует publish.

### Acceptance Criteria

- Failing build не даёт publish/push нового MR-ready state.
- Successful build попадает в validation summary.
- Existing smoke test обновлён, чтобы видеть build gate skipped или passed.

## Milestone 2.3: Security Scan

### Configuration

Добавить command-based gates:

```env
SECURITY_SCAN_COMMAND=npm audit --audit-level=high
SAST_COMMAND=semgrep ci
```

Обе переменные optional.

### Implementation

- Добавить `securityScanCommand?: string` и `sastCommand?: string`.
- Запускать после build, чтобы быстрые compile/test failures падали раньше.
- Считать non-zero exit code blocking failure.
- Не парсить scanner-specific JSON в MVP; stdout/stderr сохранять как diagnostic.

### Acceptance Criteria

- Security gate можно включить одной env переменной.
- Failing security command блокирует publish и запускает fix attempt, если попытки ещё доступны.
- Unknown scanner output не ломает отчёт.

## Milestone 2.4: Coverage Gate

### Configuration

Добавить:

```env
COVERAGE_COMMAND=npm run test:coverage -- --reporter=json
MIN_COVERAGE_PERCENT=80
COVERAGE_REPORT_FILE=coverage/coverage-summary.json
```

`COVERAGE_REPORT_FILE` optional, но предпочтителен для стабильного parsing.

### MVP Parsing Rules

Поддержать Istanbul/Vitest-style summary:

```json
{
  "total": {
    "lines": {
      "pct": 82.5
    }
  }
}
```

Fallback: если report file не задан, попытаться распарсить stdout как JSON с такой же структурой.

### Implementation

- Добавить `coverageCommand?: string`, `minCoveragePercent?: number`, `coverageReportFile?: string`.
- Coverage command запускается после tests/build/security gates.
- Если command прошёл, но coverage не распарсился, gate должен fail с actionable diagnostic.
- В validation summary указать actual coverage и threshold.

### Acceptance Criteria

- Coverage ниже threshold блокирует publish.
- Coverage выше threshold проходит.
- Missing report даёт понятный diagnostic.
- `MIN_COVERAGE_PERCENT` валидируется как число от `0` до `100`.

## Milestone 2.5: Visual Regression MVP

Visual regression зависит от repo profiles и frontend project settings, поэтому в Phase 2 делать только подготовку интерфейса:

- зарезервировать gate id `visual_regression`;
- определить command-based entrypoint:

```env
VISUAL_REGRESSION_COMMAND=npm run test:visual
VISUAL_REGRESSION_ARTIFACTS_DIR=playwright-report
```

- поддержать generic artifact path в validation summary;
- не внедрять browser-specific orchestration в worker core до Phase 3 profiles.

### Acceptance Criteria

- Если `VISUAL_REGRESSION_COMMAND` задан, command запускается как optional configured gate.
- Artifact path попадает в MR description notes.
- Нет зависимости worker core от Playwright или конкретного frontend stack.

## Gate Runner Design

### Ordered Gates

Recommended order:

```text
typecheck
lint
tests
build
security_scan
sast
coverage
visual_regression
```

### Backward Compatibility

- `TEST_COMMAND` и `LINT_COMMAND` остаются существующими config keys.
- Новые gates optional и skipped при пустых env vars.
- `ValidationResult.changed` остаётся обязательной проверкой до запуска gates.
- Diagnostic format должен остаться пригодным для existing `buildFixPrompt()`.

### Logging

Для каждого gate логировать:

- gate id;
- command;
- duration;
- status;
- truncated stdout/stderr при failure.

Не логировать секреты из env.

## Testing Plan

Добавить или обновить tests:

- `tests/config.test.ts`: parsing новых env vars и validation threshold.
- `tests/qualityGates.test.ts`: order, skip, fail-fast, diagnostics.
- `tests/orchestrator.test.ts`: failing gate вызывает fix attempt; successful gates позволяют publish.
- `tests/worker.smoke.test.ts`: smoke target проходит с skipped optional gates.

## Verification

Минимальный набор команд:

```bash
npm run typecheck
npm test
npm run test:smoke
npm run build
```

Дополнительные ручные сценарии:

1. `TYPE_CHECK_COMMAND` падает, lint/tests не запускаются.
2. `BUILD_COMMAND` падает после successful tests.
3. `SECURITY_SCAN_COMMAND` возвращает non-zero и блокирует publish.
4. Coverage ниже `MIN_COVERAGE_PERCENT` блокирует publish.
5. Все optional gates пустые, старый flow работает как раньше.

## Risks

| Risk | Mitigation |
| --- | --- |
| Gate commands сильно различаются между репозиториями | Использовать command-based interface без tool-specific assumptions. |
| Coverage JSON нестабилен | Поддержать `COVERAGE_REPORT_FILE` и явно документировать expected schema. |
| Security scanner output слишком большой | Применить существующую truncation стратегию для diagnostics. |
| Новые gates замедляют worker | Fail-fast order и optional config. |
| Visual regression требует project-specific setup | В Phase 2 оставить command-based adapter и artifacts metadata. |

## Definition of Done

- Gate runner заменяет hardcoded tests/lint validation.
- Phase 0/1 flows используют новый validation summary без регрессий.
- Documentation и `.env.example` описывают новые переменные.
- Unit и smoke tests покрывают primary gates.
- Roadmap items `2.1`, `2.2`, `2.3`, `2.4` completed; `2.5` completed как command-based MVP.
