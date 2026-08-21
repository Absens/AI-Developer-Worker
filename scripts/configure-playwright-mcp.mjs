import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const PLAYWRIGHT_MCP_MANAGED_BEGIN =
  "# BEGIN AI_WORKER_PLAYWRIGHT_MCP";
export const PLAYWRIGHT_MCP_MANAGED_END =
  "# END AI_WORKER_PLAYWRIGHT_MCP";

const PLAYWRIGHT_MCP_ENABLED_TOOLS = [
  "browser_navigate",
  "browser_wait_for",
  "browser_snapshot",
  "browser_network_requests",
  "browser_network_request",
  "browser_take_screenshot",
  "browser_close",
];

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const managedBlockPattern = new RegExp(
  `${escapeRegExp(PLAYWRIGHT_MCP_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(PLAYWRIGHT_MCP_MANAGED_END)}\\s*`,
  "g",
);

export const configurePlaywrightMcpConfig = async ({
  codexHome,
  enabled,
  url,
}) => {
  const resolvedCodexHome = resolve(codexHome);
  const configPath = join(resolvedCodexHome, "config.toml");
  await mkdir(resolvedCodexHome, { recursive: true });

  const current = await readFile(configPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const unmanaged = current.replace(managedBlockPattern, "").trimEnd();

  if (!enabled) {
    await writeFile(configPath, unmanaged ? `${unmanaged}\n` : "", "utf8");
    return;
  }

  const normalizedUrl = normalizeMcpUrl(url);
  const managedBlock = renderManagedBlock(normalizedUrl);
  const next = unmanaged
    ? `${unmanaged}\n\n${managedBlock}\n`
    : `${managedBlock}\n`;
  await writeFile(configPath, next, "utf8");
};

const renderManagedBlock = (url) => [
  PLAYWRIGHT_MCP_MANAGED_BEGIN,
  "[mcp_servers.playwright]",
  `url = ${JSON.stringify(url)}`,
  "enabled = false",
  "required = true",
  "startup_timeout_sec = 30",
  "tool_timeout_sec = 180",
  'default_tools_approval_mode = "approve"',
  "enabled_tools = [",
  ...PLAYWRIGHT_MCP_ENABLED_TOOLS.map((tool) => `  ${JSON.stringify(tool)},`),
  "]",
  PLAYWRIGHT_MCP_MANAGED_END,
].join("\n");

const normalizeMcpUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PLAYWRIGHT_MCP_URL must be a valid HTTP(S) URL.");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "PLAYWRIGHT_MCP_URL must be an HTTP(S) URL without embedded credentials.",
    );
  }

  return parsed.toString();
};

const parseEnabled = (value) => {
  if (value === undefined || value.trim() === "") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error("PLAYWRIGHT_MCP_ENABLED must be true or false.");
};

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const enabled = parseEnabled(process.env.PLAYWRIGHT_MCP_ENABLED);
  const codexHome = process.env.CODEX_HOME || "/codex-home";
  const url = process.env.PLAYWRIGHT_MCP_URL || "http://playwright:8931/mcp";

  configurePlaywrightMcpConfig({ codexHome, enabled, url })
    .then(() => {
      console.log(
        enabled
          ? `Configured Playwright MCP at ${url} in ${codexHome}/config.toml.`
          : `Playwright MCP is disabled; removed managed config from ${codexHome}/config.toml.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
