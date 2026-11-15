#!/usr/bin/env node
// cf-backup: read-only local backups of Cloudflare D1 databases and KV namespaces.
// Zero dependencies. Node 22+. Uses your existing wrangler login (`npx wrangler login`).
//
//   node cf-backup.mjs --dry-run                    what would be backed up (counts only, writes nothing)
//   node cf-backup.mjs [--out ~/cf-backups]         back up every D1 database and KV namespace
//   node cf-backup.mjs --d1 my-db --kv my-ns        only these (names, titles or ids, comma separated)
//   node cf-backup.mjs --keep 5                     then delete older backups this tool made in --out
//   node cf-backup.mjs verify <backupDir>           re-check every sha256 and replay the SQL in SQLite
//   node cf-backup.mjs prune <outDir> --keep 5      local only; touches only folders with a cf-backup manifest
//
// Nothing is ever written to Cloudflare. Restore commands are written to RESTORE.md, never run.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOL = 'cf-backup', FORMAT = 1, VERSION = '1.0.0';
export const NAME_RE = /^cf-backup-\d{8}-\d{6}Z(?:-\d+)?$/;
const isWin = process.platform === 'win32';
const API = 'https://api.cloudflare.com/client/v4';
const MiB = 1048576;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SELF = fileURLToPath(import.meta.url);

// ---------- small helpers ----------
export const human = n => n < 1024 ? `${n} B` : n < MiB ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 * MiB ? `${(n / MiB).toFixed(1)} MiB` : `${(n / 1024 / MiB).toFixed(2)} GiB`;
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
export const safeName = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'x';
const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const short = id => String(id).slice(0, 8) + '…';
// Wrangler and API error text can carry presigned download URLs or tokens. Strip them before printing.
export const redact = s => String(s ?? '').replace(/[[0-9;]*[A-Za-z]/g, '').replace(/https?:\/\/\S+/g, '<url>').replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>')
  .replace(/\s+/g, ' ').trim().slice(0, 300);
// SQLite errors quote tokens from the SQL (`near "alice@x.com"`), which can be row data.
const redactSql = s => redact(s).replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'");
const log = s => console.log(s);
const warn = s => console.log('  ! ' + s);
const step = s => console.log('\n▸ ' + s);
class Fatal extends Error { constructor(msg, code = 1) { super(msg); this.code = code; } }
const die = (msg, code = 1) => { throw new Fatal(msg, code); };

export async function pool(items, n, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run));
}

export function walkFiles(root) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) rec(abs); else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  })(root);
  return out.sort();
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// ---------- git work tree check ----------
// Returns the work tree root that contains `dir` (or would contain it once created), or null.
export function findGitWorkTree(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  for (let x = d; ; x = path.dirname(x)) {
    if (fs.existsSync(path.join(x, '.git'))) return x;
    if (path.dirname(x) === x) break;
  }
  const r = spawnSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}

// ---------- KV entry format ----------
// Each KV namespace is saved as JSON array files, one entry per line, in exactly the shape
// `wrangler kv bulk put` reads: {key, value, base64?, expiration?, metadata?}. Valid UTF-8 values are
// stored as text (a leading BOM is kept); anything else is base64.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function encodeKvEntry({ key, bytes, text, expiration, metadata }) {
  const e = { key };
  if (text !== undefined) e.value = text;
  else {
    let t = null;
    try { t = utf8.decode(bytes); } catch { }
    if (t !== null) e.value = t; else { e.value = Buffer.from(bytes).toString('base64'); e.base64 = true; }
  }
  if (expiration) e.expiration = expiration;
  if (metadata !== undefined && metadata !== null) e.metadata = metadata;
  return e;
}
export function decodeKvEntry(e) {
  if (!e || typeof e.key !== 'string' || typeof e.value !== 'string') throw new Error('entry needs string "key" and "value"');
  const bytes = e.base64 ? Buffer.from(e.value, 'base64') : Buffer.from(e.value, 'utf8');
  if (e.base64 && bytes.toString('base64') !== e.value) throw new Error('value is not canonical base64');
  return { key: e.key, bytes, expiration: e.expiration, metadata: e.metadata };
}
export const parseKvFile = file => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(j)) throw new Error('not a JSON array');
  return j;
};
// wrangler kv bulk put only accepts object metadata; other JSON (a bare string or number) needs the API.
export const bulkPutCompatible = e => e.metadata === undefined || (typeof e.metadata === 'object' && e.metadata !== null);

export class ChunkWriter {
  constructor(dir, prefix, { maxBytes = 64 * MiB, maxEntries = 10000 } = {}) {
    Object.assign(this, { dir, prefix, maxBytes, maxEntries, fd: null, files: [], n: 0, bytes: 0 });
  }
  add(entry) {
    const line = JSON.stringify(entry), len = Buffer.byteLength(line) + 2;
    if (this.fd === null || (this.n > 0 && (this.bytes + len > this.maxBytes || this.n >= this.maxEntries))) this.#rotate();
    fs.writeSync(this.fd, (this.n ? ',\n' : '') + line);
    this.n++; this.bytes += len; this.files.at(-1).entries++;
  }
  #rotate() {
    this.#finish();
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `${this.prefix}-${String(this.files.length + 1).padStart(4, '0')}.json`;
    this.fd = fs.openSync(path.join(this.dir, name), 'w');
    fs.writeSync(this.fd, '[\n');
    this.files.push({ name, entries: 0 }); this.n = 0; this.bytes = 2;
  }
  #finish() { if (this.fd !== null) { fs.writeSync(this.fd, '\n]\n'); fs.closeSync(this.fd); this.fd = null; } }
  close() { this.#finish(); return this.files; }
}

// ---------- SQL checks ----------
const SQL_KEYWORDS = new Set(['PRAGMA', 'CREATE', 'INSERT', 'REPLACE', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'DELETE', 'UPDATE', 'DROP', 'ALTER', 'WITH', 'SELECT', 'ANALYZE', 'VACUUM', 'REINDEX']);
const INSERT_RE = /^(?:INSERT|REPLACE)\s+(?:OR\s+[A-Za-z]+\s+)?INTO\s+("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)/i;
const unquoteIdent = s => /^["`[]/.test(s) ? s.slice(1, -1).replace(/""/g, '"') : s;
// Drop leading whitespace and comments.
export function stripLead(s) {
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) { const i = s.indexOf('\n'); s = i < 0 ? '' : s.slice(i + 1); }
    else if (s.startsWith('/*')) { const i = s.indexOf('*/', 2); s = i < 0 ? '' : s.slice(i + 2); }
    else return s;
  }
}
const isOpenTrigger = stmt => /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(stripLead(stmt))
  && !/\bEND\s*;$/i.test(stmt.replace(/--[^\n]*$/gm, '').trimEnd());

