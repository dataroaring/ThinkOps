import { execFile } from "child_process";
import type { AgentCLI, CLIResult } from "./types.js";

function run(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`claude CLI failed: ${err.message}\nstderr: ${stderr}`));
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

export const claudeCli: AgentCLI = {
  name: "claude",

  async execute(prompt, opts) {
    const args = ["-p", prompt, "--output-format", "json"];
    if (opts?.model) args.push("--model", opts.model);
    const raw = await run(args, opts?.cwd);
    return parseOutput(raw);
  },

  async resume(sessionId, prompt, opts) {
    const args = ["-p", prompt, "--output-format", "json", "--resume", sessionId];
    const raw = await run(args, opts?.cwd);
    return parseOutput(raw);
  },
};
