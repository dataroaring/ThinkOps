import { appendFile, mkdir } from "fs/promises";
import { resolve } from "path";

interface LogEntry {
  template: string;
  agent: string;
  model: string;
  elapsed: string;
  cost?: number;
  turns?: number;
  sessionId: string;
  humanInputNeeded: boolean;
}

function formatEntry(entry: LogEntry): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const cost = entry.cost != null ? ` | cost: $${entry.cost.toFixed(4)}` : "";
  const turns = entry.turns != null ? ` | turns: ${entry.turns}` : "";
  const human = entry.humanInputNeeded ? " | **HUMAN INPUT NEEDED**" : "";
  return `- ${ts} | \`${entry.template}\` | ${entry.agent}/${entry.model} | ${entry.elapsed}${cost}${turns}${human}\n`;
}

export async function appendRunLog(
  vaultPath: string,
  entry: LogEntry
): Promise<void> {
  const dir = resolve(vaultPath, "thinkops");
  await mkdir(dir, { recursive: true });
  const logPath = resolve(dir, "_run_log.md");
  await appendFile(logPath, formatEntry(entry));
}
