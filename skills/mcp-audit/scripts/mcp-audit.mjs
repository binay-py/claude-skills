#!/usr/bin/env node
// mcp-audit — what do your MCP servers cost you, and which ones do you actually use?
// Finds every MCP server Claude Code can load (user + local scope in ~/.claude.json, project .mcp.json files,
// installed plugins), counts how often each was called in your session logs, and flags unused servers,
// duplicates, missing binaries and literal secrets in config. Never prints secret values.
// Zero dependencies. Node 22+. Read-only.
//
//   node mcp-audit.mjs                     inventory + usage over the last 30 days
//   node mcp-audit.mjs --days 90
//   node mcp-audit.mjs --root ~/code       also look for .mcp.json files under these folders (repeatable, depth 4)
//   node mcp-audit.mjs --measure           START each server (stdio: runs its command; http: POSTs to its url) and
//                                          size its tools/list. This executes configured commands. Opt-in only.
//   node mcp-audit.mjs --measure --only memory,git --timeout 20000
//   node mcp-audit.mjs --json              machine-readable output
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const DAYS = Number(opt('days', 30)), MEASURE = argv.includes('--measure'), JSON_OUT = argv.includes('--json');
const TIMEOUT = Number(opt('timeout', 10000));
const ONLY = (opt('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const roots = []; for (let i = 0; i < argv.length; i++) if (argv[i] === '--root') roots.push(path.resolve(argv[++i].replace(/^~/, os.homedir())));
const HOME = os.homedir(), CLAUDE = path.join(HOME, '.claude'), WIN = process.platform === 'win32';
const short = p => String(p).replace(HOME, '~').split(path.sep).join('/');
const normPath = p => { let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); return WIN ? s.toLowerCase() : s; };
const under = (child, parent) => { const c = normPath(child), p = normPath(parent); return c === p || c.startsWith(p + '/'); };
const normName = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_'); // Claude Code's tool-name sanitising
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const tok = chars => Math.round(chars / 4);
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

// ---------- secret detection (names + type only, never values) ----------
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'], [/\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}/, 'OpenAI-style key'],
  [/\b[sr]k_live_[0-9a-zA-Z]{16,}/, 'Stripe live key'], [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/, 'GitHub token'], [/\bgithub_pat_[0-9A-Za-z_]{40,}/, 'GitHub token'],
  [/\bglpat-[0-9A-Za-z_-]{20,}/, 'GitLab token'], [/\bxox[abprs]-[0-9A-Za-z-]{10,}/, 'Slack token'], [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bnpm_[0-9A-Za-z]{36}\b/, 'npm token'], [/\bhf_[0-9A-Za-z]{30,}/, 'Hugging Face token'], [/\bntn_[0-9A-Za-z]{30,}/, 'Notion token'],
  [/\blin_api_[0-9A-Za-z]{30,}/, 'Linear key'], [/\bsbp_[0-9a-f]{30,}/, 'Supabase token'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]{3,}@/, 'database URL with password'],
  [/https?:\/\/[^\s:@/]+:[^\s@/]{6,}@/, 'URL with embedded password'],
  [/[?&](?:api[_-]?key|key|token|access_token|secret)=[A-Za-z0-9._~-]{12,}/i, 'key in URL query'],
];
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|APIKEY|PRIVATE|CREDENTIAL|AUTH)/i;
const PLACEHOLDER = /^(<.*>|your[-_ ].*|x{3,}|\*+|changeme|placeholder|todo|none|null|true|false|\d{1,6})$/i;
function secretType(name, value) {
  if (typeof value !== 'string' || !value) return null;
  const stripped = value.replace(/\$\{[^}]*\}/g, '');           // ${VAR} references are the right way
  for (const [re, what] of SECRETS) if (re.test(stripped)) return what;
  if (/^authorization$/i.test(name) && /^(bearer|basic|token)\s+\S{12,}/i.test(stripped.trim())) return 'literal auth header';
  if (name && SECRET_NAME.test(name) && stripped.trim().length >= 12 && !PLACEHOLDER.test(stripped.trim()) && !/^(https?:|[A-Za-z]:[\\/]|\/|~)/.test(stripped)) return 'literal value in a secret-named field';
  return null;
}

// ---------- discovery ----------
const servers = []; // {name, scope, where, project?, plugin?, cfg, key, root?}
const notes = [];
const cj = readJson(path.join(HOME, '.claude.json')) || {};
const userSettings = readJson(path.join(CLAUDE, 'settings.json')) || {};
const projState = cj.projects || {};
const addServer = s => { s.key = s.plugin ? `plugin_${normName(s.plugin)}_${normName(s.name)}` : normName(s.name); servers.push(s); };

