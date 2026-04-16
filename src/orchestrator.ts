import { readFile, readdir, writeFile, stat, mkdir, appendFile } from "fs/promises";
import { resolve, join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";
import { createHash } from "crypto";
import { exec as execCb } from "child_process";
import type { Config } from "./config.js";
import { spawn, resume } from "./agent/spawner.js";
import { TelegramBot } from "./telegram/bot.js";
import { watchFolder } from "./utils/file-watcher.js";
import { startDashboard } from "./web/server.js";
import { ActionTracker } from "./utils/action-tracker.js";

interface ActiveAgent {
  connector: string;
  phase: string;
  taskId?: string;
  taskTitle?: string;
  startedAt: number;
  phaseStartedAt: number;
}

interface LoopRun {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  outcome: "ok" | "error";
  error?: string;
}

interface LoopState {
  name: string;
  intervalSecs: number;
  runCount: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  running: boolean;
  history: LoopRun[];
}

const LOOP_HISTORY_SIZE = 20;
/** Max safe setTimeout delay — 32-bit signed int limit (~24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** setTimeout clamped to 32-bit max to avoid Node.js overflow warning. */
function safeTimeout(fn: () => void, ms: number): NodeJS.Timeout {
  return setTimeout(fn, Math.min(ms, MAX_TIMEOUT_MS));
}

/** Per-run logging context — every log line includes connector, taskId, and timing. */
class RunLog {
  private phaseTimings: { phase: string; durationMs: number }[] = [];
  private currentPhaseStart = 0;
  private currentPhaseName = "";

  constructor(
    private connector: string,
    private _taskId?: string,
  ) {}

  get taskId(): string | undefined { return this._taskId; }
  set taskId(id: string | undefined) { this._taskId = id; }

  private get prefix(): string {
    const tag = this._taskId
      ? `${this.connector}/${this._taskId}`
      : this.connector;
    return `${ts()} [${tag}]`;
  }

  log(msg: string): void {
    console.log(`${this.prefix} ${msg}`);
  }

  warn(msg: string): void {
    console.warn(`${this.prefix} ${msg}`);
  }

  error(msg: string, err?: unknown): void {
    console.error(`${this.prefix} ${msg}`, err instanceof Error ? err.message : (err ?? ""));
  }

  startPhase(phase: string): void {
    this.endPhase();
    this.currentPhaseName = phase;
    this.currentPhaseStart = Date.now();
    this.log(`▸ ${phase}`);
  }

  endPhase(): void {
    if (this.currentPhaseStart > 0) {
      this.phaseTimings.push({
        phase: this.currentPhaseName,
        durationMs: Date.now() - this.currentPhaseStart,
      });
      this.currentPhaseStart = 0;
      this.currentPhaseName = "";
    }
  }

  summary(status: string): string {
    this.endPhase();
    const total = this.phaseTimings.reduce((s, p) => s + p.durationMs, 0);
    return `${this.prefix} ✓ ${status} (total: ${formatDuration(total)})`;
  }
}

export interface OrchestratorEvent {
  type: "phase" | "completed" | "log" | "rate_limited" | "summary";
  connector: string;
  taskId?: string;
  timestamp: number;
  // phase events
  phase?: string;
  // completed events
  title?: string;
  result?: string;
  quality?: string;
  cost?: number;
  // log events
  message?: string;
  level?: "info" | "warn" | "error";
  // rate_limited events
  backoffUntil?: number;
  // summary events — full pipeline recap
  summary?: string;
  // size info
  inputChars?: number;
  outputChars?: number;
}

export class Orchestrator {
  private bot: TelegramBot;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private startedAt = 0;
  private activeAgents = new Map<string, ActiveAgent>();
  private totalCompleted = 0;
  private totalNoTasks = 0;

  /** Event emitter for dashboard and observability. */
  readonly events = new EventEmitter();
  private eventBuffer: OrchestratorEvent[] = [];
  private readonly EVENT_BUFFER_SIZE = 100;

  /** Per-connector rate limit backoff state. */
  private rateLimitBackoff = new Map<string, { until: number; delay: number }>();
  private readonly BACKOFF_INITIAL = 5 * 60 * 1000;   // 5 minutes
  private readonly BACKOFF_MAX = 60 * 60 * 1000;       // 1 hour

  /** Fingerprint of last ## Check output per connector — skip poll when unchanged. */
  private checkFingerprints = new Map<string, string>();

  /** Background loop tracking for dashboard. */
  private loopStates = new Map<string, LoopState>();

  /** Action tracker — learns from repeated LLM behavior. */
  private actionTracker: ActionTracker;

  constructor(private config: Config) {
    this.bot = new TelegramBot(config);
    this.actionTracker = new ActionTracker(config.vaultPath);
    this.registerCommands();
  }

  /** Emit a structured event and buffer it for new SSE connections. */
  private emitEvent(event: OrchestratorEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.EVENT_BUFFER_SIZE) {
      this.eventBuffer.shift();
    }
    this.events.emit("event", event);
  }

  /** Get buffered events for new SSE connections. */
  getRecentEvents(): OrchestratorEvent[] {
    return [...this.eventBuffer];
  }

  /** Get a status snapshot for the dashboard API. */
  getStatus(): {
    uptime: number;
    completed: number;
    noTasks: number;
    activeAgents: number;
    maxAgents: number;
    agentCli: string;
    agentModel: string;
    connectors: number;
  } {
    return {
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      completed: this.totalCompleted,
      noTasks: this.totalNoTasks,
      activeAgents: this.activeAgents.size,
      maxAgents: this.config.taskConcurrency,
      agentCli: this.config.agentCli,
      agentModel: this.config.agentModel,
      connectors: this.connectorPolls.size,
    };
  }

  /** Get active agents snapshot for the dashboard. */
  getActiveAgents(): ActiveAgent[] {
    return [...this.activeAgents.values()];
  }

  /** Get connector stats for the dashboard. */
  getConnectorStats(): { name: string; polls: number; doneCount: number }[] {
    const stats: { name: string; polls: number; doneCount: number }[] = [];
    for (const [name, polls] of this.connectorPolls) {
      stats.push({ name, polls, doneCount: this.connectorDoneCounts.get(name) ?? 0 });
    }
    return stats;
  }

  /** Get all tasks (DONE + ATTEMPTED) across all connectors for the dashboard. */
  async getAllTasks(): Promise<{
    connector: string;
    timestamp: string;
    status: "done" | "attempted" | "eval";
    taskId: string;
    title: string;
    detail: string;
    quality?: string;
  }[]> {
    const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
    const tasks: {
      connector: string; timestamp: string; status: "done" | "attempted" | "eval";
      taskId: string; title: string; detail: string; quality?: string;
    }[] = [];

    let files: string[];
    try { files = (await readdir(auditDir)).filter(f => f.endsWith(".md")); }
    catch { return []; }

    for (const file of files) {
      const connector = file.replace(/\.md$/, "");
      try {
        const content = await readFile(resolve(auditDir, file), "utf-8");
        const evalScores = new Map<string, string>();

        // First pass: collect eval scores
        for (const line of content.split("\n")) {
          if (!line.includes("| EVAL |")) continue;
          const id = line.match(/\*\*(.+?)\*\*/)?.[1];
          const quality = line.match(/quality:\s*(\d+)/)?.[1];
          if (id && quality) evalScores.set(id, quality);
        }

        // Second pass: collect DONE and ATTEMPTED entries
        for (const line of content.split("\n")) {
          if (!line.startsWith("- ")) continue;
          const parts = line.slice(2).split(" | ");
          if (parts.length < 3) continue;

          const timestamp = parts[0].trim();
          const type = parts[1].replace(/\*/g, "").trim();

          if (type === "DONE") {
            const taskId = parts[2]?.replace(/\*/g, "").trim() ?? "";
            const title = parts[3]?.trim() ?? "";
            const detail = parts[4]?.trim() ?? "";
            tasks.push({ connector, timestamp, status: "done", taskId, title, detail,
              quality: evalScores.get(taskId) });
          } else if (type === "ATTEMPTED") {
            const reason = parts[2]?.trim() ?? "";
            const snippet = parts[3]?.trim() ?? "";
            tasks.push({ connector, timestamp, status: "attempted", taskId: "",
              title: reason, detail: snippet });
          }
        }
      } catch { /* skip unreadable */ }
    }

    // Sort newest first
    tasks.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return tasks;
  }

  /** Get background loop stats for the dashboard. */
  getLoopStats(): LoopState[] {
    return [...this.loopStates.values()];
  }

  /** List tools from vault. */
  async getTools(): Promise<{ name: string; path: string; content: string }[]> {
    const dir = resolve(this.config.vaultPath, "tools");
    try {
      const files = await readdir(dir);
      const tools: { name: string; path: string; content: string }[] = [];
      for (const f of files) {
        if (!f.endsWith(".md") || f.startsWith("_")) continue;
        try {
          const content = await readFile(resolve(dir, f), "utf-8");
          tools.push({ name: f.replace(".md", ""), path: `tools/${f}`, content });
        } catch { /* skip */ }
      }
      return tools;
    } catch { return []; }
  }

  /** List skills from vault (reads _tree.md index + individual files). */
  async getSkills(): Promise<{ name: string; path: string; content: string }[]> {
    const dir = resolve(this.config.vaultPath, "skills");
    try {
      return await this.readSkillDir(dir, "skills");
    } catch { return []; }
  }

  private async readSkillDir(dir: string, prefix: string): Promise<{ name: string; path: string; content: string }[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: { name: string; path: string; content: string }[] = [];
    for (const e of entries) {
      if (e.name.startsWith("_")) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        results.push(...await this.readSkillDir(full, `${prefix}/${e.name}`));
      } else if (e.name.endsWith(".md")) {
        try {
          const content = await readFile(full, "utf-8");
          results.push({ name: e.name.replace(".md", ""), path: `${prefix}/${e.name}`, content });
        } catch { /* skip */ }
      }
    }
    return results;
  }

  /** Initialize a loop tracker. */
  private initLoop(name: string, intervalSecs: number): void {
    this.loopStates.set(name, {
      name, intervalSecs, runCount: 0,
      lastRunAt: null, nextRunAt: Date.now() + intervalSecs * 1000,
      running: false, history: [],
    });
  }

  /** Record a loop run starting. */
  private loopStart(name: string): void {
    const s = this.loopStates.get(name);
    if (s) { s.running = true; s.nextRunAt = null; }
  }

  /** Record a loop run finishing. nextIntervalMs overrides the static intervalSecs. */
  private loopFinish(name: string, startedAt: number, err?: unknown, nextIntervalMs?: number): void {
    const s = this.loopStates.get(name);
    if (!s) return;
    const now = Date.now();
    s.running = false;
    s.runCount++;
    s.lastRunAt = now;
    const intervalMs = nextIntervalMs ?? s.intervalSecs * 1000;
    s.intervalSecs = Math.round(intervalMs / 1000);
    s.nextRunAt = now + intervalMs;
    const run: LoopRun = {
      startedAt, finishedAt: now, durationMs: now - startedAt,
      outcome: err ? "error" : "ok",
      error: err instanceof Error ? err.message : err ? String(err) : undefined,
    };
    s.history.push(run);
    if (s.history.length > LOOP_HISTORY_SIZE) s.history.shift();
  }

  private registerCommands(): void {
    this.bot.onCommand("status", async () => {
      const uptime = this.startedAt ? formatDuration(Date.now() - this.startedAt) : "not started";
      const connectorCount = this.connectorPolls.size;
      const active = this.activeAgents.size;
      const max = this.config.taskConcurrency;

      const lines = [
        `*${this.config.brandName}* running for ${uptime}`,
        `Agent: ${this.config.agentCli}/${this.config.agentModel}`,
        `Connectors: ${connectorCount} | Agents: ${active}/${max}`,
        `Completed: ${this.totalCompleted} | No tasks: ${this.totalNoTasks}`,
      ];

      if (active > 0) {
        lines.push("\n*Active agents:*");
        for (const [, agent] of this.activeAgents) {
          const elapsed = formatDuration(Date.now() - agent.startedAt);
          const task = agent.taskId ? ` (${agent.taskId})` : "";
          lines.push(`  [${agent.connector}] ${agent.phase}${task} — ${elapsed}`);
        }
      }

      return lines.join("\n");
    });

    this.bot.onCommand("connectors", async () => {
      const connectors = await this.listConnectors();
      if (connectors.length === 0) return "No connectors found.";
      const lines: string[] = [];
      for (const c of connectors) {
        const auditCount = (await this.loadAuditLog(c.name)).split("\n").filter((l) => l.startsWith("- ")).length;
        lines.push(`- *${c.name}* (${auditCount} completed)`);
      }
      return lines.join("\n");
    });

    this.bot.onCommand("audit", async (args) => {
      if (!args) return "Usage: /audit <connector-name>";
      const log = await this.loadAuditLog(args.trim());
      return log || `No audit log for connector "${args.trim()}".`;
    });

    this.bot.onCommand("query", async (args) => {
      if (!args) return "Usage: /query <your question>";
      const result = await spawn(this.config, "knowledge-query", { question: args });
      return result.output;
    });

    this.bot.onCommand("lint", async () => {
      const result = await spawn(this.config, "knowledge-lint", {});
      return result.output;
    });

    this.bot.onCommand("skills", async () => {
      const treePath = resolve(this.config.vaultPath, "skills/_tree.md");
      try {
        return await readFile(treePath, "utf-8");
      } catch {
        return "No skills tree found yet.";
      }
    });

    this.bot.onCommand("ingest", async (args) => {
      if (!args) return "Usage: /ingest <source-path-or-url>";
      const result = await spawn(this.config, "knowledge-ingest", {
        source_path: args,
      });
      return result.output;
    });
  }

  async start(): Promise<void> {
    this.running = true;
    this.startedAt = Date.now();

    // Ensure vault folders exist
    console.log("[orchestrator] ensuring vault structure...");
    await this.ensureVaultStructure();

    // Start Telegram bot
    console.log("[orchestrator] connecting telegram bot...");
    try {
      await this.bot.start();
    } catch (err) {
      console.error("[orchestrator] telegram bot failed to start:", err instanceof Error ? err.message : err);
      console.error("[orchestrator] continuing without telegram. Run: thinkops --check");
    }

    // Init loop trackers
    this.initLoop("connectors", this.config.taskPollInterval);
    this.initLoop("knowledge-lint", this.config.knowledgeLintInterval);
    this.initLoop("skill-extract", this.config.skillExtractInterval);
    this.initLoop("skill-organize", this.config.skillOrganizeInterval);
    this.initLoop("tool-review", this.config.toolReviewInterval);
    this.initLoop("feedback", this.config.feedbackCheckInterval);

    // Start task loops (parallel, one per connector)
    console.log("[orchestrator] starting task loops (concurrency=%d, adaptive poll %s–%s)...", this.config.taskConcurrency, formatDuration(this.POLL_MIN_MS), formatDuration(this.POLL_MAX_MS));
    this.startTaskLoop();

    // Start knowledge watcher
    console.log("[orchestrator] starting knowledge watcher...");
    this.startKnowledgeWatcher();

    // Start skill loops
    console.log("[orchestrator] starting skill loops...");
    this.startSkillLoops();

    // Start tool review loop
    console.log("[orchestrator] starting tool review loop (every %ds)...", this.config.toolReviewInterval);
    this.startToolLoop();

    // Start feedback learning loop
    console.log("[orchestrator] starting feedback loop (every %ds)...", this.config.feedbackCheckInterval);
    this.startFeedbackLoop();

    // Start web dashboard
    console.log("[orchestrator] starting web dashboard...");
    try {
      startDashboard(this, this.config);
      console.log(`[orchestrator] dashboard at http://localhost:${this.config.dashboardPort}`);
    } catch (err) {
      console.error("[orchestrator] dashboard failed to start:", err instanceof Error ? err.message : err);
    }

    // Print startup summary
    const summary = await this.buildStartupSummary();
    console.log(summary.console);
    try {
      await this.bot.notify(summary.telegram);
      console.log("[orchestrator] startup notification sent to telegram");
    } catch (err) {
      console.error("[orchestrator] failed to send startup notification:", err instanceof Error ? err.message : err);
    }
  }

  private async buildStartupSummary(): Promise<{ console: string; telegram: string }> {
    const connectors = await this.listConnectors();
    const connectorDetails: { name: string; source: string; cwd: string; done: number }[] = [];

    for (const c of connectors) {
      const content = await readFile(c.path, "utf-8");
      const source = content.match(/##\s*Source\s*\n([\s\S]*?)(?=\n##|\n$)/)?.[1]?.trim() ?? (content.split("\n")[0]?.replace(/^#+\s*/, "").trim() || "unknown");
      const cwd = content.match(/code directory:\s*(.+)/)?.[1]?.trim() ?? "—";
      const auditLog = await this.loadAuditLog(c.name);
      const done = (auditLog.match(/\| DONE \|/g) || []).length;
      connectorDetails.push({ name: c.name, source: source.split("\n")[0], cwd, done });
    }

    const cfg = this.config;
    const divider = "─".repeat(50);

    // Console version (plain text)
    const consoleLines = [
      "",
      divider,
      `  ${cfg.brandName} — Startup Plan`,
      divider,
      "",
      `  Agent:       ${cfg.agentCli}/${cfg.agentModel}`,
      `  Concurrency: ${cfg.taskConcurrency} parallel agents`,
      `  Poll:        adaptive 10m–1h (grows when idle, resets on activity)`,
      `  Dashboard:   http://localhost:${cfg.dashboardPort}`,
      "",
      `  Connectors (${connectors.length}):`,
    ];
    if (connectorDetails.length === 0) {
      consoleLines.push("    (none found — add .md files to connectors/)");
    } else {
      for (const c of connectorDetails) {
        consoleLines.push(`    [${c.name}] ${c.done} completed`);
        consoleLines.push(`      source: ${c.source}`);
        consoleLines.push(`      cwd:    ${c.cwd}`);
      }
    }
    consoleLines.push("");
    consoleLines.push(`  Plan: poll each connector every ${cfg.taskPollInterval}s,`);
    consoleLines.push(`        run up to ${cfg.taskConcurrency} agents in parallel,`);
    consoleLines.push(`        each task → preflight → execute → critic → eval.`);
    consoleLines.push("");
    consoleLines.push(divider);

    // Telegram version (markdown)
    const teleLines = [
      `*${cfg.brandName} started*`,
      `Agent: ${cfg.agentCli}/${cfg.agentModel}`,
      `Concurrency: ${cfg.taskConcurrency} | Poll: adaptive 10m–1h`,
      `Dashboard: http://localhost:${cfg.dashboardPort}`,
      "",
      `*Connectors (${connectors.length}):*`,
    ];
    if (connectorDetails.length === 0) {
      teleLines.push("  (none)");
    } else {
      for (const c of connectorDetails) {
        teleLines.push(`  *${c.name}* — ${c.done} done`);
        teleLines.push(`    ${c.source}`);
      }
    }
    teleLines.push("");
    teleLines.push(`Plan: preflight → execute → critic → eval, ${cfg.taskConcurrency} parallel.`);
    teleLines.push(`\n${this.config.brandSignature}`);

    return { console: consoleLines.join("\n"), telegram: teleLines.join("\n") };
  }

  stop(): void {
    this.running = false;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    this.bot.stop();
    console.log("[orchestrator] stopped");
  }

  // ── Task Loops (parallel, one per connector) ──────────

  private semaphore = 0;
  private connectorPolls = new Map<string, number>();
  private connectorDoneCounts = new Map<string, number>();

  /** Adaptive poll interval per connector (ms). Grows on idle, shrinks on activity. */
  private connectorIntervals = new Map<string, number>();
  private readonly POLL_MIN_MS = 10 * 60 * 1000;  // 10 minutes
  private readonly POLL_MAX_MS = 60 * 60 * 1000;  // 1 hour

  private startTaskLoop(): void {
    // Discover connectors and start a loop for each; re-scan periodically for new ones
    const discover = async () => {
      if (!this.running) return;
      const connectors = await this.listConnectors();
      for (const c of connectors) {
        if (!this.connectorPolls.has(c.name)) {
          this.connectorPolls.set(c.name, 0);
          console.log(`${ts()} [orchestrator] starting loop for connector [${c.name}]`);
          this.startConnectorLoop(c.name, c.path);
        }
      }
      if (this.running) {
        const timer = safeTimeout(discover, this.config.taskPollInterval * 1000);
        this.timers.push(timer);
      }
    };
    discover();
  }

  private startConnectorLoop(name: string, path: string): void {
    // Initialize adaptive interval from config (clamped to bounds)
    const initialMs = Math.max(this.POLL_MIN_MS, Math.min(this.config.taskPollInterval * 1000, this.POLL_MAX_MS));
    this.connectorIntervals.set(name, initialMs);

    const poll = async () => {
      if (!this.running) return;

      // Check rate limit backoff
      const backoff = this.rateLimitBackoff.get(name);
      if (backoff && Date.now() < backoff.until) {
        const waitSecs = Math.round((backoff.until - Date.now()) / 1000);
        console.log(`${ts()} [${name}] rate-limited, backing off for ${waitSecs}s`);
        if (this.running) {
          const timer = safeTimeout(poll, Math.min(backoff.until - Date.now(), 60_000));
          this.timers.push(timer);
        }
        return;
      }

      const start = Date.now();
      this.loopStart("connectors");
      let err: unknown;
      try {
        await this.runConnector(name, path);
      } catch (e) {
        err = e;
        console.error(`${ts()} [${name}] error:`, e);
      }
      const nextMs = this.connectorIntervals.get(name) ?? this.POLL_MIN_MS;
      this.loopFinish("connectors", start, err, nextMs);
      if (this.running) {
        console.log(`${ts()} [${name}] next poll in ${formatDuration(nextMs)}`);
        const timer = safeTimeout(poll, nextMs);
        this.timers.push(timer);
      }
    };
    poll();
  }

  /** Apply exponential backoff for auth failures (reuses the rate-limit backoff map). */
  private applyAuthBackoff(name: string, run: RunLog): void {
    run.warn("auth failure — applying backoff, skipping recovery pipeline");
    const existing = this.rateLimitBackoff.get(name);
    const delay = existing ? Math.min(existing.delay * 2, this.BACKOFF_MAX) : this.BACKOFF_INITIAL;
    const until = Date.now() + delay;
    this.rateLimitBackoff.set(name, { until, delay });
    this.emitEvent({ type: "rate_limited", connector: name, timestamp: Date.now(),
      message: `Auth failure, backing off ${Math.round(delay / 60000)}min`, backoffUntil: until });
  }

  /** Shrink interval after finding tasks (reset to minimum). */
  private pollFaster(name: string): void {
    this.connectorIntervals.set(name, this.POLL_MIN_MS);
  }

  /** Grow interval after finding no tasks (1.5x, capped at max). */
  private pollSlower(name: string): void {
    const current = this.connectorIntervals.get(name) ?? this.POLL_MIN_MS;
    const next = Math.min(Math.round(current * 1.5), this.POLL_MAX_MS);
    this.connectorIntervals.set(name, next);
  }

  private async acquireSlot(name: string): Promise<boolean> {
    if (this.semaphore >= this.config.taskConcurrency) {
      console.log(`${ts()} [${name}] waiting for slot (${this.semaphore}/${this.config.taskConcurrency} active)`);
      // Wait until a slot opens, checking every 5s
      while (this.semaphore >= this.config.taskConcurrency && this.running) {
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!this.running) return false;
    }
    this.semaphore++;
    console.log(`${ts()} [${name}] acquired slot (${this.semaphore}/${this.config.taskConcurrency} active)`);
    return true;
  }

  private releaseSlot(name: string): void {
    this.semaphore--;
    console.log(`${ts()} [${name}] released slot (${this.semaphore}/${this.config.taskConcurrency} active)`);
  }

  private setPhase(name: string, phase: string, taskId?: string, taskTitle?: string): void {
    const existing = this.activeAgents.get(name);
    const agent: ActiveAgent = {
      connector: name,
      phase,
      taskId: taskId ?? existing?.taskId,
      taskTitle: taskTitle ?? existing?.taskTitle,
      startedAt: existing?.startedAt ?? Date.now(),
      phaseStartedAt: Date.now(),
    };
    this.activeAgents.set(name, agent);
    this.emitEvent({
      type: "phase",
      connector: name,
      phase,
      taskId: agent.taskId,
      timestamp: Date.now(),
    });
  }

  private async runConnector(name: string, path: string): Promise<void> {
    const pollNum = (this.connectorPolls.get(name) ?? 0) + 1;
    this.connectorPolls.set(name, pollNum);

    const run = new RunLog(name);
    run.log(`── poll #${pollNum} ──────────────────────`);

    const content = await readFile(path, "utf-8");

    // Skip empty or trivially small connectors — nothing useful to do
    if (content.trim().length < 20) {
      run.log("connector too small / empty — skipping");
      this.pollSlower(name);
      return;
    }

    // Cheap change detection: run ## Check command before any LLM call
    const changed = await this.runCheapCheck(name, content);
    if (!changed) {
      run.log("check: no changes detected — skipping poll");
      this.pollSlower(name);
      return;
    }

    const auditLog = await this.loadAuditLog(name);
    const doneCount = (auditLog.match(/\| DONE \|/g) || []).length;
    run.log(`audit: ${doneCount} tasks completed previously`);

    // Run generated tool if one exists for this (connector, template) — skip LLM entirely
    const toolResult = await this.runGeneratedTool(name, "connector-run");
    if (toolResult) {
      if (toolResult.outcome === "no-tasks") {
        run.log(`gen-tool: ${toolResult.details ?? "no tasks"} — skipping LLM`);
        await this.appendAuditCheck(name);
        this.totalNoTasks++;
        this.pollSlower(name);
        return;
      } else if (toolResult.outcome === "needs-llm") {
        run.log(`gen-tool: needs LLM — ${toolResult.details ?? "proceeding"}`);
      } else {
        run.log(`gen-tool: ${toolResult.outcome} — ${toolResult.details ?? ""}`);
      }
    }

    // Extract code directory from connector context
    const cwdMatch = content.match(/code directory:\s*(.+)/);
    const taskCwd = cwdMatch?.[1]?.trim();
    if (taskCwd) run.log(`cwd: ${taskCwd}`);

    // Acquire concurrency slot for preflight
    if (!(await this.acquireSlot(name))) return;

    try {
      // Load past eval findings for failure memory + analogical reasoning
      const pastFindings = await this.loadPastFindings(name);

      // Phase 1: Pre-flight — analyze state and split into sub-tasks
      run.startPhase("preflight");
      this.setPhase(name, "preflight");
      this.emitEvent({ type: "log", connector: name, message: `Analyzing ${name}: splitting into sub-tasks`, level: "info", timestamp: Date.now() });
      const auditTail = tailLines(auditLog, 50);
      const preflight = await spawn(this.config, "task-preflight", {
        connector_content: content,
        audit_log: auditTail || "(empty — no tasks completed yet)",
        past_findings: pastFindings || "(no past findings yet)",
      }, { cwd: taskCwd, label: `preflight: ${name}` });

      const preflightOutput = preflight.output;
      run.log(`pre-flight done (in: ${preflight.inputChars}c, out: ${preflightOutput.length}c)`);

      // Auth failure in preflight — bail before any LLM work
      if (isAuthFailure(preflightOutput)) {
        this.applyAuthBackoff(name, run);
        return;
      }

      // Record preflight actions for pattern detection
      if (preflight.actions?.length) {
        this.recordAndLearn(name, "task-preflight", preflight.actions, preflightOutput, preflight.cost).catch(() => {});
      }

      // Check for no tasks
      if (preflightOutput.includes("NO_TASKS_AVAILABLE")) {
        run.log("preflight: no tasks available");
        this.totalNoTasks++;
        this.pollSlower(name);
        await this.appendAuditCheck(name);
        console.log(run.summary("no tasks"));
        return;
      }

      // Parse sub-tasks from preflight output
      const subtasks = parseSubTasks(preflightOutput);
      if (subtasks.length === 0) {
        run.warn("preflight produced no parseable sub-tasks — falling back to single run");
        await this.runSingleTask(name, path, content, auditTail, preflightOutput, taskCwd, run);
        return;
      }

      run.log(`preflight: ${subtasks.length} sub-tasks (${subtasks.filter(s => s.fast).length} fast, ${subtasks.filter(s => !s.fast).length} full)`);
      this.pollFaster(name);

      // Phase 2: Execute sub-tasks
      // Fast sub-tasks run in parallel, skip critique/eval
      const fastTasks = subtasks.filter(s => s.fast);
      const fullTasks = subtasks.filter(s => !s.fast);

      // Run all fast tasks in parallel
      if (fastTasks.length > 0) {
        run.startPhase(`fast-tasks (${fastTasks.length})`);
        this.setPhase(name, "fast-tasks");
        this.emitEvent({ type: "log", connector: name, message: `Running ${fastTasks.length} fast sub-tasks in parallel`, level: "info", timestamp: Date.now() });

        const fastResults = await Promise.allSettled(
          fastTasks.map(task => this.runFastSubTask(name, path, content, task, taskCwd))
        );

        for (let i = 0; i < fastResults.length; i++) {
          const r = fastResults[i];
          const task = fastTasks[i];
          if (r.status === "fulfilled" && r.value) {
            run.log(`fast [${task.id}]: done — ${r.value.result}`);
            await this.appendAuditTask(name, r.value);
            this.totalCompleted++;
            this.connectorDoneCounts.set(name, (this.connectorDoneCounts.get(name) ?? 0) + 1);
          } else if (r.status === "rejected") {
            run.warn(`fast [${task.id}]: failed — ${r.reason}`);
          } else {
            run.log(`fast [${task.id}]: no result`);
          }
        }
      }

      // Run first full task through the complete pipeline (critic/eval/recovery)
      if (fullTasks.length > 0) {
        const task = fullTasks[0]; // One per poll — next poll picks the next one
        if (fullTasks.length > 1) {
          run.log(`full: picking "${task.id}" (${fullTasks.length - 1} remaining for next poll)`);
        }
        await this.runFullSubTask(name, path, content, auditTail, task, taskCwd, run);
      }

      if (fastTasks.length > 0 && fullTasks.length === 0) {
        console.log(run.summary(`${fastTasks.length} fast tasks done`));
      }
    } catch (err) {
      run.error("run failed", err);
      this.pollSlower(name); // Back off on errors
    } finally {
      this.activeAgents.delete(name);
      this.releaseSlot(name);
    }
  }

  /** Run a fast sub-task — no critique/eval, minimal context. */
  private async runFastSubTask(
    connectorName: string,
    connectorPath: string,
    connectorContent: string,
    subtask: SubTask,
    cwd?: string,
  ): Promise<{ id: string; title: string; result: string } | null> {
    const result = await spawn(this.config, "connector-run", {
      connector_path: connectorPath,
      connector_content: connectorContent,
      audit_log: "(see sub-task action for context)",
      skill_context: "No skills needed for this fast task.",
      preflight_analysis: `Execute this single sub-task:\nid: ${subtask.id}\naction: ${subtask.action}`,
    }, { cwd, label: `${connectorName}/${subtask.id}` });

    // Record actions
    if (result.actions?.length) {
      this.recordAndLearn(connectorName, "connector-run", result.actions, result.output, result.cost).catch(() => {});
    }

    const completed = parseTaskCompleted(result.output);
    if (completed) {
      this.emitEvent({ type: "completed", connector: connectorName, taskId: completed.id,
        title: completed.title, result: completed.result, cost: result.cost, timestamp: Date.now() });
    }
    return completed;
  }

  /** Run a full sub-task through the complete pipeline (critique/eval/recovery). */
  private async runFullSubTask(
    connectorName: string,
    connectorPath: string,
    connectorContent: string,
    auditTail: string,
    subtask: SubTask,
    cwd: string | undefined,
    run: RunLog,
  ): Promise<void> {
    // Select relevant skills
    run.startPhase("skill-select");
    this.setPhase(connectorName, "skill-select");
    const skillContext = await this.loadSkillContext(connectorContent);

    // Execute
    run.startPhase(`execute [${subtask.id}]`);
    this.setPhase(connectorName, "execute");
    this.emitEvent({ type: "log", connector: connectorName, message: `Executing sub-task: ${subtask.id}`, level: "info", timestamp: Date.now() });

    const result = await spawn(this.config, "connector-run", {
      connector_path: connectorPath,
      connector_content: connectorContent,
      audit_log: auditTail || "(empty)",
      skill_context: truncate(skillContext, 8000),
      preflight_analysis: `Execute this single sub-task:\nid: ${subtask.id}\naction: ${subtask.action}\npriority: ${subtask.priority}`,
    }, { cwd, label: `${connectorName}/${subtask.id}` });
    this.emitEvent({ type: "log", connector: connectorName, message: `Execute done (in: ${fmtChars(result.inputChars)}, out: ${fmtChars(result.outputChars)})`, level: "info", timestamp: Date.now(), inputChars: result.inputChars, outputChars: result.outputChars });

    // Handle human input loop — release slot while waiting so other connectors can run
    let current = result;
    while (current.humanInputNeeded) {
      run.startPhase("human-input");
      this.setPhase(connectorName, "human-input");
      run.log(`waiting for human: ${current.humanInputNeeded}`);
      this.releaseSlot(connectorName); // Don't block others while waiting
      try {
        const answer = await this.bot.askQuestion(current.humanInputNeeded);
        run.log(`user replied, re-acquiring slot...`);
        if (!(await this.acquireSlot(connectorName))) return;
        run.startPhase("execute (resumed)");
        this.setPhase(connectorName, "execute (resumed)");
        current = await resume(this.config, current.sessionId,
          `The user answered: ${answer}\n\nPlease continue executing the task.`);
      } catch (err) {
        run.error("Q&A timed out", err);
        if (!(await this.acquireSlot(connectorName))) return; // Re-acquire for finally block
        this.bot.notify(`[${connectorName}] timed out waiting for input.`).catch(() => {});
        break;
      }
    }

    // Auth failure detection — skip recovery pipeline entirely
    if (isAuthFailure(current.output)) {
      this.applyAuthBackoff(connectorName, run);
      return;
    }

    // Rate limit detection
    if (isRateLimited(current.output)) {
      run.warn("rate limit detected — applying backoff");
      const existing = this.rateLimitBackoff.get(connectorName);
      const delay = existing ? Math.min(existing.delay * 2, this.BACKOFF_MAX) : this.BACKOFF_INITIAL;
      const until = Date.now() + delay;
      this.rateLimitBackoff.set(connectorName, { until, delay });
      this.emitEvent({ type: "rate_limited", connector: connectorName, timestamp: Date.now(),
        message: `Rate limited, backing off for ${Math.round(delay / 60000)}min`, backoffUntil: until });
      this.bot.notify(`[${connectorName}] rate-limited, backing off for ${Math.round(delay / 60000)}min`).catch(() => {});
      console.log(run.summary("rate-limited"));
      return;
    }
    this.rateLimitBackoff.delete(connectorName);

    // Record actions for pattern detection
    if (current.actions?.length) {
      this.recordAndLearn(connectorName, "connector-run", current.actions, current.output, current.cost).catch(() => {});
    }

    if (current.output.includes("NO_TASKS_AVAILABLE")) {
      run.log("result: sub-task found no work");
      await this.appendAuditCheck(connectorName);
      console.log(run.summary("no tasks"));
      return;
    }

    let completed = parseTaskCompleted(current.output);
    if (completed) {
      await this.handleCompleted(connectorName, connectorContent, completed, current, run);
    } else if (!current.humanInputNeeded) {
      await this.handleRecovery(connectorName, connectorContent, current, run);
    }
  }

  /** Fallback: run the old single-spawn approach when preflight doesn't produce sub-tasks. */
  private async runSingleTask(
    name: string,
    path: string,
    content: string,
    auditTail: string,
    preflightOutput: string,
    cwd: string | undefined,
    run: RunLog,
  ): Promise<void> {
    const skillContext = await this.loadSkillContext(content);

    run.startPhase("execute");
    this.setPhase(name, "execute");
    const result = await spawn(this.config, "connector-run", {
      connector_path: path,
      connector_content: content,
      audit_log: auditTail || "(empty)",
      skill_context: truncate(skillContext, 8000),
      preflight_analysis: truncate(preflightOutput, 5000),
    }, { cwd, label: name });

    let current = result;
    // Record actions
    if (current.actions?.length) {
      this.recordAndLearn(name, "connector-run", current.actions, current.output, current.cost).catch(() => {});
    }

    if (current.output.includes("NO_TASKS_AVAILABLE")) {
      this.totalNoTasks++;
      this.pollSlower(name);
      await this.appendAuditCheck(name);
      console.log(run.summary("no tasks"));
    } else if (isAuthFailure(current.output)) {
      this.applyAuthBackoff(name, run);
    } else {
      const completed = parseTaskCompleted(current.output);
      if (completed) {
        this.pollFaster(name);
        await this.handleCompleted(name, content, completed, current, run);
      } else {
        await this.handleRecovery(name, content, current, run);
      }
    }
  }

  /** Shared completion pipeline: critique → eval → notify. */
  private async handleCompleted(
    name: string,
    connectorContent: string,
    completed: { id: string; title: string; result: string; dispositions?: string },
    current: import("./agent/spawner.js").SpawnResult,
    run: RunLog,
  ): Promise<void> {
    this.pollFaster(name);
    run.taskId = completed.id;
    this.setPhase(name, "completed", completed.id, completed.title);
    run.log(`task done: ${completed.title}`);
    run.log(`result: ${completed.result}`);
    if (completed.dispositions) run.log(`dispositions:\n${completed.dispositions}`);
    this.emitEvent({ type: "log", connector: name, taskId: completed.id, message: `Task done: ${completed.title} — ${completed.result}`, level: "info", timestamp: Date.now() });

    // Critique
    run.startPhase("critic");
    this.setPhase(name, "critic", completed.id, completed.title);
    this.emitEvent({ type: "log", connector: name, taskId: completed.id, message: "Critic challenging the result", level: "info", timestamp: Date.now() });
    const critique = await this.runCritique(name, connectorContent, completed, current.output);

    if (critique === "needs_fix" && current.sessionId) {
      run.startPhase("fix-pass");
      this.setPhase(name, "fix-pass", completed.id, completed.title);
      run.log("critic found issues — running fix pass");
      current = await resume(this.config, current.sessionId,
        "A critic agent reviewed your work and found issues. Please fix them and report TASK_COMPLETED again.");
      const fixed = parseTaskCompleted(current.output);
      if (fixed) completed = fixed;
      run.log("fix pass complete");
    }

    if (current.cost) run.log(`cost: $${current.cost.toFixed(4)}`);
    if (current.turns) run.log(`turns: ${current.turns}`);
    await this.appendAuditTask(name, completed);
    this.totalCompleted++;
    this.connectorDoneCounts.set(name, (this.connectorDoneCounts.get(name) ?? 0) + 1);
    this.emitEvent({ type: "completed", connector: name, taskId: completed.id,
      title: completed.title, result: completed.result, cost: current.cost, timestamp: Date.now() });

    const details = extractKeyDetails(current.output);
    const notifyLines = [
      `*Task completed* [${name}/${completed.id}]`,
      `*${completed.title}*`,
      completed.result ? `\n${completed.result}` : "",
      details ? `\n${details}` : "",
      current.cost ? `\nCost: $${current.cost.toFixed(4)}` : "",
      `\n${this.config.brandSignature}`,
    ].filter(Boolean).join("\n");
    this.bot.notify(notifyLines).catch(() => {});

    // Eval
    run.startPhase("eval");
    this.setPhase(name, "eval", completed.id, completed.title);
    const quality = await this.runEval(name, connectorContent, completed, current.output);

    // Summary
    const elapsed = formatDuration(Date.now() - (this.activeAgents.get(name)?.startedAt ?? Date.now()));
    const summaryLines = [
      `Pipeline complete: [${name}/${completed.id}]`,
      `Task: ${completed.title}`,
      `Result: ${completed.result}`,
      `Critic: ${critique === "needs_fix" ? "found issues → fix pass applied" : "approved"}`,
      `Quality: ${quality}/10`,
      current.cost ? `Cost: $${current.cost.toFixed(4)}` : null,
      current.turns ? `Turns: ${current.turns}` : null,
      `Total time: ${elapsed}`,
    ].filter(Boolean).join("\n");
    this.emitEvent({ type: "summary", connector: name, taskId: completed.id, title: completed.title,
      result: completed.result, quality, cost: current.cost, summary: summaryLines, timestamp: Date.now() });

    // Extract reusable tools (background)
    this.extractTools(current.output, connectorContent).catch((err) =>
      console.error(`[tools] extraction error:`, err));

    console.log(run.summary(`completed ${completed.id}`));
  }

  /** Shared recovery pipeline: retry → escalate → abandon. */
  private async handleRecovery(
    name: string,
    connectorContent: string,
    current: import("./agent/spawner.js").SpawnResult,
    run: RunLog,
  ): Promise<void> {
    run.warn("agent finished without TASK_COMPLETED or NO_TASKS_AVAILABLE");
    const maxAttempts = this.config.maxRecoveryAttempts;
    let recovered = false;
    let abandoned = false;
    let completed: { id: string; title: string; result: string; dispositions?: string } | null = null;

    for (let attempt = 1; attempt <= maxAttempts && current.sessionId; attempt++) {
      run.startPhase(`recover (${attempt}/${maxAttempts})`);
      this.setPhase(name, "recover");
      this.emitEvent({ type: "log", connector: name, message: `Recovery attempt ${attempt}/${maxAttempts}`, level: "warn", timestamp: Date.now() });

      const decision = await this.runRecovery(name, connectorContent, current.output, attempt, maxAttempts);

      if (decision.action === "retry" && decision.plan) {
        run.log(`recovery: RETRY — ${decision.analysis}`);
        run.startPhase(`retry (${attempt}/${maxAttempts})`);
        this.setPhase(name, "retry");
        current = await resume(this.config, current.sessionId,
          `Your previous attempt failed. Here is what went wrong:\n\n${decision.analysis}\n\nRecovery plan:\n${decision.plan}\n\nPlease try again and report TASK_COMPLETED when done.`);
        const retryCompleted = parseTaskCompleted(current.output);
        if (retryCompleted) { completed = retryCompleted; recovered = true; break; }
      } else if (decision.action === "escalate" && decision.question) {
        run.log(`recovery: ESCALATE — ${decision.analysis}`);
        try {
          const answer = await this.bot.askQuestion(
            `[${name}] Task failed:\n${decision.analysis}\n\n${decision.question}`);
          run.startPhase("execute (recovered)");
          this.setPhase(name, "execute (recovered)");
          current = await resume(this.config, current.sessionId,
            `Recovery: ${decision.analysis}\nUser answered: ${answer}\n\nPlease try again and report TASK_COMPLETED when done.`);
          const esc = parseTaskCompleted(current.output);
          if (esc) { completed = esc; recovered = true; }
        } catch { run.warn("escalation timed out"); }
        break;
      } else {
        run.log(`recovery: ABANDON — ${decision.analysis}`);
        await this.appendAuditAttempted(name, `abandoned: ${decision.analysis}`, current.output);
        this.emitEvent({ type: "log", connector: name, message: `Abandoned: ${decision.analysis}`, level: "error", timestamp: Date.now() });
        abandoned = true;
        break;
      }
    }

    if (recovered && completed) {
      await this.handleCompleted(name, connectorContent, completed, current, run);
    } else if (!recovered && !abandoned && maxAttempts > 0) {
      await this.appendAuditAttempted(name, "recovery exhausted", current.output);
      console.log(run.summary("recovery exhausted"));
    } else {
      await this.appendAuditAttempted(name, "no result parsed", current.output);
      console.log(run.summary("no result parsed"));
    }
  }

  // ── Cheap Change Detection ──────────────────────────

  /**
   * Run the optional ## Check command from the connector.
   * Returns true if changes detected (or no check defined), false if unchanged.
   */
  private async runCheapCheck(name: string, content: string): Promise<boolean> {
    const checkMatch = content.match(/^##\s+Check\s*\n([\s\S]*?)(?=\n##|$)/m);
    if (!checkMatch) return true; // No ## Check section — always run

    const command = checkMatch[1].trim();
    if (!command) return true;

    try {
      const output = await this.execCheck(command);
      const fingerprint = createHash("sha256").update(output).digest("hex").slice(0, 16);
      const prev = this.checkFingerprints.get(name);

      if (prev === fingerprint) {
        return false; // Nothing changed
      }

      this.checkFingerprints.set(name, fingerprint);
      return true; // Changed (or first run)
    } catch (err) {
      // Check command failed — run the agent anyway (may be a transient issue)
      console.warn(`${ts()} [${name}] check command failed, proceeding with poll:`, err instanceof Error ? err.message : err);
      return true;
    }
  }

  private execCheck(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execCb(command, { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}\n${stderr}`));
        else resolve(stdout);
      });
    });
  }

  // ── Connector & Audit ───────────────────────────────

  private async listConnectors(): Promise<{ name: string; path: string }[]> {
    const dir = resolve(this.config.vaultPath, "connectors");
    try {
      const files = await readdir(dir);
      const candidates = files
        .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
        .map((f) => ({ name: f.replace(".md", ""), path: join(dir, f) }));

      // Filter out files that aren't real connectors (too small, or look like misplaced audit logs)
      const valid: { name: string; path: string }[] = [];
      for (const c of candidates) {
        try {
          const content = await readFile(c.path, "utf-8");
          // Skip empty/trivial files (< 100 bytes) and misplaced audit logs
          if (content.trim().length < 100) continue;
          if (content.trim().startsWith("- ") && content.includes("| CHECKED |")) continue;
        } catch { continue; }
        valid.push(c);
      }
      return valid;
    } catch {
      return [];
    }
  }

  /** Public accessor for dashboard API. */
  async getAuditLog(connectorName: string): Promise<string> {
    return this.loadAuditLog(connectorName);
  }

  private async loadAuditLog(connectorName: string): Promise<string> {
    const logPath = resolve(this.config.vaultPath, "thinkops/audit", `${connectorName}.md`);
    try {
      return await readFile(logPath, "utf-8");
    } catch {
      return "";
    }
  }

  private auditPath(connectorName: string): string {
    return resolve(this.config.vaultPath, "thinkops/audit", `${connectorName}.md`);
  }

  private async appendAuditTask(
    connectorName: string,
    task: { id: string; title: string; result: string; dispositions?: string }
  ): Promise<void> {
    const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
    await mkdir(auditDir, { recursive: true });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    let entry = `- ${now} | DONE | **${task.id}** | ${task.title} | ${task.result}\n`;
    if (task.dispositions) {
      const normalized = task.dispositions.split("\n").map(l => `    ${l.trimStart()}`).join("\n");
      entry += `  dispositions:\n${normalized}\n`;
    }
    await appendFile(this.auditPath(connectorName), entry);
  }

  private async appendAuditCheck(connectorName: string): Promise<void> {
    const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
    await mkdir(auditDir, { recursive: true });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const entry = `- ${now} | CHECKED | no new tasks\n`;
    await appendFile(this.auditPath(connectorName), entry);
  }

  private async appendAuditAttempted(
    connectorName: string,
    reason: string,
    outputSnippet: string
  ): Promise<void> {
    const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
    await mkdir(auditDir, { recursive: true });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const snippet = outputSnippet.slice(0, 500).replace(/\n/g, " ").trim();
    const entry = `- ${now} | ATTEMPTED | ${reason} | ${snippet}\n`;
    await appendFile(this.auditPath(connectorName), entry);
  }

  // ── Past Findings ───────────────────────────────────

  private async loadPastFindings(connectorName: string): Promise<string> {
    const sections: string[] = [];

    // 1. Eval scores from this connector
    const auditLog = await this.loadAuditLog(connectorName);
    const evalLines = auditLog.split("\n").filter((l) => l.includes("| EVAL |"));
    if (evalLines.length > 0) {
      sections.push("## Eval scores (this connector):");
      sections.push(...evalLines.slice(-10));
    }

    // 2. Feedback outcomes from this connector (what happened after we finished)
    const feedbackLines = auditLog.split("\n").filter((l) => l.includes("| FEEDBACK |"));
    if (feedbackLines.length > 0) {
      sections.push("\n## Outcome feedback (this connector):");
      sections.push(...feedbackLines.slice(-10));
    }

    // 3. Cross-connector patterns — recent feedback from other connectors
    try {
      const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
      const files = (await readdir(auditDir)).filter(
        (f) => f.endsWith(".md") && f !== `${connectorName}.md`
      );
      const crossFeedback: string[] = [];
      for (const file of files.slice(0, 5)) { // Cap at 5 other connectors
        const content = await readFile(resolve(auditDir, file), "utf-8");
        const cn = file.replace(/\.md$/, "");
        const fb = content.split("\n").filter((l) => l.includes("| FEEDBACK |") && !l.includes("unchanged"));
        if (fb.length > 0) {
          crossFeedback.push(`[${cn}] ${fb.slice(-3).join("\n")}`);
        }
      }
      if (crossFeedback.length > 0) {
        sections.push("\n## Cross-connector feedback (patterns from other work):");
        sections.push(...crossFeedback);
      }
    } catch { /* no audit dir yet */ }

    return sections.join("\n");
  }

  // ── Critique ─────────────────────────────────────────

  private async runCritique(
    connectorName: string,
    connectorContent: string,
    task: { id: string; title: string; result: string },
    agentOutput: string
  ): Promise<"approved" | "needs_fix"> {
    const tag = `${connectorName}/${task.id}`;
    try {
      const critiqueResult = await spawn(this.config, "task-critique", {
        connector_content: connectorContent,
        task_result: `${task.id}: ${task.title}\n${task.result}`,
        agent_output: agentOutput.slice(0, 10_000),
      }, { label: `critique: ${tag}` });

      const output = critiqueResult.output;
      if (isAuthFailure(output)) {
        console.warn(`${ts()} [${tag}] critic: skipped (auth failure)`);
        return "approved";
      }
      if (output.includes("status: needs_fix")) {
        const issues = output.match(/issues:\n([\s\S]*?)(?:\n```|$)/)?.[1]?.trim() ?? "unspecified issues";
        console.log(`${ts()} [${tag}] critic: needs fix — ${issues.slice(0, 200)}`);
        return "needs_fix";
      }
      console.log(`${ts()} [${tag}] critic: approved`);
      return "approved";
    } catch (err) {
      console.error(`${ts()} [${tag}] critic error:`, err instanceof Error ? err.message : err);
      return "approved"; // Don't block on critic failure
    }
  }

  // ── Recovery ────────────────────────────────────────

  private async runRecovery(
    connectorName: string,
    connectorContent: string,
    agentOutput: string,
    attempt: number,
    maxAttempts: number
  ): Promise<{ action: "retry" | "escalate" | "abandon"; analysis: string; plan?: string; question?: string; suggestion?: string }> {
    try {
      const result = await spawn(this.config, "task-recover", {
        connector_content: connectorContent,
        agent_output: agentOutput.slice(-10_000),
        attempt_number: String(attempt),
        max_attempts: String(maxAttempts),
      }, { label: `recover: ${connectorName} #${attempt}` });

      const output = result.output;
      const analysis = output.match(/ANALYSIS:\s*(.+)/)?.[1]?.trim() ?? "unknown failure";

      if (output.includes("DECISION: RETRY")) {
        const plan = output.match(/PLAN:\s*([\s\S]*?)(?:\n```|$)/)?.[1]?.trim();
        return { action: "retry", analysis, plan };
      }
      if (output.includes("DECISION: ESCALATE")) {
        const question = output.match(/QUESTION:\s*(.+)/)?.[1]?.trim();
        return { action: "escalate", analysis, question };
      }
      // Default to abandon
      const suggestion = output.match(/SUGGESTION:\s*(.+)/)?.[1]?.trim();
      return { action: "abandon", analysis, suggestion };
    } catch (err) {
      console.error(`${ts()} [${connectorName}] recovery error:`, err instanceof Error ? err.message : err);
      return { action: "abandon", analysis: "Recovery agent failed" };
    }
  }

  // ── Eval ─────────────────────────────────────────────

  private async runEval(
    connectorName: string,
    connectorContent: string,
    task: { id: string; title: string; result: string },
    agentOutput: string
  ): Promise<string> {
    const tag = `${connectorName}/${task.id}`;
    console.log(`${ts()} [${tag}] eval: starting`);
    try {
      const evalResult = await spawn(this.config, "eval-run", {
        connector_content: connectorContent,
        task_result: `${task.id}: ${task.title}\n${task.result}`,
        agent_output: agentOutput.slice(0, 10_000),
      }, { label: `eval: ${tag}` });

      const evalOutput = evalResult.output;
      if (isAuthFailure(evalOutput)) {
        console.warn(`${ts()} [${tag}] eval: skipped (auth failure)`);
        return "skipped";
      }
      const quality = evalOutput.match(/quality:\s*(\d+)/)?.[1] ?? "?";
      console.log(`${ts()} [${tag}] eval: quality ${quality}/10`);
      if (evalResult.cost) console.log(`${ts()} [${tag}] eval cost: $${evalResult.cost.toFixed(4)}`);

      // Annotate audit log with quality score
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      await appendFile(this.auditPath(connectorName),
        `- ${now} | EVAL | **${task.id}** | quality: ${quality}/10\n`);

      // Route findings
      await this.routeEvalFindings(connectorName, task.id, evalOutput);
      return quality;
    } catch (err) {
      console.error(`${ts()} [${tag}] eval error:`, err instanceof Error ? err.message : err);
      return "?";
    }
  }

  private async routeEvalFindings(
    connectorName: string,
    taskId: string,
    evalOutput: string
  ): Promise<void> {
    const tag = `${connectorName}/${taskId}`;
    const lines = evalOutput.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("SKILL:")) {
        const finding = trimmed.slice(6).trim();
        console.log(`${ts()} [${tag}] eval → SKILL: ${finding}`);
        try {
          await spawn(this.config, "skill-extract", {
            history_chunk: `Eval finding from [${connectorName}] task ${taskId}:\n${finding}`,
          }, { label: `eval-skill: ${finding.slice(0, 40)}` });
          console.log(`${ts()} [${tag}] eval → skill saved`);
        } catch {
          console.warn(`${ts()} [${tag}] eval → skill save failed (non-critical)`);
        }
      } else if (trimmed.startsWith("CODE:")) {
        const finding = trimmed.slice(5).trim();
        console.log(`${ts()} [${tag}] eval → CODE: ${finding}`);
        const findingsConnector = resolve(this.config.vaultPath, "connectors/findings.md");
        await this.ensureFindingsConnector(findingsConnector);
        const now = new Date().toISOString().slice(0, 10);
        const entry = `- [ ] ${finding} _(from eval of [${connectorName}] ${taskId}, ${now})_\n`;
        await appendFile(findingsConnector, entry);
        console.log(`${ts()} [${tag}] eval → finding added to connectors/findings.md`);
      } else if (trimmed.startsWith("CRITICAL:")) {
        const finding = trimmed.slice(9).trim();
        console.error(`${ts()} [${tag}] eval → CRITICAL: ${finding}`);
        this.bot.notify(
          `*CRITICAL* [${tag}]\n${finding}`
        ).catch(() => {});
      }
    }
  }

  private async loadSkillContext(taskDescription: string): Promise<string> {
    try {
      const treePath = resolve(this.config.vaultPath, "skills/_tree.md");
      const treeContent = await readFile(treePath, "utf-8");
      if (treeContent.trim().length < 50) {
        return "No skills available yet.";
      }
    } catch {
      return "No skills available yet.";
    }

    try {
      const result = await spawn(this.config, "skill-select", {
        task_description: taskDescription,
      });

      const paths = result.output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.endsWith(".md") && !l.startsWith("```"));

      if (paths.length === 0 || paths[0] === "NONE") {
        return "No relevant skills found.";
      }

      const skills: string[] = [];
      let totalLen = 0;
      const MAX_PER_SKILL = 1500;
      const MAX_TOTAL_SKILLS = 8000;
      for (const p of paths.slice(0, 5)) {
        if (totalLen >= MAX_TOTAL_SKILLS) break;
        try {
          const content = await readFile(
            resolve(this.config.vaultPath, p),
            "utf-8"
          );
          const trimmed = content.length > MAX_PER_SKILL
            ? content.slice(0, MAX_PER_SKILL) + "\n...(truncated)"
            : content;
          skills.push(`--- Skill: ${p} ---\n${trimmed}`);
          totalLen += trimmed.length;
        } catch {
          // Skill file not found, skip
        }
      }
      return skills.length > 0
        ? skills.join("\n\n")
        : "No relevant skills found.";
    } catch {
      return "Skill selection failed.";
    }
  }

  // ── Knowledge Loop ─────────────────────────────────────

  private startKnowledgeWatcher(): void {
    const sourcesDir = resolve(this.config.vaultPath, "knowledge/sources");
    mkdir(sourcesDir, { recursive: true }).then(() => {
      watchFolder(sourcesDir, async (filePath) => {
        console.log(`[knowledge] new source: ${filePath}`);
        await this.bot.notify(`Ingesting new source: \`${filePath}\``);
        try {
          const result = await spawn(this.config, "knowledge-ingest", {
            source_path: filePath,
          });
          await this.bot.notify(`Ingestion complete: ${result.output.slice(0, 200)}`);
        } catch (err) {
          console.error("[knowledge] ingest error:", err);
        }
      });
      console.log("[knowledge] watching sources/");
    });

    // Periodic lint
    const lintInterval = this.config.knowledgeLintInterval * 1000;
    const lintLoop = async () => {
      if (!this.running) return;
      const start = Date.now();
      this.loopStart("knowledge-lint");

      // Guard: skip if no knowledge pages exist to lint
      const entityDir = resolve(this.config.vaultPath, "knowledge/entities");
      const topicDir = resolve(this.config.vaultPath, "knowledge/topics");
      let pageCount = 0;
      try { pageCount += (await readdir(entityDir)).filter((f) => f.endsWith(".md")).length; } catch {}
      try { pageCount += (await readdir(topicDir)).filter((f) => f.endsWith(".md")).length; } catch {}

      let err: unknown;
      if (pageCount === 0) {
        console.log("[knowledge] no pages to lint — skipping");
      } else {
        console.log(`[knowledge] linting ${pageCount} pages...`);
        try {
          await spawn(this.config, "knowledge-lint", {});
        } catch (e) {
          err = e;
          console.error("[knowledge] lint error:", e);
        }
      }
      this.loopFinish("knowledge-lint", start, err);
      if (this.running) {
        const timer = safeTimeout(lintLoop, lintInterval);
        this.timers.push(timer);
      }
    };
    const lintTimer = safeTimeout(lintLoop, lintInterval);
    this.timers.push(lintTimer);
  }

  // ── Skill Loop ─────────────────────────────────────────

  private startSkillLoops(): void {
    // Periodic skill extraction from conversation history
    const extractInterval = this.config.skillExtractInterval * 1000;
    const extractLoop = async () => {
      if (!this.running) return;
      const start = Date.now();
      this.loopStart("skill-extract");
      let err: unknown;
      try {
        await this.runSkillExtraction();
      } catch (e) { err = e; }
      this.loopFinish("skill-extract", start, err);
      if (this.running) {
        const timer = safeTimeout(extractLoop, extractInterval);
        this.timers.push(timer);
      }
    };
    const extractTimer = safeTimeout(extractLoop, extractInterval);
    this.timers.push(extractTimer);

    // Less frequent skill organization
    const organizeInterval = this.config.skillOrganizeInterval * 1000;
    const organizeLoop = async () => {
      if (!this.running) return;
      const start = Date.now();
      this.loopStart("skill-organize");

      // Guard: skip if no skills exist to organize
      const treePath = resolve(this.config.vaultPath, "skills/_tree.md");
      let hasSkills = false;
      try { await stat(treePath); hasSkills = true; } catch { /* no tree yet */ }

      let err: unknown;
      if (!hasSkills) {
        console.log("[skills] no skills to organize — skipping");
      } else {
        console.log("[skills] running organize...");
        try {
          await spawn(this.config, "skill-organize", {});
        } catch (e) {
          err = e;
          console.error("[skills] organize error:", e);
        }
      }
      this.loopFinish("skill-organize", start, err);
      if (this.running) {
        const timer = safeTimeout(organizeLoop, organizeInterval);
        this.timers.push(timer);
      }
    };
    const organizeTimer = safeTimeout(organizeLoop, organizeInterval);
    this.timers.push(organizeTimer);
  }

  private async runSkillExtraction(): Promise<void> {
    console.log("[skills] running extraction...");
    try {
      const historyDir = resolve(homedir(), ".claude/projects");
      const chunk = await this.readRecentHistory(historyDir);
      if (!chunk) {
        console.log("[skills] no new history to process");
        return;
      }
      await spawn(this.config, "skill-extract", { history_chunk: chunk });
    } catch (err) {
      console.error("[skills] extraction error:", err);
    }
  }

  private async readRecentHistory(dir: string): Promise<string | null> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const projectDirs = entries.filter((e) => e.isDirectory());

      let newest = "";
      let newestTime = 0;

      for (const d of projectDirs) {
        const projectPath = join(dir, d.name);
        const files = await readdir(projectPath);
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = join(projectPath, f);
          const s = await stat(fp);
          if (s.mtimeMs > newestTime) {
            newestTime = s.mtimeMs;
            newest = fp;
          }
        }
      }

      if (!newest) return null;

      // Read last ~50KB of the newest conversation
      const content = await readFile(newest, "utf-8");
      const tail = content.slice(-50_000);
      return tail;
    } catch {
      return null;
    }
  }

  /** Ensure connectors/findings.md exists. */
  private async ensureFindingsConnector(filePath: string): Promise<void> {
    try {
      await stat(filePath);
    } catch {
      const header = [
        "# Findings",
        "Improvement findings discovered by the eval pipeline.",
        "Each unchecked item is a task to address.",
        "",
        "## Tasks",
        "",
      ].join("\n");
      await writeFile(filePath, header);
    }
  }

  // ── Tool Loop ───────────────────────────────────────────

  private async extractTools(agentOutput: string, connectorContent: string): Promise<void> {
    // Only extract if output has substantial CLI commands
    const cmdCount = (agentOutput.match(/\$ |```bash|```sh|gh |curl |jq /g) ?? []).length;
    if (cmdCount < 2) return;

    console.log("[tools] extracting reusable tools from agent output...");
    await spawn(this.config, "tool-extract", {
      agent_output: agentOutput.slice(0, 20_000),
      connector_content: connectorContent,
    });
  }

  // ── Generated Tools (learn from repeated patterns) ─────

  /**
   * Record actions from a completed spawn, detect repeats, and generate tools.
   * This is the general "evolution" mechanism — ThinkOps observes its own behavior,
   * detects when it keeps doing the same thing, and generates a script to replace it.
   */
  private async recordAndLearn(
    connector: string,
    template: string,
    actions: import("./agent/types.js").ToolAction[],
    outcome: string,
    cost?: number,
  ): Promise<void> {
    await this.actionTracker.record(template, connector, actions, outcome, cost);

    const repeats = await this.actionTracker.detectRepeats(connector, template);
    if (repeats.length === 0) return;

    // Generate tools for the most costly repeated patterns
    for (const pattern of repeats.slice(0, 1)) {
      const toolPath = this.generatedToolPath(pattern.fingerprint);
      try {
        await stat(toolPath);
        continue; // Already generated
      } catch { /* generate it */ }

      console.log(`[${connector}] evolution: pattern "${pattern.fingerprint}" repeated ${pattern.count}x (cost: $${pattern.totalCost.toFixed(4)}) — generating tool`);

      try {
        const connectorContent = await this.loadConnectorContent(connector);
        const auditLog = await this.loadAuditLog(connector);

        const result = await spawn(this.config, "tool-gen", {
          template_name: template,
          connector_name: connector,
          repeat_count: String(pattern.count),
          total_cost: pattern.totalCost.toFixed(4),
          action_sequence: this.actionTracker.formatPatternForLLM(pattern),
          typical_outcome: pattern.lastOutcome.slice(0, 2000),
          connector_content: connectorContent,
          audit_log_tail: auditLog.split("\n").slice(-30).join("\n"),
          fingerprint: pattern.fingerprint,
        });

        const scriptMatch = result.output.match(/```bash\n([\s\S]*?)```/);
        if (!scriptMatch) {
          console.warn(`[${connector}] tool-gen: no valid script produced`);
          continue;
        }

        await mkdir(resolve(this.config.vaultPath, "tools"), { recursive: true });
        await writeFile(toolPath, scriptMatch[1], { mode: 0o755 });
        console.log(`[${connector}] evolution: tool saved → ${toolPath}`);
      } catch (err) {
        console.error(`[${connector}] tool-gen failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Run a previously-generated tool for a (connector, template) pair.
   * Returns parsed result or null if no tool exists / tool failed.
   */
  private async runGeneratedTool(
    connector: string,
    template: string,
  ): Promise<{ outcome: string; details?: string; data?: Record<string, unknown> } | null> {
    // Find any generated tool for this connector+template by checking action history
    const repeats = await this.actionTracker.detectRepeats(connector, template);
    for (const pattern of repeats) {
      const toolPath = this.generatedToolPath(pattern.fingerprint);
      try {
        await stat(toolPath);
      } catch {
        continue; // No tool for this pattern
      }

      try {
        const output = await this.execCheck(`bash "${toolPath}"`);
        const parsed = JSON.parse(output.trim());
        if (parsed.outcome) {
          console.log(`[${connector}] gen-tool ${pattern.fingerprint.slice(0, 8)}: ${parsed.outcome}`);
          return parsed;
        }
      } catch (err) {
        console.warn(`[${connector}] gen-tool ${pattern.fingerprint.slice(0, 8)} failed — falling back to LLM:`,
          err instanceof Error ? err.message : err);
      }
    }
    return null;
  }

  private generatedToolPath(fingerprint: string): string {
    return resolve(this.config.vaultPath, `tools/_gen_${fingerprint}.sh`);
  }

  private async loadConnectorContent(name: string): Promise<string> {
    const path = resolve(this.config.vaultPath, "connectors", `${name}.md`);
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "";
    }
  }

  private startToolLoop(): void {
    const reviewInterval = this.config.toolReviewInterval * 1000;
    const loop = async () => {
      if (!this.running) return;
      const start = Date.now();
      this.loopStart("tool-review");

      // Guard: skip if no tools exist to review
      const toolsDir = resolve(this.config.vaultPath, "tools");
      let toolFiles: string[] = [];
      try {
        toolFiles = (await readdir(toolsDir)).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
      } catch { /* dir missing */ }

      let err: unknown;
      if (toolFiles.length === 0) {
        console.log("[tools] no tools to review — skipping");
      } else {
        console.log(`[tools] reviewing ${toolFiles.length} tools...`);
        try {
          await spawn(this.config, "tool-review", {});
        } catch (e) {
          err = e;
          console.error("[tools] review error:", e);
        }
      }
      this.loopFinish("tool-review", start, err);
      if (this.running) {
        const timer = safeTimeout(loop, reviewInterval);
        this.timers.push(timer);
      }
    };
    const timer = safeTimeout(loop, reviewInterval);
    this.timers.push(timer);
  }

  // ── Feedback Loop (learning from outcomes) ──────────────

  private startFeedbackLoop(): void {
    const interval = this.config.feedbackCheckInterval * 1000;
    const loop = async () => {
      if (!this.running) return;
      const start = Date.now();
      this.loopStart("feedback");
      let err: unknown;
      try {
        await this.runFeedbackCycle();
      } catch (e) {
        err = e;
      }
      this.loopFinish("feedback", start, err);
      if (this.running) {
        const timer = safeTimeout(loop, interval);
        this.timers.push(timer);
      }
    };
    const timer = safeTimeout(loop, interval);
    this.timers.push(timer);
  }

  private async runFeedbackCycle(): Promise<void> {
    console.log("[feedback] checking outcomes of completed tasks...");
    try {
      // Collect recent DONE tasks across all connectors that haven't been feedback-checked
      const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
      let entries: { name: string }[];
      try {
        entries = await readdir(auditDir, { withFileTypes: false }) as unknown as { name: string }[];
      } catch {
        return; // No audit dir yet
      }

      const files = (await readdir(auditDir)).filter((f) => f.endsWith(".md"));
      const tasksToCheck: string[] = [];

      for (const file of files) {
        const content = await readFile(resolve(auditDir, file), "utf-8");
        const connectorName = file.replace(/\.md$/, "");
        // Find DONE entries that don't have a FEEDBACK entry following them
        const lines = content.split("\n");
        const feedbackIds = new Set(
          lines.filter((l) => l.includes("| FEEDBACK |")).map((l) => l.match(/\*\*(.+?)\*\*/)?.[1]).filter(Boolean)
        );
        const doneLines = lines.filter((l) => l.includes("| DONE |"));
        for (const line of doneLines.slice(-20)) { // Check last 20 completed tasks
          const id = line.match(/\*\*(.+?)\*\*/)?.[1];
          if (id && !feedbackIds.has(id)) {
            const title = line.split("|")[3]?.trim() ?? "";
            const result = line.split("|")[4]?.trim() ?? "";
            tasksToCheck.push(`- [${connectorName}] **${id}** | ${title} | ${result}`);
          }
        }
      }

      if (tasksToCheck.length === 0) {
        console.log("[feedback] no unchecked tasks");
        return;
      }

      console.log(`[feedback] checking ${tasksToCheck.length} tasks for outcomes...`);

      // Phase 1: Collect feedback signals
      const checkResult = await spawn(this.config, "feedback-check", {
        tasks_to_check: tasksToCheck.join("\n"),
      });

      // Parse FEEDBACK lines
      const feedbackLines = checkResult.output.split("\n").filter((l) => l.startsWith("id:") || l.startsWith("outcome:") || l.startsWith("signal:"));
      if (feedbackLines.length === 0) {
        console.log("[feedback] no new signals found");
        return;
      }

      // Record feedback in audit logs
      const feedbacks = this.parseFeedbackOutput(checkResult.output);
      for (const fb of feedbacks) {
        const connectorName = fb.connector;
        if (connectorName) {
          const now = new Date().toISOString().slice(0, 19).replace("T", " ");
          const entry = `- ${now} | FEEDBACK | **${fb.id}** | ${fb.outcome} | ${fb.signal}\n`;
          await appendFile(this.auditPath(connectorName), entry);
        }
      }

      // Phase 2: Learn from signals (only if there are meaningful signals)
      const meaningful = feedbacks.filter((f) => f.outcome !== "unchanged" && f.outcome !== "unknown");
      if (meaningful.length === 0) return;

      console.log(`[feedback] learning from ${meaningful.length} outcome signals...`);
      const signalsSummary = meaningful.map((f) =>
        `- [${f.connector}] **${f.id}**: ${f.outcome} — ${f.signal}`
      ).join("\n");

      // Load connector content for context
      const connectorPaths = [...new Set(meaningful.map((f) => f.connector).filter(Boolean))];
      let taskContext = "";
      for (const cn of connectorPaths.slice(0, 3)) {
        try {
          const auditLog = await this.loadAuditLog(cn!);
          taskContext += `## ${cn} audit (last 20 lines):\n${auditLog.split("\n").slice(-20).join("\n")}\n\n`;
        } catch { /* skip */ }
      }

      await spawn(this.config, "feedback-learn", {
        feedback_signals: signalsSummary,
        task_context: taskContext,
      });

      console.log("[feedback] learning cycle complete");
    } catch (err) {
      console.error("[feedback] cycle error:", err);
    }
  }

  private parseFeedbackOutput(output: string): Array<{ connector?: string; id: string; outcome: string; signal: string }> {
    const results: Array<{ connector?: string; id: string; outcome: string; signal: string }> = [];
    const blocks = output.split("FEEDBACK").slice(1);
    for (const block of blocks) {
      const id = block.match(/id:\s*\[?(\S+?)\]?\s*\*?\*?(\S+?)\*?\*?/)?.[0]?.replace(/^id:\s*/, "").replace(/\*\*/g, "").trim() ?? "";
      const connectorMatch = id.match(/^\[(.+?)\]\s*(.+)/);
      const connector = connectorMatch?.[1];
      const taskId = connectorMatch?.[2] ?? id;
      const outcome = block.match(/outcome:\s*(\S+)/)?.[1] ?? "unknown";
      const signal = block.match(/signal:\s*(.+)/)?.[1]?.trim() ?? "";
      if (taskId) {
        results.push({ connector, id: taskId, outcome, signal });
      }
    }
    return results;
  }

  // ── Vault Setup ────────────────────────────────────────

  private async ensureVaultStructure(): Promise<void> {
    const dirs = [
      "connectors",
      "knowledge",
      "knowledge/sources",
      "knowledge/entities",
      "knowledge/topics",
      "knowledge/queries",
      "skills",
      "tools",
      "tools/_archive",
      "thinkops",
      "thinkops/audit",
      "thinkops/actions",
    ];
    for (const d of dirs) {
      await mkdir(resolve(this.config.vaultPath, d), { recursive: true });
    }
  }
}

