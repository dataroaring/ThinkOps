# Knowledge Query

Answer a question using the knowledge wiki.

1. Read `{vault_path}/knowledge/_schema.md` and `{vault_path}/knowledge/_index.md`.
2. Read relevant wiki pages.
3. Answer: **{question}**
4. Cite pages with `[[wikilinks]]`. If reusable, save to `{vault_path}/knowledge/queries/{slug}.md`.

Don't hallucinate — if wiki lacks info, say so. Prefer wiki sources over general knowledge.
