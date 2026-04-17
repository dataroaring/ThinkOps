# ThinkOps Design Principles

Every change to ThinkOps must respect these principles. The enhance loop and all contributors should treat violations as bugs.

---

## 1. Intelligence in Prompts, Plumbing in Code

The TypeScript orchestrator is thin plumbing — config, spawning, splitting, tracking. All intelligence lives in prompt templates (`prompts/*.md`). Change what the system *does* by editing markdown, not code. The orchestrator decides *when* and *how* to spawn; prompts decide *what to do*.

## 2. Structural Control Over Prompt Heuristics

Task splitting, parallelism, and pipeline enforcement happen in the orchestrator — never via prompt engineering. The LLM is never asked "should you run these in parallel?" The orchestrator decides based on structured output from preflight (fast/full flags, priorities).

## 3. Cheapest Check First

Every cycle follows an escalating cost ladder:

1. `## Check` command — zero LLM cost (SHA-256 fingerprint)
2. Generated tool — zero LLM cost (bash script from pattern detection)
3. Preflight LLM — cheap (bare mode, ~15-20K tokens saved)
4. Full execution — expensive (only when real work exists)

Never skip a cheaper layer to jump to an expensive one. New features should add cheap checks, not more LLM calls.

## 4. Learn Like Humans Do

Three feedback loops at different speeds, each catching what the others miss:

- **Muscle memory** (per-task): Record actions → fingerprint sequences → detect repeats → generate scripts → replace LLM with bash. Self-healing: script fails → fall back to LLM silently.
- **Peer review** (per-cycle): Critic adversarially challenges claims → eval scores quality → route findings (SKILL/CODE/CRITICAL). The system internalizes patterns from its own reviews.
- **Retrospective** (daily): Check outcomes after completion (PR merged? reverted?) → extract lessons → load into next preflight. A task that looked good at eval time but failed in production gets remembered.

All three feed into preflight context for the next run. Lessons from one connector inform others.

## 5. One Failure, One Response

Failures are classified and each gets exactly one response path:

- **Auth errors** → backoff, skip recovery (retrying won't help)
- **Rate limits** → exponential backoff with reset on success
- **Execution failures** → recovery pipeline (retry → escalate → abandon, max 3 attempts)
- **Human needed** → release concurrency slot, ask via Telegram, resume

Never conflate failure types. Never double-log the same failure.

## 6. Every Task Gets Judged

No task completes without flowing through critic → eval → learn. The critic checks whether actual work matches claims. Eval scores quality and routes findings. Skipping eval (e.g., due to auth errors) must be logged as a warning, never silently swallowed.

## 7. Connectors Are Endless

A connector is a repeating concern, not a one-shot task. It's polled adaptively — fast when active (10min), slow when idle (up to 1hr). The system never "finishes" a connector; it keeps checking. Empty or placeholder connectors (< 100 bytes) should be filtered out, not polled.

## 8. Observable by Default

Every spawn logs to `_run_log.md`. Every task outcome goes to per-connector audit logs. The dashboard shows real-time state via SSE. `gather-state.sh` runs diagnostics at zero LLM cost. If something happens and nobody can see it, that's a bug.

## 9. Graceful Degradation

Non-critical failures never block progress:

- Critic/eval auth error → log warning, continue
- Skill selection fails → run with empty context
- Generated tool fails → fall back to LLM
- Merge conflict in enhance loop → abort merge, continue cycle

The system should always make forward progress, even in a degraded state.

## 10. Minimal, Test-Gated Changes

Changes should be the smallest diff that fixes the issue. No drive-by cleanups, no speculative abstractions, no features beyond what was asked. All changes must pass `npm test` before commit. The enhance loop reverts on test failure — this is a feature, not a limitation.
