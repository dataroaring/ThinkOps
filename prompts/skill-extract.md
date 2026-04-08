# Skill Extract

You are analyzing conversation history to extract reusable skills.

## Instructions

1. Read the skill schema at `{vault_path}/skills/_schema.md`.
2. Analyze the following conversation history:
   ```
   {history_chunk}
   ```
3. Look for:
   - **Repeated patterns**: approaches used multiple times.
   - **User corrections**: mistakes corrected by the user (these become anti-patterns).
   - **Successful approaches**: techniques that worked well.
   - **Domain knowledge**: specific facts or conventions referenced.
4. For each skill found:
   - Check if a similar skill already exists in `{vault_path}/skills/`.
   - If it exists, **update** it: refine the approach, add examples, note anti-patterns.
   - If it's new, **create** a skill file following the schema format.
   - Place it in the appropriate domain folder (e.g., `coding/`, `writing/`, `devops/`).
     Create the folder if it doesn't exist.
5. Update `{vault_path}/skills/_tree.md` with the current hierarchy.
6. Update `{vault_path}/skills/_stats.md` with extraction statistics.

## Guidelines

- Quality over quantity: only extract genuinely reusable skills.
- Each skill should be actionable, not just a vague observation.
- Include concrete examples from the conversation.
- Anti-patterns are as valuable as patterns.
