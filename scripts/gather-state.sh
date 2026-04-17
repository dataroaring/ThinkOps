#!/usr/bin/env bash
# gather-state.sh — Zero-cost diagnostic for ThinkOps enhancement loop.
# Reads run logs, audit files, git history, and code to produce a structured
# report that Claude Code can act on.
set -uo pipefail

VAULT="${VAULT_PATH:-$HOME/Documents/Obsidian Vault}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_LOG="$VAULT/thinkops/_run_log.md"
AUDIT_DIR="$VAULT/thinkops/audit"

# ── Helpers ──────────────────────────────────────

section() { printf '\n## %s\n\n' "$1"; }
kv()      { echo "- **$1**: $2"; }

# ── Header ───────────────────────────────────────

echo "# ThinkOps State Report"
echo "Generated: $(date '+%Y-%m-%d %H:%M:%S')"

# ── Git Status ───────────────────────────────────

section "Git Status"
cd "$PROJECT_DIR"
kv "Branch" "$(git branch --show-current 2>/dev/null || echo 'unknown')"
kv "Clean" "$(git diff --quiet && git diff --cached --quiet && echo 'yes' || echo 'no — uncommitted changes')"
kv "Last 5 commits" ""
git log --oneline -5 2>/dev/null | sed 's/^/  - /'

# ── Run Log Analysis ────────────────────────────

section "Run Log Summary (last 200 lines)"

if [[ -f "$RUN_LOG" ]]; then
  TOTAL_LINES=$(wc -l < "$RUN_LOG" | tr -d ' ')
  kv "Total log lines" "$TOTAL_LINES"

  TAIL=$(tail -200 "$RUN_LOG")

  # Count error patterns
  AUTH_403=$(echo "$TAIL" | grep -c '403\|Request not allowed' || true)
  NOT_LOGGED=$(echo "$TAIL" | grep -c 'Not logged in' || true)
  API_500=$(echo "$TAIL" | grep -c 'API Error: 500\|Internal server error' || true)
  RATE_LIMITED=$(echo "$TAIL" | grep -c 'rate limit\|429\|too many requests' || true)
  NO_TASKS=$(echo "$TAIL" | grep -c 'NO_TASKS_AVAILABLE' || true)
  TASK_COMPLETED=$(echo "$TAIL" | grep -c 'TASK_COMPLETED' || true)
  HUMAN_INPUT=$(echo "$TAIL" | grep -c 'HUMAN_INPUT_NEEDED' || true)
  RECOVERY_EXHAUSTED=$(echo "$TAIL" | grep -c 'recovery exhausted' || true)
  ABANDONED=$(echo "$TAIL" | grep -c 'abandoned:' || true)

  echo ""
  kv "403/auth failures" "$AUTH_403"
  kv "Not-logged-in errors" "$NOT_LOGGED"
  kv "500 server errors" "$API_500"
  kv "Rate limited" "$RATE_LIMITED"
  kv "No tasks available" "$NO_TASKS"
  kv "Tasks completed" "$TASK_COMPLETED"
  kv "Human input needed" "$HUMAN_INPUT"
  kv "Recovery exhausted" "$RECOVERY_EXHAUSTED"
  kv "Abandoned" "$ABANDONED"

  # Cost analysis from recent entries
  echo ""
  echo "### Recent Costs"
  TOTAL_COST=$(echo "$TAIL" | grep -oE 'cost: \$[0-9.]+' | sed 's/cost: \$//' | awk '{s+=$1} END {printf "%.2f", s}')
  ZERO_COST_RUNS=$(echo "$TAIL" | grep -c 'cost: \$0.0000' || true)
  ALL_RUNS=$(echo "$TAIL" | grep -c 'cost: \$' || true)
  kv "Total cost (last 200 lines)" "\$$TOTAL_COST"
  kv "Zero-cost runs (auth failures)" "$ZERO_COST_RUNS"
  kv "Total runs" "$ALL_RUNS"

  # Template frequency
  echo ""
  echo "### Template Usage (last 200 lines)"
  echo "$TAIL" | grep -oE '\|[[:space:]]*`[a-z-]+`' | sed 's/|[[:space:]]*//' | sed 's/`//g' | sort | uniq -c | sort -rn | head -10 | while read -r count name; do
    printf '  - `%s`: %d runs\n' "$name" "$count"
  done

  # Wasted runs: templates that always return "Not logged in" or 403
  echo ""
  echo "### Wasted Runs (auth/login failures by template)"
  echo "$TAIL" | grep -E 'Not logged in|403' | grep -oE '\|[[:space:]]*`[a-z-]+`' | sed 's/|[[:space:]]*//' | sed 's/`//g' | sort | uniq -c | sort -rn | head -10 | while read -r count name; do
    printf '  - `%s`: %d wasted\n' "$name" "$count"
  done

  # Last 10 entries (condensed)
  echo ""
  echo "### Last 10 Entries"
  echo "$TAIL" | grep '^- ' | tail -10 | while IFS= read -r line; do
    # Truncate to 200 chars
    echo "  ${line:0:200}"
  done
