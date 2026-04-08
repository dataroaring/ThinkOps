import { execFile } from "child_process";
import type { AgentCLI, CLIResult } from "./types.js";

function run(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("opencode", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`opencode CLI failed: ${err.message}\nstderr: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseOutput(raw: string): CLIResult {
  try {
    const json = JSON.parse(raw);
    return {
      output: json.result ?? raw,
      sessionId: json.session_id ?? "",
      cost: json.cost_usd,
      turns: json.num_turns,
    };
  } catch {
    return { output: raw, sessionId: "" };
  }
}

export const opencodeCli: AgentCLI = {
  name: "opencode",

  async execute(prompt, opts) {
    const args = ["run", prompt];
    if (opts?.model) args.push("--model", opts.model);
    args.push("--format", "json");
    const raw = await run(args, opts?.cwd);
    return parseOutput(raw);
  },

  async resume(sessionId, prompt, opts) {
    const args = ["run", prompt, "--session", sessionId, "--format", "json"];
    const raw = await run(args, opts?.cwd);
    return parseOutput(raw);
  },
};
