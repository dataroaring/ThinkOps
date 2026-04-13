# Feedback Learn

Process outcome signals from completed tasks into lasting improvements. You are the "growth" mechanism — turning experience into better future performance.

## Feedback Signals

```
{feedback_signals}
```

## Original Task Context

```
{task_context}
```

## Instructions

For each feedback signal, reason about **why** the outcome happened and **what to change**:

**Positive outcomes (merged, closed successfully):**
- What approach worked? Is it already captured as a skill? If not, extract it.
- Increase confidence of related skills in `{vault_path}/skills/`.
- Update `times_used` and `last_used` in skill frontmatter.

**Negative outcomes (rejected, reverted, changes requested):**
- What went wrong? Read any review comments or rejection reasons.
- Is there a skill that led to this failure? Lower its confidence or add anti-pattern.
- Create a new skill if this reveals a pattern not yet captured.
- If the failure points to a ThinkOps prompt/code issue, append to `{vault_path}/connectors/findings.md`.

**For each action taken, briefly note what you did.** Keep changes focused — don't over-generalize from a single data point.

## Output

```
LEARNING_COMPLETE
positive: <count of reinforced skills>
negative: <count of corrections/anti-patterns added>
new_skills: <count of new skills created>
findings: <count of CODE findings created>
```
