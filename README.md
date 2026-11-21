# Easy MCP

Connect a local project folder to web AI clients (Claude Web, ChatGPT, Gemini, DeepSeek) over the Model Context Protocol. Zero npm dependencies — pure Node.js builtins. No terminal UI: everything happens on a web page.

▶️ **Watch the demo:** [Free Claude & ChatGPT vs Gemini Pro — who controls my PC?](https://www.youtube.com/watch?v=P-xTnxFNU80)

## Tunnel modes

Easy MCP publishes your local server through a tunnel. Two modes, switchable
any time from the dashboard toggle:

- **Cloudflare (default)** — a free quick tunnel, no account needed. The URL
  changes on every run, so you re-paste the MCP link after each restart. Note:
  some AI providers' servers get blocked by Cloudflare's bot protection.
- **Tailscale Funnel (persistent link)** — a stable
  `https://<machine>.<tailnet>.ts.net` address that never changes: paste the
  MCP link once and forget it. Requires [Tailscale](https://tailscale.com/download)
  installed and signed in (free plan works).

Your choice is remembered in `~/.easy-mcp/config.json`. Your access token is
generated once and stored in `~/.easy-mcp/token`, so with Funnel the MCP link
stays identical across restarts. Run with `--rotate-token` to mint a new one.

## Quickstart

One command — paste into cmd, PowerShell, or terminal (needs Node.js 18+):

```
npx -y https://codeload.github.com/mrkaylabs/easy-mcp/tar.gz/refs/heads/main
```

That runs Easy MCP on the current folder and opens the dashboard in your
browser. To use another folder: `npx -y https://codeload.github.com/mrkaylabs/easy-mcp/tar.gz/refs/heads/main /path/to/your/project`

Or clone it:

```
git clone https://github.com/mrkaylabs/easy-mcp.git
cd easy-mcp
node easy-mcp.js /path/to/your/project
```

On Windows you can also double-click `easy-mcp.bat`.

What happens:

1. A local MCP server starts on `127.0.0.1:9494`.
2. The selected tunnel publishes it at a public HTTPS address.
3. Your browser opens the dashboard.

## Dashboard

The dashboard is the control panel:

- **MCP link** — the public link to paste into your web AI client's MCP / custom tool settings, with a Copy button.
- **Project folder** — switch the folder the AI can access, with recent folders one click away.
- **Status** — tool count, calls, errors, sessions, background jobs, uptime.
- **Recent tool calls** — what the AI did, live.
- **Background jobs** — stop dev servers the AI started.

## Tools the AI gets

`read_file`, `read_files`, `write_file`, `write_files`, `edit_file`, `list_directory`, `search_files`, `get_file_info`, `execute_command`, `start_job`, `job_status`, `stop_job`, `list_jobs`, `git_status`, `git_diff`, `fetch_url`, `get_current_project`, `set_project`.

All file access is jailed to the project folder.

## Options

```
node easy-mcp.js [folder] [--port 9494] [--no-tunnel] [--no-open]
                          [--read-only] [--disable-shell] [--token <token>]
```

- `--read-only` — block file writes.
- `--disable-shell` — block command execution and background jobs.
- `--dangerously-skip-jail` — **no folder jail**: the AI can read, write and run commands anywhere on the machine (defaults the project to the drive root). Anyone with the MCP link + token gets the same access. The dashboard shows a red warning while it is on.
- `--no-tunnel` — local only, no public link.
- `--no-open` — don't open the browser.

## Security model

- Every request needs the token (`Authorization: Bearer <token>` or `?token=<token>`); a fresh random token is generated per run unless `--token` / `EASY_MCP_TOKEN` is set.
- The server binds `127.0.0.1` only; remote traffic goes through the tunnel.
- File operations cannot escape the project folder (path traversal and absolute paths outside it are rejected).

## Connecting clients

Claude Web, ChatGPT, Gemini Web, Gemini API (Interactions API), Gemini CLI, Antigravity — step-by-step for each in [examples/README.md](examples/README.md), including a ready-to-run Gemini API script. The `/mcp` endpoint speaks Streamable HTTP (with sessions) plus the legacy SSE transport.

## License

MIT — see [LICENSE](LICENSE).

---

[![Share AI Slot — family slots & AI subscriptions from $1/month](https://raw.githubusercontent.com/mrkaylabs/share-ai-slot/main/banner.png)](https://mrkaylabs.github.io/share-ai-slot/)

**Share AI Slot** — need a Google family slot or an AI subscription (ChatGPT, Claude Code...)? Got a spare one to sell? [Submit here](https://mrkaylabs.github.io/share-ai-slot/) — from $1/month, varies by country.
