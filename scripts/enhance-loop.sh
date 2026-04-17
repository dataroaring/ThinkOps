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

# ── Step 0: Ensure we're on main, merge branches ahead ──

ORIG_BRANCH=$(git branch --show-current 2>/dev/null)
if [[ "$ORIG_BRANCH" != "main" ]]; then
  log "Switching to main (was on $ORIG_BRANCH)..."
  # Stash any uncommitted changes so checkout doesn't fail
  git stash --include-untracked -q 2>/dev/null || true
  git checkout main 2>/dev/null || { log "ERROR: Cannot checkout main"; exit 1; }
fi

git fetch --all --prune 2>/dev/null || true

# Merge all local branches that are ahead of main, then delete them
for branch in $(git for-each-ref --format='%(refname:short)' refs/heads/ | grep -v '^main$'); do
  # Skip branches already fully contained in main (by ancestry or by content)
  if git merge-base --is-ancestor "$branch" main 2>/dev/null; then
    log "Deleting '$branch' (ancestor of main)."
    git branch -D "$branch" 2>/dev/null || true
    git push origin --delete "$branch" 2>/dev/null || true
    continue
  fi
  # If main is ahead of the branch tip, the branch is stale (e.g., rebased)
  if git merge-base --is-ancestor "$(git merge-base main "$branch")" "$branch" 2>/dev/null; then
    BEHIND=$(git rev-list --count "$branch"..main 2>/dev/null || echo 0)
    if [[ "$BEHIND" -gt 0 ]]; then
      log "Deleting '$branch' (main is $BEHIND commits ahead — stale branch)."
      git branch -D "$branch" 2>/dev/null || true
      git push origin --delete "$branch" 2>/dev/null || true
      continue
    fi
  fi
  AHEAD=$(git rev-list --count main.."$branch" 2>/dev/null || echo 0)
  if [[ "$AHEAD" -gt 0 ]]; then
    log "Merging '$branch' ($AHEAD commits ahead) into main..."
    if git merge "$branch" --no-edit 2>&1; then
      log "Merged '$branch' into main. Deleting branch."
      git branch -D "$branch" 2>/dev/null || true
      git push origin --delete "$branch" 2>/dev/null || true
    else
      log "ERROR: Merge conflict with '$branch'. Aborting merge."
      git merge --abort 2>/dev/null || true
      append_log "MERGE_FAILED" "Conflict merging $branch into main"
    fi
  fi
done

# Also pull remote main if behind
BEHIND_REMOTE=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
if [[ "$BEHIND_REMOTE" -gt 0 ]]; then
  log "Main is $BEHIND_REMOTE commits behind origin/main. Pulling..."
  git pull --no-edit 2>&1 | tail -3
fi

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

PRINCIPLES=""
if [[ -f "$PROJECT_DIR/PRINCIPLES.md" ]]; then
  PRINCIPLES=$(cat "$PROJECT_DIR/PRINCIPLES.md")
fi

PROMPT=$(cat <<'PROMPT_END'
You are enhancing ThinkOps, an evolution agent system.

<design-principles>
PRINCIPLES_PLACEHOLDER
</design-principles>

<state-report>
STATE_PLACEHOLDER
</state-report>

<already-fixed>
FIXED_PLACEHOLDER
</already-fixed>

## Your Task

Pick exactly ONE issue from "Detected Issue Patterns" that has NOT been fixed already (check the <already-fixed> section). Implement a focused fix that respects the design principles above.

## Rules

- Fix ONE issue per cycle. Do not batch.
- Read PRINCIPLES.md first, then the relevant source files before making changes.
- Every fix must align with the design principles. If a fix would violate a principle, find a different approach.
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

# Inject principles, state, and history into prompt
PROMPT="${PROMPT/PRINCIPLES_PLACEHOLDER/$PRINCIPLES}"
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

  log "Pushing main to remote..."
  git push origin main 2>&1 | tail -3

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
