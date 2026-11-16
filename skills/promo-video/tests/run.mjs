// node tests/run.mjs
//   Serves tests/fixtures/site on 127.0.0.1, renders it in quick mode and from a storyboard (clicks, typing, zoom,
//   hover, Nepali caption, synthetic music), re-renders after a caption edit (must reuse the cached recording), and
//   checks with ffprobe: files, exact sizes, 30 fps, duration = plan ± 0.2 s, an audio stream, no black frames,
//   loudness, the playbook rules, validation errors, and that no browser, profile or work folder is left behind.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = p => fileURLToPath(new URL(p, import.meta.url));
const script = here('../scripts/promo.mjs'), site = here('./fixtures/site'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-test-'));
let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('✘ ' + msg); } };
const pids = [];
const run = (args, ms = 600000) => new Promise(res => {
  const c = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  pids.push(c.pid); let out = '';
  c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
  const t = setTimeout(() => c.kill(), ms);
  c.on('close', code => { clearTimeout(t); res({ code, out }); });
});
const types = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(site, p);
  if (!f.startsWith(site) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL0 = `http://127.0.0.1:${server.address().port}/`;
const probe = f => { try { return JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', f], { encoding: 'utf8' }).stdout); } catch { return {}; } };
const luma = (f, t) => { const b = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=64:-2,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout; return b && b.length ? b.reduce((s, x) => s + x, 0) / b.length / 255 : 0; };
async function verify(name, out, sbFile) {
  const plan = JSON.parse((await run(['plan', sbFile, '--json'])).out.trim().split('\n').pop());
  for (const p of plan) {
    const f = path.join(out, `promo-${p.format}.mp4`), [W, H] = p.format === '9x16' ? [1080, 1920] : [1920, 1080];
    ok(fs.existsSync(f), `${name}: ${f} missing`); if (!fs.existsSync(f)) continue;
    const j = probe(f), v = j.streams?.find(s => s.codec_type === 'video') || {}, dur = Number(j.format?.duration);
    ok(v.width === W && v.height === H, `${name} ${p.format}: size ${v.width}x${v.height}`);
    ok(v.r_frame_rate === '30/1', `${name} ${p.format}: frame rate ${v.r_frame_rate}`);
    ok(Math.abs(dur - p.seconds) <= 0.2, `${name} ${p.format}: duration ${dur} vs plan ${p.seconds}`);
    ok(j.streams?.some(s => s.codec_type === 'audio'), `${name} ${p.format}: no audio stream`);
    for (const t of [0, dur * 0.35, dur * 0.7, dur - 0.1]) { const l = luma(f, t.toFixed(2)); ok(l > 0.06, `${name} ${p.format}: frame at ${t.toFixed(1)} s is black (luma ${l.toFixed(3)})`); }
    ok(fs.existsSync(path.join(out, `poster-${p.format}.jpg`)) && fs.existsSync(path.join(out, `promo-${p.format}.json`)), `${name} ${p.format}: poster or sidecar missing`);
  }
  ok(fs.existsSync(path.join(out, 'contact.png')), `${name}: contact.png missing`);
  return plan;
}
const t0 = Date.now();
try {
  // 1. quick mode, both formats, no cache
  const qOut = path.join(tmp, 'quick'), q = await run(['quick', URL0, '--seconds', '14', '--out', qOut, '--no-cache']);
  ok(q.code === 0, `quick exit ${q.code}\n${q.out.slice(-1500)}`);
  if (q.code === 0) {
    const sb = JSON.parse(fs.readFileSync(path.join(qOut, 'storyboard.json'), 'utf8'));
    ok(sb.scenes.length >= 3 && sb.scenes.slice(1).every(s => s.actions?.[0]?.scroll), `quick: expected the hero + section scenes, got ${JSON.stringify(sb.scenes).slice(0, 300)}`);
    ok(/नमस्ते/.test(sb.hook), `quick: hook should come from the Nepali h1, got "${sb.hook}"`);
    ok(sb.brand?.logo && sb.brand.bg?.length === 2, 'quick: brand colors/logo not detected');
    await verify('quick', qOut, path.join(qOut, 'storyboard.json'));
    ok(!fs.existsSync(path.join(qOut, '.cache')), 'quick: --no-cache still wrote a cache');
  }
  // 2. storyboard: click, zoom, hover, type, a 16x9-only scene, synthetic music -> loudness and the rules
  const music = path.join(tmp, 'music.wav');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*2*t))+0.2*sin(2*PI*330*t)+0.15*sin(2*PI*440*t)':d=9:s=48000", '-ac', '2', music]);
  const sb = JSON.parse(fs.readFileSync(here('./fixtures/storyboard.json'), 'utf8'));
  sb.scenes[0].url = URL0; sb.music = music; sb.brand.logo = path.join(site, 'logo.svg');
  const sbFile = path.join(tmp, 'storyboard.json'); fs.writeFileSync(sbFile, JSON.stringify(sb, null, 2));
  const sOut = path.join(tmp, 'story'), s = await run(['render', sbFile, '--out', sOut]);
  ok(s.code === 0, `storyboard exit ${s.code}\n${s.out.slice(-1500)}`);
  if (s.code === 0) {
    const plan = await verify('storyboard', sOut, sbFile);
    ok(plan.find(p => p.format === '9x16').scenes === plan.find(p => p.format === '16x9').scenes - 1, 'storyboard: the 16x9-only scene should be skipped in 9x16');
    ok(!/nothing on the page matches/.test(s.out), `storyboard: a selector did not match:\n${s.out.match(/.*nothing on the page matches.*/g)}`);
    const c = await run(['check', sOut]);
    ok(c.code === 0 && !/✘/.test(c.out), `check: rules failed\n${c.out}`);
    ok(/✓ \d+ rules pass \([^)]*\b17\b/.test(c.out), `check: loudness rule 17 did not pass\n${c.out}`);
    // 3. caption edit -> the recording is reused from the cache
    sb.scenes[1].caption = 'Real projects, live fast'; fs.writeFileSync(sbFile, JSON.stringify(sb, null, 2));
    const r = await run(['render', sbFile, '--out', sOut, '--formats', '9x16']);
    ok(r.code === 0 && /\(1 cached\)/.test(r.out), `re-render after a caption edit should use the cache:\n${r.out.slice(-800)}`);
  }
  // 4. preview flags rule problems without rendering a video
  const weak = { title: 'Weak', hook: 'A hook that is far too long to read in time', scenes: [{ url: URL0, seconds: 9 }], formats: ['9x16'] };
  const wFile = path.join(tmp, 'weak.json'); fs.writeFileSync(wFile, JSON.stringify(weak));
  const w = await run(['render', wFile, '--out', path.join(tmp, 'weak'), '--preview', '--no-cache']);
  ok(w.code === 0 && /✘ 3 hook/.test(w.out) && /✘ 7 visual change/.test(w.out) && fs.existsSync(path.join(tmp, 'weak', 'preview.png')), `preview should flag rules 3 and 7:\n${w.out.slice(-800)}`);
  // 5. validation: clear errors, exit 2, no browser started
  fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify({ title: 'x', intro: { seconds: 2 }, brand: { bg: 'blue' }, scenes: [{ caption: 'no url', actions: [{ scroll: '#a', click: '#b' }, { zoom: '#c', scale: 9 }, { tap: '#d' }] }] }));
  const v = await run(['plan', path.join(tmp, 'bad.json')]);
  ok(v.code === 2 && /"intro" was removed/.test(v.out) && /brand\.bg: must be a hex color/.test(v.out) && /scenes\[0\]\.url: is required/.test(v.out) && /use one action per object/.test(v.out) && /scale: must be a number from 1.1 to 4/.test(v.out) && /needs one of scroll/.test(v.out), `validation messages:\n${v.out}`);
} finally { server.close(); }

// nothing left behind: browser profiles or work folders from our runs, or browsers using a promo-video profile
const left = fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('promo-video-') || d.startsWith('promo-work-')).filter(d => {
  try { return pids.includes(JSON.parse(fs.readFileSync(path.join(os.tmpdir(), d, 'owner.json'), 'utf8')).node); } catch { return true; }
});
ok(!left.length, `left behind in temp: ${left.join(', ')}`);
const ps = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*promo-video-*' -and $_.Name -match 'chrome|msedge|chromium' }).Count"], { encoding: 'utf8', windowsHide: true })
  : spawnSync('sh', ['-c', "ps -eo args | grep -E 'chrom|msedge' | grep -c -- '--user-data-dir=[^ ]*promo-video-' || true"], { encoding: 'utf8' });
const count = parseInt(ps.stdout, 10);
if (Number.isNaN(count)) console.log(`  (could not list processes: ${(ps.stderr || '').trim().slice(0, 120)})`); else ok(count === 0, `${count} browser process(es) still running with a promo-video profile`);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
console.log(`\n${n - bad}/${n} checks passed in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exitCode = bad ? 1 : 0;
