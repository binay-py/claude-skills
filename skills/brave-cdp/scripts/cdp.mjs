#!/usr/bin/env node
// brave-cdp — drive your own logged-in Brave / Chrome / Edge over the DevTools Protocol
// with ONE connection, so the browser's "Allow remote debugging?" prompt appears once.
// Zero dependencies. Node 22+ (built-in WebSocket and fetch).
//
//   node cdp.mjs tabs                         list open page tabs
//   node cdp.mjs eval "document.title" [--match <url-part>]
//   node cdp.mjs run job.mjs [args...]        run a whole job on one connection
//   node cdp.mjs cleanup                      close tabs left open by jobs that were killed
//   node cdp.mjs relay                        keep one connection open for later commands
//
// Every command uses a running relay when there is one, otherwise connects directly.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensions, printReload, formatErrors, watch } from './ext.mjs';

const RELAY_PORT = Number(process.env.CDP_RELAY_PORT || 9333);
// one token file per relay port, so a second relay (or a test one) never overwrites a running relay's token
const TOKEN_FILE = path.join(os.homedir(), RELAY_PORT === 9333 ? '.cdp-relay-token' : `.cdp-relay-token-${RELAY_PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- finding the browser ----------
function profileDirs() {
  const h = os.homedir();
  const L = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
  const S = path.join(h, 'Library', 'Application Support');
  if (process.platform === 'win32') return [
    ['brave', path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['chrome', path.join(L, 'Google', 'Chrome', 'User Data')],
    ['edge', path.join(L, 'Microsoft', 'Edge', 'User Data')]];
  if (process.platform === 'darwin') return [
    ['brave', path.join(S, 'BraveSoftware', 'Brave-Browser')],
    ['chrome', path.join(S, 'Google', 'Chrome')],
    ['edge', path.join(S, 'Microsoft Edge')]];
  return [
    ['brave', path.join(h, '.config', 'BraveSoftware', 'Brave-Browser')],
    ['chrome', path.join(h, '.config', 'google-chrome')],
    ['chromium', path.join(h, '.config', 'chromium')],
    ['edge', path.join(h, '.config', 'microsoft-edge')]];
}

export async function findEndpoint() {
  if (process.env.CDP_URL) return process.env.CDP_URL;
  const want = (process.env.CDP_BROWSER || '').toLowerCase();
  for (const [name, dir] of profileDirs()) {
    if (want && name !== want) continue;
    const f = path.join(dir, 'DevToolsActivePort');
    if (fs.existsSync(f)) {
      const [port, wsPath] = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/);
      return `ws://127.0.0.1:${port}${wsPath}`;
    }
  }
  const port = process.env.CDP_PORT || 9222;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).webSocketDebuggerUrl;
  } catch {}
  throw new Error('No debuggable browser found. Turn on remote debugging at brave://inspect/#remote-debugging '
    + '(chrome://inspect/#remote-debugging in Chrome), start the browser with --remote-debugging-port=9222, or set CDP_URL.');
}

// ---------- direct connection ----------
export class CDP {
  static async connect(url) {
    url ??= await findEndpoint();
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`Could not connect to ${url}. Is the browser open, and did you click Allow?`));
    });
    return new CDP(ws);
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Set();
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(`${m.error.message} (${m.error.code})`)) : res(m.result);
      } else if (m.method) for (const l of this.listeners) l(m);
    };
    ws.onclose = () => {
      for (const { rej } of this.pending.values()) rej(new Error('CDP connection closed'));
      this.pending.clear(); this.closed = true; this.onclose?.();
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id, msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { this.ws.close(); }
}