// Streaming statement splitter: quotes ('', "", ``, []), -- and /* */ comments, CREATE TRIGGER ... END;
export class SqlSplitter {
  constructor() { this.buf = ''; this.state = 0; this.prev = ''; } // 0 sql, 1 ' 2 " 3 ` 4 [ 5 -- 6 /*
  push(chunk) {
    const out = [];
    let seg = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      let p = c;
      switch (this.state) {
        case 0:
          if (c === "'") this.state = 1; else if (c === '"') this.state = 2; else if (c === '`') this.state = 3; else if (c === '[') this.state = 4;
          else if (c === '-' && this.prev === '-') this.state = 5;
          else if (c === '*' && this.prev === '/') { this.state = 6; p = ''; }
          else if (c === ';') {
            const stmt = this.buf + chunk.slice(seg, i + 1);
            if (!isOpenTrigger(stmt)) {
              this.buf = ''; seg = i + 1;
              const t = stmt.trim();
              if (stripLead(t).replace(/;$/, '').trim()) out.push(t);
            }
          }
          break;
        case 1: if (c === "'") this.state = 0; break;
        case 2: if (c === '"') this.state = 0; break;
        case 3: if (c === '`') this.state = 0; break;
        case 4: if (c === ']') this.state = 0; break;
        case 5: if (c === '\n') this.state = 0; break;
        case 6: if (c === '/' && this.prev === '*') { this.state = 0; p = ''; } break;
      }
      this.prev = p;
    }
    this.buf += chunk.slice(seg);
    return out;
  }
  end() { return { rest: this.buf, state: this.state }; }
}

let sqliteMod;
async function loadSqlite() {
  if (sqliteMod !== undefined) return sqliteMod;
  // node:sqlite prints an ExperimentalWarning on Node 22; keep every other warning.
  const prev = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', w => { if (!(w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message))) prev.forEach(l => l(w)); });
  try { sqliteMod = await import('node:sqlite'); } catch { sqliteMod = null; }
  return sqliteMod;
}

// Split the file into statements, check each starts with a SQL keyword, count INSERTs per table, and
// (when node:sqlite is available) replay it into an in-memory SQLite database to count real rows.
export async function analyzeSqlFile(file, { sqlite = true } = {}) {
  const res = { statements: 0, inserts: {}, tables: null, rows: null, replayed: false, problems: [] };
  const problem = m => { if (res.problems.length < 10) res.problems.push(m); else if (res.problems.length === 10) res.problems.push('more problems not shown'); };
  const size = fs.statSync(file).size;
  const m = sqlite && size <= 1024 * MiB ? await loadSqlite() : null;
  const db = m?.DatabaseSync ? new m.DatabaseSync(':memory:') : null;
  let pending = '', pendingFrom = 0;
  const onStmt = s => {
    const n = ++res.statements, head = stripLead(s);
    const kw = (head.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
    if (!SQL_KEYWORDS.has(kw)) problem(`statement ${n} doesn't start with a SQL keyword`);
    const ins = head.match(INSERT_RE);
    if (ins) { const t = unquoteIdent(ins[1]); res.inserts[t] = (res.inserts[t] || 0) + 1; }
    if (!db) return;
    const sql = pending + s;
    try { db.exec(sql); pending = ''; }
    catch (e) {
      if (/incomplete input/i.test(e.message)) { if (!pending) pendingFrom = n; pending = sql + '\n'; }
      else { pending = ''; problem(`statement ${n} fails in SQLite: ${redactSql(e.message)}`); }
    }
  };
  const sp = new SqlSplitter();
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: MiB })) for (const s of sp.push(chunk)) onStmt(s);
  const tail = sp.end();
  if (tail.state >= 1 && tail.state <= 4) problem('file ends inside a quoted string or identifier (truncated?)');
  if (tail.state === 6) problem('file ends inside a /* comment */');
  if (stripLead(tail.rest)) problem("text after the last ';' (truncated, or not SQL)");
  if (pending) problem(`statement ${pendingFrom} never completes`);
  if (db) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    res.tables = tables.length; res.rows = {};
    for (const t of tables) res.rows[t] = Number(db.prepare(`SELECT count(*) AS c FROM "${t.replace(/"/g, '""')}"`).get().c);
    res.replayed = true;
    db.close();
  }
  return res;
}

// ---------- manifest, verify ----------
export async function finalizeBackup(dir, manifest) {
  const files = {};
  let total = 0;
  for (const rel of walkFiles(dir)) {
    if (rel === 'manifest.json') continue;
    const abs = path.join(dir, rel), bytes = fs.statSync(abs).size;
    files[rel] = { bytes, sha256: await sha256File(abs) };
    total += bytes;
  }
  manifest.files = files;
  manifest.totalBytes = total;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return m && m.tool === TOOL && typeof m.files === 'object' ? m : null;
  } catch { return null; }
}

export async function verifyBackup(dir, { sqlite = true } = {}) {
  const r = { ok: false, problems: [], warnings: [], files: 0, bytes: 0, d1: [], kv: [] };
  const m = readManifest(dir);
  if (!m) { r.problems.push('no cf-backup manifest.json in this folder'); return r; }
  const actual = new Set(walkFiles(dir).filter(f => f !== 'manifest.json'));
  for (const [rel, want] of Object.entries(m.files)) {
    const abs = path.join(dir, ...rel.split('/'));
    if (!actual.delete(rel)) { r.problems.push(`${rel}: missing`); continue; }
    const bytes = fs.statSync(abs).size;
    if (bytes !== want.bytes) { r.problems.push(`${rel}: size ${bytes} bytes, manifest says ${want.bytes}`); continue; }
    if (await sha256File(abs) !== want.sha256) { r.problems.push(`${rel}: sha256 doesn't match the manifest (changed since the backup)`); continue; }
    r.files++; r.bytes += bytes;
  }
  for (const rel of actual) r.warnings.push(`${rel}: not in the manifest (added after the backup?)`);
  for (const d of m.d1 || []) {
    if (!d.file) continue;
    const abs = path.join(dir, ...d.file.split('/'));
    if (!fs.existsSync(abs)) continue; // already reported
    const a = await analyzeSqlFile(abs, { sqlite });
    const p = a.problems.map(x => `${d.file}: ${x}`);
    if (a.statements !== d.statements) p.push(`${d.file}: ${a.statements} statements, manifest says ${d.statements}`);
    if (a.rows && d.rows) for (const t of new Set([...Object.keys(a.rows), ...Object.keys(d.rows)]))
      if (a.rows[t] !== d.rows[t]) { p.push(`${d.file}: a table has ${a.rows[t] ?? 0} rows after replay, manifest says ${d.rows[t] ?? 0}`); break; }
    r.problems.push(...p);
    r.d1.push({ name: d.name, statements: a.statements, replayed: a.replayed, tables: a.tables, rows: a.rows ? Object.values(a.rows).reduce((x, y) => x + y, 0) : null, ok: !p.length });
  }
  for (const k of m.kv || []) {
    let entries = 0;
    const seen = new Set(), p = [];
    for (const rel of k.files || []) {
      const abs = path.join(dir, ...rel.split('/'));
      if (!fs.existsSync(abs)) continue;
      let arr;
      try { arr = parseKvFile(abs); } catch (e) { p.push(`${rel}: ${e.message}`); continue; }
      arr.forEach((e, i) => {
        try { decodeKvEntry(e); } catch (err) { p.push(`${rel} entry ${i}: ${err.message}`); return; }
        if (seen.has(e.key)) p.push(`${rel} entry ${i}: duplicate key`);
        seen.add(e.key); entries++;
      });
    }
    if (entries !== k.written) p.push(`kv ${k.title}: ${entries} entries in files, manifest says ${k.written}`);
    r.problems.push(...p);
    r.kv.push({ title: k.title, id: k.id, entries, ok: !p.length });
  }
  r.manifest = m;
  r.ok = !r.problems.length;
  return r;
}