// ── Helpers ────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function fmtChars(n: number): string {
  if (n < 1000) return `${n}c`;
  return `${(n / 1000).toFixed(1)}K`;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${remMins}m`;
}

interface SubTask {
  id: string;
  action: string;
  priority: "high" | "medium" | "low";
  fast: boolean;
}

/** Parse structured sub-tasks from preflight output. */
function parseSubTasks(output: string): SubTask[] {
  const subtasks: SubTask[] = [];
  const subtasksSection = output.match(/subtasks:\s*\n([\s\S]*?)(?:\n```|$)/);
  if (!subtasksSection) return subtasks;

  const blocks = subtasksSection[1].split(/^- id:\s*/m).filter(Boolean);
  for (const block of blocks) {
    const id = block.split("\n")[0]?.trim();
    const action = block.match(/action:\s*(.+)/)?.[1]?.trim();
    const priority = (block.match(/priority:\s*(\w+)/)?.[1]?.trim() ?? "medium") as SubTask["priority"];
    const fast = block.match(/fast:\s*(\w+)/)?.[1]?.trim() === "true";
    if (id && action) {
      subtasks.push({ id, action, priority, fast });
    }
  }

  // Sort: high priority first, then medium, then low
  const order = { high: 0, medium: 1, low: 2 };
  subtasks.sort((a, b) => order[a.priority] - order[b.priority]);
  return subtasks;
}

