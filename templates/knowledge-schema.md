# Knowledge Wiki Schema

This file defines the structure and conventions for the knowledge wiki.
All agents processing knowledge must follow these rules.

## Page Types

### Entity Pages (`entities/`)
Represent specific things: people, projects, technologies, organizations.

```yaml
---
type: entity
entity_type: person | project | technology | organization
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [list of source references]
---
```

Structure:
- **Summary**: 2-3 sentence overview
- **Key Facts**: bullet list of important attributes
- **Relationships**: links to related entities/topics via `[[wikilinks]]`
- **Sources**: numbered list of citations

### Topic Pages (`topics/`)
Represent concepts, patterns, comparisons, methodologies.

```yaml
---
type: topic
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [list of source references]
---
```

Structure:
- **Summary**: what this topic is about
- **Details**: in-depth explanation
- **Related**: links to related topics and entities
- **Sources**: citations

### Query Pages (`queries/`)
Saved answers to questions asked via the query system.

```yaml
---
type: query
question: "the original question"
created: YYYY-MM-DD
sources: [wiki pages referenced]
---
```

## Conventions

1. **One topic per page**: don't combine unrelated information.
2. **Always cite sources**: every factual claim should reference a source.
3. **Use wikilinks**: connect related pages with `[[page-name]]`.
4. **Update, don't duplicate**: if a page exists, update it with new info.
5. **Keep _index.md current**: every page must be listed in the index.
6. **Immutable sources**: files in `sources/` are never modified after ingestion.

## Index Format (`_index.md`)

```markdown
# Knowledge Index

## Entities
- [[entity-name]]: brief description

## Topics
- [[topic-name]]: brief description

## Queries
- [[query-slug]]: the question asked
```

## Log Format (`_log.md`)

Append-only chronological log:
```
- YYYY-MM-DD HH:mm | Operation | Details
```
