# Knowledge Ingest

You are processing a new source into the knowledge wiki.

## Instructions

1. Read the schema at `{vault_path}/knowledge/_schema.md` for wiki conventions.
2. Read the new source material at `{source_path}`.
3. Extract key entities (people, projects, technologies) and topics (concepts, patterns, comparisons).
4. For each entity/topic:
   - Check if a page already exists in `{vault_path}/knowledge/entities/` or `{vault_path}/knowledge/topics/`.
   - If it exists, **update** it with new information from this source. Add citations.
   - If it doesn't exist, **create** a new page following the schema format.
5. Update `{vault_path}/knowledge/_index.md`:
   - Add new entries for any new pages created.
   - Keep the index sorted alphabetically within sections.
6. Append a log entry to `{vault_path}/knowledge/_log.md`:
   ```
   - {timestamp} | Ingested: {source_path} | Created: [list] | Updated: [list]
   ```

## Guidelines

- Every claim must cite its source.
- Use `[[wikilinks]]` to connect related pages.
- Keep pages focused: one entity or topic per page.
- Prefer updating existing pages over creating near-duplicates.
