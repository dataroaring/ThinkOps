import { readFile, readdir, stat, mkdir } from "fs/promises";
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

    this.bot.onCommand("tasks", async () => {
      const tasks = await this.scanTasks();
      if (tasks.length === 0) return "No pending tasks.";
      return tasks.map((t) => `- ${t.name} (${t.status})`).join("\n");
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
    } catch {
      // Telegram not available, already logged above
    }
  }

  stop(): void {
    this.running = false;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    this.bot.stop();
    console.log("[orchestrator] stopped");
  }

  // ── Task Loop ──────────────────────────────────────────

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
    const tasks = await this.scanTasks();
    const todo = tasks.filter((t) => t.status === "todo");
    const done = tasks.filter((t) => t.status === "done");
    const next = todo.sort((a, b) => a.estimatedCost - b.estimatedCost)[0];

    console.log(
      `[task-loop] poll #${this.taskPollCount}: ${tasks.length} tasks (${todo.length} todo, ${done.length} done)${next ? ` — next: ${next.name}` : " — idle"}`
    );

    if (!next) return;

    console.log(`[task-loop] executing: ${next.name}`);
    this.bot.notify(`Starting task: *${next.name}*`).catch(() => {});

    // Step 1: Select relevant skills
    const skillContext = await this.loadSkillContext(next.description);

    // Step 2: Execute task with skill context
    const result = await spawn(this.config, "task-executor", {
      task_path: next.path,
      skill_context: skillContext,
    });

    // Step 3: Handle human input if needed
    if (result.humanInputNeeded) {
      console.log(`[task-loop] human input needed: ${result.humanInputNeeded}`);
      try {
        const answer = await this.bot.askQuestion(result.humanInputNeeded);
        // Resume the agent session with the answer
        const resumed = await resume(
          this.config,
          result.sessionId,
          `The user answered: ${answer}\n\nPlease continue executing the task.`,
        );
        await this.bot.notify(
          `Task *${next.name}* resumed.\n${resumed.humanInputNeeded ? "More input needed." : "Completed."}`
        );
      } catch (err) {
        console.error(`[task-loop] Q&A failed for ${next.name}:`, err);
        this.bot.notify(`Task *${next.name}* timed out waiting for input.`).catch(() => {});
      }
    } else {
      console.log(`[task-loop] task completed: ${next.name}`);
      this.bot.notify(`Task *${next.name}* completed.`).catch(() => {});
    }
  }

  private async scanTasks(): Promise<TaskInfo[]> {
    const dir = resolve(this.config.vaultPath, "tasks");
    try {
      const files = await readdir(dir);
      const tasks: TaskInfo[] = [];
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const path = join(dir, f);
        const content = await readFile(path, "utf-8");

        // Use frontmatter status if present, otherwise infer from checkboxes
        let status = extractFrontmatterField(content, "status");
        if (!status) {
          const hasUnchecked = /- \[ \]/.test(content);
          const hasChecked = /- \[x\]/i.test(content);
          if (hasUnchecked) status = "todo";
          else if (hasChecked) status = "done";
          else status = "unknown";
        }

        // Use ## Description if present, otherwise use full content as description
        let description = extractSection(content, "Description");
        if (!description) {
          description = content.replace(/^---[\s\S]*?^---\s*/m, "").trim();
        }

        const costStr = extractFrontmatterField(content, "estimated_cost");
        const estimatedCost = costStr ? parseFloat(costStr) : Infinity;
        console.log(`[task-loop]   scanned: ${f} → status=${status}, cost=${estimatedCost === Infinity ? "none" : estimatedCost}`);
        tasks.push({ name: f.replace(".md", ""), path, status, description, estimatedCost });
      }
      return tasks;
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
      "tasks",
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

interface TaskInfo {
  name: string;
  path: string;
  status: string;
  description: string;
  estimatedCost: number;
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

function extractSection(content: string, heading: string): string {
  const re = new RegExp(
    `^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`,
    "m"
  );
  const match = content.match(re);
  return match?.[1]?.trim() ?? "";
}
