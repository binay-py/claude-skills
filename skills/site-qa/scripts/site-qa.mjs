#!/usr/bin/env node
// site-qa — crawl a website in a headless Chromium browser and report what's broken.
// Zero dependencies. Node 22+. Uses an installed Chrome / Edge / Brave / Chromium (set BROWSER=path to override).
//
//   node site-qa.mjs https://example.com                 crawl up to 20 same-site pages
//   node site-qa.mjs https://example.com --max-pages 50 --out qa-report
//   node site-qa.mjs http://localhost:8080 --no-external  skip checking outbound links
//
// Writes <out>/report.md, <out>/report.json, and desktop + mobile screenshots of the start page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const start = argv.find(a => /^https?:\/\//.test(a));
if (!start) { console.log('usage: node site-qa.mjs <url> [--max-pages 20] [--out qa-report] [--no-external] [--keep-query]'); process.exit(1); }
const MAX = Number(opt('max-pages', 20)), OUT = path.resolve(opt('out', 'qa-report')), EXTERNAL = !argv.includes('--no-external'), KEEP_QUERY = argv.includes('--keep-query');
const origin = new URL(start).origin;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'site-qa-'));
  const proc = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) throw new Error('browser did not start');
  await sleep(200);
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to browser')); });
  let id = 0; const pending = new Map(), listeners = new Set();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, sessionId })); return new Promise((res, rej) => pending.set(i, { res, rej })); };
  const close = () => { try { ws.close(); proc.kill(); } catch {} setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 800); };
  return { send, on: f => (listeners.add(f), () => listeners.delete(f)), close };
}

