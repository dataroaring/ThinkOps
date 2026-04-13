# Knowledge Ingest

Process a new source into the knowledge wiki.

## Instructions

1. Read schema at `{vault_path}/knowledge/_schema.md`.
2. Read source at `{source_path}`.
3. Extract entities and topics. Update existing pages in `{vault_path}/knowledge/entities/` and `topics/`, or create new ones following schema.
4. Update `{vault_path}/knowledge/_index.md` (sorted alphabetically).
5. Append to `{vault_path}/knowledge/_log.md`: `- {timestamp} | Ingested: {source_path} | Created: [list] | Updated: [list]`

Every claim must cite its source. Use `[[wikilinks]]`. One entity/topic per page. Prefer updating over creating near-duplicates.
