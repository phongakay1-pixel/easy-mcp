#!/usr/bin/env node
/*
 * Easy MCP — server
 *
 * A small, dependency-free MCP server that exposes one local project folder
 * to web AI clients, plus a plain web dashboard for the human running it.
 *
 * Routes (all token-gated except none):
 *   POST /mcp            JSON-RPC 2.0 (initialize, tools/list, tools/call, ping)
 *   GET  /sse            MCP SSE transport (endpoint event -> /messages)
 *   POST /messages       MCP SSE transport messages
 *   POST /call           { name, arguments } convenience tool call
 *   GET  /               dashboard page
 *   GET  /api/dashboard  dashboard JSON
 *   POST /api/set-project { path }
 *   POST /api/set-public-url { url }   (called by the launcher)
 *   POST /api/stop-job   { id }
 *
 * Auth: Authorization: Bearer <token>, x-easy-mcp-token header, or ?token=.
 * Binds 127.0.0.1 only; remote access goes through the tunnel.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(process.env.EASY_MCP_PORT || argValue('--port', '9494'));
const TOKEN = process.env.EASY_MCP_TOKEN || argValue('--token', '');
let DISABLE_SHELL = args.includes('--disable-shell') || process.env.EASY_MCP_DISABLE_SHELL === '1';
let READ_ONLY = args.includes('--read-only') || process.env.EASY_MCP_READ_ONLY === '1';
let SKIP_JAIL = args.includes('--dangerously-skip-jail') || process.env.EASY_MCP_SKIP_JAIL === '1';
let projectRoot = path.resolve(process.env.EASY_MCP_PROJECT || args.find(a => !a.startsWith('--')) || process.cwd());
let publicUrl = (process.env.EASY_MCP_PUBLIC_URL || '').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Tunnel manager — Cloudflare quick tunnel (default) or Tailscale Funnel
// (persistent link). Mode persists in ~/.easy-mcp/config.json.
// ---------------------------------------------------------------------------
const easyMcpHome = path.join(os.homedir(), '.easy-mcp');
const configFile = path.join(easyMcpHome, 'config.json');
function loadConfig() { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } }
function saveConfig(patch) {
  try {
    fs.mkdirSync(easyMcpHome, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ ...loadConfig(), ...patch }, null, 2) + '\n');
  } catch {}
}
let tunnelMode = process.env.EASY_MCP_TUNNEL || loadConfig().tunnel || 'cloudflare';
if (!['cloudflare', 'funnel', 'none'].includes(tunnelMode)) tunnelMode = 'cloudflare';
let tunnelProc = null;
let tunnelError = '';

function cloudflaredPath() {
  return path.join(easyMcpHome, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}
function ensureCloudflared() {
  const bin = cloudflaredPath();
  if (fs.existsSync(bin)) return Promise.resolve(bin);
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  const name = process.platform === 'win32' ? 'cloudflared-windows-amd64.exe'
    : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz')
    : (process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const tmp = bin + '.tmp';
  return new Promise((resolve, reject) => {
    const get = (url) => https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error('cloudflared download failed: HTTP ' + res.statusCode));
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(tmp, bin); if (process.platform !== 'win32') fs.chmodSync(bin, 0o755); resolve(bin); });
      out.on('error', reject);
    }).on('error', reject);
    get(base + name);
  });
}

function stopTunnel() {
  if (tunnelProc) { try { tunnelProc.kill(); } catch {} tunnelProc = null; }
  // Note: Funnel is left ON in tailscaled when switching away — turning it off
  // requires the Tailscale owner's session, and it proxies the same port anyway.
  publicUrl = '';
}

async function startTunnel(mode) {
  tunnelError = '';
  if (mode === 'none') { tunnelMode = 'none'; return; }
  if (mode === 'funnel') {
    try { spawnSync('tailscale', ['funnel', '--bg', String(PORT)], { stdio: 'ignore', timeout: 20000 }); } catch {}
    let dns = '';
    try {
      const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 15000 });
      dns = JSON.parse(st.stdout || '{}').Self?.DNSName?.replace(/\.$/, '') || '';
    } catch {}
    dns = dns || process.env.EASY_MCP_FUNNEL_HOST || '';
    if (!dns) {
      tunnelError = 'Tailscale not found or not signed in. Install: https://tailscale.com/download';
      tunnelMode = 'funnel';
      return;
    }
    tunnelMode = 'funnel';
    publicUrl = 'https://' + dns;
    console.log(`MCP link:  ${publicUrl}/mcp/${TOKEN}`);
    return;
  }
  // cloudflare
  tunnelMode = 'cloudflare';
  const bin = await ensureCloudflared();
  tunnelProc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    const m = String(d).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !publicUrl) {
      publicUrl = m[0];
      console.log(`MCP link:  ${publicUrl}/mcp/${TOKEN}`);
    }
  };
  tunnelProc.stdout.on('data', onData);
  tunnelProc.stderr.on('data', onData);
  tunnelProc.on('exit', () => { tunnelProc = null; if (!publicUrl) tunnelError = 'Cloudflare tunnel failed to start (no internet route?)'; });
}

async function setTunnel(mode) {
  if (!['cloudflare', 'funnel', 'none'].includes(mode)) throw new Error('Unknown tunnel mode: ' + mode);
  stopTunnel();
  saveConfig({ tunnel: mode });
  await startTunnel(mode);
}
const startedAt = Date.now();
const recentFile = path.join(require('os').homedir(), '.easy-mcp', 'recent-projects.json');
function loadRecents() {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile, 'utf8'));
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function saveRecents() {
  try {
    fs.mkdirSync(path.dirname(recentFile), { recursive: true });
    fs.writeFileSync(recentFile, JSON.stringify(recentProjects.slice(0, 10), null, 2));
  } catch {}
}
const recentProjects = [...new Set([projectRoot, ...loadRecents()])].slice(0, 10);

// ---------------------------------------------------------------------------
// Stats / activity
// ---------------------------------------------------------------------------

let totalCalls = 0;
let totalErrors = 0;
const recentCalls = []; // { ts, tool, ok, ms }
function recordCall(tool, ok, ms) {
  totalCalls++;
  if (!ok) totalErrors++;
  recentCalls.unshift({ ts: new Date().toISOString(), tool, ok, ms });
  if (recentCalls.length > 100) recentCalls.length = 100;
}

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

function resolveInProject(p) {
  const abs = path.resolve(projectRoot, String(p || '.'));
  if (SKIP_JAIL) return abs; // --dangerously-skip-jail: any path on the machine
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project folder: ${p}`);
  }
  return abs;
}
function relOf(abs) {
  const r = path.relative(projectRoot, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return abs.split(path.sep).join('/');
  return r === '' ? '.' : r.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

const jobs = new Map(); // id -> { id, command, pid, startedAt, status, exitCode, log }
let jobSeq = 0;

function shellCommand(command) {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: '/bin/sh', args: ['-c', command] };
}

function startJob(command) {
  const id = `job-${++jobSeq}`;
  const { file, args: sargs } = shellCommand(command);
  const child = spawn(file, sargs, { cwd: projectRoot, windowsHide: true });
  const job = { id, command, pid: child.pid, startedAt: new Date().toISOString(), status: 'running', exitCode: null, log: '' };
  const push = d => { job.log += d.toString(); if (job.log.length > 200000) job.log = job.log.slice(-200000); };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', code => { job.status = 'exited'; job.exitCode = code; });
  child.on('error', err => { job.status = 'error'; job.log += `\n${err.message}`; });
  jobs.set(id, job);
  return job;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__']);

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 12 || out.length > 5000) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function readTextFile(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error('Binary file, cannot read as text');
  return buf.toString('utf8');
}

function runCommand(command, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const { file, args: sargs } = shellCommand(command);
    const child = spawn(file, sargs, { cwd: projectRoot, windowsHide: true });
    let out = '';
    const push = d => { out += d.toString(); if (out.length > 300000) out = out.slice(-300000); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => { child.kill(); out += '\n[timed out]'; }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, output: out.trim() }); });
    child.on('error', err => { clearTimeout(timer); resolve({ exitCode: -1, output: err.message }); });
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//.test(url)) return reject(new Error('Only https:// URLs are allowed'));
    https.get(url, { headers: { 'User-Agent': 'easy-mcp' }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).toString()));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 300000) res.destroy(); });
      res.on('end', () => resolve(body.slice(0, 300000)));
    }).on('error', reject);
  });
}

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the project folder. Returns line-numbered content.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path: p }) => {
      const abs = resolveInProject(p);
      const lines = readTextFile(abs).split('\n');
      return `File: ${relOf(abs)} (${lines.length} lines)\n\n` + lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
    }
  },
  {
    name: 'read_files',
    description: 'Read several text files at once.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
    run: ({ paths }) => paths.map(p => {
      try { return `===== ${p} =====\n${readTextFile(resolveInProject(p))}`; }
      catch (e) { return `===== ${p} =====\n[error] ${e.message}`; }
    }).join('\n\n')
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the project folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    write: true,
    run: ({ path: p, content }) => {
      const abs = resolveInProject(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return `Wrote ${relOf(abs)} (${Buffer.byteLength(content)} bytes)`;
    }
  },
  {
    name: 'write_files',
    description: 'Create or overwrite several text files at once.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }, required: ['files'] },
    write: true,
    run: ({ files }) => files.map(f => {
      const abs = resolveInProject(f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, 'utf8');
      return `Wrote ${relOf(abs)}`;
    }).join('\n')
  },
  {
    name: 'edit_file',
    description: 'Replace an exact text snippet in a file. Fails if old_text is not found or not unique.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
    write: true,
    run: ({ path: p, old_text, new_text }) => {
      const abs = resolveInProject(p);
      const text = readTextFile(abs);
      const first = text.indexOf(old_text);
      if (first < 0) throw new Error('old_text not found');
      if (text.indexOf(old_text, first + 1) >= 0) throw new Error('old_text is not unique');
      fs.writeFileSync(abs, text.slice(0, first) + new_text + text.slice(first + old_text.length), 'utf8');
      return `Edited ${relOf(abs)}`;
    }
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a project directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: ({ path: p }) => {
      const abs = resolveInProject(p || '.');
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const lines = entries.map(e => {
        const full = path.join(abs, e.name);
        if (e.isDirectory()) return `[DIR]  ${e.name}/`;
        let size = 0; try { size = fs.statSync(full).size; } catch {}
        return `[FILE] ${e.name} (${size} bytes)`;
      });
      return `Directory: ${relOf(abs)}\n\n${lines.join('\n') || '(empty)'}`;
    }
  },
  {
    name: 'search_files',
    description: 'Search file contents for a text query across the project (skips node_modules/.git and binary files).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] },
    run: ({ query, path: p }) => {
      const base = resolveInProject(p || '.');
      const files = fs.statSync(base).isDirectory() ? walkFiles(base) : [base];
      const hits = [];
      for (const f of files) {
        let text; try { text = readTextFile(f); } catch { continue; }
        text.split('\n').forEach((line, i) => {
          if (line.includes(query) && hits.length < 200) hits.push(`${relOf(f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      return hits.length ? hits.join('\n') : 'No matches.';
    }
  },
  {
    name: 'get_file_info',
    description: 'Get size, type and timestamps for a file or folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path: p }) => {
      const abs = resolveInProject(p);
      const st = fs.statSync(abs);
      return JSON.stringify({ path: relOf(abs), type: st.isDirectory() ? 'directory' : 'file', size: st.size, modified: st.mtime.toISOString(), created: st.birthtime.toISOString() }, null, 2);
    }
  },
  {
    name: 'execute_command',
    description: 'Run a shell command inside the project folder (cmd on Windows, sh elsewhere). Returns exit code and output.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] },
    shell: true,
    run: async ({ command, timeout_ms }) => {
      const r = await runCommand(command, Math.min(Number(timeout_ms) || 120000, 600000));
      return `Exit code: ${r.exitCode}\n\n${r.output || '(no output)'}`;
    }
  },
  {
    name: 'start_job',
    description: 'Start a long-running background command (dev server, watcher). Returns a job id.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    shell: true,
    run: ({ command }) => {
      const job = startJob(command);
      return `Started ${job.id} (pid ${job.pid}): ${command}`;
    }
  },
  {
    name: 'job_status',
    description: 'Check a background job status and recent output.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown job: ${id}`);
      return `${job.id}: ${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}\nCommand: ${job.command}\nStarted: ${job.startedAt}\n\n${job.log.slice(-4000) || '(no output yet)'}`;
    }
  },
  {
    name: 'stop_job',
    description: 'Stop a background job.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown job: ${id}`);
      try { process.kill(job.pid); } catch {}
      job.status = 'stopped';
      return `Stopped ${id}`;
    }
  },
  {
    name: 'list_jobs',
    description: 'List background jobs.',
    inputSchema: { type: 'object', properties: {} },
    run: () => jobs.size
      ? [...jobs.values()].map(j => `${j.id}: ${j.status} — ${j.command}`).join('\n')
      : 'No jobs.'
  },
  {
    name: 'git_status',
    description: 'Run git status in the project folder.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await runCommand('git status --short --branch')).output || '(clean)'
  },
  {
    name: 'git_diff',
    description: 'Run git diff in the project folder (optionally for one path).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: async ({ path: p }) => (await runCommand(`git diff${p ? ` -- "${p}"` : ''}`)).output || '(no diff)'
  },
  {
    name: 'fetch_url',
    description: 'Fetch an https URL (documentation, API reference) and return its text.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: ({ url }) => fetchUrl(url)
  },
  {
    name: 'get_current_project',
    description: 'Return the current project folder.',
    inputSchema: { type: 'object', properties: {} },
    run: () => projectRoot
  },
  {
    name: 'set_project',
    description: 'Switch the project folder all tools operate on.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path: p }) => { setProject(p); return `Project folder: ${projectRoot}`; }
  }
];

function setProject(p) {
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Not a folder: ${p}`);
  projectRoot = abs;
  const i = recentProjects.indexOf(abs);
  if (i >= 0) recentProjects.splice(i, 1);
  recentProjects.unshift(abs);
  if (recentProjects.length > 10) recentProjects.length = 10;
  saveRecents();
}

const READ_ONLY_TOOLS = new Set(['read_file', 'read_files', 'list_directory', 'search_files', 'get_file_info', 'job_status', 'list_jobs', 'git_status', 'git_diff', 'fetch_url', 'get_current_project']);
function toolList() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: READ_ONLY_TOOLS.has(t.name)
      ? { readOnlyHint: true, destructiveHint: false, openWorldHint: t.name === 'fetch_url' }
      : { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }));
}

async function callTool(name, toolArgs) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (READ_ONLY && tool.write) throw new Error('Server is read-only');
  if (DISABLE_SHELL && tool.shell) throw new Error('Shell is disabled on this server');
  const t0 = Date.now();
  try {
    const result = await tool.run(toolArgs || {});
    recordCall(name, true, Date.now() - t0);
    return String(result);
  } catch (err) {
    recordCall(name, false, Date.now() - t0);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC
// ---------------------------------------------------------------------------

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'Easy MCP', version: '2.0.0' }
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call': {
      try {
        const text = await callTool(params?.name, params?.arguments);
        return reply({ content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// SSE sessions
// ---------------------------------------------------------------------------

const sseSessions = new Map(); // sessionId -> res (legacy SSE transport)
const mcpSessions = new Map(); // sessionId -> { createdAt } (Streamable HTTP)

// ---------------------------------------------------------------------------
// Native folder picker (server runs on the user's own machine)
// ---------------------------------------------------------------------------

function pickFolderNative() {
  return new Promise((resolve) => {
    let file, sargs;
    if (process.platform === 'win32') {
      file = 'powershell.exe';
      sargs = ['-NoProfile', '-STA', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select project folder'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"];
    } else if (process.platform === 'darwin') {
      file = 'osascript';
      sargs = ['-e', 'POSIX path of (choose folder with prompt "Select project folder")'];
    } else {
      file = 'zenity';
      sargs = ['--file-selection', '--directory', '--title=Select project folder'];
    }
    const child = spawn(file, sargs, { windowsHide: false });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 180000);
    child.on('close', () => { clearTimeout(timer); const p = out.trim(); resolve(p || null); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 10_000_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function authorized(req, url) {
  if (!TOKEN) return true;
  if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/oauth/')) return true;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7)
    : (req.headers['x-easy-mcp-token'] || url.searchParams.get('token') || req._pathToken || '');
  return given === TOKEN;
}

function dashboardData() {
  const q = TOKEN ? `?token=${TOKEN}` : '';
  return {
    status: 'online',
    project: projectRoot,
    recentProjects,
    readOnly: READ_ONLY,
    disableShell: DISABLE_SHELL,
    skipJail: SKIP_JAIL,
    toolsCount: TOOLS.length,
    toolNames: TOOLS.map(t => t.name),
    sseSessions: sseSessions.size,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    totalCalls,
    totalErrors,
    jobs: [...jobs.values()].map(j => ({ id: j.id, command: j.command, status: j.status, startedAt: j.startedAt })),
    publicUrl: publicUrl || null,
    tunnelMode,
    tunnelError: tunnelError || null,
    mcpUrl: publicUrl ? `${publicUrl}/mcp${TOKEN ? '/' + TOKEN : ''}` : null,
    dashboardUrl: publicUrl ? `${publicUrl}/${q}` : null,
    recentCalls
  };
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Easy MCP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700;900&family=Cinzel:wght@600;700;900&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark light;
    --bg: #0d0c0a;
    --card: #151311;
    --card-elevated: #1a1715;
    --border: #29241f;
    --border-hover: #423930;
    --text: #f5f0eb;
    --muted: #96897b;
    --gold: #f59e0b;
    --flame: #ea580c;
    --flame-dark: #9a2c04;
    --ok: #22c55e;
    --err: #ef4444;
    --accent-glow: rgba(234, 88, 12, 0.18);
    --gold-glow: rgba(245, 158, 11, 0.15);
    --input-bg: #100f0d;
    --radius: 14px;
    --radius-sm: 8px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #faf7f2;
      --card: #ffffff;
      --card-elevated: #fcfbfa;
      --border: #e8e0d5;
      --border-hover: #cbbfb0;
      --text: #1d1916;
      --muted: #847566;
      --input-bg: #f5f0e8;
      --accent-glow: rgba(234, 88, 12, 0.08);
      --gold-glow: rgba(245, 158, 11, 0.08);
    }
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
    padding: 36px 20px 60px;
    background-image: 
      radial-gradient(ellipse 60% 40% at 50% -10%, rgba(234, 88, 12, 0.12), transparent 70%),
      radial-gradient(circle at 10% 20%, rgba(245, 158, 11, 0.04), transparent 40%);
  }

  .container {
    max-width: 960px;
    margin: 0 auto;
  }

  /* Hero Section */
  .hero {
    text-align: center;
    padding: 10px 0 32px;
    position: relative;
  }
  .hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--gold);
    box-shadow: 0 2px 10px var(--gold-glow);
    margin-bottom: 14px;
  }
  .hero-badge .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok);
    animation: pulse 2.2s infinite ease-in-out;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }

  /* Mortal Kombat Inspired Title */
  .logo-mk {
    font-family: 'Cinzel Decorative', 'Cinzel', serif;
    font-size: 42px;
    font-weight: 900;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    background: linear-gradient(180deg, #FFF7ED 0%, #FDE68A 25%, #F59E0B 55%, #D9480F 82%, #7C1D05 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 4px 18px rgba(217, 72, 15, 0.35));
    line-height: 1.1;
    margin-bottom: 10px;
    position: relative;
    display: inline-block;
  }
  .logo-mk::after {
    content: '';
    position: absolute;
    bottom: -6px;
    left: 20%;
    right: 20%;
    height: 1.5px;
    background: linear-gradient(90deg, transparent, var(--flame), var(--gold), transparent);
  }

  .hero-subtitle {
    font-size: 14.5px;
    font-weight: 500;
    color: var(--muted);
    letter-spacing: 0.02em;
    margin-top: 14px;
  }
  .hero-subtitle strong {
    color: var(--text);
    font-weight: 600;
  }
  .hero-subtitle .glow-text {
    background: linear-gradient(135deg, #F59E0B, #EA580C);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    font-weight: 700;
  }

  /* Grid Layout (Desktop 2-column) */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .span-full {
    grid-column: 1 / -1;
  }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
    .span-full { grid-column: auto; }
    .logo-mk { font-size: 32px; letter-spacing: 0.12em; }
  }

  /* Cards */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 22px;
    transition: all 0.2s ease;
    position: relative;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  }
  .card:hover {
    border-color: var(--border-hover);
    box-shadow: 0 6px 24px var(--accent-glow);
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .card-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card-title svg {
    color: var(--gold);
    width: 14px;
    height: 14px;
  }

  /* Input & Button Groups */
  .input-row {
    display: flex;
    gap: 8px;
  }
  .input-text {
    flex: 1;
    min-width: 0;
    padding: 11px 14px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .input-text:focus {
    border-color: var(--gold);
    box-shadow: 0 0 0 2px var(--gold-glow);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 10px 18px;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 12.5px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--card-elevated);
    color: var(--text);
    transition: all 0.15s ease;
    white-space: nowrap;
    text-decoration: none;
  }
  .btn:hover {
    background: var(--border-hover);
    transform: translateY(-1px);
  }
  .btn-primary {
    background: linear-gradient(135deg, #f59e0b, #d9480f);
    border-color: #d9480f;
    color: #fff;
    box-shadow: 0 2px 10px rgba(217, 72, 15, 0.3);
  }
  .btn-primary:hover {
    background: linear-gradient(135deg, #fbbf24, #ea580c);
    box-shadow: 0 4px 14px rgba(217, 72, 15, 0.45);
  }

  /* Quick Connect Connectors Strip */
  .connectors-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 14px;
  }
  .connector-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 15px;
    border-radius: var(--radius-sm);
    background: var(--card-elevated);
    border: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
    transition: all 0.15s ease;
  }
  .connector-card:hover {
    transform: translateY(-2px);
    border-color: var(--gold);
    box-shadow: 0 4px 14px rgba(0,0,0,0.25);
  }
  .connector-card svg {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }
  .connector-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .connector-info .c-name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.2;
  }
  .connector-info .c-step {
    font-size: 10px;
    color: var(--muted);
    margin-top: 3px;
    letter-spacing: 0.02em;
    font-family: 'JetBrains Mono', monospace;
  }

  /* Recent Projects */
  .recents-label {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin: 16px 0 8px;
  }
  .recent-item {
    display: flex;
    align-items: center;
    width: 100%;
    text-align: left;
    padding: 9px 12px;
    margin-bottom: 5px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .recent-item:hover {
    background: var(--card-elevated);
    border-color: var(--muted);
  }
  .recent-item.active {
    border-color: var(--gold);
    background: rgba(245, 158, 11, 0.08);
  }
  .recent-item .tag {
    margin-left: auto;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #fff;
    padding: 2px 7px;
    background: linear-gradient(135deg, #f59e0b, #ea580c);
    border-radius: 4px;
  }

  /* Toggle Settings */
  .toggle-group {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .toggle-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .toggle-item:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
  .toggle-item:first-child {
    padding-top: 0;
  }
  .toggle-meta .t-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .toggle-meta .t-desc {
    font-size: 11.5px;
    color: var(--muted);
    margin-top: 2px;
  }

  /* Switch */
  .switch {
    position: relative;
    width: 44px;
    height: 24px;
    flex-shrink: 0;
    margin-left: 14px;
  }
  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: var(--border);
    border-radius: 24px;
    transition: background 0.2s ease;
  }
  .slider::before {
    content: '';
    position: absolute;
    width: 18px;
    height: 18px;
    left: 3px;
    bottom: 3px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  .switch input:checked + .slider {
    background: linear-gradient(135deg, var(--gold), var(--flame));
  }
  .switch input:checked + .slider::before {
    transform: translateX(20px);
  }
  .switch.danger input:checked + .slider {
    background: var(--err);
  }

  /* Warning Bar */
  .danger-alert {
    display: none;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--err);
    border-radius: var(--radius);
    padding: 13px 18px;
    font-size: 12.5px;
    color: #fca5a5;
    margin-bottom: 16px;
    line-height: 1.5;
  }

  /* Telemetry Grid */
  .telemetry-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    text-align: center;
  }
  .telemetry-col {
    padding: 6px 12px;
  }
  .telemetry-col:not(:last-child) {
    border-right: 1px solid var(--border);
  }
  .telemetry-val {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .telemetry-lbl {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-top: 3px;
  }

  /* Background jobs */
  .jobs-panel {
    display: none;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th, td {
    padding: 9px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  th {
    color: var(--muted);
    font-weight: 700;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  #msg {
    color: var(--err);
    font-size: 12px;
    margin-top: 6px;
    min-height: 16px;
  }
</style>
</head>
<body>
<div class="container">
  
  <!-- Hero Section -->
  <header class="hero">
    <div class="hero-badge">
      <span class="status-dot"></span>
      <span id="statusLine">INITIALIZING...</span>
    </div>
    <br>
    <div class="logo-mk">EASY MCP</div>
    <p class="hero-subtitle">
      Double your quota with <span class="glow-text">Antigravity</span>, <span class="glow-text">Claude Code</span>, <span class="glow-text">Codex</span> and more
    </p>
  </header>

  <!-- Danger banner if jail disabled -->
  <div class="danger-alert" id="jailWarn">
    <strong>⚠ CRITICAL SECURITY ALERT:</strong> Folder jail is completely disabled (<kbd>--dangerously-skip-jail</kbd>). Connected AI clients have unrestrained read, write, and command execution access to the entire file system.
  </div>

  <div class="grid">

    <!-- Card 1: MCP Tunnel Endpoint & Integrations (Full Width) -->
    <div class="card span-full">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          Direct MCP Tunnel Endpoint
        </div>
        <span style="font-size: 11px; color: var(--muted);" id="stUptime">⏱ Uptime: --</span>
      </div>

      <div class="input-row">
        <input type="text" class="input-text" id="mcpUrl" readonly value="(establishing tunnel...)">
        <button class="btn btn-primary" onclick="copyEl('mcpUrl', this)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy Link
        </button>
      </div>

      <div style="display:flex; align-items:center; gap:10px; margin-top:12px; flex-wrap:wrap;">
        <span style="font-size:12px; color:var(--muted);">Tunnel:</span>
        <div style="display:inline-flex; border:1px solid var(--border); border-radius:10px; overflow:hidden;">
          <button id="tunCloudflare" onclick="setTunnel('cloudflare')" style="padding:7px 14px; font-size:12.5px; border:none; cursor:pointer; background:transparent; color:inherit;">Cloudflare</button>
          <button id="tunFunnel" onclick="setTunnel('funnel')" style="padding:7px 14px; font-size:12.5px; border:none; cursor:pointer; background:transparent; color:inherit;">Tailscale · persistent link</button>
        </div>
        <span id="tunError" style="font-size:12px; color:#e5484d;"></span>
      </div>

      <div class="connectors-strip">
        <!-- Claude Web / Plugins -->
        <a class="connector-card" href="https://claude.ai/plugins" target="_blank" title="Add custom MCP connector to Claude">
          <svg viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="5" fill="#D97757"/><path d="M12 4.5l1.8 5.4h5.7l-4.6 3.4 1.8 5.5-4.7-3.4-4.7 3.4 1.8-5.5-4.6-3.4h5.7z" fill="#FFF"/></svg>
          <div class="connector-info">
            <span class="c-name">Claude Plugins</span>
            <span class="c-step">Add › Add custom connector</span>
          </div>
        </a>

        <!-- ChatGPT Plugins -->
        <a class="connector-card" href="https://chatgpt.com/plugins" target="_blank" title="Add custom MCP server to ChatGPT">
          <svg viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="5" fill="#10A37F"/><path d="M12 4a8 8 0 0 0-8 8c0 4.42 3.58 8 8 8s8-3.58 8-8a8 8 0 0 0-8-8zm0 2.5a5.5 5.5 0 0 1 5.5 5.5c0 1.25-.42 2.4-1.12 3.33l1.82 1.05a7.5 7.5 0 0 0-6.2-9.88V6.5zm-5.5 5.5a5.5 5.5 0 0 1 3.33-5.06V4.84a7.5 7.5 0 0 0-5.33 7.16h2zm3.33 5.06a5.5 5.5 0 0 1-3.33-5.06H4.5a7.5 7.5 0 0 0 9.77 7.02l-1.05-1.82a5.47 5.47 0 0 1-3.39-.14z" fill="#FFF"/></svg>
          <div class="connector-info">
            <span class="c-name">ChatGPT Plugins</span>
            <span class="c-step">Add › Add custom MCP server</span>
          </div>
        </a>

        <!-- Gemini Connectors -->
        <a class="connector-card" href="https://gemini.google.com/customize/connectors" target="_blank" title="Add connector to Gemini">
          <svg viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="5" fill="#1E293B"/><path d="M12 3C12 7.97 7.97 12 3 12C7.97 12 12 16.03 12 21C12 16.03 16.03 12 21 12C16.03 12 12 7.97 12 3Z" fill="url(#geminiGrad)"/><defs><linearGradient id="geminiGrad" x1="3" y1="3" x2="21" y2="21"><stop stop-color="#4285F4"/><stop offset="0.5" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs></svg>
          <div class="connector-info">
            <span class="c-name">Gemini Connectors</span>
            <span class="c-step">Add connector</span>
          </div>
        </a>
      </div>
    </div>

    <!-- Card 2: Active Workspace (Left Column) -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Active Project Workspace
        </div>
      </div>

      <div class="input-row">
        <input type="text" class="input-text" id="projectPath" placeholder="C:\\path\\to\\project" onkeydown="if(event.key==='Enter') setProject()">
        <button class="btn" id="pickBtn" onclick="pickFolder(this)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>
          Browse
        </button>
      </div>

      <div class="recents-label">Recent Workspaces</div>
      <div id="recent"></div>
      <div id="msg"></div>
    </div>

    <!-- Card 3: Security & Policies (Right Column) -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Security & Access Policies
        </div>
      </div>

      <div class="toggle-group">
        <div class="toggle-item">
          <div class="toggle-meta">
            <div class="t-title">Read-Only Mode</div>
            <div class="t-desc">Prohibits all file writes and deletions</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="togReadOnly" onchange="saveSetting('readOnly', this.checked)">
            <span class="slider"></span>
          </label>
        </div>

        <div class="toggle-item">
          <div class="toggle-meta">
            <div class="t-title">Disable Shell Execution</div>
            <div class="t-desc">Blocks terminal commands and child processes</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="togDisableShell" onchange="saveSetting('disableShell', this.checked)">
            <span class="slider"></span>
          </label>
        </div>

        <div class="toggle-item">
          <div class="toggle-meta">
            <div class="t-title" style="color: var(--err);">⚠ Disable Folder Jail</div>
            <div class="t-desc">Allows AI to access the entire filesystem instead of just the project folder. <strong>Dangerous.</strong></div>
          </div>
          <label class="switch danger">
            <input type="checkbox" id="togSkipJail" onchange="toggleJail(this.checked)">
            <span class="slider"></span>
          </label>
        </div>

        <div class="telemetry-col">
          <div class="telemetry-val" id="stErrors">0</div>
          <div class="telemetry-lbl">Errors Encountered</div>
        </div>
        <div class="telemetry-col">
          <div class="telemetry-val" id="stSessions">0</div>
          <div class="telemetry-lbl">Active Sessions</div>
        </div>
        <div class="telemetry-col">
          <div class="telemetry-val" id="stTools">18</div>
          <div class="telemetry-lbl">Registered Tools</div>
        </div>
      </div>
    </div>

    <!-- Card 5: Background Jobs (Conditionally shown) -->
    <div class="card span-full jobs-panel" id="jobsCard">
      <div class="card-header">
        <div class="card-title">Active Background Jobs</div>
      </div>
      <table><tbody id="jobsBody"></tbody></table>
    </div>

    <!-- Share AI Slot promo (dismissible banner, bottom-right) -->
    <div id="slotPromo" style="position:fixed;right:16px;bottom:16px;width:300px;max-width:calc(100vw - 32px);z-index:999;background:var(--card,#171512);border:1px solid rgba(245,158,11,.45);border-radius:14px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.45);">
      <button onclick="closeSlotPromo()" title="Close" style="position:absolute;top:6px;right:10px;background:none;border:none;color:inherit;font-size:16px;cursor:pointer;opacity:.7;">×</button>
      <div style="font-size:14px;font-weight:700;padding-right:18px;">Need a Google family slot or an AI subscription? Got a spare one to sell?</div>
      <div style="margin-top:6px;font-size:12.5px;opacity:.85;">From $1/month, varies by country — every family member gets their own Gemini quota.</div>
      <a href="https://mrkaylabs.github.io/share-ai-slot/" target="_blank" rel="noopener" style="display:inline-block;margin-top:10px;padding:8px 18px;border-radius:999px;background:linear-gradient(90deg,#f59e0b,#ea580c);color:#fff;font-weight:700;text-decoration:none;font-size:13px;">Share AI Slot →</a>
    </div>

  </div>
</div>

<script>
const token = new URLSearchParams(location.search).get('token') || '';
const q = token ? '?token=' + encodeURIComponent(token) : '';

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function copyEl(id, btn){
  const el = document.getElementById(id);
  el.select();
  navigator.clipboard.writeText(el.value).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 1400);
  });
}

async function setTunnel(mode){
  document.getElementById('mcpUrl').value = '(switching tunnel...)';
  await fetch('/api/set-tunnel' + q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  });
  tick();
}

