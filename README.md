# ThinkOps

Evolution agent that bridges **Obsidian** (task/knowledge management) with **Claude Code** (execution) and **Telegram** (human-in-the-loop Q&A). Learns from its own behavior — detects repeated LLM patterns and generates tools to replace them, like a human automating repetitive work.

## Core Loops

| Loop | What it does |
|------|-------------|
| **Task Loop** | Adaptive polling → preflight splits into sub-tasks → parallel fast agents + full pipeline agents → critic → eval → audit |
| **Evolution** | Records structured action sequences → fingerprints → detects repetition → generates replacement scripts → skips LLM next time |
| **Knowledge** | Watches `knowledge/sources/` → ingests into persistent wiki → periodic lint → queryable via Telegram |
| **Skill** | Reads conversation history → extracts reusable skills → auto-organizes hierarchy → feeds into future runs |
| **Feedback** | Checks outcomes of completed tasks → learns from merged/rejected/reverted PRs → updates strategy |

## How It Thinks

Every task goes through a multi-stage pipeline. The orchestrator structurally enforces each stage — the agent can't skip them.

```
Pre-flight (split work into sub-tasks)
  ├── Investigate current state (PRs, branches, CI, issues)
  ├── Learn from past eval findings, outcome feedback, cross-connector patterns
  ├── Split into discrete sub-tasks (one per PR, one per action)
  └── Output: structured sub-task list with priority and fast/full classification

Orchestrator (structural parallelism — not prompt-dependent)
  ├── Fast sub-tasks → parallel spawns, skip critique/eval
  │     (e.g., comment "run buildall" on 10 PRs simultaneously)
  └── Full sub-tasks → one per poll, full pipeline:
        Execute → Critic → Fix pass → Eval → Learn

Critic (adversarial challenge)
  ├── Claimed vs actually done?
  ├── What was missed or assumed?
  └── If needs_fix → resume agent to fix, then re-check

Eval (quality review + learning)
  ├── Score quality (1-10)
  └── Route findings:
        SKILL → saved for future runs
        CODE → task added to thinkops connector
        CRITICAL → Telegram alert
```

Key principles:
- **Structural task splitting** — orchestrator splits work at the system level, not via prompt instructions
- **Parallel by default** — fast sub-tasks run concurrently, full sub-tasks run one per poll
- **Evolution** — repeated LLM patterns are detected and replaced by generated scripts
- **Adaptive polling** — interval grows when idle (10m → 15m → 22m → ... → 1h), resets on activity
- **Token-efficient** — `--bare` mode for analysis-only spawns, context caps on audit/skills/preflight

## Evolution: Learning from Repetition

ThinkOps observes its own behavior and learns to skip the LLM when possible:

```
1. Record:   After each spawn, save structured action sequence
             (tool names + structural inputs + outcome class)

2. Detect:   Fingerprint sequences via SHA-256. When the same
             pattern appears 3+ times → flag as repeated.

3. Generate: Spawn LLM once to produce a replacement bash script
             that does the same work without any LLM call.

4. Use:      Before each spawn, check for a generated tool.
             If it succeeds → skip LLM entirely.
             If it fails → fall back to LLM (self-healing).
```

This is general-purpose — it works for any template, any connector, any action pattern. The system doesn't know what "checking for tasks" means; it just notices "the LLM keeps doing the same sequence with the same outcome" and generates a cheap replacement.

## Architecture

```
Orchestrator (TypeScript — thin plumbing, no intelligence)
  ├── Task Loops (parallel, one per connector)
  │     ├── Cheap check (## Check command — zero LLM cost)
  │     ├── Generated tool check (learned scripts)
  │     ├── Pre-flight (split into sub-tasks)
  │     ├── Fast sub-tasks (parallel, no critique/eval)
  │     └── Full sub-task (execute → critic → eval)
  ├── Action Tracker (fingerprint, detect repeats, trigger tool-gen)
  ├── Knowledge Loop (watch sources/, ingest, lint)
  ├── Skill Loop (extract from history, organize)
  └── Feedback Loop (check outcomes, learn from results)
        │
        ▼
  Subagent Spawner
  (each op = isolated CLI session with prompt template + context)
        │
        ├── CLI Adapters (claude --bare / claude full / opencode)
        ├── Telegram Bot (Telegraf — Q&A bridge)
        ├── Web Dashboard (real-time SSE, sidebar navigation)
        ├── Run Logger (→ thinkops/_run_log.md)
        └── Prompt Templates (prompts/*.md — THE BRAIN)
```

