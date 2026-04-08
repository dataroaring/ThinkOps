import { loadConfig } from "./config.js";
import { stat, readdir } from "fs/promises";
import { resolve } from "path";
import { execFile } from "child_process";
import { Telegraf } from "telegraf";

type Status = "ok" | "fail" | "warn";

function log(status: Status, label: string, detail?: string): void {
  const icon = status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
  const msg = detail ? `${label}: ${detail}` : label;
  console.log(`  ${icon} ${msg}`);
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

function checkCli(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

export async function runCheck(): Promise<void> {
  console.log("\n[thinkops] Running health check...\n");

  let failures = 0;

  // 1. Config
  console.log("Config:");
  let config;
  try {
    config = loadConfig();
    log("ok", "Environment", `.env loaded`);
    log("ok", "Agent", `${config.agentCli}/${config.agentModel}`);
    log("ok", "Task poll interval", `${config.taskPollInterval}s`);
  } catch {
    log("fail", "Environment", "Failed to load config. Run: cp .env.example .env");
    failures++;
    process.exit(1);
  }

  // 2. Vault
  console.log("\nVault:");
  const vaultExists = await dirExists(config.vaultPath);
  if (vaultExists) {
    log("ok", "Vault path", config.vaultPath);
  } else {
    log("fail", "Vault path", `${config.vaultPath} not found`);
    failures++;
  }

  const vaultDirs = ["tasks", "knowledge", "knowledge/sources", "skills", "thinkops"];
  for (const d of vaultDirs) {
    const exists = await dirExists(resolve(config.vaultPath, d));
    if (exists) {
      log("ok", d);
    } else {
      log("warn", d, "missing (will be created on start)");
    }
  }

  const schemaFiles = ["knowledge/_schema.md", "skills/_schema.md"];
  for (const f of schemaFiles) {
    const exists = await fileExists(resolve(config.vaultPath, f));
    if (exists) {
      log("ok", f);
    } else {
      log("warn", f, "missing (copy from templates/)");
    }
  }

  // 3. Tasks
  console.log("\nTasks:");
  const tasksDir = resolve(config.vaultPath, "tasks");
  if (await dirExists(tasksDir)) {
    const files = (await readdir(tasksDir)).filter((f) => f.endsWith(".md"));
    log("ok", `${files.length} task file(s) found`);
    for (const f of files.slice(0, 5)) {
      log("ok", `  ${f}`);
    }
    if (files.length > 5) log("ok", `  ...and ${files.length - 5} more`);
  } else {
    log("warn", "No tasks/ directory");
  }

  // 4. Agent CLI
  console.log("\nAgent CLI:");
  const cliAvailable = await checkCli(config.agentCli);
  if (cliAvailable) {
    log("ok", config.agentCli, "found on PATH");
  } else {
    log("fail", config.agentCli, "not found on PATH");
    failures++;
  }

  // 5. Telegram
  console.log("\nTelegram:");
  try {
    const bot = new Telegraf(config.telegramBotToken);
    const me = await bot.telegram.getMe();
    log("ok", "Bot connected", `@${me.username}`);

    try {
      await bot.telegram.sendMessage(config.telegramChatId, "ThinkOps health check: OK");
      log("ok", "Chat reachable", `sent test message to ${config.telegramChatId}`);
    } catch (err) {
      log("fail", "Chat unreachable", `chat_id ${config.telegramChatId} — ${err instanceof Error ? err.message : err}`);
      failures++;
    }
  } catch (err) {
    log("fail", "Bot token invalid", `${err instanceof Error ? err.message : err}`);
    failures++;
  }

  // Summary
  console.log("\n─────────────────────────────");
  if (failures === 0) {
    console.log("All checks passed. Run: thinkops");
  } else {
    console.log(`${failures} check(s) failed. Fix the issues above.`);
  }
  console.log("");

  process.exit(failures > 0 ? 1 : 0);
}
