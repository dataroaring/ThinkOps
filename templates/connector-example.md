# Example: Jira Connector

## Source
Jira: https://your-company.atlassian.net
Auth: use JIRA_TOKEN environment variable (basic auth with email:token)
Filter: project = MYPROJECT AND status = "To Do" AND assignee = currentUser() ORDER BY priority DESC

## Check
curl -s -H "Authorization: Bearer $JIRA_TOKEN" "https://your-company.atlassian.net/rest/api/3/search?jql=project=MYPROJECT+AND+status=%22To+Do%22&maxResults=0" | jq '.total'

## Context
code directory: /path/to/your/project
using git worktree to isolate tasks.
create pr to your-org/your-repo
run tests before committing


# Example: GitHub PR Reviews Connector

## Source
GitHub PR reviews: your-org/your-repo
Filter: is:pr is:open review-requested:your-username

## Check
gh pr list --repo your-org/your-repo --search "review-requested:your-username" --json number,updatedAt,comments --limit 20

## Context
code directory: /path/to/your/project
create pr to your-org/your-repo


# Example: GitHub Issues Connector

## Source
GitHub Issues: your-org/your-repo
Filter: state:open assignee:your-username label:bug

## Check
gh issue list --repo your-org/your-repo --assignee your-username --label bug --json number,updatedAt --limit 20

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
Improvement findings discovered by the eval pipeline.
Each unchecked item below is a task to address.

## Check
cat connectors/findings.md | grep -c '^\- \[ \]'

## Tasks

## Context
code directory: /path/to/your/project
Address unchecked findings. Mark items `[x]` when resolved.
Only work on findings relevant to this codebase.
