import { spawn as spawnProcess } from "child_process";
import type { AgentCLI, CLIResult } from "./types.js";

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

interface StreamEvent {
  type: string;
  subtype?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  content?: string;
  result?: string;
  session_id?: string;
  cost_usd?: number;
  num_turns?: number;
}

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

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event: StreamEvent = JSON.parse(line);
          logEvent(event);

          // Capture final result data
          if (event.session_id) sessionId = event.session_id;
          if (event.cost_usd != null) cost = event.cost_usd;
          if (event.num_turns != null) turns = event.num_turns;
          if (event.result != null) lastResult = event.result;

          // Capture assistant text content
          if (event.type === "assistant" && event.content) {
            lastResult = event.content;
          }
        } catch {
          // Not JSON, log raw
          if (line.trim()) console.log(`[claude]   ${line.trim()}`);
        }
      }
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event: StreamEvent = JSON.parse(buffer);
          if (event.session_id) sessionId = event.session_id;
          if (event.cost_usd != null) cost = event.cost_usd;
          if (event.num_turns != null) turns = event.num_turns;
          if (event.result != null) lastResult = event.result;
          if (event.type === "assistant" && event.content) lastResult = event.content;
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

function logEvent(event: StreamEvent): void {
  switch (event.type) {
    case "assistant":
      if (event.subtype === "tool_use" && event.tool_name) {
        const input = event.tool_input ?? {};
        const detail = summarizeToolInput(event.tool_name, input);
        console.log(`[claude]   🔧 ${event.tool_name}${detail}`);
      }
      break;
    case "result":
      console.log(`[claude]   ✅ done (${event.num_turns} turns, $${event.cost_usd?.toFixed(4) ?? "?"})`);
      break;
  }
}

function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Read":
      return `: ${input.file_path ?? ""}`;
    case "Write":
      return `: ${input.file_path ?? ""}`;
    case "Edit":
      return `: ${input.file_path ?? ""}`;
    case "Bash":
      return `: ${String(input.command ?? "").slice(0, 80)}`;
    case "Grep":
      return `: "${input.pattern ?? ""}"`;
    case "Glob":
      return `: ${input.pattern ?? ""}`;
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
