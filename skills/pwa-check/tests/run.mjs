// node tests/run.mjs
//   Runs scripts/pwa-check.mjs in folder mode on every fixture in tests/fixtures (headless browser, no network
//   needed) and checks the findings, Chrome's verdict, the offline test, exit codes, and that no browser process
//   or temp profile is left behind.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = p => fileURLToPath(new URL(p, import.meta.url));
const script = here('../scripts/pwa-check.mjs'), fixtures = here('./fixtures');
let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('✘ ' + msg); } };

// expected results per fixture
//   has: finding ids that must appear · cats: categories that must stay empty · chrome: Chrome's verdict
//   start/page2: offline state of start_url and the second page · exit: exit code
const CASES = {
  'good': { has: ['https', 'manifest', 'start-url', 'display', 'id', 'icon-192', 'icon-512', 'maskable-icon', 'screenshots', 'apple-touch-icon', 'sw-controls', 'sw-scope', 'sw-fetch-handler', 'cache-name-versioned', 'offline-start-url', 'offline-page2'], cats: ['install', 'offline', 'warn'], chrome: true, start: 'ok', page2: 'ok', exit: 0 },
  'missing-512': { has: ['icon-512-missing', 'icon-192', 'offline-start-url'], cats: ['install', 'offline'], chrome: true, start: 'ok', exit: 0 },
  'icon-size-mismatch': { has: ['icon-size-mismatch', 'icon-512-missing'], cats: ['install', 'offline'], chrome: true, start: 'ok', exit: 0 },
  'sw-no-fetch': { has: ['sw-no-fetch-handler', 'offline-start-url-fails', 'offline-page2-fails', 'sw-controls'], cats: ['install'], chrome: true, start: 'error-page', exit: 1 },
  'sw-empty-fetch': { has: ['sw-empty-fetch-handler', 'offline-start-url-fails'], cats: ['install'], chrome: true, start: 'error-page', exit: 1 },
  'start-url-out-of-scope': { has: ['start-url-out-of-scope', 'offline-start-url'], cats: ['install', 'offline'], chrome: true, start: 'ok', exit: 0 },
  'bad-json': { has: ['manifest-invalid-json'], chrome: false, exit: 1 },
  'not-a-pwa': { has: ['no-manifest-link', 'no-service-worker', 'no-viewport', 'no-apple-touch-icon'], chrome: false, exit: 1 },
  // start_url /app exists only when the server answers unknown routes with index.html
  'spa-route': { has: ['start-url-status', 'offline-start-url'], chrome: true, start: 'ok', exit: 1 },
  'spa-route --spa': { dir: 'spa-route', args: ['--spa'], has: ['start-url', 'offline-start-url'], cats: ['install', 'offline', 'warn'], chrome: true, start: 'ok', exit: 0 },
};
const missing = fs.readdirSync(fixtures).filter(d => !CASES[d]);
ok(!missing.length, `fixtures without expectations: ${missing.join(', ')}`);

const pids = [];
const run = args => new Promise(res => {
  const c = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  pids.push(c.pid);
  let out = '', err = '';
  c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
  const t = setTimeout(() => c.kill(), 150000);
  c.on('close', code => { clearTimeout(t); res({ code, out, err }); });
});

async function check(name) {
  const want = CASES[name], r = await run([path.join(fixtures, want.dir || name), '--json', ...(want.args || [])]);
  let j; try { j = JSON.parse(r.out); } catch { ok(false, `${name}: no JSON output (exit ${r.code}) ${r.err.slice(0, 300)}`); return; }
  const ids = new Set(j.findings.map(f => f.id));
  for (const id of want.has) ok(ids.has(id), `${name}: expected finding ${id}; got ${[...ids].join(', ')}`);
  for (const cat of want.cats || []) { const extra = j.findings.filter(f => f.cat === cat); ok(!extra.length, `${name}: unexpected ${cat} finding(s): ${extra.map(f => `${f.id} (${f.msg})`).join('; ')}`); }
  ok(j.chrome?.available, `${name}: Chrome's verdict unavailable: ${j.chrome?.error}`);
  if (j.chrome?.available) ok(j.chrome.installable === want.chrome, `${name}: Chrome installable=${j.chrome.installable}, expected ${want.chrome} (${JSON.stringify(j.chrome.errors)})`);
  if (want.start) ok(j.offline?.startOffline?.state === want.start, `${name}: offline start_url state ${j.offline?.startOffline?.state}, expected ${want.start}`);
  if (want.page2) ok(j.offline?.page2Offline?.state === want.page2, `${name}: offline page2 state ${j.offline?.page2Offline?.state}, expected ${want.page2}`);
  ok(!ids.has('offline-emulation-leaked'), `${name}: offline emulation leaked: ${j.findings.find(f => f.id === 'offline-emulation-leaked')?.msg}`);
  if (j.offline?.startOffline) ok(j.offline.serverHitsWhileOffline === 0, `${name}: ${j.offline.serverHitsWhileOffline} request(s) reached the fixture server while offline`);
  ok(r.code === want.exit, `${name}: exit ${r.code}, expected ${want.exit}`);
  console.log(`  ${name}: ${j.summary.install} install · ${j.summary.offline} offline · ${j.summary.warnings} warnings · ${j.summary.passes} passes`);
}

const names = Object.keys(CASES);
const t0 = Date.now();
for (let i = 0; i < names.length; i += 3) await Promise.all(names.slice(i, i + 3).map(check));

// text report renders, and a missing folder is a usage error (exit 2)
const txt = await run([path.join(fixtures, 'good')]);
ok(txt.code === 0 && /Verdict: installs · works offline · 0 warning/.test(txt.out) && /PASSES \(\d+\)/.test(txt.out), `text report: exit ${txt.code}\n${txt.out.slice(-400)}`);
const nf = await run([path.join(fixtures, 'does-not-exist')]);
ok(nf.code === 2, `missing folder should exit 2, got ${nf.code}`);

// nothing left behind: temp profiles owned by our runs, or browser processes using a pwa-check profile
const left = fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('pwa-check-')).filter(d => {
  try { return pids.includes(JSON.parse(fs.readFileSync(path.join(os.tmpdir(), d, 'owner.json'), 'utf8')).node); } catch { return true; }
});
ok(!left.length, `temp profile(s) left behind: ${left.join(', ')}`);
const ps = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pwa-check-*' -and $_.Name -match 'chrome|msedge|brave|chromium' }).Count"], { encoding: 'utf8', windowsHide: true })
  : spawnSync('sh', ['-c', "ps -eo args | grep -E 'chrom|msedge|brave' | grep -c -- '--user-data-dir=[^ ]*pwa-check-' || true"], { encoding: 'utf8' });
const count = parseInt(ps.stdout, 10);
if (Number.isNaN(count)) console.log(`  (could not list processes: ${(ps.stderr || ps.error?.message || '').trim().slice(0, 120)})`);
else ok(count === 0, `${count} browser process(es) still running with a pwa-check profile`);

console.log(`\n${n - bad}/${n} checks passed in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exitCode = bad ? 1 : 0;
