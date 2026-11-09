#!/usr/bin/env node
// visual-diff — before/after screenshot regression for websites. Zero dependencies, Node 22+.
// Uses an installed Chrome / Edge / Brave / Chromium in headless mode with a throwaway profile (BROWSER=path to override).
//
//   node visual-diff.mjs capture <url> [more urls or /paths] --out shots/before [--full] [--hide ".clock,.ad"] [--wait 800]
//   node visual-diff.mjs compare shots/before shots/after --out shots/report [--threshold 0.5] [--tolerance 16]
//   node visual-diff.mjs run <url> [/paths] --baseline shots/baseline [--full] [--hide ...]
//
// compare/run exit with code 1 when any page changed more than --threshold percent (or a page is missing).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const USAGE = `usage:
  node visual-diff.mjs capture <url> [more urls or /paths] --out <dir> [--full] [--hide "<css selectors>"] [--wait ms] [--viewports desktop,mobile]
  node visual-diff.mjs compare <baselineDir> <currentDir> --out <dir> [--threshold 0.5] [--tolerance 16]
  node visual-diff.mjs run <url> [more urls or /paths] --baseline <dir> [--out <dir>] [capture + compare options]`;

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const FLAGS = new Set(['full']);
const opts = {}, pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); if (FLAGS.has(k)) opts[k] = true; else opts[k] = argv[++i]; }
  else pos.push(a);
}

const VIEWPORTS = {
  desktop: { width: 1366, height: 900, dpr: 1, mobile: false },
  mobile: { width: 390, height: 844, dpr: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
};

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-diff-'));
  const proc = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb',
    '--font-render-hinting=none', '--disable-features=PaintHolding', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { proc.kill(); throw new Error('browser did not start'); }
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
  const close = async () => {
    try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch {}
    try { ws.close(); } catch {}
    try { proc.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  return { send, on: f => (listeners.add(f), () => listeners.delete(f)), close };
}

// CSS that removes the usual sources of noise between two otherwise identical renders.
const FREEZE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

async function shoot(b, url, vp, { full, hide, wait, file }) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  let inflight = 0, lastNet = Date.now(), loaded = false, status = null;
  const off = b.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Network.requestWillBeSent') { inflight++; lastNet = Date.now(); }
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document' && status === null) status = m.params.response.status;
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight = Math.max(0, inflight - 1); lastNet = Date.now(); }
    if (m.method === 'Page.loadEventFired') loaded = true;
  });
  const quiet = async (maxMs) => { const t = Date.now(); while (Date.now() - t < maxMs && !(loaded && inflight <= 0 && Date.now() - lastNet > 700)) await sleep(100); };
  const ev = async e => (await s('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  try {
    await Promise.all(['Network.enable', 'Page.enable', 'Runtime.enable'].map(m => s(m)));
    await s('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile });
    if (vp.mobile) { await s('Emulation.setUserAgentOverride', { userAgent: vp.ua }); await s('Emulation.setTouchEmulationEnabled', { enabled: true }); }
    await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const css = FREEZE_CSS + (hide ? `${hide}{visibility:hidden!important}` : '');
    // Inject the freeze CSS as early as possible on every document, and again after load in case the page replaced <head>.
    const inject = `(()=>{const add=()=>{if(document.getElementById('__vd_css'))return;const st=document.createElement('style');st.id='__vd_css';st.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(st)};if(document.documentElement)add();document.addEventListener('DOMContentLoaded',add)})()`;
    await s('Page.addScriptToEvaluateOnNewDocument', { source: inject });
    await s('Page.navigate', { url });
    await quiet(30000);
    await ev(inject);
    if (full) { // scroll through the page so lazy images load, then back to top
      await ev(`(async()=>{const h=()=>document.documentElement.scrollHeight;for(let y=0;y<h()&&y<30000;y+=innerHeight){scrollTo(0,y);await new Promise(r=>setTimeout(r,150))}scrollTo(0,0)})()`);
      await quiet(10000);
    }
    // wait for fonts and every <img> (lazy ones included) to finish loading and decoding, max 8 s
    await ev(`(async()=>{const imgs=[...document.images];imgs.forEach(i=>{if(i.loading==='lazy')i.loading='eager'});await Promise.race([Promise.all(imgs.map(i=>i.complete?(i.decode?i.decode().catch(()=>{}):0):new Promise(r=>{i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true})}).then(()=>i.decode&&i.decode().catch(()=>{})))),new Promise(r=>setTimeout(r,8000))])})()`);
    await quiet(5000);
    await ev(`(async()=>{try{await document.fonts.ready}catch{};document.querySelectorAll('video').forEach(v=>{try{v.pause();v.currentTime=0}catch{}});document.activeElement&&document.activeElement.blur&&document.activeElement.blur();scrollTo(0,0);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()`);
    await sleep(wait);
    const params = { format: 'png' };
    if (full) {
      const m = await s('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize;
      const h = Math.min(Math.ceil(cs.height), 16000);
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: vp.width, height: Math.max(h, vp.height), scale: 1 };
    }
    const { data } = await s('Page.captureScreenshot', params);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return { status };
  } finally {
    off();
    await b.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

function slug(u) {
  const x = new URL(u);
  let p = (x.pathname.replace(/\/+$/, '') || '/home').replace(/^\//, '');
  if (x.search) p += '_' + x.search.slice(1);
  return p.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'home';
}

function resolveUrls(list) {
  const first = list.find(a => /^https?:\/\//.test(a));
  if (!first) throw new Error('need at least one http(s) URL');
  // Git Bash on Windows rewrites "/about" to "C:/Program Files/Git/about"; undo that.
  const fix = a => a.replace(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/]/, '/');
  return [...new Set(list.map(a => /^https?:\/\//.test(a) ? a : new URL(fix(a), first).href))];
}

async function capture(urls, out, o) {
  fs.mkdirSync(out, { recursive: true });
  const vps = (o.viewports || 'desktop,mobile').split(',').map(v => v.trim()).filter(Boolean);
  for (const v of vps) if (!VIEWPORTS[v]) throw new Error(`unknown viewport "${v}" (use desktop, mobile)`);
  const wait = Number(o.wait ?? 500);
  const manifest = { created: new Date().toISOString(), full: !!o.full, hide: o.hide || null, wait, shots: [] };
  const used = new Set();
  const b = await launch();
  try {
    for (const url of urls) {
      let name = slug(url); for (let n = 2; used.has(name); n++) name = slug(url) + '-' + n; used.add(name);
      for (const v of vps) {
        const file = `${name}__${v}.png`;
        const t0 = Date.now();
        const r = await shoot(b, url, VIEWPORTS[v], { full: o.full, hide: o.hide, wait, file: path.join(out, file) });
        const { width, height } = pngSize(fs.readFileSync(path.join(out, file)));
        manifest.shots.push({ url, name, viewport: v, file, width, height, status: r.status });
        console.log(`  ${v.padEnd(7)} ${String(r.status ?? '-').padEnd(4)} ${width}x${height}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${url}`);
      }
    }
  } finally { await b.close(); }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`captured ${manifest.shots.length} screenshots -> ${out}`);
  return manifest;
}

// ---------- PNG decode / encode (8-bit, non-interlaced; what Chromium writes) ----------
function pngSize(buf) { return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; }

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w, h, depth, ctype, interlace, palette, trns; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), d = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') palette = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (bit depth ${depth}, interlace ${interlace}); re-save as 8-bit non-interlaced`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      if (ctype === 6) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
      else if (ctype === 2) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else if (ctype === 0) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
      else if (ctype === 4) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else { const p = cur[s]; out[o] = palette[p * 3]; out[o + 1] = palette[p * 3 + 1]; out[o + 2] = palette[p * 3 + 2]; out[o + 3] = trns && p < trns.length ? trns[p] : 255; }
    }
    cur.copy(prev);
  }
  return { width: w, height: h, data: out };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG({ width: w, height: h, data }) { // RGB output, "Up" filter
  const stride = w * 3, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const ro = y * (stride + 1); raw[ro] = 2;
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      const v = data[(y * w + x) * 4 + c], up = y ? data[((y - 1) * w + x) * 4 + c] : 0;
      raw[ro + 1 + x * 3 + c] = (v - up) & 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- diff ----------
// Pixels outside one image (different sizes) count as changed. Alpha is composited on white first.
function diffImages(A, B, tol) {
  const W = Math.max(A.width, B.width), H = Math.max(A.height, B.height);
  const px = (I, x, y, c) => { if (x >= I.width || y >= I.height) return -1; const o = (y * I.width + x) * 4, a = I.data[o + 3]; return Math.round(I.data[o + c] * a / 255 + 255 * (1 - a / 255)); };
  const mask = new Uint8Array(W * H); let changed = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let d = false;
    if (x >= A.width || y >= A.height || x >= B.width || y >= B.height) d = true;
    else for (let c = 0; c < 3; c++) if (Math.abs(px(A, x, y, c) - px(B, x, y, c)) > tol) { d = true; break; }
    if (d) { mask[y * W + x] = 1; changed++; }
  }
  // Regions: 16px cells, grow by one cell so nearby changes merge, then connected components.
  const CELL = 16, gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL), grid = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) grid[((y / CELL) | 0) * gw + ((x / CELL) | 0)] = 1;
  const grown = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (grid[y * gw + x])
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) grown[yy * gw + xx] = 1; }
  const seen = new Uint8Array(gw * gh); let boxes = [];
  for (let i = 0; i < gw * gh; i++) {
    if (!grown[i] || seen[i]) continue;
    const st = [i]; seen[i] = 1; let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, real = false;
    while (st.length) {
      const j = st.pop(), cx = j % gw, cy = (j / gw) | 0;
      if (grid[j]) { real = true; x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = cy + dy, xx = cx + dx, k = yy * gw + xx; if (yy >= 0 && yy < gh && xx >= 0 && xx < gw && grown[k] && !seen[k]) { seen[k] = 1; st.push(k); } }
    }
    if (!real) continue;
    // tighten to the actual changed pixels inside the cell box
    let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1, n = 0;
    for (let y = y0 * CELL; y < Math.min(H, (y1 + 1) * CELL); y++) for (let x = x0 * CELL; x < Math.min(W, (x1 + 1) * CELL); x++)
      if (mask[y * W + x]) { n++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    boxes.push({ x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1, pixels: n });
  }
  boxes.sort((a, b) => b.pixels - a.pixels);
  // diff image: current (or baseline where current is missing) faded, changed pixels magenta, region boxes orange
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, I = (x < B.width && y < B.height) ? B : A;
    if (mask[y * W + x]) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; }
    else for (let c = 0; c < 3; c++) { const v = px(I, x, y, c); out[o + c] = v < 0 ? 255 : Math.round(v * 0.25 + 255 * 0.6); }
    out[o + 3] = 255;
  }
  const T = Math.max(2, Math.round(W / 450));
  for (const bx of boxes.slice(0, 50)) {
    const X0 = Math.max(0, bx.x - T - 2), Y0 = Math.max(0, bx.y - T - 2), X1 = Math.min(W - 1, bx.x + bx.width + T + 1), Y1 = Math.min(H - 1, bx.y + bx.height + T + 1);
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++)
      if (x - X0 < T || X1 - x < T || y - Y0 < T || Y1 - y < T) { const o = (y * W + x) * 4; out[o] = 255; out[o + 1] = 120; out[o + 2] = 0; }
  }
  return { width: W, height: H, changed, percent: changed / (W * H) * 100, boxes, image: { width: W, height: H, data: out } };
}

