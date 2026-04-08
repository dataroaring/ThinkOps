import { execFile } from "child_process";
import type { AgentCLI, CLIResult } from "./types.js";

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function run(args: string[], cwd?: string, timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "claude",
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: timeout ?? DEFAULT_TIMEOUT },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(new Error(`claude CLI timed out after ${(timeout ?? DEFAULT_TIMEOUT) / 1000}s`));
            return;
          }
          reject(new Error(`claude CLI failed: ${err.message}\nstderr: ${stderr}`));
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

export const claudeCli: AgentCLI = {
  name: "claude",

  async execute(prompt, opts) {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--dangerously-skip-permissions",
    ];
    if (opts?.model) args.push("--model", opts.model);
    const raw = await run(args, opts?.cwd, opts?.timeout);
    return parseOutput(raw);
  },

  async resume(sessionId, prompt, opts) {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--resume", sessionId,
    ];
    const raw = await run(args, opts?.cwd, opts?.timeout);
    return parseOutput(raw);
  },
};
