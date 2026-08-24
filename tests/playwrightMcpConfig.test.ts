import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  configurePlaywrightMcpConfig,
  PLAYWRIGHT_MCP_MANAGED_BEGIN,
  PLAYWRIGHT_MCP_MANAGED_END,
} from "../scripts/configure-playwright-mcp.mjs";

const tempDirs: string[] = [];

const createCodexHome = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "playwright-mcp-config-"));
  tempDirs.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("configurePlaywrightMcpConfig", () => {
  it("preserves unrelated Codex config and appends a narrow managed server block", async () => {
    const codexHome = await createCodexHome();
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model = "gpt-5.6-codex"',
        "",
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        "",
      ].join("\n"),
      "utf8",
    );

    await configurePlaywrightMcpConfig({
      codexHome,
      enabled: true,
      url: "http://playwright:8931/mcp",
    });

    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.6-codex"');
    expect(config).toContain("[mcp_servers.docs]");
    expect(config).toContain(PLAYWRIGHT_MCP_MANAGED_BEGIN);
    expect(config).toContain("[mcp_servers.playwright]");
    expect(config).toContain('url = "http://playwright:8931/mcp"');
    expect(config).toContain("enabled = false");
    expect(config).toContain("required = true");
    expect(config).toContain('default_tools_approval_mode = "approve"');
    expect(config).toContain('"browser_navigate"');
    expect(config).toContain('"browser_snapshot"');
    expect(config).toContain('"browser_network_requests"');
    expect(config).toContain('"browser_network_request"');
    expect(config).not.toContain("browser_run_code");
    expect(config).not.toContain("browser_click");
    expect(config).toContain(PLAYWRIGHT_MCP_MANAGED_END);
  });

  it("is idempotent and replaces a stale managed block", async () => {
    const codexHome = await createCodexHome();

    await configurePlaywrightMcpConfig({
      codexHome,
      enabled: true,
      url: "http://old-playwright:8931/mcp",
    });
    await configurePlaywrightMcpConfig({
      codexHome,
      enabled: true,
      url: "http://playwright:8931/mcp",
    });

    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config.match(new RegExp(PLAYWRIGHT_MCP_MANAGED_BEGIN, "g"))).toHaveLength(1);
    expect(config.match(/\[mcp_servers\.playwright\]/g)).toHaveLength(1);
    expect(config).not.toContain("old-playwright");
    expect(config).toContain('url = "http://playwright:8931/mcp"');
  });

  it("removes only the managed block when disabled", async () => {
    const codexHome = await createCodexHome();
    await writeFile(
      join(codexHome, "config.toml"),
      [
        "approval_policy = \"never\"",
        PLAYWRIGHT_MCP_MANAGED_BEGIN,
        "[mcp_servers.playwright]",
        'url = "http://stale:8931/mcp"',
        PLAYWRIGHT_MCP_MANAGED_END,
        "",
        "[mcp_servers.other]",
        'url = "https://other.example/mcp"',
        "",
      ].join("\n"),
      "utf8",
    );

    await configurePlaywrightMcpConfig({
      codexHome,
      enabled: false,
      url: "http://playwright:8931/mcp",
    });

    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain("[mcp_servers.other]");
    expect(config).not.toContain(PLAYWRIGHT_MCP_MANAGED_BEGIN);
    expect(config).not.toContain("[mcp_servers.playwright]");
  });

  it.each([
    "file:///tmp/mcp",
    "playwright:8931/mcp",
    "http://",
    "https://user:secret@example.com/mcp",
  ])("rejects unsafe or malformed MCP URL %s", async (url) => {
    const codexHome = await createCodexHome();

    await expect(configurePlaywrightMcpConfig({
      codexHome,
      enabled: true,
      url,
    })).rejects.toThrow(/PLAYWRIGHT_MCP_URL/);
  });
  it("runs the managed MCP configurator after Codex auth bootstrap", async () => {
    const entrypoint = await readFile(
      join(process.cwd(), "scripts", "docker-entrypoint.sh"),
      "utf8",
    );

    expect(entrypoint).toMatch(/^#!\/bin\/sh\n/);
    expect(entrypoint).not.toContain("\r");
    expect(entrypoint.indexOf("configure-playwright-mcp.mjs")).toBeGreaterThan(
      entrypoint.indexOf("Bootstrapping CODEX_HOME"),
    );
    expect(entrypoint).toContain('node /workspace/scripts/configure-playwright-mcp.mjs');
  });

});


describe("Playwright MCP Docker Compose wiring", () => {
  it("runs a pinned isolated browser sidecar on the internal Compose network", async () => {
    const compose = parseYaml(await readFile(join(process.cwd(), "compose.yaml"), "utf8")) as {
      services?: Record<string, Record<string, unknown>>;
    };
    const playwright = compose.services?.playwright as {
      image?: string;
      entrypoint?: string[];
      command?: string[];
      ports?: unknown;
      healthcheck?: { test?: string[] };
    } | undefined;

    expect(playwright).toBeDefined();
    expect(playwright?.image).toBe("mcr.microsoft.com/playwright/mcp:v0.0.79");
    expect(playwright?.entrypoint).toEqual(["node"]);
    expect(playwright?.command).toEqual(expect.arrayContaining([
      "/app/cli.js",
      "--headless",
      "--browser",
      "chromium",
      "--no-sandbox",
      "--isolated",
      "--block-service-workers",
      "--image-responses",
      "omit",
      "--allowed-hosts",
      "playwright:8931,playwright,localhost,127.0.0.1",
      "--port",
      "8931",
      "--host",
      "0.0.0.0",
    ]));
    expect(playwright?.ports).toBeUndefined();
    expect(playwright?.healthcheck?.test?.join(" ")).toContain("8931");
  });

  it("enables the required MCP endpoint only for the worker service", async () => {
    const compose = parseYaml(await readFile(join(process.cwd(), "compose.yaml"), "utf8")) as {
      services?: Record<string, {
        environment?: Record<string, string>;
        depends_on?: Record<string, { condition?: string }>;
      }>;
    };
    const worker = compose.services?.worker;

    expect(worker?.environment?.PLAYWRIGHT_MCP_ENABLED).toBe("true");
    expect(worker?.environment?.PLAYWRIGHT_MCP_URL).toBe(
      "http://playwright:8931/mcp",
    );
    expect(worker?.depends_on?.playwright?.condition).toBe("service_healthy");
    expect(compose.services?.migrate?.environment?.PLAYWRIGHT_MCP_ENABLED).toBeUndefined();
  });
});
