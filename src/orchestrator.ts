import { readFile, readdir, writeFile, stat, mkdir, appendFile } from "fs/promises";
import { resolve, join } from "path";
import { homedir } from "os";
import type { Config } from "./config.js";
import { spawn, resume } from "./agent/spawner.js";
import { TelegramBot } from "./telegram/bot.js";
import { watchFolder } from "./utils/file-watcher.js";

export class Orchestrator {
  private bot: TelegramBot;
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private config: Config) {
    this.bot = new TelegramBot(config);
    this.registerCommands();
  }

  private registerCommands(): void {
    this.bot.onCommand("status", async () => {
      return "ThinkOps is running.\n" +
        `Agent: ${this.config.agentCli}/${this.config.agentModel}\n` +
        `Vault: ${this.config.vaultPath}`;
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

    // Start task loop
    console.log("[orchestrator] starting task loop (poll every %ds)...", this.config.taskPollInterval);
    this.startTaskLoop();

    // Start knowledge watcher
    console.log("[orchestrator] starting knowledge watcher...");
    this.startKnowledgeWatcher();

    // Start skill loops
    console.log("[orchestrator] starting skill loops...");
    this.startSkillLoops();

    console.log("[orchestrator] all loops started");
    try {
      await this.bot.notify("ThinkOps started. All loops active.");
      console.log("[orchestrator] startup notification sent to telegram");
    } catch (err) {
      console.error("[orchestrator] failed to send startup notification:", err instanceof Error ? err.message : err);
    }
  }

  stop(): void {
    this.running = false;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    this.bot.stop();
    console.log("[orchestrator] stopped");
  }

  // ── Task Loop (Connector-driven) ──────────────────────

  private startTaskLoop(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        await this.runTaskLoop();
      } catch (err) {
        console.error(`[task-loop ${ts()}] error:`, err);
      }
      if (this.running) {
        const timer = setTimeout(poll, this.config.taskPollInterval * 1000);
        this.timers.push(timer);
      }
    };
    poll();
  }

  private taskPollCount = 0;

  private async runTaskLoop(): Promise<void> {
    this.taskPollCount++;
    const connectors = await this.listConnectors();

    if (connectors.length === 0) {
      console.log(`[task-loop ${ts()}] poll #${this.taskPollCount}: no connectors — idle`);
      return;
    }

    // Round-robin through connectors
    const idx = (this.taskPollCount - 1) % connectors.length;
    const connector = connectors[idx];

    console.log(`[task-loop ${ts()}] poll #${this.taskPollCount}: ${connectors.length} connectors — running [${connector.name}]`);

    const content = await readFile(connector.path, "utf-8");
    const auditLog = await this.loadAuditLog(connector.name);

    // Extract code directory from connector context
    const cwdMatch = content.match(/code directory:\s*(.+)/);
    const taskCwd = cwdMatch?.[1]?.trim();

    this.bot.notify(`Checking connector [${connector.name}]...`).catch(() => {});

    // Select relevant skills
    const skillContext = await this.loadSkillContext(content);

    // Spawn agent: fetch task from source + execute + report
    const result = await spawn(this.config, "connector-run", {
      connector_path: connector.path,
      connector_content: content,
      audit_log: auditLog || "(empty — no tasks completed yet)",
      skill_context: skillContext,
    }, { cwd: taskCwd, label: connector.name });

    // Log output
    const outputPreview = result.output.slice(0, 500);
    console.log(`[task-loop ${ts()}] agent output:\n${outputPreview}${result.output.length > 500 ? "\n...(truncated)" : ""}`);

    // Handle human input loop
    let current = result;
    while (current.humanInputNeeded) {
      console.log(`[task-loop ${ts()}] human input needed: ${current.humanInputNeeded}`);
      try {
        const answer = await this.bot.askQuestion(current.humanInputNeeded);
        console.log(`[task-loop ${ts()}] user answered: ${answer}`);
        current = await resume(
          this.config,
          current.sessionId,
          `The user answered: ${answer}\n\nPlease continue executing the task.`,
        );
        const resumePreview = current.output.slice(0, 300);
        console.log(`[task-loop ${ts()}] resumed output:\n${resumePreview}${current.output.length > 300 ? "\n...(truncated)" : ""}`);
      } catch (err) {
        console.error(`[task-loop ${ts()}] Q&A failed for [${connector.name}]:`, err);
        this.bot.notify(`[${connector.name}] timed out waiting for input.`).catch(() => {});
        break;
      }
    }

    // Parse result
    if (current.output.includes("NO_TASKS_AVAILABLE")) {
      console.log(`[task-loop ${ts()}] [${connector.name}]: no tasks available`);
      await this.appendAuditCheck(connector.name);
    } else {
      const completed = parseTaskCompleted(current.output);
      if (completed) {
        console.log(`[task-loop ${ts()}] [${connector.name}] completed: ${completed.id} — ${completed.title}`);
        await this.appendAuditTask(connector.name, completed);
        const details = extractKeyDetails(current.output);
        const summary = [
          `✅ *Task completed* [${connector.name}]`,
          `*${completed.title}*`,
          completed.result ? `\n${completed.result}` : "",
          details ? `\n${details}` : "",
          current.cost ? `\nCost: $${current.cost.toFixed(4)}` : "",
        ].filter(Boolean).join("\n");
        this.bot.notify(summary).catch(() => {});
      } else if (!current.humanInputNeeded) {
        console.warn(`[task-loop ${ts()}] [${connector.name}]: agent finished without clear result`);
        this.bot.notify(`⚠️ [${connector.name}]: agent finished without reporting task completion. Check thinkops/_run_log.md`).catch(() => {});
      }
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
    task: { id: string; title: string; result: string }
  ): Promise<void> {
    const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
    await mkdir(auditDir, { recursive: true });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const entry = `- ${now} | DONE | **${task.id}** | ${task.title} | ${task.result}\n`;
    await appendFile(this.auditPath(connectorName), entry);
  }

  private async appendAuditCheck(connectorName: string): Promise<void> {
    const auditDir = resolve(this.config.vaultPath, "thinkops/audit");
    await mkdir(auditDir, { recursive: true });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const entry = `- ${now} | CHECKED | no new tasks\n`;
    await appendFile(this.auditPath(connectorName), entry);
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

function parseTaskCompleted(output: string): { id: string; title: string; result: string } | null {
  const block = output.match(/TASK_COMPLETED\s*\n([\s\S]*?)(?:\n```|$)/);
  if (!block) return null;
  const lines = block[1];
  const id = lines.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
  const title = lines.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "untitled";
  const result = lines.match(/^result:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { id, title, result };
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

