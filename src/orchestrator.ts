import { readFile, readdir, writeFile, stat, mkdir, appendFile } from "fs/promises";
import { resolve, join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";
import type { Config } from "./config.js";
import { spawn, resume } from "./agent/spawner.js";
import { TelegramBot } from "./telegram/bot.js";
import { watchFolder } from "./utils/file-watcher.js";
import { startDashboard } from "./web/server.js";

interface ActiveAgent {
  connector: string;
  phase: string;
  taskId?: string;
  taskTitle?: string;
  startedAt: number;
  phaseStartedAt: number;
}

/** Per-run logging context — every log line includes connector, run#, taskId, and phase. */
class RunLog {
  private phaseTimings: { phase: string; durationMs: number }[] = [];
  private currentPhaseStart = 0;

  constructor(
    private connector: string,
    private runNum: number,
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
    this.currentPhaseStart = Date.now();
    this.log(`▸ ${phase}`);
  }

  endPhase(): void {
    if (this.currentPhaseStart > 0) {
      this.phaseTimings.push({
        phase: this.phaseTimings.length.toString(),
        durationMs: Date.now() - this.currentPhaseStart,
      });
      this.currentPhaseStart = 0;
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

  constructor(private config: Config) {
    this.bot = new TelegramBot(config);
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

  private registerCommands(): void {
    this.bot.onCommand("status", async () => {
      const uptime = this.startedAt ? formatDuration(Date.now() - this.startedAt) : "not started";
      const connectorCount = this.connectorPolls.size;
      const active = this.activeAgents.size;
      const max = this.config.taskConcurrency;

      const lines = [
        `*ThinkOps* running for ${uptime}`,
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

    // Start task loops (parallel, one per connector)
    console.log("[orchestrator] starting task loops (concurrency=%d, poll every %ds)...", this.config.taskConcurrency, this.config.taskPollInterval);
    this.startTaskLoop();

    // Start knowledge watcher
    console.log("[orchestrator] starting knowledge watcher...");
    this.startKnowledgeWatcher();

    // Start skill loops
    console.log("[orchestrator] starting skill loops...");
    this.startSkillLoops();

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
      const source = content.match(/##\s*Source\s*\n([\s\S]*?)(?=\n##|\n$)/)?.[1]?.trim() ?? "unknown";
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
      "  ThinkOps — Startup Plan",
      divider,
      "",
      `  Agent:       ${cfg.agentCli}/${cfg.agentModel}`,
      `  Concurrency: ${cfg.taskConcurrency} parallel agents`,
      `  Poll:        every ${cfg.taskPollInterval}s`,
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
      `*ThinkOps started*`,
      `Agent: ${cfg.agentCli}/${cfg.agentModel}`,
      `Concurrency: ${cfg.taskConcurrency} | Poll: ${cfg.taskPollInterval}s`,
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
        const timer = setTimeout(discover, this.config.taskPollInterval * 1000);
        this.timers.push(timer);
      }
    };
    discover();
  }

  private startConnectorLoop(name: string, path: string): void {
    const poll = async () => {
      if (!this.running) return;

      // Check rate limit backoff
      const backoff = this.rateLimitBackoff.get(name);
      if (backoff && Date.now() < backoff.until) {
        const waitSecs = Math.round((backoff.until - Date.now()) / 1000);
        console.log(`${ts()} [${name}] rate-limited, backing off for ${waitSecs}s`);
        if (this.running) {
          const timer = setTimeout(poll, Math.min(backoff.until - Date.now(), 60_000));
          this.timers.push(timer);
        }
        return;
      }

      try {
        await this.runConnector(name, path);
      } catch (err) {
        console.error(`${ts()} [${name}] error:`, err);
      }
      if (this.running) {
        const timer = setTimeout(poll, this.config.taskPollInterval * 1000);
        this.timers.push(timer);
      }
    };
    poll();
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

    const run = new RunLog(name, pollNum);
    run.log(`── poll #${pollNum} ──────────────────────`);

    const content = await readFile(path, "utf-8");
    const auditLog = await this.loadAuditLog(name);
    const doneCount = (auditLog.match(/\| DONE \|/g) || []).length;
    run.log(`audit: ${doneCount} tasks completed previously`);

    // Extract code directory from connector context
    const cwdMatch = content.match(/code directory:\s*(.+)/);
    const taskCwd = cwdMatch?.[1]?.trim();
    if (taskCwd) run.log(`cwd: ${taskCwd}`);

    // Acquire concurrency slot before spawning agent
    if (!(await this.acquireSlot(name))) return;

    this.setPhase(name, "preflight");

    try {
      // Load past eval findings for failure memory + analogical reasoning
      const pastFindings = await this.loadPastFindings(name);

      // Phase 1: Pre-flight analysis — LLM thinks about best approach
      run.startPhase("preflight");
      this.setPhase(name, "preflight");
      const preflight = await spawn(this.config, "task-preflight", {
        connector_content: content,
        audit_log: auditLog || "(empty — no tasks completed yet)",
        past_findings: pastFindings || "(no past findings yet)",
      }, { cwd: taskCwd, label: `preflight: ${name}` });

      const preflightOutput = preflight.output;
      run.log(`pre-flight done (${preflightOutput.length} chars)`);

      // Select relevant skills
      run.startPhase("skill-select");
      this.setPhase(name, "skill-select");
      const skillContext = await this.loadSkillContext(content);

      // Phase 2: Execute with pre-flight guidance
      run.startPhase("execute");
      this.setPhase(name, "execute");

      const result = await spawn(this.config, "connector-run", {
        connector_path: path,
        connector_content: content,
        audit_log: auditLog || "(empty — no tasks completed yet)",
        skill_context: skillContext,
        preflight_analysis: preflightOutput,
      }, { cwd: taskCwd, label: name });

      // Handle human input loop
      let current = result;
      while (current.humanInputNeeded) {
        run.startPhase("human-input");
        this.setPhase(name, "human-input");
        run.log(`waiting for human: ${current.humanInputNeeded}`);
        try {
          const answer = await this.bot.askQuestion(current.humanInputNeeded);
          run.log(`user replied, resuming session ${current.sessionId}`);
          run.startPhase("execute (resumed)");
          this.setPhase(name, "execute (resumed)");
          current = await resume(
            this.config,
            current.sessionId,
            `The user answered: ${answer}\n\nPlease continue executing the task.`,
          );
        } catch (err) {
          run.error("Q&A timed out", err);
          this.bot.notify(`[${name}] timed out waiting for input.`).catch(() => {});
          break;
        }
      }

      // Rate limit detection
      if (isRateLimited(current.output)) {
        run.warn("rate limit detected — applying backoff");
        const existing = this.rateLimitBackoff.get(name);
        const delay = existing ? Math.min(existing.delay * 2, this.BACKOFF_MAX) : this.BACKOFF_INITIAL;
        const until = Date.now() + delay;
        this.rateLimitBackoff.set(name, { until, delay });
        this.emitEvent({
          type: "rate_limited",
          connector: name,
          timestamp: Date.now(),
          message: `Rate limited, backing off for ${Math.round(delay / 60000)}min`,
          backoffUntil: until,
        });
        this.bot.notify(`[${name}] rate-limited, backing off for ${Math.round(delay / 60000)}min`).catch(() => {});
        console.log(run.summary("rate-limited"));
        return;
      }
      // Clear backoff on successful run
      this.rateLimitBackoff.delete(name);

      // Parse result
      if (current.output.includes("NO_TASKS_AVAILABLE")) {
        run.log("result: no new tasks");
        this.totalNoTasks++;
        await this.appendAuditCheck(name);
        console.log(run.summary("no tasks"));
      } else {
        let completed = parseTaskCompleted(current.output);
        if (completed) {
          run.taskId = completed.id;
          this.setPhase(name, "completed", completed.id, completed.title);
          run.log(`task done: ${completed.title}`);
          run.log(`result: ${completed.result}`);
          if (completed.dispositions) run.log(`dispositions:\n${completed.dispositions}`);

          // Run critic agent to challenge the result
          run.startPhase("critic");
          this.setPhase(name, "critic", completed.id, completed.title);
          const critique = await this.runCritique(name, content, completed, current.output);

          if (critique === "needs_fix" && current.sessionId) {
            run.startPhase("fix-pass");
            this.setPhase(name, "fix-pass", completed.id, completed.title);
            run.log("critic found issues — running fix pass");
            current = await resume(
              this.config,
              current.sessionId,
              "A critic agent reviewed your work and found issues. Please fix them and report TASK_COMPLETED again.",
            );
            const fixed = parseTaskCompleted(current.output);
            if (fixed) completed = fixed;
            run.log("fix pass complete");
          }

          if (current.cost) run.log(`cost: $${current.cost.toFixed(4)}`);
          if (current.turns) run.log(`turns: ${current.turns}`);
          await this.appendAuditTask(name, completed);
          this.totalCompleted++;
          this.connectorDoneCounts.set(name, (this.connectorDoneCounts.get(name) ?? 0) + 1);
          this.emitEvent({
            type: "completed",
            connector: name,
            taskId: completed.id,
            title: completed.title,
            result: completed.result,
            cost: current.cost,
            timestamp: Date.now(),
          });

          const details = extractKeyDetails(current.output);
          const summary = [
            `*Task completed* [${name}/${completed.id}]`,
            `*${completed.title}*`,
            completed.result ? `\n${completed.result}` : "",
            details ? `\n${details}` : "",
            current.cost ? `\nCost: $${current.cost.toFixed(4)}` : "",
          ].filter(Boolean).join("\n");
          this.bot.notify(summary).catch(() => {});

          // Run eval agent on the completed task
          run.startPhase("eval");
          this.setPhase(name, "eval", completed.id, completed.title);
          const quality = await this.runEval(name, content, completed, current.output);

          // Emit pipeline summary — recap of everything that happened
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
          this.emitEvent({
            type: "summary",
            connector: name,
            taskId: completed.id,
            title: completed.title,
            result: completed.result,
            quality,
            cost: current.cost,
            summary: summaryLines,
            timestamp: Date.now(),
          });

          console.log(run.summary(`completed ${completed.id}`));
        } else if (!current.humanInputNeeded) {
          run.warn("agent finished without TASK_COMPLETED or NO_TASKS_AVAILABLE");
          this.emitEvent({
            type: "log",
            connector: name,
            message: "Agent finished without TASK_COMPLETED or NO_TASKS_AVAILABLE",
            level: "warn",
            timestamp: Date.now(),
          });
          console.log(run.summary("no result parsed"));
        }
      }
    } catch (err) {
      run.error("run failed", err);
    } finally {
      this.activeAgents.delete(name);
      this.releaseSlot(name);
    }
  }

  // ── Connector & Audit ───────────────────────────────

  private async listConnectors(): Promise<{ name: string; path: string }[]> {
    const dir = resolve(this.config.vaultPath, "connectors");
    try {
      const files = await readdir(dir);
      return files
        .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
        .map((f) => ({ name: f.replace(".md", ""), path: join(dir, f) }));
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
      entry += `  dispositions:\n${task.dispositions.split("\n").map(l => `    ${l}`).join("\n")}\n`;
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

  // ── Past Findings ───────────────────────────────────

  private async loadPastFindings(connectorName: string): Promise<string> {
    const findings: string[] = [];

    // Load eval entries from this connector's audit log
    const auditLog = await this.loadAuditLog(connectorName);
    const evalLines = auditLog.split("\n").filter((l) => l.includes("| EVAL |"));
    if (evalLines.length > 0) {
      findings.push("## Past eval scores for this connector:");
      findings.push(...evalLines.slice(-10)); // Last 10 evals
    }

    // Load CODE findings from the thinkops connector (accumulated improvement tasks)
    const thinkopsPath = resolve(this.config.vaultPath, "connectors/thinkops.md");
    try {
      const thinkopsContent = await readFile(thinkopsPath, "utf-8");
      const tasks = thinkopsContent.split("\n").filter((l) => l.startsWith("- ["));
      if (tasks.length > 0) {
        findings.push("\n## Past CODE findings (improvement tasks):");
        findings.push(...tasks.slice(-10)); // Last 10 tasks
      }
    } catch {
      // No thinkops connector
    }

    return findings.join("\n");
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
        const thinkopsPath = resolve(this.config.vaultPath, "connectors/thinkops.md");
        const now = new Date().toISOString().slice(0, 10);
        const entry = `- [ ] ${finding} _(from eval of [${connectorName}] ${taskId}, ${now})_\n`;
        await appendFile(thinkopsPath, entry);
        console.log(`${ts()} [${tag}] eval → task added to thinkops connector`);
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
      await stat(treePath);
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
      for (const p of paths.slice(0, 5)) {
        try {
          const content = await readFile(
            resolve(this.config.vaultPath, p),
            "utf-8"
          );
          skills.push(`--- Skill: ${p} ---\n${content}`);
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
    const lintTimer = setInterval(async () => {
      if (!this.running) return;
      console.log("[knowledge] running lint...");
      try {
        await spawn(this.config, "knowledge-lint", {});
      } catch (err) {
        console.error("[knowledge] lint error:", err);
      }
    }, lintInterval);
    this.timers.push(lintTimer as unknown as NodeJS.Timeout);
  }

  // ── Skill Loop ─────────────────────────────────────────

  private startSkillLoops(): void {
    // Periodic skill extraction from conversation history
    const extractInterval = this.config.skillExtractInterval * 1000;
    const extractTimer = setInterval(async () => {
      if (!this.running) return;
      await this.runSkillExtraction();
    }, extractInterval);
    this.timers.push(extractTimer as unknown as NodeJS.Timeout);

    // Less frequent skill organization
    const organizeInterval = this.config.skillOrganizeInterval * 1000;
    const organizeTimer = setInterval(async () => {
      if (!this.running) return;
      console.log("[skills] running organize...");
      try {
        await spawn(this.config, "skill-organize", {});
      } catch (err) {
        console.error("[skills] organize error:", err);
      }
    }, organizeInterval);
    this.timers.push(organizeTimer as unknown as NodeJS.Timeout);
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
      "thinkops",
      "thinkops/audit",
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

function parseTaskCompleted(output: string): { id: string; title: string; result: string; dispositions?: string } | null {
  const block = output.match(/TASK_COMPLETED\s*\n([\s\S]*?)(?:\n```|$)/);
  if (!block) return null;
  const lines = block[1];
  const id = lines.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
  const title = lines.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "untitled";
  const result = lines.match(/^result:\s*(.+)$/m)?.[1]?.trim() ?? "";
  // dispositions is optional (PR tasks only) and may span multiple lines
  const dispMatch = lines.match(/^dispositions:\s*(.*(?:\n\s+-.*)*)/m);
  const dispositions = dispMatch?.[1]?.trim() || undefined;
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

