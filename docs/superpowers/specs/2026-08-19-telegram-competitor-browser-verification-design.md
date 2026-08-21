# Telegram Competitor Research Browser Verification Design

## Context

The first live competitor-research run accepted a Wildberries URL but could not read the source card. Codex then inferred the product from search results and produced a plausible report for an unverified product. This is unacceptable because every competitor, SEO, content, and positioning conclusion depends on identifying the exact source card first.

The worker currently gives competitor research `--search`, which is useful for discovery but is not a JavaScript-capable browser. Codex already supports MCP servers through `CODEX_HOME/config.toml`, so the smallest reliable next step is to provide a real Chromium session through the official Microsoft Playwright MCP server.

## Goal

Give non-interactive Codex competitor-research turns a browser capable of loading dynamic Wildberries pages and make exact source-card verification a hard prerequisite for generating or delivering a competitor report.

## Non-goals

- Building a dedicated Wildberries API/parser adapter.
- Guaranteeing access when Wildberries returns CAPTCHA, geo restrictions, or blocks automation.
- Persisting browser sessions, cookies, or user credentials.
- Adding browser access to Telegram Business/Profile automation.
- Generating card images or modifying marketplace data.

## Architecture

### Browser sidecar

Docker Compose adds a `playwright` service based on the official `mcr.microsoft.com/playwright/mcp` image. It runs headless Chromium as a long-lived Streamable HTTP MCP endpoint at `http://playwright:8931/mcp`.

The browser uses isolated in-memory contexts. The worker does not install Chromium and does not mount Codex credentials into the Playwright container.

### Managed Codex MCP configuration

A focused startup script manages only a delimited block in `${CODEX_HOME}/config.toml`:

```toml
# BEGIN AI_WORKER_PLAYWRIGHT_MCP
[mcp_servers.playwright]
url = "http://playwright:8931/mcp"
enabled = false
required = true
startup_timeout_sec = 30
tool_timeout_sec = 180
default_tools_approval_mode = "approve"
enabled_tools = [
  "browser_navigate",
  "browser_wait_for",
  "browser_snapshot",
  "browser_network_requests",
  "browser_network_request",
  "browser_take_screenshot",
  "browser_close",
]
# END AI_WORKER_PLAYWRIGHT_MCP
```

The script preserves all user configuration outside the managed block and is idempotent. `PLAYWRIGHT_MCP_ENABLED=true` installs the block and validates its URL, but the server remains disabled by default. `CliCodexRunner` enables it through a one-run `--config mcp_servers.playwright.enabled=true` override only for competitor research. Disabling the feature removes the managed block without touching unrelated settings.

### Research output contract

The Codex structured output gains a required `sourceVerification` object:

```ts
interface CompetitorResearchSourceVerification {
  status: "verified" | "failed";
  requestedProductId: string;
  resolvedProductId: string | null;
  productTitle: string | null;
  brand: string | null;
  evidence: string[];
  failureReason: string | null;
}
```

The prompt requires Codex to use Playwright before web search, open the exact URL, wait for dynamic loading, inspect the accessibility snapshot, and inspect network requests if the DOM is insufficient. Search results cannot establish source-card identity.

A result is application-verified only when:

- `status === "verified"`;
- `requestedProductId` equals the requested article;
- `resolvedProductId` equals the requested article;
- `productTitle` is non-empty;
- `failureReason` is `null`;
- `evidence` contains at least one concrete browser-derived item that includes the exact requested article;
- the Codex JSONL stream contains successful `mcp_tool_call` records for the configured `playwright` server: `browser_navigate` plus either `browser_snapshot` or `browser_network_request`.

`CliCodexRunner` captures completed MCP calls as redacted execution metadata. This prevents a model from satisfying the structured schema by merely claiming it used the browser.

### Delivery gate

If verification fails or the structured output is malformed:

- the Telegram turn completes as failed;
- the user receives a concise message that the exact source card could not be confirmed and the analysis was stopped;
- no competitor summary is presented as a valid analysis;
- no HTML report is generated or uploaded;
- the metric outcome is `unverified` rather than `success`.

Timeouts and infrastructure exceptions keep their existing failure behavior.

## Data flow

```text
Telegram WB URL
  -> start background competitor turn
  -> Codex + Playwright MCP opens exact WB URL
  -> DOM/network evidence confirms exact article and product
     -> verified: web search + competitor analysis -> summary + HTML
     -> failed: stop -> verification failure message only
```

## Security

- Playwright MCP is exposed only on the internal Compose network; no host port is published.
- The allowlist exposes only navigation, waiting, snapshot, network inspection, screenshot, and close tools.
- Unsafe arbitrary-code tools, file upload, form filling, and state-changing interactions are not exposed.
- Browser page text and network bodies remain untrusted input in the prompt.
- The browser uses isolated sessions and no persistent profile.
- MCP is marked `required` so research fails closed when the browser service cannot initialize.

## Compatibility and rollout

`PLAYWRIGHT_MCP_ENABLED` defaults to `false`, preserving existing non-Compose behavior. The standard Compose deployment configures the disabled-by-default server and provides the sidecar. Only competitor research enables it for one Codex invocation, preserving developer-worker, review, project-Q&A, and Digital Twin behavior.

The change can be tested without live credentials through unit tests for config management, prompt/schema parsing, verification logic, and Telegram delivery gates. A real Wildberries/Codex/Telegram smoke test remains mandatory before production rollout.

## Success criteria

- Codex sees the allowed Playwright tools in non-interactive `codex exec` runs.
- A browser-confirmed card produces the existing summary plus HTML report.
- A card that cannot be confirmed never produces a competitor report or guessed product identity.
- Existing project Q&A, developer-task execution, and Telegram flows remain unchanged.
