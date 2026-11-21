# Connecting Easy MCP to AI clients

Start Easy MCP first (`node easy-mcp.js <folder>`), then copy the MCP link from the dashboard.

## Claude Web / ChatGPT

Settings → Connectors → Add custom connector → paste the MCP link (it already contains the token). Done — no extra message needed in chat.

## Gemini Web (gemini.google.com)

Settings → Connectors (Connected Apps) → Add a custom app → paste the MCP link. Availability depends on your account/region. If you don't see "Add a custom app", use one of the paths below.

## Gemini API (API key from AI Studio)

Google AI Studio's web UI has no field for MCP URLs, but the Gemini API behind it does (Interactions API, Streamable HTTP). Use `gemini-interactions.mjs`:

```
GEMINI_API_KEY=... EASY_MCP_URL=https://xxxx.trycloudflare.com EASY_MCP_TOKEN=... \
  node examples/gemini-interactions.mjs "Read README.md and summarize it"
```

## Gemini API via function-calling bridge (works everywhere, no Interactions API needed)

`gemini-function-loop.mjs` converts Easy MCP's tools to Gemini function declarations and runs the call loop itself: Gemini asks, the script executes against Easy MCP, results go back. Same env vars as the Interactions example:

```
GEMINI_API_KEY=... EASY_MCP_URL=https://xxxx.trycloudflare.com EASY_MCP_TOKEN=... \
  node examples/gemini-function-loop.mjs "Run the tests and fix failures"
```

Add `--dry-run` to print the generated declarations without calling Gemini.

## AI Studio web (no MCP field) — extension workaround

The [MCP SuperAssistant](https://github.com/srbhptl39/mcp-superassistant) Chrome extension injects MCP tools into web chats including Google AI Studio: install the extension, run its proxy (`npx @srbhptl39/mcp-superassistant-proxy --config ./mcpconfig.json`) pointing at your Easy MCP tunnel, then use the MCP button it adds next to the AI Studio input box. Be aware it is fragile: it rewrites page HTML (UI changes break it), each tool call pauses the chat until you press Run and send the result, and malformed model JSON causes errors.

## Desktop chat clients (Gemini models + MCP in one app)

Cherry Studio, LibreChat, LM Studio and 5ire all connect remote MCP servers by URL + headers and can run Gemini models via API key. Cherry Studio: Settings → MCP → MCP Servers → Add → type "Streamable HTTP" → URL `https://xxxx.trycloudflare.com/mcp` → header `Authorization: Bearer YOUR_TOKEN`.

## Gemini CLI

Merge `gemini-cli-settings.json` into `~/.gemini/settings.json` (Windows: `%USERPROFILE%\.gemini\settings.json`), replacing the URL and token. Or:

```
gemini mcp add --transport http easy-mcp https://xxxx.trycloudflare.com/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

## Antigravity (IDE / CLI / agy)

Merge the same `mcpServers` block into `~/.gemini/config/mcp_config.json` (Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`).

## Notes

- The tunnel URL changes every run (quick tunnel). Re-copy the link after restarting Easy MCP.
- Token in the link (`?token=...`) and `Authorization: Bearer` header both work.
- Gemini API server names must not contain a dash — use `easy_mcp` there.
