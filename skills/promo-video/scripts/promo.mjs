#!/usr/bin/env node
// promo-video — promo videos of a website or web app for Reels, Shorts, TikTok, Fiverr and Reddit. The real page is
// recorded frame by frame on a virtual clock (smooth scrolling, page animations advance exactly one frame at a time),
// framed in a phone (9:16) and a browser window (16:9) on a brand background. Frame 0 is the hook over the product,
// captions come in 1-3 word chunks, rehooks land at 40% and 70%, and the CTA loops back into frame 0, following
// references/video-playbook.md. Zero npm dependencies: Node 22+, ffmpeg, and Chrome / Edge / Chromium run headless
// with a throwaway profile (BROWSER=path to choose). Optional voiceover with edge-tts (Python) when it is installed.
//
//   node promo.mjs quick <url> [--hook "3-7 words"] [--title "Name"] [--cta "…"] [--music song.mp3] [--seconds 30]
//                              [--brand "#bg1,#bg2[,#accent]"] [--platform shorts|reels|tiktok|x|fiverr|reddit] [--out promo]
//   node promo.mjs render storyboard.json [--out promo] [--music song.mp3] [--platform …]
//   node promo.mjs plan storyboard.json [--json]       validate it and print the timeline (fast: no browser, no video)
//   node promo.mjs check [promo]                      check rendered videos against the playbook rules (no frames to look at)
// Options: --preview (a few half-size key frames in preview.png, no video) · --formats 16x9,9x16 · --no-cache
//          (don't keep recordings in <out>/.cache) · --fresh (re-record even if cached) · --keep-frames
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const argv = process.argv.slice(2), mode = argv[0];
const BOOL = ['keep-frames', 'json', 'preview', 'no-cache', 'fresh'];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = n => argv.includes('--' + n);
const positional = []; for (let i = 1; i < argv.length; i++) { if (argv[i].startsWith('--')) { if (!BOOL.includes(argv[i].slice(2))) i++; continue; } positional.push(argv[i]); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = (m, code = 1) => { console.error('✘ ' + m); process.exit(code); };
const warn = m => console.log('  ! ' + m);
const secs = t0 => ((Date.now() - t0) / 1000).toFixed(1) + ' s';
const FPS = 30, STEP = 1000 / FPS;
// 16:9 records a 1440x900 desktop viewport, 9:16 a 390x844 phone at 3x with a mobile user agent and touch.
const FMT = {
  '16x9': { W: 1920, H: 1080, vw: 1440, vh: 900, dsf: 1, mobile: false },
  '9x16': { W: 1080, H: 1920, vw: 390, vh: 844, dsf: 3, mobile: true },
};
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
// Analytics and ad beacons are blocked so renders don't count as visits on the site's own stats.
const BLOCK = ['*google-analytics.com*', '*googletagmanager.com*', '*analytics.google.com*', '*doubleclick.net*', '*connect.facebook.net*',
  '*facebook.com/tr*', '*static.cloudflareinsights.com*', '*clarity.ms*', '*hotjar.com*', '*plausible.io/api*', '*api.segment.io*', '*mixpanel.com*', '*posthog.com*'];
// Cookie banners and chat bubbles are hidden (display:none in the throwaway browser only). Add more with "hide".
const HIDE = ['#onetrust-consent-sdk', '#CybotCookiebotDialog', '#usercentrics-root', '#didomi-host', '.qc-cmp2-container', '.fc-consent-root',
  '.cc-window', '.cc-banner', '#cookie-banner', '#cookie-notice', '#cookie-law-info-bar', '.cookie-banner', '.cookie-notice', '.cookie-consent',
  '[id^="cookie-consent"]', '[class*="CookieConsent"]', '#hubspot-messages-iframe-container', '.intercom-lightweight-app', '#crisp-chatbox', '#tidio-chat'];
const hideCss = extra => `${[...HIDE, ...(extra || [])].join(',')}{display:none!important}*{scroll-behavior:auto!important;scroll-snap-type:none!important}::-webkit-scrollbar{display:none}`;

function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const P = process.env.PROGRAMFILES || 'C:/Program Files', P86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', L = process.env.LOCALAPPDATA || '';
  const c = process.platform === 'win32' ? [`${P}/Google/Chrome/Application/chrome.exe`, `${P86}/Google/Chrome/Application/chrome.exe`, `${L}/Google/Chrome/Application/chrome.exe`,
    `${P86}/Microsoft/Edge/Application/msedge.exe`, `${P}/Microsoft/Edge/Application/msedge.exe`]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  const f = c.find(p => fs.existsSync(p));
  if (!f) throw new Error('No Chrome, Edge or Chromium found. Set BROWSER=/path/to/chrome');
  return f;
}

// ---------- page clock + recorder helpers (injected before any page script) ----------
// The clock idea is gif-maker's: requestAnimationFrame, performance.now, Date.now, setTimeout/setInterval and all
// CSS/Web Animations advance only when advance(ms) is called, so every frame is exact however slow a screenshot is.
// Same-origin iframes are advanced with the page. advance() also reports whether anything could have changed on
// screen (DOM mutations, running animations, rAF with a canvas, playing video), so idle frames reuse the last shot.
const CLOCK = `(() => {
  if (window.__promo) return;
  const realTimeout = window.setTimeout.bind(window), start = Date.now();
  let now = 0, rid = 0, tid = 1, dirty = true, timers = [];
  const rafs = new Map(), seen = new WeakMap();
  performance.now = () => now; Date.now = () => start + now;
  window.requestAnimationFrame = cb => { rafs.set(++rid, cb); return rid; };
  window.cancelAnimationFrame = id => { rafs.delete(id); };
  window.setTimeout = (fn, ms = 0, ...a) => { const id = tid++; timers.push({ id, at: now + Math.max(1, +ms || 0), fn, a }); return id; };
  window.setInterval = (fn, ms = 0, ...a) => { const id = tid++, every = Math.max(4, +ms || 0); timers.push({ id, at: now + every, fn, a, every }); return id; };
  window.clearTimeout = window.clearInterval = id => { timers = timers.filter(t => t.id !== id); };
  const mo = new MutationObserver(() => { dirty = true; });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('load', () => { dirty = true; }, true);
  const anims = () => { let on = false; for (const an of document.getAnimations()) { if (!seen.has(an)) seen.set(an, now - (an.currentTime || 0)); an.pause(); an.currentTime = now - seen.get(an);
    const c = an.effect && an.effect.getComputedTiming(); if (c && c.localTime !== null && c.localTime < c.endTime + 50) on = true; } return on; };
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = el => { if (!el || !el.getBoundingClientRect) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0; };
  const scrollable = e => /auto|scroll|overlay/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2;
  const root = () => document.scrollingElement || document.documentElement;
  const fixedUp = e => { for (; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return e; } return null; };
  const P = window.__promo = {
    realTimeout,
    advance(ms) {
      const end = now + ms; let n = 0;
      for (;;) { timers.sort((x, y) => x.at - y.at); const t = timers[0]; if (!t || t.at > end || ++n > 5000) break; now = t.at; if (t.every) t.at += t.every; else timers.shift(); try { if (typeof t.fn === 'function') t.fn(...t.a); } catch (e) {} }
      now = end;
      const run = [...rafs.values()]; rafs.clear(); for (const cb of run) { try { cb(now); } catch (e) {} }
      let changed = anims();
      for (let i = 0; i < frames.length; i++) { try { const w = frames[i]; if (w.__promo && w.__promo.advance(ms)) changed = true; } catch (e) {} }
      if (run.length && document.querySelector('canvas')) changed = true;
      for (const v of document.querySelectorAll('video')) if (!v.paused && !v.ended) changed = true;
      if (mo.takeRecords().length || dirty) changed = true;
      dirty = false; return changed;
    },
    style(css) { let s = document.getElementById('promo-video-style'); if (!s) { s = document.createElement('style'); s.id = 'promo-video-style'; (document.head || document.documentElement).appendChild(s); } s.textContent = css; },
    // "text=Our work" finds the element whose text is exactly that (headings first, then buttons and links), else contains it
    find(sel) {
      if (/^text=/.test(sel)) {
        const want = norm(sel.slice(5)).toLowerCase(), txt = e => norm(e.textContent).toLowerCase();
        const rank = e => /^H[1-6]$/.test(e.tagName) ? 0 : e.matches('a,button,label,summary,[role=button],[role=tab],[role=link]') ? 1 : 2;
        const all = [...document.querySelectorAll('body *')].filter(e => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|path)$/i.test(e.tagName));
        let hits = all.filter(e => txt(e) === want && vis(e));
        if (!hits.length) hits = all.filter(e => txt(e).includes(want) && vis(e));
        hits.sort((a, b) => rank(a) - rank(b) || txt(a).length - txt(b).length || (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
        return hits[0] || null;
      }
      const list = [...document.querySelectorAll(sel)];
      return list.find(vis) || list[0] || null;
    },
    main() { const r = root(); if (r.scrollHeight > innerHeight + 2) return r; let best = r, area = 0;
      for (const e of document.querySelectorAll('body *')) { if (e.clientHeight < 100 || !scrollable(e)) continue; const a = e.clientWidth * e.clientHeight; if (a > area) { area = a; best = e; } } return best; },
    scroller(el) { for (let e = el && el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) if (scrollable(e)) return e; return root(); },
    // bottom edge of a fixed or sticky header, so scroll targets land below it
    inset() { let h = 0; for (const x of [0.2, 0.5, 0.8]) { const f = fixedUp(document.elementFromPoint(innerWidth * x, 2)); if (f) { const r = f.getBoundingClientRect(); if (r.top <= 2 && r.height < innerHeight * 0.4) h = Math.max(h, r.bottom); } } return h; },
    scrollPlan(target, gap) {
      let sc, to, miss = false;
      if (typeof target === 'number' || target === 'top' || target === 'bottom') { sc = P.main(); to = target === 'top' ? 0 : target === 'bottom' ? 1e9 : sc.scrollTop + target; }
      else { const el = P.find(target); if (!el) { miss = true; sc = P.main(); to = sc.scrollTop + innerHeight * 0.8; }
        else { sc = P.scroller(el); const isRoot = sc === root(); to = sc.scrollTop + el.getBoundingClientRect().top - (isRoot ? P.inset() : sc.getBoundingClientRect().top) - gap; } }
      to = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, to)); P.sc = sc;
      return { from: sc.scrollTop, to, miss };
    },
    // element center for a pointer action or zoom, after scrolling it into view if it is not already
    target(sel) {
      const el = P.find(sel); if (!el) return null;
      const r = el.getBoundingClientRect(), sc = P.scroller(el), ins = P.inset(), from = sc.scrollTop; let to = from;
      if (r.top < ins + 10 || r.bottom > innerHeight - 20) to = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, from + r.top + r.height / 2 - (innerHeight + ins) / 2));
      P.sc = sc; P.el = el;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 - (to - from), w: r.width, h: r.height, from, to };
    },
    at() { const r = P.el && P.el.isConnected ? P.el.getBoundingClientRect() : null; return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; },
    go(y) { if (P.sc) P.sc.scrollTo({ top: y, behavior: 'instant' }); },
    pending() { let n = 0; for (const i of document.images) { if (i.complete) continue; const r = i.getBoundingClientRect(); if (r.width && r.bottom > -300 && r.top < innerHeight + 300) n++; } return n; },
    // color for the phone status bar: theme-color, else the first solid background under the top edge
    top() { const m = document.querySelector('meta[name="theme-color"]'); if (m && m.content) return m.content;
      for (let e = document.elementFromPoint(innerWidth / 2, 1); e; e = e.parentElement) { const s = getComputedStyle(e);
        if (!/^rgba\\(.*,\\s*0\\)$|^transparent$/.test(s.backgroundColor)) return s.backgroundColor; if (s.backgroundImage !== 'none') return '#000000'; } return '#ffffff'; },
    analyze() {
      const meta = n => (document.querySelector('meta[name="' + n + '"],meta[property="' + n + '"]') || {}).content || '';
      const skip = e => e.closest('nav,footer,dialog,[role=dialog],[aria-hidden=true],[hidden]') || fixedUp(e);
      const cssPath = el => { const parts = []; for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
        if (e.id && document.querySelectorAll('#' + CSS.escape(e.id)).length === 1) { parts.unshift('#' + CSS.escape(e.id)); return parts.join(' > '); }
        let i = 1; for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++; parts.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + i + ')'); } return 'body > ' + parts.join(' > '); };
      const sc = P.main(), base = sc === root() ? 0 : sc.getBoundingClientRect().top;
      const texts = new Map(); for (const h of document.querySelectorAll('h1,h2,h3,h4')) { const t = norm(h.textContent).toLowerCase(); texts.set(t, (texts.get(t) || 0) + 1); }
      const heads = [...document.querySelectorAll('h1,h2,h3')].filter(e => vis(e) && !skip(e)).map(e => { const text = norm(e.textContent);
        return { tag: e.tagName.toLowerCase(), text, y: Math.round(e.getBoundingClientRect().top - base + sc.scrollTop), sel: text.length <= 60 && texts.get(text.toLowerCase()) === 1 ?'text=' + text : cssPath(e) }; }).filter(h => h.text.length > 1);
      const bg = e => getComputedStyle(e).backgroundColor;
      const buttons = [...document.querySelectorAll('a,button,[role=button]')].filter(vis).slice(0, 300).map(e => { const r = e.getBoundingClientRect(); return { bg: bg(e), area: Math.round(r.width * r.height) }; });
      const blocks = [...document.querySelectorAll('body,body > *,section,header,footer,main > *,[class*=hero]')].filter(vis).map(e => { const r = e.getBoundingClientRect(); return { bg: bg(e), area: Math.round(r.width * Math.min(r.height, 3000)) }; });
      const icons = [...document.querySelectorAll('link[rel~="icon"],link[rel~="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"]')].map(l => ({ href: l.href, sizes: l.getAttribute('sizes') || '', rel: l.rel, type: l.type || '' }));
      const links = [...document.querySelectorAll('nav a[href],header a[href],[role=navigation] a[href]')].filter(a => vis(a) && a.origin === location.origin && a.pathname !== location.pathname && !a.hash)
        .map(a => ({ href: a.href.split('#')[0], text: norm(a.textContent) })).filter(l => l.text && l.text.length < 40);
      return { url: location.href, title: document.title, site: meta('og:site_name'), desc: meta('description') || meta('og:description'), theme: meta('theme-color'),
        manifest: (document.querySelector('link[rel=manifest]') || {}).href || '', icons, heads, buttons, blocks, links, ink: getComputedStyle(document.body).color,
        font: getComputedStyle(document.querySelector('h1') || document.body).fontFamily, scrollH: sc.scrollHeight, vh: innerHeight };
    },
  };
})();`;

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

