# ThinkOps

Three-loop agent system that bridges **Obsidian** (task/knowledge management) with **Claude Code** (execution) and **Telegram** (human-in-the-loop Q&A), with self-improving skills.

## Loops

| Loop | What it does |
|------|-------------|
| **Task Loop** | Scans Obsidian `tasks/` for `status: todo` → selects relevant skills → executes via CLI agent → asks questions via Telegram → updates progress in Obsidian |
| **Knowledge Loop** | Watches `knowledge/sources/` for new files → ingests into a persistent wiki → periodic quality linting → queryable via Telegram |
| **Skill Loop** | Reads Claude Code conversation history → extracts reusable skills → auto-organizes hierarchy → improves via feedback |

## Architecture

```
Orchestrator (thin TypeScript plumbing)
  ├── Task Loop (poll tasks/, pick cheapest, execute)
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
        └── Prompt Templates (prompts/*.md — THE BRAIN)
```

All intelligence lives in prompt templates (`prompts/`). TypeScript is just config, CLI spawning, Telegram bridge, file watching, and logging.

## Setup

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your Telegram bot token, chat ID, and vault path

# Run
npm run dev
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | required |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | required |
| `VAULT_PATH` | Path to Obsidian vault | `~/Documents/Obsidian Vault` |
| `AGENT_CLI` | CLI agent to use (`claude` or `opencode`) | `claude` |
| `AGENT_MODEL` | Model name passed to the CLI | `sonnet` |
| `TASK_POLL_INTERVAL` | Seconds between task scans | `30` |
| `SKILL_EXTRACT_INTERVAL` | Seconds between skill extractions | `3600` |
| `SKILL_ORGANIZE_INTERVAL` | Seconds between skill reorganizations | `86400` |
| `KNOWLEDGE_LINT_INTERVAL` | Seconds between knowledge lint runs | `86400` |

## Obsidian Vault Structure

```
~/Documents/Obsidian Vault/
  tasks/                  # Task files with YAML frontmatter
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
```

## Task File Format

```yaml
---
status: todo              # todo | in_progress | blocked | done
priority: medium          # high | medium | low
estimated_cost: 0.05      # USD estimate (cheapest tasks run first)
assigned_agent: claude-code
created: 2026-04-08
tags: [feature]
---
# Task Title

## Description
What needs to be done...

## Keypoints
- [ ] Key decision 1: _pending_
- [x] Key decision 2: The resolved answer

## Progress Log
- 2026-04-08: Task created
```

Tasks are scheduled **cheapest-first** by `estimated_cost`. Tasks without a cost estimate run last.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Show ThinkOps status |
| `/tasks` | List pending tasks |
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
  index.ts              # Entry point
  config.ts             # Zod-validated config
  orchestrator.ts       # Three loops + Telegram commands
  agent/
    types.ts            # AgentCLI interface
    claude-cli.ts       # Claude Code adapter
    opencode-cli.ts     # OpenCode adapter
    spawner.ts          # Template loading + CLI dispatch
  telegram/
    bot.ts              # Telegraf bot
  utils/
    run-logger.ts       # Append to _run_log.md
    file-watcher.ts     # chokidar wrapper
prompts/                # Prompt templates (all agent intelligence)
templates/              # Vault setup templates
```