function readShots(dir) {
  const mf = path.join(dir, 'manifest.json');
  if (fs.existsSync(mf)) return JSON.parse(fs.readFileSync(mf, 'utf8')).shots;
  return fs.readdirSync(dir).filter(f => f.endsWith('.png')).map(f => { const m = f.match(/^(.*)__(\w+)\.png$/); return { name: m ? m[1] : f.slice(0, -4), viewport: m ? m[2] : '-', file: f, url: '' }; });
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function compare(baseDir, curDir, out, o) {
  const threshold = Number(o.threshold ?? 0.5), tol = Number(o.tolerance ?? 16);
  fs.mkdirSync(out, { recursive: true });
  const base = readShots(baseDir), cur = readShots(curDir);
  const meta = d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')); } catch { return {}; } };
  const mb = meta(baseDir), mc = meta(curDir);
  if (mb.full !== mc.full) console.warn(`warning: baseline was captured ${mb.full ? 'with' : 'without'} --full and current ${mc.full ? 'with' : 'without'}; heights will differ.`);
  if ((mb.hide || '') !== (mc.hide || '')) console.warn(`warning: --hide differs (baseline "${mb.hide || ''}", current "${mc.hide || ''}").`);
  const key = s => `${s.name}__${s.viewport}`;
  const bmap = new Map(base.map(s => [key(s), s])), cmap = new Map(cur.map(s => [key(s), s]));
  const results = [];
  for (const k of new Set([...bmap.keys(), ...cmap.keys()])) {
    const b = bmap.get(k), c = cmap.get(k);
    const r = { name: (b || c).name, viewport: (b || c).viewport, url: (c || b).url, baseline: b && path.join(baseDir, b.file), current: c && path.join(curDir, c.file) };
    if (!b || !c) { r.status = b ? 'missing' : 'new'; results.push(r); continue; }
    const A = decodePNG(fs.readFileSync(r.baseline)), B = decodePNG(fs.readFileSync(r.current));
    const d = diffImages(A, B, tol);
    r.diff = path.join(out, `${k}__diff.png`);
    fs.writeFileSync(r.diff, encodePNG(d.image));
    Object.assign(r, { percent: +d.percent.toFixed(3), changedPixels: d.changed, size: { baseline: [A.width, A.height], current: [B.width, B.height] }, regions: d.boxes.slice(0, 20).map(({ x, y, width, height }) => ({ x, y, width, height })), regionCount: d.boxes.length });
    r.status = d.percent > threshold ? 'changed' : 'ok';
    results.push(r);
  }
  const rank = r => r.status === 'missing' ? 1e9 : r.status === 'new' ? 1e8 : r.percent;
  results.sort((a, b) => rank(b) - rank(a));
  const failed = results.filter(r => r.status === 'changed' || r.status === 'missing');
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ created: new Date().toISOString(), baseline: path.resolve(baseDir), current: path.resolve(curDir), threshold, tolerance: tol, failed: failed.length, results }, null, 2));
  fs.writeFileSync(path.join(out, 'index.html'), html(results, { baseDir, curDir, out, threshold, tol }));
  console.log(`\nvisual-diff: ${results.length} screenshot pairs, threshold ${threshold}%, tolerance ${tol}`);
  for (const r of results) {
    const pct = r.percent == null ? '   -   ' : (r.percent.toFixed(2) + '%').padStart(7);
    const tag = r.status === 'ok' && r.changedPixels ? 'ok (small change, under threshold)' : { changed: 'CHANGED', ok: 'ok', missing: 'MISSING in current', new: 'new (no baseline)' }[r.status];
    const reg = r.regions?.length ? `  ${r.regionCount} region(s), largest ${r.regions[0].width}x${r.regions[0].height} at ${r.regions[0].x},${r.regions[0].y}` : '';
    const sz = r.size && r.size.baseline.join() !== r.size.current.join() ? `  size ${r.size.baseline.join('x')} -> ${r.size.current.join('x')}` : '';
    console.log(`  ${pct}  ${r.viewport.padEnd(7)} ${r.name.padEnd(24)} ${tag}${reg}${sz}`);
  }
  console.log(`report: ${path.join(out, 'index.html')}`);
  console.log(failed.length ? `${failed.length} over threshold -> exit 1` : 'no change over threshold');
  return failed.length ? 1 : 0;
}

