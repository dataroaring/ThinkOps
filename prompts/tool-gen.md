# Tool Generator

You just analyzed a connector and found no new tasks. Now generate a **reusable check script** so future polls can determine "are there new tasks?" without any LLM call.

## Connector

```
{connector_content}
```

## Audit Log (recent)

```
{audit_log_tail}
```

## What You Found

```
{agent_summary}
```

## Instructions

Write a shell script that:
1. Checks the task source (API, file, CLI) for current open/pending items
2. Compares against completed task IDs (read from the audit log at `{audit_path}`)
3. Outputs a single number: the count of **genuinely new** tasks (0 = nothing to do)

Requirements:
- Must be a standalone bash script (no Node/Python dependencies beyond what's already installed)
- Must exit 0 on success. The **only stdout** should be the numeric count.
- Use the same auth/API approach visible in the connector's ## Check or ## Source section
- Handle errors gracefully (if API is unreachable, output nothing and exit 1 — this will cause the system to fall back to the LLM)
- Keep it simple and fast (should complete in under 10 seconds)

## Output

Output ONLY the script content, wrapped in a single fenced code block:

```bash
#!/bin/bash
# Check script for: {connector_name}
# ... your script here ...
```

No explanation needed. Just the script.
