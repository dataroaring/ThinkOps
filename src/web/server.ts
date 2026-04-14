import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { Config } from "../config.js";
import type { Orchestrator, OrchestratorEvent } from "../orchestrator.js";

export function startDashboard(orchestrator: Orchestrator, config: Config): void {
  const port = config.dashboardPort;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    try {
      if (path === "/") {
        return await serveDashboard(res, config);
      }
      if (path === "/api/status") {
        return jsonResponse(res, orchestrator.getStatus());
      }
      if (path === "/api/agents") {
        return jsonResponse(res, orchestrator.getActiveAgents());
      }
      if (path === "/api/connectors") {
        return jsonResponse(res, orchestrator.getConnectorStats());
      }
      if (path.startsWith("/api/audit/")) {
        const name = decodeURIComponent(path.slice("/api/audit/".length));
        const log = await orchestrator.getAuditLog(name);
        const entries = parseAuditEntries(log);
        return jsonResponse(res, entries);
      }
      if (path === "/api/loops") {
        return jsonResponse(res, orchestrator.getLoopStats());
      }
      if (path === "/api/tools") {
        const tools = await orchestrator.getTools();
        return jsonResponse(res, tools);
      }
      if (path === "/api/skills") {
        const skills = await orchestrator.getSkills();
        return jsonResponse(res, skills);
      }
      if (path === "/api/events") {
        return handleSSE(res, orchestrator);
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      console.error("[dashboard] request error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  server.listen(port, () => {
    console.log(`[dashboard] listening on http://localhost:${port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[dashboard] port ${port} in use — dashboard disabled`);
    } else {
      console.error("[dashboard] server error:", err.message);
    }
  });
}

async function serveDashboard(res: ServerResponse, config: Config): Promise<void> {
  const htmlPath = resolve(import.meta.dirname!, "dashboard.html");
  try {
    const raw = await readFile(htmlPath, "utf-8");
    const html = raw.replace(/\{\{BRAND_NAME\}\}/g, config.brandName);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Dashboard HTML not found");
  }
}

function jsonResponse(res: ServerResponse, data: unknown): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function handleSSE(res: ServerResponse, orchestrator: Orchestrator): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send buffered events as initial burst
  const recent = orchestrator.getRecentEvents();
  for (const event of recent) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // Stream new events
  const onEvent = (event: OrchestratorEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  orchestrator.events.on("event", onEvent);

  // Keepalive every 15s
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  // Cleanup on close
  res.on("close", () => {
    orchestrator.events.off("event", onEvent);
    clearInterval(keepalive);
  });
}

interface AuditEntry {
  timestamp: string;
  type: string;
  taskId?: string;
  title?: string;
  detail?: string;
}

function parseAuditEntries(log: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of log.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const parts = line.slice(2).split(" | ");
    if (parts.length >= 2) {
      const timestamp = parts[0].trim();
      const type = parts[1].replace(/\*/g, "").trim();
      const taskId = parts[2]?.replace(/\*/g, "").trim();
      const title = parts[3]?.trim();
      const detail = parts[4]?.trim();
      entries.push({ timestamp, type, taskId, title, detail });
    }
  }
  return entries;
}
