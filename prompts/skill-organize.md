# Skill Organize

You are reorganizing the skills hierarchy for optimal retrieval.

## Instructions

1. Read `{vault_path}/skills/_tree.md` and `{vault_path}/skills/_schema.md`.
2. Read all skill files across all domain folders in `{vault_path}/skills/`.
3. Reorganize:
   - **Merge** skills that are too similar (combine into one, redirect the other).
   - **Split** skills that cover too many topics (break into focused sub-skills).
   - **Reclassify** skills in wrong domain folders.
   - **Rebalance** the tree so no folder has too many or too few skills.
4. Update `{vault_path}/skills/_tree.md` to reflect the new hierarchy.
5. Update `{vault_path}/skills/_stats.md` with:
   - Total skill count, skills per domain, last organized date.
   - Merges and splits performed in this run.

## Guidelines

- A good skill tree has 3-7 items per folder.
- Prefer clear, descriptive names over clever ones.
- Preserve skill content during reorganization -- only change structure and metadata.
