import { spawn as spawnProcess } from "child_process";
import type { AgentCLI, CLIResult } from "./types.js";

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function run(args: string[], cwd?: string, timeout?: number): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnProcess("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin?.end();

    const timeoutMs = timeout ?? DEFAULT_TIMEOUT;
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    let lastResult = "";
    let sessionId = "";
    let cost: number | undefined;
    let turns: number | undefined;
    let buffer = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processEvent(event);
        } catch {
          // Not JSON
        }
      }
    });

    function processEvent(event: Record<string, unknown>): void {
      const type = event.type as string;
      if (event.session_id) sessionId = event.session_id as string;

      if (type === "assistant") {
        // Tool use and text are inside message.content array
        const msg = event.message as Record<string, unknown> | undefined;
        const content = msg?.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if (block.type === "tool_use") {
              const name = block.name as string;
              const input = block.input as Record<string, unknown>;
              const detail = summarizeTool(name, input);
              console.log(`[claude]   🔧 ${name}${detail}`);
            } else if (block.type === "text") {
              const text = (block.text as string).trim();
              if (text) lastResult = text;
            }
          }
        }
      } else if (type === "result") {
        const resultText = event.result as string | undefined;
        if (resultText) lastResult = resultText;
        cost = event.total_cost_usd as number | undefined;
        turns = event.num_turns as number | undefined;
        const duration = event.duration_ms as number | undefined;
        const secs = duration ? (duration / 1000).toFixed(1) : "?";
        console.log(`[claude]   ✅ done (${turns ?? "?"} turns, $${cost?.toFixed(4) ?? "?"}, ${secs}s)`);
      }
    }

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (buffer.trim()) {
        try {
          processEvent(JSON.parse(buffer));
        } catch {
          if (!lastResult) lastResult = buffer;
        }
      }

      if (code !== 0 && !lastResult) {
        reject(new Error(`claude CLI exited with code ${code}\nstderr: ${stderr}`));
        return;
      }

      resolve({ output: lastResult, sessionId, cost, turns });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI failed: ${err.message}`));
    });
  });
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `: ${input.file_path ?? ""}`;
    case "Write":
      return `: ${input.file_path ?? ""}`;
    case "Edit":
      return `: ${input.file_path ?? ""}`;
    case "Bash": {
      const cmd = String(input.command ?? "").split("\n")[0].slice(0, 80);
      return `: ${cmd}`;
    }
    case "Grep":
      return `: "${input.pattern ?? ""}"`;
    case "Glob":
      return `: ${input.pattern ?? ""}`;
    case "LSP":
      return `: ${input.operation ?? ""}`;
    case "Agent":
      return `: ${input.description ?? ""}`;
    default:
      return "";
  }
}

export const claudeCli: AgentCLI = {
  name: "claude",

  async execute(prompt, opts) {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (opts?.model) args.push("--model", opts.model);
    return run(args, opts?.cwd, opts?.timeout);
  },

  async resume(sessionId, prompt, opts) {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions",
      "--resume", sessionId,
    ];
    return run(args, opts?.cwd, opts?.timeout);
  },
};
