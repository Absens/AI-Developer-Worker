# Telegram Competitor Research Design

## Goal

Add a minimal read-only research flow to the existing Telegram Assistant: an allowed user sends a Wildberries product-card URL, receives a concise chat summary, and gets the detailed competitor analysis as a self-contained HTML document after Codex finishes a web-search-backed analysis.

## Scope

The first version supports only Wildberries product links in private bot chats and already-supported groups. It reuses `TELEGRAM_PROJECT_QA_ENABLED`, `TELEGRAM_USER_CODEX_QA_DAILY_LIMIT`, the existing assistant-turn store, conversation queue, cancellation behavior, Codex timeout, observability counters, and Telegram renderer.

The first version does not add a new UI, marketplace API adapter, PostgreSQL migration, generic research queue, Ozon/Yandex support, card editing, or image generation.

## User Flow

1. An allowed user sends a Wildberries product-card URL, optionally with text such as “найди конкурентов”.
2. Telegram intent routing recognizes a valid `/catalog/<productId>` link as `competitor_research`. Explicit task-creation and task-control intents keep their existing precedence.
3. The service validates that project Q&A is enabled, the source is not a Telegram Business automation message, the Codex method is available, and the user has not exceeded the existing daily Codex limit.
4. The service creates a normal `TelegramAssistantTurn`, immediately acknowledges the request, releases the conversation lock, and performs research in the existing background-turn path.
5. Codex runs read-only with per-run web search enabled and a structured output schema containing a concise `summary` and full `report`. The prompt requires Russian output, source URLs, explicit distinction between verified facts and assumptions, and no fabricated sales, stock, or financial metrics.
6. When the turn completes, the service atomically completes the active turn, sends the concise summary to Telegram, renders the full report into a controlled self-contained HTML template, and uploads it through `sendDocument`.
7. If document delivery is unavailable or fails, the full report is chunked through the existing Telegram renderer as a text fallback. If cancellation wins, no late summary, document, or fallback report is sent.
8. Failures and timeouts mark the turn as failed and return a user-facing diagnostic when the turn is still active.

## Architecture

### URL and Report Domain Module

Create `src/domain/telegramAssistant/competitorResearch.ts` with four responsibilities:

- parse and canonicalize a Wildberries product-card reference;
- build the Codex prompt and `summary`/`report` output schema;
- render the concise summary and text fallback into Telegram blocks;
- render the full report into a safe self-contained HTML document and deterministic filename.

A canonical reference contains:

```ts
interface WildberriesProductReference {
  marketplace: "wildberries";
  productId: string;
  sourceUrl: string;
}
```

Only `wildberries.ru` and its subdomains are accepted. The canonical URL is `https://www.wildberries.ru/catalog/<productId>/detail.aspx`.

### Codex Runner

Extend `CodexRunOptions` with `webSearch?: boolean`. When true, `CliCodexRunner` adds exactly one global `--search` argument before `exec`. Search remains opt-in per run; existing worker implementation, review, and digital-twin runs do not change.

### Telegram Assistant Codex Service

Add `researchMarketplaceCompetitors()` to `TelegramAssistantCodexService`. It calls `runInitial()` with:

- `sandbox: "read-only"`;
- `webSearch: true`;
- a JSON output schema containing required `summary` and `report` strings.

The parser accepts schema-conformant JSON, remains compatible with earlier report-only JSON, and falls back to a non-empty plain final message. An empty response produces a stable failure message.

### Telegram Service

Add `competitor_research` to the intent model and route. `TelegramAssistantService` reuses the existing assistant-turn lifecycle rather than creating a separate task or research entity. The acknowledgement and concise summary use the normal Telegram message path. The full report is uploaded with a new multipart `TelegramClient.sendDocument()` method; `renderTelegramResponse()` remains the lossless text fallback when document delivery is unavailable.

Business/Profile automation is excluded from this MVP. The intended channels are the private bot and configured groups, where existing allowlists and group mention/reply policy already apply.

## Safety and Data Quality

- The external Telegram text and marketplace pages are untrusted data, not instructions.
- Codex runs in read-only sandbox mode.
- Web search is enabled only for this run.
- The prompt forbids unsupported claims and requires uncertainty to be stated.
- Reports must include source URLs for material claims.
- No secrets or local project sources are passed to competitor research.
- Existing redaction, per-user daily limits, conversation locking, cancellation, retention, and observability remain in force.

## Observability

Use existing metrics with `intent="competitor_research"`:

- `telegram_intents_total`;
- `telegram_codex_turns_total`;
- `telegram_processing_duration_seconds`;
- `telegram_rate_limited_total`;
- `telegram_messages_sent_total`;
- `telegram_documents_sent_total` for HTML upload success/failure.

No persistence-specific metric family is required for the MVP.

## Testing

Add focused Vitest coverage for:

- Wildberries URL extraction and canonicalization;
- intent precedence and invalid URLs;
- per-run `--search` placement and deduplication;
- Codex prompt/options/schema/output parsing and timeout;
- Telegram acknowledgement, asynchronous completion, concise summary delivery, multipart HTML upload, safe HTML escaping, text fallback, cancellation safety, disabled/unavailable behavior, and failure handling.

Final verification is `npm run typecheck`, the focused Telegram/Codex tests, `npm test`, and `npm run build`.
