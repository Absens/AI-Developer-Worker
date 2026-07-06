# AI Browser Testing Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional browser-driven AI testing capability so the worker can validate UI tasks by running real browser scenarios, collecting diagnostics/artifacts, and feeding failures back into the existing Codex fix loop before publishing a merge request.

**Architecture:** Keep browser automation command-based and off by default. Add a dedicated `browser_e2e` quality gate between coverage and visual regression. The worker should not depend on Playwright/Cypress/Selenium directly; target repositories provide the browser test command. The worker owns configuration parsing, validation ordering, artifact notes, preflight safety checks, and repair-loop integration.

**Tech Stack:** Node.js, TypeScript, Vitest, existing quality gate runner, existing Tracker/Internal tracker orchestration, existing Git/GitLab publish flow, target-repository browser framework such as Playwright.

---

## Context And Constraints

- Current worker already runs Codex implementation, quality gates, validation repair attempts, and MR publish. Browser testing should extend that pipeline instead of creating a separate side channel.
- Do not repurpose `visual_regression` as the long-term functional browser gate. It can be used as a temporary MVP, but the implementation should add a separate `browser_e2e` gate.
- Do not add Playwright as a root worker dependency. The worker must remain framework-agnostic; the command can be `npm run e2e`, `npm --prefix web run e2e`, `pnpm playwright test`, Cypress, Selenium, or a custom script.
- Default behavior must not change. Empty `BROWSER_E2E_COMMAND` means the gate is skipped.
- Browser tests are expensive and flaky compared to unit tests. Run them after lint/tests/build/coverage and before visual regression.
- Browser artifacts must not be committed accidentally. The existing Git service commits with `git add -A`, so any screenshots/traces/reports inside the target checkout must either be ignored by git or written outside the repository.
- Direct Yandex mode and internal tracker mode both use `runQualityGates`; shared quality gate changes should affect both paths.
- Browser tests must be deterministic enough for the repair loop. Exploratory AI clicking should be a later non-blocking stage, not the first blocking implementation.
- The first production version should validate critical paths and collect traces/screenshots on failure. It should not try to replace human QA or GitLab review.

---

## Proposed User-Facing Configuration

### Single-repository `.env`

```env
# Optional functional browser/e2e gate. Empty value skips the gate.
BROWSER_E2E_COMMAND=npm run test:e2e:critical

# Optional artifact path shown in validation summaries and MR notes.
# Must be gitignored if inside REPO_PATH, or point outside REPO_PATH.
BROWSER_E2E_ARTIFACTS_DIR=test-results/ai-e2e

# Optional preflight behavior. Default should be false/warn to avoid expensive startup checks.
PREFLIGHT_RUN_BROWSER_COMMANDS=false
```

### Fleet profile

```yaml
repositories:
  - name: warehouse-front
    repoPath: /workspace/warehouse-front
    gitlabProjectId: "123"
    baseBranch: main
    queues: ["FRONTEND"]
    tags: ["ai_dev"]

    testCommand: npm test
    lintCommand: npm run lint
    buildCommand: npm run build
    browserE2eCommand: npm run test:e2e:critical
    browserE2eArtifactsDir: test-results/ai-e2e
```

---

## Target Quality Gate Order

```text
typecheck
lint
tests
build
security_scan
sast
coverage
browser_e2e
visual_regression
```

Rationale:

- Cheap deterministic checks fail first.
- Browser e2e runs only after the app is typechecked/tested/built enough to be worth launching.
- Visual regression remains last because it is usually the most artifact-heavy and environment-sensitive gate.

---

## File Structure

- Modify `src/models/types.ts`
  - Add `browserE2eCommand?: string` and `browserE2eArtifactsDir?: string` to `AppConfig`.
  - Add matching fields to repository profile/runtime config types.
- Modify `src/config.ts`
  - Parse `BROWSER_E2E_COMMAND`.
  - Parse `BROWSER_E2E_ARTIFACTS_DIR`.
  - Parse `PREFLIGHT_RUN_BROWSER_COMMANDS`.
  - Parse matching fleet config fields: `browserE2eCommand`, `browserE2eArtifactsDir`.
  - Include fields when building single-repository fleet config.
- Modify `src/domain/qualityGates.ts`
  - Add `browser_e2e` gate after coverage and before visual regression.
  - Include artifact path in result summaries and MR notes when configured.
- Modify `src/domain/preflight.ts`
  - Add optional browser command preflight.
  - Add artifact path safety validation.
- Modify `src/integrations/git/service.ts`
  - Add a safe helper if needed for checking ignored paths, for example `isPathIgnored(path: string): Promise<boolean>`.
  - Do not change existing commit behavior unless artifact safety requires an explicit pre-publish guard.
