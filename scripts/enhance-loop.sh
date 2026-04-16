#!/usr/bin/env bash
# enhance-loop.sh — Fully autonomous ThinkOps self-improvement loop.
#
# Usage:
#   ./scripts/enhance-loop.sh                   # One cycle: fix, test, commit, push
#   ./scripts/enhance-loop.sh --dry-run         # Analyze only, no changes
#   while true; do ./scripts/enhance-loop.sh; sleep 1800; done   # Loop every 30m
#
# Each cycle:
#   1. Gathers current state (zero LLM cost)
#   2. Checks if any issues remain to fix
#   3. Spawns Claude Code to implement ONE fix
#   4. Runs npm test — reverts if failing
#   5. Commits and pushes automatically
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VAULT="${VAULT_PATH:-$HOME/Documents/Obsidian Vault}"
ENHANCE_LOG="$VAULT/thinkops/enhance_log.md"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    *)         echo "Unknown option: $1"; exit 1 ;;
  esac
done

cd "$PROJECT_DIR"

# ── Helpers ──────────────────────────────────────

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[enhance] $(ts) $1"; }

append_log() {
  mkdir -p "$(dirname "$ENHANCE_LOG")"
  echo "- $(ts) | $1 | $2" >> "$ENHANCE_LOG"
}

# ── Step 1: Gather state ────────────────────────

log "Gathering ThinkOps state..."
STATE=$(bash "$SCRIPT_DIR/gather-state.sh" 2>/dev/null)

# Check if any issues were detected
if ! echo "$STATE" | grep -q '^\- \*\*[A-Z_]*\*\*:'; then
  log "No issues detected. ThinkOps codebase is healthy."
  append_log "SKIPPED" "No issues detected"
  exit 0
fi

ISSUES=$(echo "$STATE" | sed -n '/## Detected Issue Patterns/,/^---/p' | grep '^\- \*\*' | head -5)
log "Issues found:"
echo "$ISSUES" | sed 's/^/  /'

if $DRY_RUN; then
  log "DRY RUN — not implementing fixes."
  exit 0
fi

# ── Step 2: Check what's already fixed ───────────

ALREADY_FIXED=""
if [[ -f "$ENHANCE_LOG" ]]; then
  ALREADY_FIXED=$(cat "$ENHANCE_LOG")
  log "Enhancement history (last 5):"
  tail -5 "$ENHANCE_LOG" | sed 's/^/  /'
fi

# ── Step 3: Build prompt and spawn Claude Code ───

PROMPT=$(cat <<'PROMPT_END'
You are enhancing ThinkOps, an evolution agent system. Below is a diagnostic report and enhancement history.

<state-report>
STATE_PLACEHOLDER
</state-report>

<already-fixed>
FIXED_PLACEHOLDER
</already-fixed>

## Your Task

Pick exactly ONE issue from "Detected Issue Patterns" that has NOT been fixed already (check the <already-fixed> section). Implement a focused fix.

## Priority Order

1. **AUTH_FAILURE_LOOP** — Add auth failure detection to the orchestrator. When a spawn returns "Not logged in" or "403 Request not allowed", treat it like a rate limit: apply backoff and skip the recovery pipeline.
2. **DUPLICATE_AUDIT_ENTRIES** — In handleRecovery(), when the decision is ABANDON, it logs "abandoned" then falls through to also log "recovery exhausted". Fix the control flow so only one entry per failure.
3. **EVAL_SKIPPED** — When task-critique or eval-run returns an auth error (cost $0.0000, "Not logged in"), detect and log a warning rather than silently recording "quality: ?/10".
4. **EMPTY_SKILL_SELECT** — Before spawning skill-select, check if the skill tree has content. Skip if empty.
5. **EMPTY_CONNECTOR** — Filter out connector files < 100 bytes in listConnectors().

## Rules

- Fix ONE issue per cycle. Do not batch.
- Read the relevant source files before making changes.
- Run `npm test` after changes. All tests must pass.
- Keep changes minimal — no drive-by cleanups.
- Do not add comments, docstrings, or type annotations to code you didn't change.
- Report what you did in this exact format at the end:

```
ENHANCEMENT_DONE
issue: <ISSUE_TAG>
summary: <one-line description>
files: <comma-separated list of changed files>
tests: <pass/fail>
```

If all issues from the priority list are already fixed, report:

```
NO_ENHANCEMENT_NEEDED
reason: <why>
```
PROMPT_END
)

# Inject state and history into prompt
PROMPT="${PROMPT/STATE_PLACEHOLDER/$STATE}"
PROMPT="${PROMPT/FIXED_PLACEHOLDER/$ALREADY_FIXED}"

log "Spawning Claude Code to implement fix..."

OUTPUT=$(claude -p "$PROMPT" \
  --output-format text \
  --dangerously-skip-permissions \
  --model opus \
  2>/dev/null) || true

# ── Step 4: Parse result ─────────────────────────

if echo "$OUTPUT" | grep -q 'ENHANCEMENT_DONE'; then
  ISSUE=$(echo "$OUTPUT" | grep '^issue:' | head -1 | sed 's/^issue:[[:space:]]*//')
  SUMMARY=$(echo "$OUTPUT" | grep '^summary:' | head -1 | sed 's/^summary:[[:space:]]*//')
  FILES=$(echo "$OUTPUT" | grep '^files:' | head -1 | sed 's/^files:[[:space:]]*//')
  TESTS=$(echo "$OUTPUT" | grep '^tests:' | head -1 | sed 's/^tests:[[:space:]]*//')

  log "Fix applied: [$ISSUE] $SUMMARY"
  log "Files: $FILES"
  log "Tests: $TESTS"

  # ── Step 5: Verify tests ─────────────────────

  log "Verifying tests..."
  if npm test 2>&1 | tail -5; then
    log "Tests confirmed passing."
  else
    log "ERROR: Tests failing after fix. Reverting."
    git checkout -- . 2>/dev/null || true
    append_log "REVERTED" "[$ISSUE] $SUMMARY (tests failed)"
    exit 1
  fi

  # ── Step 6: Commit and push ──────────────────

  log "Committing changes..."
  git add -A
  git commit -m "$(cat <<EOF
Enhance: $SUMMARY

Auto-fix for $ISSUE detected by enhance-loop.
Files: $FILES

Co-Authored-By: Claude Sonnet <noreply@anthropic.com>
EOF
  )" 2>&1 | tail -3

  log "Pushing to remote..."
  git push 2>&1 | tail -3

  append_log "DONE" "[$ISSUE] $SUMMARY | files: $FILES | committed+pushed"
  log "Cycle complete: [$ISSUE] committed and pushed."

elif echo "$OUTPUT" | grep -q 'NO_ENHANCEMENT_NEEDED'; then
  REASON=$(echo "$OUTPUT" | grep '^reason:' | head -1 | sed 's/^reason:[[:space:]]*//')
  log "All issues resolved: $REASON"
  append_log "ALL_DONE" "$REASON"
  exit 0
else
  log "Claude Code did not produce structured output. Tail:"
  echo "$OUTPUT" | tail -15
  append_log "UNCLEAR" "No structured result from Claude Code"
  exit 1
fi
