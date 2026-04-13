# Tool Review

Verify that existing tool scripts still work and are still useful.

## Instructions

1. Read `{vault_path}/tools/_index.md` for the full tool inventory.
2. For each tool script:
   - **Syntax check**: Is the script valid? (shellcheck or dry-run)
   - **Dependency check**: Are required CLIs/APIs still available?
   - **Relevance check**: Is this tool still referenced by any connector in `{vault_path}/connectors/`? Has it been used recently?
3. Actions:
   - **Fix** tools with minor issues (typos, deprecated flags).
   - **Archive** tools that are no longer relevant → move to `{vault_path}/tools/_archive/`.
   - **Flag** tools with serious issues that need human attention.
4. Update `{vault_path}/tools/_index.md` to reflect changes.
5. Output a brief summary: tools checked, fixed, archived, flagged.
