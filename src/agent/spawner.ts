import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { claudeCli } from "./claude-cli.js";
import { opencodeCli } from "./opencode-cli.js";
import type { AgentCLI, CLIResult, TimeoutOpts } from "./types.js";
import type { Config } from "../config.js";
import { appendRunLog } from "../utils/run-logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

/** Templates that only operate on vault files — don't need Claude Code's full
 *  system prompt, hooks, memory, LSP, or CLAUDE.md discovery. Using --bare
 *  saves ~15-20K input tokens per spawn. */
const BARE_TEMPLATES = new Set([
  "tool-review", "tool-extract",
  "skill-extract", "skill-organize", "skill-select",
  "knowledge-lint", "knowledge-ingest", "knowledge-query",
  "feedback-check", "feedback-learn",
]);

export interface SpawnResult extends CLIResult {
  template: string;
  humanInputNeeded?: string;
  inputChars: number;
  outputChars: number;
}

function getAgent(config: Config): AgentCLI {
  return config.agentCli === "opencode" ? opencodeCli : claudeCli;
}

function configTimeout(config: Config): TimeoutOpts {
  return {
    maxTimeMs: config.agentMaxTime * 1000,
    idleTimeMs: config.agentIdleTime * 1000,
  };
}

async function loadTemplate(
  name: string,
  vars: Record<string, string>
): Promise<{ prompt: string; templateChars: number }> {
  const raw = await readFile(resolve(PROMPTS_DIR, `${name}.md`), "utf-8");
  const templateChars = raw.length;
  const prompt = raw.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
  return { prompt, templateChars };
}

function extractHumanInput(output: string): string | undefined {
  const match = output.match(/HUMAN_INPUT_NEEDED:\s*(.+)/);
  return match?.[1]?.trim();
}

export async function spawn(
  config: Config,
  templateName: string,
  vars: Record<string, string>,
  opts?: { cwd?: string; extraContext?: string; label?: string; addDirs?: string[] }
): Promise<SpawnResult> {
  const loaded = await loadTemplate(templateName, {
    vault_path: config.vaultPath,
    brand_name: config.brandName,
    brand_signature: config.brandSignature,
    brand_pr_footer: config.brandPrFooter,
    ...vars,
  });

  let prompt = loaded.prompt;
  if (opts?.extraContext) {
    prompt = opts.extraContext + "\n\n" + prompt;
  }

  const inputChars = prompt.length;
  const varsChars = inputChars - loaded.templateChars;
  const bare = BARE_TEMPLATES.has(templateName);

  const agent = getAgent(config);
  const label = opts?.label ? ` (${opts.label})` : "";
  const mode = bare ? " [bare]" : "";
  console.log(`[spawn] ${agent.name} running "${templateName}"${label}${mode} | input: ${fmtSize(inputChars)} (template: ${fmtSize(loaded.templateChars)}, context: ${fmtSize(varsChars)})`);
  const start = Date.now();
  const result = await agent.execute(prompt, {
    cwd: opts?.cwd ?? config.vaultPath,
    model: config.agentModel,
    timeoutOpts: configTimeout(config),
    bare,
    addDirs: opts?.addDirs,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const outputChars = result.output.length;
  console.log(`[spawn] "${templateName}" done in ${elapsed}s | output: ${fmtSize(outputChars)}${result.cost ? ` | cost: $${result.cost.toFixed(4)}` : ""}`);

  const humanInputNeeded = extractHumanInput(result.output);

  await appendRunLog(config.vaultPath, {
    template: templateName,
    agent: agent.name,
    model: config.agentModel,
    elapsed: `${elapsed}s`,
    cost: result.cost,
    turns: result.turns,
    sessionId: result.sessionId,
    humanInputNeeded: !!humanInputNeeded,
    output: result.output,
    inputChars,
    outputChars,
  });

  return { ...result, template: templateName, humanInputNeeded, inputChars, outputChars };
}

export async function resume(
  config: Config,
  sessionId: string,
  prompt: string,
  opts?: { cwd?: string }
): Promise<SpawnResult> {
  const agent = getAgent(config);
  const inputChars = prompt.length;
  console.log(`[spawn] ${agent.name} resume ${sessionId.slice(0, 8)}... | input: ${fmtSize(inputChars)}`);
  const start = Date.now();
  const result = await agent.resume(sessionId, prompt, {
    cwd: opts?.cwd ?? config.vaultPath,
    timeoutOpts: configTimeout(config),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const outputChars = result.output.length;
  console.log(`[spawn] resume done in ${elapsed}s | output: ${fmtSize(outputChars)}${result.cost ? ` | cost: $${result.cost.toFixed(4)}` : ""}`);

  const humanInputNeeded = extractHumanInput(result.output);

  await appendRunLog(config.vaultPath, {
    template: "resume",
    agent: agent.name,
    model: config.agentModel,
    elapsed: `${elapsed}s`,
    cost: result.cost,
    turns: result.turns,
    sessionId: result.sessionId,
    humanInputNeeded: !!humanInputNeeded,
    inputChars,
    outputChars,
  });

  return { ...result, template: "resume", humanInputNeeded, inputChars, outputChars };
}

function fmtSize(chars: number): string {
  if (chars < 1000) return `${chars}c`;
  const kb = (chars / 1000).toFixed(1);
  return `${kb}K`;
}