for (const [name, cfg] of Object.entries(cj.mcpServers || {})) addServer({ name, scope: 'user', where: '~/.claude.json', cfg });
for (const [p, st] of Object.entries(projState)) for (const [name, cfg] of Object.entries(st.mcpServers || {}))
  addServer({ name, scope: 'local', where: `~/.claude.json → ${short(p)}`, project: p, cfg });

// project .mcp.json: cwd, --root dirs (depth 4), and every project folder Claude Code has opened
const mcpFiles = new Set();
const checkDir = d => { const f = path.join(d, '.mcp.json'); try { if (fs.statSync(f).isFile()) mcpFiles.add(path.resolve(f)); } catch {} };
const SKIP = /^(node_modules|\.git|AppData|Library|\.cache|\.npm|dist|build|\.next|vendor|venv|\.venv|__pycache__|target)$/;
function walk(d, n) { checkDir(d); if (n === 0) return; let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) if (e.isDirectory() && !SKIP.test(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), n - 1); }
checkDir(process.cwd()); for (const r of roots) walk(r, 4); for (const p of Object.keys(projState)) checkDir(p);
const settingsFor = dir => [readJson(path.join(dir, '.claude', 'settings.json')), readJson(path.join(dir, '.claude', 'settings.local.json')), userSettings].filter(Boolean);
for (const f of mcpFiles) {
  const j = readJson(f); if (!j) { notes.push(`${short(f)} is not valid JSON; Claude Code will ignore it`); continue; }
  const dir = path.dirname(f);
  for (const [name, cfg] of Object.entries(j.mcpServers || {})) addServer({ name, scope: 'project', where: short(f), project: dir, cfg });
}

// plugins: installed_plugins.json install paths + claude.ai-synced plugins
const pluginDirs = []; // {id, plugin, dir, scope, projectPath?}
const inst = readJson(path.join(CLAUDE, 'plugins', 'installed_plugins.json'));
for (const [id, list] of Object.entries(inst?.plugins || {})) for (const e of Array.isArray(list) ? list : [list]) if (e?.installPath) pluginDirs.push({ id, plugin: id.split('@')[0], dir: e.installPath, pscope: e.scope, projectPath: e.projectPath });
let syncedAccts = []; try { syncedAccts = fs.readdirSync(path.join(CLAUDE, 'plugins', 'synced'), { withFileTypes: true }).filter(e => e.isDirectory()); } catch {}
for (const acct of syncedAccts) { // plugins Claude Code syncs from your claude.ai account
  const base = path.join(CLAUDE, 'plugins', 'synced', acct.name); let ents = []; try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch {}
  for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) pluginDirs.push({ id: e.name, plugin: e.name, dir: path.join(base, e.name), pscope: 'synced', pref: readJson(path.join(base, e.name + '.meta.json'))?.installation_preference });
}
for (const pd of pluginDirs) {
  const found = {};
  const take = (obj, where) => { if (obj && typeof obj === 'object') for (const [name, cfg] of Object.entries(obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj)) if (cfg && typeof cfg === 'object' && (cfg.command || cfg.url)) found[name] ??= { cfg, where }; };
  const mf = path.join(pd.dir, '.mcp.json'); if (fs.existsSync(mf)) take(readJson(mf), short(mf));
  const pj = readJson(path.join(pd.dir, '.claude-plugin', 'plugin.json'));
  if (pj?.mcpServers) {
    if (typeof pj.mcpServers === 'string') { const f = path.resolve(pd.dir, pj.mcpServers); take(readJson(f), short(f)); }
    else if (Array.isArray(pj.mcpServers)) for (const x of pj.mcpServers) typeof x === 'string' ? take(readJson(path.resolve(pd.dir, x)), short(path.resolve(pd.dir, x))) : take(x, short(pd.dir));
    else take(pj.mcpServers, short(path.join(pd.dir, '.claude-plugin', 'plugin.json')));
  }
  let enabled = pd.pscope === 'synced' ? null : userSettings.enabledPlugins?.[pd.id];
  if (pd.projectPath) { const ps = settingsFor(pd.projectPath).find(s => s.enabledPlugins && pd.id in s.enabledPlugins); if (ps) enabled = ps.enabledPlugins[pd.id]; }
  for (const [name, { cfg, where }] of Object.entries(found)) addServer({ name, scope: 'plugin', where, plugin: pd.plugin, pluginId: pd.id, pref: pd.pref, pluginEnabled: enabled, root: pd.dir, project: pd.projectPath, cfg });
}