- Modify docs:
  - `.env.example`
  - `README.md`
  - `docs/ENV_CONFIGURATION.md`
  - Relevant Docker/local run docs.
- Modify tests:
  - `tests/config.test.ts`
  - `tests/qualityGates.test.ts`
  - `tests/preflight.test.ts`
  - Existing orchestrator tests only if assertions assume the exact gate list.

---

## Task 0: Baseline And Safety Review

**Files:**
- Read: `src/domain/qualityGates.ts`
- Read: `src/domain/orchestrator.ts`
- Read: `src/domain/internalWorkerOrchestrator.ts`
- Read: `src/domain/preflight.ts`
- Read: `src/config.ts`
- Read: `src/integrations/git/service.ts`
- Read: `tests/qualityGates.test.ts`
- Read: `tests/config.test.ts`
- Read: `tests/preflight.test.ts`

- [ ] **Step 1: Create implementation branch**

Run:

```powershell
git status --short --branch
git switch -c codex/browser-e2e-quality-gate
```

- [ ] **Step 2: Run current focused baseline**

Run:

```powershell
npm run typecheck
npx vitest run tests/config.test.ts tests/qualityGates.test.ts tests/preflight.test.ts
```

Expected: all tests pass before changing behavior.

- [ ] **Step 3: Confirm artifact commit risk**

Inspect `RepositoryGitService.commit()`. It currently stages all changes. If a browser test writes unignored files under `REPO_PATH`, those files can be committed. Keep this risk explicit in the implementation and tests.

---

## Task 1: Add Browser E2E Configuration

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Extend config types**

Add optional fields:

```ts
browserE2eCommand?: string;
browserE2eArtifactsDir?: string;
preflightRunBrowserCommands: boolean;
```

If there is already a global/fleet config type split, add corresponding fields to repository profile/runtime types too.

- [ ] **Step 2: Parse env vars**

Add parsing:

```ts
...(env.BROWSER_E2E_COMMAND?.trim()
  ? { browserE2eCommand: env.BROWSER_E2E_COMMAND.trim() }
  : {}),
...(env.BROWSER_E2E_ARTIFACTS_DIR?.trim()
  ? { browserE2eArtifactsDir: env.BROWSER_E2E_ARTIFACTS_DIR.trim() }
  : {}),
preflightRunBrowserCommands: parseBooleanFlag(
  env.PREFLIGHT_RUN_BROWSER_COMMANDS,
  "PREFLIGHT_RUN_BROWSER_COMMANDS",
  false,
),
```

- [ ] **Step 3: Parse fleet fields**

In repository profile parsing, support:

```yaml
browserE2eCommand: npm run test:e2e:critical
browserE2eArtifactsDir: test-results/ai-e2e
```

Propagate these fields through single-repository fleet config and repository runtime config.

- [ ] **Step 4: Add config tests**

Add tests that verify:

- env parsing works;
- default command is undefined;
- `PREFLIGHT_RUN_BROWSER_COMMANDS` defaults to `false`;
- fleet repository profile parses browser e2e fields;
- empty strings do not create config fields.

Run:

```powershell
npx vitest run tests/config.test.ts -t "browser"
```

---

## Task 2: Add `browser_e2e` Quality Gate

**Files:**
- Modify: `src/domain/qualityGates.ts`
- Modify: `tests/qualityGates.test.ts`

- [ ] **Step 1: Add gate entry**

Insert after coverage and before visual regression:

```ts
{
  id: "browser_e2e",
  label: "Browser E2E",
  command: trimOptional(config.browserE2eCommand),
  required: false,
  ...(trimOptional(config.browserE2eCommand) && config.browserE2eArtifactsDir
    ? { artifactPath: config.browserE2eArtifactsDir }
    : {}),
},
```

- [ ] **Step 2: Keep fail-fast behavior**

No special runner should be added. `runQualityGates()` should treat browser e2e exactly like other command-based gates:

- exit code `0` passes;
- non-zero exit fails;
- stdout/stderr become diagnostic;
- later gates are skipped after failure.

- [ ] **Step 3: Add quality gate tests**

Update expected order:

```text
typecheck -> lint -> tests -> build -> security_scan -> sast -> coverage -> browser_e2e -> visual_regression
```

Add tests for:

- skipped when no command configured;
- runs after coverage;
- failure blocks visual regression;
- artifact path appears in `formatQualityGateSummary()`;
- artifact path appears in `collectQualityGateNotes()`.

Run:

```powershell
npx vitest run tests/qualityGates.test.ts
```

---

## Task 3: Add Browser Artifact Safety Checks

**Files:**
- Modify: `src/domain/preflight.ts`
- Modify: `src/integrations/git/service.ts` or add a small helper module
- Modify: `tests/preflight.test.ts`

- [ ] **Step 1: Define safe artifact policy**