// ---------- relay client (same interface as CDP) ----------
class RelayCDP {
  static async connect() {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    try {
      const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`, { headers: { 'x-relay-token': token }, signal: AbortSignal.timeout(800) });
      if (!r.ok) return null;
      // CDP_URL / CDP_BROWSER / CDP_PORT pick a browser: only use the relay if it is connected to that one
      const want = process.env.CDP_URL || process.env.CDP_BROWSER || process.env.CDP_PORT ? await findEndpoint().catch(() => null) : null;
      if (!want || (await r.json()).url === want) return new RelayCDP(token);
    } catch {}
    return null;
  }
  constructor(token) { this.token = token; this.listeners = new Set(); this.since = null; this.ctrl = new AbortController(); this.viaRelay = true; }
  async req(p, body) {
    const r = await fetch(`http://127.0.0.1:${RELAY_PORT}${p}`, {
      method: body ? 'POST' : 'GET', signal: this.ctrl.signal,
      headers: { 'x-relay-token': this.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return r.json();
  }
  async send(method, params = {}, sessionId) {
    const j = await this.req('/send', { method, params, sessionId });
    if (!j.ok) throw new Error(j.error);
    return j.result;
  }
  on(fn) { this.listeners.add(fn); if (!this.polling) this.poll(); return () => this.listeners.delete(fn); }
  async poll() {
    this.polling = true;
    try {
      if (this.since === null) this.since = (await this.req('/events?since=-1')).seq;
      while (this.listeners.size && !this.closed) {
        const j = await this.req(`/events?since=${this.since}&wait=20000`);
        for (const e of j.events) { this.since = e.seq; for (const l of this.listeners) l(e); }
      }
    } catch (e) { if (!this.closed) console.error('relay event poll stopped:', e.message); }
    this.polling = false;
  }
  close() { this.closed = true; this.ctrl.abort(); }
}

export async function connect() {
  return (await RelayCDP.connect()) || CDP.connect();
}

// ---------- helpers ----------
export function waitEvent(cdp, method, { sessionId, filter = () => true, timeout = 30000 } = {}) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { off(); rej(new Error(`timeout waiting for ${method}`)); }, timeout);
    const off = cdp.on(m => {
      if (m.method === method && (!sessionId || m.sessionId === sessionId) && filter(m.params)) { clearTimeout(t); off(); res(m.params); }
    });
  });
}

export async function tabs(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
}

// Ledger of tabs that jobs opened, with the job's PID. A job that is killed outright (timeout, closed
// terminal) can't close its tabs, so the next run closes those whose job is gone. The user's own tabs
// are never in the ledger, and tabs of a job that is still running are left alone.
const LEDGER = path.join(os.homedir(), '.cdp-opened.json');
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return []; } };
const writeLedger = l => { try { l.length ? fs.writeFileSync(LEDGER, JSON.stringify(l)) : fs.rmSync(LEDGER, { force: true }); } catch {} };
const alivePid = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function closeLeftovers(cdp) {
  const stale = readLedger().filter(e => !alivePid(e.pid));
  if (!stale.length) return 0;
  const open = new Set((await tabs(cdp)).map(t => t.targetId));
  let n = 0;
  for (const e of stale) if (open.has(e.targetId)) { await cdp.send('Target.closeTarget', { targetId: e.targetId }).catch(() => {}); n++; }
  const ids = new Set(stale.map(e => e.targetId));
  writeLedger(readLedger().filter(e => !ids.has(e.targetId)));
  return n;
}

const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };

// Attach to a tab. Default: open a NEW tab so the user's own tabs are never disturbed.
// { match: 'part-of-url' } reuses an existing tab instead.
export async function page(cdp, { url = 'about:blank', match, background = false } = {}) {
  let target = match && (await tabs(cdp)).find(t => t.url.includes(match));
  let created = false;
  if (!target) {
    target = { targetId: (await cdp.send('Target.createTarget', { url, background })).targetId }; created = true;
    writeLedger([...readLedger(), { targetId: target.targetId, pid: process.pid }]);
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);

  const p = {
    targetId: target.targetId, sessionId, send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(expression, timeout = 30000) {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) { try { const v = await p.eval(expression); if (v) return v; last = undefined; } catch (e) { last = e.message; } await sleep(250); }
      throw new Error('timeout waiting for: ' + expression + (last ? `
  last error: ${last}` : ''));
    },
    async goto(u, timeout = 45000) {
      await send('Page.navigate', { url: u });
      await sleep(300);
      return p.waitFor(`document.readyState === 'complete' && location.href !== 'about:blank'`, timeout);
    },
    front: () => send('Page.bringToFront'),
    // Real mouse events at the element's centre (synthetic el.click() doesn't open file choosers, menus, etc.)
    async click(selector) {
      const r = await p.waitFor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect();
        return b.width && b.height ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; })()`);
      await p.mouse(r.x, r.y);
    },
    async mouse(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    type: text => send('Input.insertText', { text }),
    async key(key, modifiers = 0) { // modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift
      const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
      const base = { key, modifiers, windowsVirtualKeyCode: code, code: key.length === 1 ? 'Key' + key.toUpperCase() : key };
      // Default actions (form submit on Enter, typing a char) only happen when keyDown carries text.
      const text = key === 'Enter' ? '\r' : key.length === 1 && !(modifiers & 6) ? key : undefined;
      await send('Input.dispatchKeyEvent', text ? { type: 'keyDown', text, unmodifiedText: text, ...base } : { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64')); return file;
    },
    // Attach local files to an <input type=file> without opening the OS dialog.
    async upload(selector, files) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('no element: ' + selector);
      await send('DOM.setFileInputFiles', { nodeId, files: files.map(f => path.resolve(f)) });
    },
    async close() {
      if (!created) return cdp.send('Target.detachFromTarget', { sessionId });
      try { await cdp.send('Target.closeTarget', { targetId: target.targetId }); }
      finally { writeLedger(readLedger().filter(e => e.targetId !== target.targetId)); }
    },
  };
  if (url !== 'about:blank' && created) await p.waitFor(`location.href !== 'about:blank' && document.readyState === 'complete'`, 45000);
  return p;
}

// Save downloads into `dir`. Files arrive named by GUID (no extension); the
// 'Browser.downloadProgress' event with state 'completed' carries the guid.
export async function downloadsTo(cdp, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: path.resolve(dir), eventsEnabled: true });
}

// ---------- extensions ----------
async function extCli(cdp, [sub, q, ...flags]) {
  const has = f => flags.includes(f);
  if (!['list', 'reload', 'errors', 'watch'].includes(sub) || (sub !== 'list' && !q)) { console.log(USAGE); process.exitCode = 1; return; }
  const api = await extensions(cdp, o => page(cdp, o));
  try {
    if (sub === 'list') {
      for (const e of await api.list()) {
        const n = (e.runtimeErrors?.length || 0) + (e.manifestErrors?.length || 0);
        const kind = e.location === 'UNPACKED' ? 'unpacked' : e.location.toLowerCase().replace('from_', '');
        console.log(`${e.id}  ${e.state === 'ENABLED' ? 'on ' : 'off'}  ${kind.padEnd(8)}  ${e.name} ${e.version}${n ? `  [${n} error${n > 1 ? 's' : ''}]` : ''}${e.dir ? `
    ${e.dir}` : ''}`);
      }
    }
    if (sub === 'errors') {
      const e = await api.find(q), info = await api.info(e.id);
      console.log(formatErrors(info) || `no errors for ${e.name}`);
      if (has('--clear')) { await api.clearErrors(e.id); console.log('cleared'); }
    }
    if (sub === 'reload') {
      const r = await api.reload(q, { reloadTabs: has('--tabs') });
      printReload(r);
      if (!r.ok) process.exitCode = 2;
    }
    if (sub === 'watch') {
      const ac = new AbortController();
      for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, () => ac.abort());
      await watch(api, q, { reloadTabs: has('--tabs'), signal: ac.signal });
    }
  } finally { await api.close().catch(() => {}); }
}

// ---------- relay server ----------
async function relay() {
  const url = await findEndpoint(), cdp = await CDP.connect(url);
  const token = crypto.randomBytes(24).toString('hex');
  const events = []; let seq = 0; const waiters = new Set();
  cdp.on(m => { events.push({ seq: ++seq, ...m }); if (events.length > 5000) events.shift(); for (const w of waiters) w(); });
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers.host !== `127.0.0.1:${RELAY_PORT}` || req.headers['x-relay-token'] !== token) return json(res, 403, { ok: false, error: 'forbidden' });
    if (u.pathname === '/health') return json(res, 200, { ok: true, url });
    if (u.pathname === '/send' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      try { const { method, params, sessionId } = JSON.parse(body); json(res, 200, { ok: true, result: await cdp.send(method, params, sessionId) }); }
      catch (e) { json(res, 200, { ok: false, error: e.message }); }
      return;
    }
    if (u.pathname === '/events') {
      const since = Number(u.searchParams.get('since'));
      if (since < 0) return json(res, 200, { seq, events: [] });
      const pick = () => events.filter(e => e.seq > since);
      let out = pick();
      if (!out.length) {
        await new Promise(r => { const w = () => { waiters.delete(w); clearTimeout(t); r(); }; const t = setTimeout(w, Math.min(Number(u.searchParams.get('wait')) || 0, 25000)); waiters.add(w); });
        out = pick();
      }
      return json(res, 200, { seq, events: out });
    }
    json(res, 404, { ok: false, error: 'not found' });
  });
  // The token file is written only once the port is ours: a relay that can't listen must not replace a running relay's token.
  server.on('error', e => { console.error(`relay could not listen on 127.0.0.1:${RELAY_PORT}: ${e.code === 'EADDRINUSE' ? 'a relay (or something else) is already running there' : e.message}`); process.exit(1); });
  server.listen(RELAY_PORT, '127.0.0.1', () => {
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    console.log(`relay up on 127.0.0.1:${RELAY_PORT} (token in ${TOKEN_FILE}). Ctrl+C to stop.`);
  });
  const stop = () => { try { if (fs.readFileSync(TOKEN_FILE, 'utf8') === token) fs.unlinkSync(TOKEN_FILE); } catch {} process.exit(0); };
  cdp.onclose = () => { console.log('browser connection closed'); stop(); };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, stop);
}

// ---------- CLI ----------
const USAGE = `usage: node cdp.mjs tabs | eval "<js>" [--match <url-part>] | run job.mjs [args...] | cleanup | relay
       node cdp.mjs ext list
       node cdp.mjs ext reload <id | folder | name> [--tabs]   reload and print new errors (--tabs: also reload the pages its content scripts run on)
       node cdp.mjs ext errors <id | folder | name> [--clear]
       node cdp.mjs ext watch  <id | folder | name> [--tabs]   reload on every file change in the folder`;
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'relay') return relay();
  if (!['tabs', 'eval', 'run', 'cleanup', 'ext'].includes(cmd)) {
    console.log(USAGE); process.exit(1);
  }
  const cdp = await connect();
  try {
    const left = await closeLeftovers(cdp).catch(() => 0);
    if (left || cmd === 'cleanup') console.log(`closed ${left} tab(s) left open by earlier jobs`);
    if (cmd === 'tabs') for (const t of await tabs(cdp)) console.log(`${t.targetId}  ${t.title.slice(0, 60)}  ${t.url}`);
    if (cmd === 'eval') {
      const mi = rest.indexOf('--match'); const match = mi >= 0 ? rest[mi + 1] : undefined;
      if (match && !(await tabs(cdp)).some(t => t.url.includes(match))) throw new Error(`no open tab's URL contains "${match}"`);
      const p = await page(cdp, { match });
      try { console.log(JSON.stringify(await p.eval(rest[0]), null, 2)); }
      finally { await p.close(); } // closes the blank tab, or detaches from the matched one; also when the expression throws
    }
    if (cmd === 'ext') await extCli(cdp, rest);
    if (cmd === 'run') {
      const job = await import(pathToFileURL(path.resolve(rest[0])).href);
      const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
      const opened = []; // tabs the job opens are closed afterwards, even if it throws
      const openPage = async o => { const pg = await page(cdp, o); opened.push(pg); return pg; };
      // Ctrl+C / terminate: close this job's tabs before exiting (a hard kill is handled by the ledger next run).
      const onSignal = async () => { for (const pg of opened) await pg.close().catch(() => {}); cdp.close(); process.exit(130); };
      for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, onSignal);
      try {
        await job.default({ cdp, page: openPage, ext: () => extensions(cdp, openPage), tabs: () => tabs(cdp), waitEvent: (m, o) => waitEvent(cdp, m, o), downloadsTo: d => downloadsTo(cdp, d), log, args: rest.slice(1) });
      } finally {
        for (const pg of opened) await pg.close().catch(() => {});
      }
    }
  } finally { cdp.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