All intelligence lives in prompt templates (`prompts/`). TypeScript is config, CLI spawning, task splitting, action tracking, and logging.

## Setup

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your Telegram bot token, chat ID, and vault path

# Install CLI globally
npm link

# Run
thinkops
```

You can also run without global install via `npm run dev`.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | required |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | required |
| `VAULT_PATH` | Path to Obsidian vault | `~/Documents/Obsidian Vault` |
| `AGENT_CLI` | CLI agent to use (`claude` or `opencode`) | `claude` |
| `AGENT_MODEL` | Model name passed to the CLI | `sonnet` |
| `AGENT_MAX_TIME` | Hard ceiling per agent run (seconds) | `7200` (2h) |
| `AGENT_IDLE_TIME` | Kill agent if no output for this long (seconds) | `300` (5min) |
| `TASK_CONCURRENCY` | Max parallel connector agent runs | `1` |
| `TASK_POLL_INTERVAL` | Initial poll interval in seconds (adaptive: 10m–1h) | `600` (10min) |
| `SKILL_EXTRACT_INTERVAL` | Seconds between skill extractions | `3600` |
| `SKILL_ORGANIZE_INTERVAL` | Seconds between skill reorganizations | `86400` |
| `KNOWLEDGE_LINT_INTERVAL` | Seconds between knowledge lint runs | `86400` |
| `TOOL_REVIEW_INTERVAL` | Seconds between tool reviews | `2592000` (30d) |
| `FEEDBACK_CHECK_INTERVAL` | Seconds between feedback learning cycles | `86400` |
| `DASHBOARD_PORT` | Web dashboard port | `3120` |

## Web Dashboard

Real-time web dashboard at `http://localhost:3120` with left sidebar navigation:

- **Overview**: uptime, completed tasks, active agents, concurrency gauge
- **Tasks**: all handled tasks (done/attempted) with quality scores, filterable by connector and status
- **Connectors**: per-connector stats, poll counts, audit logs
- **Tools**: generated and extracted tool scripts
- **Skills**: learned skills with hierarchy
- **Loops**: background loop stats with run history (adaptive intervals visible)
- **Activity Log**: real-time SSE stream, filterable by connector

API endpoints:
- `GET /api/status` — JSON status snapshot
- `GET /api/agents` — active agents list
- `GET /api/connectors` — connector stats
- `GET /api/audit/:name` — parsed audit log entries
- `GET /api/tools` — generated/extracted tools
- `GET /api/skills` — learned skills
- `GET /api/loops` — background loop stats with history
- `GET /api/events` — SSE stream for real-time updates

## Token Efficiency

ThinkOps is designed to minimize token consumption:

| Optimization | Savings |
|---|---|
| `--bare` mode for analysis-only spawns (preflight, critique, eval) | ~15-20K tokens/spawn |
| Adaptive polling (10m–1h, grows when idle) | Fewer idle polls |
| Generated tools (replace repeated LLM patterns with scripts) | 100% for learned patterns |
| `## Check` change detection (connector-level) | Skip poll when nothing changed |
| Context caps: audit log (50 lines), skills (1.5K/file, 8K total), preflight (5K) | Bounded prompt growth |
| Sub-task splitting with `fast: true` | Skip critique/eval for mechanical tasks |

## Rate Limit Detection

When the agent CLI returns a rate limit error (429, "hit your limit", etc.), ThinkOps applies exponential backoff for that connector (5min initial, doubling up to 1hr max). Backoff resets on the next successful run.

## Obsidian Vault Structure

```
~/Documents/Obsidian Vault/
  connectors/             # Task sources (Jira, GitHub, manual lists)
    thinkops.md           #   Self-improvement connector
  knowledge/
    _schema.md            # Wiki conventions
    _index.md             # Content catalog
    sources/              # Raw source material (immutable)
    entities/             # People, projects, technologies
    topics/               # Concepts, patterns, comparisons
  skills/
    _schema.md            # Skill format instructions
    _tree.md              # Auto-maintained hierarchy
    coding/               # Domain folders (auto-created)
  tools/
    _gen_<fingerprint>.sh # Auto-generated replacement scripts
  thinkops/
    _run_log.md           # All agent activity (append-only)
    audit/                # Per-connector audit logs
    actions/              # Action sequence history (for pattern detection)
```

## Connector Format

A **connector** is an endless task source. Each `.md` file in `connectors/` describes where to fetch tasks and how to work on them.

