# Knowledge Lint

You are auditing the knowledge wiki for quality issues.

## Instructions

1. Read `{vault_path}/knowledge/_schema.md` for wiki conventions.
2. Scan all pages in `{vault_path}/knowledge/entities/` and `{vault_path}/knowledge/topics/`.
3. Check for:
   - **Contradictions**: conflicting claims across pages.
   - **Missing citations**: claims without source references.
   - **Orphan pages**: pages not linked from any other page or the index.
   - **Stale claims**: information that may be outdated (check dates).
   - **Duplicates**: near-duplicate pages covering the same topic.
   - **Broken links**: `[[wikilinks]]` pointing to non-existent pages.
4. Fix what you can automatically:
   - Add missing index entries.
   - Fix broken links if the target is obvious.
   - Merge clear duplicates.
5. Report all findings as a summary.
6. Append a lint report to `{vault_path}/knowledge/_log.md`.

## Guidelines

- Be conservative with automated fixes -- flag ambiguous issues rather than guessing.
- Prioritize contradictions and missing citations over cosmetic issues.
