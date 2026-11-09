#!/usr/bin/env node
// gif-maker — sharp, small, smooth GIFs (and MP4/WebP) from HTML animations, terminal sessions, video clips
// or images. Needs ffmpeg on PATH; html/terminal modes also need Chrome, Edge, Brave or Chromium (headless,
// temporary profile). Zero npm dependencies. Node 22+.
//
//   node gif.mjs html <file.html|url> --dur 4 [--size 800x450] [--fps 24] --out anim.gif
//   node gif.mjs terminal <session.txt> [--size 900x520] [--theme dark|light] --out demo.gif
//   node gif.mjs video <clip.mp4> [--start 3 --dur 5] [--width 720] [--crop W:H:X:Y] [--speed 1.5] [--text "Caption"] --out clip.gif
//   node gif.mjs images <a.png> <b.png> ... [--hold 1.6] [--fade 0.4] [--size 1000x600] --out slides.gif
//   node gif.mjs optimize <in.gif|in.mp4> --max-mb 3 --out small.gif
// Common: --max-mb N (default 5: shrinks fps → colors → width until it fits), --fps, --colors 256,
//         --loop 0 (forever) | -1 (once), --mp4 / --webp (also write those), --keep (keep frames)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2), mode = argv[0];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = n => argv.includes('--' + n);
const positional = []; for (let i = 1; i < argv.length; i++) { if (argv[i].startsWith('--')) { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['mp4', 'webp', 'keep', 'pingpong', 'light'].includes(argv[i].slice(2))) i++; continue; } positional.push(argv[i]); }
const OUT = path.resolve(opt('out', 'out.gif'));
const MAX_MB = Number(opt('max-mb', 5)), LOOP = opt('loop', '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = m => { console.error('✘ ' + m); process.exit(1); };
const ff = (args, label) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }); if (r.status) die(`ffmpeg failed (${label}): ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`); };
const probe = f => { const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', f], { encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return null; } };
if (spawnSync('ffmpeg', ['-version']).status !== 0) die('ffmpeg not found on PATH (install it: winget install ffmpeg / brew install ffmpeg / apt install ffmpeg)');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-maker-'));
process.on('exit', () => { if (!flag('keep')) fs.rmSync(work, { recursive: true, force: true }); else console.log('frames kept in ' + work); });

// ---------- encoder with size budget ----------
// input: { args: [...ffmpeg input args], filter: 'scale=..' (pre-palette chain), fps, width }
function encode({ inputArgs, chain = '', fps, width, colors = Number(opt('colors', 256)) }) {
  const attempt = (fps, width, colors) => {
    const base = [chain, fps ? `fps=${fps}` : '', width ? `scale=${width}:-2:flags=lanczos` : ''].filter(Boolean).join(',') || 'null';
    const dither = colors >= 128 ? 'sierra2_4a' : 'bayer:bayer_scale=3';
    ff([...inputArgs, '-filter_complex', `[0:v]${base},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff:reserve_transparent=0[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`, '-loop', LOOP, OUT], 'gif');
    return fs.statSync(OUT).size;
  };
  let size = attempt(fps, width, colors), steps = 0;
  const limit = MAX_MB * 1024 * 1024;
  while (size > limit && steps < 10) {
    steps++;
    if (fps && fps > 12) fps = Math.max(12, Math.round(fps * 0.75));
    else if (colors > 64) colors = Math.max(64, colors / 2);
    else if (width && width > 320) width = Math.round(width * 0.85 / 2) * 2;
    else break;
    console.log(`  ${(size / 1048576).toFixed(2)} MB > ${MAX_MB} MB: retrying at ${fps || 'src'} fps, ${colors} colors, ${width || 'src'} px`);
    size = attempt(fps, width, colors);
  }
  if (flag('mp4')) ff([...inputArgs, '-vf', [chain, fps ? `fps=${fps}` : '', width ? `scale=${width}:-2:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2'].filter(Boolean).join(','), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', OUT.replace(/\.gif$/i, '') + '.mp4'], 'mp4');
  if (flag('webp')) ff([...inputArgs, '-vf', [chain, fps ? `fps=${fps}` : '', width ? `scale=${width}:-2:flags=lanczos` : ''].filter(Boolean).join(',') || 'null', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '75', '-loop', LOOP === '-1' ? '1' : '0', '-an', OUT.replace(/\.gif$/i, '') + '.webp'], 'webp');
  const p = probe(OUT), st = p?.streams?.[0] || {};
  console.log(`✓ ${OUT}  ${st.width}x${st.height} · ${(size / 1048576).toFixed(2)} MB · ${fps || 'src'} fps · ${colors} colors${size > limit ? `  (still over ${MAX_MB} MB: shorten it or lower --width)` : ''}`);
  if (flag('mp4')) console.log('  + ' + OUT.replace(/\.gif$/i, '') + '.mp4');
  if (flag('webp')) console.log('  + ' + OUT.replace(/\.gif$/i, '') + '.webp');
}

// ---------- headless browser with a virtual clock ----------
function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const P = process.env.PROGRAMFILES || 'C:/Program Files', P86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', L = process.env.LOCALAPPDATA || '';
  const c = process.platform === 'win32' ? [`${P}/Google/Chrome/Application/chrome.exe`, `${L}/Google/Chrome/Application/chrome.exe`, `${P86}/Microsoft/Edge/Application/msedge.exe`, `${P}/Microsoft/Edge/Application/msedge.exe`, `${P}/BraveSoftware/Brave-Browser/Application/brave.exe`]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  return c.find(p => fs.existsSync(p)) || die('no Chromium-based browser found; set BROWSER=/path/to/chrome');
}
// Replaces the page's clock: requestAnimationFrame, performance.now, Date.now, setTimeout/setInterval and all
// CSS/Web Animations advance only when we say so, so every frame is exact and the GIF loops cleanly.
const CLOCK = `(() => {
  let now = 0; const start = 1700000000000; let rafs = []; let timers = []; let tid = 1; const seen = new Map();
  performance.now = () => now; Date.now = () => start + now;
  window.requestAnimationFrame = cb => { rafs.push(cb); return rafs.length; };
  window.cancelAnimationFrame = () => {};
  window.setTimeout = (fn, ms = 0, ...a) => { const id = tid++; timers.push({ id, at: now + Math.max(0, ms), fn, a }); return id; };
  window.setInterval = (fn, ms = 0, ...a) => { const id = tid++; timers.push({ id, at: now + Math.max(1, ms), fn, a, every: Math.max(1, ms) }); return id; };
  window.clearTimeout = window.clearInterval = id => { timers = timers.filter(t => t.id !== id); };
  const syncAnims = () => { for (const an of document.getAnimations()) { if (!seen.has(an)) seen.set(an, now - (an.currentTime || 0)); an.pause(); an.currentTime = now - seen.get(an); } };
  window.__gif = { advance(ms) { const end = now + ms;
      for (;;) { timers.sort((x, y) => x.at - y.at); const t = timers[0]; if (!t || t.at > end) break; now = t.at; if (t.every) t.at += t.every; else timers.shift(); try { typeof t.fn === 'function' ? t.fn(...t.a) : 0; } catch (e) {} }
      now = end; const run = rafs; rafs = []; for (const cb of run) { try { cb(now); } catch (e) {} } syncAnims(); },
    get now() { return now; } };
  document.addEventListener('DOMContentLoaded', syncAnims);
})();`;
async function recordPage(url, { width, height, fps, dur, scale = 1 }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-maker-browser-'));
  const proc = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
  const kill = () => { try { proc.kill(); } catch {} setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500); };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    await sleep(200);
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
    const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, sessionId })); return new Promise((res, rej) => pending.set(i, { res, rej })); };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s('Page.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
    await s('Page.navigate', { url });
    const ev = async e => (await s('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
    for (let i = 0; i < 200; i++) { await sleep(100); try { if (await ev(`document.readyState === 'complete' && !!window.__gif`)) break; } catch {} }
    await ev(`document.fonts ? document.fonts.ready.then(() => 1) : 1`);
    await ev(`Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))`);
    const n = Math.max(1, Math.round(dur * fps)), step = 1000 / fps;
    process.stdout.write(`  recording ${n} frames at ${fps} fps…`);
    for (let f = 0; f < n; f++) {
      await ev(`window.__gif.advance(${f === 0 ? 0 : step})`);
      const { data } = await s('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      fs.writeFileSync(path.join(work, `f${String(f).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
    }
    process.stdout.write(' done\n');
    ws.close();
  } finally { kill(); }
}
const parseSize = (s, d) => { const m = String(s || d).match(/^(\d+)x(\d+)$/); return m ? [Number(m[1]), Number(m[2])] : die('bad --size, use WIDTHxHEIGHT'); };
const framesInput = fps => ['-framerate', String(fps), '-i', path.join(work, 'f%05d.png')];

// ---------- terminal session → HTML ----------
// Format: "$ cmd" typed; other lines printed; "@pause 800"; "@clear"; "@title text"; "@speed 35" (ms/char);
// "@prompt ❯"; colors auto (✓/✔ green, ✘/✗/error red, !/warn yellow, #/dim comment grey) or [green]..[/].
function terminalHtml(src, theme) {
  const T = theme === 'light' ? { bg: '#dcdcdc', win: '#ffffff', fg: '#1f2328', dim: '#6e7781', green: '#1a7f37', red: '#cf222e', yellow: '#9a6700', blue: '#0969da', bar: '#ececec', shadow: '0 2px 8px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.12)' }
    : { bg: '#0d1117', win: '#161b22', fg: '#e6edf3', dim: '#8b949e', green: '#3fb950', red: '#ff7b72', yellow: '#d29922', blue: '#79c0ff', bar: '#21262d', shadow: '0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(127,127,127,.18)' };
  const lines = src.replace(/\r/g, '').split('\n');
  const ev = []; let t = 400, speed = 38, title = '', prompt = '$';
  for (const raw of lines) {
    if (/^@title\s+/.test(raw)) { title = raw.replace(/^@title\s+/, ''); continue; }
    if (/^@speed\s+\d+/.test(raw)) { speed = Number(raw.split(/\s+/)[1]); continue; }
    if (/^@prompt\s+/.test(raw)) { prompt = raw.replace(/^@prompt\s+/, ''); continue; }
    if (/^@pause\s+\d+/.test(raw)) { t += Number(raw.split(/\s+/)[1]); continue; }
    if (/^@clear/.test(raw)) { ev.push({ t, clear: true }); t += 150; continue; }
    if (raw.startsWith('$ ')) { const cmd = raw.slice(2); ev.push({ t, cmd, typed: speed }); t += cmd.length * speed + 350; continue; }
    ev.push({ t, out: raw }); t += raw.trim() ? 90 : 40;
  }
  const total = t + 1800;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const color = s => {
    let h = esc(s).replace(/\[(green|red|yellow|blue|dim|bold)\]([\s\S]*?)\[\/\]/g, (_, c, x) => `<span class="${c}">${x}</span>`);
    if (!/class=/.test(h)) {
      if (/^\s*(✓|✔|PASS|ALLOW|ok\b)/.test(s)) h = `<span class="green">${h}</span>`;
      else if (/^\s*(✘|✗|✖|ERROR|FAIL|BLOCK)/i.test(s)) h = `<span class="red">${h}</span>`;
      else if (/^\s*(!|⚠|WARN|ASK)/i.test(s)) h = `<span class="yellow">${h}</span>`;
      else if (/^\s*(#|·|\.\.\.)/.test(s)) h = `<span class="dim">${h}</span>`;
    }
    return h.replace(/(https?:\/\/[^\s<]+)/g, '<span class="blue">$1</span>');
  };
  const data = JSON.stringify(ev.map(e => e.cmd !== undefined ? { ...e, html: esc(e.cmd) } : e.out !== undefined ? { t: e.t, html: color(e.out) } : e));
  return { total, html: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${T.bg};}
.win{position:absolute;inset:18px;background:${T.win};border-radius:10px;box-shadow:${T.shadow};overflow:hidden;display:flex;flex-direction:column}
.bar{height:38px;background:${T.bar};display:flex;align-items:center;padding:0 14px;gap:8px;flex:none}
.dot{width:12px;height:12px;border-radius:50%}.t{flex:1;text-align:center;color:${T.dim};font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif;margin-right:52px}
.term{flex:1;padding:16px 20px;font:15px/1.55 "Cascadia Mono","Cascadia Code",Consolas,"SF Mono",Menlo,"DejaVu Sans Mono",monospace;color:${T.fg};white-space:pre-wrap;word-break:break-word;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.p{color:${T.green};font-weight:700}.green{color:${T.green}}.red{color:${T.red}}.yellow{color:${T.yellow}}.blue{color:${T.blue}}.dim{color:${T.dim}}.bold{font-weight:700}
.cur{display:inline-block;width:9px;height:1.15em;vertical-align:-3px;background:${T.fg};margin-left:1px}
</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><div class="t">${esc(title)}</div></div><div class="term"><div id="o"></div></div></div>
<script>
const EV=${data}, P=${JSON.stringify(esc(prompt))}, o=document.getElementById('o');
function render(now){let rows=[],typing=false;for(const e of EV){if(e.t>now)break;if(e.clear){rows=[];continue}
 if(e.typed!==undefined){const n=Math.min(e.html.length,Math.floor((now-e.t)/e.typed));const done=n>=e.html.length;typing=!done;rows.push('<span class="p">'+P+'</span> '+e.html.slice(0,n)+(done?'':'<span class="cur"></span>'))}
 else rows.push(e.html||' ')}
 if(!typing){const blink=Math.floor(now/530)%2===0;rows.push('<span class="p">'+P+'</span> '+(blink?'<span class="cur"></span>':''))}
 o.innerHTML=rows.join('\\n')}
function loop(){render(performance.now());requestAnimationFrame(loop)}requestAnimationFrame(loop);render(0);
</script>` };
}

// ---------- modes ----------
const main = async () => {
  if (mode === 'html' || mode === 'terminal') {
    const [W, H] = parseSize(opt('size'), mode === 'terminal' ? '900x520' : '800x450');
    const fps = Number(opt('fps', mode === 'terminal' ? 15 : 24));
    let url, dur = Number(opt('dur', 0));
    if (mode === 'terminal') {
      const src = positional[0] && fs.existsSync(positional[0]) ? fs.readFileSync(positional[0], 'utf8') : die('give a session .txt file');
      const { html, total } = terminalHtml(src, flag('light') ? 'light' : opt('theme', 'dark'));
      const f = path.join(work, 'terminal.html'); fs.writeFileSync(f, html); url = 'file:///' + f.split(path.sep).join('/');
      if (!dur) dur = Math.min(60, total / 1000);
    } else {
      const src = positional[0] || die('give an .html file or URL');
      url = /^https?:|^file:/.test(src) ? src : 'file:///' + path.resolve(src).split(path.sep).join('/');
      if (!dur) dur = 4;
    }
    const scale = Number(opt('scale', 1));
    await recordPage(url, { width: W, height: H, fps, dur, scale });
    let chain = '';
    if (flag('pingpong')) { ff([...framesInput(fps), '-filter_complex', '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1', path.join(work, 'pp.mp4')], 'pingpong'); return encode({ inputArgs: ['-i', path.join(work, 'pp.mp4')], fps, width: Number(opt('width', W)) }); }
    return encode({ inputArgs: framesInput(fps), chain, fps, width: Number(opt('width', W)) });
  }
  if (mode === 'video') {
    const src = positional[0] && fs.existsSync(positional[0]) ? path.resolve(positional[0]) : die('give a video file');
    const fps = Number(opt('fps', 15)), width = Number(opt('width', 720)), speed = Number(opt('speed', 1));
    const inputArgs = [...(opt('start') ? ['-ss', opt('start')] : []), ...(opt('dur') ? ['-t', String(Number(opt('dur')) * speed)] : []), '-i', src];
    const parts = [];
    if (opt('crop')) parts.push(`crop=${opt('crop')}`);
    if (speed !== 1) parts.push(`setpts=PTS/${speed}`);
    if (opt('text')) {
      const font = ['C:/Windows/Fonts/seguibl.ttf', 'C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(f => fs.existsSync(f));
      const tf = path.join(work, 'caption.txt'); fs.writeFileSync(tf, opt('text'));
      const e = p => p.replace(/\\/g, '/').replace(/:/g, '\\:');
      const vh = Number(probe(src)?.streams?.[0]?.height) || 720, ch = opt('crop') ? Number(opt('crop').split(':')[1]) || vh : vh;
      parts.push(`drawtext=${font ? `fontfile='${e(font)}':` : ''}textfile='${e(tf)}':fontcolor=white:fontsize=h/11:borderw=${Math.max(2, Math.round(ch / 90))}:bordercolor=black@0.85:x=(w-text_w)/2:y=h-text_h-h/14`);
    }
    return encode({ inputArgs, chain: parts.join(','), fps, width });
  }
  if (mode === 'images') {
    const imgs = positional.filter(f => fs.existsSync(f)); if (imgs.length < 1) die('give one or more image files');
    const [W, H] = parseSize(opt('size'), '1000x600'), hold = Number(opt('hold', 1.6)), fade = Math.min(Number(opt('fade', 0.4)), hold / 2), fps = Number(opt('fps', 20));
    const bg = opt('bg', 'black');
    const inputs = imgs.flatMap(f => ['-loop', '1', '-t', String(hold + fade), '-i', path.resolve(f)]);
    const norm = imgs.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,fps=${fps},format=yuv420p[v${i}]`);
    let chain = norm.join(';'), last = 'v0';
    for (let i = 1; i < imgs.length; i++) { chain += `;[${last}][v${i}]xfade=transition=${opt('transition', 'fade')}:duration=${fade}:offset=${(hold * i).toFixed(3)}[x${i}]`; last = `x${i}`; }
    const mid = path.join(work, 'slides.mp4');
    ff([...inputs, '-filter_complex', chain, '-map', `[${last}]`, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', mid], 'slides');
    return encode({ inputArgs: ['-i', mid], fps, width: Number(opt('width', W)) });
  }
  if (mode === 'optimize') {
    const src = positional[0] && fs.existsSync(positional[0]) ? path.resolve(positional[0]) : die('give a .gif or video');
    if (path.resolve(src) === OUT) die('--out must differ from the input');
    const p = probe(src)?.streams?.[0] || {}; const [a, b] = String(p.r_frame_rate || '15/1').split('/').map(Number);
    return encode({ inputArgs: ['-i', src], fps: Math.min(Number(opt('fps', 30)), Math.round(a / (b || 1)) || 15), width: Number(opt('width', p.width || 720)) });
  }
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(1);
};
main().catch(e => die(e.message));