```markdown
code directory: /path/to/project
using git worktree from upstream/master to isolate tasks.
create pr to apache/doris

## Tasks

### 1. Trigger CI builds (check every poll)
List open PRs: `gh pr list --repo apache/doris --author me --state open`
For each PR, check if latest commit has a "run buildall" comment.
If not, comment `run buildall` on the PR.

### 2. Resolve PR feedback (one PR per run)
Pick ONE PR with unresolved review comments or CI failures. Fix it fully.

## Check
gh pr list --repo apache/doris --author me --state open --json number,updatedAt

## Context
Additional context for the agent (auth tokens, conventions, etc.)
```

**How it works:**
- Each connector gets its own independent polling loop with adaptive intervals.
- Pre-flight analyzes state and splits work into discrete sub-tasks.
- Fast sub-tasks (commenting, labeling) run in parallel without critique/eval.
- Full sub-tasks (code changes) go through the complete pipeline.
- `## Check` provides cheap change detection — if output is unchanged, skip the poll entirely.
- Completed tasks are tracked in `thinkops/audit/<connector>.md`.
- Concurrency is controlled by `TASK_CONCURRENCY` (default 1).

## Self-Improvement

After each task, an **eval agent** reviews the result and routes findings:

```
Task completed → Critic challenges → Eval reviews
  ├── SKILL: behavioral pattern   → saved as skill for future runs
  ├── CODE: prompt/code fix       → task added to thinkops connector
  └── CRITICAL: serious bug       → Telegram alert for human review
```

Past eval findings and outcome feedback feed back into future pre-flight analyses:
```
Eval finding → skill file / audit log
  → loaded by pre-flight for next task
    → agent avoids repeating the same mistake
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Show ThinkOps status |
| `/connectors` | List all connectors with completed task counts |
| `/audit <name>` | Show audit log for a connector |
| `/query <question>` | Query the knowledge wiki |
| `/lint` | Run knowledge wiki audit |
| `/skills` | Show skill tree |
| `/ingest <path>` | Ingest a source into the wiki |

## Human-in-the-Loop

When an agent needs input or has low confidence, it outputs `HUMAN_INPUT_NEEDED: <question>`. The orchestrator sends the question to Telegram and waits for your reply, then resumes the agent session.

## Adding a New Agent Backend

Implement the `AgentCLI` interface in `src/agent/`:

```typescript
interface AgentCLI {
  name: string;
  execute(prompt: string, opts?: { cwd?: string; model?: string; bare?: boolean }): Promise<CLIResult>;
  resume(sessionId: string, prompt: string, opts?: { cwd?: string }): Promise<CLIResult>;
}
```

Then add it to `src/agent/spawner.ts`.

## Project Structure

```
src/
  index.ts              # Entry point + --check flag
  config.ts             # Zod-validated config from .env
  check.ts              # Health check (vault, CLI, Telegram)
  orchestrator.ts       # Task splitting, parallel execution, adaptive polling
  agent/
    types.ts            # AgentCLI + CLIResult + ToolAction interfaces
    claude-cli.ts       # Claude Code adapter (stream-json, action capture)
    opencode-cli.ts     # OpenCode adapter
    spawner.ts          # Template loading + CLI dispatch + bare mode
  telegram/
    bot.ts              # Telegraf bot (Q&A bridge)
  web/
    server.ts           # HTTP server + SSE + JSON API
    dashboard.html      # Single-file real-time dashboard (sidebar navigation)
  utils/
    run-logger.ts       # Append to thinkops/_run_log.md
    file-watcher.ts     # chokidar wrapper
    action-tracker.ts   # Record actions, fingerprint, detect repeats
prompts/                # Prompt templates (THE BRAIN)
  task-preflight.md     #   Split work into sub-tasks
  connector-run.md      #   Execute a single sub-task
  task-critique.md      #   Adversarial review
  task-recover.md       #   Analyze failure, decide retry/escalate/abandon
  eval-run.md           #   Quality review → SKILL / CODE / CRITICAL
  tool-gen.md           #   Generate replacement scripts for repeated patterns
  tool-extract.md       #   Extract reusable tools from agent output
  tool-review.md        #   Review and maintain tool quality
  feedback-check.md     #   Check outcomes of completed tasks
  feedback-learn.md     #   Learn from outcome signals
  knowledge-*.md        #   Ingest, query, lint
  skill-*.md            #   Extract, organize, select
templates/              # Vault setup examples
```
