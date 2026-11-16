#!/usr/bin/env node
// pwa-check — will this web app install as a PWA, and does it work offline? Zero dependencies. Node 22+.
// Runs its own headless Chrome / Edge / Brave / Chromium with a throwaway profile (set BROWSER=path to override).
//
//   node pwa-check.mjs https://app.example.com        live site (https, or http://localhost:port)
//   node pwa-check.mjs ./dist                          build folder, served on a random 127.0.0.1 port
//   node pwa-check.mjs ./dist --spa                    ...answering unknown routes with index.html
//   node pwa-check.mjs <target> --start /app/          page to open first (default: the URL / folder root)
//   node pwa-check.mjs <target> --page2 /settings      second in-scope page for the offline test
//   node pwa-check.mjs <target> --json                 full result as JSON on stdout
//
// Exit code: 0 = installs and works offline (warnings possible), 1 = won't install or broken offline, 2 = could not run.
// PWA_DEBUG=1 prints step timings to stderr.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const JSON_OUT = flag('json'), SPA = flag('spa'), PAGE2 = opt('page2'), START = opt('start');
const target = argv.find(a => !a.startsWith('--'));
if (!target) { console.log('usage: node pwa-check.mjs <https://url | http://localhost:port | ./folder> [--spa] [--start /path] [--page2 /path] [--json]'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now(), dbg = (...a) => process.env.PWA_DEBUG && console.error(((Date.now() - T0) / 1000).toFixed(1) + 's', ...a);

// ---------- browser ----------
function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const P = process.env.PROGRAMFILES || 'C:/Program Files', P86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', L = process.env.LOCALAPPDATA || '';
  const c = process.platform === 'win32' ? [
    `${P}/Google/Chrome/Application/chrome.exe`, `${P86}/Google/Chrome/Application/chrome.exe`, `${L}/Google/Chrome/Application/chrome.exe`,
    `${P86}/Microsoft/Edge/Application/msedge.exe`, `${P}/Microsoft/Edge/Application/msedge.exe`,
    `${P}/BraveSoftware/Brave-Browser/Application/brave.exe`, `${L}/BraveSoftware/Brave-Browser/Application/brave.exe`]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/snap/bin/chromium'];
  const f = c.find(p => fs.existsSync(p));
  if (!f) throw new Error('No Chromium-based browser found. Set BROWSER=/path/to/chrome');
  return f;
}

// ---------- headless browser lifecycle ----------
// On Windows, --headless=new still creates real (hidden) browser windows, and a browser that gets force-killed
// leaves its pages stuck in Alt+Tab (blank entries titled after the pages, until Explorer restarts). Hidden
// windows ignore a normal "taskkill" close, so the only clean way out is Browser.close over the DevTools
// connection. Every exit path uses it and waits up to 15 s (Edge can take ~13 s): normal close, Ctrl+C, crashes
// (via a short synchronous helper process), and browsers that earlier runs left behind when they were killed
// outright (closed on the next start). A force-kill is only the last resort when the browser ignores that.
const alivePid = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const rmDir = dir => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} };
const GRACE_MS = 15000;
// Run in a child process so it also works synchronously from the 'exit' handler: Browser.close, then wait for the pid.
const CLOSER = `const [f, pid, ms] = process.argv.slice(1), t0 = Date.now();
const alive = () => { if (!+pid) return Date.now() - t0 < 1500; try { process.kill(+pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
try { const [port, p] = require('fs').readFileSync(f, 'utf8').trim().split(/\\r?\\n/);
  const ws = new WebSocket('ws://127.0.0.1:' + port + p); ws.onerror = () => {};
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch {}
setInterval(() => { if (!alive() || Date.now() - t0 > +ms) process.exit(0); }, 150);`;
// Watchdog, started detached next to the browser: if this script is killed outright (a timeout, a closed
// terminal), Windows would otherwise force-kill the browser with it (Node's job object), which is exactly what
// leaves the stuck Alt+Tab entries. The watchdog closes it cleanly instead, then exits.
const GUARD = `const [f, parent, child] = process.argv.slice(1), cp = require('child_process');
const alive = p => { try { process.kill(+p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const iv = setInterval(() => {
  if (!alive(child)) process.exit(0);
  if (alive(parent)) return;
  clearInterval(iv);
  cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(CLOSER)}, f, child, '${GRACE_MS}'], { stdio: 'ignore', windowsHide: true });
  try { if (alive(child)) process.platform === 'win32' ? cp.spawnSync('taskkill', ['/PID', child, '/T', '/F'], { stdio: 'ignore', windowsHide: true }) : process.kill(+child, 'SIGKILL'); } catch {}
  process.exit(0);
}, 500);`;
function closeSync(dir, pid) {
  try { spawnSync(process.execPath, ['-e', CLOSER, path.join(dir, 'DevToolsActivePort'), String(pid), String(GRACE_MS)], { stdio: 'ignore', windowsHide: true, timeout: GRACE_MS + 5000 }); } catch {}
}
function killTree(pid) { // last resort only
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {}
}
async function sweepStale(prefix) {
  let names = []; try { names = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(prefix)); } catch {}
  for (const n of names) {
    const dir = path.join(os.tmpdir(), n);
    let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch {}
    let age = 0; try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
    if (owner ? alivePid(owner.node) : age < 30 * 60e3) continue; // another run may still be using it
    // Browser.close reaches only the exact instance that wrote this profile (the ws path is unique per instance);
    // its pid is unknown here, so wait on the profile folder instead: it can be removed once the browser is gone.
    closeSync(dir, '');
    for (let t = 0; t < GRACE_MS && fs.existsSync(dir); t += 500) { rmDir(dir); if (fs.existsSync(dir)) await sleep(500); }
  }
}
// Throwaway headless browser. stop() is synchronous so it also works from the 'exit' handler.
async function startBrowser(prefix, args = []) {
  await sweepStale(prefix);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(profile, 'owner.json'), JSON.stringify({ node: process.pid }));
  const proc = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', ...args, 'about:blank'],
    { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' }); // detached: not killed along with this script (see GUARD)
  const running = () => proc.exitCode === null && proc.signalCode === null;
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    if (running() && alivePid(proc.pid)) closeSync(profile, proc.pid);
    if (running() && alivePid(proc.pid)) killTree(proc.pid);
    rmDir(profile);
    process.off('exit', stop); for (const s of SIGNALS) process.off(s, onSignal);
  };
  const onSignal = () => { stop(); process.exit(130); };
  process.on('exit', stop); for (const s of SIGNALS) process.on(s, onSignal);
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile) && running(); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { stop(); throw new Error('browser did not start'); }
  await sleep(200);
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  try { spawn(process.execPath, ['-e', GUARD, portFile, String(process.pid), String(proc.pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  const waitExit = ms => Promise.race([running() ? new Promise(r => proc.once('exit', r)) : null, sleep(ms)]);
  // Graceful shutdown: Browser.close over the page's own connection, wait for the process to go, then make sure.
  const close = async (send, ws) => {
    try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch {}
    try { ws.close(); } catch {}
    await waitExit(GRACE_MS); stop();
  };
  return { wsUrl: `ws://127.0.0.1:${port}${wsPath}`, close, stop };
}

async function launch() {
  const br = await startBrowser('pwa-check-');
  const ws = new WebSocket(br.wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to browser')); });
  let id = 0; const pending = new Map(), listeners = new Set();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  };
  // if the browser dies mid-run, fail with a message instead of Node's "unsettled top-level await" (exit 13)
  let lost = null;
  ws.onclose = () => { lost = new Error('lost the connection to the browser (did it crash?)'); for (const { rej } of pending.values()) rej(lost); pending.clear(); };
  const send = (method, params = {}, sessionId) => { if (lost) return Promise.reject(lost); const i = ++id; ws.send(JSON.stringify({ id: i, method, params, sessionId })); return new Promise((res, rej) => pending.set(i, { res, rej })); };
  const close = () => br.close(send, ws);
  return { send, on: f => (listeners.add(f), () => listeners.delete(f)), close };
}

// ---------- helpers ----------
// unref'd so a pending timeout never keeps the process alive after the work is done
const withTimeout = (p, ms, what = 'timed out') => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms).unref())]);
const isLocal = u => /^(localhost|127(\.\d+){3}|\[::1\])$/i.test(new URL(u).hostname);
const within = (u, scope) => { const a = new URL(u), s = new URL(scope); return a.origin === s.origin && a.pathname.startsWith(s.pathname); };
const dirOf = u => { const x = new URL('.', u); return x.href; };
let UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Plain HTTP from Node. Bot protection (Cloudflare and others) sometimes refuses Node but not a browser, so a
// same-origin request that gets 401/403/429/503 or no answer is retried with fetch() inside the page.
let pageFetch = null;
async function get(url, max = 8e6, headers = {}) {
  let r;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await res.arrayBuffer());
    r = { ok: res.ok, status: res.status, url: res.url || url, redirected: res.redirected, ct: (res.headers.get('content-type') || '').toLowerCase(), acao: res.headers.get('access-control-allow-origin'), buf: buf.subarray(0, max) };
  } catch (e) {
    r = { ok: false, status: 0, url, error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message, ct: '', buf: Buffer.alloc(0) };
  }
  if (!r.ok && [0, 401, 403, 429, 503].includes(r.status) && pageFetch && /^https?:/.test(url) && new URL(url).origin === new URL(R.page?.url || R.url).origin) {
    const p = await pageFetch(url).catch(() => null);
    if (p?.ok) return { ok: true, status: p.status, url: p.url || url, redirected: p.redirected, ct: p.ct.toLowerCase(), acao: null, buf: Buffer.from(p.b64, 'base64').subarray(0, max), via: 'browser' };
  }
  return r;
}

