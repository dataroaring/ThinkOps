# Knowledge Lint

Audit knowledge wiki for quality issues.

## Instructions

1. Read schema at `{vault_path}/knowledge/_schema.md`.
2. Scan all pages in `{vault_path}/knowledge/entities/` and `topics/`.
3. Check for: contradictions, missing citations, orphan pages, stale claims, duplicates, broken `[[wikilinks]]`.
4. Fix automatically: missing index entries, obvious broken links, clear duplicates. Flag ambiguous issues.
5. Append lint report to `{vault_path}/knowledge/_log.md`.

Prioritize contradictions and missing citations over cosmetic issues. Be conservative with automated fixes.