// ---------- DevTools connection and tabs ----------
async function connect() {
  const br = await startBrowser('promo-video-', ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-gpu-vsync', '--disable-frame-rate-limit']);
  const ws = new WebSocket(br.wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to the browser')); });
  let id = 0, lost = null; const pending = new Map(), listeners = new Set();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  };
  ws.onclose = () => { lost = new Error('lost the connection to the browser (did it crash?)'); for (const { rej } of pending.values()) rej(lost); pending.clear(); };
  const send = (method, params = {}, sessionId) => { if (lost) return Promise.reject(lost); const i = ++id; ws.send(JSON.stringify({ id: i, method, params, sessionId })); return new Promise((res, rej) => pending.set(i, { res, rej })); };
  return { send, on: f => (listeners.add(f), () => listeners.delete(f)), close: () => br.close(send, ws) };
}
const RELEVANT = new Set(['Document', 'Stylesheet', 'Image', 'Font', 'Script', 'XHR', 'Fetch']);
async function openTab(b, { width, height, dsf = 1, mobile = false, page = true, scheme = 'light' }) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', newWindow: true }); // own window: stays "visible", so it keeps rendering
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const T = { s, net: new Map(), navs: 0, loaded: false, url: '' };
  const off = b.on(m => {
    if (m.sessionId !== sessionId) return; const p = m.params;
    if (m.method === 'Network.requestWillBeSent') T.net.set(p.requestId, { type: p.type, t: Date.now() });
    else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') T.net.delete(p.requestId);
    else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) { T.navs++; T.loaded = false; T.url = p.frame.url; T.net.clear(); }
    else if (m.method === 'Page.navigatedWithinDocument') T.url = p.url;
    else if (m.method === 'Page.loadEventFired') T.loaded = true;
  });
  await s('Page.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile });
  if (page) {
    await s('Network.enable');
    await s('Network.setBlockedURLs', { urls: BLOCK });
    await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }); // not the OS theme
    if (mobile) { await s('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA }); await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); }
    await s('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  }
  T.ev = async e => { const r = await s('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text); return r.result.value; };
  T.busy = () => { for (const r of T.net.values()) if (RELEVANT.has(r.type) && Date.now() - r.t < 6000) return true; return false; };
  T.waitNet = async ms => { const t0 = Date.now(); while (T.busy() && Date.now() - t0 < ms) await sleep(25); };
  T.waitImgs = async ms => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let n = 0; try { n = await T.ev('__promo.pending()'); } catch {} if (!n) break; await sleep(40); } };
  T.close = async () => { off(); await b.send('Target.closeTarget', { targetId }).catch(() => {}); };
  return T;
}
// Open a URL and let it settle: the page clock runs at real speed while it loads, then 1.5 s more of page time
// passes (entrance animations finish), then fonts and images in view are awaited.
async function settle(T, css) {
  const t0 = Date.now(); let last = t0, quiet = 0;
  for (;;) {
    await sleep(60);
    const n = Date.now(); let st = 'none';
    try { st = await T.ev(`window.__promo ? (__promo.advance(${n - last}), document.readyState) : 'none'`); } catch {}
    last = n;
    if (T.loaded && st === 'complete' && !T.busy()) { if (!quiet) quiet = n; if (n - quiet > 500) break; } else quiet = 0;
    if (n - t0 > 25000) { warn(`${T.url} was still loading after 25 s; recording anyway`); break; }
  }
  await T.ev(`__promo.style(${JSON.stringify(css)})`).catch(() => {});
  await T.ev('document.fonts.ready.then(() => 1)').catch(() => {});
  for (let i = 0; i < 30; i++) { await T.ev('__promo.advance(50)').catch(() => {}); if (T.busy()) await T.waitNet(3000); }
  await T.waitImgs(5000);
}
async function load(T, url, css) {
  T.loaded = false;
  const r = await T.s('Page.navigate', { url });
  if (r.errorText) die(`could not open ${url}: ${r.errorText}`);
  await settle(T, css);
}

// ---------- colors ----------
const hex2rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const rgb2hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const parseColor = s => {
  s = String(s || '').trim(); let m;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return { c: hex2rgb(s), a: 1 };
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return { c: p.slice(0, 3), a: p[3] ?? 1 }; }
  if ((m = /^color\(srgb ([^)]+)\)$/.exec(s))) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat); return { c: p.slice(0, 3).map(v => v * 255), a: p[3] ?? 1 }; }
  return null;
};
const toHsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l]; const s = d / (1 - Math.abs(2 * l - 1)); const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(h * 60 + 360) % 360, s, l]; };
const fromHsl = (h, s, l) => { const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return rgb2hex([r, g, b].map(v => (v + m) * 255)); };
const lum = c => { const f = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; const [r, g, b] = c.map(f); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const onColor = hex => lum(hex2rgb(hex)) > 0.179 ? '#111111' : '#ffffff';
// Brand from the page: accent = theme-color or the biggest saturated button; background = a dark color the site
// already uses (dark theme-color, dark section, text ink), else a deep shade of the accent's hue.
function deriveBrand(a) {
  const cols = list => list.map(x => ({ ...x, p: parseColor(x.bg) })).filter(x => x.p && x.p.a > 0.85).map(x => ({ ...x, hsl: toHsl(x.p.c) }));
  const theme = parseColor(a.theme), th = theme && toHsl(theme.c), ink = parseColor(a.ink), ih = ink && toHsl(ink.c);
  const vivid = h => h[1] > 0.35 && h[2] > 0.25 && h[2] < 0.75;
  const btn = cols(a.buttons).filter(x => vivid(x.hsl)).sort((x, y) => y.area - x.area)[0];
  const dark = cols(a.blocks).filter(x => x.hsl[2] < 0.22).sort((x, y) => y.area - x.area)[0];
  const [h0, s0, l0] = th && th[2] < 0.3 ? th : dark ? dark.hsl : ih && ih[2] < 0.3 && ih[1] > 0.12 ? ih : th && th[1] > 0.2 ? th : btn ? btn.hsl : [222, 0.4, 0.15];
  const L = Math.min(l0, 0.17), bg = [fromHsl(h0, Math.min(s0, 0.6), L), fromHsl(h0, Math.min(s0 * 1.1, 0.65), L + 0.09)];
  let ac = th && vivid(th) ? th : btn ? btn.hsl : th && th[1] > 0.2 ? th : [217, 0.9, 0.6];
  if (ac[2] < L + 0.3) ac = [ac[0], Math.max(ac[1], 0.55), L + 0.38]; // keep it clearly lighter than the background
  return { bg, accent: fromHsl(...ac), text: '#ffffff' };
}

// ---------- storyboard ----------
// Defaults follow references/video-playbook.md: frame 0 = hook text over the real product, captions in 1-3 word
// chunks, a visual change every <= 3 s, rehooks at 40% and 70%, one CTA in the last <= 3 s, last frame = frame 0's layout.
const KINDS = ['scroll', 'click', 'type', 'hover', 'wait', 'zoom'];
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const PLATFORMS = { shorts: 45, reels: 45, tiktok: 60, x: 45, fiverr: 75, reddit: 60, linkedin: 90 };
const words = s => String(s || '').split(/\s+/).filter(Boolean);
const glen = s => [...new Intl.Segmenter().segment(s)].length; // characters as people count them (Devanagari, emoji)
function validate(sb) {
  const errs = [], E = (p, m) => errs.push(`${p}: ${m}`);
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const known = (o, p, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k) && !k.startsWith('_')) E(p, k === 'intro' ? '"intro" was removed: frame 0 shows the hook over the product (playbook rule 4)' : `unknown key "${k}" (allowed: ${keys.join(', ')})`); };
  const str = (v, p, req) => { if (v === undefined) { if (req) E(p, 'is required'); } else if (typeof v !== 'string' || !v.trim()) E(p, 'must be a non-empty string'); };
  const num = (v, p, lo, hi) => { if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)) E(p, `must be a number from ${lo} to ${hi}`); };
  const color = (v, p) => { if (v !== undefined && (typeof v !== 'string' || !HEX.test(v))) E(p, `must be a hex color like "#1e2340" (got ${JSON.stringify(v)})`); };
  const fmts = (v, p) => { if (v !== undefined && (!Array.isArray(v) || !v.length || v.some(f => !FMT[f]))) E(p, 'must be a list of "16x9" and/or "9x16"'); };
  if (!isObj(sb)) return ['the storyboard must be a JSON object'];
  known(sb, 'storyboard', ['title', 'hook', 'tagline', 'platform', 'brand', 'music', 'sfx', 'voice', 'outro', 'formats', 'scenes', 'hide', 'colorScheme']);
  str(sb.title, 'title', true); str(sb.hook, 'hook'); str(sb.tagline, 'tagline'); str(sb.music, 'music'); fmts(sb.formats, 'formats');
  if (sb.platform !== undefined && !PLATFORMS[sb.platform]) E('platform', `must be one of ${Object.keys(PLATFORMS).join(', ')}`);
  if (sb.sfx !== undefined && typeof sb.sfx !== 'boolean') E('sfx', 'must be true or false');
  if (sb.colorScheme !== undefined && !['light', 'dark'].includes(sb.colorScheme)) E('colorScheme', 'must be "light" or "dark"');
  if (sb.voice !== undefined) { if (!isObj(sb.voice)) E('voice', 'must be an object like {"name": "en-US-AndrewMultilingualNeural", "rate": "+5%"}'); else { known(sb.voice, 'voice', ['name', 'rate']); str(sb.voice.name, 'voice.name'); if (sb.voice.rate !== undefined && !/^[+-]\d{1,2}%$/.test(sb.voice.rate)) E('voice.rate', 'must look like "+5%" or "-10%"'); } }
  if (sb.brand !== undefined) {
    if (!isObj(sb.brand)) E('brand', 'must be an object');
    else {
      known(sb.brand, 'brand', ['bg', 'accent', 'text', 'logo', 'font']);
      const bg = sb.brand.bg;
      if (bg !== undefined) { if (Array.isArray(bg)) { if (!bg.length || bg.length > 3) E('brand.bg', 'must list 1 to 3 colors'); bg.forEach((c, i) => color(c, `brand.bg[${i}]`)); } else color(bg, 'brand.bg'); }
      color(sb.brand.accent, 'brand.accent'); color(sb.brand.text, 'brand.text'); str(sb.brand.logo, 'brand.logo'); str(sb.brand.font, 'brand.font');
    }
  }
  if (sb.outro !== undefined) { if (!isObj(sb.outro)) E('outro', 'must be an object'); else { known(sb.outro, 'outro', ['cta', 'url', 'seconds', 'voiceover']); str(sb.outro.cta, 'outro.cta'); str(sb.outro.url, 'outro.url'); str(sb.outro.voiceover, 'outro.voiceover'); num(sb.outro.seconds, 'outro.seconds', 1, 3); } }
  if (sb.hide !== undefined && (!Array.isArray(sb.hide) || sb.hide.some(h => typeof h !== 'string' || !h.trim()))) E('hide', 'must be a list of CSS selectors');
  if (!Array.isArray(sb.scenes) || !sb.scenes.length) E('scenes', 'must be a non-empty list');
  else sb.scenes.forEach((sc, i) => {
    const p = `scenes[${i}]`;
    if (!isObj(sc)) return E(p, 'must be an object');
    known(sc, p, ['url', 'caption', 'voiceover', 'seconds', 'formats', 'actions']);
    if (sc.url !== undefined && (typeof sc.url !== 'string' || !/^(https?|file):\/\//i.test(sc.url))) E(`${p}.url`, 'must start with http://, https:// or file://');
    if (i === 0 && sc.url === undefined) E(`${p}.url`, 'is required on the first scene (later scenes without a url continue on the same page)');
    str(sc.caption, `${p}.caption`); str(sc.voiceover, `${p}.voiceover`); num(sc.seconds, `${p}.seconds`, 0.5, 120); fmts(sc.formats, `${p}.formats`);
    if (sc.actions === undefined) return;
    if (!Array.isArray(sc.actions)) return E(`${p}.actions`, 'must be a list');
    sc.actions.forEach((a, j) => {
      const q = `${p}.actions[${j}]`;
      if (!isObj(a)) return E(q, 'must be an object like {"scroll": "#pricing"}');
      const ks = KINDS.filter(k => k in a);
      if (ks.length !== 1) return E(q, ks.length ? `has ${ks.join(' and ')}; use one action per object` : `needs one of ${KINDS.join(', ')}`);
      const k = ks[0];
      known(a, q, [k, ...({ scroll: ['ms'], click: ['ms'], hover: ['ms'], type: ['text', 'ms'], wait: [], zoom: ['scale', 'ms'] })[k]]);
      if (k === 'wait') return num(a.wait, `${q}.wait`, 0, 60000);
      if (k === 'scroll') { if (!(typeof a.scroll === 'number' && Number.isFinite(a.scroll) && Math.abs(a.scroll) <= 50000) && !(typeof a.scroll === 'string' && a.scroll.trim())) E(`${q}.scroll`, 'must be a CSS selector, "text=…", "top", "bottom", or a number of pixels'); }
      else str(a[k], `${q}.${k}`, true);
      if (k === 'type') { str(a.text, `${q}.text`, true); if (typeof a.text === 'string' && a.text.length > 300) E(`${q}.text`, 'is longer than 300 characters'); }
      if (k === 'zoom') num(a.scale, `${q}.scale`, 1.1, 4);
      num(a.ms, `${q}.ms`, k === 'scroll' ? 100 : k === 'zoom' ? 900 : 500, 30000);
    });
  });
  return errs;
}
const DEF = { cta: 2.5, lead: 600, tail: 1000, scroll: 1200, click: 1400, hover: 1300, zoom: 2400, gap: 380, preCta: 600 };
const actionMs = (a, k) => a.ms ?? (k === 'wait' ? a.wait : k === 'type' ? 1000 + 55 * a.text.length + 500 : DEF[k]);
const moveMs = a => a.kind === 'zoom' ? Math.min(800, a.ms * 0.3) : Math.min(a.kind === 'hover' ? 900 : 700, a.ms * 0.55);
// voiceover text -> sentences of <= 12 words (split at the comma nearest the middle, else in the middle)
function sentences(text) {
  const out = [];
  for (let s of (String(text).match(/[^.!?।]+[.!?।]*/g) || []).map(x => x.trim()).filter(Boolean)) {
    while (words(s).length > 12) {
      const w = words(s), mid = w.length / 2; let cut = -1;
      w.forEach((x, i) => { if (i < w.length - 2 && /[,;:–—]$/.test(x) && (cut < 0 || Math.abs(i + 1 - mid) < Math.abs(cut - mid))) cut = i + 1; });
      if (cut < 3) cut = Math.ceil(mid);
      out.push(w.slice(0, cut).join(' ')); s = w.slice(cut).join(' ');
    }
    out.push(s);
  }
  return out;
}
// caption chunks: 1-3 words, <= 16 characters, break after punctuation
function chunk(ws) {
  const out = []; let g = [];
  ws.forEach((w, i) => { const len = glen([...g.map(j => ws[j]), w].join(' ')); if (g.length && (g.length >= 3 || len > 16)) { out.push(g); g = []; } g.push(i); if (/[,.…!?।:;]$/.test(w)) { out.push(g); g = []; } });
  if (g.length) out.push(g);
  return out;
}
// Timeline in whole frames for one format. vo: sentence id -> {dur, words} from the voice step (or null).
function plan(sb, fmt, vo = {}) {
  const fr = ms => Math.round(ms * FPS / 1000), ms = f => f * 1000 / FPS;
  const scenes = []; let g = 0, pageUrl = null, shownUrl = null;
  const hookText = sb.hook || (sb.scenes[0].caption && words(sb.scenes[0].caption).length <= 7 ? sb.scenes[0].caption : '') || sb.title;
  sb.scenes.forEach((sc, i) => {
    if (sc.url) pageUrl = sc.url;
    if (sc.formats && !sc.formats.includes(fmt)) return;
    let t = DEF.lead;
    const acts = (sc.actions || []).map(a => { const kind = KINDS.find(k => k in a), d = actionMs(a, kind), r = { ...a, kind, ms: d, t0: t, t1: t + d }; t += d; return r; });
    const lines = [], lead = scenes.length ? 60 : 40;
    let vt = lead;
    sentences(sc.voiceover || '').forEach((text, k) => { const v = vo[`${i}.${k}`]; if (!v) return; lines.push({ text, at: vt, dur: v.dur, words: v.words, file: v.file }); vt += v.dur * 1000 + DEF.gap; });
    const voEnd = lines.length ? vt - DEF.gap + 330 : 0;
    const want = Math.max(sc.seconds ? sc.seconds * 1000 : t + DEF.tail, voEnd, scenes.length ? 0 : 2000); // hook stays >= 1.5 s
    if (sc.seconds && sc.seconds * 1000 < Math.max(t, voEnd)) warn(`scene ${i + 1}: its ${voEnd > t ? 'voiceover' : 'actions'} take ${(Math.max(t, voEnd) / 1000).toFixed(1)} s, more than "seconds": ${sc.seconds}; using that`);
    const url = sc.url || (shownUrl !== pageUrl ? pageUrl : undefined); // a scene skipped in this format may have opened the page
    shownUrl = pageUrl;
    const frames = fr(Math.max(want, t));
    scenes.push({ n: i + 1, url, caption: sc.caption || '', acts, frames, start: g, end: g + frames, lines }); g += frames;
  });
  // CTA: last <= 3 s, its voiceover 0.6 s after the last spoken line
  const ctaLines = []; let ctaMs = (sb.outro?.seconds ?? DEF.cta) * 1000;
  const lastVo = scenes.flatMap(s => s.lines.map(l => ms(s.start) + l.at + l.dur * 1000)).pop();
  let ct = lastVo !== undefined ? Math.max(100, lastVo + DEF.preCta - ms(g)) : 100;
  sentences(sb.outro?.voiceover || '').forEach((text, k) => { const v = vo[`cta.${k}`]; if (!v) return; ctaLines.push({ text, at: ct, dur: v.dur, words: v.words, file: v.file }); ct += v.dur * 1000 + DEF.gap; });
  if (ctaLines.length) ctaMs = Math.min(3000, Math.max(ctaMs, ct - DEF.gap + 300));
  const ctaF = fr(ctaMs), total = g + ctaF, T = ms(total);
  // captions: spoken words when there is a voiceover (word-synced), else the scene caption spread over the scene
  const chunks = [];
  for (const [k, s] of scenes.entries()) {
    const s0 = ms(s.start), s1 = ms(s.end);
    if (s.lines.length) for (const l of s.lines) {
      const shown = s.caption && s.lines.length === 1 ? words(s.caption) : words(l.text), sw = l.words.length ? l.words : shown.map((w, i) => ({ t: i * l.dur / shown.length, d: l.dur / shown.length }));
      const at = i => s0 + l.at + 1000 * sw[Math.min(sw.length - 1, Math.floor(i * sw.length / shown.length))].t;
      const gs = chunk(shown);
      gs.forEach((gr, j) => chunks.push({ text: gr.map(i => shown[i]).join(' '), s: at(gr[0]) - 40, e: j < gs.length - 1 ? at(gs[j + 1][0]) - 40 : s0 + l.at + l.dur * 1000 + 250, w: gr.map(i => at(i) - 40) }));
    } else if (s.caption && !(k === 0 && hookText === s.caption)) {
      const gs = chunk(words(s.caption)), all = words(s.caption), a = s0 + 200, b = s1 - 250, wsum = gs.reduce((n, gr) => n + gr.map(i => all[i]).join(' ').length + 6, 0);
      let t0 = a; gs.forEach(gr => { const text = gr.map(i => all[i]).join(' '), d = Math.max(250, (b - a) * (text.length + 6) / wsum); chunks.push({ text, s: t0, e: Math.min(b, t0 + d) }); t0 += d; });
    }
  }
  for (let i = 0; i < chunks.length - 1; i++) {
    const c = chunks[i], d = chunks[i + 1];
    if (c.e - c.s >= 260 || d.s - c.e > 50) continue;
    const text = c.text + ' ' + d.text;
    if (words(text).length <= 3 && glen(text) <= 16) { chunks.splice(i, 2, { text, s: c.s, e: d.e, w: c.w && d.w ? [...c.w, ...d.w] : undefined }); i--; }
    else { c.e = c.s + 260; d.s = Math.max(d.s, c.e); }
  }
  chunks.forEach((c, i) => { if (chunks[i + 1] && c.e > chunks[i + 1].s) c.e = chunks[i + 1].s; c.e = Math.min(c.e, ms(g)); });
  // rehooks at 40% and 70%: on a scene cut when one is within 5% of runtime, else a punch-in
  const cuts = scenes.slice(1).map(s => ms(s.start));
  const rehooks = [0.4, 0.7].map(f => { const want = T * f, near = cuts.filter(c => Math.abs(c - want) <= T * 0.05).sort((x, y) => Math.abs(x - want) - Math.abs(y - want))[0]; return { at: Math.round(near ?? want), cut: near !== undefined }; });
  // sound effects: whoosh on cuts and into the CTA, click on presses, impact on rehooks; never two within 1.5 s
  const sfx = [...rehooks.map(r => ({ type: 'impact', at: r.at, p: 3 })), { type: 'whoosh', at: ms(g) - 150, p: 2 }, ...cuts.map(c => ({ type: 'whoosh', at: c - 150, p: 1 })),
    ...scenes.flatMap(s => s.acts.filter(a => a.kind === 'click' || a.kind === 'type').map(a => ({ type: 'click', at: ms(s.start) + a.t0 + moveMs(a), p: 0 })))]
    .filter(x => x.at >= 0 && x.at < T).sort((x, y) => y.p - x.p).reduce((keep, x) => keep.some(k => Math.abs(k.at - x.at) < 1500) ? keep : [...keep, x], []).sort((x, y) => x.at - y.at);
  return { fmt, scenes, ctaF, total, seconds: total / FPS, hook: { text: hookText, s: 0, e: scenes[0] ? ms(scenes[0].end) : 0 }, ctaStart: ms(g), ctaLines, chunks, rehooks, sfx: sb.sfx === false ? [] : sfx };
}
function readStoryboard(file) {
  let sb; try { sb = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { die(`cannot read ${file}: ${e.message}`, 2); }
  const errs = validate(sb);
  if (errs.length) die(`${file} has ${errs.length} problem(s):\n  - ${errs.join('\n  - ')}`, 2);
  return sb;
}

// ---------- quick mode: build a storyboard from the page itself ----------
const clipText = (s, n) => { s = s.replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const cut = s.slice(0, n); return cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[,;:\s–—-]+$/, '') + '…'; };
const firstSentence = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); const m = /^.+?[.!?।](\s|$)/.exec(s); return clipText(m && m[0].length > 20 ? m[0].trim() : s, n); };
// hook: 3-7 words from the headline, else its first clause, else the description; trimmed to 7 words as a last resort
const hookFrom = (...cands) => {
  const clean = s => String(s || '').replace(/\s+/g, ' ').replace(/[.!?।…]+$/, '').trim(), ok = s => words(s).length >= 3 && words(s).length <= 7;
  for (const c of cands.map(clean)) { if (ok(c)) return c; const first = clean(c.split(/[,;:–—|]| - /)[0]); if (ok(first)) return first; }
  const c = cands.map(clean).find(x => words(x).length >= 3) || cands.map(clean).find(Boolean) || '';
  return words(c).slice(0, 7).join(' ').replace(/[,;:–—-]+$/, '');
};
const GENERIC_FONT = /^(system-ui|-apple-system|blinkmacsystemfont|segoe ui.*|roboto|helvetica.*|arial.*|sans-serif|serif|monospace|ui-.*|inherit|initial|cursive|fantasy|times.*|georgia|verdana|tahoma|nirmala.*|mangal|kohinoor.*|sf pro.*|.*emoji.*|.*symbol.*)$/i;
async function pickLogo(a) {
  const cands = [];
  const size = s => Math.max(0, ...String(s || '').split(/\s+/).map(x => parseInt(x, 10) || 0));
  if (a.manifest) {
    try { const m = await (await fetchRetry(a.manifest)).json();
      for (const ic of m.icons || []) cands.push({ href: new URL(ic.src, a.manifest).href, score: /svg/.test(ic.type || ic.src) ? 600 : Math.min(size(ic.sizes), 512) - (/maskable/.test(ic.purpose || '') && !/any/.test(ic.purpose || '') ? 100 : 0) });
    } catch {}
  }
  for (const ic of a.icons) cands.push({ href: ic.href, score: /svg/.test(ic.type || ic.href) ? 600 : size(ic.sizes) || (/apple/.test(ic.rel) ? 180 : 32) });
  const best = cands.filter(c => /^https?:|^data:/.test(c.href)).sort((x, y) => y.score - x.score)[0];
  return best && best.score >= 64 ? best.href : undefined;
}
async function quickStoryboard(b, url) {
  const T = await openTab(b, { width: 1440, height: 900 });
  let a; try { await load(T, url, hideCss()); a = await T.ev('__promo.analyze()'); } finally { await T.close(); }
  const host = new URL(a.url).host;
  const site = a.site || (a.title || '').split(/\s+[|–—·:-]\s+/)[0].trim() || host;
  const title = opt('title') || site;
  const tagline = opt('tagline') || firstSentence(a.desc, 110) || undefined;
  const brand = deriveBrand(a);
  if (opt('brand')) { const c = opt('brand').split(',').map(s => s.trim()).filter(Boolean); if (c.length) brand.bg = c.slice(0, 2); if (c[2]) brand.accent = c[2]; }
  const logo = await pickLogo(a); if (logo) brand.logo = logo;
  const fonts = (a.font || '').split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(f => f && !GENERIC_FONT.test(f)).slice(0, 2);
  if (fonts.length) brand.font = fonts.join(', ');
  const h1 = a.heads.find(h => h.tag === 'h1');
  const hook = opt('hook') || hookFrom(h1?.text, tagline, a.desc, `${title} ${tagline || ''}`);
  // scenes: the hero (with the hook), then the main sections (h2, else h3) spread over the page
  let secs = a.heads.filter(h => h.tag === 'h2' && h.y > a.vh * 0.6);
  if (secs.length < 2) secs = a.heads.filter(h => h.tag !== 'h1' && h.y > a.vh * 0.6);
  const seen = new Set(); secs = secs.filter(h => { const k = h.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  secs = secs.filter((h, i) => i === 0 || h.y - secs[i - 1].y > a.vh * 0.35); // skip headings a few lines apart
  const total = Math.min(Number(opt('seconds', 30)), 120) * 1000, heroMs = 3000;
  let avail = total - DEF.cta * 1000 - heroMs;
  const n = Math.max(0, Math.min(secs.length, Math.floor(avail / 3400)));
  const pick = n >= secs.length ? secs : Array.from({ length: n }, (_, i) => secs[Math.round(i * (secs.length - 1) / Math.max(1, n - 1))]);
  const r1 = s => Math.round(s / 100) / 10;
  const scenes = [{ url: a.url, caption: hook, seconds: r1(heroMs), actions: [] }];
  if (pick.length) {
    const per = Math.min(4500, avail / pick.length);
    for (const h of pick) scenes.push({ caption: clipText(h.text, 60), seconds: r1(per), actions: [{ scroll: h.sel, ms: 1300 }] });
  } else {
    // no sections (an app screen): visit a few of its own nav links by URL (read-only), else scroll the page slowly
    const bad = /log ?out|sign ?out|log ?in|sign ?(in|up)|admin|account|cart|checkout|delete/i;
    const links = [...new Map(a.links.filter(l => !bad.test(l.href + ' ' + l.text)).map(l => [l.href, l])).values()].slice(0, Math.min(4, Math.floor(avail / 3400)));
    for (const l of links) scenes.push({ url: l.href, caption: clipText(l.text, 60), seconds: r1(Math.min(4500, avail / links.length)), actions: a.scrollH > a.vh * 1.3 ? [{ scroll: Math.round(a.vh * 0.6), ms: 1600 }] : [] });
    if (!links.length && a.scrollH > a.vh * 1.3) for (let k = 0; k < Math.min(4, Math.floor(avail / 3400)); k++) scenes.push({ seconds: 3.4, actions: [{ scroll: Math.round(a.vh * 0.7), ms: 1400 }] });
  }
  const sb = { title, hook, ...(tagline ? { tagline } : {}), brand, outro: { cta: opt('cta', 'See it live'), url: host + (new URL(a.url).pathname.replace(/\/$/, '') || ''), seconds: DEF.cta } };
  if (opt('platform')) sb.platform = opt('platform');
  if (opt('music')) sb.music = path.resolve(opt('music'));
  sb.formats = sb.platform === 'fiverr' ? ['16x9'] : ['shorts', 'reels', 'tiktok'].includes(sb.platform) ? ['9x16'] : Object.keys(FMT);
  sb.scenes = scenes;
  return sb;
}

// ---------- assets: logo as a data URL, brand font from Google Fonts ----------
const fetchRetry = async (url, opts = {}, ms = 12000) => { try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }); } catch { return fetch(url, { ...opts, signal: AbortSignal.timeout(ms * 2) }); } };
async function loadLogo(src, base) {
  if (!src) return null;
  try {
    if (/^data:/.test(src)) return src;
    if (/^https?:/.test(src)) { const r = await fetchRetry(src); if (!r.ok) throw new Error('HTTP ' + r.status); const type = (r.headers.get('content-type') || '').split(';')[0] || 'image/png'; return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`; }
    const f = path.resolve(base, src.replace(/^file:\/\//, '')), ext = path.extname(f).slice(1).toLowerCase();
    return `data:${ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : 'image/' + (ext || 'png')};base64,${fs.readFileSync(f).toString('base64')}`;
  } catch (e) { warn(`logo ${src}: ${e.message}; using a monogram`); return null; }
}
async function googleFonts(list) {
  let css = ''; const got = [];
  for (const fam of (list || '').split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(f => f && !GENERIC_FONT.test(f)).slice(0, 3)) {
    for (const spec of [':wght@400;600;700;800;900', ':wght@400;700;800', ':wght@400;700', '']) {
      try {
        const r = await fetchRetry(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}${spec}&display=block`,
          { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' } });
        if (r.ok) { css += await r.text(); got.push(fam); break; }
        if (r.status !== 400) break;
      } catch { if (spec) continue; } // a timeout: try the next, simpler request
    }
  }
  return { css, got };
}

