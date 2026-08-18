# Telegram Competitor Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an allowed Telegram user send a Wildberries product link, receive a concise asynchronous summary, and download the full Codex competitor report as HTML.

**Architecture:** Reuse the existing Telegram assistant-turn lifecycle and queue. Add a small marketplace-research domain module, opt-in per-run Codex web search, a structured Codex service method, and a Telegram service route; do not introduce a new persistence model.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Telegram Bot API adapter, Codex CLI.

**Spec:** `docs/superpowers/specs/2026-08-18-telegram-competitor-research-design.md`

## Global Constraints

- Support only Wildberries product-card URLs in the first version.
- Reuse `TELEGRAM_PROJECT_QA_ENABLED` and the existing Codex Q&A daily limit.
- Exclude Telegram Business/Profile automation from the MVP.
- Keep Codex read-only and enable web search only for competitor research runs.
- Do not add a database migration, generic research queue, marketplace parser, UI, or image generation.

---

### Task 1: Wildberries reference and intent routing

**Files:**
- Create: `src/domain/telegramAssistant/competitorResearch.ts`
- Modify: `src/domain/telegramAssistant/types.ts`
- Modify: `src/domain/telegramAssistant/intentRouter.ts`
- Modify: `src/domain/telegramAssistant/index.ts`
- Test: `tests/telegramCompetitorResearch.test.ts`
- Test: `tests/telegramIntentRouter.test.ts`

**Interfaces:**
- Produces: `extractWildberriesProductReference(text: string): WildberriesProductReference | undefined`
- Produces: intent name `competitor_research`

- [ ] Write failing URL parser tests for canonical, query-string, no-scheme, invalid-host, and non-product URLs.
- [ ] Run the new parser test and verify it fails because the module does not exist.
- [ ] Implement the minimal parser and canonical reference type.
- [ ] Run the parser test and verify it passes.
- [ ] Write failing intent tests for plain links, natural-language requests, and task-creation precedence.
- [ ] Run the intent tests and verify the new cases fail.
- [ ] Add `competitor_research` to the intent union and router, then export the domain functions.
- [ ] Run both focused test files and verify they pass.

### Task 2: Per-run Codex web search

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/integrations/codex/runner.ts`
- Test: `tests/codexRunner.test.ts`

**Interfaces:**
- Produces: `CodexRunOptions.webSearch?: boolean`
- Behavior: exactly one global `--search` before `exec` when enabled

- [ ] Write a failing runner test that requests web search and inspects launched CLI arguments.
- [ ] Run the focused test and verify it fails because `--search` is absent.
- [ ] Add the option and minimal argument-injection helper with deduplication.
- [ ] Run `tests/codexRunner.test.ts` and verify it passes.

### Task 3: Structured competitor research Codex method

**Files:**
- Modify: `src/domain/telegramAssistant/competitorResearch.ts`
- Modify: `src/domain/telegramAssistant/assistantCodex.ts`
- Modify: `src/domain/telegramAssistant/index.ts`
- Test: `tests/telegramCompetitorResearch.test.ts`
- Test: `tests/telegramAssistantCodex.test.ts`

**Interfaces:**
- Produces: `buildCompetitorResearchPrompt(reference)`
- Produces: `COMPETITOR_RESEARCH_OUTPUT_SCHEMA`
- Produces: `TelegramAssistantCodexService.researchMarketplaceCompetitors(input)`
- Returns: `{ report: string; threadId?: string; timedOut?: boolean }`

- [ ] Write failing prompt/schema tests that assert Russian report requirements, source citation, uncertainty, and no fabricated metrics.
- [ ] Implement the prompt, schema, and output parser minimally.
- [ ] Write failing Codex service tests for read-only + web search + schema options, structured parsing, plain-text fallback, and timeout.
- [ ] Implement `researchMarketplaceCompetitors()` using the shared timeout wrapper.
- [ ] Run both focused test files and verify they pass.

### Task 4: Asynchronous Telegram delivery

**Files:**
- Modify: `src/domain/telegramAssistant/competitorResearch.ts`
- Modify: `src/domain/telegramAssistant/service.ts`
- Test: `tests/telegramAssistant.test.ts`

**Interfaces:**
- Produces: `buildCompetitorResearchTelegramResponse(summary, reference)`, `buildCompetitorResearchHtmlReport(...)`, and a chunked text fallback
- Consumes: `assistantCodex.researchMarketplaceCompetitors()`

- [ ] Write a failing service test that sends a Wildberries URL and expects an immediate acknowledgement plus a later concise summary and HTML document.
- [ ] Add the Codex method to the service dependency contract and route the new intent.
- [ ] Implement prepare/run/complete methods by reusing `TelegramAssistantTurn` and background operation patterns; add multipart `sendDocument` with text fallback.
- [ ] Run the focused service test and verify it passes.
- [ ] Add failing tests for disabled Q&A, timeout/failure notification, and no late report after cancellation.
- [ ] Implement only the missing guards and error paths.
- [ ] Run `tests/telegramAssistant.test.ts` and verify it passes.

### Task 5: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/ENV_CONFIGURATION.md`
- Delete before completion: `.github/workflows/export-source.yml`

- [ ] Document the Wildberries-link flow and required existing Telegram Q&A settings.
- [ ] Remove the temporary artifact-export workflow.
- [ ] Run `npm run typecheck`.
- [ ] Run `npx vitest run tests/telegramCompetitorResearch.test.ts tests/telegramIntentRouter.test.ts tests/codexRunner.test.ts tests/telegramAssistantCodex.test.ts tests/telegramAssistant.test.ts`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Review the final diff for secrets, unintended scope, and temporary files.