// ---------- one page ----------
async function audit(b, url, { width, height, mobile, shot }) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const r = { url, consoleErrors: [], failed: [], bytes: 0, requests: 0 };
  const reqUrl = new Map(); let mainStatus = null, inflight = 0, lastNet = Date.now(), loaded = false;
  const off = b.on(m => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    if (m.method === 'Network.requestWillBeSent') { reqUrl.set(p.requestId, p.request.url); inflight++; lastNet = Date.now(); r.requests++; }
    if (m.method === 'Network.responseReceived') {
      if (p.type === 'Document' && mainStatus === null) mainStatus = p.response.status;
      if (p.response.status >= 400 && p.type !== 'Document' && !/\/favicon\.ico(\?|$)/.test(p.response.url)) r.failed.push(`${p.response.status} ${p.response.url}`);
    }
    if (m.method === 'Network.loadingFinished') { r.bytes += p.encodedDataLength; inflight--; lastNet = Date.now(); }
    if (m.method === 'Network.loadingFailed') { inflight--; lastNet = Date.now(); if (!p.canceled && !/ERR_ABORTED|ERR_HTTP_RESPONSE_CODE_FAILURE/.test(p.errorText)) r.failed.push(`${p.errorText} ${reqUrl.get(p.requestId) || ''}`); }
    if (m.method === 'Runtime.exceptionThrown') r.consoleErrors.push('Uncaught ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') r.consoleErrors.push(p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    if (m.method === 'Log.entryAdded' && p.entry.level === 'error' && p.entry.source !== 'network') r.consoleErrors.push(p.entry.text.slice(0, 300));
    if (m.method === 'Page.loadEventFired') loaded = true;
  });
  await Promise.all(['Network.enable', 'Runtime.enable', 'Log.enable', 'Page.enable'].map(m => s(m)));
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) await s('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const t0 = Date.now();
  await s('Page.navigate', { url });
  while (Date.now() - t0 < 30000 && !(loaded && inflight <= 0 && Date.now() - lastNet > 800)) await sleep(150);
  r.loadMs = Date.now() - t0; r.status = mainStatus;
  const ev = async e => (await s('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  Object.assign(r, await ev(`(() => {
    const q = s => document.querySelector(s), meta = n => q('meta[name="' + n + '"],meta[property="' + n + '"]')?.content || '';
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return {
      finalUrl: location.href, title: document.title.trim(), lang: document.documentElement.lang,
      description: meta('description'), ogTitle: meta('og:title'), ogImage: meta('og:image'), viewport: meta('viewport'),
      canonical: q('link[rel=canonical]')?.href || '', favicon: !!q('link[rel~=icon]'),
      h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()).filter(Boolean),
      imgNoAlt: [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).map(i => i.currentSrc || i.src).slice(0, 20),
      brokenImgs: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map(i => i.currentSrc || i.src).slice(0, 20),
      overflowX: document.documentElement.scrollWidth - innerWidth,
      wideEls: [...document.querySelectorAll('body *')].filter(e => vis(e) && e.getBoundingClientRect().right > innerWidth + 2)
        .slice(0, 5).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')),
      smallTapTargets: ${mobile} ? [...document.querySelectorAll('a,button,input,select,textarea')].filter(e => { const b = e.getBoundingClientRect(); return vis(e) && (b.width < 24 || b.height < 24); }).length : 0,
      emptyLinks: [...document.querySelectorAll('a')].filter(a => vis(a) && !a.textContent.trim() && !a.getAttribute('aria-label') && !a.querySelector('img[alt]:not([alt=""]),svg[aria-label],[aria-label]')).length,
      inputsNoLabel: [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea')].filter(e => !e.labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.title).length,
      links: [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^https?:/.test(h)))],
    };
  })()`));
  if (shot) { const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(shot, Buffer.from(data, 'base64')); }
  off(); await b.send('Target.closeTarget', { targetId });
  r.consoleErrors = [...new Set(r.consoleErrors)]; r.failed = [...new Set(r.failed)];
  return r;
}

async function checkExternal(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 site-qa link checker' } });
      if (r.ok) return { url, status: r.status, ok: true };
      if (method === 'GET' || ![403, 405, 501].includes(r.status)) return { url, status: r.status, ok: false, botBlocked: [401, 403, 429, 999].includes(r.status) };
    } catch (e) { if (method === 'GET') return { url, status: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message, ok: false }; }
  }
}

// ---------- crawl ----------
// Same page with a different ?query is crawled once unless --keep-query.
const norm = (u, page = true) => { const x = new URL(u); x.hash = ''; if (page && !KEEP_QUERY && x.origin === origin) x.search = ''; return x.href; };
const isPage = u => new URL(u).origin === origin && !/\.(pdf|zip|png|jpe?g|gif|webp|svg|ico|mp4|mp3|webm|xml|json|txt|css|js)$/i.test(new URL(u).pathname);
fs.mkdirSync(OUT, { recursive: true });
const b = await launch();
const pages = [], queue = [new URL(start).href.replace(/#.*$/, '')], seen = new Set(queue), external = new Set(), linkedFrom = new Map();
try {
  while (queue.length && pages.length < MAX) {
    const url = queue.shift();
    process.stdout.write(`  [${pages.length + 1}/${Math.min(MAX, pages.length + 1 + queue.length)}] ${url}\n`);
    const r = await audit(b, url, { width: 1366, height: 900, mobile: false, shot: pages.length === 0 ? path.join(OUT, 'desktop.png') : null });
    const m = await audit(b, url, { width: 390, height: 844, mobile: true, shot: pages.length === 0 ? path.join(OUT, 'mobile.png') : null });
    r.mobileOverflowX = m.overflowX; r.mobileWideEls = m.wideEls; r.smallTapTargets = m.smallTapTargets; r.mobileConsoleErrors = m.consoleErrors.filter(e => !r.consoleErrors.includes(e));
    pages.push(r);
    for (const l of r.links) {
      const n = norm(l);
      if (!linkedFrom.has(n)) linkedFrom.set(n, url);
      if (isPage(n)) { if (!seen.has(n)) { seen.add(n); queue.push(n); } }
      else if (new URL(n).origin !== origin) external.add(n);
    }
  }
} finally { b.close(); }

let ext = [];
if (EXTERNAL && external.size) {
  console.log(`  checking ${Math.min(external.size, 100)} outbound links`);
  const list = [...external].slice(0, 100);
  for (let i = 0; i < list.length; i += 8) ext.push(...await Promise.all(list.slice(i, i + 8).map(checkExternal)));
}

// ---------- report ----------
const faviconIco = await fetch(origin + '/favicon.ico', { signal: AbortSignal.timeout(8000) }).then(r => r.ok && /image|icon|octet/.test(r.headers.get('content-type') || '')).catch(() => false);
const issues = []; // [severity, page, text]
const add = (sev, page, text) => issues.push([sev, page, text]);
const titles = new Map();
for (const p of pages) {
  const u = p.url;
  if (p.status >= 400 || p.status === null) add('high', u, `page returned ${p.status ?? 'no response'}`);
  p.consoleErrors.forEach(e => add('high', u, `console error: ${e}`));
  p.mobileConsoleErrors.forEach(e => add('high', u, `console error (mobile only): ${e}`));
  p.failed.forEach(f => add('high', u, `failed request: ${f}`));
  p.brokenImgs.forEach(i => add('high', u, `broken image: ${i}`));
  if (p.mobileOverflowX > 2) add('high', u, `sideways scroll on mobile: page is ${p.mobileOverflowX}px wider than the screen (${p.mobileWideEls.join(', ') || 'unknown element'})`);
  if (!p.viewport) add('high', u, 'no <meta name="viewport"> — mobile browsers will render a zoomed-out desktop page');
  if (!p.title) add('medium', u, 'missing <title>');
  else { if (titles.has(p.title)) add('low', u, `same title as ${titles.get(p.title)}`); else titles.set(p.title, u); }
  if (!p.description) add('medium', u, 'missing meta description');
  if (p.h1.length === 0) add('medium', u, 'no <h1>');
  if (p.h1.length > 1) add('low', u, `${p.h1.length} <h1> elements`);
  if (!p.ogTitle || !p.ogImage) add('medium', u, `missing Open Graph ${[!p.ogTitle && 'og:title', !p.ogImage && 'og:image'].filter(Boolean).join(' + ')} — link previews on WhatsApp/Facebook will be plain`);
  if (!p.lang) add('low', u, 'no lang attribute on <html>');
  if (!p.favicon && !faviconIco) add('low', u, 'no favicon (no <link rel=icon> and no /favicon.ico)');
  if (p.imgNoAlt.length) add('medium', u, `${p.imgNoAlt.length} image(s) without alt text`);
  if (p.inputsNoLabel) add('medium', u, `${p.inputsNoLabel} form field(s) without a label`);
  if (p.emptyLinks) add('low', u, `${p.emptyLinks} link(s) with no text or aria-label`);
  if (p.smallTapTargets > 3) add('low', u, `${p.smallTapTargets} tap targets smaller than 24px on mobile`);
  if (p.bytes > 3e6) add('medium', u, `heavy page: ${(p.bytes / 1e6).toFixed(1)} MB transferred`);
  if (p.loadMs > 8000) add('medium', u, `slow: ${(p.loadMs / 1000).toFixed(1)} s until the network went quiet`);
}
for (const e of ext.filter(e => !e.ok)) add(e.botBlocked ? 'info' : 'high', linkedFrom.get(e.url), `${e.botBlocked ? 'outbound link refused the checker (check by hand)' : 'broken outbound link'}: ${e.status} ${e.url}`);

const order = { high: 0, medium: 1, low: 2, info: 3 };
issues.sort((a, b) => order[a[0]] - order[b[0]]);
const count = s => issues.filter(i => i[0] === s).length;
const short = u => u ? (u.startsWith(origin) ? u.slice(origin.length) || '/' : u) : '?';
let md = `# Site QA: ${origin}\n\n${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${pages.length} page(s) crawled · ${ext.length} outbound link(s) checked\n\n`
  + `**${count('high')} high · ${count('medium')} medium · ${count('low')} low**` + (count('info') ? ` · ${count('info')} to check by hand` : '') + `\n\n`
  + `| Desktop | Mobile |\n|---|---|\n| ![desktop](desktop.png) | ![mobile](mobile.png) |\n\n## Issues\n\n`;
if (!issues.length) md += 'No issues found.\n';
for (const sev of ['high', 'medium', 'low', 'info']) {
  const list = issues.filter(i => i[0] === sev); if (!list.length) continue;
  md += `### ${sev[0].toUpperCase() + sev.slice(1)}\n\n` + list.map(([, p, t]) => `- \`${short(p)}\` ${t}`).join('\n') + '\n\n';
}
md += '## Pages\n\n| Page | Status | Load | Size | Requests | Title |\n|---|---|---|---|---|---|\n'
  + pages.map(p => `| \`${short(p.url)}\` | ${p.status} | ${(p.loadMs / 1000).toFixed(1)} s | ${(p.bytes / 1e6).toFixed(2)} MB | ${p.requests} | ${(p.title || '—').replace(/\|/g, '/')} |`).join('\n') + '\n';
if (pages.length >= MAX && queue.length) md += `\n_Stopped at --max-pages ${MAX}; ${queue.length} more page(s) were found._\n`;
fs.writeFileSync(path.join(OUT, 'report.md'), md);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ origin, pages, external: ext, issues }, null, 2));
console.log(`\n${count('high')} high · ${count('medium')} medium · ${count('low')} low → ${path.join(OUT, 'report.md')}`);
