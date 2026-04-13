# Skill Extract

Extract reusable skills from conversation history.

## Instructions

1. Read schema at `{vault_path}/skills/_schema.md`.
2. Analyze conversation:
   ```
   {history_chunk}
   ```
3. Extract: repeated patterns, user corrections (→ anti-patterns), successful approaches, domain knowledge.
4. For each skill: update existing in `{vault_path}/skills/` or create new following schema. Place in appropriate domain folder.
5. Update `{vault_path}/skills/_tree.md` and `{vault_path}/skills/_stats.md`.

Quality over quantity. Each skill must be actionable with concrete examples. Anti-patterns are as valuable as patterns.