// width/height from the first bytes of PNG, JPEG, GIF, WebP, ICO; SVG detected by content
function imageSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const f = b.toString('ascii', 12, 16);
    if (f === 'VP8 ') return { type: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (f === 'VP8L') { const n = b.readUInt32LE(21); return { type: 'webp', w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    if (f === 'VP8X') return { type: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    return { type: 'webp' };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1], len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return { type: 'jpeg' };
  }
  if (b.length > 6 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) return { type: 'ico', w: b[6] || 256, h: b[7] || 256 };
  // drop the XML declaration, comments and doctype in linear passes, then the root must be <svg
  const head = b.toString('utf8', 0, 4000).replace(/^\uFEFF/, '').replace(/<\?xml[^>]*>|<!--[\s\S]*?-->|<!doctype svg[^>]*>/gi, ' ');
  if (/^<svg[\s>]/i.test(head.trimStart())) return { type: 'svg' };
  if (/^\s*<(!doctype html|html|head|body)/i.test(b.toString('utf8', 0, 300))) return { type: 'html' };
  return { type: 'unknown' };
}
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };

// ---------- folder mode: tiny static server ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};
function serve(root, spa) {
  const log = { offline: false, hits: [] };
  const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const server = http.createServer((req, res) => {
    let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (log.offline) log.hits.push(p);
    const abs = path.resolve(root, '.' + p);
    if (abs !== root && !abs.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    let isDir = false; try { isDir = fs.statSync(abs).isDirectory(); } catch {}
    if (isDir && !p.endsWith('/')) { res.writeHead(301, { location: p + '/' + new URL(req.url, 'http://x').search }).end(); return; }
    let file = [abs, path.join(abs, 'index.html'), abs + '.html'].find(isFile), status = 200;
    if (!file && spa && !path.extname(p)) file = isFile(path.join(root, 'index.html')) && path.join(root, 'index.html');
    if (!file) { status = 404; file = isFile(path.join(root, '404.html')) ? path.join(root, '404.html') : null; }
    const type = file ? TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' : 'text/plain; charset=utf-8';
    const body = file ? fs.readFileSync(file) : Buffer.from('404 not found');
    res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((res, rej) => {
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => res({ origin: `http://127.0.0.1:${server.address().port}`, log, close: () => { server.closeAllConnections?.(); server.close(); } }));
  });
}

// ---------- result ----------
const INSTALL = 'install', OFFLINE = 'offline', WARN = 'warn', PASS = 'pass';
const R = { target, mode: null, url: null, browser: null, https: null, chrome: null, page: null, manifest: null, serviceWorker: null, offline: null, findings: [] };
const F = (cat, id, msg, fix) => R.findings.push(fix ? { cat, id, msg, fix } : { cat, id, msg });
function fail(msg) {
  if (JSON_OUT) console.log(JSON.stringify({ ...R, error: msg }, null, 2)); else console.error('pwa-check: ' + msg);
  process.exit(2);
}

let srv = null, pageUrl;
if (/^https?:\/\//i.test(target)) { R.mode = 'url'; pageUrl = new URL(START || '', target).href; }
else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
  R.mode = 'folder'; R.folder = path.resolve(target);
  srv = await serve(R.folder, SPA); pageUrl = new URL(START || '/', srv.origin).href;
} else if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(target)) { R.mode = 'url'; pageUrl = new URL(START || '', 'http://' + target).href; }
else if (!fs.existsSync(target) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(target)) { R.mode = 'url'; pageUrl = new URL(START || '', 'https://' + target).href; }
else fail(`not a URL or a folder: ${target}`);
R.url = pageUrl;
const short = u => { try { const x = new URL(u); return x.origin === new URL(R.url).origin ? x.pathname + x.search : u; } catch { return String(u); } };

// Chrome's installability error ids (components/webapps/browser/installable/installable_logging.cc)
const CHROME_MSG = {
  'not-from-secure-origin': 'page is not served from a secure origin (https, or localhost while developing)',
  'no-manifest': 'page has no <link rel="manifest">',
  'manifest-parsing-or-network-error': 'the manifest could not be fetched or parsed',
  'start-url-not-valid': 'manifest start_url is not valid',
  'manifest-missing-name-or-short-name': 'manifest has no name or short_name',
  'manifest-display-not-supported': 'manifest display must be standalone, fullscreen or minimal-ui',
  'manifest-display-override-not-supported': 'the first supported display_override value must be standalone, fullscreen or minimal-ui',
  'manifest-missing-suitable-icon': 'no suitable icon: needs a square PNG, SVG or WebP of at least {minimum-icon-size-in-pixels}px with sizes set and purpose "any"',
  'no-acceptable-icon': 'no icon is at least {minimum-icon-size-in-pixels}px square in PNG, SVG or WebP format',
  'cannot-download-icon': 'could not download a required icon from the manifest',
  'no-icon-available': 'the downloaded icon was empty or corrupted',
  'prefer-related-applications': 'manifest sets prefer_related_applications: true',
  'url-not-supported-for-webapk': 'a URL in the manifest contains a username, password or port (Android WebAPK limit)',
  'manifest-location-changed': 'manifest location changed during fetch',
  'in-incognito': 'page is loaded in an incognito window',
  'already-installed': 'the app is already installed',
  'no-matching-service-worker': 'no service worker controls the page and start_url (older Chrome versions)',
  'not-offline-capable': 'start_url does not work offline (older Chrome versions)',
};
const chromeMsg = e => (CHROME_MSG[e.errorId] || e.errorId).replace(/\{([\w-]+)\}/g, (_, k) => e.errorArguments?.find(a => a.name === k)?.value ?? k);

// ---------- browser session ----------
// Our own temp profile, found by its owner.json, so a browser child that holds a file a moment longer can't leave it behind.
const ownProfiles = () => { try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('pwa-check-')).map(n => path.join(os.tmpdir(), n))
  .filter(d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'owner.json'), 'utf8')).node === process.pid; } catch { return false; } }); } catch { return []; } };
const b = await launch().catch(e => fail(e.message));
const mine = ownProfiles();
try { await run(); }
catch (e) { R.error = e.message; }
finally {
  await b.close(); srv?.close();
  for (let i = 0; i < 20 && mine.some(d => fs.existsSync(d)); i++) { await sleep(500); mine.forEach(rmDir); }
}
if (R.error && !R.page) fail(R.error);
report();