async function setProject(pathOverride){
  const p = pathOverride || document.getElementById('projectPath').value.trim();
  if (!p) return;
  const res = await fetch('/api/set-project' + q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p })
  });
  const d = await res.json();
  document.getElementById('msg').textContent = d.success ? '' : (d.error || 'Failed to update folder');
  tick();
}

async function pickFolder(btn){
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Browsing...';
  document.getElementById('msg').textContent = '';
  try {
    const res = await fetch('/api/pick-folder' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const d = await res.json();
    if (!d.success && d.error !== 'No folder selected') {
      document.getElementById('msg').textContent = d.error || 'Selection failed';
    }
  } catch (e) {
    document.getElementById('msg').textContent = 'Folder picker failed';
  }
  btn.disabled = false;
  btn.innerHTML = orig;
  tick();
}

async function saveSetting(key, value){
  try {
    const body = {};
    body[key] = value;
    await fetch('/api/settings' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    tick();
  } catch (e) {
    console.error('Settings update failed', e);
  }
}

async function toggleJail(checked){
  if (checked) {
    const yes = confirm(
      '⚠ DANGEROUS: This will disable the folder jail.\\n\\n' +
      'Connected AI clients will be able to read, write, and execute commands ANYWHERE on this machine — not just inside the project folder.\\n\\n' +
      'Are you absolutely sure?'
    );
    if (!yes) {
      document.getElementById('togSkipJail').checked = false;
      return;
    }
  }
  await saveSetting('skipJail', checked);
}

async function stopJob(id){
  await fetch('/api/stop-job' + q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  tick();
}

function fmtUptime(s){
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

async function tick(){
  try {
    const res = await fetch('/api/dashboard' + q);
    const d = await res.json();
    
    // Status line in badge
    const badgeParts = ['ONLINE', d.project];
    if (d.readOnly) badgeParts.push('READ-ONLY');
    if (d.disableShell) badgeParts.push('SHELL OFF');
    if (d.skipJail) badgeParts.push('JAIL BYPASSED');
    document.getElementById('statusLine').textContent = badgeParts.join(' · ');

    document.getElementById('jailWarn').style.display = d.skipJail ? 'block' : 'none';
    document.getElementById('togReadOnly').checked = d.readOnly;
    document.getElementById('togDisableShell').checked = d.disableShell;
    document.getElementById('togSkipJail').checked = d.skipJail;

    document.getElementById('mcpUrl').value = d.mcpUrl || '(tunnel starting...)';
    const tc = document.getElementById('tunCloudflare'), tf = document.getElementById('tunFunnel');
    if (tc && tf) {
      const on = 'background:var(--accent, #6c5ce7); color:#fff; font-weight:600;';
      const off = 'background:transparent; color:inherit; font-weight:400;';
      tc.style.cssText += (d.tunnelMode === 'cloudflare' ? on : off);
      tf.style.cssText += (d.tunnelMode === 'funnel' ? on : off);
    }
    const te = document.getElementById('tunError');
    if (te) te.textContent = d.tunnelError || '';
    
    const pp = document.getElementById('projectPath');
    if (document.activeElement !== pp) pp.value = d.project;

    // Recents
    document.getElementById('recent').innerHTML = d.recentProjects.slice(0, 5).map(p =>
      '<button class="recent-item' + (p === d.project ? ' active' : '') + '" onclick="setProject(' + JSON.stringify(p).replace(/"/g, '&quot;') + ')">' +
      esc(p) + (p === d.project ? '<span class="tag">CURRENT</span>' : '') +
      '</button>'
    ).join('');

    // Telemetry
    document.getElementById('stUptime').textContent = '⏱ Uptime: ' + fmtUptime(d.uptimeSec);
    const elCalls = document.getElementById('stCalls'); if (elCalls) elCalls.textContent = d.totalCalls;
    document.getElementById('stErrors').textContent = d.totalErrors;
    document.getElementById('stSessions').textContent = d.sseSessions;
    document.getElementById('stTools').textContent = d.toolsCount;

    // Background jobs
    const jobsCard = document.getElementById('jobsCard');
    jobsCard.style.display = d.jobs.length ? 'block' : 'none';
    document.getElementById('jobsBody').innerHTML = d.jobs.map(j =>
      '<tr><td>' + esc(j.id) + '</td><td><code>' + esc(j.command) + '</code></td><td>' + esc(j.status) + '</td><td>' +
      (j.status === 'running' ? '<button class="btn" style="padding:4px 10px;font-size:11px;" onclick="stopJob(\\'' + j.id + '\\')">Stop</button>' : '') +
      '</td></tr>'
    ).join('');

  } catch (e) {
    document.getElementById('statusLine').textContent = 'SERVER DISCONNECTED';
  }
}

function closeSlotPromo(){
  document.getElementById('slotPromo').style.display = 'none';
}

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;

const oauthCodes = new Map(); // code -> expiry (OAuth mock for Gemini)
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // Token-in-path form: /mcp/<token> (one-paste link, no '?' for strict URL fields)
  const pathTokenMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
  if (pathTokenMatch) {
    req._pathToken = decodeURIComponent(pathTokenMatch[1]);
    url.pathname = '/mcp';
  }

  // CORS headers (mandatory for web clients like Gemini Web & Claude Web)
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, x-easy-mcp-token, mcp-protocol-version, mcp-method, mcp-name, *');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, *');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle preflight OPTIONS immediately before auth
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (!authorized(req, url)) {
      if (url.pathname === '/mcp') {
        const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      }
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
      return sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        scopes_supported: ['mcp', 'mcp:read', 'mcp:write'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none']
      });
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
      return sendJson(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header']
      });
    }

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
      const suffix = url.pathname.slice('/.well-known/oauth-protected-resource'.length) || '/mcp';
      return sendJson(res, 200, {
        resource: `${base}${suffix}`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp']
      });
    }

    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      let meta = {};
      try { meta = JSON.parse(await readBody(req) || '{}'); } catch {}
      return sendJson(res, 201, {
        client_id: 'easy-mcp',
        client_secret: TOKEN,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'mcp'
      });
    }

    if (url.pathname === '/oauth/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') || '';
      if (redirectUri) {
        const code = require('crypto').randomBytes(16).toString('hex');
        oauthCodes.set(code, {
          exp: Date.now() + 600000,
          challenge: url.searchParams.get('code_challenge') || '',
          method: url.searchParams.get('code_challenge_method') || 'S256'
        });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (state) target.searchParams.set('state', state);
        const issBase = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
        target.searchParams.set('iss', issBase);
        res.writeHead(302, { Location: target.toString() });
        return res.end();
      }
      return sendJson(res, 200, { status: 'authorized' });
    }

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const raw = await readBody(req);
      const form = new URLSearchParams(raw);
      let secret = form.get('client_secret') || '';
      const basic = req.headers.authorization || '';
      if (!secret && basic.startsWith('Basic ')) {
        try { secret = Buffer.from(basic.slice(6), 'base64').toString().split(':').slice(1).join(':'); } catch {}
      }
      const grantType = form.get('grant_type') || 'authorization_code';
      if (grantType === 'refresh_token') {
        if ((form.get('refresh_token') || '') !== TOKEN) {
          return sendJson(res, 401, { error: 'invalid_grant', error_description: 'Unknown refresh token' });
        }
        return sendJson(res, 200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: TOKEN, scope: 'mcp' });
      }
      const code = form.get('code') || '';
      const rec = oauthCodes.get(code);
      const codeOk = !!rec && rec.exp > Date.now();
      if (code) oauthCodes.delete(code);
      let pkceOk = false;
      if (codeOk && rec.challenge) {
        const verifier = form.get('code_verifier') || '';
        if (verifier) {
          const computed = rec.method === 'plain'
            ? verifier
            : require('crypto').createHash('sha256').update(verifier).digest('base64url');
          pkceOk = computed === rec.challenge;
        }
      }
      if (!codeOk || (secret !== TOKEN && !pkceOk)) {
        return sendJson(res, 401, { error: 'invalid_client', error_description: 'Client secret or PKCE verifier mismatch' });
      }
      return sendJson(res, 200, {
        access_token: TOKEN,
        token_type: 'Bearer',
        expires_in: 86400,
        refresh_token: TOKEN,
        scope: 'mcp'
      });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(DASHBOARD_HTML);
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return sendJson(res, 200, dashboardData());
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const d = dashboardData();
      return sendJson(res, 200, { status: d.status, project: d.project, toolsCount: d.toolsCount, sseSessions: d.sseSessions, uptimeSec: d.uptimeSec });
    }
    if (req.method === 'POST' && url.pathname === '/api/set-project') {
      const { path: p } = JSON.parse(await readBody(req) || '{}');
      try { setProject(p); return sendJson(res, 200, { success: true, project: projectRoot }); }
      catch (err) { return sendJson(res, 400, { success: false, error: err.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      const picked = await pickFolderNative();
      if (!picked) return sendJson(res, 200, { success: false, error: 'No folder selected' });
      try { setProject(picked); return sendJson(res, 200, { success: true, project: projectRoot }); }
      catch (err) { return sendJson(res, 400, { success: false, error: err.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/set-tunnel') {
      const { mode } = JSON.parse(await readBody(req) || '{}');
      try {
        await setTunnel(mode);
        return sendJson(res, 200, { success: !tunnelError, tunnelMode, publicUrl: publicUrl || null, error: tunnelError || null });
      } catch (err) {
        return sendJson(res, 200, { success: false, tunnelMode, error: err.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/set-public-url') {
      const { url: u } = JSON.parse(await readBody(req) || '{}');
      const clean = String(u || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\//.test(clean)) return sendJson(res, 400, { success: false, error: 'url must be https://...' });
      publicUrl = clean;
      return sendJson(res, 200, { success: true, publicUrl });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(res, 200, { readOnly: READ_ONLY, disableShell: DISABLE_SHELL, skipJail: SKIP_JAIL });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.readOnly === 'boolean') READ_ONLY = body.readOnly;
      if (typeof body.disableShell === 'boolean') DISABLE_SHELL = body.disableShell;
      if (typeof body.skipJail === 'boolean') SKIP_JAIL = body.skipJail;
      return sendJson(res, 200, { success: true, readOnly: READ_ONLY, disableShell: DISABLE_SHELL, skipJail: SKIP_JAIL });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop-job') {
      const { id } = JSON.parse(await readBody(req) || '{}');
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { success: false, error: 'Unknown job' });
      try { process.kill(job.pid); } catch {}
      job.status = 'stopped';
      return sendJson(res, 200, { success: true });
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      const { name, arguments: toolArgs } = JSON.parse(await readBody(req) || '{}');
      try { return sendJson(res, 200, { success: true, result: await callTool(name, toolArgs) }); }
      catch (err) { return sendJson(res, 200, { success: false, error: err.message }); }
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const raw = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const isInit = messages.some(m => m && m.method === 'initialize');
      let sessionId = req.headers['mcp-session-id'];
      if (isInit) {
        sessionId = crypto.randomBytes(16).toString('hex');
        mcpSessions.set(sessionId, { createdAt: Date.now() });
      }
      const outs = [];
      for (const m of messages) {
        const out = await handleRpc(m);
        if (out) outs.push(out);
      }
      if (!outs.length) { res.writeHead(202); return res.end(); }
      const payload = Array.isArray(parsed) ? outs : outs[0];
      const sseId = url.searchParams.get('sessionId') || sessionId;
      const sseRes = sseId && sseSessions.get(sseId);
      if (sseRes) { try { sseRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`); } catch {} }
      const body = JSON.stringify(payload);
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      res.writeHead(200, headers);
      return res.end(body);
    }
    if (url.pathname === '/mcp' && req.method === 'GET') {
      const accept = req.headers.accept || '';
      if (!accept.includes('text/event-stream')) {
        // Plain GET (e.g. URL validators): answer with a JSON status, like the original bridge.
        return sendJson(res, 200, {
          status: 'online',
          service: 'Easy MCP',
          protocolVersion: '2025-03-26',
          toolsCount: TOOLS.length,
          tools: TOOLS.map(t => t.name)
        });
      }
      // Legacy SSE transport: pad to flush proxy buffers, then send the endpoint event.
      if (req.socket) { req.socket.setKeepAlive(true, 10000); req.socket.setNoDelay(true); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const sseId = crypto.randomBytes(16).toString('hex');
      const endpointUri = `${proto}://${host}/mcp?sessionId=${sseId}&token=${TOKEN}`;
      res.write(`: ${' '.repeat(2048)}\n\n`);
      res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);
      sseSessions.set(sseId, res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); res.write('event: ping\ndata: {}\n\n'); } catch {} }, 15000);
      const cleanup = () => { clearInterval(ping); sseSessions.delete(sseId); };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }
    if (url.pathname === '/mcp' && req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId) mcpSessions.delete(sessionId);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = crypto.randomBytes(8).toString('hex');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sseSessions.set(sessionId, res);
      const q = TOKEN ? `?token=${TOKEN}&sessionId=${sessionId}` : `?sessionId=${sessionId}`;
      res.write(`event: endpoint\ndata: /messages${q}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseSessions.delete(sessionId); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const sse = sseSessions.get(sessionId);
      const msg = JSON.parse(await readBody(req) || '{}');
      const out = await handleRpc(msg);
      if (out && sse) sse.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — Easy MCP may already be running. Stop the old instance or use --port <n>.`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Easy MCP server on http://127.0.0.1:${PORT} — project: ${projectRoot}`);
  startTunnel(tunnelMode).catch(err => { tunnelError = err.message; });
  if (SKIP_JAIL) console.log('WARNING: --dangerously-skip-jail is ON. The AI can access the whole machine.');
});
