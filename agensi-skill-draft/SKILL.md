---
name: easy-mcp-local-project
description: Work on the user's local project folder through their own Easy MCP server (read, search, edit files, run commands, manage background jobs) instead of asking the user to paste file contents into chat.
---

# Easy MCP — Local Project Skill (DRAFT — not for listing yet)

## What this is
A companion skill for Easy MCP (https://github.com/phongakay1-pixel/easy-mcp),
a free, MIT-licensed, zero-dependency Node.js MCP server the user runs on
their own machine. The server is NOT bundled with this skill; the user
installs and runs it themselves. This skill only teaches the agent when and
how to use the 18 tools the server exposes once connected.

## Setup the user must do first (agent cannot do this)
1. Install Tailscale (free plan is fine) and sign in — Easy MCP publishes
   through Tailscale Funnel at a stable https://<machine>.<tailnet>.ts.net
   address, so the MCP link never changes.
2. Run `node easy-mcp.js /path/to/project` (or double-click easy-mcp.bat on
   Windows). The dashboard opens in the browser.
3. Copy the one MCP link from the dashboard and paste it into the AI
   client's MCP / custom-connector settings. One paste — no separate
   Client ID / Client Secret steps for the user.

## Tools available once connected
read_file, read_files, write_file, write_files, edit_file, list_directory,
search_files, get_file_info, execute_command, start_job, job_status,
stop_job, list_jobs, git_status, git_diff, fetch_url, get_current_project,
set_project.

## How to work
- Start with get_current_project, then list_directory / search_files to
  orient before reading whole files.
- Prefer read_files (batch) over many single reads.
- Use edit_file for surgical changes; write_file only for new files or
  full rewrites the user asked for.
- Use start_job for long-running processes (dev servers); check job_status
  instead of blocking on execute_command.
- Check git_status / git_diff before and after edits so the user sees
  exactly what changed.

## Safety rules (must follow)
- All file access is jailed to the current project folder. Never ask the
  user to disable the jail; use set_project to switch folders explicitly.
- If the server is in read-only mode or shell is disabled, respect it —
  do not try to work around it.
- Confirm before destructive commands (delete, overwrite, git reset).
- Never read or exfiltrate credential files (.env, keys, tokens) unless
  the user explicitly asks about that exact file.
