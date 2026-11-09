#!/usr/bin/env node
// brave-cdp — drive your own logged-in Brave / Chrome / Edge over the DevTools Protocol
// with ONE connection, so the browser's "Allow remote debugging?" prompt appears once.
// Zero dependencies. Node 22+ (built-in WebSocket and fetch).
//
//   node cdp.mjs tabs                         list open page tabs
//   node cdp.mjs eval "document.title" [--match <url-part>]
//   node cdp.mjs run job.mjs [args...]        run a whole job on one connection
//   node cdp.mjs relay                        keep one connection open for later commands
//
// Every command uses a running relay when there is one, otherwise connects directly.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RELAY_PORT = Number(process.env.CDP_RELAY_PORT || 9333);
const TOKEN_FILE = path.join(os.homedir(), '.cdp-relay-token');
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
      if (r.ok) return new RelayCDP(token);
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

const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };

// Attach to a tab. Default: open a NEW tab so the user's own tabs are never disturbed.
// { match: 'part-of-url' } reuses an existing tab instead.
export async function page(cdp, { url = 'about:blank', match } = {}) {
  let target = match && (await tabs(cdp)).find(t => t.url.includes(match));
  let created = false;
  if (!target) { target = { targetId: (await cdp.send('Target.createTarget', { url })).targetId }; created = true; }
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
    close: () => created ? cdp.send('Target.closeTarget', { targetId: target.targetId }) : cdp.send('Target.detachFromTarget', { sessionId }),
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

// ---------- relay server ----------
async function relay() {
  const cdp = await CDP.connect();
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  const events = []; let seq = 0; const waiters = new Set();
  cdp.on(m => { events.push({ seq: ++seq, ...m }); if (events.length > 5000) events.shift(); for (const w of waiters) w(); });
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers.host !== `127.0.0.1:${RELAY_PORT}` || req.headers['x-relay-token'] !== token) return json(res, 403, { ok: false, error: 'forbidden' });
    if (u.pathname === '/health') return json(res, 200, { ok: true });
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
  server.listen(RELAY_PORT, '127.0.0.1', () => console.log(`relay up on 127.0.0.1:${RELAY_PORT} (token in ${TOKEN_FILE}). Ctrl+C to stop.`));
  const stop = () => { try { fs.unlinkSync(TOKEN_FILE); } catch {} process.exit(0); };
  cdp.onclose = () => { console.log('browser connection closed'); stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

// ---------- CLI ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'relay') return relay();
  if (!['tabs', 'eval', 'run'].includes(cmd)) {
    console.log('usage: node cdp.mjs tabs | eval "<js>" [--match <url-part>] | run job.mjs [args...] | relay'); process.exit(1);
  }
  const cdp = await connect();
  try {
    if (cmd === 'tabs') for (const t of await tabs(cdp)) console.log(`${t.targetId}  ${t.title.slice(0, 60)}  ${t.url}`);
    if (cmd === 'eval') {
      const mi = rest.indexOf('--match'); const match = mi >= 0 ? rest[mi + 1] : undefined;
      const p = await page(cdp, { match });
      console.log(JSON.stringify(await p.eval(rest[0]), null, 2));
      if (!match) await p.close();
    }
    if (cmd === 'run') {
      const job = await import(pathToFileURL(path.resolve(rest[0])).href);
      const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
      const opened = []; // tabs the job opens are closed afterwards, even if it throws
      const openPage = async o => { const pg = await page(cdp, o); opened.push(pg); return pg; };
      try {
        await job.default({ cdp, page: openPage, tabs: () => tabs(cdp), waitEvent: (m, o) => waitEvent(cdp, m, o), downloadsTo: d => downloadsTo(cdp, d), log, args: rest.slice(1) });
      } finally {
        for (const pg of opened) await pg.close().catch(() => {});
      }
    }
  } finally { cdp.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