// ---------- prune ----------
export function listOwnBackups(outDir) {
  if (!fs.existsSync(outDir)) return [];
  const out = [];
  for (const e of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue; // never a symlink, never a .partial folder
    const dir = path.join(outDir, e.name), m = readManifest(dir);
    if (m && m.name === e.name && m.createdAt) out.push({ dir, name: e.name, manifest: m });
  }
  return out;
}

// Keep the newest `keep` complete backups per account. Delete only older backups (complete or not), so a
// failed run never pushes out a good one.
export function planPrune(backups, keep) {
  const groups = new Map(), del = [];
  for (const b of backups) {
    const k = b.manifest.account?.id || '?';
    groups.set(k, [...(groups.get(k) || []), b]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.name.localeCompare(a.name));
    const complete = list.filter(b => b.manifest.complete);
    if (complete.length <= keep) continue;
    const oldestKept = complete[keep - 1];
    for (const b of list) if (b !== oldestKept && list.indexOf(b) > list.indexOf(oldestKept)) del.push(b);
  }
  return del;
}

export function prune(outDir, keep, { dryRun = false, account } = {}) {
  const root = path.resolve(outDir);
  let own = listOwnBackups(root);
  if (account) own = own.filter(b => b.manifest.account?.id === account);
  const del = planPrune(own, keep);
  for (const b of del) {
    if (path.dirname(path.resolve(b.dir)) !== root || fs.lstatSync(b.dir).isSymbolicLink()) continue;
    if (!dryRun) fs.rmSync(b.dir, { recursive: true, force: true });
  }
  return { own: own.length, deleted: del.map(b => b.name), kept: own.length - del.length };
}

