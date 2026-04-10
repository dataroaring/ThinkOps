# Example: Jira Connector

## Source
Jira: https://your-company.atlassian.net
Auth: use JIRA_TOKEN environment variable (basic auth with email:token)
Filter: project = MYPROJECT AND status = "To Do" AND assignee = currentUser() ORDER BY priority DESC

## Context
code directory: /path/to/your/project
using git worktree to isolate tasks.
create pr to your-org/your-repo
run tests before committing


# Example: GitHub Issues Connector

## Source
GitHub Issues: your-org/your-repo
Filter: state:open assignee:your-username label:bug

## Context
code directory: /path/to/your/project
create pr to your-org/your-repo


# Example: Manual Task List

## Source
Manual task list below.

## Tasks
- [ ] Fix the memory leak in module X
- [ ] Add retry logic to the API client

## Context
code directory: /path/to/your/project


# Example: Self-Improvement Connector

## Source
ThinkOps findings file: thinkops/findings.md
These are improvement tasks discovered during eval of other connectors.
Each finding is a checkbox item `- [ ] description`.

## Context
code directory: /path/to/thinkops-managed-project
Address unchecked findings. Mark items `[x]` when resolved.
Only work on findings relevant to this codebase.