async function run() {
  const ver = await b.send('Browser.getVersion');
  R.browser = ver.product; UA = ver.userAgent.replace(/Headless/g, '');
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p = {}) => b.send(m, p, sessionId);
  const P = { loaded: false, inflight: 0, lastNet: 0, docs: new Map(), swServed: 0, console: [], swErrors: [] };
  b.on(m => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    switch (m.method) {
      case 'Network.requestWillBeSent': if (!p.redirectResponse) P.inflight++; P.lastNet = Date.now(); break;
      case 'Network.responseReceived':
        if (p.type === 'Document') P.docs.set(p.loaderId, { status: p.response.status, url: p.response.url, fromSW: !!p.response.fromServiceWorker, mime: p.response.mimeType });
        if (p.response.fromServiceWorker) P.swServed++;
        break;
      case 'Network.dataReceived': P.lastNet = Date.now(); break;
      case 'Network.loadingFinished': case 'Network.loadingFailed': P.inflight--; P.lastNet = Date.now(); break;
      case 'Page.loadEventFired': P.loaded = true; break;
      case 'Runtime.exceptionThrown': P.console.push('Uncaught ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text).split('\n')[0]); break;
      case 'Runtime.consoleAPICalled': if (['error', 'warning'].includes(p.type)) P.console.push(p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)); break;
      case 'Log.entryAdded': if (['error', 'warning'].includes(p.entry.level)) P.console.push(p.entry.text.slice(0, 300)); break;
      case 'ServiceWorker.workerErrorReported': P.swErrors.push(`${p.errorMessage.errorMessage} (${short(p.errorMessage.sourceURL)}:${p.errorMessage.lineNumber})`); break;
    }
  });
  await Promise.all(['Network.enable', 'Page.enable', 'Runtime.enable', 'Log.enable'].map(m => s(m)));
  await s('ServiceWorker.enable').catch(() => {});
  const ev = async (expression, ms = 30000) => {
    const r = await withTimeout(s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), ms).catch(() => null);
    return r && !r.exceptionDetails ? r.result.value : undefined;
  };
  const nav = async (url, quiet = 700) => {
    P.loaded = false; P.inflight = 0; P.lastNet = Date.now(); P.swServed = 0;
    const t0 = Date.now();
    let r; try { r = await withTimeout(s('Page.navigate', { url }), 30000, 'navigation timed out'); } catch (e) { return { url, error: e.message }; }
    if (r.errorText) { await sleep(300); return { url, error: r.errorText }; }
    while (Date.now() - t0 < 30000) {
      const idle = Date.now() - P.lastNet;
      if (P.loaded && idle > quiet && (P.inflight <= 0 || idle > 2500)) break;
      await sleep(100);
    }
    const d = P.docs.get(r.loaderId) || {};
    return { url, status: d.status ?? null, finalUrl: d.url || url, fromSW: !!d.fromSW, swServed: P.swServed, ms: Date.now() - t0 };
  };
  const look = () => ev(`(() => { const t = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    return { href: location.href, title: document.title, text: t.slice(0, 120), textLen: t.length,
      media: document.querySelectorAll('img,svg,canvas,video').length, controlled: !!navigator.serviceWorker?.controller }; })()`);

  dbg("browser ready");
  // 1. load the page
  const first = await nav(pageUrl);
  if (first.error) throw new Error(`could not load ${pageUrl}: ${first.error}`);
  const dom = await ev(`(() => {
    const meta = n => document.querySelector('meta[name="' + n + '" i]')?.getAttribute('content') ?? null;
    const scripts = [...document.scripts];
    return {
      href: location.href, title: document.title, secure: isSecureContext, swSupported: 'serviceWorker' in navigator,
      manifests: [...document.querySelectorAll('link[rel~="manifest" i]')].map(l => ({ href: l.href, raw: l.getAttribute('href'), crossorigin: l.getAttribute('crossorigin') })),
      viewport: meta('viewport'), themeColor: meta('theme-color'),
      appleIcons: [...document.querySelectorAll('link[rel~="apple-touch-icon" i],link[rel~="apple-touch-icon-precomposed" i]')].map(l => ({ href: l.href, sizes: l.getAttribute('sizes') || '' })),
      appleCapable: meta('apple-mobile-web-app-capable'), mobileCapable: meta('mobile-web-app-capable'), appleTitle: meta('apple-mobile-web-app-title'),
      links: [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href.split('#')[0]))].filter(h => h.startsWith(location.origin)).slice(0, 300),
      scriptSrcs: scripts.map(x => x.src).filter(Boolean).slice(0, 20),
      inline: scripts.filter(x => !x.src).map(x => x.textContent).join('\\n').slice(0, 300000),
    };
  })()`);
  if (!dom) throw new Error('could not read the page');
  const docUrl = dom.href;
  R.page = { url: docUrl, status: first.status, title: dom.title };
  if (first.status >= 400) F(INSTALL, 'page-status', `the page itself returned HTTP ${first.status}`);
  pageFetch = url => ev(`fetch(${JSON.stringify(url)}, { cache: 'no-store' }).then(async r => {
    const b = new Uint8Array(await r.arrayBuffer()); let s = '';
    for (let i = 0; i < Math.min(b.length, 8e6); i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return { ok: r.ok, status: r.status, url: r.url, redirected: r.redirected, ct: r.headers.get('content-type') || '', b64: btoa(s) };
  }).catch(() => null)`, 20000);

  dbg("page loaded", first.ms + "ms");
  // 2. HTTPS + viewport
  const proto = new URL(docUrl).protocol;
  R.https = proto === 'https:' || isLocal(docUrl);
  if (proto === 'https:') F(PASS, 'https', 'served over HTTPS');
  else if (isLocal(docUrl)) F(PASS, 'https', `served from ${new URL(docUrl).hostname}, which browsers treat as secure (the live site must use HTTPS)`);
  else F(INSTALL, 'not-https', `served over ${proto.slice(0, -1)}: browsers only install PWAs (and only register service workers) on HTTPS or localhost`, 'serve the site over HTTPS and redirect http:// to https://');
  if (!dom.viewport) F(WARN, 'no-viewport', 'no <meta name="viewport">: the installed app renders a zoomed-out desktop page on phones', 'add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>');
  else if (!/width\s*=\s*device-width/i.test(dom.viewport)) F(WARN, 'viewport-width', `viewport is "${dom.viewport}" without width=device-width`, 'use <meta name="viewport" content="width=device-width, initial-scale=1">');
  else F(PASS, 'viewport', 'viewport meta set (width=device-width)');

  // 3. Chrome's own verdict
  R.chrome = { available: false };
  try {
    const m = await withTimeout(s('Page.getAppManifest', {}), 20000);
    R.chrome.available = true;
    R.chrome.manifestUrl = m.url || null;
    R.chrome.parseErrors = (m.errors || []).map(e => `${e.message} (line ${e.line}, column ${e.column})`);
    R.chrome.parsed = m.manifest ? { startUrl: m.manifest.startUrl, scope: m.manifest.scope, id: m.manifest.id, display: m.manifest.display } : null;
  } catch (e) { R.chrome.error = `Page.getAppManifest: ${e.message}`; }
  try {
    const r = await withTimeout(s('Page.getInstallabilityErrors'), 30000);
    R.chrome.available = true;
    R.chrome.errors = r.installabilityErrors.map(e => ({ id: e.errorId, message: chromeMsg(e) }));
    // Android-only WebAPK rule; folder mode always runs on a port
    if (R.mode === 'folder' || isLocal(docUrl)) R.chrome.errors = R.chrome.errors.filter(e => e.id !== 'url-not-supported-for-webapk');
    R.chrome.installable = R.chrome.errors.length === 0;
  } catch (e) { R.chrome.error = [R.chrome.error, `Page.getInstallabilityErrors: ${e.message}`].filter(Boolean).join('; '); }

  dbg("chrome verdict");
  // 4. manifest
  const M = await checkManifest(dom, docUrl, s);
  const start = M?.start || docUrl, scope = M?.scope || dirOf(start);

  dbg("manifest checked");
  // 5. iOS home screen (Safari reads these tags; since iOS 26 every Home Screen site opens as a web app by default)
  R.ios = { appleTouchIcons: dom.appleIcons, appleMobileWebAppCapable: dom.appleCapable, mobileWebAppCapable: dom.mobileCapable, appleMobileWebAppTitle: dom.appleTitle };
  if (dom.appleIcons.length) {
    const a = dom.appleIcons.find(i => /180/.test(i.sizes)) || dom.appleIcons[0];
    const r = await get(a.href), im = imageSize(r.buf);
    if (!r.ok) F(WARN, 'apple-touch-icon-fetch', `apple-touch-icon ${short(a.href)} returns ${r.status || r.error}`, 'fix the path or upload the file');
    else if (im.type !== 'png') F(WARN, 'apple-touch-icon-type', `apple-touch-icon ${short(a.href)} is ${im.type}, not PNG: iOS ignores SVG here`, 'use a 180×180 PNG');
    else if (im.w < 180) F(WARN, 'apple-touch-icon-small', `apple-touch-icon is ${im.w}×${im.h}: iPhones use 180×180 and scale smaller icons up (blurry)`, 'use a 180×180 PNG with no transparency');
    else F(PASS, 'apple-touch-icon', `apple-touch-icon ${short(a.href)} (${im.w}×${im.h} PNG) for iPhone/iPad home screens`);
  } else F(WARN, 'no-apple-touch-icon', 'no <link rel="apple-touch-icon">: iOS falls back to the manifest icons or a screenshot of the page', 'add <link rel="apple-touch-icon" href="/apple-touch-icon.png"> (180×180 PNG, opaque background)');

  // 6. service worker
  const SW = R.serviceWorker = { supported: dom.swSupported, registered: false };
  const sources = [dom.inline];
  for (const src of dom.scriptSrcs.filter(u => new URL(u).origin === new URL(docUrl).origin).slice(0, 10)) { const r = await get(src, 5e6); if (r.ok) sources.push(r.buf.toString('utf8')); }
  const regCall = sources.join('\n').match(/serviceWorker\s*\.\s*register\(\s*(?:new URL\(\s*)?['"`]([^'"`]+)['"`]/);
  SW.registerCall = regCall?.[1] || null;
  if (!dom.swSupported) {
    F(OFFLINE, 'sw-unsupported', 'service workers are unavailable on this page (not a secure context), so nothing can work offline', 'serve over HTTPS');
  } else {
    const st = await ev(`(async () => {
      const t = ms => new Promise(r => setTimeout(r, ms)), t0 = Date.now();
      const pick = async () => { const rs = await navigator.serviceWorker.getRegistrations(); return rs.sort((a, b) => b.scope.length - a.scope.length).find(r => location.href.startsWith(r.scope)) || rs[0] || null; };
      let reg = null;
      while (!(reg = await pick()) && Date.now() - t0 < ${SW.registerCall || /serviceWorker/.test(sources.join('')) ? 8000 : 2500}) await t(250);
      if (!reg) return { registered: false };
      while (!(reg.active && reg.active.state === 'activated') && Date.now() - t0 < 25000) { await t(250); if (!reg.installing && !reg.waiting && !reg.active) break; }
      const w = reg.active || reg.waiting || reg.installing;
      return { registered: true, scope: reg.scope, scriptURL: w?.scriptURL || null, state: w?.state || 'redundant', scopes: (await navigator.serviceWorker.getRegistrations()).map(r => r.scope) };
    })()`, 40000);
    Object.assign(SW, st || {});
    SW.errors = [...new Set([...P.swErrors, ...P.console.filter(c => /service ?worker/i.test(c))])].slice(0, 5);
    if (!SW.registered) {
      if (SW.registerCall) {
        const swUrl = new URL(SW.registerCall, docUrl).href, r = await get(swUrl);
        const why = !r.ok ? `${short(swUrl)} returns ${r.status || r.error}` : !/javascript|ecmascript/.test(r.ct) ? `${short(swUrl)} is served as "${r.ct || 'no content-type'}"; service workers need a JavaScript MIME type` : SW.errors[0] || 'registration failed, or it only runs later than ~8 s after load or after a user action';
        F(OFFLINE, 'sw-not-registered', `the page calls serviceWorker.register('${SW.registerCall}') but no service worker got registered: ${why}`, 'open DevTools > Application > Service workers, fix the error, and make sure the file is deployed next to the page');
      } else F(OFFLINE, 'no-service-worker', 'no service worker registered: nothing works offline (Chrome no longer needs one to install, but offline launch does)', "add sw.js with install/activate/fetch handlers and register it: navigator.serviceWorker.register('/sw.js')");
    }
  }

  if (SW.registered) {
    if (SW.state !== 'activated') F(OFFLINE, 'sw-not-activated', `the service worker is stuck in state "${SW.state}"${SW.errors.length ? ': ' + SW.errors[0] : ' (install failed: often cache.addAll() with a file that 404s)'}`, 'check every URL in the precache list returns 200; a single 404 fails the whole install');
    // reload: does it control the page now?
    const re = await nav(pageUrl);
    const lk = await look();
    SW.controlsAfterReload = !!lk?.controlled; SW.servedOnReload = re.swServed;
    if (SW.controlsAfterReload) F(PASS, 'sw-controls', `service worker ${short(SW.scriptURL)} (scope ${short(SW.scope)}) controls the page after reload`);
    else F(OFFLINE, 'sw-not-controlling', `service worker ${short(SW.scriptURL)} is registered (scope ${short(SW.scope)}) but does not control ${short(docUrl)} after a reload`, 'register it from a path whose directory covers the page (e.g. /sw.js for the whole site), or set scope and the Service-Worker-Allowed header');
    if (within(start, SW.scope)) F(PASS, 'sw-scope', `service worker scope ${short(SW.scope)} covers start_url ${short(start)}`);
    else F(OFFLINE, 'sw-scope-misses-start-url', `service worker scope ${short(SW.scope)} does not cover start_url ${short(start)}: the installed app launches without it`, 'serve sw.js from the site root (scope "/") or move start_url inside the scope');
    await analyzeSW(SW, re.swServed);
  }

  dbg("service worker checked");
  // 7. offline test
  if (SW.registered && SW.state === 'activated') {
    const on = await nav(start);
    const startOnline = await look();
    let page2 = PAGE2 ? new URL(PAGE2, docUrl).href : null;
    if (!page2) {
      const lk2 = await ev(`[...new Set([...document.querySelectorAll('a[href]')].map(a => a.href.split('#')[0]))].filter(h => h.startsWith(location.origin)).slice(0, 300)`) || [];
      const seen = new Set([start, docUrl].map(u => new URL(u).origin + new URL(u).pathname));
      page2 = [...dom.links, ...lk2].find(h => { const u = new URL(h); return within(h, scope) && !seen.has(u.origin + u.pathname) && /(\/|\.html?|\/[^./]+)$/.test(u.pathname) && !/\/(api|logout|signout|admin)\b/i.test(u.pathname); })
        || (!seen.has(scope) ? scope : null);
    }
    const O = R.offline = { start: short(start), startOnline: { status: on.status, rendered: !!startOnline && !startOnline.href.startsWith('chrome-error') }, page2: page2 ? short(page2) : null };
    // Emulation is per target: the page AND each service worker (whose own fetch() calls would otherwise still reach
    // the network and make a network-first worker look offline-capable). Network traffic seen from the worker while
    // offline means the emulation leaked.
    const swSessions = [], net = { swNetwork: [], swBlocked: 0 };
    let offlineNow = false;
    const offNet = b.on(m => {
      if (!offlineNow || !swSessions.includes(m.sessionId)) return;
      const r = m.params.response;
      if (m.method === 'Network.responseReceived' && /^https?:/.test(r.url) && r.status > 0 && !r.fromDiskCache && !r.fromServiceWorker) net.swNetwork.push(short(r.url));
      if (m.method === 'Network.loadingFailed' && /INTERNET_DISCONNECTED/.test(m.params.errorText)) net.swBlocked++;
    });
    const setOffline = async off => {
      const cond = { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
      if (off) {
        const { targetInfos } = await b.send('Target.getTargets');
        for (const t of targetInfos.filter(t => t.type === 'service_worker')) {
          try { const { sessionId: sid } = await b.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }); await b.send('Network.enable', {}, sid); swSessions.push(sid); } catch {}
        }
      }
      for (const sid of [sessionId, ...swSessions]) {
        await b.send('Network.emulateNetworkConditions', cond, sid).catch(async () => {
          await b.send('Network.overrideNetworkState', cond, sid).catch(() => {});
          await b.send('Network.emulateNetworkConditionsByRule', { emulateOfflineServiceWorker: off, matchedNetworkConditions: [{ urlPattern: '', ...cond }] }, sid).catch(() => {});
        });
        await b.send('Network.setCacheDisabled', { cacheDisabled: off }, sid).catch(() => {});
      }
      if (off) { offlineNow = true; if (srv) srv.log.offline = true; }
    };
    const tryOffline = async url => {
      const n = await nav(url, 1000), lk = n.error ? null : await look();
      const state = n.error || !lk || lk.href.startsWith('chrome-error') ? 'error-page' : lk.textLen || lk.media ? 'ok' : 'blank';
      return { url: short(url), state, error: n.error || null, status: n.status, fromSW: n.fromSW, title: lk?.title || '', text: lk?.text || '' };
    };
    await setOffline(true);
    try {
      O.startOffline = await tryOffline(start);
      if (page2) O.page2Offline = await tryOffline(page2);
    } finally {
      // leave the error page first: Chrome's offline error page reloads itself as soon as the network is back
      offlineNow = false; if (srv) srv.log.offline = false;
      await withTimeout(s('Page.navigate', { url: 'about:blank' }), 5000).catch(() => {});
      await setOffline(false); offNet();
    }
    // the browser's own update check for the service worker script is not covered by emulation; it can't make a page render
    const swPath = new URL(SW.scriptURL || docUrl).pathname, hits = srv ? srv.log.hits.filter(h => h !== swPath) : [];
    O.serverHitsWhileOffline = srv ? hits.length : null; O.swNetworkWhileOffline = net.swNetwork.length; O.swFetchesBlocked = net.swBlocked;
    const leaked = [...new Set([...hits, ...net.swNetwork])];
    if (leaked.length) F(WARN, 'offline-emulation-leaked', `${leaked.length} request(s) still reached the network during the offline test (${leaked.slice(0, 3).join(', ')}): offline results may be too optimistic`);
    // an SPA has the same <title> on every route, so the second page is described by its text
    const desc = (r, byText) => r.state === 'ok' ? `renders "${((byText ? r.text : r.title) || r.text).slice(0, 60)}"${r.status ? ` (HTTP ${r.status}${r.fromSW ? ' from the service worker' : ''})` : ''}` : r.state === 'blank' ? 'loads but renders a blank page' : `shows the browser's offline error (${r.error || 'chrome-error page'})`;
    const S = O.startOffline;
    if (S.state === 'ok') F(PASS, 'offline-start-url', `offline: start_url ${S.url} ${desc(S)}`);
    else F(OFFLINE, S.state === 'blank' ? 'offline-start-url-blank' : 'offline-start-url-fails', `offline: start_url ${S.url} ${desc(S)}`,
      S.state === 'blank' ? 'the HTML came back but its scripts/styles did not: precache the JS/CSS bundles too (or use Workbox precaching from your build tool)'
        : 'in the fetch handler, answer navigations from the cache when the network fails, and precache start_url on install: e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then(r => r || caches.match("/"))))');
    if (O.page2Offline) {
      const T = O.page2Offline;
      if (T.state === 'ok') F(PASS, 'offline-page2', `offline: ${T.url} (not opened before going offline) ${desc(T, T.title === S.title)}`);
      else F(WARN, 'offline-page2-fails', `offline: ${T.url}, an in-scope page not opened before going offline, ${desc(T)}`, 'add a navigation fallback: when a navigation fails offline, return the cached app shell (SPA) or an offline.html page');
    } else if (S.state === 'ok') O.page2Note = 'no second in-scope page found; pass --page2 /path to test one';
  } else if (!SW.registered) R.offline = { skipped: 'no service worker' };
}

async function checkManifest(dom, docUrl, s) {
  if (!dom.manifests.length) {
    F(INSTALL, 'no-manifest-link', 'the page has no <link rel="manifest">', 'add <link rel="manifest" href="/manifest.webmanifest"> to the <head> of every page');
    return null;
  }
  if (dom.manifests.length > 1) F(WARN, 'multiple-manifests', `${dom.manifests.length} <link rel="manifest"> tags: browsers use only the first (${short(dom.manifests[0].href)})`, 'keep one');
  const link = dom.manifests[0], mUrl = link.href;
  const info = R.manifest = { url: mUrl };
  const r = await get(mUrl);
  info.status = r.status; info.contentType = r.ct;
  if (!r.ok) { F(INSTALL, 'manifest-fetch', `manifest ${short(mUrl)} returns ${r.status || r.error}`, `make sure ${new URL(mUrl).pathname} is deployed and public (browsers fetch it without cookies)`); return null; }
  if (new URL(r.url).origin !== new URL(docUrl).origin && !(await get(mUrl, 1e6, { origin: new URL(docUrl).origin })).acao) F(INSTALL, 'manifest-cors', `manifest is on another origin (${new URL(r.url).origin}) without Access-Control-Allow-Origin: browsers fetch it in CORS mode and get blocked`, 'serve the manifest from the same origin as the page, or add Access-Control-Allow-Origin');
  let M; const text = r.buf.toString('utf8').replace(/^\uFEFF/, '');
  try { M = JSON.parse(text); if (!M || typeof M !== 'object' || Array.isArray(M)) throw new Error('top level is not a JSON object'); }
  catch (e) {
    const looksHtml = /^\s*</.test(text);
    F(INSTALL, 'manifest-invalid-json', `manifest ${short(mUrl)} is not valid JSON: ${looksHtml ? 'the server returned an HTML page (usually a SPA fallback or 404 page)' : e.message}`, looksHtml ? `put the manifest file at ${new URL(mUrl).pathname} (in Vite: public/)` : 'fix the syntax (trailing commas and comments are not allowed in JSON)');
    return null;
  }
  if (/manifest\+json|application\/json/.test(r.ct)) F(PASS, 'manifest', `manifest ${short(mUrl)} fetched (${r.ct.split(';')[0]}) and parsed`);
  else F(WARN, 'manifest-content-type', `manifest is served as "${r.ct || 'no content-type'}"`, 'serve it as application/manifest+json (or application/json)');
  info.json = M;
  const docOrigin = new URL(docUrl).origin;

  // name
  const str = v => typeof v === 'string' && v.trim() ? v.trim() : null;
  const name = str(M.name), shortName = str(M.short_name);
  if (!name && !shortName) F(INSTALL, 'manifest-no-name', 'manifest has neither name nor short_name', 'add "name": "My App" and "short_name": "MyApp"');
  else {
    F(PASS, 'name', `name "${name || shortName}"${shortName ? `, short_name "${shortName}"` : ''}`);
    const label = shortName || name;
    if (label.length > 12) F(WARN, 'short-name-long', `${shortName ? 'short_name' : 'name (no short_name)'} "${label}" is ${label.length} characters: launchers cut home-screen labels at about 12`, 'add a "short_name" of 12 characters or fewer');
  }

  // start_url
  let start = docUrl;
  if (M.start_url === undefined) F(WARN, 'start-url-missing', 'no start_url: web.dev lists it as required; Chrome falls back to the page the user installed from, so the app opens wherever they happened to be', 'add "start_url": "/"');
  else {
    let su = null; try { su = typeof M.start_url === 'string' ? new URL(M.start_url, mUrl) : null; } catch {}
    if (!su) F(WARN, 'start-url-invalid', `start_url ${JSON.stringify(M.start_url)} is not a valid URL: browsers fall back to the page URL`, 'use a path like "/"');
    else if (su.origin !== docOrigin) F(WARN, 'start-url-cross-origin', `start_url ${su.href} is on another origin: browsers ignore it and use the page URL`, 'use a same-origin path like "/"');
    else start = su.href;
  }
  start = start.split('#')[0];
  // scope
  let scope = dirOf(start);
  if (M.scope !== undefined) {
    let sc = null; try { sc = typeof M.scope === 'string' ? new URL(M.scope, mUrl) : null; } catch {}
    if (!sc) F(WARN, 'scope-invalid', `scope ${JSON.stringify(M.scope)} is not a valid URL: browsers use ${short(scope)}`);
    else if (sc.origin !== docOrigin) F(WARN, 'scope-cross-origin', `scope ${sc.href} is on another origin: browsers ignore it and use ${short(scope)}`);
    else if (!within(start, sc.href)) F(WARN, 'start-url-out-of-scope', `start_url ${short(start)} is outside scope ${short(sc.href)}, which makes the scope invalid: browsers ignore it and fall back to ${short(scope)} (the start_url's folder)`, new URL(start).pathname + '/' === sc.pathname ? `make start_url "${sc.pathname}" (with the trailing slash)` : `move start_url inside the scope, or widen scope (e.g. "scope": "/")`);
    else scope = new URL(sc.pathname, sc.origin).href;
  }
  info.start = start; info.scope = scope;
  if (R.chrome?.parsed?.startUrl && R.chrome.parsed.startUrl.split('#')[0] !== start) info.chromeStartUrl = R.chrome.parsed.startUrl;
  const sr = await get(start);
  info.startStatus = sr.status;
  if (!sr.ok) F(OFFLINE, 'start-url-status', `start_url ${short(start)} returns ${sr.status || sr.error}: the installed app opens on an error page`, R.mode === 'folder' && !SPA && !path.extname(new URL(start).pathname) ? 'add the file, or re-run with --spa if your host serves index.html for every route' : 'make start_url a page that exists, e.g. "/"');
  else {
    if (new URL(sr.url).origin !== docOrigin) F(WARN, 'start-url-redirect', `start_url ${short(start)} redirects to another origin (${sr.url})`);
    else if (!within(sr.url, scope)) F(WARN, 'start-url-redirect-out-of-scope', `start_url ${short(start)} redirects to ${short(sr.url)}, outside scope ${short(scope)}: the app shows a browser address bar there`);
    else F(PASS, 'start-url', `start_url ${short(start)} is in scope ${short(scope)} and returns ${sr.status}`);
  }

  // display
  const DISPLAYS = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
  const rawDisplay = typeof M.display === 'string' ? M.display.trim() : M.display;
  let display = DISPLAYS.includes(rawDisplay) ? rawDisplay : 'browser';
  let via = 'display';
  if (Array.isArray(M.display_override)) {
    const first = M.display_override.find(d => [...DISPLAYS, 'window-controls-overlay'].includes(d));
    if (first) { display = first; via = 'display_override'; }
  }
  if (display === 'browser') F(INSTALL, 'display', via === 'display_override' ? 'the first display_override value is "browser"' : rawDisplay === undefined ? 'no display member: it defaults to "browser", which Chrome does not install' : `display is ${JSON.stringify(rawDisplay)}${DISPLAYS.includes(rawDisplay) ? '' : ' (not a valid value, so it counts as "browser")'}: Chrome only installs standalone, fullscreen or minimal-ui`, 'set "display": "standalone"');
  else F(PASS, 'display', `display "${display}"${via === 'display_override' ? ' (from display_override)' : ''}`);

  // colors (validated by the browser's own CSS parser)
  const colors = await s('Runtime.evaluate', { expression: `(${JSON.stringify([M.theme_color, M.background_color])}).map(c => typeof c === 'string' && CSS.supports('color', c))`, returnByValue: true }).then(x => x.result.value).catch(() => [true, true]);
  const themeWhy = dom.themeColor ? `the page's <meta name="theme-color"> colors the open app, but the Android splash screen and install UI read the manifest` : 'it colors the app title bar and the Android status bar';
  for (const [k, okc, why] of [['theme_color', colors[0], themeWhy], ['background_color', colors[1], 'it is the splash-screen background while the app starts']]) {
    if (M[k] === undefined) F(WARN, `${k.replace('_', '-')}-missing`, `no ${k}: ${why}`, `add "${k}": "${k === 'theme_color' && dom.themeColor ? dom.themeColor : '#ffffff'}"`);
    else if (!okc) F(WARN, `${k.replace('_', '-')}-invalid`, `${k} ${JSON.stringify(M[k])} is not a valid CSS color`);
    else F(PASS, k.replace('_', '-'), `${k} ${M[k]}`);
  }
  // id
  if (M.id === undefined) F(WARN, 'id-missing', `no id: Chrome derives the app identity from start_url, so changing start_url later creates a second, separate app`, `add "id": "${new URL(start).pathname + new URL(start).search}" (this keeps existing installs)`);
  else { let id = null; try { id = typeof M.id === 'string' ? new URL(M.id, new URL(start).origin) : null; } catch {}
    if (!id) F(WARN, 'id-invalid', `id ${JSON.stringify(M.id)} is invalid: browsers use start_url instead`);
    else if (id.origin !== new URL(start).origin) F(WARN, 'id-cross-origin', `id ${id.href} is on another origin than start_url: browsers ignore it and use start_url`, 'use a root-relative id like "/"');
    else F(PASS, 'id', `id ${short(id.href.split('#')[0])}`); }
  // Android-only rule: desktop Chrome ignores it (and so does the desktop verdict above)
  if (M.prefer_related_applications === true) F(WARN, 'prefer-related-applications', `prefer_related_applications is true: Chrome on Android won't offer to install the web app and points users to the store app${Array.isArray(M.related_applications) && M.related_applications.length ? '' : ' (and related_applications is empty)'}; desktop Chrome ignores it`, 'remove it or set it to false if the web app should be installable on Android');
  if (!str(M.description)) F(WARN, 'description-missing', 'no description: Chrome\'s richer install dialog shows it next to the screenshots', 'add a one- or two-sentence "description" (shown up to ~7 lines)');

  // icons
  const icons = Array.isArray(M.icons) ? M.icons.filter(i => i && typeof i.src === 'string').slice(0, 30) : [];
  info.icons = [];
  if (!icons.length) F(INSTALL, 'no-icons', 'manifest has no icons', 'add 192×192 and 512×512 PNG icons, plus a maskable one');
  const PURPOSES = ['any', 'maskable', 'monochrome'];
  const toUrl = src => { try { return new URL(src, mUrl).href; } catch { return null; } };
  const fetched = await Promise.all(icons.map(ic => toUrl(ic.src) ? get(toUrl(ic.src)) : null));
  for (const [k, ic] of icons.entries()) {
    const url = toUrl(ic.src);
    const sizes = typeof ic.sizes === 'string' ? ic.sizes.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
    const purposes = typeof ic.purpose === 'string' && ic.purpose.trim() ? ic.purpose.trim().split(/\s+/) : ['any'];
    const rec = { src: ic.src, sizes: sizes.join(' '), purpose: purposes.join(' '), type: ic.type || null };
    info.icons.push(rec);
    if (!url) { F(WARN, 'icon-src-invalid', `icon src ${JSON.stringify(ic.src)} is not a valid URL`); continue; }
    const r = fetched[k]; rec.status = r.status; rec.ok = r.ok;
    const real = r.ok ? imageSize(r.buf) : { type: null };
    Object.assign(rec, { realType: real.type, w: real.w, h: real.h });
    const label = short(url);
    if (!r.ok) { F(WARN, 'icon-fetch', `icon ${label} returns ${r.status || r.error}`, 'upload the file or fix the src path (relative paths resolve against the manifest URL)'); continue; }
    if (!real.type || ['html', 'unknown'].includes(real.type)) { F(WARN, 'icon-not-image', `icon ${label} is not an image (${real.type === 'html' ? 'an HTML page came back' : r.ct})`, 'fix the src path'); rec.broken = true; continue; }
    const bad = purposes.filter(p => !PURPOSES.includes(p));
    if (bad.length) F(WARN, 'icon-purpose-invalid', `icon ${label} has unknown purpose ${bad.map(x => `"${x}"`).join(', ')}${bad.length === purposes.length ? ': browsers ignore this icon' : ''}`, 'purpose must be "any", "maskable" or "monochrome" (lowercase, space-separated)');
    if (purposes.includes('any') && purposes.includes('maskable')) rec.anyMaskable = true;
    if (!sizes.length) F(WARN, 'icon-sizes-missing', `icon ${label} has no sizes: Chrome skips icons without sizes when choosing the install icon`, real.w ? `add "sizes": "${real.w}x${real.h}"` : 'add "sizes": "any" for SVG');
    if (ic.type && MIME[real.type] && ic.type.toLowerCase() !== MIME[real.type] && !(real.type === 'ico' && /icon/.test(ic.type))) F(WARN, 'icon-type-mismatch', `icon ${label} declares type ${ic.type} but the file is ${real.type.toUpperCase()}`, `set "type": "${MIME[real.type]}" or convert the file`);
    if (real.w && real.type !== 'svg') {
      if (sizes.length && !sizes.includes(`${real.w}x${real.h}`)) F(WARN, 'icon-size-mismatch', `icon ${label} declares sizes "${sizes.join(' ')}" but the file is ${real.w}×${real.h}`, `re-export the image at ${sizes[0].replace('x', '×')}, or change sizes to "${real.w}x${real.h}"`);
      if (real.w !== real.h) F(WARN, 'icon-not-square', `icon ${label} is ${real.w}×${real.h}, not square: Chrome only uses square icons`);
    }
  }
  const okIcons = info.icons.filter(i => i.ok && i.realType && !['html', 'unknown'].includes(i.realType) && !i.broken);
  const fits = i => i.purpose.split(' ').includes('any') && ['png', 'svg', 'webp'].includes(i.realType)
    && i.sizes.split(' ').some(z => z === 'any' || (/^(\d+)x\1$/.test(z) && +z.split('x')[0] >= 144));
  if (icons.length) {
    const usable = okIcons.filter(fits);
    if (!usable.length) F(INSTALL, 'no-usable-icon', 'no icon Chrome can install with: it needs a square PNG, SVG or WebP icon of at least 144px that downloads, has sizes set, and has purpose "any" (or no purpose)', 'add { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }');
    // web.dev/MDN list 192 and 512; a bigger icon scales down fine, a smaller one gets blurry when scaled up
    const anyIcons = okIcons.filter(i => i.purpose.split(' ').includes('any'));
    const vector = anyIcons.find(i => i.realType === 'svg' && i.sizes.split(' ').includes('any'));
    const raster = anyIcons.filter(i => i.w && i.realType !== 'svg' && i.w === i.h);
    const largest = raster.reduce((m, i) => Math.max(m, i.w), 0);
    for (const px of [192, 512]) {
      const exact = raster.find(i => i.w === px);
      if (exact) F(PASS, `icon-${px}`, `${px}×${px} icon present and the file really is ${px}×${px}`);
      else if (largest > px || vector) F(PASS, `icon-${px}`, `no exact ${px}×${px} icon, but the ${largest > px ? `${largest}×${largest}` : 'SVG'} icon scales down to it`);
      else {
        const why = okIcons.some(i => i.sizes.split(' ').includes(`${px}x${px}`) && i.w && i.w !== px) ? ' (one is declared, but the file has a different size)'
          : okIcons.some(i => i.w === px) ? ' with purpose "any" (only a maskable one)' : '';
        F(WARN, `icon-${px}-missing`, `no icon of ${px}×${px} or larger${why}${largest ? `; the largest is ${largest}×${largest}, which gets blurry when scaled up` : ''}: web.dev and MDN list 192 and 512 as required (Chrome itself only insists on 144px)`,
          `add { "src": "/icon-${px}.png", "sizes": "${px}x${px}", "type": "image/png" }`);
      }
    }
    const masks = okIcons.filter(i => i.purpose.split(' ').includes('maskable'));
    if (!masks.length) F(WARN, 'no-maskable-icon', 'no maskable icon: Android shows your icon shrunk inside a white circle or squircle', 'add a 512×512 PNG with the logo inside the central 80% safe zone and "purpose": "maskable" (maskable.app checks it)');
    else F(PASS, 'maskable-icon', `maskable icon present (${short(new URL(masks[0].src, mUrl).href)})`);
    const am = info.icons.filter(i => i.anyMaskable);
    if (am.length) F(WARN, 'icon-any-maskable', `${am.map(i => i.src).join(', ')} use "purpose": "any maskable": one image can't suit both, so it looks too small (any) or gets its edges cropped (maskable); Chrome DevTools warns about this too`, 'ship two files: a normal icon with "purpose": "any" and a padded one with "purpose": "maskable"');
  }

  // screenshots for the richer install dialog
  const shots = Array.isArray(M.screenshots) ? M.screenshots.filter(x => x && typeof x.src === 'string') : [];
  info.screenshots = [];
  if (!shots.length) F(WARN, 'no-screenshots', 'no screenshots: Chrome shows its small basic install prompt instead of the richer install dialog (Android 94+, desktop 108+)', 'add "screenshots" with at least one { "form_factor": "wide" } (desktop) and one { "form_factor": "narrow" } (mobile), PNG or JPEG, 320–3840 px, long side at most 2.3× the short side');
  else {
    const ratios = { wide: new Set(), narrow: new Set() };
    const list = shots.slice(0, 8), got = await Promise.all(list.map(sh => toUrl(sh.src) ? get(toUrl(sh.src)) : null));
    for (const [k, sh] of list.entries()) {
      const url = toUrl(sh.src), r = got[k]; if (!url) continue;
      const real = r.ok ? imageSize(r.buf) : {};
      const ff = sh.form_factor === 'wide' || sh.form_factor === 'narrow' ? sh.form_factor : null;
      info.screenshots.push({ src: sh.src, form_factor: sh.form_factor || null, status: r.status, ok: r.ok, type: real.type, w: real.w, h: real.h });
      const label = short(url);
      if (!r.ok) { F(WARN, 'screenshot-fetch', `screenshot ${label} returns ${r.status || r.error}`); continue; }
      if (!['png', 'jpeg'].includes(real.type)) F(WARN, 'screenshot-type', `screenshot ${label} is ${real.type}: Chrome's docs list only PNG and JPEG`);
      if (real.w) {
        const lo = Math.min(real.w, real.h), hi = Math.max(real.w, real.h);
        if (lo < 320 || hi > 3840) F(WARN, 'screenshot-size', `screenshot ${label} is ${real.w}×${real.h}: each side must be 320–3840 px or Chrome skips it`);
        if (hi / lo > 2.3) F(WARN, 'screenshot-ratio', `screenshot ${label} is ${real.w}×${real.h}: the long side may be at most 2.3× the short side`);
        if (typeof sh.sizes === 'string' && sh.sizes.trim() && !sh.sizes.toLowerCase().split(/\s+/).includes(`${real.w}x${real.h}`)) F(WARN, 'screenshot-size-mismatch', `screenshot ${label} declares sizes "${sh.sizes}" but the file is ${real.w}×${real.h}`);
        if (ff) ratios[ff].add((real.w / real.h).toFixed(3));
        if (ff === 'wide' && real.w < real.h) F(WARN, 'screenshot-orientation', `screenshot ${label} is marked wide but is portrait (${real.w}×${real.h})`);
        if (ff === 'narrow' && real.w > real.h) F(WARN, 'screenshot-orientation', `screenshot ${label} is marked narrow but is landscape (${real.w}×${real.h})`);
      }
    }
    for (const ff of ['wide', 'narrow']) if (ratios[ff].size > 1) F(WARN, 'screenshot-mixed-ratio', `${ff} screenshots have different aspect ratios: Chrome wants one ratio per form_factor`);
    const has = ff => info.screenshots.some(x => x.form_factor === ff && x.ok);
    if (!has('wide')) F(WARN, 'no-wide-screenshot', 'no screenshot with "form_factor": "wide": desktop Chrome shows the basic install prompt', 'add a landscape screenshot (e.g. 1280×720) with "form_factor": "wide"');
    if (!has('narrow') && !info.screenshots.some(x => !x.form_factor && x.ok)) F(WARN, 'no-narrow-screenshot', 'no screenshot with "form_factor": "narrow": Android shows the basic install prompt', 'add a portrait screenshot (e.g. 720×1280) with "form_factor": "narrow"');
    if (has('wide') && (has('narrow') || info.screenshots.some(x => !x.form_factor))) F(PASS, 'screenshots', `screenshots for the richer install dialog (${info.screenshots.length})`);
  }
  return { start, scope };
}

// Static look at the service worker source: fetch handler, cache naming, cleanup
async function analyzeSW(SW, servedOnReload) {
  if (!SW.scriptURL) return;
  const main = await get(SW.scriptURL, 5e6);
  let src = main.buf.toString('utf8');
  if (main.ok && !/javascript|ecmascript/.test(main.ct)) F(WARN, 'sw-content-type', `${short(SW.scriptURL)} is served as "${main.ct}"`);
  // one level of importScripts(), static imports and AMD define([...]) (vite-plugin-pwa / workbox-build output)
  const strs = s => [...s.matchAll(/['"`]([^'"`]+)['"`]/g)].map(x => x[1]);
  const deps = [...src.matchAll(/importScripts\(([^)]*)\)/g)].flatMap(m => strs(m[1]))
    .concat([...src.matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)].map(m => m[1]))
    .concat([...src.matchAll(/\bdefine\(\s*\[([^\]]*)\]/g)].flatMap(m => strs(m[1])).filter(d => /^\.{0,2}\//.test(d)).map(d => /\.m?js$/.test(d) ? d : d + '.js'))
    .slice(0, 6);
  for (const d of deps) { try { const r = await get(new URL(d, SW.scriptURL).href, 5e6); if (r.ok) src += '\n' + r.buf.toString('utf8'); } catch {} }
  const fetchListener = /addEventListener\(\s*['"`]fetch['"`]/.test(src) || /\bonfetch\s*=/.test(src);
  const workbox = /workbox|precacheAndRoute|__WB_MANIFEST/i.test(src);
  // strip comments first, so the handler test needs no nested quantifiers (no catastrophic backtracking)
  const bare = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  const empty = /addEventListener\(\s*['"`]fetch['"`]\s*,\s*(?:(?:async\s+)?function\s*\w*\s*\([^)]*\)|(?:async\s*)?(?:\w+|\([^)]*\))\s*=>)\s*\{\s*\}\s*\)/.test(bare);
  SW.fetchHandler = fetchListener || servedOnReload > 0;
  SW.analysis = { fetchListener, workbox, emptyFetchHandler: empty, servedOnReload };
  if (empty) F(OFFLINE, 'sw-empty-fetch-handler', 'the fetch handler is empty: Chrome skips empty handlers, so nothing is served offline', 'call e.respondWith(...) with a cache fallback, or remove the handler and add real caching');
  else if (!SW.fetchHandler) F(OFFLINE, 'sw-no-fetch-handler', `${short(SW.scriptURL)} has no fetch handler: it never answers requests, so the app cannot load offline`, "add self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => caches.match(e.request))))");
  else if (!servedOnReload && SW.controlsAfterReload) F(WARN, 'sw-fetch-passthrough', 'the service worker has a fetch handler, but it answered none of the page\'s requests on reload (no respondWith for them), so it can\'t make the page load offline', 'call e.respondWith(...) for navigations and the app\'s own JS/CSS, with a cache fallback');
  else F(PASS, 'sw-fetch-handler', `service worker has a fetch handler${servedOnReload ? ` (it answered ${servedOnReload} request(s) on reload)` : ''}`);

  // cache versioning hints (one deploy is all we can see)
  if (/self\.__WB_MANIFEST/.test(src)) F(WARN, 'workbox-manifest-not-injected', 'the deployed service worker still contains self.__WB_MANIFEST: the Workbox injectManifest step did not run, so nothing is precached', 'run the workbox/vite-plugin-pwa build step that injects the precache list');
  const revisioned = /\brevision\s*["']?\s*:\s*["'`][0-9a-f]{6,}/i.test(src) || /precacheAndRoute\s*\(\s*\[/.test(src);
  if (workbox && revisioned) { F(PASS, 'sw-precache-revisions', 'precache entries carry per-file revisions (Workbox-style): changed files are re-fetched on each deploy'); return; }
  const names = new Set(); let dynamic = false;
  for (const m of src.matchAll(/caches\.open\(\s*([^)]+?)\s*\)/g)) {
    const e = m[1].trim(), lit = e.match(/^(['"`])([^'"`$]*)\1$/);
    if (lit) names.add(lit[2]);
    else if (/^[A-Za-z_$][\w$.]*$/.test(e)) {
      const def = src.match(new RegExp(`(?:const|let|var)\\s+${e.split('.').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(['"\`])([^'"\`]*)\\1`));
      if (def && !def[2].includes('${')) names.add(def[2]); else dynamic = true;
    } else dynamic = true;
  }
  SW.analysis.cacheNames = [...names];
  const cacheFirst = /\|\|\s*fetch\(/.test(src) || /if\s*\(\s*\w+\s*\)\s*return\s+\w+\s*;?[\s\S]{0,120}fetch\(/.test(src);
  const networkFirst = /fetch\([^)]*\)[\s\S]{0,600}?\.catch\([\s\S]{0,300}?caches\.match/.test(src);
  SW.analysis.strategy = cacheFirst && !networkFirst ? 'cache-first' : networkFirst && !cacheFirst ? 'network-first' : cacheFirst && networkFirst ? 'mixed' : 'unknown';
  const versioned = n => /v\d|\d{2,}|[0-9a-f]{7,}|\d+\.\d+/i.test(n);
  const flat = [...names].filter(n => !versioned(n));
  if (flat.length) F(WARN, 'cache-name-unversioned', `cache name ${flat.map(n => `"${n}"`).join(', ')} has no version${SW.analysis.strategy === 'cache-first' ? ' and is served cache-first' : ''}: if a deploy changes files but not this name (or sw.js itself), returning users keep the old files, the most common stale-content bug`, 'put a version or build hash in the cache name (e.g. "app-v2" or the commit hash), bump it on every deploy, and delete old caches in activate');
  else if (names.size) F(PASS, 'cache-name-versioned', `cache name ${[...names].map(n => `"${n}"`).join(', ')} carries a version${SW.analysis.strategy !== 'unknown' ? ` (${SW.analysis.strategy})` : ''}; bump it on every deploy that changes cached files (this check sees only the current deploy)`);
  if ((names.size || dynamic) && !/caches\.delete\(/.test(src)) F(WARN, 'old-caches-kept', 'the service worker never calls caches.delete(): each version bump leaves the previous cache on users\' devices', "in activate: caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))");
}

// ---------- report ----------
function report() {
  const by = c => R.findings.filter(f => f.cat === c);
  const ch = R.chrome || {};
  // Chrome's verdict next to ours: anything Chrome flags that our own checks did not
  if (ch.available && ch.errors?.length && !by(INSTALL).length) for (const e of ch.errors) F(INSTALL, 'chrome:' + e.id, `Chrome says: ${e.message}`);
  R.summary = { installable: !by(INSTALL).length, worksOffline: !by(OFFLINE).length && R.offline?.startOffline?.state === 'ok', install: by(INSTALL).length, offline: by(OFFLINE).length, warnings: by(WARN).length, passes: by(PASS).length };
  if (JSON_OUT) { console.log(JSON.stringify(R, null, 2)); process.exitCode = R.error ? 2 : R.summary.install || R.summary.offline ? 1 : 0; return; }
  const out = [];
  out.push(`pwa-check  ${R.url}${R.mode === 'folder' ? `  (folder ${R.folder})` : ''}`);
  out.push(ch.available ? `Chrome's own verdict (${R.browser}, via DevTools Protocol): ${ch.installable ? 'installable' : 'NOT installable' + (ch.errors?.length ? ' — ' + ch.errors.map(e => e.message).join('; ') : '')}` : `Chrome's own verdict: unavailable (${ch.error || 'protocol method missing'})`);
  if (ch.parseErrors?.length) out.push(`Chrome's manifest parser: ${ch.parseErrors.join('; ')}`);
  if (R.error) out.push(`Stopped early: ${R.error}`);
  const O = R.offline;
  const st = x => ({ ok: 'renders', blank: 'blank page', 'error-page': "browser's offline error" })[x.state] || x.state;
  if (O?.startOffline) out.push(`Offline test: start_url ${O.start} → ${st(O.startOffline)}${O.page2Offline ? `; ${O.page2} → ${st(O.page2Offline)}` : ''}${O.page2Note ? ` (${O.page2Note})` : ''}`);
  else if (O?.skipped) out.push(`Offline test: skipped (${O.skipped})`);
  for (const [cat, title, mark] of [[INSTALL, "WON'T INSTALL", '✘'], [OFFLINE, 'BROKEN OFFLINE / ON LAUNCH', '✘'], [WARN, 'WARNINGS', '!'], [PASS, 'PASSES', '✓']]) {
    const list = by(cat); if (!list.length) continue;
    out.push('', `${title} (${list.length})`);
    for (const f of list) { out.push(`  ${mark} ${f.msg}`); if (f.fix && cat !== PASS) out.push(`      fix: ${f.fix}`); }
  }
  const S = R.summary;
  out.push('', `Verdict: ${S.installable ? 'installs' : "won't install"} · ${S.worksOffline ? 'works offline' : R.offline?.startOffline ? 'broken offline' : 'no offline support'} · ${S.warnings} warning(s)`);
  out.push('Not tested here: iOS Safari / iPhone "Add to Home Screen" (only the iOS tags are checked), and Firefox/Safari install UIs.');
  console.log(out.join('\n'));
  process.exitCode = R.error ? 2 : S.install || S.offline ? 1 : 0;
}
