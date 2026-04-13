# Feedback Check

Check completed tasks for external outcome signals. You are the "ears" of the learning system — detect what happened after ThinkOps finished its work.

## Completed Tasks to Check

```
{tasks_to_check}
```

## Instructions

For each task above, determine its **external outcome** by checking the source system:
- **GitHub PR**: Was it merged, closed without merge, had changes requested, or reverted? Any new review comments since completion?
- **GitHub Issue**: Was it closed? Reopened? Any follow-up comments?
- **Jira**: What's the current status? Any comments or status transitions?
- **Inline task**: Was it manually edited or rolled back?

Use whatever tools and APIs are available. Be efficient — batch queries where possible.

## Output

For each task, output one line:

```
FEEDBACK
id: <task-id>
outcome: <merged | rejected | reverted | stale | unchanged | unknown>
signal: <brief explanation — e.g. "PR merged 2 days after completion" or "reviewer requested changes: missing test coverage">
```

- `merged` / `closed` — positive signal, approach worked
- `rejected` — negative signal, approach had problems
- `reverted` — strong negative signal, something broke
- `stale` — no activity, still open/pending
- `unchanged` — task source hasn't changed since completion
- `unknown` — couldn't determine (permissions, API error)

Only report tasks with actual signal changes. Skip `unchanged` tasks silently.