// ---------- wrangler ----------
let WR = null;
function resolveWrangler() {
  if (WR) return WR;
  const cands = [];
  if (process.env.CF_BACKUP_WRANGLER) cands.push(process.env.CF_BACKUP_WRANGLER);
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    cands.push(path.join(d, 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
    if (path.dirname(d) === d) break;
  }
  const g = spawnSync(isWin ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: isWin, windowsHide: true });
  if (g.status === 0 && g.stdout.trim()) cands.push(path.join(g.stdout.trim(), 'wrangler', 'bin', 'wrangler.js'));
  const npx = [path.join(os.homedir(), '.npm', '_npx'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')].filter(Boolean);
  const cached = [];
  for (const root of npx) {
    if (!fs.existsSync(root)) continue;
    for (const h of fs.readdirSync(root)) {
      const p = path.join(root, h, 'node_modules', 'wrangler');
      try { cached.push([JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version, path.join(p, 'bin', 'wrangler.js')]); } catch { }
    }
  }
  cached.sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));
  cands.push(...cached.map(c => c[1]));
  const hit = cands.find(p => fs.existsSync(p));
  if (hit) {
    let version = '?';
    try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(hit), '..', 'package.json'), 'utf8')).version; } catch { }
    // Run wrangler's JS entry with this node, no shell: key names can contain & | % " and must reach wrangler as-is.
    return (WR = { cmd: process.execPath, pre: [hit], shell: false, version });
  }
  return (WR = { cmd: isWin ? 'npx.cmd' : 'npx', pre: ['-y', 'wrangler'], shell: isWin, version: 'npx' });
}
const cmdArg = a => {
  if (!/^[\w.,:@=+/\\ -]*$/.test(a)) throw new Error("an argument can't be passed safely through cmd.exe. Install wrangler (npm i -g wrangler) so cf-backup can run it without a shell");
  return /\s/.test(a) ? `"${a}"` : a;
};
let ACCOUNT_ID = null, LOG_DIR = null;
// wrangler's debug log would keep D1's presigned dump URL in ~/.wrangler/logs: send it to our temp dir instead.
const wranglerEnv = () => ({ ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0', ...(LOG_DIR ? { WRANGLER_LOG_PATH: LOG_DIR } : {}), ...(ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } : {}) });

function runWrangler(args, { cwd, timeoutMs = 60 * 60e3 } = {}) {
  const w = resolveWrangler();
  let argv = [...w.pre, ...args];
  try { if (w.shell) argv = argv.map(cmdArg); } catch (e) { return Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: e.message }); }
  return new Promise(resolve => {
    const ch = spawn(w.cmd, argv, { cwd: cwd || process.cwd(), env: wranglerEnv(), shell: w.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    ch.stdout.on('data', d => out.push(d));
    ch.stderr.on('data', d => err.push(d));
    const t = setTimeout(() => ch.kill(), timeoutMs);
    ch.on('error', e => { clearTimeout(t); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: e.message }); });
    ch.on('close', code => { clearTimeout(t); resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }); });
  });
}
// Only error-looking lines, redacted. withStdout=false for commands whose stdout holds values.
const wErr = (r, withStdout = true) => {
  const text = (r.stderr || '') + '\n' + (withStdout ? r.stdout.toString('utf8') : '');
  const lines = text.split(/\r?\n/).filter(l => /error|✘|failed|not found|denied|unauthori[sz]ed|forbidden|\b429\b|\b5\d\d\b|timed? ?out|ECONN|fetch failed/i.test(l));
  return redact((lines.length ? lines.slice(-4) : text.trim().split(/\r?\n/).slice(-3)).join(' ')) || `exit code ${r.code}`;
};
export function parseJsonOut(s) {
  const i = s.search(/^[[{]/m);
  if (i < 0) throw new Error('no JSON in wrangler output');
  const body = s.slice(i);
  try { return JSON.parse(body); } catch { }
  for (let j = body.length; j > 0; j--) {
    if (body[j - 1] !== ']' && body[j - 1] !== '}') continue;
    try { return JSON.parse(body.slice(0, j)); } catch { }
  }
  throw new Error('could not parse wrangler JSON output');
}
async function wranglerJson(args, opts) {
  const r = await runWrangler(args, opts);
  if (r.code !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')}: ${wErr(r)}`);
  return parseJsonOut(r.stdout.toString('utf8'));
}

// ---------- rate limiting + retries ----------
// Cloudflare allows 1,200 API requests per 5 minutes per user, shared with the dashboard and wrangler.
export class Gate {
  constructor(rps) { this.gap = rps > 0 && Number.isFinite(rps) ? 1000 / rps : 0; this.next = 0; this.until = 0; }
  async wait() {
    for (;;) {
      const now = Date.now(), t = Math.max(this.next, this.until);
      if (t <= now) { this.next = now + this.gap; return; }
      await sleep(t - now);
    }
  }
  pause(ms) { this.until = Math.max(this.until, Date.now() + ms); }
}
const backoff = a => Math.min(60e3, 1000 * 2 ** (a - 1)) * (0.75 + Math.random() * 0.5);
const TRANSIENT = /\b429\b|rate.?limit|too many requests|\b50[0-9]\b|\b52[0-9]\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|other side closed|timed? ?out|reset before export|database is locked|SQLITE_BUSY|internal error|failed to start/i;
async function retrying(fn, { attempts = 6, gate, stats } = {}) {
  for (let a = 1; ; a++) {
    try { return await fn(); } catch (e) {
      if (a >= attempts || !TRANSIENT.test(e.message)) throw e;
      const ms = backoff(a);
      if (/429|rate.?limit|too many/i.test(e.message)) { gate?.pause(ms); if (stats) stats.rateLimited++; }
      if (stats) stats.retries++;
      await sleep(ms);
    }
  }
}

class ApiError extends Error { constructor(status, msg) { super(`HTTP ${status}: ${msg}`); this.status = status; } }
const cfErr = buf => {
  try { const j = JSON.parse(buf.toString('utf8')); return redact((j.errors || []).map(e => `${e.code ? '[' + e.code + '] ' : ''}${e.message}`).join('; ') || 'request failed'); }
  catch { return 'non-JSON response'; }
};

export class CfApi {
  constructor(accountId, headers, gate, stats, refresh, base = API) { Object.assign(this, { accountId, headers, gate, stats, refresh, base, refreshedAt: 0 }); }
  async req(method, p, { body, raw = false } = {}) {
    for (let a = 1; ; a++) {
      await this.gate.wait();
      let res, buf, err;
      try {
        res = await fetch(this.base + p, {
          method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180e3),
          headers: { ...this.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        });
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) { err = e; }
      if (err) {
        if (a >= 8) throw new Error(`network error: ${redact(err.message)}`);
        this.stats.retries++; await sleep(backoff(a)); continue;
      }
      this.stats.requests++;
      const rl = res.headers.get('ratelimit') || '';
      const left = rl.match(/\br=(\d+)/), reset = rl.match(/\bt=(\d+)/);
      if (left && reset && Number(left[1]) <= 10) this.gate.pause(Number(reset[1]) * 1000);
      if (res.status === 401 && this.refresh && Date.now() - this.refreshedAt > 5 * 60e3) {
        this.refreshedAt = Date.now(); this.headers = await this.refresh(); continue; // OAuth tokens expire; wrangler refreshes
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const ms = res.status === 429 && ra > 0 ? ra * 1000 + 500 : backoff(a);
        if (res.status === 429) {
          this.gate.pause(ms); this.stats.rateLimited++;
          if (ms > 10e3) warn(`rate limited by Cloudflare, waiting ${Math.round(ms / 1000)} s`);
        }
        if (a >= 8) throw new ApiError(res.status, cfErr(buf));
        this.stats.retries++; await sleep(ms); continue;
      }
      if (raw) {
        if (res.ok) return buf;
        if (res.status === 404) return null;
        throw new ApiError(res.status, cfErr(buf));
      }
      let j;
      try { j = JSON.parse(buf.toString('utf8')); } catch { throw new ApiError(res.status, 'non-JSON response'); }
      if (!res.ok || j.success === false) throw new ApiError(res.status, cfErr(buf));
      return j;
    }
  }
  async pages(p) {
    const out = [];
    for (let page = 1; page < 1000; page++) {
      const j = await this.req('GET', `${p}${p.includes('?') ? '&' : '?'}page=${page}&per_page=100`);
      const got = j.result || [];
      out.push(...got);
      const tp = j.result_info?.total_pages;
      if (!got.length || (tp ? page >= tp : got.length < 100)) break;
    }
    return out;
  }
}

async function getAuthHeaders() {
  const e = process.env;
  if (e.CLOUDFLARE_API_TOKEN) return { authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}` };
  if (e.CLOUDFLARE_API_KEY && e.CLOUDFLARE_EMAIL) return { 'x-auth-key': e.CLOUDFLARE_API_KEY, 'x-auth-email': e.CLOUDFLARE_EMAIL };
  const j = await wranglerJson(['auth', 'token', '--json']);
  if (j.token) return { authorization: `Bearer ${j.token}` };
  if (j.key && j.email) return { 'x-auth-key': j.key, 'x-auth-email': j.email };
  throw new Error('wrangler auth token gave no usable credentials');
}

// Two ways to read: the REST API (fast; token from your wrangler login, never printed) or wrangler
// subcommands (for --local, or when no token can be had). Both are read-only.
export function apiTransport(api) {
  const a = `/accounts/${api.accountId}`;
  return {
    name: 'REST API (your wrangler login)',
    listD1: async () => (await api.pages(`${a}/d1/database`)).map(d => ({ uuid: d.uuid, name: d.name, file_size: d.file_size })),
    listKv: async () => (await api.pages(`${a}/storage/kv/namespaces`)).map(n => ({ id: n.id, title: n.title })),
    async listKeys(ns) {
      const out = [];
      let cursor = '';
      do {
        const j = await api.req('GET', `${a}/storage/kv/namespaces/${ns.id}/keys?limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
        out.push(...(j.result || []));
        cursor = j.result_info?.cursor || '';
      } while (cursor);
      return out;
    },
    async bulkText(ns, keys) {
      const j = await api.req('POST', `${a}/storage/kv/namespaces/${ns.id}/bulk/get`, { body: { keys, type: 'text' } });
      return new Map(Object.entries(j.result?.values || {}).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v]));
    },
    raw: (ns, key) => api.req('GET', `${a}/storage/kv/namespaces/${ns.id}/values/${encodeURIComponent(key)}`, { raw: true }),
  };
}

