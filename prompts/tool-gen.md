# Tool Generator

You've detected a **repeated action pattern** — the LLM keeps performing the same sequence of tool calls with the same structural outcome. Generate a reusable script to replace this repeated LLM work.

## Pattern Details

Template: `{template_name}`
Connector: `{connector_name}`
Times repeated: {repeat_count}
Estimated cost wasted: ${total_cost}

### Action Sequence (what the LLM keeps doing)

```
{action_sequence}
```

### Typical Outcome

```
{typical_outcome}
```

## Connector Context

```
{connector_content}
```

## Audit Log (recent)

```
{audit_log_tail}
```

## Instructions

Write a shell script that **replaces** the repeated LLM action sequence above. The script should:

1. Perform the same operations the LLM was doing (API calls, file reads, checks, etc.)
2. Produce output that can be parsed programmatically
3. Exit 0 on success, exit 1 on failure (failure triggers LLM fallback)

Output format — the script MUST print a single JSON object to stdout:

```json
{"outcome": "<outcome_class>", "details": "<human-readable summary>", "data": {}}
```

Where `outcome` is one of:
- `no-tasks` — nothing to do (e.g., no new tasks found)
- `completed` — the action was successfully performed
- `needs-llm` — the script can't handle this case, fall back to LLM
- `error` — something went wrong

Requirements:
- Standalone bash script (no Node/Python dependencies beyond what's installed)
- Must exit 0 on success. **Only stdout** should be the JSON result.
- Handle errors gracefully — if something fails, output `{"outcome":"needs-llm","details":"<reason>"}` and exit 1
- Keep it simple and fast (< 10 seconds)
- Use the same auth/API approach visible in the connector context

## Output

Output ONLY the script, wrapped in a single fenced code block:

```bash
#!/bin/bash
# Generated tool for: {template_name}/{connector_name}
# Replaces repeated pattern: {fingerprint}
# ... your script here ...
```

No explanation needed. Just the script.
