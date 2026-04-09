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