function parseTaskCompleted(output: string): { id: string; title: string; result: string; dispositions?: string } | null {
  const block = output.match(/TASK_COMPLETED\s*\n([\s\S]*?)(?:\n```|$)/);
  if (!block) return null;
  const lines = block[1];
  const id = lines.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
  const title = lines.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "untitled";
  const result = lines.match(/^result:\s*(.+)$/m)?.[1]?.trim() ?? "";
  // dispositions is optional (PR tasks only) and may span multiple lines
  const dispMatch = lines.match(/^dispositions:\s*(.*(?:\n\s+-.*)*)/m);
  const dispositions = dispMatch?.[1]
    ? dispMatch[1].split("\n").map(l => l.trimStart()).filter(Boolean).join("\n") || undefined
    : undefined;
  return { id, title, result, dispositions };
}

const RATE_LIMIT_PATTERNS = [
  /you['']ve hit your limit/i,
  /rate limit/i,
  /\b429\b/,
  /too many requests/i,
  /usage limit/i,
];

function isRateLimited(output: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(output));
}

const AUTH_FAILURE_PATTERNS = [
  /not logged in/i,
  /API Error: 403/i,
  /Request not allowed/i,
  /Failed to authenticate/i,
];

function isAuthFailure(output: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((p) => p.test(output));
}

/** Keep the last N lines of a string. */
function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return `...(${lines.length - n} older entries omitted)\n` + lines.slice(-n).join("\n");
}

/** Hard-truncate a string to maxChars. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...(truncated)";
}

function extractKeyDetails(output: string): string {
  const details: string[] = [];
  // Extract URLs (PRs, issues, etc.)
  const urls = output.match(/https?:\/\/github\.com\/[^\s)>\]]+/g);
  if (urls) {
    for (const url of [...new Set(urls)]) {
      if (url.includes("/pull/")) details.push(`PR: ${url}`);
      else if (url.includes("/issues/")) details.push(`Issue: ${url}`);
      else details.push(`Link: ${url}`);
    }
  }
  // Extract branch names
  const branch = output.match(/branch[:\s]+`?([^\s`]+)`?/i);
  if (branch) details.push(`Branch: ${branch[1]}`);
  // Extract file changes
  const files = output.match(/Files changed[\s\S]*?(?=\n\n|\n#|$)/i);
  if (files) details.push(files[0].trim());
  return details.join("\n");
}