// ---------- status (enabled / disabled / pending) ----------
for (const s of servers) {
  const label = s.plugin ? `plugin:${s.plugin}:${s.name}` : s.name;
  if (s.scope === 'user') { const off = Object.entries(projState).filter(([, st]) => (st.disabledMcpServers || []).includes(s.name)).map(([p]) => short(p)); s.status = off.length ? `on (off in ${off.length} project${off.length > 1 ? 's' : ''})` : 'on'; s.offIn = off; }
  else if (s.scope === 'local') s.status = (projState[s.project]?.disabledMcpServers || []).includes(s.name) ? 'off' : 'on';
  else if (s.scope === 'project') {
    const st = Object.entries(projState).find(([p]) => normPath(p) === normPath(s.project))?.[1] || {};
    const sets = settingsFor(s.project);
    if ((st.disabledMcpjsonServers || []).includes(s.name) || sets.some(x => (x.disabledMcpjsonServers || []).includes(s.name))) s.status = 'rejected';
    else if ((st.enabledMcpjsonServers || []).includes(s.name) || sets.some(x => (x.enabledMcpjsonServers || []).includes(s.name) || x.enableAllProjectMcpServers)) s.status = (st.disabledMcpServers || []).includes(s.name) ? 'off' : 'approved';
    else s.status = 'pending approval';
  } else {
    s.status = s.pluginEnabled === false ? 'plugin disabled' : s.pluginEnabled === true ? 'on' : s.pluginEnabled === undefined ? 'plugin not enabled' : `synced${s.pref ? ' (' + s.pref + ')' : ''}`;
    const off = Object.entries(projState).filter(([, st]) => (st.disabledMcpServers || []).includes(label)).map(([p]) => short(p)); if (off.length) s.status += ` (off in ${off.length})`;
  }
  s.active = /^(on|approved)/.test(s.status) || (s.status.startsWith('synced') && !/disabled|not_installed/i.test(s.status));
}