function wranglerTransport(o, gate, stats, tmp) {
  const loc = o.local ? ['--local', ...(o['persist-to'] ? ['--persist-to', path.resolve(o['persist-to'])] : [])] : ['--remote'];
  const cwd = o.local ? path.resolve(o.cwd || '.') : tmp;
  const run = async (args, withStdout = true) => {
    if (!o.local) await gate.wait();
    const r = await runWrangler(args, { cwd });
    if (r.code !== 0) throw new Error(wErr(r, withStdout));
    return r.stdout;
  };
  const json = async args => parseJsonOut((await retrying(() => run(args), { gate, stats })).toString('utf8'));
  let n = 0;
  const t = {
    name: o.local ? 'wrangler --local' : 'wrangler subcommands (slower: one process per binary value)',
    loc, cwd,
    listD1: async () => (await json(['d1', 'list', '--json'])).map(d => ({ uuid: d.uuid, name: d.name, file_size: d.file_size })),
    listKv: async () => (await json(['kv', 'namespace', 'list'])).map(x => ({ id: x.id, title: x.title })),
    listKeys: ns => json(['kv', 'key', 'list', '--namespace-id', ns.id, ...loc]),
    async bulkText(ns, keys) {
      const f = path.join(tmp, `keys-${++n}.json`);
      fs.writeFileSync(f, JSON.stringify(keys));
      try {
        const out = await retrying(() => run(['kv', 'bulk', 'get', f, '--namespace-id', ns.id, ...loc], false), { gate, stats });
        const j = parseJsonOut(out.toString('utf8'));
        return new Map(Object.entries(j).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v]));
      } finally { fs.rmSync(f, { force: true }); }
    },
    async raw(ns, key) {
      // yargs reads a leading "-" as a flag, even after "--"; the REST API transport has no such limit.
      if (key.startsWith('-')) throw new Error("wrangler can't read keys that start with '-' (use the API transport)");
      const buf = await retrying(() => run(['kv', 'key', 'get', key, '--namespace-id', ns.id, ...loc], false), { gate, stats });
      // wrangler prints "Value not found" (exit 0) for a missing key; check it really is missing.
      if (/^Value not found\r?\n?$/.test(buf.toString('latin1'))) { const m = await t.bulkText(ns, [key]); if (m.get(key) == null) return null; }
      return buf;
    },
  };
  return t;
}

// ---------- backup ----------
const stampOf = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d+Z$/, 'Z');

async function resolveAccount(o) {
  if (o.local) return { id: 'local', name: 'local wrangler state' };
  const r = await runWrangler(['whoami', '--json']);
  let who = null;
  try { who = parseJsonOut(r.stdout.toString('utf8')); } catch { }
  if (!who?.loggedIn) die('wrangler is not logged in. Ask the user to run: npx wrangler login', 2);
  const accts = (who.accounts || []).map(a => ({ id: a.id, name: a.name }));
  const want = o.account || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (want) {
    const a = accts.find(x => x.id === want || x.name === want);
    if (a) return a;
    if (!accts.length && /^[0-9a-f]{32}$/.test(want)) return { id: want, name: '(not listed by whoami)' };
    die(`account "${want}" isn't one this login can see: ${accts.map(x => `${x.name} (${x.id})`).join(', ') || 'none listed'}`, 2);
  }
  if (accts.length === 1) return accts[0];
  if (!accts.length) die('wrangler whoami listed no accounts. Set CLOUDFLARE_ACCOUNT_ID or pass --account <id>', 2);
  die(`this login can see ${accts.length} accounts. Pick one with --account <id> (or CLOUDFLARE_ACCOUNT_ID):\n` + accts.map(a => `    ${a.id}  ${a.name}`).join('\n'), 2);
}

