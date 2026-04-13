# Tool Extract

Extract reusable CLI tool scripts from agent output.

## Agent Output

```
{agent_output}
```

## Connector Context

```
{connector_content}
```

## Instructions

1. Read existing tools in `{vault_path}/tools/` and `{vault_path}/tools/_index.md`.
2. Scan the agent output for CLI commands, API calls, or multi-step shell patterns that are reusable across tasks (e.g., fetching tasks from a source, checking build status, posting comments).
3. For each reusable pattern:
   - If a similar tool already exists, update it with improvements.
   - If new, create a shell script in `{vault_path}/tools/<domain>/<name>.sh` with:
     - Clear usage comment at top
     - Parameterized inputs (arguments, not hardcoded values)
     - Error handling (non-zero exit on failure)
4. Update `{vault_path}/tools/_index.md` — one line per tool: `- [name](path) — what it does`.
5. Organize tools by domain folder (e.g., `github/`, `jira/`, `build/`, `notify/`).

Skip trivial one-liners (simple `git add`, `ls`, etc.). Only extract patterns with 2+ steps or non-obvious flags/APIs.