// ---------- optional voiceover: edge-tts through scripts/voice.py, one call per sentence ----------
const sha = (x, n = 12) => crypto.createHash('sha1').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, n);
const durOf = f => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8', windowsHide: true }).stdout) || 0;
async function voiceover(sb, cache) {
  const items = [];
  sb.scenes.forEach((sc, i) => sentences(sc.voiceover || '').forEach((text, k) => items.push({ id: `${i}.${k}`, text })));
  sentences(sb.outro?.voiceover || '').forEach((text, k) => items.push({ id: `cta.${k}`, text }));
  if (!items.length) return { vo: {}, note: '' };
  if (sb.platform === 'fiverr') return { vo: {}, note: 'voiceover skipped: Fiverr asks for a human voice, not text-to-speech (record your own and pass it with --music)' };
  const py = process.env.PROMO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  if (spawnSync(py, ['-c', 'import edge_tts'], { windowsHide: true }).status !== 0) return { vo: {}, note: `voiceover skipped: edge-tts is not installed for ${py} (pip install edge-tts, or set PROMO_PYTHON to a Python that has it); captions use the voiceover text` };
  const dev = items.some(x => /[ऀ-ॿ]/.test(x.text));
  const voice = sb.voice?.name || (dev ? 'ne-NP-SagarNeural' : 'en-US-AndrewMultilingualNeural'), rate = sb.voice?.rate || '+0%';
  fs.mkdirSync(cache, { recursive: true });
  const vo = {}, todo = [];
  for (const it of items) {
    it.base = path.join(cache, `tts-${sha([voice, rate, it.text])}`);
    try { vo[it.id] = { ...JSON.parse(fs.readFileSync(it.base + '.json', 'utf8')), file: it.base + '.wav' }; if (!fs.existsSync(it.base + '.wav')) throw 0; } catch { todo.push(it); }
  }
  if (todo.length) {
    const job = path.join(cache, `job-${process.pid}.json`);
    fs.writeFileSync(job, JSON.stringify({ voice, rate, items: todo.map(x => ({ id: x.id, text: x.text, out: x.base })) }));
    const r = spawnSync(py, [fileURLToPath(new URL('./voice.py', import.meta.url)), job], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    rmDir(job);
    let res = []; try { res = JSON.parse(r.stdout); } catch { return { vo: {}, note: `voiceover skipped: edge-tts failed (${(r.stderr || '').trim().split('\n').pop() || 'no output'})` }; }
    for (const [k, x] of res.entries()) {
      const it = todo[k]; if (x.error || !x.words?.length) return { vo: {}, note: `voiceover skipped: ${x.error || 'no word timings'} for "${it.text}"` };
      // trim edge-tts padding using the word timings: <= 40 ms of leading silence (rule 16)
      const lead = Math.max(0, x.words[0].t - 0.04), end = x.words.at(-1).t + x.words.at(-1).d + 0.16;
      const t = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', x.mp3, '-af', `atrim=${lead}:${end},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, end - lead - 0.05)}:d=0.05`, '-ar', '48000', '-ac', '2', it.base + '.wav'], { windowsHide: true });
      rmDir(x.mp3);
      if (t.status) return { vo: {}, note: 'voiceover skipped: could not convert the speech audio' };
      const meta = { dur: durOf(it.base + '.wav'), words: x.words.map(w => ({ w: w.w, t: +Math.max(0, w.t - lead).toFixed(3), d: w.d })) };
      fs.writeFileSync(it.base + '.json', JSON.stringify(meta)); vo[it.id] = { ...meta, file: it.base + '.wav' };
    }
  }
  return { vo, note: `voiceover: ${items.length} sentence(s), ${voice} ${rate}${todo.length < items.length ? ` (${items.length - todo.length} cached)` : ''}`, voice, used: items.map(x => x.base) };
}

// ---------- recorder: one group of scenes (a page and the scenes that continue on it), frame by frame ----------
const cl = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
const io3 = p => p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
const lerp = (a, b, p) => a + (b - a) * p;
async function recordGroup(b, sb, fmt, group, dir, want, tag) {
  const F = FMT[fmt], css = hideCss(sb.hide), gap = Math.round(F.vh * 0.06);
  fs.mkdirSync(dir, { recursive: true });
  const T = await openTab(b, { width: F.vw, height: F.vh, dsf: F.dsf, mobile: F.mobile, scheme: sb.colorScheme });
  const cur = { x: F.vw * 0.64, y: F.vh * 0.78, o: 0 }, out = [], told = new Set();
  const once = m => { if (!told.has(m)) { told.add(m); warn(`${tag} ${m}`); } };
  let shots = 0, since = 0;
  const shoot = async (z, sx, sy) => {
    const p = { format: 'jpeg', quality: 88, optimizeForSpeed: true };
    if (z) p.clip = { x: sx + z.x, y: sy + z.y, width: z.w, height: z.h, scale: z.z }; // re-rendered at the zoom, so text stays sharp
    const { data } = await T.s('Page.captureScreenshot', p);
    fs.writeFileSync(path.join(dir, `${String(++shots).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64')); since = 0;
  };
  const mouse = (type, x, y) => T.s('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const press = ([x, y], down) => F.mobile ? T.s('Input.dispatchTouchEvent', { type: down ? 'touchStart' : 'touchEnd', touchPoints: down ? [{ x, y }] : [] }) : mouse(down ? 'mousePressed' : 'mouseReleased', x, y);
  try {
    for (const sc of group) {
      if (sc.url) await load(T, sc.url, css);
      const frames = []; out.push(frames);
      const acts = sc.acts.map(a => ({ ...a, st: null }));
      const ptr = acts.filter(a => a.kind === 'click' || a.kind === 'type' || (a.kind === 'hover' && !F.mobile));
      const show0 = ptr.length ? ptr[0].t0 - 150 : Infinity, show1 = ptr.length ? ptr.at(-1).t1 + 600 : -1;
      const presses = []; let ai = 0, zoom = null, zkey = '';
      // set up an action when its time comes: find the element, plan the scroll that brings it into view
      const begin = async a => {
        if (a.kind === 'wait') return { ok: false };
        const what = JSON.stringify(a[a.kind]);
        try {
          if (a.kind === 'scroll') { const r = await T.ev(`__promo.scrollPlan(${what}, ${gap})`); if (r.miss) once(`scene ${sc.n}: nothing on the page matches ${what}; scrolling down instead`); return { ok: true, ...r }; }
          if (a.kind === 'hover' && F.mobile) { once(`scene ${sc.n}: hover does nothing on a phone, so it is a pause in 9x16`); return { ok: false }; }
          const r = await T.ev(`__promo.target(${what})`);
          if (!r) { once(`scene ${sc.n}: nothing on the page matches ${what}; skipped that ${a.kind}`); return { ok: false }; }
          const move = moveMs(a);
          if (a.kind === 'click' || a.kind === 'type') presses.push({ x: r.x, y: r.y, at: a.t0 + move });
          return { ok: true, ...r, move, cx: cur.x, cy: cur.y, typed: 0 };
        } catch (e) { die(`${tag} scene ${sc.n}: ${a.kind} ${what}: ${e.message}`); }
      };
      for (let f = 0; f < sc.frames; f++) {
        const t = f * STEP, navs = T.navs; let js = '', moved = false, input = false;
        while (ai < acts.length && t >= acts[ai].t0) {
          const a = acts[ai], p = Math.min(1, (t - a.t0) / a.ms), lt = t - a.t0;
          if (!a.st) a.st = await begin(a);
          const st = a.st;
          const scrollTo = e => { const y = lerp(st.from, st.to, e); if (y !== st.ly) { st.ly = y; js = `__promo.go(${y.toFixed(1)});`; moved = true; } };
          if (st.ok && a.kind === 'scroll') scrollTo(io3(p));
          else if (st.ok && a.kind === 'zoom') {
            const inn = st.move, outMs = Math.min(700, a.ms * 0.3), e = lt < inn ? io3(lt / inn) : lt > a.ms - outMs ? io3(Math.max(0, (a.ms - lt) / outMs)) : 1;
            if (lt <= inn) scrollTo(io3(Math.min(1, lt / inn)));
            const z = 1 + ((a.scale ?? 1.6) - 1) * e, w = F.vw / z, h = F.vh / z, cx = lerp(F.vw / 2, st.x, e), cy = lerp(F.vh / 2, st.y, e);
            zoom = p >= 1 || z <= 1.0005 ? null : { z, w, h, x: cl(cx - w / 2, 0, F.vw - w), y: cl(cy - h / 2, 0, F.vh - h) };
          } else if (st.ok) { // click, hover, type: glide the cursor over (scrolling the target into view on the way), press, type
            const e = io3(Math.min(1, lt / st.move));
            scrollTo(e);
            if (!F.mobile) {
              const dx = st.x - st.cx, dy = st.y - st.cy, len = Math.hypot(dx, dy) || 1, arc = Math.sin(Math.PI * e) * len * 0.08;
              const nx = lerp(st.cx, st.x, e) - dy / len * arc, ny = lerp(st.cy, st.y, e) + dx / len * arc;
              if (nx !== cur.x || ny !== cur.y) { cur.x = nx; cur.y = ny; await mouse('mouseMoved', nx, ny); input = true; }
            }
            if (a.kind !== 'hover' && lt >= st.move && !st.down) { st.down = (await T.ev('__promo.at()').catch(() => null)) || [st.x, st.y]; await press(st.down, true); input = true; }
            if (a.kind !== 'hover' && lt >= st.move + 100 && !st.up) { st.up = true; await press(st.down, false); input = true; }
            if (a.kind === 'type' && st.up) {
              const chars = [...a.text], per = Math.max(15, (a.ms - st.move - 800) / chars.length);
              const due = p >= 1 ? chars.length : Math.min(chars.length, Math.max(0, Math.floor((lt - st.move - 300) / per) + 1));
              for (; st.typed < due; st.typed++) await T.s('Input.insertText', { text: chars[st.typed] });
              if (due) input = true;
            }
          }
          if (t >= a.t1) { ai++; if (a.kind === 'zoom') zoom = null; } else break;
        }
        if (!F.mobile) cur.o = t >= show0 && t <= show1 ? Math.min(1, cur.o + 0.2) : Math.max(0, cur.o - 0.1);
        let res = null;
        try { res = await T.ev(`(() => { const P = __promo; ${js} return [P.advance(${STEP}), ${F.mobile ? 'P.top()' : "''"}, P.pending(), scrollX, scrollY]; })()`); } catch {}
        if (T.navs !== navs || !res) { // a click opened another page: let it load, then carry on
          await settle(T, css);
          res = [true, F.mobile ? await T.ev('__promo.top()').catch(() => '#ffffff') : '', 0, ...await T.ev('[scrollX, scrollY]').catch(() => [0, 0])];
        }
        if (res[2] || T.busy()) { await T.waitNet(5000); await T.waitImgs(3000); }
        const zk = zoom ? `${zoom.z.toFixed(4)},${zoom.x.toFixed(1)},${zoom.y.toFixed(1)}` : '';
        if (want ? want.has(`${sc.n}:${f}`) : f === 0 || res[0] || res[2] || moved || input || zk !== zkey || since >= 20) await shoot(zoom, res[3], res[4]); else since++;
        zkey = zk;
        // cursor and taps in 0..1 coordinates of the captured image (which is the zoomed region while zooming)
        const R = zoom || { x: 0, y: 0, w: F.vw, h: F.vh, z: 1 }, nx = x => +((x - R.x) / R.w).toFixed(4), ny = y => +((y - R.y) / R.h).toFixed(4);
        const pr = presses.reduce((m, q) => { const d = t - q.at; return d >= -60 && d <= 240 ? Math.max(m, Math.sin(Math.PI * (d + 60) / 300)) : m; }, 0);
        frames.push({
          i: shots, url: T.url, top: res[1], z: +R.z.toFixed(3),
          c: !F.mobile && cur.o > 0 ? [nx(cur.x), ny(cur.y), +cur.o.toFixed(2), +pr.toFixed(2)] : null,
          ev: presses.filter(q => t - q.at >= -260 && t - q.at <= 700).slice(-3).map(q => [nx(q.x), ny(q.y), Math.round(t - q.at)]),
        });
      }
    }
  } finally { await T.close(); }
  return { scenes: out, shots };
}
// Record every group of a format, reusing earlier recordings: the cache key covers everything that changes what the
// browser shows (URL, actions, timing, viewport, hidden elements), not captions, voice or styling.
async function recordFormat(b, sb, P, A, tag, want) {
  const F = FMT[P.fmt], groups = [];
  for (const s of P.scenes) (s.url || !groups.length ? groups[groups.length] = [] : groups.at(-1)).push(s);
  const out = [], used = []; let cached = 0, shots = 0;
  await Promise.all(groups.map(async (g, k) => {
    const key = sha({ v: 1, fmt: P.fmt, F, hide: sb.hide || [], scheme: sb.colorScheme || 'light', scenes: g.map(s => ({ url: s.url, frames: s.frames, acts: s.acts.map(({ st, ...a }) => a) })) });
    const dir = path.join(want || !A.cache ? A.work : A.cache, `rec-${P.fmt}-${key}${want ? '-preview' : ''}`), metaF = path.join(dir, 'meta.json');
    let rec = null;
    if (A.cache && !flag('fresh')) try { rec = JSON.parse(fs.readFileSync(metaF, 'utf8')); cached++; } catch {}
    if (!rec) { rmDir(dir); rec = await recordGroup(b, sb, P.fmt, g, dir, want, tag); if (A.cache && !want) fs.writeFileSync(metaF, JSON.stringify(rec)); }
    used.push(dir); shots += rec.shots;
    out[k] = rec.scenes.map(fr => fr.map(x => ({ ...x, src: pathToFileURL(path.join(dir, `${String(x.i).padStart(6, '0')}.jpg`)).href })));
  }));
  return { scenes: out.flat(), used, cached, groups: groups.length, shots };
}

// ---------- audio: voice clips, music ducked under the voice, sound effects, two-pass loudnorm ----------
const ff = (args, label) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }); if (r.status) die(`ffmpeg failed (${label}): ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`); return r; };
const measure = inArgs => { // loudnorm's first pass: integrated loudness, true peak, LRA
  const e = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...inArgs, '-vn', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }).stderr || '';
  const a = e.lastIndexOf('{'), z = e.indexOf('}', a); try { return JSON.parse(e.slice(a, z + 1)); } catch { return null; } };
const SFX = { // synthesized, so there is no third-party audio to license
  whoosh: "aevalsrc='(random(0)*2-1)*0.5*sin(PI*t/0.45)':d=0.45:s=48000,highpass=f=500,lowpass=f=5000",
  click: "aevalsrc='0.5*(random(0)*2-1)*exp(-260*t)+0.3*sin(2*PI*2400*t)*exp(-90*t)':d=0.05:s=48000,highpass=f=1200",
  impact: "aevalsrc='0.9*sin(2*PI*(55+140*exp(-18*t))*t)*exp(-7*t)+0.35*(random(0)*2-1)*exp(-30*t)':d=0.7:s=48000",
};
function buildAudio(P, A, dir) {
  const D = P.seconds, lines = [...P.scenes.flatMap(s => s.lines.map(l => ({ ...l, abs: s.start * STEP + l.at }))), ...P.ctaLines.map(l => ({ ...l, abs: P.ctaStart + l.at }))];
  const inputs = [], parts = [], info = { voice: lines.length > 0, music: !!A.music, sfx: P.sfx.length, duckDb: null };
  const add = args => { inputs.push(...args); return inputs.filter(x => x === '-i').length - 1; };
  if (lines.length) {
    const vf = path.join(dir, 'voice.wav');
    ff([...lines.flatMap(l => ['-i', l.file]), '-filter_complex', lines.map((l, k) => `[${k}]adelay=${Math.round(l.abs)}|${Math.round(l.abs)}[v${k}]`).join(';') + ';' + lines.map((_, k) => `[v${k}]`).join('') + `amix=inputs=${lines.length}:normalize=0,apad,atrim=0:${D.toFixed(3)}[o]`, '-map', '[o]', '-ar', '48000', '-ac', '2', vf], 'voice');
    parts.push(`[${add(['-i', vf])}:a]anull[vo]`);
  }
  if (A.music) {
    // music sits 6 dB under the voice level, and 20 dB under it while someone speaks (rule 18), releasing over 300 ms
    const m = measure(['-t', '60', '-i', A.music]), v = lines.length ? measure(['-i', path.join(dir, 'voice.wav')]) : null;
    const ref = v && Number.isFinite(+v.input_i) ? +v.input_i : -14, gain = (ref - (lines.length ? 6 : 0)) - (m && Number.isFinite(+m.input_i) ? +m.input_i : -14);
    let env = '0';
    if (lines.length) { info.duckDb = 20; env = lines.map(l => { const s = l.abs / 1000, e = s + l.dur; return `clip(min((t-${(s - 0.12).toFixed(3)})/0.12,(${(e + 0.3).toFixed(3)}-t)/0.3),0,1)`; }).reduce((x, y) => `max(${x},${y})`); }
    parts.push(`[${add(['-stream_loop', '-1', '-i', A.music])}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(2)}dB,volume='pow(10,-0.7*(${env}))':eval=frame,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, D - 1.2).toFixed(3)}:d=1.2[mu]`);
  }
  P.sfx.forEach((x, k) => { const f = path.join(dir, `sfx-${x.type}.wav`); if (!fs.existsSync(f)) ff(['-f', 'lavfi', '-i', SFX[x.type], '-ac', '2', f], 'sfx'); parts.push(`[${add(['-i', f])}:a]volume=${x.type === 'impact' ? 0.42 : x.type === 'whoosh' ? 0.3 : 0.28},adelay=${Math.round(x.at)}|${Math.round(x.at)}[x${k}]`); });
  const labels = [...(lines.length ? ['[vo]'] : []), ...(A.music ? ['[mu]'] : []), ...P.sfx.map((_, k) => `[x${k}]`)];
  const out = path.join(dir, 'audio.wav'), mix = path.join(dir, 'mix.wav');
  if (!labels.length) { ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', D.toFixed(3), out], 'silence'); return { file: out, ...info }; }
  ff([...inputs, '-filter_complex', `${parts.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0,apad,atrim=0:${D.toFixed(3)}[o]`, '-map', '[o]', '-ar', '48000', '-ac', '2', mix], 'mix');
  if (!lines.length && !A.music) { fs.renameSync(mix, out); return { file: out, ...info }; } // effects only: keep them quiet, no loudness boost
  const m = measure(['-i', mix]); // two-pass loudnorm to -14 LUFS (rule 17); TP -1.5 leaves room for AAC overshoot
  const norm = m ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true` : 'loudnorm=I=-14:TP=-1.5:LRA=11';
  ff(['-i', mix, '-af', `${norm},aresample=48000`, '-ar', '48000', out], 'loudnorm');
  return { file: out, ...info };
}

// ---------- compositor stage: one HTML page per format, drawn by the browser (so Nepali and emoji just work) ----------
// 9:16 keeps every word inside x 65-890, y 250-1440 (clear of Reels/Shorts/TikTok buttons and captions); 16:9 uses the width.
const LAYOUT = {
  '9x16': { band: [65, 250, 825, 280], bandFont: [96, 56, 3], dev: { x: 177, y: 556, w: 600, inner: 568 }, cap: [477, 1190, 700], capFont: [88, 72], pill: 52 },
  '16x9': { band: [160, 18, 1600, 178], bandFont: [80, 50, 2], dev: { x: 320, y: 212, w: 1280, bar: 50 }, cap: [960, 915, 1100], capFont: [80, 72], pill: 48 },
};
function stageHtml(sb, P, A) {
  const F = FMT[P.fmt], v = P.fmt === '9x16', B = A.brand, L = LAYOUT[P.fmt];
  const D = { W: F.W, H: F.H, v, L, scenes: P.scenes.map(s => [s.start * STEP, s.end * STEP]), ctaStart: P.ctaStart, T: P.total * STEP, hook: P.hook, chunks: P.chunks, rehooks: P.rehooks,
    title: sb.title, tagline: sb.tagline || '', cta: sb.outro?.cta || 'See it live', url: A.pillText, logo: A.logo, fonts: A.fonts.got };
  const rgba = (hex, a) => `rgba(${hex2rgb(hex).join(',')},${a})`;
  const fam = [...new Set([...A.fonts.got, ...(B.font || '').split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean)])].map(f => `"${f}"`).concat(['"Segoe UI Variable Display"', '"Segoe UI"', 'system-ui', '-apple-system', '"Helvetica Neue"', 'Arial',
    '"Nirmala UI"', 'Mangal', '"Noto Sans Devanagari"', '"Kohinoor Devanagari"', '"Segoe UI Emoji"', '"Apple Color Emoji"', '"Noto Color Emoji"', 'sans-serif']).join(',');
  const ui = '"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,"Nirmala UI",sans-serif';
  const noise = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}")`;
  const s = v ? L.dev.inner / 390 : 0, sh = Math.round(44 * s), scrH = Math.round(844 * s), devH = v ? 32 + sh + scrH : L.dev.bar + Math.round(L.dev.w * 900 / 1440);
  const dev = v
    ? `<div id="dev" class="L phone"><div class="inner"><div class="status" id="status"><b>9:41</b><i class="cam"></i><span class="icons"><svg width="50" height="18" viewBox="0 0 54 20"><g fill="currentColor"><rect x="0" y="12" width="4" height="6" rx="1"/><rect x="6" y="8" width="4" height="10" rx="1"/><rect x="12" y="4" width="4" height="14" rx="1"/><rect x="25" y="3" width="25" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="28" y="6" width="17" height="8" rx="2"/><rect x="51" y="8" width="2.5" height="4" rx="1"/></g></svg></span></div><div class="screen" id="screen"></div></div></div>`
    : `<div id="dev" class="L win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><div class="url"><svg id="lock" width="12" height="15" viewBox="0 0 12 15"><path d="M2.5 6.5V4.6a3.5 3.5 0 0 1 7 0v1.9" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="0.5" y="6.5" width="11" height="8" rx="2" fill="currentColor"/></svg><span id="host"></span><span id="path"></span></div></div><div class="screen" id="screen"></div></div>`;
  const [bx, by, bw, bh] = L.band, [cx, cy, cw] = L.cap;
  const css = `${A.fonts.css}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${F.W}px;height:${F.H}px;overflow:hidden;background:${B.bg[0]}}
body{font-family:${fam};color:${B.text};-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.L{position:absolute}
#bg{inset:0;background:radial-gradient(${v ? '130% 55% at 15% 0%' : '75% 95% at 8% 0%'},${rgba(B.accent, 0.17)},transparent 70%),radial-gradient(${v ? '120% 55% at 100% 100%' : '70% 90% at 100% 100%'},${rgba(B.bg[1], 0.9)},transparent 70%),linear-gradient(${v ? 165 : 150}deg,${B.bg.join(',')})}
#grain{inset:0;opacity:.06;background-image:${noise};mix-blend-mode:overlay}
.band{left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;display:flex;align-items:center;justify-content:center;text-align:center}
.band .t{font-weight:800;letter-spacing:-.025em;line-height:1.06;text-wrap:balance;max-width:${bw}px;text-shadow:0 4px 24px rgba(0,0,0,.25)}
#chip{gap:${v ? 26 : 22}px}
#chip .name{font-weight:800;letter-spacing:-.02em;font-size:${v ? 56 : 58}px;line-height:1.05;text-align:left}
#chip .tag{font-weight:500;opacity:.78;font-size:${v ? 30 : 32}px;line-height:1.25;text-align:left;margin-top:6px;max-width:${v ? 600 : 1100}px}
.logo{display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;border-radius:23%;width:${v ? 104 : 92}px;height:${v ? 104 : 92}px;font-size:${v ? 56 : 50}px}
.logo img{width:100%;height:100%;object-fit:contain;display:block}
.logo.app,.logo.tile,.logo.mono{box-shadow:0 14px 34px -12px rgba(0,0,0,.45)}
.logo.tile{background:#fff}.logo.tile img{width:72%;height:72%}
.logo.mark{border-radius:0;overflow:visible;filter:drop-shadow(0 10px 24px rgba(0,0,0,.35))}
.logo.mono{background:${B.accent};color:${B.onAccent};font-weight:800}
#cap{left:${cx - cw / 2}px;width:${cw}px;top:${cy - 150}px;height:300px;display:flex;align-items:center;justify-content:center;text-align:center;pointer-events:none}
#cap .t{font-weight:900;line-height:1.08;letter-spacing:-.01em;color:#fff;-webkit-text-stroke:14px #0b0b0b;paint-order:stroke fill;text-shadow:0 8px 24px rgba(0,0,0,.35);max-width:${cw}px}
#cap .t span{display:inline-block}#cap .t .now{color:${B.accent}}
#pillB{left:${cx - cw / 2}px;width:${cw}px;top:${cy - 60}px;height:120px;display:flex;align-items:center;justify-content:center}
#pill{padding:.38em 1.05em;border-radius:999px;background:${B.accent};color:${B.onAccent};font-weight:800;font-size:${L.pill}px;letter-spacing:-.01em;white-space:nowrap;box-shadow:0 14px 36px -14px ${rgba(B.accent, 0.8)}}
.win{left:${L.dev.x}px;top:${L.dev.y}px;width:${L.dev.w}px;height:${devH}px;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 60px 120px -30px rgba(0,0,0,.6),0 24px 48px -24px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.1)}
.bar{position:relative;height:${L.dev.bar}px;background:#ededf0;border-bottom:1px solid #d9d9de;display:flex;align-items:center;padding:0 20px;gap:9px}
.bar i{width:13px;height:13px;border-radius:50%}
.url{position:absolute;left:50%;top:10px;transform:translateX(-50%);height:30px;min-width:440px;max-width:820px;padding:0 20px;border-radius:9px;background:#fff;box-shadow:0 0 0 1px #dcdce1;display:flex;align-items:center;justify-content:center;gap:7px;font:500 15px/1 ${ui};color:#1d1d1f;white-space:nowrap;overflow:hidden}
#lock{color:#6e6e73;margin-right:3px;flex:none}#path{color:#8a8a8f}
.win .screen{position:absolute;left:0;top:${L.dev.bar}px;width:${L.dev.w}px;height:${devH - (L.dev.bar || 0)}px;overflow:hidden;background:#fff}
.phone{left:${L.dev.x}px;top:${L.dev.y}px;width:${L.dev.w}px;height:${devH}px;border-radius:84px;background:#0c0c0e;padding:16px;box-shadow:0 70px 120px -40px rgba(0,0,0,.65),0 0 0 2px #2b2b30,0 0 0 3px rgba(255,255,255,.08)}
.inner{position:relative;width:${L.dev.inner}px;height:100%;border-radius:68px;overflow:hidden;background:#fff}
.status{position:relative;height:${sh}px;display:flex;align-items:center;justify-content:space-between;padding:6px 50px 0;font:600 22px/1 ${ui};background:#fff;color:#111}
.status b{font-weight:600}.cam{position:absolute;left:50%;top:17px;width:28px;height:28px;margin-left:-14px;border-radius:50%;background:#0c0c0e}
.phone .screen{position:relative;width:${L.dev.inner}px;height:${scrH}px;overflow:hidden;background:#fff}
.screen img{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
#cursor{left:0;top:0;width:34px;height:34px;margin:-3px 0 0 -5px;transform-origin:5px 3px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.35))}
.rip{left:0;top:0;width:100px;height:100px;margin:-50px 0 0 -50px;border-radius:50%;border:4px solid ${B.accent};background:${rgba(B.accent, 0.22)}}
.tap{left:0;top:0;width:76px;height:76px;margin:-38px 0 0 -38px;border-radius:50%;background:rgba(20,20,20,.22);border:4px solid rgba(255,255,255,.95);box-shadow:0 6px 22px rgba(0,0,0,.35)}`;
  const js = `const D = ${JSON.stringify(D)};
const $ = id => document.getElementById(id);
const cl = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x, o3 = p => 1 - (1 - p) ** 3, i3 = p => p * p * p, io3 = p => p < .5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2, ob = p => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;
let K = [];
const S = (el, tf, op) => { op = Math.round(op * 1000) / 1000; if (el._t !== tf) { el.style.transform = tf; el._t = tf; } if (el._o !== op) { el.style.opacity = op; el.style.visibility = op > 0 ? 'visible' : 'hidden'; el._o = op; } K.push(tf, op); };
const fit = (el, max, min, lines, width, height) => { for (let fs = max; fs >= min; fs -= 2) { el.style.fontSize = fs + 'px'; const lh = parseFloat(getComputedStyle(el).lineHeight), h = el.getBoundingClientRect().height;
  if (el.scrollWidth <= Math.min(width, el.clientWidth) + 1 && h <= lh * lines + 2 && h <= height) return fs; } return min; };
const lum = c => { const m = String(c).match(/[\\d.]+/g); let r, g, b; if (/^#/.test(c)) { let h = c.slice(1); if (h.length === 3) h = h.replace(/./g, x => x + x); [r, g, b] = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); } else if (m) [r, g, b] = m.map(Number); else return 1; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
async function logo(el) {
  const mono = () => { el.className = 'logo mono'; el.textContent = [...new Intl.Segmenter().segment(D.title.trim())][0]?.segment.toUpperCase() || '•'; };
  if (!D.logo) return mono();
  const img = new Image(); img.src = D.logo; try { await img.decode(); } catch { return mono(); }
  let kind = 'tile';
  try { const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 48, 48); const d = x.getImageData(0, 0, 48, 48).data, a = (px, py) => d[(py * 48 + px) * 4 + 3];
    if ([a(2, 2), a(45, 2), a(2, 45), a(45, 45)].every(v => v > 230)) kind = 'app';
    else { let L = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { L += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++; } if (n && L / n > 0.72) kind = 'mark'; } } catch {}
  el.className = 'logo ' + kind; el.appendChild(img);
}
const dev = $('dev'), screen = $('screen'), A = new Image(), Bi = new Image(), cursor = document.createElement('div'), cap = $('cap');
screen.append(A, Bi, cursor); cursor.className = 'L'; cursor.id = 'cursor';
cursor.innerHTML = '<svg width="34" height="34" viewBox="0 0 34 34"><path d="M6 3.5v24.2l6.3-6.1 4.2 9.6 4.3-1.9-4.2-9.4h8.8z" fill="#111" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>';
const rips = [0, 1, 2].map(() => { const e = document.createElement('div'); e.className = 'L rip'; screen.appendChild(e); return e; });
const taps = D.v ? [0, 1, 2].map(() => { const e = document.createElement('div'); e.className = 'L tap'; screen.appendChild(e); return e; }) : [];
const SW = screen.offsetWidth, SH = screen.offsetHeight, capT = document.createElement('div'); capT.className = 't'; cap.appendChild(capT);
const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
let shown = -1;
const showChunk = i => { if (i === shown) return; shown = i; capT.textContent = ''; if (i < 0) return; const c = D.chunks[i]; c.text.split(' ').forEach((w, k) => { const s = document.createElement('span'); s.textContent = w; capT.append(s, ' '); }); capT.style.fontSize = c.fs + 'px'; };
window.__stage = {
  async ready() {
    $('hookT').textContent = D.hook.text; $('ctaT').textContent = D.cta; $('nameT').textContent = D.title; $('tagT').textContent = D.tagline; if (!D.tagline) $('tagT').remove();
    if (D.url) $('pill').textContent = D.url; else $('pillB').remove();
    const all = [D.hook.text, D.title, D.tagline, D.cta, D.url, ...D.chunks.map(c => c.text)].join(' ');
    await Promise.all(D.fonts.flatMap(f => ['400', '700', '800', '900'].map(w => document.fonts.load(w + ' 40px "' + f + '"', all).catch(() => {}))));
    await document.fonts.ready;
    await logo($('logoC'));
    const [bmax, bmin, bl] = D.L.bandFont, bw = D.L.band[2], bh = D.L.band[3], m = { texts: [] };
    for (const id of ['hookT', 'ctaT']) { const fs = fit($(id), bmax, bmin, bl, bw, bh); m.texts.push({ kind: id === 'hookT' ? 'hook' : 'cta', text: $(id).textContent, fs, weight: 800, box: box($(id)) }); }
    m.texts.push({ kind: 'brand', text: D.title, fs: parseFloat(getComputedStyle($('nameT')).fontSize), weight: 800, box: box($('chip')) });
    if ($('pillB')) { const p = $('pill'), w = D.L.cap[2]; for (let fs = D.L.pill; fs > 24 && p.getBoundingClientRect().width > w; fs -= 2) p.style.fontSize = fs + 'px'; m.texts.push({ kind: 'url', text: D.url, fs: parseFloat(getComputedStyle(p).fontSize), weight: 800, box: box(p) }); }
    D.chunks.forEach((c, i) => { shown = -1; c.fs = D.L.capFont[0]; showChunk(i); capT.style.whiteSpace = 'nowrap'; while (c.fs > D.L.capFont[1] && capT.scrollWidth > D.L.cap[2]) { c.fs -= 2; capT.style.fontSize = c.fs + 'px'; } capT.style.whiteSpace = '';
      m.texts.push({ kind: 'caption', text: c.text, fs: c.fs, weight: 900, box: box(capT) }); });
    shown = -2; showChunk(-1);
    const cs = getComputedStyle(capT); m.caption = { weight: +cs.fontWeight, stroke: parseFloat(cs.webkitTextStrokeWidth) / 2, fill: cs.color, strokeColor: cs.webkitTextStrokeColor };
    for (const id of ['hook', 'chipB', 'ctaB', 'pillB']) if ($(id)) S($(id), '', 0);
    m.fonts = [...new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')))];
    return m;
  },
  async frame(st) {
    K = []; const t = st.t, T = D.T, cs = D.ctaStart;
    // band: hook from frame 0 (no fade-in), brand after it, CTA in the last seconds
    if (t < D.hook.e) { const q = i3(cl((t - (D.hook.e - 250)) / 250)); S($('hook'), 'translateY(' + (-14 * q).toFixed(1) + 'px) scale(' + (1 + 0.035 * (1 - o3(cl(t / 260)))).toFixed(4) + ')', 1 - q); } else S($('hook'), '', 0);
    if (t >= D.hook.e && t < cs) { const p = o3(cl((t - D.hook.e - 60) / 450)), q = cl((t - (cs - 220)) / 220); S($('chipB'), 'translateY(' + (18 * (1 - p)).toFixed(1) + 'px)', p * (1 - q)); } else S($('chipB'), '', 0);
    if (t >= cs) { const p = cl((t - cs) / 260); S($('ctaB'), 'scale(' + (1 + 0.1 * (1 - ob(p))).toFixed(4) + ')', cl(p * 2)); if ($('pillB')) { const pp = cl((t - cs - 250) / 300); S($('pillB'), 'translateY(' + (20 * (1 - o3(pp))).toFixed(1) + 'px) scale(' + (0.9 + 0.1 * ob(pp)).toFixed(4) + ')', cl(pp * 2)); } }
    else { S($('ctaB'), '', 0); if ($('pillB')) S($('pillB'), '', 0); }
    // device: gentle push-in / pull-out per scene (never still for long), punch-in at the rehooks, settles back for the loop
    let z = 1; const k = D.scenes.findIndex(([a, b]) => t >= a && t < b);
    if (k >= 0) { const [a, b] = D.scenes[k], p = io3(cl((t - a) / (b - a))); z = k % 2 ? 1.045 - 0.045 * p : 1 + 0.045 * p; }
    else if (t >= cs) { const last = (D.scenes.length - 1) % 2 ? 1 : 1.045; z = last + (1 - last) * io3(cl((t - cs) / 600)); }
    for (const r of D.rehooks) { const d = t - r.at; if (d >= 0 && d < 750) z += 0.05 * (d < 150 ? o3(d / 150) : 1 - io3((d - 150) / 600)); }
    S(dev, 'scale(' + z.toFixed(4) + ')', 1);
    if (st.a !== A._s) { A._s = st.a; A.src = st.a; await A.decode().catch(() => {}); }
    if (st.b) { if (st.b !== Bi._s) { Bi._s = st.b; Bi.src = st.b; await Bi.decode().catch(() => {}); } S(Bi, '', st.ba); } else S(Bi, '', 0);
    if (!D.v && st.url !== dev._u) { dev._u = st.url; let h = st.url, p = ''; try { const u = new URL(st.url); h = u.host || u.pathname; p = u.host ? (u.pathname + u.search).replace(/\\/$/, '') : ''; $('lock').style.display = u.protocol === 'https:' ? '' : 'none'; } catch {} $('host').textContent = h; $('path').textContent = p.length > 48 ? p.slice(0, 46) + '…' : p; }
    if (D.v && st.top !== dev._c) { dev._c = st.top; const s = $('status'); s.style.background = st.top; s.style.color = lum(st.top) > 0.6 ? '#111' : '#fff'; }
    K.push(st.a, st.b || '', st.url, st.top);
    if (st.c) S(cursor, 'translate(' + (st.c[0] * SW).toFixed(1) + 'px,' + (st.c[1] * SH).toFixed(1) + 'px) scale(' + (1 - 0.16 * st.c[3]).toFixed(3) + ')', st.c[2]); else S(cursor, '', 0);
    for (let i = 0; i < 3; i++) {
      const e = (st.ev || [])[i], pos = e ? 'translate(' + (e[0] * SW).toFixed(1) + 'px,' + (e[1] * SH).toFixed(1) + 'px) ' : '';
      if (!e || e[2] < 0) S(rips[i], '', 0); else { const p = cl(e[2] / 650); S(rips[i], pos + 'scale(' + ((0.2 + 0.95 * o3(p)) * (st.z || 1)).toFixed(3) + ')', 0.9 * (1 - p)); }
      if (D.v) { if (!e) S(taps[i], '', 0); else { const a = e[2]; let o, s; if (a < 0) { o = cl((a + 260) / 160); s = 1.25 - 0.25 * o3(cl((a + 260) / 260)); } else if (a < 140) { o = 1; s = 1 - 0.18 * o3(a / 140); } else { o = 1 - cl((a - 140) / 360); s = 0.82 + 0.18 * o3(cl((a - 140) / 360)); } S(taps[i], pos + 'scale(' + s.toFixed(3) + ')', o); } }
    }
    // captions: one 1-3 word chunk at a time, popping in; with a voiceover the spoken word is highlighted
    const ci = D.chunks.findIndex(c => t >= c.s && t < c.e);
    showChunk(ci);
    if (ci >= 0) { const c = D.chunks[ci], p = cl((t - c.s) / 140); S(cap, 'scale(' + (0.82 + 0.18 * ob(p)).toFixed(4) + ')', cl(p * 2.5));
      if (c.w) [...capT.children].forEach((s, j) => { const on = t >= c.w[j] && (j === c.w.length - 1 || t < c.w[j + 1]); s.className = on ? 'now' : ''; s.style.opacity = t >= c.w[j] ? 1 : 0.45; K.push(j, on, t >= c.w[j]); });
      K.push(ci); } else S(cap, '', 0);
    return K.join('|');
  },
};`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div id="bg" class="L"></div><div id="grain" class="L"></div>
${dev}
<div id="hook" class="L band"><div class="t" id="hookT"></div></div>
<div id="chipB" class="L band"><div id="chip" style="display:flex;align-items:center"><div id="logoC" class="logo"></div><div><div class="name" id="nameT"></div><div class="tag" id="tagT"></div></div></div></div>
<div id="ctaB" class="L band"><div class="t" id="ctaT"></div></div>
<div id="cap" class="L"></div>
<div id="pillB" class="L"><span id="pill"></span></div>
<script>${js}</script></body></html>`;
}

// ---------- compose: stage frames -> ffmpeg (video), or a few half-size key frames (preview) ----------
function encoder(out, dur, audio, platform) {
  const D = dur.toFixed(3), rate = platform === 'fiverr' ? ['-maxrate', '6M', '-bufsize', '12M'] : ['-maxrate', '12M', '-bufsize', '24M'];
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', audio,
    '-vf', 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '18', ...rate, '-r', String(FPS), '-g', String(FPS / 2), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', D, '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  children.add(p);
  let err = '', code = null; p.stderr.on('data', d => err += d); p.stdin.on('error', () => {});
  const done = new Promise(r => p.on('close', c => { code = c; children.delete(p); r(c); }));
  const fail = () => new Error(`ffmpeg stopped: ${err.trim().split('\n').slice(-3).join(' | ') || 'exit ' + code}`);
  return {
    write: buf => code !== null ? Promise.reject(fail()) : new Promise((res, rej) => { if (p.stdin.write(buf)) res(); else { p.stdin.once('drain', res); done.then(() => rej(fail())); } }),
    end: async () => { p.stdin.end(); if (await done) throw fail(); },
  };
}
const children = new Set();
process.on('exit', () => { for (const c of children) try { c.kill(); } catch {} });
// key frames: frame 0 (hook), the rehooks, the middle of each scene, the CTA, the last frame (loop)
function keyFrames(P, n) {
  const T = P.total, pick = new Set([0, T - 1, ...P.rehooks.map(r => Math.min(T - 1, Math.round(r.at / STEP) + 4)), ...P.scenes.map(s => Math.round((s.start + s.end) / 2)), Math.min(T - 1, Math.round(P.ctaStart / STEP) + 20)]);
  let ks = [...pick].sort((a, b) => a - b);
  while (ks.length > n) { let bi = 1, bd = Infinity; for (let i = 1; i < ks.length - 1; i++) { const d = ks[i + 1] - ks[i - 1]; if (d < bd) { bd = d; bi = i; } } ks.splice(bi, 1); }
  return ks;
}
async function compose(b, sb, P, A, rec, tag, keys) {
  const F = FMT[P.fmt], stage = path.join(A.work, `stage-${P.fmt}.html`);
  fs.writeFileSync(stage, stageHtml(sb, P, A));
  const T = await openTab(b, { width: F.W, height: F.H, dsf: keys ? 0.5 : 1, page: false });
  const hero = rec.scenes[0][0], state = g => {
    const k = P.scenes.findIndex(s => g >= s.start && g < s.end), t = g * STEP;
    if (k < 0) { // the CTA: cross-fade back to the opening frame so the end loops into frame 0
      const f = g - P.scenes.at(-1).end, last = rec.scenes.at(-1).at(-1), st = { t, a: hero.src, url: hero.url, top: hero.top };
      if (f < 9) Object.assign(st, { b: last.src, ba: +(1 - io3(f / 9)).toFixed(3) });
      return st;
    }
    const s = P.scenes[k], f = g - s.start, fr = rec.scenes[k][f], st = { t, a: fr.src, url: fr.url, top: fr.top, c: fr.c, ev: fr.ev, z: fr.z };
    if (k > 0 && s.url && f < 9) Object.assign(st, { b: rec.scenes[k - 1].at(-1).src, ba: +(1 - io3(f / 9)).toFixed(3) });
    return st;
  };
  const shots = [];
  let metrics;
  try {
    await T.s('Page.navigate', { url: pathToFileURL(stage).href });
    for (let i = 0; i < 100; i++) { await sleep(50); try { if (await T.ev('document.readyState === "complete" && !!window.__stage')) break; } catch {} }
    metrics = await T.ev('__stage.ready()');
    const shot = async () => Buffer.from((await T.s('Page.captureScreenshot', { format: 'jpeg', quality: keys ? 80 : 92, optimizeForSpeed: true })).data, 'base64');
    if (keys) { for (const g of keys) { await T.ev(`__stage.frame(${JSON.stringify(state(g))})`); shots.push(await shot()); } return { metrics, shots }; }
    const out = path.join(A.out, `promo-${P.fmt}.mp4`), enc = encoder(out, P.seconds, A.audio[P.fmt].file, sb.platform);
    const keep = flag('keep-frames') ? path.join(A.work, 'c' + P.fmt) : null; if (keep) fs.mkdirSync(keep, { recursive: true });
    let key = null, buf = null, drawn = 0;
    for (let g = 0; g < P.total; g++) {
      const k = await T.ev(`__stage.frame(${JSON.stringify(state(g))})`);
      if (k !== key) { key = k; buf = await shot(); drawn++; }
      await enc.write(buf);
      if (keep) fs.writeFileSync(path.join(keep, `${String(g + 1).padStart(6, '0')}.jpg`), buf);
      if (g === 0) fs.writeFileSync(path.join(A.out, `poster-${P.fmt}.jpg`), buf); // frame 0 = hook + product = the cover
    }
    await enc.end();
    return { metrics, out, drawn };
  } finally { await T.close(); }
}
// One small review image for the whole render: <= 12 tiles (frame 0, rehooks, scenes, CTA, last frame).
function sheet(rows, png) {
  const tiles = path.join(path.dirname(png), `.tiles-${process.pid}`); fs.mkdirSync(tiles, { recursive: true });
  const rowPngs = rows.map(({ files, w, h }, r) => {
    files.forEach((f, i) => fs.copyFileSync(f, path.join(tiles, `r${r}-${String(i).padStart(2, '0')}.jpg`)));
    const o = path.join(tiles, `row${r}.png`);
    ff(['-framerate', '1', '-i', path.join(tiles, `r${r}-%02d.jpg`), '-vf', `scale=${w}:${h},tile=${files.length}x1:padding=4:color=0x0b0b0b`, '-frames:v', '1', o], 'sheet row');
    return o;
  });
  const W = Math.max(...rows.map(r => r.files.length * (r.w + 4)));
  ff([...rowPngs.flatMap(f => ['-i', f]), '-filter_complex', rowPngs.map((_, i) => `[${i}]pad=${W}:ih:0:0:0x0b0b0b[p${i}]`).join(';') + ';' + rowPngs.map((_, i) => `[p${i}]`).join('') + (rowPngs.length > 1 ? `vstack=inputs=${rowPngs.length}` : 'null'), '-frames:v', '1', png], 'sheet');
  rmDir(tiles);
}
const frameJpg = (mp4, g, dir, name) => { const f = path.join(dir, name); ff(['-i', mp4, '-vf', `select=eq(n\\,${g})`, '-fps_mode', 'vfr', '-frames:v', '1', '-q:v', '3', f], 'frame'); return f; };

// ---------- rules check: a rendered MP4 + its sidecar (timeline, text boxes, audio setup) against the playbook ----------
const probeJson = (args, f) => { const r = spawnSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', f], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }); try { return JSON.parse(r.stdout); } catch { return {}; } };
function atomsFaststart(f) { // moov before mdat at the top level
  const fd = fs.openSync(f, 'r'), b = Buffer.alloc(16), size = fs.fstatSync(fd).size; let pos = 0, seen = [];
  try { while (pos < size && seen.length < 12) { fs.readSync(fd, b, 0, 16, pos); let n = b.readUInt32BE(0); const type = b.toString('latin1', 4, 8); if (n === 1) n = Number(b.readBigUInt64BE(8)); if (n < 8) break; seen.push(type); if (type === 'moov' || type === 'mdat') break; pos += n; } } finally { fs.closeSync(fd); }
  return seen.at(-1) === 'moov';
}
function measureVideo(mp4) {
  const p = probeJson(['-show_entries', 'stream=codec_type,codec_name,profile,width,height,r_frame_rate,pix_fmt,sample_rate:format=duration,size'], mp4);
  const v = (p.streams || []).find(s => s.codec_type === 'video') || {}, a = (p.streams || []).find(s => s.codec_type === 'audio') || {};
  const [n, d] = String(v.r_frame_rate || '0/1').split('/').map(Number), dur = Number(p.format?.duration) || 0, N = Math.round(dur * n / (d || 1));
  const kf = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', mp4], { encoding: 'utf8', windowsHide: true }).stdout.split(/\s+/).map(parseFloat).filter(Number.isFinite);
  const gop = Math.max(...kf.map((t, i) => (i ? t - kf[i - 1] : t)), dur - (kf.at(-1) || 0));
  const w = 96, h = Math.round(96 * (v.height || 1) / (v.width || 1) / 2) * 2;
  const raw = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mp4, '-vf', `select='eq(n\\,0)+eq(n\\,${Math.max(0, N - 1)})',scale=${w}:${h},format=gray`, '-fps_mode', 'vfr', '-f', 'rawvideo', '-'], { windowsHide: true, maxBuffer: 16 << 20 }).stdout || Buffer.alloc(0);
  const px = w * h, f0 = raw.subarray(0, px), fl = raw.subarray(px, 2 * px);
  const luma0 = f0.length ? f0.reduce((s, x) => s + x, 0) / f0.length / 255 : 0, mad = fl.length === px ? f0.reduce((s, x, i) => s + Math.abs(x - fl[i]), 0) / px / 255 : 1;
  const fz = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', mp4, '-map', '0:v', '-vf', 'freezedetect=n=0.003:d=3', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }).stderr || '';
  const freezes = [...fz.matchAll(/freeze_start: ([\d.]+)/g)].map(m => +m[1]);
  const loud = a.codec_name ? measure(['-i', mp4]) : null;
  return { width: v.width, height: v.height, fps: n / (d || 1), codec: v.codec_name, profile: v.profile, pix: v.pix_fmt, acodec: a.codec_name, rate: +a.sample_rate, dur, size: +p.format?.size || 0,
    gop, faststart: atomsFaststart(mp4), luma0, loop: 1 - mad, freezes, lufs: loud ? +loud.input_i : null, tp: loud ? +loud.input_tp : null };
}
function evaluate(S, M) { // S: sidecar (or the same data from a preview), M: measurements of the MP4 (null in a preview)
  const R = [], add = (n, ok, name, detail) => R.push({ n, s: ok === null ? 'n/a' : ok === 'warn' ? 'WARN' : ok ? 'PASS' : 'FAIL', name, detail });
  const v = S.format === '9x16', T = S.seconds * 1000, sec = ms => (ms / 1000).toFixed(1) + ' s';
  const platform = S.platform || (v ? 'shorts' : 'fiverr'), vo = S.vo.lines, voWords = vo.flatMap(l => words(l.text));
  if (M) add(1, M.width === (v ? 1080 : 1920) && M.height === (v ? 1920 : 1080) && Math.abs(M.fps - 30) < 0.01, 'canvas', `${M.width}x${M.height} @ ${+M.fps.toFixed(2)} fps`);
  add(2, M ? M.luma0 > 0.1 && !!S.hook.text : !!S.hook.text, 'frame 0', `${M ? `luma ${M.luma0.toFixed(2)}, ` : ''}hook text + product on screen`);
  const hw = words(S.hook.text).length, spoken = vo[0] && vo[0].scene === 1 ? vo[0].at + vo[0].dur * 1000 : null;
  add(3, hw >= 3 && hw <= 7 && S.hook.e - S.hook.s >= 1500 && (spoken === null || spoken <= 2000 || 'warn'), 'hook', `"${S.hook.text}" ${hw} words, ${sec(S.hook.s)}-${sec(S.hook.e)}${spoken !== null ? `, spoken by ${sec(spoken)}` : ''}`);
  add(4, true, 'product first', 'real page from frame 0, no logo card');
  add(5, vo.length ? (voWords.slice(0, 12).some(w => /^(you|your|you're|you'll|yours)\b/i.test(w)) || 'warn') : null, '"you" early', vo.length ? 'in the first 12 spoken words' : 'no voiceover');
  const fits = Object.entries(PLATFORMS).filter(([, cap]) => S.seconds <= cap).map(([p]) => p);
  add(6, S.seconds <= PLATFORMS[platform], 'length', `${S.seconds.toFixed(1)} s, cap ${PLATFORMS[platform]} s for ${platform} (fits: ${fits.join(', ') || 'none'})`);
  // longest stretch with no cut, text change, action or push-in (push-in counts when it is >= 3% per 3 s)
  const spans = [...S.scenes.filter(s => s.end - s.start <= 4510).map(s => [s.start, s.end]), ...S.scenes.flatMap(s => s.acts.map(a => [a.t0, a.t1])), [S.ctaStart, S.ctaStart + 600],
    ...[0, ...S.scenes.map(s => s.start), ...S.chunks.flatMap(c => [c.s, c.e]), S.hook.e, S.hook.e + 500, S.ctaStart + 550, ...S.rehooks.map(r => r.at), T].map(p => [p, p])].sort((a, b) => a[0] - b[0]);
  let still = 0, cur = 0; for (const [x, y] of spans) { still = Math.max(still, Math.min(x, T) - cur); cur = Math.max(cur, y); }
  add(7, still <= 3000 && (!M || !M.freezes.length), 'visual change', `longest still ${sec(still)}${M ? `, ${M.freezes.length} freeze(s) >= 3 s` : ''}`);
  const rh = S.rehooks.map(r => ({ ...r, sfx: S.sfx.some(x => Math.abs(x.at - r.at) < 200) }));
  add(8, rh.length === 2 && rh.every((r, i) => Math.abs(r.at / T - [0.4, 0.7][i]) <= 0.05) && (rh.every(r => r.sfx) || 'warn'), 'rehooks', rh.map(r => `${sec(r.at)} ${r.cut ? 'cut' : 'punch-in'}${r.sfx ? '+sfx' : ''}`).join(', '));
  add(9, T - S.ctaStart <= 3050 && T - S.ctaStart >= 1000, 'CTA', `"${S.cta}" from ${sec(S.ctaStart)}, video ends with it`);
  add(10, M ? M.loop >= 0.85 : true, 'loops', M ? `last frame vs frame 0 similarity ${M.loop.toFixed(2)}` : 'CTA returns to the opening frame');
  const box = v ? [65, 250, 890, 1440] : [0, 0, 1920, 1080], out = S.metrics.texts.filter(t => t.box[0] < box[0] - 1 || t.box[1] < box[1] - 1 || t.box[2] > box[2] + 1 || t.box[3] > box[3] + 1);
  add(11, !out.length, 'safe area', out.length ? `outside x ${box[0]}-${box[2]}, y ${box[1]}-${box[3]}: ${out.slice(0, 3).map(t => `${t.kind} "${t.text}" [${t.box}]`).join('; ')}` : `all ${S.metrics.texts.length} text blocks inside x ${box[0]}-${box[2]}, y ${box[1]}-${box[3]}`);
  const badC = S.chunks.filter(c => words(c.text).length > 3 || glen(c.text) > 16 || c.e - c.s < 250);
  add(12, S.chunks.length ? !badC.length : null, 'caption chunks', S.chunks.length ? (badC.length ? `${badC.length} off: ${badC.slice(0, 3).map(c => `"${c.text}" ${sec(c.e - c.s)}`).join(', ')}` : `${S.chunks.length} chunks, 1-3 words, <= 16 chars, >= 0.25 s`) : 'no captions');
  const caps = S.metrics.texts.filter(t => t.kind === 'caption'), cs = S.metrics.caption, minFs = caps.length ? Math.min(...caps.map(t => t.fs)) : 0;
  const contrast = (() => { const c = x => (String(x).match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number), l1 = lum(c(cs.fill)), l2 = lum(c(cs.strokeColor)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); })();
  add(13, caps.length ? minFs >= 72 && cs.weight >= 800 && cs.stroke >= 6 && contrast >= 4.5 : null, 'caption style', caps.length ? `${minFs}+ px, weight ${cs.weight}, stroke ${cs.stroke} px, contrast ${contrast.toFixed(1)}:1` : 'no captions');
  const speech = vo.reduce((s, l) => s + l.dur, 0), wpm = speech ? voWords.length / speech * 60 : 0;
  add(14, vo.length ? (wpm >= 130 && wpm <= 190 ? (wpm >= 150 && wpm <= 170 || 'warn') : false) : null, 'pace', vo.length ? `${Math.round(wpm)} wpm (target 150-170)` : 'no voiceover');
  add(15, vo.length ? vo.every(l => words(l.text).length <= 12) : null, 'sentences', vo.length ? `${vo.length} TTS calls, longest ${Math.max(...vo.map(l => words(l.text).length))} words` : 'no voiceover');
  const gaps = vo.slice(1).map((l, i) => ({ g: l.at - (vo[i].at + vo[i].dur * 1000), cta: l.cta }));
  add(16, vo.length > 1 ? gaps.every(x => x.cta ? x.g >= 480 && x.g <= 720 : x.g >= 280 && x.g <= 470) || 'warn' : null, 'silences', vo.length > 1 ? `gaps ${gaps.map(x => (x.g / 1000).toFixed(2)).join(', ')} s` : 'no voiceover');
  const loudOn = S.audio.voice || S.audio.music;
  if (M) add(17, loudOn ? Math.abs(M.lufs + 14) <= 1 && M.tp <= -1 : null, 'loudness', `${M.lufs?.toFixed(1)} LUFS, true peak ${M.tp?.toFixed(1)} dBTP${loudOn ? '' : ' (effects only: not normalized)'}`);
  add(18, S.audio.voice && S.audio.music ? S.audio.duckDb >= 18 && S.audio.duckDb <= 24 : null, 'ducking', S.audio.voice && S.audio.music ? `music ${S.audio.duckDb} dB under the voice, 300 ms release` : 'needs voice + music');
  const sg = S.sfx.slice(1).map((x, i) => x.at - S.sfx[i].at);
  add(19, S.sfx.length ? Math.min(...sg, Infinity) >= 1500 : null, 'sound effects', S.sfx.length ? `${S.sfx.length} cues, >= ${sec(Math.min(...sg, T))} apart, about 10 dB under the voice/music` : 'off');
  add(22, !S.zooms.length || Math.min(...S.zooms) >= 1.5 || 'warn', 'capture', `${v ? '390x844 @3x' : '1440x900, zooms re-rendered at zoom scale'}${S.zooms.length ? `, zooms ${S.zooms.map(z => z + 'x').join(' ')}` : ''}`);
  if (M) add(23, M.codec === 'h264' && /high/i.test(M.profile || '') && M.pix === 'yuv420p' && M.gop <= 0.55 && M.faststart && M.acodec === 'aac' && M.rate === 48000, 'encode', `${M.codec} ${M.profile}, ${M.pix}, keyframes every ${M.gop.toFixed(2)} s, ${M.faststart ? 'faststart' : 'NO faststart'}, ${M.acodec} ${M.rate} Hz`);
  const contact = [S.hook.text, S.cta, S.url, ...S.chunks.map(c => c.text)].filter(Boolean).filter(t => /\b[\w-]+\.(com|net|org|io|dev|app|np|co|me|pages\.dev|workers\.dev)\b|@\w|\+?\d[\d -]{7,}/i.test(t));
  add(24, S.platform === 'fiverr' ? (!contact.length && !vo.length && (!M || M.size <= 50e6)) : null, 'Fiverr', S.platform === 'fiverr' ? `${M ? (M.size / 1e6).toFixed(1) + ' MB, ' : ''}${contact.length ? 'URL/contact in text: ' + contact[0] : 'no URL or contact info'}${vo.length ? ', has TTS voice' : ''}` : 'platform is not fiverr');
  return R;
}
function printRules(tag, R) {
  for (const r of R.filter(r => r.s === 'FAIL' || r.s === 'WARN')) console.log(`${tag} ${r.s === 'FAIL' ? '✘' : '!'} ${r.n} ${r.name}: ${r.detail}`);
  const ok = R.filter(r => r.s === 'PASS'), na = R.filter(r => r.s === 'n/a');
  console.log(`${tag} ✓ ${ok.length} rules pass (${ok.map(r => r.n).join(' ')})${na.length ? ` · n/a ${na.map(r => r.n).join(' ')}` : ''}`);
  return R.filter(r => r.s === 'FAIL').length;
}
function sidecar(sb, P, A, metrics) {
  const lines = [...P.scenes.flatMap(s => s.lines.map(l => ({ text: l.text, at: s.start * STEP + l.at, dur: l.dur, scene: s.n }))), ...P.ctaLines.map(l => ({ text: l.text, at: P.ctaStart + l.at, dur: l.dur, cta: true }))];
  return { v: 1, format: P.fmt, platform: sb.platform || null, seconds: P.seconds, frames: P.total, hook: P.hook, ctaStart: P.ctaStart, cta: sb.outro?.cta || 'See it live', url: A.pillText,
    chunks: P.chunks.map(({ text, s, e }) => ({ text, s: Math.round(s), e: Math.round(e) })), rehooks: P.rehooks, sfx: P.sfx.map(({ type, at }) => ({ type, at: Math.round(at) })),
    scenes: P.scenes.map(s => ({ n: s.n, start: s.start * STEP, end: s.end * STEP, acts: s.acts.map(a => ({ kind: a.kind, t0: s.start * STEP + a.t0, t1: s.start * STEP + a.t1 })) })),
    zooms: P.scenes.flatMap(s => s.acts.filter(a => a.kind === 'zoom').map(a => a.scale ?? 1.6)), vo: { voice: A.voiceName || null, lines },
    audio: { voice: lines.length > 0, music: !!A.music, duckDb: lines.length && A.music ? 20 : null }, metrics };
}
function runCheck(targets) {
  const files = targets.flatMap(t => fs.existsSync(t) && fs.statSync(t).isDirectory() ? fs.readdirSync(t).filter(f => /^promo-(16x9|9x16)\.mp4$/.test(f)).map(f => path.join(t, f)) : [t]);
  if (!files.length) die('nothing to check: give an output folder or promo-*.mp4', 2);
  let fails = 0;
  for (const f of files) {
    const sideF = f.replace(/\.mp4$/i, '.json'); let S;
    try { S = JSON.parse(fs.readFileSync(sideF, 'utf8')); } catch { die(`${sideF} is missing: check needs the sidecar promo.mjs writes next to the video`, 2); }
    if (opt('platform')) S.platform = opt('platform');
    fails += printRules(`[${S.format}]`, evaluate(S, measureVideo(f)));
  }
  return fails;
}

// ---------- main ----------
function makeWork() {
  for (const n of fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('promo-work-'))) { // left by runs that were killed
    const d = path.join(os.tmpdir(), n); let pid = 0, age = 0;
    try { pid = JSON.parse(fs.readFileSync(path.join(d, 'owner.json'), 'utf8')).node; } catch {} try { age = Date.now() - fs.statSync(d).mtimeMs; } catch {}
    if (pid ? !alivePid(pid) : age > 10 * 60e3) rmDir(d);
  }
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-work-'));
  fs.writeFileSync(path.join(w, 'owner.json'), JSON.stringify({ node: process.pid }));
  process.on('exit', () => { if (flag('keep-frames')) console.log('frames kept in ' + w); else rmDir(w); });
  return w;
}
function resolveBrand(br = {}) {
  const list = Array.isArray(br.bg) ? br.bg : br.bg ? [br.bg] : ['#0f172a'];
  const [h, s, l] = toHsl(hex2rgb(list[0]));
  const bg = list.length > 1 ? list : [list[0], fromHsl(h, Math.min(1, s * 1.1), Math.min(0.9, l + 0.1))];
  const accent = br.accent || '#3b82f6';
  return { ...br, bg, accent, text: br.text || (lum(hex2rgb(bg[0])) > 0.35 ? '#111111' : '#ffffff'), onAccent: onColor(accent) };
}
const probeAudio = f => { const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f], { encoding: 'utf8', windowsHide: true }); return r.status === 0 && r.stdout.trim(); };
const printPlan = P => console.log(`plan ${P.fmt}: ${P.seconds.toFixed(2)} s = ${P.scenes.map(s => `scene ${s.n} ${(s.frames / FPS).toFixed(1)}`).join(' + ')} + CTA ${(P.ctaF / FPS).toFixed(1)}`);
const dirSize = d => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch {} return n; };
const main = async () => {
  if (!['quick', 'render', 'plan', 'check'].includes(mode)) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(mode && !['-h', '--help', 'help'].includes(mode) ? 2 : 0);
  }
  if (mode === 'check') { process.exitCode = runCheck(positional.length ? positional : ['promo']) ? 1 : 0; return; }
  const want = opt('formats') ? opt('formats').split(',').map(s => s.trim()) : null;
  if (want && want.some(f => !FMT[f])) die('--formats takes 16x9, 9x16 or 16x9,9x16', 2);
  if (opt('platform') && !PLATFORMS[opt('platform')]) die(`--platform takes ${Object.keys(PLATFORMS).join(', ')}`, 2);
  if (mode === 'plan') {
    const file = positional[0] || die('give a storyboard.json', 2), sb = readStoryboard(file);
    const plans = (want || sb.formats || Object.keys(FMT)).map(f => plan(sb, f));
    if (flag('json')) console.log(JSON.stringify(plans.map(p => ({ format: p.fmt, frames: p.total, seconds: p.seconds, scenes: p.scenes.length }))));
    else { plans.forEach(printPlan); if (sb.scenes.some(s => s.voiceover) || sb.outro?.voiceover) console.log('  (without voiceover time: render and --preview synthesize it and stretch scenes to fit)'); console.log('✓ storyboard is valid'); }
    return;
  }
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) die('ffmpeg not found on PATH (winget install ffmpeg / brew install ffmpeg / apt install ffmpeg)');
  const T0 = Date.now(), OUT = path.resolve(opt('out', 'promo')), preview = flag('preview');
  let sb, base = OUT;
  if (mode === 'render') { const f = positional[0] || die('give a storyboard.json', 2); sb = readStoryboard(f); base = path.dirname(path.resolve(f)); }
  else if (!/^(https?|file):\/\//i.test(positional[0] || '')) die('give a URL that starts with http://, https:// or file://', 2);
  const musicArg = opt('music') && path.resolve(opt('music'));
  if (musicArg && !fs.existsSync(musicArg)) die(`music file not found: ${musicArg}`, 2);
  fs.mkdirSync(OUT, { recursive: true });
  const work = makeWork(), cache = flag('no-cache') ? null : path.join(OUT, '.cache'), b = await connect(), outs = [];
  let fails = 0; const usedDirs = [];
  try {
    if (mode === 'quick') {
      sb = await quickStoryboard(b, positional[0]);
      const errs = validate(sb); if (errs.length) die(`could not build a storyboard: ${errs.join('; ')}`);
      const f = path.join(OUT, 'storyboard.json'); fs.writeFileSync(f, JSON.stringify(sb, null, 2) + '\n');
      console.log(`storyboard: ${f} (edit hook, captions or actions, then: render "${f}")`);
    }
    if (opt('platform')) sb.platform = opt('platform');
    const formats = want || sb.formats || Object.keys(FMT);
    const music = musicArg || (sb.music ? path.resolve(base, sb.music) : null);
    if (music && !fs.existsSync(music)) die(`music file not found: ${music}`, 2);
    if (music && !probeAudio(music)) die(`no audio stream in ${music}`, 2);
    const brand = resolveBrand(sb.brand);
    const [logo, fonts, voice] = await Promise.all([loadLogo(brand.logo, base), googleFonts(brand.font), voiceover(sb, cache || work)]);
    if (voice.note) console.log(voice.note);
    if (brand.font && !fonts.got.length) console.log(`font "${brand.font}" is not on Google Fonts (or offline): using it if installed, else the system font`);
    const pillText = sb.platform === 'fiverr' ? '' : sb.outro?.url ?? new URL(sb.scenes[0].url).host;
    const A = { work, out: OUT, cache, brand, logo, fonts, music, pillText, voiceName: voice.voice, audio: {} };
    const plans = formats.map(f => plan(sb, f, voice.vo)); plans.forEach(printPlan);
    if (preview) { // a few half-size key frames, no video: the cheap way to check layout and captions
      const rows = await Promise.all(plans.map(async P => {
        const keys = keyFrames(P, Math.floor(12 / plans.length)), wantSet = new Set();
        for (const g of keys) { const s = P.scenes.find(x => g >= x.start && g < x.end); if (s) wantSet.add(`${s.n}:${g - s.start}`); }
        P.scenes.forEach(s => { wantSet.add(`${s.n}:0`); wantSet.add(`${s.n}:${s.frames - 1}`); });
        const rec = await recordFormat(b, sb, P, A, `[${P.fmt}]`, wantSet);
        const { metrics, shots } = await compose(b, sb, P, A, rec, `[${P.fmt}]`, keys);
        const files = shots.map((buf, i) => { const f = path.join(work, `pv-${P.fmt}-${i}.jpg`); fs.writeFileSync(f, buf); return f; });
        fails += printRules(`[${P.fmt}]`, evaluate(sidecar(sb, P, A, metrics), null));
        return { files, w: P.fmt === '9x16' ? 180 : 320, h: P.fmt === '9x16' ? 320 : 180 };
      }));
      sheet(rows, path.join(OUT, 'preview.png'));
      console.log(`preview: ${path.join(OUT, 'preview.png')} (key frames: hook, rehooks, scenes, CTA, last) · ${secs(T0)}`);
      return;
    }
    for (const P of plans) { const d = path.join(work, 'a' + P.fmt); fs.mkdirSync(d, { recursive: true }); A.audio[P.fmt] = buildAudio(P, A, d); }
    const results = await Promise.all(plans.map(async P => {
      const tag = `[${P.fmt}]`, t0 = Date.now(), rec = await recordFormat(b, sb, P, A, tag, null), t1 = Date.now(); usedDirs.push(...rec.used);
      const c = await compose(b, sb, P, A, rec, tag, null);
      fs.writeFileSync(path.join(OUT, `promo-${P.fmt}.json`), JSON.stringify(sidecar(sb, P, A, c.metrics)));
      console.log(`${tag} ${P.seconds.toFixed(1)} s · recorded ${rec.groups - rec.cached}/${rec.groups} page(s) in ${((t1 - t0) / 1000).toFixed(1)} s${rec.cached ? ` (${rec.cached} cached)` : ''} · composed ${c.drawn}/${P.total} frames in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      return { P, out: c.out };
    }));
    outs.push(...results);
  } finally { await b.close(); }
  for (const { P, out } of outs) {
    const S = JSON.parse(fs.readFileSync(out.replace(/\.mp4$/, '.json'), 'utf8')), M = measureVideo(out);
    console.log(`✓ ${out}  ${M.width}x${M.height} · ${M.dur.toFixed(2)} s · ${(M.size / 1048576).toFixed(1)} MB`);
    fails += printRules(`[${P.fmt}]`, evaluate(S, M));
  }
  const n = Math.floor(12 / outs.length);
  sheet(outs.map(({ P, out }) => ({ files: keyFrames(P, n).map((g, i) => frameJpg(out, g, work, `cs-${P.fmt}-${i}.jpg`)), w: P.fmt === '9x16' ? 180 : 320, h: P.fmt === '9x16' ? 320 : 180 })), path.join(OUT, 'contact.png'));
  if (cache) { // keep only what this render used
    const keep = new Set(usedDirs); for (const d of fs.readdirSync(cache)) { const f = path.join(cache, d); if (/^rec-/.test(d) && outs.some(o => d.startsWith(`rec-${o.P.fmt}-`)) && !keep.has(f)) rmDir(f); }
  }
  console.log(`contact sheet: ${path.join(OUT, 'contact.png')} · posters: poster-*.jpg${cache ? ` · cache ${(dirSize(cache) / 1048576).toFixed(0)} MB in ${cache} (--no-cache to skip)` : ''}`);
  console.log(`done in ${secs(T0)}${fails ? ` · ${fails} rule failure(s)` : ''}`);
};
main().catch(e => die(e.message));
