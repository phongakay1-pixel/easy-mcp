#!/usr/bin/env node
/*
 * Gemini + Easy MCP via the function-calling bridge (no Interactions API needed).
 *
 * How it works:
 *   1. Ask Easy MCP for its tool list (MCP tools/list).
 *   2. Convert the tools to Gemini function declarations.
 *   3. Chat loop: Gemini emits function calls -> this script executes them
 *      against Easy MCP (/call) -> results go back to Gemini -> repeat.
 *
 * This is the workaround for surfaces with no MCP field (e.g. AI Studio web):
 * the model stays Gemini, your code does the executing.
 *
 * Env:
 *   GEMINI_API_KEY  — API key from Google AI Studio
 *   EASY_MCP_URL    — tunnel URL, e.g. https://xxxx.trycloudflare.com
 *   EASY_MCP_TOKEN  — token printed by Easy MCP at startup
 *   GEMINI_MODEL    — optional, default gemini-3.8-flash
 *
 * Usage:
 *   node examples/gemini-function-loop.mjs "Read README.md and summarize it"
 *   node examples/gemini-function-loop.mjs --dry-run   # print declarations only
 */
const apiKey = process.env.GEMINI_API_KEY;
const baseUrl = (process.env.EASY_MCP_URL || '').replace(/\/+$/, '');
const token = process.env.EASY_MCP_TOKEN || '';
const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const dryRun = process.argv.includes('--dry-run');
const prompt = process.argv.slice(2).filter(a => a !== '--dry-run').join(' ') || 'List the files in my project folder.';

if (!baseUrl || (!apiKey && !dryRun)) {
  console.error('Set EASY_MCP_URL (and GEMINI_API_KEY unless --dry-run). See the header of this file.');
  process.exit(1);
}

const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

async function mcpRpc(method, params) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...authHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function callTool(name, args) {
  const res = await fetch(`${baseUrl}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ name, arguments: args })
  });
  const data = await res.json();
  return data.success ? data.result : `Error: ${data.error}`;
}

// Gemini accepts a JSON-Schema subset; drop keys it rejects.
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['additionalProperties', '$schema', 'default', 'examples'].includes(k)) continue;
    if (k === 'properties') { out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, cleanSchema(pv)])); continue; }
    if (k === 'items') { out[k] = cleanSchema(v); continue; }
    out[k] = v;
  }
  return out;
}

const { tools } = await mcpRpc('tools/list');
const declarations = tools.map(t => ({
  name: t.name,
  description: t.description,
  parameters: cleanSchema(t.inputSchema)
}));

if (dryRun) {
  console.log(JSON.stringify(declarations, null, 2));
  process.exit(0);
}

const contents = [{ role: 'user', parts: [{ text: prompt }] }];
for (let turn = 0; turn < 12; turn++) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents, tools: [{ functionDeclarations: declarations }] })
  });
  const data = await res.json();
  if (!res.ok) { console.error('Gemini API error:', JSON.stringify(data, null, 2)); process.exit(1); }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const calls = parts.filter(p => p.functionCall);
  if (!calls.length) {
    console.log(parts.map(p => p.text || '').join(''));
    process.exit(0);
  }
  contents.push({ role: 'model', parts });
  const responses = [];
  for (const { functionCall } of calls) {
    console.error(`[tool] ${functionCall.name} ${JSON.stringify(functionCall.args || {})}`);
    const result = await callTool(functionCall.name, functionCall.args || {});
    responses.push({ functionResponse: { name: functionCall.name, response: { result } } });
  }
  contents.push({ role: 'user', parts: responses });
}
console.error('Stopped after 12 tool turns.');
