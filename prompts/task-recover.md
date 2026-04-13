# Task Recovery

Analyze a failed task attempt and decide the path forward.

## Connector

```
{connector_content}
```

## Agent Output (failed attempt)

```
{agent_output}
```

## Attempt {attempt_number} of {max_attempts}

## Instructions

Analyze: What went wrong? Is it recoverable? What would you do differently?

Output exactly ONE decision:

**Retryable with different approach:**
```
DECISION: RETRY
ANALYSIS: <what went wrong>
PLAN: <specific different approach — not "try again">
```

**Needs human judgment or access:**
```
DECISION: ESCALATE
ANALYSIS: <the blocker>
QUESTION: <specific question for the human>
```

**Cannot succeed right now:**
```
DECISION: ABANDON
ANALYSIS: <why>
SUGGESTION: <what must change first>
```

On later attempts (2+), prefer ESCALATE or ABANDON over another RETRY. Be honest about root causes.