A configured `BROWSER_E2E_ARTIFACTS_DIR` is safe if at least one condition is true:

1. path is outside `REPO_PATH`;
2. path is inside `REPO_PATH` and gitignored;
3. path is empty/undefined.

Unsafe condition:

- path is inside `REPO_PATH`, not gitignored, and browser command is configured.

- [ ] **Step 2: Implement path check**

Use Node path resolution to determine whether the artifact directory is inside the checkout. For inside-checkout paths, use a git helper to check ignore rules, for example:

```bash
git check-ignore --quiet -- test-results/ai-e2e
```

If the path is not ignored, preflight should fail with an actionable message:

```text
BROWSER_E2E_ARTIFACTS_DIR is inside REPO_PATH but is not ignored by git. Add it to .gitignore or move artifacts outside the checkout to avoid committing screenshots/traces/reports.
```

- [ ] **Step 3: Add tests**

Cover:

- no browser command: no artifact failure;
- artifact path outside repo: pass;
- artifact path inside repo and ignored: pass;
- artifact path inside repo and not ignored: fail;
- Windows-style path handling if existing tests already cover Windows config behavior.

---

## Task 4: Add Optional Browser Command Preflight

**Files:**
- Modify: `src/domain/preflight.ts`
- Modify: `tests/preflight.test.ts`
- Modify: `docs/ENV_CONFIGURATION.md`

- [ ] **Step 1: Add preflight behavior**

If `BROWSER_E2E_COMMAND` is configured and `PREFLIGHT_RUN_BROWSER_COMMANDS=false`, add a warning:

```text
Browser E2E command is configured but not executed during preflight. Set PREFLIGHT_RUN_BROWSER_COMMANDS=true for full browser runtime validation.
```

If `PREFLIGHT_RUN_BROWSER_COMMANDS=true`, run the browser command in `REPO_PATH` and fail preflight on non-zero exit code.

- [ ] **Step 2: Keep existing target command behavior**

Do not make browser preflight part of the existing `PREFLIGHT_RUN_TARGET_COMMANDS` unless deliberately documented. Browser checks are slower and often require app/test data services, so they need a separate flag.

- [ ] **Step 3: Add focused tests**

Cover:

- warning when browser command configured but browser preflight disabled;
- pass when enabled command exits `0`;
- fail when enabled command exits non-zero;
- skipped when no command configured.

---

## Task 5: Docker And Runtime Documentation

**Files:**
- Modify: `Dockerfile` only if choosing built-in browser support
- Modify: `docs/LOCAL_DOCKER_RUN.md`
- Modify: `docs/WINDOWS_POWERSHELL_QUICKSTART.md` if relevant
- Modify: `README.md`

- [ ] **Step 1: Do not install browser dependencies by default**

Default worker image should stay lean. Browser frameworks and browser binaries belong to the target repository or to a custom worker image.

- [ ] **Step 2: Document two supported runtime strategies**

Strategy A: target repo owns Playwright browsers.

```bash
cd /workspace/project
npm ci
npx playwright install --with-deps chromium
npm run test:e2e:critical
```

Strategy B: custom worker image extends the base worker image.

```dockerfile
FROM ai-developer-worker:latest
RUN npx playwright install --with-deps chromium
```

- [ ] **Step 3: Document required mounted services**

Browser e2e often needs:

- app server;
- database/test data reset;
- auth seed user;
- stable base URL;
- disabled animations or deterministic clocks if visual assertions exist.

Include examples using `E2E_BASE_URL`, `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`, and service containers if applicable.

---

## Task 6: Documentation Updates

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/ENV_CONFIGURATION.md`

- [ ] **Step 1: Update `.env.example`**

Add browser settings near existing quality gates:

```env
# Optional functional browser/e2e gate. Runs after coverage and before visual regression.
# BROWSER_E2E_COMMAND=npm run test:e2e:critical
# BROWSER_E2E_ARTIFACTS_DIR=test-results/ai-e2e
# Set true only when preflight should execute the potentially expensive browser command.
PREFLIGHT_RUN_BROWSER_COMMANDS=false
```

- [ ] **Step 2: Update README**

Add a short section explaining:

- `TEST_COMMAND` is not enough for UI acceptance;
- `BROWSER_E2E_COMMAND` runs real browser scenarios;
- failures are fed back into the existing Codex repair loop;
- artifacts are referenced in MR notes;
- artifact directories must be gitignored or outside checkout.

- [ ] **Step 3: Update env configuration table**

Add rows:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BROWSER_E2E_COMMAND` | No | unset | Optional functional browser/e2e gate command executed in `REPO_PATH`. |
| `BROWSER_E2E_ARTIFACTS_DIR` | No | unset | Optional browser artifacts path included in validation summaries and MR notes. Must be gitignored if inside `REPO_PATH`. |
| `PREFLIGHT_RUN_BROWSER_COMMANDS` | No | `false` | Runs configured browser command during preflight when set to `true`; otherwise emits a warning. |

