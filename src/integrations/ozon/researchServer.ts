import { createServer } from "node:http";

import { extractOzonProductReference } from "../../domain/telegramAssistant/competitorResearch.js";
import {
  maxOzonInspectionResponseBytes,
  PlaywrightMcpOzonInspector,
} from "./productResearch.js";

const port = Number.parseInt(process.env.OZON_RESEARCH_PORT ?? "8933", 10);
const mcpUrl = process.env.OZON_BROWSER_MCP_URL?.trim();
if (!mcpUrl || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  throw new Error("Ozon research server configuration is invalid.");
}
const inspector = new PlaywrightMcpOzonInspector({ mcpUrl });

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/inspect") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 8_192) {
      response.writeHead(413).end();
      return;
    }
  }
  try {
    const value = JSON.parse(body) as { url?: unknown };
    const url = typeof value.url === "string" ? value.url : "";
    const reference = extractOzonProductReference(url);
    if (!reference || reference.sourceUrl !== url) {
      response.writeHead(400).end();
      return;
    }
    const inspection = await inspector.inspect(url);
    if (!inspection) {
      response.writeHead(502).end();
      return;
    }
    const payload = JSON.stringify(inspection);
    if (Buffer.byteLength(payload, "utf8") > maxOzonInspectionResponseBytes) {
      response.writeHead(502).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  } catch {
    response.writeHead(400).end();
  }
});

server.listen(port, "0.0.0.0");