// ---------- transport, binary on PATH, secrets, identity ----------
const expand = (str, extra = {}) => String(str ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, v, def) => extra[v] ?? process.env[v] ?? def ?? '');
const unresolved = (str, extra = {}) => [...String(str ?? '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g)].filter(m => !m[2] && extra[m[1]] === undefined && process.env[m[1]] === undefined).map(m => m[1]);
function which(cmd) {
  if (!cmd) return null;
  const exts = WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean) : [''];
  const tryFile = f => { for (const e of WIN && !path.extname(f) ? ['', ...exts] : ['']) { const p = f + e; try { if (fs.statSync(p).isFile() && (!WIN || e || path.extname(p))) return p; } catch {} } return null; };
  if (/[\\/]/.test(cmd)) return tryFile(path.resolve(cmd));
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) { const r = tryFile(path.join(d, cmd)); if (r) return r; }
  return null;
}
const safeUrl = u => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '(invalid url)'; } };
const isSecretish = a => SECRETS.some(([re]) => re.test(a)) || /^[A-Za-z0-9_+/=-]{32,}$/.test(a);
// reference packages that are demos or were archived by the modelcontextprotocol/servers repo
const ARCHIVED = 'archived reference server (moved to modelcontextprotocol/servers-archived, no longer maintained)';
const KNOWN_PKGS = {
  '@modelcontextprotocol/server-everything': 'this is the MCP protocol TEST server (demo tools), not a real integration',
  ...Object.fromEntries(['github', 'gitlab', 'puppeteer', 'brave-search', 'google-maps', 'slack', 'postgres', 'sqlite', 'gdrive', 'redis', 'sentry', 'aws-kb-retrieval-server', 'everart'].map(n => [`@modelcontextprotocol/server-${n}`, ARCHIVED])),
};
function describe(s) {
  const c = s.cfg, extra = s.root ? { CLAUDE_PLUGIN_ROOT: s.root } : {};
  s.flags = [];
  s.transport = c.type || (c.url ? 'http' : 'stdio');
  if (s.transport === 'stdio' || c.command) {
    s.transport = 'stdio';
    const cmd = expand(c.command, extra), args = (c.args || []).map(a => expand(a, extra));
    // show the command and the first non-flag argument (usually the package), never anything that looks like a key
    let pkg = args.find(a => !a.startsWith('-')); if (pkg && /[\\/]/.test(pkg) && !pkg.startsWith('@')) pkg = path.basename(pkg); s.target = `${path.basename(cmd)}${pkg && !isSecretish(pkg) ? ' ' + (pkg.length > 50 ? '…' + pkg.slice(-45) : pkg) : ''}`;
    s.identity = 'stdio:' + [path.basename(cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/, ''), ...args].join(' ');
    const known = args.map(a => a.replace(/@[\d.^~]+$/, '')).find(a => KNOWN_PKGS[a]); if (known) s.flags.push(KNOWN_PKGS[known]);
    s.resolved = which(cmd);
    if (!s.resolved) s.flags.push(`command "${path.basename(cmd)}" not found${/[\\/]/.test(cmd) ? '' : ' on PATH'}`);
    const un = [...unresolved(c.command, extra), ...(c.args || []).flatMap(a => unresolved(a, extra))]; if (un.length) s.flags.push(`uses unset env var ${un.join(', ')}`);
    for (const [i, a] of (c.args || []).entries()) { const t = secretType('', String(a)) || (i && /^--?(api[-_]?key|token|secret|password)$/i.test(c.args[i - 1]) && secretType('TOKEN', String(a))); if (t) s.flags.push(`secret in args[${i}]: ${t}`); }
  } else {
    s.target = safeUrl(expand(c.url, extra)); s.identity = 'url:' + expand(c.url, extra).replace(/\/+$/, '').toLowerCase();
    const t = secretType('url', c.url || ''); if (t) s.flags.push(`secret in url: ${t}`);
    const un = unresolved(c.url, extra); if (un.length) s.flags.push(`url uses unset env var ${un.join(', ')}`);
  }
  for (const [k, v] of Object.entries(c.env || {})) { const t = secretType(k, String(v)); if (t) s.flags.push(`literal secret in env ${k} (${t})`); }
  for (const [k, v] of Object.entries(c.headers || {})) { const t = secretType(k, String(v)); if (t) s.flags.push(`literal secret in header ${k} (${t})`); }
}
servers.forEach(describe);
// duplicates. Same name in several scopes: only one loads (local > project > user), the rest is clutter.
// Same command/url under a DIFFERENT name: both start and both tool lists load.
const where2 = o => `${o.scope}${o.project ? ' ' + short(o.project).split('/').slice(-1)[0] : ''}`;
const byId = new Map(); for (const s of servers) { const l = byId.get(s.identity) || []; l.push(s); byId.set(s.identity, l); }
for (const list of byId.values()) if (list.length > 1) for (const s of list) {
  const other = list.filter(o => o !== s && o.name !== s.name && (!s.project || !o.project || normPath(o.project) === normPath(s.project) || o.scope === 'user' || s.scope === 'user'));
  if (other.length) s.flags.push(`same server as ${other.slice(0, 3).map(o => `"${o.name}" (${where2(o)})`).join(', ')}: loads twice`);
}
for (const s of servers) {
  const same = servers.filter(o => o !== s && o.name === s.name && o.scope !== 'plugin' && s.scope !== 'plugin' && (o.scope === 'user' || s.scope === 'user' || normPath(o.project) === normPath(s.project)));
  if (!same.length) continue;
  const identical = same.every(o => o.identity === s.identity);
  if (s.scope === 'user') s.flags.push(`also defined in ${same.map(where2).join(', ')}${identical ? ' (identical)' : ' (different config)'}; that copy wins there`);
  else s.flags.push(`${identical ? 'identical to' : 'overrides'} the user-scope "${s.name}"${identical ? ': redundant' : ''}`);
}