---

## Task 7: Prompt And Repair-Loop Guidance

**Files:**
- Review: `src/domain/promptBuilder.ts`
- Modify only if current prompts do not already tell Codex to add/update tests when appropriate

- [ ] **Step 1: Check implementation prompt**

Confirm that UI/frontend tasks tell Codex to add or update tests when useful. If missing, add guidance that for UI changes Codex should prefer stable e2e coverage for changed critical paths.

- [ ] **Step 2: Check fix prompt**

Confirm that `buildFixPrompt()` includes quality gate diagnostics as-is. Browser failures should include stdout/stderr and be actionable without a special parser.

- [ ] **Step 3: Avoid overfitting to Playwright**

Do not mention Playwright as the only supported framework in generic prompts. Use wording like “browser/e2e tests configured by the repository.”

---

## Task 8: Optional Post-MVP AI Tester Stage

This is intentionally not part of the first blocking implementation.

- [ ] **Step 1: Define an exploratory QA stage interface**

Potential config:

```env
AI_BROWSER_EXPLORATION_ENABLED=false
AI_BROWSER_EXPLORATION_COMMAND=npm run test:e2e:explore
AI_BROWSER_EXPLORATION_BLOCKING=false
```

- [ ] **Step 2: Keep exploratory output non-blocking by default**

Exploratory clicking can find valuable issues, but it is harder to reproduce. First version should attach findings/artifacts to task comments or MR notes without blocking publish.

- [ ] **Step 3: Convert stable findings into tests**

When exploratory QA finds a reproducible issue, ask Codex to convert it into a deterministic e2e test before using it as a blocking gate.

---

## Validation Plan

Run focused tests:

```powershell
npm run typecheck
npx vitest run tests/config.test.ts tests/qualityGates.test.ts tests/preflight.test.ts
```

Run full worker tests:

```powershell
npm test
```

Run local smoke with a fake browser command:

```env
BROWSER_E2E_COMMAND=node -e "console.log('browser ok')"
BROWSER_E2E_ARTIFACTS_DIR=/tmp/ai-worker-browser-artifacts
WORKER_RUN_ONCE=true
```

Run local failure-loop smoke with a failing browser command:

```env
BROWSER_E2E_COMMAND=node -e "console.error('button was not visible'); process.exit(1)"
MAX_FIX_ATTEMPTS=1
```

Expected behavior:

- validation fails at `browser_e2e`;
- `visual_regression` is skipped;
- diagnostic includes command, stdout/stderr, and exit code;
- Codex receives the diagnostic through the existing fix prompt;
- task fails after configured repair attempts if the command still fails.

---

## Rollout Plan

1. Merge implementation with browser gate disabled by default.
2. Enable in one UI-heavy repository profile only.
3. Start with 3-5 critical deterministic flows.
4. Set browser artifacts outside the checkout or ensure `.gitignore` covers them.
5. Track failure rate and runtime for at least several worker cycles.
6. Only after flakiness is acceptable, make the gate required for selected frontend queues/tags.
7. Add AI-assisted test generation as a separate improvement after deterministic gate adoption.

---

## Risks And Mitigations

- **Flaky tests:** add retries in the target repo browser config, but keep worker retries controlled through `MAX_FIX_ATTEMPTS`; do not hide persistent failures.
- **Slow validation:** run browser e2e after cheaper gates; allow per-repository configuration.
- **Accidental artifact commits:** enforce artifact path safety during preflight; require gitignored or external artifact dirs.
- **Missing browser binaries in Docker:** document custom image or target-repo installation; do not bloat the default worker image.
- **Secrets in traces/screenshots:** recommend redacted test accounts and restricted artifact retention; avoid storing production credentials in browser traces.
- **Environment coupling:** require deterministic seed data and stable `E2E_BASE_URL`; browser tests should not depend on developer-local state.
- **False confidence:** browser gate validates selected flows only. It complements unit tests, build checks, self-review, and human review; it does not prove the whole UI is correct.

---

## Definition Of Done

- `BROWSER_E2E_COMMAND` is parsed for single-repo and fleet modes.
- `browser_e2e` appears in quality gate order after coverage and before visual regression.
- Browser gate failures block publish and participate in the existing Codex repair loop.
- Browser gate artifacts are shown in validation summaries and MR notes when configured.
- Preflight warns or runs browser command depending on `PREFLIGHT_RUN_BROWSER_COMMANDS`.
- Preflight rejects unsafe unignored artifact directories inside `REPO_PATH`.
- Documentation explains configuration, Docker/runtime expectations, artifact safety, and rollout.
- Focused tests and full `npm test` pass.