else
  echo "(no run log found at $RUN_LOG)"
fi

# ── Audit Log Analysis ──────────────────────────

section "Audit Logs"

if [[ -d "$AUDIT_DIR" ]]; then
  for f in "$AUDIT_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    NAME=$(basename "$f" .md)
    LINES=$(wc -l < "$f" | tr -d ' ')
    DONE_COUNT=$(grep -c '| DONE |' "$f" || true)
    ATTEMPTED_COUNT=$(grep -c '| ATTEMPTED |' "$f" || true)
    EVAL_COUNT=$(grep -c '| EVAL |' "$f" || true)
    CHECKED_COUNT=$(grep -c '| CHECKED |' "$f" || true)

    echo "### $NAME"
    kv "Lines" "$LINES"
    kv "Done" "$DONE_COUNT"
    kv "Attempted/Failed" "$ATTEMPTED_COUNT"
    kv "Evaluated" "$EVAL_COUNT"
    kv "Checked (no work)" "$CHECKED_COUNT"

    # Show recent entries
    echo "  Recent:"
    tail -5 "$f" | while IFS= read -r line; do
      echo "    ${line:0:160}"
    done
    echo ""
  done
else
  echo "(no audit directory)"
fi

# ── Connector Status ─────────────────────────────

section "Connectors"

CONNECTOR_DIR="$VAULT/connectors"
if [[ -d "$CONNECTOR_DIR" ]]; then
  for f in "$CONNECTOR_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    NAME=$(basename "$f" .md)
    SIZE=$(wc -c < "$f" | tr -d ' ')
    TASKS_TOTAL=$(grep -cE '^\s*(###|\d+\.)' "$f" || true)
    TASKS_DONE=$(grep -c '\[x\]' "$f" || true)
    TASKS_OPEN=$(grep -c '\[ \]' "$f" || true)
    HAS_CHECK=$(grep -q '^## Check' "$f" && echo "yes" || echo "no")
    echo "### $NAME"
    kv "Size" "${SIZE}B"
    kv "Has ## Check" "$HAS_CHECK"
    kv "Tasks (total/done/open)" "$TASKS_TOTAL / $TASKS_DONE / $TASKS_OPEN"
    echo ""
  done
else
  echo "(no connectors directory)"
fi

# ── Code Health ──────────────────────────────────

section "Code Health"

cd "$PROJECT_DIR"

# TypeScript compile check
if npx tsc --noEmit 2>/dev/null; then
  kv "TypeScript" "compiles clean"
else
  kv "TypeScript" "has errors"
fi

# Test status
if npm test 2>/dev/null | tail -3; then
  kv "Tests" "passing"
else
  kv "Tests" "failing"
fi

