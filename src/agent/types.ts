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
    opts?: { cwd?: string; model?: string; timeout?: number }
  ): Promise<CLIResult>;
  resume(
    sessionId: string,
    prompt: string,
    opts?: { cwd?: string; timeout?: number }
  ): Promise<CLIResult>;
}
