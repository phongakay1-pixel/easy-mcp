#!/usr/bin/env node
/*
 * Use Easy MCP from the Gemini API (Interactions API).
 *
 * Google's servers connect to your Easy MCP tunnel and call its tools
 * server-side. You need:
 *   GEMINI_API_KEY  — an API key from Google AI Studio
 *   EASY_MCP_URL    — your tunnel URL, e.g. https://xxxx.trycloudflare.com
 *   EASY_MCP_TOKEN  — the token Easy MCP printed at startup
 *
 * Usage:
 *   GEMINI_API_KEY=... EASY_MCP_URL=https://xxxx.trycloudflare.com EASY_MCP_TOKEN=... \
 *     node examples/gemini-interactions.mjs "List the files in my project"
 *
 * Optional: GEMINI_MODEL (default gemini-3.8-flash)
 */
const apiKey = process.env.GEMINI_API_KEY;
const baseUrl = (process.env.EASY_MCP_URL || '').replace(/\/+$/, '');
const token = process.env.EASY_MCP_TOKEN || '';
const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const prompt = process.argv.slice(2).join(' ') || 'List the files in my project folder.';

if (!apiKey || !baseUrl) {
  console.error('Set GEMINI_API_KEY and EASY_MCP_URL first. See the header of this file.');
  process.exit(1);
}

const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
  body: JSON.stringify({
    model,
    input: prompt,
    tools: [
      {
        type: 'mcp_server',
        name: 'easy_mcp', // Gemini API: server names must not contain a dash
        url: `${baseUrl}/mcp`,
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      }
    ]
  })
});

const data = await res.json();
if (!res.ok) {
  console.error('Gemini API error:', JSON.stringify(data, null, 2));
  process.exit(1);
}
for (const output of data.outputs || []) {
  if (output.type === 'text') console.log(output.text);
}