// ---------- usage from session logs ----------
const since = Date.now() - DAYS * 864e5;
const usage = new Map(); // key -> {calls, last, cwds: Map}
const PROJ = path.join(CLAUDE, 'projects');
const logFiles = [];
(function rec(d) { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) logFiles.push(p); } catch {} } } })(PROJ);
for (const file of logFiles) {
  let cwd = '';
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!cwd) { const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/); if (m) cwd = JSON.parse(`"${m[1]}"`); }
    if (!line.includes('"mcp__')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN; if (ts < since) continue;
    for (const c of d.message.content) {
      if (c?.type !== 'tool_use' || typeof c.name !== 'string' || !c.name.startsWith('mcp__')) continue;
      const rest = c.name.slice(5), i = rest.indexOf('__'); const key = i > 0 ? rest.slice(0, i) : rest;
      const u = usage.get(key) || { calls: 0, last: 0, cwds: new Map() }; u.calls++; if (ts > u.last) u.last = ts;
      const w = d.cwd || cwd; u.cwds.set(w, (u.cwds.get(w) || 0) + 1); usage.set(key, u);
    }
  }
}
for (const s of servers) {
  const u = usage.get(s.key);
  if (!u) { s.calls = 0; continue; }
  if (s.scope === 'local' || s.scope === 'project' || (s.scope === 'plugin' && s.project)) { s.calls = 0; for (const [w, n] of u.cwds) if (under(w, s.project)) s.calls += n; }
  else s.calls = u.calls;
  s.last = u.last; s.usedIn = [...u.cwds.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => short(w || '?'));
}
const configuredKeys = new Set(servers.map(s => s.key));
const logOnly = [...usage.entries()].filter(([k]) => !configuredKeys.has(k)).sort((a, b) => b[1].calls - a[1].calls);

// ---------- optional: measure tools/list ----------
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-audit', version: '1.0.0' } } };
const redact = t => { let s = String(t); for (const [re] of SECRETS) s = s.replace(new RegExp(re.source, 'g'), m => m.slice(0, 4) + '…'); return s.replace(/\s+/g, ' ').trim().slice(0, 120); };
// the most useful stderr line: skip stack frames and the "Node.js vX" footer, prefer one that names an error
const errLine = e => { const l = String(e).split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^(at |Node\.js v|\^+$|node:)/.test(x)); return redact(l.find(x => /error|ERR_|not found|cannot|denied|refused/i.test(x)) || l.pop() || ''); };
const quoteWin = a => /^[A-Za-z0-9_\-.:\\/@=+,]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`;
function killTree(child) { try { if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }

function measureStdio(s) {
  return new Promise(resolve => {
    const extra = s.root ? { CLAUDE_PLUGIN_ROOT: s.root } : {};
    const cmd = s.resolved || expand(s.cfg.command, extra), args = (s.cfg.args || []).map(a => expand(a, extra));
    const env = { ...process.env }; for (const [k, v] of Object.entries(s.cfg.env || {})) env[k] = expand(v, extra);
    if (s.root) env.CLAUDE_PLUGIN_ROOT = s.root;
    const cwd = s.root || (s.project && fs.existsSync(s.project) ? s.project : process.cwd());
    let child; const t0 = Date.now();
    try {
      child = WIN && /\.(cmd|bat)$/i.test(cmd) ? spawn([cmd, ...args].map(quoteWin).join(' '), { shell: true, env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        : spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN, windowsHide: true });
    } catch (e) { return resolve({ error: 'spawn failed: ' + redact(e.message) }); }
    let buf = '', err = '', done = false, init = null; const tools = []; let page = 0;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); killTree(child); resolve({ ...r, ms: Date.now() - t0 }); };
    const send = m => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch {} };
    const timer = setTimeout(() => finish({ error: `no ${init ? 'tools/list' : 'initialize'} reply within ${TIMEOUT / 1000}s${err ? ': ' + errLine(err) : ''}`, init }), TIMEOUT);
    child.on('error', e => finish({ error: 'spawn failed: ' + redact(e.message) }));
    child.on('exit', code => setTimeout(() => finish({ error: `exited with code ${code} before answering${err ? ': ' + errLine(err) : ''}`, init }), 50));
    child.stdin.on('error', () => {}); child.stdout.on('error', () => {});
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; } // servers sometimes log to stdout
        if (m.id === 1) {
          if (m.error) return finish({ error: 'initialize error: ' + redact(m.error.message) });
          init = m.result || {}; send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (typeof m.id === 'number' && m.id >= 2) {
          if (m.error) return finish({ init, tools, error: 'tools/list error: ' + redact(m.error.message) });
          tools.push(...(m.result?.tools || []));
          if (m.result?.nextCursor && page++ < 20) send({ jsonrpc: '2.0', id: 3 + page, method: 'tools/list', params: { cursor: m.result.nextCursor } });
          else return finish({ init, tools });
        } else if (m.method && m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} }); // answer server->client requests (ping, roots) minimally
      }
    });
    send(INIT);
  });
}

async function postRpc(url, headers, body, session) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers };
  if (session) h['mcp-session-id'] = session;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctl.signal });
    const sid = r.headers.get('mcp-session-id') || session;
    if (body.id === undefined) { r.body?.cancel().catch(() => {}); return { status: r.status, sid }; }
    if (!r.ok) { r.body?.cancel().catch(() => {}); return { status: r.status, sid, auth: r.status === 401 || r.status === 403 || !!r.headers.get('www-authenticate') }; }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) { // read SSE events until the response with our id arrives
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let k; while ((k = buf.search(/\r?\n\r?\n/)) >= 0) {
          const ev = buf.slice(0, k); buf = buf.slice(k).replace(/^\r?\n\r?\n/, '');
          const data = ev.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          try { const m = JSON.parse(data); if (m.id === body.id) { reader.cancel().catch(() => {}); return { status: r.status, sid, msg: m }; } } catch {}
        }
      }
      return { status: r.status, sid, error: 'stream ended without a response' };
    }
    return { status: r.status, sid, msg: await r.json() };
  } catch (e) { return { error: e.name === 'AbortError' ? `no reply within ${TIMEOUT / 1000}s` : redact(e.cause?.code || e.message) }; }
  finally { clearTimeout(timer); }
}
async function measureHttp(s) {
  const extra = s.root ? { CLAUDE_PLUGIN_ROOT: s.root } : {}, url = expand(s.cfg.url, extra), t0 = Date.now();
  const headers = Object.fromEntries(Object.entries(s.cfg.headers || {}).map(([k, v]) => [k, expand(v, extra)]));
  const a = await postRpc(url, headers, INIT);
  if (a.auth) return { auth: true, error: `HTTP ${a.status}: needs auth (OAuth tokens live in Claude Code's credential store), not measured` };
  if (a.error || !a.msg) return { error: a.error || `HTTP ${a.status}` };
  if (a.msg.error) return { error: 'initialize error: ' + redact(a.msg.error.message) };
  await postRpc(url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, a.sid);
  const tools = []; let cursor, id = 2;
  do {
    const b = await postRpc(url, headers, { jsonrpc: '2.0', id: id++, method: 'tools/list', params: cursor ? { cursor } : {} }, a.sid);
    if (b.auth) return { auth: true, init: a.msg.result, error: `HTTP ${b.status} on tools/list: needs auth, not measured` };
    if (b.error || !b.msg || b.msg.error) return { init: a.msg.result, error: b.error || redact(b.msg?.error?.message || `HTTP ${b.status}`) };
    tools.push(...(b.msg.result?.tools || [])); cursor = b.msg.result?.nextCursor;
  } while (cursor && id < 22);
  return { init: a.msg.result, tools, ms: Date.now() - t0 };
}

