/**
 * Action Tracker — learns from repeated LLM behavior.
 *
 * Records structured action sequences from each LLM run, fingerprints
 * them, and detects when the same pattern repeats. When a pattern is
 * seen enough times, it's flagged for tool generation so the LLM
 * doesn't have to re-think the same steps.
 *
 * This is the core "evolution" mechanism — ThinkOps learns to replace
 * repeated LLM thinking with cheap scripts, like a human automating
 * repetitive work.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve } from "path";
import { createHash } from "crypto";
import type { ToolAction } from "../agent/types.js";

export interface ActionRecord {
  timestamp: number;
  template: string;
  connector: string;
  /** Fingerprint of the action sequence (tool names + summarized inputs). */
  fingerprint: string;
  /** The action sequence itself. */
  actions: ToolAction[];
  /** The final output / outcome. */
  outcome: string;
  /** Cost of this run. */
  cost?: number;
}

export interface RepeatPattern {
  fingerprint: string;
  template: string;
  connector: string;
  /** How many times this exact sequence has been seen. */
  count: number;
  /** Representative action list. */
  actions: ToolAction[];
  /** Most recent outcome. */
  lastOutcome: string;
  /** Total tokens/cost wasted on this repeated pattern. */
  totalCost: number;
}

const MAX_HISTORY = 50; // Per connector+template pair
const REPEAT_THRESHOLD = 3; // Generate tool after N identical sequences

export class ActionTracker {
  private historyDir: string;

  constructor(vaultPath: string) {
    this.historyDir = resolve(vaultPath, "thinkops/actions");
  }

  /** Record an action sequence from a completed LLM run. */
  async record(
    template: string,
    connector: string,
    actions: ToolAction[],
    outcome: string,
    cost?: number,
  ): Promise<void> {
    const fingerprint = this.fingerprint(actions, outcome);
    const record: ActionRecord = {
      timestamp: Date.now(),
      template,
      connector,
      fingerprint,
      actions,
      outcome: outcome.slice(0, 500),
      cost,
    };

    const history = await this.loadHistory(connector, template);
    history.push(record);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await this.saveHistory(connector, template, history);
  }

  /**
   * Detect repeated action patterns that could be replaced by a tool.
   * Returns patterns seen >= REPEAT_THRESHOLD times.
   */
  async detectRepeats(connector: string, template: string): Promise<RepeatPattern[]> {
    const history = await this.loadHistory(connector, template);
    const counts = new Map<string, { count: number; actions: ToolAction[]; outcome: string; cost: number }>();

    for (const record of history) {
      const existing = counts.get(record.fingerprint);
      if (existing) {
        existing.count++;
        existing.outcome = record.outcome;
        existing.cost += record.cost ?? 0;
      } else {
        counts.set(record.fingerprint, {
          count: 1,
          actions: record.actions,
          outcome: record.outcome,
          cost: record.cost ?? 0,
        });
      }
    }

    const patterns: RepeatPattern[] = [];
    for (const [fp, data] of counts) {
      if (data.count >= REPEAT_THRESHOLD) {
        patterns.push({
          fingerprint: fp,
          template,
          connector,
          count: data.count,
          actions: data.actions,
          lastOutcome: data.outcome,
          totalCost: data.cost,
        });
      }
    }

    return patterns.sort((a, b) => b.totalCost - a.totalCost);
  }

  /**
   * Fingerprint an action sequence for deduplication.
   * Hashes the tool names + key input fields (not full content, which varies).
   */
  private fingerprint(actions: ToolAction[], outcome: string): string {
    // Build a stable representation: tool names + structural inputs + outcome class
    const parts = actions.map((a) => {
      // For fingerprinting, use tool name + structural summary (not full content)
      return `${a.tool}:${this.structuralKey(a)}`;
    });

    // Classify outcome (not full text — just the pattern)
    const outcomeClass = this.classifyOutcome(outcome);
    parts.push(`outcome:${outcomeClass}`);

    const raw = parts.join("|");
    return createHash("sha256").update(raw).digest("hex").slice(0, 12);
  }

  /** Extract structural key from tool input (ignoring content that changes). */
  private structuralKey(action: ToolAction): string {
    const { tool, input } = action;
    switch (tool) {
      case "Read": return String(input.file_path ?? "");
      case "Write": return String(input.file_path ?? "");
      case "Bash": {
        // Extract command structure (first word + flags) not full args
        const cmd = String(input.command ?? "").split("\n")[0];
        const words = cmd.split(/\s+/).slice(0, 3).join(" ");
        return words;
      }
      case "Grep": return `${input.pattern ?? ""}@${input.path ?? ""}`;
      case "Glob": return String(input.pattern ?? "");
      default: return tool;
    }
  }

  /** Classify an outcome into a structural category. */
  private classifyOutcome(outcome: string): string {
    if (outcome.includes("NO_TASKS_AVAILABLE")) return "no-tasks";
    if (outcome.includes("TASK_COMPLETED")) return "completed";
    if (outcome.includes("HUMAN_INPUT_NEEDED")) return "human-needed";
    if (outcome.includes("PREFLIGHT_RESULT")) return "preflight";
    if (outcome.includes("EVAL_RESULT")) return "eval";
    if (outcome.includes("CRITIQUE_RESULT")) return "critique";
    return "other";
  }

  /** Format a repeated pattern into a human-readable description for the LLM. */
  formatPatternForLLM(pattern: RepeatPattern): string {
    const lines = [
      `Pattern: "${pattern.template}" for connector "${pattern.connector}"`,
      `Repeated: ${pattern.count} times (total cost: $${pattern.totalCost.toFixed(4)})`,
      `Outcome: ${pattern.lastOutcome}`,
      `Actions (${pattern.actions.length} steps):`,
    ];
    for (const action of pattern.actions) {
      lines.push(`  - ${action.summary}`);
    }
    return lines.join("\n");
  }

  private historyPath(connector: string, template: string): string {
    return resolve(this.historyDir, `${connector}_${template}.json`);
  }

  private async loadHistory(connector: string, template: string): Promise<ActionRecord[]> {
    try {
      const raw = await readFile(this.historyPath(connector, template), "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private async saveHistory(connector: string, template: string, history: ActionRecord[]): Promise<void> {
    await mkdir(this.historyDir, { recursive: true });
    await writeFile(this.historyPath(connector, template), JSON.stringify(history, null, 2));
  }
}
