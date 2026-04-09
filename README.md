# ThinkOps

Three-loop agent system that bridges **Obsidian** (task/knowledge management) with **Claude Code** (execution) and **Telegram** (human-in-the-loop Q&A), with self-improving skills.

## Loops

| Loop | What it does |
|------|-------------|
| **Task Loop** | Cycles through `connectors/` → agent fetches next task from source (Jira, GitHub, inline list) → executes it → eval reviews result → logs to audit trail → notifies via Telegram |
| **Eval** | After each task completion, reviews quality → behavioral patterns → skills, code/prompt issues → thinkops connector, critical bugs → Telegram alert |
| **Knowledge Loop** | Watches `knowledge/sources/` for new files → ingests into a persistent wiki → periodic quality linting → queryable via Telegram |
| **Skill Loop** | Reads Claude Code conversation history → extracts reusable skills → auto-organizes hierarchy → improves via feedback |

## Architecture

```
Orchestrator (thin TypeScript plumbing)
  ├── Task Loop (round-robin connectors/, agent fetches + executes)
  │     └── Eval (reviews result → skills / thinkops tasks / alerts)
  ├── Knowledge Loop (watch sources/, ingest, lint)
  └── Skill Loop (extract from history, organize)
        │
        ▼
  Subagent Spawner
  (each op = isolated CLI session with prompt template + context)
        │
        ├── CLI Adapters (claude -p / opencode run)
        ├── Telegram Bot (Telegraf — Q&A bridge)
        ├── Run Logger (→ thinkops/_run_log.md)
        ├── Audit Logs (→ thinkops/audit/<connector>.md)
        └── Prompt Templates (prompts/*.md — THE BRAIN)

Self-improvement cycle:
  Eval finds CODE issue → thinkops connector → agent fixes code/prompts → tests → PR
  Eval finds SKILL pattern → skill files → loaded into future task runs
```

All intelligence lives in prompt templates (`prompts/`). TypeScript is just config, CLI spawning, Telegram bridge, file watching, and logging.

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
| `TASK_POLL_INTERVAL` | Seconds between task scans | `30` |
| `SKILL_EXTRACT_INTERVAL` | Seconds between skill extractions | `3600` |
| `SKILL_ORGANIZE_INTERVAL` | Seconds between skill reorganizations | `86400` |
| `KNOWLEDGE_LINT_INTERVAL` | Seconds between knowledge lint runs | `86400` |

## Obsidian Vault Structure

```
~/Documents/Obsidian Vault/
  connectors/             # Task sources (Jira, GitHub Issues, manual lists, etc.)
    thinkops.md           #   Self-improvement: eval creates tasks here for ThinkOps itself
  knowledge/
    _schema.md            # Wiki conventions (agent instructions)
    _index.md             # Content catalog
    _log.md               # Operation log
    sources/              # Raw source material (immutable)
    entities/             # People, projects, technologies
    topics/               # Concepts, patterns, comparisons
    queries/              # Saved query results
  skills/
    _schema.md            # Skill format instructions
    _tree.md              # Auto-maintained hierarchy
    _stats.md             # Learning statistics
    coding/               # Domain folders (auto-created)
    devops/
  thinkops/
    _run_log.md           # All agent activity (append-only)
    audit/                # Per-connector audit logs (completed task history)
```

## Connector Format

A **connector** is an endless task source. Each `.md` file in `connectors/` describes where to fetch tasks and how to work on them. The agent interprets the connector dynamically — no rigid format required.

### Jira Connector
```markdown
## Source
Jira: https://company.atlassian.net
Auth: use JIRA_TOKEN environment variable
Filter: project = DORIS AND status = "To Do" AND priority >= High

## Context
code directory: /path/to/incubator-doris
using git worktree from upstream/master to isolate tasks.
create pr to apache/doris
```

### GitHub Issues Connector
```markdown
## Source
GitHub Issues: apache/doris
Filter: state:open assignee:dataroaring label:bug

## Context
code directory: /path/to/incubator-doris
create pr to apache/doris
```

### Manual Task List
```markdown
## Source
Manual task list below.

## Tasks
- [ ] Fix the memory leak in BE
- [ ] Add retry logic to RPC client

## Context
code directory: /path/to/project
```

**How it works:**
- The agent reads the connector, fetches the next task from the source, executes it, and reports back.
- The `## Context` section tells the agent HOW to work (code directory, workflow, PR target, etc.).
- Completed tasks are tracked in `thinkops/audit/<connector>.md` — the agent skips already-done tasks.
- Connectors are cycled round-robin. Add new connectors anytime in Obsidian.
- Each poll processes one task from one connector. The loop never ends — connectors keep producing tasks.

## Self-Improvement

After each task completion, an **eval agent** reviews the result and routes findings:

```
Task completed → Eval reviews output
  ├── SKILL: behavioral pattern   → saved as skill for future runs
  ├── CODE: prompt/code fix       → task added to thinkops connector
  └── CRITICAL: serious bug       → Telegram alert for human review
```

The `thinkops` connector points to the ThinkOps codebase itself. When the eval creates CODE tasks, ThinkOps picks them up and improves its own prompts, orchestrator, and adapters — then runs tests to verify.

Quality scores are recorded in the audit log (`EVAL | quality: 8/10`).

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

When an agent needs input, it outputs `HUMAN_INPUT_NEEDED: <question>`. The orchestrator sends the question to Telegram and waits for your reply, then resumes the agent session with your answer.

```
Agent → HUMAN_INPUT_NEEDED → Telegram → You reply → Agent resumes
```

## Adding a New Agent Backend

Implement the `AgentCLI` interface in `src/agent/`:

```typescript
interface AgentCLI {
  name: string;
  execute(prompt: string, opts?: { cwd?: string; model?: string }): Promise<CLIResult>;
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
  orchestrator.ts       # Task loop, eval, knowledge & skill loops, Telegram commands
  agent/
    types.ts            # AgentCLI interface + CLIResult
    claude-cli.ts       # Claude Code adapter (stream-json)
    opencode-cli.ts     # OpenCode adapter
    spawner.ts          # Template loading + CLI dispatch + run logging
  telegram/
    bot.ts              # Telegraf bot (Q&A bridge)
  utils/
    run-logger.ts       # Append to thinkops/_run_log.md
    file-watcher.ts     # chokidar wrapper
prompts/                # Prompt templates (THE BRAIN)
  connector-run.md      #   Fetch task from source + execute + report
  eval-run.md           #   Review completed task → SKILL / CODE / CRITICAL
  knowledge-*.md        #   Ingest, query, lint
  skill-*.md            #   Extract, organize, select
templates/              # Vault setup examples
```