if (MEASURE) {
  // Only servers Claude Code would start anyway. Unapproved/rejected .mcp.json entries and disabled plugins are skipped
  // unless named with --only: a cloned repo's .mcp.json is untrusted until you approve it.
  for (const s of servers) {
    s.mkey = s.identity + '|' + JSON.stringify(s.cfg.env || {}) + JSON.stringify(s.cfg.headers || {});
    if (s.flags.some(f => f.includes('not found'))) s.measure = { error: 'command not found, not started' };
    else if (ONLY.length && !ONLY.includes(s.name)) s.measure = null;
    else if (!ONLY.length && !s.active) s.measure = { error: `${s.status}: not started (name it with --only to measure anyway)` };
  }
  const targets = servers.filter(s => s.measure === undefined);
  const seen = new Set();
  if (!JSON_OUT) console.error(`--measure: starting ${targets.length} server(s) (runs their configured commands / contacts their urls, ${TIMEOUT / 1000}s timeout each)…`);
  await Promise.all(targets.map(async s => {
    if (seen.has(s.mkey)) { s.measure = { sameAs: true }; return; } seen.add(s.mkey);
    const r = s.transport === 'stdio' ? await measureStdio(s) : s.transport === 'sse' ? { error: 'legacy SSE transport: not measured' } : await measureHttp(s);
    if (r.tools) {
      const full = JSON.stringify(r.tools).length, instr = (r.init?.instructions || '').length;
      r.count = r.tools.length; r.fullTokens = tok(full + instr); r.upfrontTokens = tok(r.tools.reduce((n, t) => n + String(t.name).length + 12, 0) + instr + s.key.length * r.tools.length);
      r.biggest = r.tools.map(t => [t.name, JSON.stringify(t).length]).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, c]) => `${n} ~${fmt(tok(c))}`);
      r.server = r.init?.serverInfo ? `${r.init.serverInfo.name} ${r.init.serverInfo.version || ''}`.trim() : ''; delete r.tools;
    }
    delete r.init; s.measure = r;
  }));
  for (const s of servers) if (s.measure?.sameAs) { const o = servers.find(x => x.mkey === s.mkey && x.measure && !x.measure.sameAs); s.measure = o ? { ...o.measure } : null; }
}

