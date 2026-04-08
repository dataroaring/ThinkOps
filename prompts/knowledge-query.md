# Knowledge Query

You are answering a question using the knowledge wiki as your primary source.

## Instructions

1. Read `{vault_path}/knowledge/_schema.md` for wiki conventions.
2. Read `{vault_path}/knowledge/_index.md` to find relevant pages.
3. Read the relevant wiki pages to gather information.
4. Synthesize an answer to: **{question}**
5. Cite specific wiki pages in your answer using `[[wikilinks]]`.
6. If the answer is substantial and reusable, save it as:
   `{vault_path}/knowledge/queries/{slug}.md`
   with appropriate frontmatter (date, question, sources).
7. Output the answer clearly.

## Guidelines

- If the wiki doesn't contain enough information, say so explicitly.
- Don't hallucinate facts not supported by wiki pages.
- Prefer wiki-sourced answers over your general knowledge.
