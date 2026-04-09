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

    // Start task loops (parallel, one per connector)
    console.log("[orchestrator] starting task loops (concurrency=%d, poll every %ds)...", this.config.taskConcurrency, this.config.taskPollInterval);
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

  // ── Task Loops (parallel, one per connector) ──────────

  private semaphore = 0;
  private connectorPolls = new Map<string, number>();

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

  private async runConnector(name: string, path: string): Promise<void> {
    const pollNum = (this.connectorPolls.get(name) ?? 0) + 1;
    this.connectorPolls.set(name, pollNum);

    console.log(`${ts()} ─── [${name}] poll #${pollNum} ───────────────────────`);

    const content = await readFile(path, "utf-8");
    const auditLog = await this.loadAuditLog(name);
    const doneCount = (auditLog.match(/\| DONE \|/g) || []).length;
    console.log(`${ts()} [${name}] audit: ${doneCount} tasks completed previously`);

    // Extract code directory from connector context
    const cwdMatch = content.match(/code directory:\s*(.+)/);
    const taskCwd = cwdMatch?.[1]?.trim();
    if (taskCwd) console.log(`${ts()} [${name}] cwd: ${taskCwd}`);

    // Acquire concurrency slot before spawning agent
    if (!(await this.acquireSlot(name))) return;

    try {
      // Load past eval findings for failure memory + analogical reasoning
      const pastFindings = await this.loadPastFindings(name);

      // Phase 1: Pre-flight analysis — LLM thinks about best approach
      console.log(`${ts()} [${name}] running pre-flight analysis...`);
      const preflight = await spawn(this.config, "task-preflight", {
        connector_content: content,
        audit_log: auditLog || "(empty — no tasks completed yet)",
        past_findings: pastFindings || "(no past findings yet)",
      }, { cwd: taskCwd, label: `preflight: ${name}` });

      const preflightOutput = preflight.output;
      console.log(`${ts()} [${name}] pre-flight: ${preflightOutput.slice(0, 300)}`);

      // Select relevant skills
      console.log(`${ts()} [${name}] loading skills...`);
      const skillContext = await this.loadSkillContext(content);

      // Phase 2: Execute with pre-flight guidance
      console.log(`${ts()} [${name}] spawning agent: fetch → execute → report`);
      this.bot.notify(`Checking connector [${name}]...`).catch(() => {});

      const result = await spawn(this.config, "connector-run", {
        connector_path: path,
        connector_content: content,
        audit_log: auditLog || "(empty — no tasks completed yet)",
        skill_context: skillContext,
        preflight_analysis: preflightOutput,
      }, { cwd: taskCwd, label: name });

      // Log output
      const outputPreview = result.output.slice(0, 500);
      console.log(`${ts()} [${name}] agent output:\n${outputPreview}${result.output.length > 500 ? "\n...(truncated)" : ""}`);

      // Handle human input loop
      let current = result;
      while (current.humanInputNeeded) {
        console.log(`${ts()} [${name}] waiting for human input: ${current.humanInputNeeded}`);
        try {
          const answer = await this.bot.askQuestion(current.humanInputNeeded);
          console.log(`${ts()} [${name}] user replied: ${answer}`);
          console.log(`${ts()} [${name}] resuming agent session ${current.sessionId}...`);
          current = await resume(
            this.config,
            current.sessionId,
            `The user answered: ${answer}\n\nPlease continue executing the task.`,
          );
          const resumePreview = current.output.slice(0, 300);
          console.log(`${ts()} [${name}] resumed output:\n${resumePreview}${current.output.length > 300 ? "\n...(truncated)" : ""}`);
        } catch (err) {
          console.error(`${ts()} [${name}] Q&A timed out:`, err);
          this.bot.notify(`[${name}] timed out waiting for input.`).catch(() => {});
          break;
        }
      }

      // Parse result
      if (current.output.includes("NO_TASKS_AVAILABLE")) {
        console.log(`${ts()} [${name}] result: no new tasks available`);
        await this.appendAuditCheck(name);
      } else {
        let completed = parseTaskCompleted(current.output);
        if (completed) {
          console.log(`${ts()} [${name}] task completed:`);
          console.log(`${ts()}   id:     ${completed.id}`);
          console.log(`${ts()}   title:  ${completed.title}`);
          console.log(`${ts()}   result: ${completed.result}`);

          // Run critic agent to challenge the result
          console.log(`${ts()} [${name}] running critic...`);
          const critique = await this.runCritique(name, content, completed, current.output);

          if (critique === "needs_fix" && current.sessionId) {
            console.log(`${ts()} [${name}] critic found issues — resuming agent to fix...`);
            current = await resume(
              this.config,
              current.sessionId,
              "A critic agent reviewed your work and found issues. Please fix them and report TASK_COMPLETED again.",
            );
            // Re-parse the fixed result
            const fixed = parseTaskCompleted(current.output);
            if (fixed) completed = fixed;
            console.log(`${ts()} [${name}] fix pass complete`);
          }

          if (current.cost) console.log(`${ts()}   cost:   $${current.cost.toFixed(4)}`);
          if (current.turns) console.log(`${ts()}   turns:  ${current.turns}`);
          await this.appendAuditTask(name, completed);

          const details = extractKeyDetails(current.output);
          const summary = [
            `*Task completed* [${name}]`,
            `*${completed.title}*`,
            completed.result ? `\n${completed.result}` : "",
            details ? `\n${details}` : "",
            current.cost ? `\nCost: $${current.cost.toFixed(4)}` : "",
          ].filter(Boolean).join("\n");
          this.bot.notify(summary).catch(() => {});

          // Run eval agent on the completed task
          console.log(`${ts()} [${name}] running eval...`);
          await this.runEval(name, content, completed, current.output);
        } else if (!current.humanInputNeeded) {
          console.warn(`${ts()} [${name}] agent finished without TASK_COMPLETED or NO_TASKS_AVAILABLE`);
          this.bot.notify(`[${name}]: agent finished without reporting task completion.`).catch(() => {});
        }
      }
    } finally {
      this.releaseSlot(name);
    }
    console.log(`${ts()} ─── [${name}] poll #${pollNum} done ──────────────────`);
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
    try {
      const critiqueResult = await spawn(this.config, "task-critique", {
        connector_content: connectorContent,
        task_result: `${task.id}: ${task.title}\n${task.result}`,
        agent_output: agentOutput.slice(0, 10_000),
      }, { label: `critique: ${connectorName}/${task.id}` });

      const output = critiqueResult.output;
      if (output.includes("status: needs_fix")) {
        const issues = output.match(/issues:\n([\s\S]*?)(?:\n```|$)/)?.[1]?.trim() ?? "unspecified issues";
        console.log(`${ts()} [critic] [${connectorName}] needs fix: ${issues.slice(0, 200)}`);
        return "needs_fix";
      }
      console.log(`${ts()} [critic] [${connectorName}] approved`);
      return "approved";
    } catch (err) {
      console.error(`${ts()} [critic] error:`, err);
      return "approved"; // Don't block on critic failure
    }
  }

  // ── Eval ─────────────────────────────────────────────

  private async runEval(
    connectorName: string,
    connectorContent: string,
    task: { id: string; title: string; result: string },
    agentOutput: string
  ): Promise<void> {
    console.log(`${ts()} [eval] evaluating [${connectorName}] ${task.id}: ${task.title}`);
    try {
      const evalResult = await spawn(this.config, "eval-run", {
        connector_content: connectorContent,
        task_result: `${task.id}: ${task.title}\n${task.result}`,
        agent_output: agentOutput.slice(0, 10_000),
      }, { label: `eval: ${connectorName}/${task.id}` });

      const evalOutput = evalResult.output;
      const quality = evalOutput.match(/quality:\s*(\d+)/)?.[1] ?? "?";
      console.log(`${ts()} [eval] [${connectorName}] ${task.id}: quality ${quality}/10`);
      if (evalResult.cost) console.log(`${ts()} [eval] cost: $${evalResult.cost.toFixed(4)}`);

      // Annotate audit log with quality score
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      await appendFile(this.auditPath(connectorName),
        `- ${now} | EVAL | **${task.id}** | quality: ${quality}/10\n`);

      // Route findings
      await this.routeEvalFindings(connectorName, task.id, evalOutput);
    } catch (err) {
      console.error(`${ts()} [eval] error:`, err);
    }
  }

  private async routeEvalFindings(
    connectorName: string,
    taskId: string,
    evalOutput: string
  ): Promise<void> {
    const lines = evalOutput.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("SKILL:")) {
        const finding = trimmed.slice(6).trim();
        console.log(`${ts()} [eval] → SKILL: ${finding}`);
        try {
          await spawn(this.config, "skill-extract", {
            history_chunk: `Eval finding from [${connectorName}] task ${taskId}:\n${finding}`,
          }, { label: `eval-skill: ${finding.slice(0, 40)}` });
          console.log(`${ts()} [eval]   skill saved`);
        } catch {
          console.warn(`${ts()} [eval]   skill save failed (non-critical)`);
        }
      } else if (trimmed.startsWith("CODE:")) {
        const finding = trimmed.slice(5).trim();
        console.log(`${ts()} [eval] → CODE: ${finding}`);
        // Append to thinkops connector as a task
        const thinkopsPath = resolve(this.config.vaultPath, "connectors/thinkops.md");
        const now = new Date().toISOString().slice(0, 10);
        const entry = `- [ ] ${finding} _(from eval of [${connectorName}] ${taskId}, ${now})_\n`;
        await appendFile(thinkopsPath, entry);
        console.log(`${ts()} [eval]   task added to thinkops connector`);
      } else if (trimmed.startsWith("CRITICAL:")) {
        const finding = trimmed.slice(9).trim();
        console.error(`${ts()} [eval] → 🚨 CRITICAL: ${finding}`);
        this.bot.notify(
          `🚨 *CRITICAL* [${connectorName}/${taskId}]\n${finding}`
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