// ---------- report ----------
const tsEnv = process.env.ENABLE_TOOL_SEARCH ?? userSettings.env?.ENABLE_TOOL_SEARCH;
const toolSearchOff = tsEnv === 'false' || tsEnv === '0';
const rows = servers.slice().sort((a, b) => (b.active - a.active) || (a.calls - b.calls) || a.name.localeCompare(b.name));
const loc = s => s.scope === 'local' || (s.scope === 'project') ? `${s.scope} (${short(s.project).split('/').slice(-1)[0] || '~'})` : s.scope === 'plugin' ? `plugin ${s.plugin}` : s.scope;
const tokCell = s => !s.measure ? (MEASURE ? 'skipped' : '–') : s.measure.count != null ? `${s.measure.count} tools · ~${fmt(s.measure.fullTokens)} · ${(s.measure.ms / 1000).toFixed(1)}s` : s.measure.auth ? 'needs auth' : /not started/.test(s.measure.error) ? 'not started' : 'failed';

if (JSON_OUT) {
  console.log(JSON.stringify({ days: DAYS, logFiles: logFiles.length, toolSearch: toolSearchOff ? 'off' : 'on (default)', servers: rows.map(s => ({ name: s.name, scope: s.scope, where: s.where, project: s.project ? short(s.project) : undefined, plugin: s.pluginId, transport: s.transport, target: s.target, status: s.status, calls: s.calls, lastUsed: s.last ? new Date(s.last).toISOString().slice(0, 10) : null, usedIn: s.usedIn, flags: s.flags, measure: s.measure })), seenInLogsOnly: logOnly.map(([k, u]) => ({ server: k, calls: u.calls })), notes }, null, 2));
  process.exit(0);
}

console.log(`mcp-audit: ${servers.length} configured MCP server entr${servers.length === 1 ? 'y' : 'ies'} · usage from ${logFiles.length} session log(s) in the last ${DAYS} days${MEASURE ? '' : ' · run with --measure to size tool lists'}\n`);
const table = [['Server', 'Scope', 'Transport', 'Status', `Calls ${DAYS}d`, 'Tools · est. tokens', 'Flags']];
for (const s of rows) table.push([s.name, loc(s), `${s.transport}: ${s.target}`, s.status, String(s.calls) + (s.calls && s.last ? ` (last ${new Date(s.last).toISOString().slice(5, 10)})` : ''), tokCell(s), s.flags.join('; ') || '']);
const W = table[0].map((_, i) => Math.min(i === 6 ? 70 : i === 2 ? 44 : i === 1 ? 40 : 32, Math.max(...table.map(r => r[i].length))));
const cell = (t, w) => (t.length > w ? t.slice(0, w - 1) + '…' : t).padEnd(w);
for (const [i, r] of table.entries()) { console.log(r.map((c, j) => cell(c, W[j])).join('  ').trimEnd()); if (!i) console.log(W.map(w => '-'.repeat(w)).join('  ')); }
const longFlags = rows.filter(s => s.flags.join('; ').length > W[6]);
if (longFlags.length) { console.log('\nFull flags:'); for (const s of longFlags) console.log(`  ${s.name} (${loc(s)}): ${s.flags.join('; ')}`); }
if (MEASURE) { const m = rows.filter(s => s.measure && s.measure.count == null); if (m.length) { console.log('\nNot measured:'); for (const s of m) console.log(`  ${s.name} (${loc(s)}): ${s.measure.error}`); } }
if (logOnly.length) console.log(`\nCalled in logs but not in local config (claude.ai connectors, built-ins like claude-in-chrome, or since-removed servers):\n  ${logOnly.map(([k, u]) => `${k} ${u.calls}`).join(' · ')}`);
for (const n of notes) console.log(`\nnote: ${n}`);