function pick(all, wanted, keys, what) {
  if (!wanted) return all;
  const out = [];
  for (const w of csv(wanted)) {
    const hit = all.find(x => keys.some(k => x[k] === w));
    if (!hit) die(`${what} "${w}" not found. Available: ${all.map(x => x[keys[0]]).join(', ') || 'none'}`, 2);
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

async function backupD1(db, ctx) {
  const rel = `d1/${safeName(db.name)}.sql`, file = path.join(ctx.dir, 'd1', safeName(db.name) + '.sql');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['d1', 'export', db.name, ctx.o.local ? '--local' : '--remote', '--output', file, '-y'];
  const cwd = ctx.o.local ? path.resolve(ctx.o.cwd || '.') : ctx.tmp;
  await retrying(async () => {
    if (!ctx.o.local) await ctx.gate.wait();
    const r = await runWrangler(args, { cwd }); // stdout has a presigned download URL: never print it
    if (r.code !== 0 || !fs.existsSync(file)) throw new Error(wErr(r));
  }, { attempts: 3, gate: ctx.gate, stats: ctx.stats });
  const a = await analyzeSqlFile(file, { sqlite: !ctx.o['no-sqlite'] });
  const bytes = fs.statSync(file).size;
  let bookmark = null;
  if (!ctx.o.local) {
    try { bookmark = (await wranglerJson(['d1', 'time-travel', 'info', db.name, '--json'], { cwd: ctx.tmp })).bookmark || null; } catch { }
  }
  const rows = a.rows ? Object.values(a.rows).reduce((x, y) => x + y, 0) : Object.values(a.inserts).reduce((x, y) => x + y, 0);
  return {
    entry: { name: db.name, uuid: db.uuid || null, file: rel, bytes, statements: a.statements, inserts: a.inserts, tables: a.tables, rows: a.rows, replayed: a.replayed, timeTravelBookmark: bookmark, exportedAt: new Date().toISOString(), problems: a.problems },
    summary: `${plural(a.statements, 'statement')}, ${a.tables ?? Object.keys(a.inserts).length} tables, ${plural(rows, 'row')}${a.replayed ? ' (replayed in SQLite)' : ''}, ${human(bytes)}`,
    problems: a.problems,
  };
}

export async function backupKv(ns, ctx) {
  const { T, o } = ctx;
  const relDir = `kv/${safeName(ns.title)}__${ns.id.slice(0, 8)}`;
  const keys = await T.listKeys(ns);
  const s = { id: ns.id, title: ns.title, keys: keys.length, written: 0, text: 0, binary: 0, valueBytes: 0, withMetadata: 0, withExpiration: 0, nonObjectMetadata: 0, vanished: 0, failed: 0, reads: { bulk: 0, single: 0 }, files: [], failedKeys: [] };
  const w = new ChunkWriter(path.join(ctx.dir, relDir), 'part'), wx = new ChunkWriter(path.join(ctx.dir, relDir), 'nonobject-metadata');
  let mode = o.exact ? 'single' : 'bulk', bulkFails = 0;
  // Local: one wrangler at a time, parallel ones fight over miniflare's SQLite state (SQLITE_BUSY).
  const conc = Number(o.concurrency) || (o.local ? 1 : T.name.startsWith('REST') ? 6 : 4);
  const tty = process.stdout.isTTY;
  for (let b = 0; b < keys.length; b += 100) {
    const batch = keys.slice(b, b + 100), res = new Array(batch.length), need = [];
    let texts = new Map();
    if (mode === 'bulk') {
      try { texts = await T.bulkText(ns, batch.map(k => k.name)); s.reads.bulk++; }
      catch (e) { if (++bulkFails >= 3) mode = 'single'; ctx.notes.add(`bulk reads failed (${redact(e.message)}); read those keys one by one`); }
    }
    // Bulk reads return text only. Binary bytes come back as U+FFFD, so those keys are re-read raw.
    batch.forEach((k, i) => { const v = texts.get(k.name); if (typeof v === 'string' && !v.includes('�')) res[i] = { text: v }; else need.push(i); });
    if (mode === 'bulk' && b < 200 && need.length > batch.length / 2) mode = 'single'; // mostly binary: skip bulk
    await pool(need, conc, async i => {
      try { const buf = await T.raw(ns, batch[i].name); res[i] = buf ? { bytes: buf } : { vanished: true }; s.reads.single++; }
      catch (e) { res[i] = { error: redact(e.message) }; }
    });
    batch.forEach((k, i) => {
      const r = res[i];
      if (r.vanished) { s.vanished++; return; }
      if (r.error) { s.failed++; s.failedKeys.push({ key: k.name, error: r.error }); return; }
      const e = encodeKvEntry({ key: k.name, text: r.text, bytes: r.bytes, expiration: k.expiration, metadata: k.metadata });
      s.valueBytes += r.bytes ? r.bytes.length : Buffer.byteLength(r.text);
      e.base64 ? s.binary++ : s.text++;
      if (e.metadata !== undefined) s.withMetadata++;
      if (e.expiration) s.withExpiration++;
      if (bulkPutCompatible(e)) w.add(e); else { s.nonObjectMetadata++; wx.add(e); }
      s.written++;
    });
    if (tty) process.stdout.write(`\r  ${Math.min(b + 100, keys.length)}/${keys.length} keys read`);
  }
  if (tty && keys.length) process.stdout.write('\r' + ' '.repeat(40) + '\r');
  s.files = [...w.close(), ...wx.close()].map(f => `${relDir}/${f.name}`);
  s.parts = w.files.map(f => ({ file: `${relDir}/${f.name}`, entries: f.entries }));
  s.nonObjectParts = wx.files.map(f => ({ file: `${relDir}/${f.name}`, entries: f.entries }));
  return s;
}

export function restoreMd(m, scriptPath = SELF) {
  const remote = m.source !== 'local', where = remote ? '--remote' : '--local';
  const L = [];
  L.push(`# Restoring ${m.name}`, '');
  L.push(`Backed up ${m.createdAt} from ${remote ? `account ${m.account.name} (\`${m.account.id}\`)` : 'local wrangler state'} by cf-backup ${m.version}.`);
  L.push('', '**Nothing below has been run.** Every command here WRITES to Cloudflare. Read each one, and only run it when you mean to.');
  L.push('', 'This folder holds user data (database rows, KV values). Keep it out of git, chat, tickets and shared drives.', '');
  L.push('Check the files first:', '', '```', `node "${scriptPath}" verify "${m.dir || '.'}"`, '```', '');
  if (remote) {
    L.push('Run the commands from inside this folder. If your login can see more than one account, pick this one first:', '', '```',
      `export CLOUDFLARE_ACCOUNT_ID=${m.account.id}        # PowerShell: $env:CLOUDFLARE_ACCOUNT_ID="${m.account.id}"`, '```', '');
  } else L.push('Run the commands from the wrangler project folder the backup was made in, with the file paths pointing into this folder.', '');
  for (const d of m.d1) {
    L.push(`## D1: ${d.name}`, '', `\`${d.file}\`: ${d.statements} statements, ${d.rows ? Object.values(d.rows).reduce((a, b) => a + b, 0) + ' rows in ' + d.tables + ' tables' : Object.values(d.inserts).reduce((a, b) => a + b, 0) + ' INSERTs'}, ${human(d.bytes)}.`, '');
    L.push('The file creates the tables and then inserts the rows, so it fails with "table already exists" on a database that still has them. Restore into a new database and point your Worker\'s binding at it, or empty the old one first.', '');
    L.push('```');
    if (remote) L.push(`npx wrangler d1 create ${d.name}-restored`);
    L.push(`npx wrangler d1 execute ${remote ? d.name + '-restored' : d.name} ${where} --file "${d.file}" -y`, '```', '');
    if (d.timeTravelBookmark) {
      L.push('Within D1 Time Travel\'s window (7 days on Free, 30 on Paid) you can also roll the original database back to just after this export, without the file. This REPLACES its current data:', '',
        '```', `npx wrangler d1 time-travel restore ${d.name} --bookmark=${d.timeTravelBookmark}`, '```', '');
    }
  }
  for (const k of m.kv) {
    L.push(`## KV: ${k.title} (\`${k.id}\`)`, '');
    if (!k.written) { L.push(`Empty when backed up${k.failed ? ` (${k.failed} keys failed to read)` : ''}: nothing to restore.`, ''); continue; }
    L.push(`${k.written} keys: ${k.text} text, ${k.binary} binary (base64), ${k.withMetadata} with metadata, ${k.withExpiration} with an expiration. ${human(k.valueBytes)} of values.`, '');
    L.push('`kv bulk put` overwrites keys with the same name and leaves other keys alone. KV rejects an expiration less than 60 seconds in the future, so entries that have expired by now make the request fail: delete them from the file first. To restore into a new namespace, run `npx wrangler kv namespace create <name>` and use the id it prints.', '');
    L.push('```', ...k.parts.map(p => `npx wrangler kv bulk put "${p.file}" --namespace-id ${k.id} ${where}`), '```', '');
    if (k.nonObjectParts?.length) {
      L.push(`${k.nonObjectMetadata} keys have metadata that isn't a JSON object, which \`wrangler kv bulk put\` refuses. The API accepts the same file:`, '', '```',
        ...k.nonObjectParts.map(p => `curl -X PUT "https://api.cloudflare.com/client/v4/accounts/${m.account.id}/storage/kv/namespaces/${k.id}/bulk" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data-binary @"${p.file}"`), '```', '');
    }
    if (k.failed) L.push(`${k.failed} keys could not be read and are NOT in this backup. Their names are in manifest.json under \`failedKeys\`.`, '');
  }
  return L.join('\n');
}

const GITIGNORE = `# cf-backup: this folder holds user data exported from Cloudflare (D1 rows, KV values).
# Don't commit it, upload it or paste it anywhere. This file makes git ignore everything here.
*
`;

async function cmdBackup(o) {
  const outRoot = path.resolve((o.out || path.join(os.homedir(), 'cf-backups')).replace(/^~(?=$|[\\/])/, os.homedir()));
  const keep = o.keep !== undefined ? Number(o.keep) : null;
  if (keep !== null && !(Number.isInteger(keep) && keep >= 1)) die('--keep needs a whole number of at least 1', 2);
  // 1. never write user data into a git work tree unless told to
  const repo = findGitWorkTree(outRoot);
  if (repo && !o['allow-git']) die(`${outRoot} is inside the git work tree ${repo}.\n  Backups contain user data and must not be committed. Use --out outside any repo,\n  or --allow-git if that folder is git-ignored and you are sure.`, 2);
  if (o.local && !o.d1 && !o.kv) die('--local needs --d1 <database name> and/or --kv <namespace id>: local state can\'t be listed', 2);
  if (o['no-d1'] && o['no-kv']) die('--no-d1 and --no-kv together leave nothing to back up', 2);
  if ((o.d1 && o['no-d1']) || (o.kv && o['no-kv'])) die('--d1/--kv conflicts with --no-d1/--no-kv', 2);
  if (o.via && !['api', 'wrangler'].includes(o.via)) die('--via is "api" or "wrangler"', 2);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-backup-'));
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  LOG_DIR = path.join(tmp, 'wrangler-logs');
  const account = await resolveAccount(o);
  if (!o.local) ACCOUNT_ID = account.id;
  const stats = { requests: 0, retries: 0, rateLimited: 0 };
  const rps = Number(o.rps) || 3;
  if (!(rps > 0 && rps <= 20)) die('--rps must be between 0 and 20', 2);
  const gate = new Gate(o.local ? Infinity : rps);
  let T;
  if (o.local || o.via === 'wrangler') T = wranglerTransport(o, gate, stats, tmp);
  else {
    try {
      const api = new CfApi(account.id, await getAuthHeaders(), gate, stats, getAuthHeaders);
      T = apiTransport(api);
    } catch (e) {
      warn(`no API token from the wrangler login (${redact(e.message)}); using wrangler subcommands instead`);
      T = wranglerTransport(o, gate, stats, tmp);
    }
  }
  log(`cf-backup ${VERSION}  account: ${account.name}${o.local ? '' : ` (${short(account.id)})`}`);
  log(`  reads via ${T.name}${o.local ? '' : `, at most ${rps} requests/s`}; wrangler ${resolveWrangler().version}`);

  // 2. what to back up
  const listed = async (what, fn) => { try { return await fn(); } catch (e) { if (e instanceof Fatal) throw e; die(`couldn't list ${what}: ${redact(e.message)}`); } };
  let dbs = [], nss = [];
  if (!o['no-d1'] && !(o.local && !o.d1)) dbs = o.local ? csv(o.d1).map(n => ({ name: n, uuid: null })) : pick(await listed('D1 databases', T.listD1), o.d1, ['name', 'uuid'], 'D1 database');
  if (!o['no-kv'] && !(o.local && !o.kv)) nss = o.local ? csv(o.kv).map(id => ({ id, title: id })) : pick(await listed('KV namespaces', T.listKv), o.kv, ['title', 'id'], 'KV namespace');

  if (o['dry-run']) {
    step(`would back up ${plural(dbs.length, 'D1 database')} and ${plural(nss.length, 'KV namespace')} into ${outRoot}`);
    for (const d of dbs) log(`  D1  ${d.name}  ${d.file_size != null ? human(d.file_size) : ''}`);
    let keys = 0;
    for (const n of nss) { const c = (await T.listKeys(n)).length; keys += c; log(`  KV  ${n.title}  (${n.id})  ${plural(c, 'key')}`); }
    const lo = Math.ceil(keys / 100), hi = keys;
    if (!o.local && keys) log(`\n  KV values take ${lo === hi ? lo : `${lo} (all text) to ${hi} (all binary)`} requests: about ${Math.ceil(lo / rps)}-${Math.ceil(hi / rps)} s at ${rps}/s`);
    if (dbs.length && !o.local) log('  ! each D1 database can\'t serve queries while its export runs (seconds for small databases)');
    log('\n(dry run) nothing written.');
    return 0;
  }

  // 3. write into <name>.partial, rename when done
  fs.mkdirSync(outRoot, { recursive: true });
  const leftovers = fs.readdirSync(outRoot).filter(n => /^cf-backup-.*\.partial$/.test(n));
  const started = new Date();
  let name = `cf-backup-${stampOf(started)}`;
  for (let i = 2; fs.existsSync(path.join(outRoot, name)) || fs.existsSync(path.join(outRoot, name + '.partial')); i++) name = `cf-backup-${stampOf(started)}-${i}`;
  const finalDir = path.join(outRoot, name), dir = finalDir + '.partial';
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE); // before any data lands
  process.on('SIGINT', () => { console.log(`\n✘ interrupted. Partial backup left at ${dir} (no manifest, never pruned). Delete it when you like.`); process.exit(130); });
  log(`  writing to ${finalDir}`);
  log('  ! backups contain user data: don\'t commit, upload or paste them');
  if (repo) warn(`inside git work tree ${repo} (--allow-git). The .gitignore in the backup keeps its files out of commits.`);
  if (leftovers.length) warn(`${plural(leftovers.length, 'unfinished backup folder')} from earlier runs in ${outRoot} (*.partial). Not touched.`);

  const ctx = { o, T, gate, stats, dir, tmp, notes: new Set() };
  const manifest = { tool: TOOL, format: FORMAT, version: VERSION, name, createdAt: started.toISOString(), finishedAt: null, source: o.local ? 'local' : 'remote', account, wrangler: resolveWrangler().version, node: process.version, complete: false, d1: [], kv: [], errors: [], stats };
  let warnedD1 = false;
  for (const db of dbs) {
    step(`D1 ${db.name}${db.file_size != null ? ` (${human(db.file_size)})` : ''}`);
    if (!o.local && !warnedD1) { warn('the database can\'t serve queries while its export runs (seconds for small databases)'); warnedD1 = true; }
    try {
      const r = await backupD1(db, ctx);
      manifest.d1.push(r.entry);
      if (r.problems.length) { manifest.errors.push({ what: `d1 ${db.name}`, message: r.problems.join('; ') }); r.problems.forEach(p => warn(p)); }
      log(`  ${r.problems.length ? '!' : '✓'} ${r.summary}`);
    } catch (e) {
      fs.rmSync(path.join(dir, 'd1', safeName(db.name) + '.sql'), { force: true }); // no half-written dump
      manifest.errors.push({ what: `d1 ${db.name}`, message: redact(e.message) });
      log(`  ✘ export failed: ${redact(e.message)}`);
    }
  }
  for (const ns of nss) {
    step(`KV ${ns.title}${ns.title !== ns.id ? ` (${short(ns.id)})` : ''}`);
    try {
      const s = await backupKv(ns, ctx);
      manifest.kv.push(s);
      if (!s.failedKeys.length) delete s.failedKeys;
      if (s.failed) manifest.errors.push({ what: `kv ${ns.title}`, message: `${s.failed} of ${s.keys} keys could not be read` });
      const parts = [`${plural(s.written, 'key')}`];
      if (s.written) parts.push(`${s.text} text, ${s.binary} binary, ${human(s.valueBytes)}`, `${s.withMetadata} with metadata, ${s.withExpiration} expiring`);
      if (s.vanished) parts.push(`${s.vanished} deleted while reading`);
      log(`  ${s.failed ? '!' : '✓'} ${parts.join('; ')}${s.keys ? `  (${s.reads.bulk} bulk + ${s.reads.single} single reads)` : ' (empty)'}`);
      if (s.failed) warn(`${plural(s.failed, 'key')} failed to read (names in manifest.json, failedKeys)`);
    } catch (e) { manifest.errors.push({ what: `kv ${ns.title}`, message: redact(e.message) }); log(`  ✘ failed: ${redact(e.message)}`); }
  }
  for (const n of ctx.notes) warn(n);

  // 4. RESTORE.md, manifest with sha256 of every file, then rename into place
  manifest.complete = manifest.errors.length === 0;
  manifest.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'RESTORE.md'), restoreMd({ ...manifest, dir: finalDir }));
  await finalizeBackup(dir, manifest);
  fs.renameSync(dir, finalDir);
  const secs = Math.round((Date.parse(manifest.finishedAt) - started) / 1000);
  log(`\n${manifest.complete ? '✓' : '!'} ${manifest.complete ? 'backup complete' : `backup finished with ${plural(manifest.errors.length, 'problem')}`}: ${plural(manifest.d1.length, 'D1 database')}, ${plural(manifest.kv.length, 'KV namespace')}, ${plural(Object.keys(manifest.files).length, 'file')}, ${human(manifest.totalBytes)} in ${secs} s`);
  if (T.name.startsWith('REST')) log(`  ${stats.requests} API requests, ${stats.retries} retries${stats.rateLimited ? `, rate limited ${stats.rateLimited}x` : ''}`);
  log(`  ${finalDir}`);
  log(`  verify:  node "${SELF}" verify "${finalDir}"`);
  log('  restore: commands are in RESTORE.md in that folder (nothing was restored or written to Cloudflare)');

  // 5. prune older local backups, only after a complete run
  if (keep !== null) {
    if (!manifest.complete) warn('not pruning: this backup is incomplete');
    else {
      const p = prune(outRoot, keep, { account: account.id });
      log(`  pruned ${plural(p.deleted.length, 'older backup')} (keeping the newest ${keep} for this account)${p.deleted.length ? ': ' + p.deleted.join(', ') : ''}`);
    }
  }
  return manifest.complete ? 0 : 1;
}