# Source line count
SRC_LINES=$(find src -name '*.ts' -exec cat {} + 2>/dev/null | wc -l | tr -d ' ')
PROMPT_COUNT=$(ls prompts/*.md 2>/dev/null | wc -l | tr -d ' ')
kv "Source lines" "$SRC_LINES"
kv "Prompt templates" "$PROMPT_COUNT"

# ── Known Issue Patterns ─────────────────────────

section "Detected Issue Patterns"

echo "The following issues are detected automatically from the state above:"
echo ""

# Pattern 1: Auth failures not circuit-broken.
# Runtime guard `applyAuthBackoff` already short-circuits the recovery pipeline
# on auth failures, so the on-disk error count alone is not an issue. Only flag
# when the guard is missing from src/orchestrator.ts.
ORCHESTRATOR="$PROJECT_DIR/src/orchestrator.ts"
if [[ -f "$ORCHESTRATOR" ]] && ! grep -q 'applyAuthBackoff' "$ORCHESTRATOR"; then
  if [[ ${AUTH_403:-0} -gt 5 ]] || [[ ${NOT_LOGGED:-0} -gt 5 ]]; then
    echo "- **AUTH_FAILURE_LOOP**: $AUTH_403 auth-403 + $NOT_LOGGED not-logged-in errors in last 200 lines."
    echo "  The orchestrator lacks a circuit breaker for authentication failures."
    echo "  Impact: Endless retry loop burning time, cluttering audit logs."
    echo ""
  fi
fi

# Pattern 2: Eval quality scores missing
MISSING_EVAL=$(grep -l 'quality: ?/10' "$AUDIT_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
if [[ ${MISSING_EVAL:-0} -gt 0 ]]; then
  echo "- **EVAL_SKIPPED**: $MISSING_EVAL audit files have tasks with 'quality: ?/10'."
  echo "  Eval/critique phases are failing (likely auth) but tasks still marked DONE."
  echo "  Impact: No quality feedback loop — the system can't learn from its own work."
  echo ""
fi

# Pattern 3: Duplicate audit entries
DUPES=$(grep -c 'recovery exhausted' "$AUDIT_DIR"/*.md 2>/dev/null | awk -F: '{s+=$2} END {print s}')
ABANDONS=$(grep -c 'abandoned:' "$AUDIT_DIR"/*.md 2>/dev/null | awk -F: '{s+=$2} END {print s}')
if [[ ${DUPES:-0} -gt 5 ]] && [[ ${ABANDONS:-0} -gt 5 ]]; then
  echo "- **DUPLICATE_AUDIT_ENTRIES**: $ABANDONS abandoned + $DUPES recovery-exhausted entries."
  echo "  Each failure logs both 'abandoned' and 'recovery exhausted' on the same timestamp."
  echo "  Impact: Audit log noise, inflated failure counts."
  echo ""
fi

# Pattern 4: Skill-select always returns NONE
SKILL_NONE=$(echo "${TAIL:-}" | grep -c 'skill-select.*NONE\|no.*skills.*select' || true)
SKILL_TOTAL=$(echo "${TAIL:-}" | grep -c 'skill-select' || true)
if [[ ${SKILL_TOTAL:-0} -gt 3 ]] && [[ ${SKILL_NONE:-0} -eq ${SKILL_TOTAL:-0} ]]; then
  echo "- **EMPTY_SKILL_SELECT**: All $SKILL_TOTAL skill-select calls returned NONE."
  echo "  Skill-select is being called even when the skill tree is empty."
  echo "  Impact: ~\$0.07-0.16 wasted per task execution."
  echo ""
fi

# Pattern 5: Empty connectors — only flag if runtime filter is missing.
# Runtime already skips < 100B files in listConnectors() and runConnector(),
# so the on-disk file alone is not an issue. Verify the guards still exist.
ORCHESTRATOR="$PROJECT_DIR/src/orchestrator.ts"
if [[ -f "$ORCHESTRATOR" ]] && ! grep -q 'content.trim().length < 100' "$ORCHESTRATOR"; then
  if [[ -d "$CONNECTOR_DIR" ]]; then
    for f in "$CONNECTOR_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      SIZE=$(wc -c < "$f" | tr -d ' ')
      NAME=$(basename "$f" .md)
      if [[ $SIZE -lt 100 ]]; then
        echo "- **EMPTY_CONNECTOR**: '$NAME' is only ${SIZE}B and orchestrator lacks the size-filter guard."
        echo "  Impact: Wasted LLM calls on empty/placeholder connectors."
        echo ""
      fi
    done
  fi
fi

echo "---"
echo "End of state report."