// recommendations
const tips = [];
const unused = rows.filter(s => s.active && !s.calls && !s.flags.some(f => f.includes(': redundant')));
const rmCmd = s => s.scope === 'user' ? `claude mcp remove ${s.name} -s user` : s.scope === 'local' ? `cd "${short(s.project)}" && claude mcp remove ${s.name} -s local` : s.scope === 'project' ? `delete "${s.name}" from ${s.where} (or reject it in /mcp)` : s.status.startsWith('synced') ? `turn off plugin ${s.plugin} in /plugin (synced from your claude.ai account)` : `claude plugin disable ${s.pluginId}`;
if (unused.length) tips.push(`${unused.length} active server(s) had no calls in ${DAYS} days: ${unused.map(s => s.name + (s.scope === 'local' ? ` (local, ${short(s.project).split('/').pop()})` : '')).join(', ')}. Each one is started at every session launch in its scope. Toggle it off in /mcp to keep the config, or remove it:\n${unused.slice(0, 10).map(s => `      ${rmCmd(s)}`).join('\n')}${unused.length > 10 ? `\n      … and ${unused.length - 10} more` : ''}`);
const narrow = rows.filter(s => s.scope === 'user' && s.calls && s.usedIn?.length === 1 && s.usedIn[0] !== '~' && Object.keys(projState).length > 1);
if (narrow.length) tips.push(`Used from only one project but configured for every project: ${narrow.map(s => `${s.name} (only in ${s.usedIn[0]})`).join(', ')}. Move it to local scope there: claude mcp remove <name> -s user, then claude mcp add <name> -s local … from that folder.`);
const missing = rows.filter(s => s.flags.some(f => f.includes('not found')));
if (missing.length) tips.push(`Command missing for ${missing.map(s => s.name).join(', ')}. These fail at every startup (and can hold startup up until the connect timeout). Reinstall the binary or remove the entry.`);
const twice = rows.filter(s => s.flags.some(f => f.includes('loads twice')));
if (twice.length) tips.push(`Same server configured under different names: ${[...new Set(twice.map(s => s.name))].join(', ')}. Both copies start and both tool lists load. Keep one name.`);
const redundant = rows.filter(s => s.flags.some(f => f.includes(': redundant')));
if (redundant.length) tips.push(`${redundant.length} local/project entr${redundant.length > 1 ? 'ies are' : 'y is'} an identical copy of a user-scope server (${[...new Set(redundant.map(s => s.name))].join(', ')}). Only one loads, so the copy does nothing except hide later changes to the user one. Remove the copies (claude mcp remove <name> -s local, run in that project).`);
const secrets = rows.filter(s => s.flags.some(f => f.includes('secret')));
if (secrets.length) tips.push(`Literal secrets in MCP config: ${secrets.map(s => s.name).join(', ')}. Replace the value with a \${ENV_VAR} reference (supported in command, args, env, url and headers) and set the variable in your shell. A project .mcp.json is meant to be committed, so a key there is a leak.`);
const pending = rows.filter(s => s.status === 'pending approval');
if (pending.length) tips.push(`${pending.length} project .mcp.json server(s) were never approved, so they don't load: ${pending.map(s => s.name).join(', ')}.`);
const measured = rows.filter(s => s.measure?.count != null);
if (measured.length) {
  const seenIds = new Set(), uniq = measured.filter(s => !seenIds.has(s.identity) && seenIds.add(s.identity));
  const full = uniq.reduce((n, s) => n + s.measure.fullTokens, 0), up = uniq.reduce((n, s) => n + s.measure.upfrontTokens, 0);
  const heavy = uniq.filter(s => s.measure.fullTokens > 5000).sort((a, b) => b.measure.fullTokens - a.measure.fullTokens);
  tips.push(toolSearchOff
    ? `ENABLE_TOOL_SEARCH is off, so all ${fmt(full)} tokens of tool definitions from the measured servers load into every session.${heavy.length ? ` Biggest: ${heavy.slice(0, 4).map(s => `${s.name} ~${fmt(s.measure.fullTokens)}`).join(', ')}.` : ''}`
    : `Measured servers define ~${fmt(full)} tokens of tools. With tool search on (the default on current models) only tool names and server instructions load at start (~${fmt(up)} tokens); full definitions load when Claude searches for a tool. If you set ENABLE_TOOL_SEARCH=false, or use a model/gateway without tool search, the full ~${fmt(full)} loads every session.${heavy.length ? ` Heaviest: ${heavy.slice(0, 4).map(s => `${s.name} ~${fmt(s.measure.fullTokens)}`).join(', ')}.` : ''}`);
}
console.log('\nWhat to change:'); for (const t of tips.length ? tips : ['Nothing stands out.']) console.log('  • ' + t);