async function cmdVerify(o) {
  const dir = o._[1] && path.resolve(o._[1]);
  if (!dir) die('usage: node cf-backup.mjs verify <backupDir>', 2);
  const r = await verifyBackup(dir, { sqlite: !o['no-sqlite'] });
  step(`verifying ${dir}`);
  if (r.manifest) log(`  ${r.manifest.name}, made ${r.manifest.createdAt}${r.manifest.complete ? '' : ' (marked incomplete)'}`);
  log(`  ${r.files}/${Object.keys(r.manifest?.files || {}).length} files match their sha256 (${human(r.bytes)})`);
  for (const d of r.d1) log(`  ${d.ok ? '✓' : '✘'} D1 ${d.name}: ${d.statements} statements${d.replayed ? `, replayed in SQLite: ${d.tables} tables, ${d.rows} rows` : ' (syntax split only)'}`);
  for (const k of r.kv) log(`  ${k.ok ? '✓' : '✘'} KV ${k.title}: ${plural(k.entries, 'entry', 'entries')} decode cleanly`);
  for (const w of r.warnings) warn(w);
  for (const p of r.problems) log('  ✘ ' + p);
  log(r.ok ? '\n✓ backup verified' : `\n✘ ${plural(r.problems.length, 'problem')}`);
  return r.ok ? 0 : 1;
}

