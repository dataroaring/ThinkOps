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
      const connectors = await this.scanConnectors();
      if (connectors.length === 0) return "No connectors found.";
      return connectors.map((c) => {
        const pending = c.pendingTasks.length;
        const first = c.pendingTasks[0];
        const preview = first && first.length > 40 ? first.slice(0, 37) + "..." : first;
        return `- *${c.name}*: ${pending} pending${preview ? ` — next: ${preview}` : ""}`;
      }).join("\n");
    });

    // Keep /tasks as alias
    this.bot.onCommand("tasks", async () => {
      const connectors = await this.scanConnectors();
      const pending = connectors.flatMap((c) =>
        c.pendingTasks.map((t) => `- [${c.name}] ${t.length > 50 ? t.slice(0, 47) + "..." : t}`)
      );
      return pending.length > 0 ? pending.join("\n") : "No pending tasks.";
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

    this.bot.onCommand("todo", async (args) => {
      if (!args) return "Usage: /todo <connector-name> <task description>\nExample: /todo doris fix the memory leak in BE";
      const parts = args.split(/\s+/);
      const connectorName = parts[0].toLowerCase();
      const taskDesc = parts.slice(1).join(" ");
      if (!taskDesc) return "Usage: /todo <connector-name> <task description>";
      const filePath = resolve(this.config.vaultPath, "connectors", `${connectorName}.md`);
      try {
        // Append to existing connector
        const content = await readFile(filePath, "utf-8");
        const updated = content.trimEnd() + `\n- [ ] ${taskDesc}\n`;
        await writeFile(filePath, updated);
        return `Task added to connector *${connectorName}*: ${taskDesc}`;
      } catch {
        // Create new connector
        const now = new Date().toISOString().slice(0, 10);
        const content = `# Context\n\n# tasks\n- [ ] ${taskDesc}\n\n# Progress log\n- ${now}: Connector created via Telegram\n`;
        await writeFile(filePath, content);
        return `New connector *${connectorName}* created with task: ${taskDesc}`;
      }
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
        console.error("[task-loop] error:", err);
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
    const connectors = await this.scanConnectors();
    const withPending = connectors.filter((c) => c.pendingTasks.length > 0);
    const totalPending = withPending.reduce((sum, c) => sum + c.pendingTasks.length, 0);

    // Pick the connector with the lowest estimated cost
    const next = withPending.sort((a, b) => a.estimatedCost - b.estimatedCost)[0];
    const nextTask = next?.pendingTasks[0];
    const shortTask = nextTask && nextTask.length > 60 ? nextTask.slice(0, 57) + "..." : nextTask;

    console.log(
      `[task-loop] poll #${this.taskPollCount}: ${connectors.length} connectors, ${totalPending} pending tasks${next ? ` — next: [${next.name}] ${shortTask}` : " — idle"}`
    );

    if (!next || !nextTask) return;

    // Extract code directory from connector context if present
    const cwdMatch = next.content.match(/code directory:\s*(.+)/);
    const taskCwd = cwdMatch?.[1]?.trim();
    console.log(`[task-loop] executing [${next.name}]: ${shortTask}${taskCwd ? ` (cwd: ${taskCwd})` : ""}`);
    this.bot.notify(`Starting [${next.name}]: *${shortTask}*`).catch(() => {});

    // Step 1: Select relevant skills
    const skillContext = await this.loadSkillContext(next.content);

    // Step 2: Pass full connector content to agent — agent interprets context + tasks
    const result = await spawn(this.config, "task-executor", {
      task_path: next.path,
      task_content: next.content,
      skill_context: skillContext,
    }, { cwd: taskCwd, label: `${next.name}: ${shortTask}` });

    // Log agent output for visibility
    const outputPreview = result.output.slice(0, 500);
    console.log(`[task-loop] agent output:\n${outputPreview}${result.output.length > 500 ? "\n...(truncated)" : ""}`);

    // Step 3: Handle human input loop — agent may ask multiple questions
    let current = result;
    while (current.humanInputNeeded) {
      console.log(`[task-loop] human input needed: ${current.humanInputNeeded}`);
      try {
        const answer = await this.bot.askQuestion(current.humanInputNeeded);
        console.log(`[task-loop] user answered: ${answer}`);
        current = await resume(
          this.config,
          current.sessionId,
          `The user answered: ${answer}\n\nPlease continue executing the task.`,
        );
        const resumePreview = current.output.slice(0, 300);
        console.log(`[task-loop] resumed output:\n${resumePreview}${current.output.length > 300 ? "\n...(truncated)" : ""}`);
      } catch (err) {
        console.error(`[task-loop] Q&A failed for [${next.name}] ${shortTask}:`, err);
        this.bot.notify(`[${next.name}] *${shortTask}* timed out waiting for input.`).catch(() => {});
        break;
      }
    }

    if (!current.humanInputNeeded) {
      // Re-read connector to check if agent updated it
      const updatedContent = await readFile(next.path, "utf-8");
      const previousPending = next.pendingTasks.length;
      const currentPending = (updatedContent.match(/- \[ \]/g) || []).length;

      if (currentPending < previousPending) {
        const completed = previousPending - currentPending;
        console.log(`[task-loop] ${completed} task(s) completed in [${next.name}]`);
        const details = extractKeyDetails(current.output);
        const summary = [
          `✅ *Task completed* [${next.name}]`,
          `*${nextTask}*`,
          details ? `\n${details}` : "",
          current.cost ? `\nCost: $${current.cost.toFixed(4)}` : "",
          currentPending > 0 ? `\n${currentPending} task(s) remaining` : "",
        ].filter(Boolean).join("\n");
        this.bot.notify(summary).catch(() => {});
      } else {
        // Agent didn't update the connector — mark to avoid infinite loop
        console.warn(`[task-loop] agent did not update connector. Marking as blocked.`);
        const blockedNote = `\n\n> [!warning] ThinkOps: Agent completed without updating this file. Review output in thinkops/_run_log.md\n`;
        await appendFile(next.path, blockedNote);
        this.bot.notify(`⚠️ [${next.name}] *${shortTask}*: agent finished but didn't update the connector.`).catch(() => {});
      }
    }
  }

  private async scanConnectors(): Promise<ConnectorInfo[]> {
    const dir = resolve(this.config.vaultPath, "connectors");
    try {
      const files = await readdir(dir);
      const connectors: ConnectorInfo[] = [];
      for (const f of files) {
        if (!f.endsWith(".md") || f.startsWith("_")) continue;
        const path = join(dir, f);
        const content = await readFile(path, "utf-8");
        const name = f.replace(".md", "");

        // Minimal detection: just find unchecked items
        const pendingMatches = content.match(/- \[ \]\s*(.+)/g) || [];
        const pendingTasks = pendingMatches.map((m) => m.replace(/^- \[ \]\s*/, "").trim());

        // Skip if connector has a block warning (agent failed to update)
        if (content.includes("ThinkOps: Agent completed without updating")) {
          console.log(`[task-loop]   ${name}: blocked (needs manual review)`);
          continue;
        }

        const costStr = extractFrontmatterField(content, "estimated_cost");
        const estimatedCost = costStr ? parseFloat(costStr) : Infinity;

        const shortPreview = pendingTasks[0]?.slice(0, 50) ?? "(no pending)";
        console.log(`[task-loop]   ${name}: ${pendingTasks.length} pending — "${shortPreview}"`);
        connectors.push({ name, path, content, pendingTasks, estimatedCost });
      }
      return connectors;
    } catch {
      return [];
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
    ];
    for (const d of dirs) {
      await mkdir(resolve(this.config.vaultPath, d), { recursive: true });
    }
  }
}

// ── Helpers ────────────────────────────────────────────

interface ConnectorInfo {
  name: string;           // connector name (filename without .md)
  path: string;           // full path to connector file
  content: string;        // raw file content — agent interprets everything
  pendingTasks: string[]; // text of unchecked `- [ ]` items
  estimatedCost: number;  // from frontmatter, or Infinity
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

function extractFrontmatterField(
  content: string,
  field: string
): string | undefined {
  const match = content.match(
    new RegExp(`^---[\\s\\S]*?^${field}:\\s*(.+)$[\\s\\S]*?^---`, "m")
  );
  return match?.[1]?.trim();
}
