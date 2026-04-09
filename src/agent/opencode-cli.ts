import { execFile } from "child_process";
import type { AgentCLI, CLIResult } from "./types.js";

// OpenCode uses execFile which doesn't support streaming, so we use maxTimeMs as a simple timeout
const DEFAULT_MAX_TIME = 2 * 60 * 60 * 1000; // 2 hours

function run(args: string[], cwd?: string, maxTimeMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = maxTimeMs ?? DEFAULT_MAX_TIME;
    const proc = execFile(
      "opencode",
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(new Error(`opencode CLI timed out after ${timeout / 1000}s`));
            return;
          }
          reject(new Error(`opencode CLI failed: ${err.message}\nstderr: ${stderr}`));
          return;
        }
        resolve(stdout);
      }
    );

    // Close stdin immediately so agent can't wait for interactive input
    proc.stdin?.end();
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
    const raw = await run(args, opts?.cwd, opts?.timeoutOpts?.maxTimeMs);
    return parseOutput(raw);
  },

  async resume(sessionId, prompt, opts) {
    const args = ["run", prompt, "--session", sessionId, "--format", "json"];
    const raw = await run(args, opts?.cwd, opts?.timeoutOpts?.maxTimeMs);
    return parseOutput(raw);
  },
};
