#!/usr/bin/env node
/*
 * Easy MCP — launcher
 *
 * Starts the MCP server, opens a Cloudflare quick tunnel, and opens the
 * web dashboard in your browser. No terminal UI — everything happens on
 * the web page.
 *
 * Usage:
 *   node easy-mcp.js [project-folder] [--port 9494] [--funnel] [--no-tunnel] [--no-open]
 *                    [--read-only] [--disable-shell] [--token <token>]
 *                    [--dangerously-skip-jail]  (no folder jail: whole machine)
 */
'use strict';

const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
let PORT = Number(argValue('--port', '9494'));
function loadToken() {
  const fromArg = argValue('--token', process.env.EASY_MCP_TOKEN || '');
  if (fromArg) return fromArg;
  const tokenFile = path.join(os.homedir(), '.easy-mcp', 'token');
  if (!args.includes('--rotate-token')) {
    try {
      const saved = fs.readFileSync(tokenFile, 'utf8').trim();
      if (/^[0-9a-f]{32,}$/.test(saved)) return saved;
    } catch {}
  }
  const fresh = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, fresh + '\n', { mode: 0o600 });
  } catch {}
  return fresh;
}
const TOKEN = loadToken();
const NO_TUNNEL = args.includes('--no-tunnel');
const TUNNEL_MODE = NO_TUNNEL ? 'none' : args.includes('--funnel') ? 'funnel' : args.includes('--cloudflare') ? 'cloudflare' : '';
const NO_OPEN = args.includes('--no-open');
const projectArg = args.find(a => !a.startsWith('--') && a !== argValue('--port', '') && a !== argValue('--token', ''));
const SKIP_JAIL = args.includes('--dangerously-skip-jail');
const projectDir = path.resolve(projectArg || (SKIP_JAIL ? path.parse(process.cwd()).root : process.cwd()));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, cmdArgs, () => {});
}

function findFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port, left) => {
      const srv = require('net').createServer();
      srv.once('error', () => { if (left > 0) tryPort(port + 1, left - 1); else resolve(start); });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort(start, 20);
  });
}

function killOldInstances() {
  // One Easy MCP at a time: stop any previous server/tunnel from an older run.
  try {
    if (process.platform === 'win32') {
      const ps = [
        "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*easy-mcp*server.js*') -or ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*.easy-mcp*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }`,
      ].join('; ');
      spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    } else {
      spawnSync('pkill', ['-f', '^node .*easy-mcp.*server\\.js']);
      spawnSync('pkill', ['-f', 'cloudflared.*\\.easy-mcp']);
      // Kill a node process still listening on our port (relative-path launches).
      const out = spawnSync('ss', ['-tlnp'], { encoding: 'utf8' }).stdout || '';
      for (const line of out.split('\n')) {
        if (!line.includes(`:${PORT} `)) continue;
        const m = line.match(/pid=(\d+)/);
        if (!m) continue;
        try {
          const cmd = fs.readFileSync(`/proc/${m[1]}/cmdline`, 'utf8');
          if (cmd.includes('node')) process.kill(Number(m[1]), 'SIGKILL');
        } catch {}
      }
    }
  } catch {}
}

async function main() {
  killOldInstances();
  await new Promise(r => setTimeout(r, 400));
  PORT = await findFreePort(PORT);
  if (!fs.existsSync(projectDir)) {
    console.error(`Project folder does not exist: ${projectDir}`);
    process.exit(1);
  }

  const serverArgs = [path.join(__dirname, 'server.js')];
  if (args.includes('--read-only')) serverArgs.push('--read-only');
  if (args.includes('--disable-shell')) serverArgs.push('--disable-shell');
  if (SKIP_JAIL) serverArgs.push('--dangerously-skip-jail');
  const server = spawn(process.execPath, serverArgs, {
    env: { ...process.env, EASY_MCP_PORT: String(PORT), EASY_MCP_TOKEN: TOKEN, EASY_MCP_PROJECT: projectDir, ...(TUNNEL_MODE ? { EASY_MCP_TUNNEL: TUNNEL_MODE } : {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => process.stdout.write(d));
  server.stderr.on('data', d => process.stderr.write(d));

  const localDashboard = `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
  console.log(`Project:   ${projectDir}`);
  if (SKIP_JAIL) console.log('WARNING: --dangerously-skip-jail is ON. The AI can read, write and run commands anywhere on this machine.');
  console.log(`Dashboard: ${localDashboard}`);

  if (!NO_OPEN) setTimeout(() => openBrowser(localDashboard), 800);
  console.log('Press Ctrl+C to stop.');

  const stop = () => {
    try { server.kill(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', (code) => process.exit(code ?? 0));
}

main().catch(err => { console.error(err.message); process.exit(1); });
