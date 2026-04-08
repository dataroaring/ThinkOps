# Skill Schema

This file defines the structure for skill files managed by ThinkOps.

## Skill File Format

Each skill is a markdown file with YAML frontmatter:

```yaml
---
name: "Descriptive Skill Name"
domain: coding | writing | devops | research | communication | other
confidence: low | medium | high
times_used: 0
last_used: YYYY-MM-DD
extracted_from: "source conversation or manual"
tags: [relevant, tags]
---
```

## Skill Body Structure

```markdown
# Skill Name

## When to Use
Describe the situations where this skill applies.

## Approach
Step-by-step approach or technique.

## Examples
Concrete examples from real conversations.

## Anti-patterns
What NOT to do. Common mistakes.

## Notes
Additional context, caveats, or refinements.
```

## Hierarchy (`_tree.md`)

Auto-maintained tree showing all skills organized by domain:

```markdown
# Skill Tree

## coding/ (N skills)
- typescript-patterns.md: TS conventions and patterns
- error-handling.md: Error handling strategies

## devops/ (N skills)
- docker-best-practices.md: Docker container patterns
```

## Statistics (`_stats.md`)

```markdown
# Skill Stats

- Total skills: N
- Last extraction: YYYY-MM-DD
- Last organization: YYYY-MM-DD

## By Domain
- coding: N skills
- devops: N skills
```

## Guidelines

- Skills should be **actionable**: a reader should know exactly what to do.
- Include **anti-patterns**: knowing what NOT to do is as valuable as knowing what to do.
- **Merge similar skills**: prefer one comprehensive skill over multiple overlapping ones.
- **Update confidence** based on feedback: corrections lower confidence, successful use raises it.
