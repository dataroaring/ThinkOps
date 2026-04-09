export interface TimeoutOpts {
  maxTimeMs?: number;   // hard ceiling (default 2h)
  idleTimeMs?: number;  // no-activity kill (default 5min)
}

export interface CLIResult {
  output: string;
  sessionId: string;
  cost?: number;
  turns?: number;
}

export interface AgentCLI {
  name: string;
  execute(
    prompt: string,
    opts?: { cwd?: string; model?: string; timeoutOpts?: TimeoutOpts }
  ): Promise<CLIResult>;
  resume(
    sessionId: string,
    prompt: string,
    opts?: { cwd?: string; timeoutOpts?: TimeoutOpts }
  ): Promise<CLIResult>;
}
