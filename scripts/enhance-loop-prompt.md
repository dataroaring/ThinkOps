# ThinkOps Enhancement Loop

Run `bash scripts/gather-state.sh` to get the current diagnostic report. Then:

1. Read the "Detected Issue Patterns" section carefully
2. Pick the **highest-priority unresolved issue** (see priority order below)
3. Check `cat ~/Documents/Obsidian\ Vault/thinkops/enhance_log.md` to see what's already been fixed — skip those
4. Read the relevant source files before changing anything
5. Implement ONE focused fix
6. Run `npm test` — all tests must pass
7. Append what you did to the enhance log:
   `echo "- $(date '+%Y-%m-%d %H:%M:%S') | DONE | [ISSUE_TAG] summary | files: list" >> ~/Documents/Obsidian\ Vault/thinkops/enhance_log.md`
8. Report what changed and what's left

## Priority Order

1. **AUTH_FAILURE_LOOP** — Add auth/login failure detection to the orchestrator. When a spawn returns "Not logged in" or "403 Request not allowed", treat it as an auth error: skip the recovery pipeline, apply exponential backoff like rate limits, and log once. Currently the system retries every ~22 minutes endlessly.
2. **DUPLICATE_AUDIT_ENTRIES** — In `handleRecovery()`, when the decision is ABANDON, it logs "abandoned" then falls through to also log "recovery exhausted". Fix the control flow so only one entry is logged per failure.
3. **EVAL_SKIPPED** — When `task-critique` or `eval-run` returns an auth error ("Not logged in", 403, cost $0.0000), detect it and log a warning. Don't silently record "quality: ?/10".
4. **EMPTY_SKILL_SELECT** — Before spawning `skill-select`, check if the skill tree file (`skills/_tree.md`) exists and has real content. Skip the LLM call if empty.
5. **EMPTY_CONNECTOR** — Filter out connector files < 100 bytes in `listConnectors()`.

## Rules

- Fix ONE issue per loop iteration. Don't batch.
- Read before you write. Understand the existing code.
- `npm test` must pass after changes.
- Keep changes minimal — no drive-by cleanups.
- If all issues are fixed, say so and the loop can stop.
