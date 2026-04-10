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
  output?: string;
  inputChars?: number;
  outputChars?: number;
}

function fmtSize(chars: number): string {
  if (chars < 1000) return `${chars}c`;
  return `${(chars / 1000).toFixed(1)}K`;
}

function formatEntry(entry: LogEntry): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const cost = entry.cost != null ? ` | cost: $${entry.cost.toFixed(4)}` : "";
  const turns = entry.turns != null ? ` | turns: ${entry.turns}` : "";
  const human = entry.humanInputNeeded ? " | **HUMAN INPUT NEEDED**" : "";
  const io = entry.inputChars != null ? ` | in: ${fmtSize(entry.inputChars)} out: ${fmtSize(entry.outputChars ?? 0)}` : "";
  let line = `- ${ts} | \`${entry.template}\` | ${entry.agent}/${entry.model} | ${entry.elapsed}${cost}${turns}${io}${human}\n`;
  if (entry.output) {
    const preview = entry.output.slice(0, 300).replace(/\n/g, "\n    ");
    line += `    > ${preview}${entry.output.length > 300 ? "..." : ""}\n`;
  }
  return line;
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
