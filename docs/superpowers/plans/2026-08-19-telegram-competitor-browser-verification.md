# Telegram Competitor Browser Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Playwright MCP browser access to competitor research and block reports unless the exact Wildberries source card is verified.

**Architecture:** Run the official Playwright MCP server as an isolated Compose sidecar, inject a narrowly managed disabled-by-default Streamable HTTP MCP block into Codex config at worker startup, enable it per-run only for competitor research, extend structured research output with source verification, and enforce the verification result in application code before Telegram delivery.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Docker Compose, Codex CLI MCP, Microsoft Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-08-19-telegram-competitor-browser-verification-design.md`

## Global Constraints

- `PLAYWRIGHT_MCP_ENABLED` defaults to `false` outside the standard Compose worker.
- The managed server remains `enabled = false`; only competitor research supplies a one-run CLI override.
- Preserve all existing `${CODEX_HOME}/config.toml` content outside the managed Playwright block.
- Expose no unsafe Playwright code-execution or state-changing tools.
- Do not generate or deliver a competitor report unless the exact requested article is application-verified and backed by successful audited Playwright MCP tool calls.
- Keep Browser/Profile automation excluded from competitor research.
- Do not add Chromium or `@playwright/mcp` to the worker image or npm dependencies.

---

### Task 1: Managed Codex Playwright Configuration

**Files:**
- Create: `scripts/configure-playwright-mcp.mjs`
- Modify: `scripts/docker-entrypoint.sh`
- Create: `tests/playwrightMcpConfig.test.ts`

**Interfaces:**
- Consumes: `CODEX_HOME`, `PLAYWRIGHT_MCP_ENABLED`, `PLAYWRIGHT_MCP_URL` environment variables.
- Produces: idempotent `configurePlaywrightMcpConfig({ codexHome, enabled, url })` and CLI entrypoint behavior.

- [ ] Write tests proving unrelated TOML is preserved, repeated execution is idempotent, disabling removes only the managed block, and invalid URLs fail.
- [ ] Run `npx vitest run tests/playwrightMcpConfig.test.ts` and verify RED failures caused by the missing module.
- [ ] Implement the minimal configuration module and invoke it from `docker-entrypoint.sh` after Codex auth bootstrap.
- [ ] Re-run the focused test and verify GREEN.
- [ ] Refactor block rendering and validation without changing behavior.

### Task 2: Compose Browser Sidecar

**Files:**
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify: `docs/LOCAL_DOCKER_RUN.md`
- Modify: `docs/ENV_CONFIGURATION.md`
- Test: `tests/playwrightMcpConfig.test.ts`

**Interfaces:**
- Consumes: official Playwright MCP Docker image and internal Compose DNS.
- Produces: `playwright` service at `http://playwright:8931/mcp`, worker environment flags, and startup dependency.

- [ ] Extend tests to assert the Compose configuration includes an isolated headless Chromium MCP service, no published browser port, and worker environment wiring.
- [ ] Run the focused test and verify RED.
- [ ] Add the sidecar, healthcheck, worker dependency, environment variables, and configuration documentation.
- [ ] Run the focused test and verify GREEN.
- [ ] Run `docker compose config` when Docker is available; otherwise document the unavailable live container check.

### Task 3: Structured Browser Verification Contract

**Files:**
- Modify: `src/domain/telegramAssistant/competitorResearch.ts`
- Modify: `tests/telegramCompetitorResearch.test.ts`

**Interfaces:**
- Produces: `CompetitorResearchSourceVerification`, extended `CompetitorResearchContent`, `isCompetitorResearchSourceVerified(content, reference)`, updated output schema and prompt.

- [ ] Add tests requiring Playwright-first instructions, exact article verification, failure-stop semantics, and the extended JSON schema.
- [ ] Add parser tests for verified, failed, malformed, and legacy/plain-text outputs; legacy output must be unverified rather than accepted.
- [ ] Run `npx vitest run tests/telegramCompetitorResearch.test.ts` and verify RED.
- [ ] Implement types, schema, parser normalization, verification predicate, and prompt changes.
- [ ] Re-run the focused test and verify GREEN.

### Task 4: Codex MCP Tool-Call Audit

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/integrations/codex/runner.ts`
- Modify: `tests/codexRunner.test.ts`

**Interfaces:**
- Produces: `CodexMcpToolCall`, optional `CodexExecution.mcpToolCalls`, redacted capture of completed `mcp_tool_call` JSONL items.

- [ ] Write a failing runner test with successful and failed Playwright MCP events and assert redacted execution metadata.
- [ ] Run `npx vitest run tests/codexRunner.test.ts -t "MCP tool calls"` and verify RED.
- [ ] Implement minimal MCP event capture and result propagation.
- [ ] Re-run the focused test and verify GREEN.
- [ ] Add a logging assertion proving MCP errors cannot leak recognized secrets through event previews.

### Task 5: Codex Service and Telegram Delivery Gate

**Files:**
- Modify: `src/domain/telegramAssistant/assistantCodex.ts`
- Modify: `src/domain/telegramAssistant/service.ts`
- Modify: `tests/telegramAssistantCodex.test.ts`
- Modify: `tests/telegramAssistant.test.ts`

**Interfaces:**
- Consumes: extended competitor research content and verification predicate.
- Produces: `ResearchMarketplaceCompetitorsResult` with verification, failed-close Codex results, and no-report Telegram behavior for unverified source cards.

- [ ] Update Codex service tests so verified structured output with audited Playwright calls succeeds, while missing/failed calls and plain text/malformed output return an unverified result.
- [ ] Run `npx vitest run tests/telegramAssistantCodex.test.ts` and verify RED.
- [ ] Implement the Codex result propagation.
- [ ] Add Telegram service tests proving an unverified result sends only the verification failure message, uploads no HTML, marks the turn failed, and records `outcome=unverified`.
- [ ] Run `npx vitest run tests/telegramAssistant.test.ts -t "competitor"` and verify RED.
- [ ] Implement the application-side gate and completion/metric behavior.
- [ ] Re-run both focused suites and verify GREEN.

### Task 6: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/superpowers/specs/2026-08-18-telegram-competitor-research-design.md`

**Interfaces:**
- Produces: deployable configuration and documented operational failure modes.

- [ ] Document the browser-first flow, environment variables, safety allowlist, and failed-close behavior.
- [ ] Run `npm run typecheck`.
- [ ] Run focused tests: `npx vitest run tests/playwrightMcpConfig.test.ts tests/telegramCompetitorResearch.test.ts tests/telegramAssistantCodex.test.ts tests/telegramAssistant.test.ts tests/codexRunner.test.ts`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Review the final diff for accidental secrets, unsafe browser tools, and temporary workflow files.
