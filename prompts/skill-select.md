# Skill Select

You are selecting relevant skills for a task.

## Instructions

1. Read `{vault_path}/skills/_tree.md` to understand the skill hierarchy.
2. Consider this task description:
   ```
   {task_description}
   ```
3. Identify which skills would be most helpful for executing this task.
4. Return ONLY the file paths of relevant skills, one per line.
5. Choose the most relevant 3-5 skills maximum.

## Output Format

Return only file paths, nothing else:
```
skills/coding/typescript-patterns.md
skills/devops/docker-best-practices.md
```

If no skills are relevant, return:
```
NONE
```
