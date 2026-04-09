# ThinkOps

Three-loop agent system that bridges **Obsidian** (task/knowledge management) with **Claude Code** (execution) and **Telegram** (human-in-the-loop Q&A), with self-improving skills and deep thinking.

## Loops

| Loop | What it does |
|------|-------------|
| **Task Loop** | Parallel connector loops → pre-flight → agent fetches + executes → critic challenges → eval reviews → audit log → Telegram |
| **Eval** | After each task, reviews quality → behavioral patterns → skills, code/prompt issues → thinkops connector, critical bugs → Telegram alert |
| **Knowledge Loop** | Watches `knowledge/sources/` for new files → ingests into a persistent wiki → periodic quality linting → queryable via Telegram |
| **Skill Loop** | Reads Claude Code conversation history → extracts reusable skills → auto-organizes hierarchy → improves via feedback |

## Thinking Pipeline

Every task goes through a multi-stage thinking pipeline. The orchestrator structurally enforces each stage — the agent can't skip them.

```
Pre-flight (read-only analysis)
  ├── Investigate current state (PRs, branches, CI, issues)
  ├── Analogical reasoning — find similar past tasks, apply lessons
  ├── Failure memory — learn from past eval findings and mistakes
  ├── Generate task-specific thinking dimensions
  └── Output: state + lessons + dimensions + strategy

Connector-run (fetch + think + execute + verify)
  ├── Fetch next task from source
  ├── Decompose into subtasks with ordering
  ├── Rate confidence per decision (low → research or ask human)
  ├── Execute with plan
  └── Verify from 4 perspectives:
        requester / code reviewer / user / maintainer

Critic (adversarial challenge)
  ├── Claimed vs actually done?
  ├── What was missed?
  ├── What could break?
  ├── What was assumed without verification?
  └── If needs_fix → resume agent to fix, then re-check

Eval (quality review + learning)
  ├── Generate task-specific review dimensions
  ├── Score quality (1-10)
  └── Route findings:
        SKILL → saved for future runs
        CODE → task added to thinkops connector
        CRITICAL → Telegram alert
```

Key principles:
- **No hardcoded checklists** — each agent generates task-specific thinking dimensions using LLM reasoning
- **Confidence gating** — low confidence forces research or human input, prevents guessing
- **Adversarial review** — critic agent challenges the result before acceptance
- **Learning from history** — past eval findings and mistakes inform future planning

## Architecture

```
Orchestrator (thin TypeScript plumbing)
  ├── Task Loops (parallel, one per connector, semaphore-limited)
  │     ├── Pre-flight (analyze state, past lessons, dimensions)
  │     ├── Connector-run (fetch + think + execute + verify)
  │     ├── Critic (adversarial challenge, can trigger fix pass)
  │     └── Eval (quality review → skills / thinkops tasks / alerts)
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
| `TASK_CONCURRENCY` | Max parallel connector agent runs | `3` |
| `TASK_POLL_INTERVAL` | Seconds between connector polls | `30` |
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
- Each connector gets its own independent polling loop (parallel, not round-robin).
- The agent reads the connector, fetches the next task, thinks about the best approach, executes, and reports back.
- A critic agent challenges the result before acceptance. If issues are found, the agent gets a fix pass.
- Completed tasks are tracked in `thinkops/audit/<connector>.md` — the agent skips already-done tasks.
- Add new connectors anytime in Obsidian — they are auto-discovered.
- Concurrency is controlled by `TASK_CONCURRENCY` (default 3 parallel agents).

## Self-Improvement

After each task completion, an **eval agent** reviews the result and routes findings:

```
Task completed → Critic challenges → Eval reviews output
  ├── SKILL: behavioral pattern   → saved as skill for future runs
  ├── CODE: prompt/code fix       → task added to thinkops connector
  └── CRITICAL: serious bug       → Telegram alert for human review
```

The `thinkops` connector points to the ThinkOps codebase itself. When the eval creates CODE tasks, ThinkOps picks them up and improves its own prompts, orchestrator, and adapters — then runs tests to verify.

Past eval findings feed back into future pre-flight analyses, creating a learning loop:
```
Eval finding → thinkops connector / skill file
  → loaded by pre-flight for next task
    → agent avoids repeating the same mistake
```

Quality scores are recorded in the audit log (`EVAL | quality: 8/10`).

## Smart Stuck Detection

Instead of a fixed timeout, ThinkOps monitors agent activity:

- **Idle detection** (`AGENT_IDLE_TIME`): If the agent produces no output for 5 minutes, it's likely stuck — kill it. An active agent making tool calls will never trigger this.
- **Max time** (`AGENT_MAX_TIME`): 2-hour hard ceiling as a safety net.

This prevents agents from wasting time on `sleep` loops or hanging on external processes.

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

When an agent needs input or has low confidence, it outputs `HUMAN_INPUT_NEEDED: <question>`. The orchestrator sends the question to Telegram and waits for your reply, then resumes the agent session with your answer.

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
  orchestrator.ts       # Parallel task loops, critic, eval, knowledge & skill loops
  agent/
    types.ts            # AgentCLI + CLIResult + TimeoutOpts interfaces
    claude-cli.ts       # Claude Code adapter (stream-json, idle detection)
    opencode-cli.ts     # OpenCode adapter
    spawner.ts          # Template loading + CLI dispatch + run logging
  telegram/
    bot.ts              # Telegraf bot (Q&A bridge)
  utils/
    run-logger.ts       # Append to thinkops/_run_log.md
    file-watcher.ts     # chokidar wrapper
prompts/                # Prompt templates (THE BRAIN)
  task-preflight.md     #   Pre-flight: analyze state, past lessons, dimensions
  connector-run.md      #   Fetch + think + execute + verify
  task-critique.md      #   Adversarial review of completed work
  eval-run.md           #   Quality review → SKILL / CODE / CRITICAL
  knowledge-*.md        #   Ingest, query, lint
  skill-*.md            #   Extract, organize, select
templates/              # Vault setup examples
```