function cmdPrune(o) {
  const dir = o._[1] && path.resolve(o._[1]);
  const keep = Number(o.keep);
  if (!dir || !(Number.isInteger(keep) && keep >= 1)) die('usage: node cf-backup.mjs prune <outDir> --keep N [--dry-run]', 2);
  const p = prune(dir, keep, { dryRun: !!o['dry-run'], account: o.account });
  log(`${o['dry-run'] ? '(dry run) would delete' : 'deleted'} ${plural(p.deleted.length, 'backup')}${p.deleted.length ? ': ' + p.deleted.join(', ') : ''}. ${p.kept} cf-backup folders kept. Other folders are never touched.`);
  return 0;
}

const USAGE = `usage:
  node cf-backup.mjs [backup] [--out <dir>] [--d1 a,b] [--kv title-or-id,...] [--no-d1] [--no-kv]
                     [--account <id>] [--keep N] [--exact] [--rps 3] [--concurrency 6] [--dry-run]
                     [--allow-git] [--via wrangler] [--local --cwd <project> [--persist-to <dir>]]
  node cf-backup.mjs verify <backupDir> [--no-sqlite]
  node cf-backup.mjs prune <outDir> --keep N [--account <id>] [--dry-run]`;
const BOOL = new Set(['dry-run', 'exact', 'allow-git', 'local', 'no-d1', 'no-kv', 'no-sqlite', 'help']);
const VALUE = new Set(['out', 'd1', 'kv', 'account', 'keep', 'rps', 'concurrency', 'via', 'cwd', 'persist-to']);
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { o.help = true; continue; }
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('='), k = a.slice(2, eq < 0 ? undefined : eq);
    if (BOOL.has(k)) { o[k] = true; continue; }
    if (!VALUE.has(k)) die(`unknown option --${k}\n${USAGE}`, 2);
    const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined || (eq < 0 && v.startsWith('--'))) die(`--${k} needs a value`, 2);
    o[k] = v;
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const o = parseArgs(argv);
    const cmd = o._[0] || 'backup';
    if (o.help) { log(USAGE); return 0; }
    if (cmd === 'backup' || cmd === 'list') { if (cmd === 'list') o['dry-run'] = true; return await cmdBackup(o); }
    if (cmd === 'verify') return await cmdVerify(o);
    if (cmd === 'prune') return cmdPrune(o);
    die(`unknown command "${cmd}"\n${USAGE}`, 2);
  } catch (e) {
    if (e instanceof Fatal) { console.error('\n✘ ' + e.message); return e.code; }
    console.error('\n✘ ' + redact(e.stack || e.message));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
