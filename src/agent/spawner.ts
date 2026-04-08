import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { claudeCli } from "./claude-cli.js";
import { opencodeCli } from "./opencode-cli.js";
import type { AgentCLI, CLIResult } from "./types.js";
import type { Config } from "../config.js";
import { appendRunLog } from "../utils/run-logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

export interface SpawnResult extends CLIResult {
  template: string;
  humanInputNeeded?: string;
}

function getAgent(config: Config): AgentCLI {
  return config.agentCli === "opencode" ? opencodeCli : claudeCli;
}

async function loadTemplate(
  name: string,
  vars: Record<string, string>
): Promise<string> {
  const raw = await readFile(resolve(PROMPTS_DIR, `${name}.md`), "utf-8");
  return raw.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function extractHumanInput(output: string): string | undefined {
  const match = output.match(/HUMAN_INPUT_NEEDED:\s*(.+)/);
  return match?.[1]?.trim();
}

export async function spawn(
  config: Config,
  templateName: string,
  vars: Record<string, string>,
  opts?: { cwd?: string; extraContext?: string }
): Promise<SpawnResult> {
  let prompt = await loadTemplate(templateName, {
    vault_path: config.vaultPath,
    ...vars,
  });

  if (opts?.extraContext) {
    prompt = opts.extraContext + "\n\n" + prompt;
  }

  const agent = getAgent(config);
  console.log(`[spawn] ${agent.name} running "${templateName}"...`);
  const start = Date.now();
  const result = await agent.execute(prompt, {
    cwd: opts?.cwd ?? config.vaultPath,
    model: config.agentModel,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[spawn] "${templateName}" completed in ${elapsed}s`);

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
  });

  return { ...result, template: templateName, humanInputNeeded };
}

export async function resume(
  config: Config,
  sessionId: string,
  prompt: string,
  opts?: { cwd?: string }
): Promise<SpawnResult> {
  const agent = getAgent(config);
  const start = Date.now();
  const result = await agent.resume(sessionId, prompt, {
    cwd: opts?.cwd ?? config.vaultPath,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

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
  });

  return { ...result, template: "resume", humanInputNeeded };
}