function html(results, { out, threshold, tol, baseDir, curDir }) {
  const rel = p => p ? path.relative(out, p).split(path.sep).map(encodeURIComponent).join('/') : '';
  const img = (p, label) => p ? `<figure><figcaption>${label}</figcaption><a href="${rel(p)}" target="_blank"><img loading="lazy" src="${rel(p)}"></a></figure>` : `<figure><figcaption>${label}</figcaption><div class="none">none</div></figure>`;
  const rows = results.map(r => {
    const cls = r.status === 'ok' ? 'ok' : 'bad';
    const pct = r.percent == null ? r.status : r.percent.toFixed(2) + '%';
    const regions = r.regions?.length ? `<p class="meta">${r.regionCount} region(s): ${r.regions.slice(0, 6).map(b => `${b.width}&times;${b.height} at (${b.x}, ${b.y})`).join(' &middot; ')}${r.regionCount > 6 ? ' &hellip;' : ''}</p>` : '';
    const size = r.size && r.size.baseline.join() !== r.size.current.join() ? `<p class="meta">Size changed: ${r.size.baseline.join('&times;')} &rarr; ${r.size.current.join('&times;')}</p>` : '';
    return `<section id="${esc(r.name + '__' + r.viewport)}"><h2><span class="pct ${cls}">${esc(pct)}</span> ${esc(r.name)} <small>${esc(r.viewport)}</small></h2>
<p class="meta"><a href="${esc(r.url)}">${esc(r.url)}</a></p>${regions}${size}
<div class="row">${img(r.baseline, 'Before')}${img(r.current, 'After')}${img(r.diff, 'Diff')}</div></section>`;
  }).join('\n');
  const summary = results.map(r => `<tr><td><a href="#${esc(r.name + '__' + r.viewport)}">${esc(r.name)}</a></td><td>${esc(r.viewport)}</td><td class="${r.status === 'ok' ? 'ok' : 'bad'}">${r.percent == null ? esc(r.status) : r.percent.toFixed(2) + '%'}</td><td>${r.regionCount ?? ''}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual diff report</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px 24px;background:#f6f6f8;color:#1b1b1f}h1{font-size:20px}h2{font-size:16px;margin:0 0 4px}
table{border-collapse:collapse;background:#fff;margin-bottom:24px}td,th{padding:4px 12px;border-bottom:1px solid #e3e3e8;text-align:left}
section{background:#fff;border:1px solid #e3e3e8;border-radius:8px;padding:12px 16px;margin-bottom:20px}.meta{color:#555;margin:2px 0;font-size:13px}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:8px}figure{margin:0}figcaption{font-weight:600;margin-bottom:4px}
img{width:100%;border:1px solid #ccc;display:block;max-height:1600px;object-fit:contain;object-position:top;background:#fff}.none{color:#999;padding:40px;text-align:center;border:1px dashed #ccc}
.pct{display:inline-block;min-width:64px;padding:1px 8px;border-radius:4px;color:#fff;text-align:center}.pct.ok{background:#2e7d32}.pct.bad{background:#c2185b}td.ok{color:#2e7d32}td.bad{color:#c2185b;font-weight:600}
@media(max-width:800px){.row{grid-template-columns:1fr}}</style></head><body>
<h1>Visual diff</h1><p class="meta">Before: ${esc(path.resolve(baseDir))}<br>After: ${esc(path.resolve(curDir))}<br>Threshold ${threshold}% &middot; per-channel tolerance ${tol} &middot; magenta = changed pixels, orange = changed regions</p>
<table><tr><th>Page</th><th>Viewport</th><th>Changed</th><th>Regions</th></tr>${summary}</table>
${rows}</body></html>`;
}

// ---------- main ----------
try {
  if (cmd === 'capture') {
    if (!pos.length || !opts.out) throw new Error(USAGE);
    await capture(resolveUrls(pos), path.resolve(opts.out), opts);
  } else if (cmd === 'compare') {
    if (pos.length < 2 || !opts.out) throw new Error(USAGE);
    process.exitCode = compare(path.resolve(pos[0]), path.resolve(pos[1]), path.resolve(opts.out), opts);
  } else if (cmd === 'run') {
    if (!pos.length || !opts.baseline) throw new Error(USAGE);
    const base = path.resolve(opts.baseline), urls = resolveUrls(pos);
    if (!fs.existsSync(path.join(base, 'manifest.json'))) {
      await capture(urls, base, opts);
      console.log('no baseline existed, so this capture is now the baseline. Run again after your change.');
    } else {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const root = path.resolve(opts.out || path.join(path.dirname(base), 'runs', stamp));
      await capture(urls, path.join(root, 'current'), opts);
      process.exitCode = compare(base, path.join(root, 'current'), path.join(root, 'report'), opts);
    }
  } else { console.log(USAGE); process.exitCode = cmd ? 2 : 0; }
} catch (e) { console.error(e.message); process.exitCode = 2; }
