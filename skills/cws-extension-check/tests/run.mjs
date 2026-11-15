// node tests/run.mjs — runs cws-check.mjs on every fixture and checks each expected finding (and that known
// false positives stay quiet). Fixtures are copied to a temp dir first; icons, keys, .env, .git and node_modules
// are generated there, because *.png is gitignored and secrets/junk shouldn't live in the repo.
// Also builds an upload zip and verifies it with an independent tool (bsdtar / unzip / python zipfile / Expand-Archive).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const here = p => fileURLToPath(new URL(p, import.meta.url));
const script = here('../scripts/cws-check.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-test-'));
let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('✘ ' + msg); } };

// ---------- generated files ----------
const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)) >>> 0, 8 + data.length); return b; };
const png = (w, h = w) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 4)))), chunk('IEND', Buffer.alloc(0))]); };
const put = (dir, rel, data) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const TOKEN = 'sk_' + 'live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'; // split so the repo's own secret scanners don't trip on this file
const icon = (rel = 'icon128.png', s = 128) => d => put(d, rel, png(s));
const SETUP = {
  good: d => { for (const s of [16, 48, 128]) put(d, `icons/icon${s}.png`, png(s)); put(d, 'images/badge.png', png(16)); },
  mv2: icon('icons/icon128.png'), 'bad-manifest': icon('icons/icon48.png', 32), locales: icon(), 'no-default-locale': icon(),
  'missing-files': icon('icons/icon128.png'), permissions: icon(), alias: icon(),
  'remote-code': d => { icon()(d); put(d, 'config.js', `const STRIPE = "${TOKEN}";\n`); },
  hygiene: d => {
    put(d, 'icons/icon128.png', png(64)); put(d, '.git/HEAD', 'ref: refs/heads/main\n'); put(d, 'node_modules/vendor/vendor.js', 'window.vendor = 1;\n');
    put(d, 'node_modules/unused/index.js', 'module.exports = 1;\n'); put(d, '.env', 'DEBUG=1\n'); put(d, 'key.pem', '-----BEGIN ' + 'PRIVATE KEY-----\nMIIfake\n-----END ' + 'PRIVATE KEY-----\n');
    put(d, 'background.js.map', '{}'); put(d, '.DS_Store', 'x'); put(d, 'Thumbs.db', 'x'); put(d, '_metadata/computed_hashes.json', '{}');
  },
  'dist-layout': d => { icon()(d); icon('dist/icon128.png')(d); const t = new Date(Date.now() - 3600e3); fs.utimesSync(path.join(d, 'dist/background.js'), t, t); },
  'plasmo-layout': d => { icon('build/chrome-mv3-dev/icon128.png')(d); icon('build/chrome-mv3-prod/icon128.png')(d); },
};
fs.cpSync(here('./fixtures'), tmp, { recursive: true });
for (const [name, setup] of Object.entries(SETUP)) setup(path.join(tmp, name));

// ---------- helpers ----------
const check = (target, ...args) => { const r = spawnSync(process.execPath, [script, target, '--json', ...args], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(r.stdout); } catch {} if (!j && /Error/.test(r.stderr)) console.log(r.stderr.slice(0, 800)); return { status: r.status, j, out: r.stdout + r.stderr }; };
const fx = name => path.join(tmp, name);
const summary = j => j ? j.findings.map(f => `${f.level}:${f.id}`).join(', ') : 'no JSON';
function expect(name, j, list) {
  for (const [lv, id, re] of list) ok(j?.findings.some(f => f.level === lv && f.id === id && (!re || re.test(f.msg))), `${name}: expected ${lv}:${id}${re ? ' ' + re : ''}\n    got: ${summary(j)}`);
}
const none = (name, j, pred, what) => ok(j && !j.findings.some(pred), `${name}: false positive (${what}): ${j?.findings.filter(pred).map(f => f.msg).join(' | ')}`);
// list a zip with something other than our own reader
function listZip(z) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const py = 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))';
  for (const [cmd, args] of [[tar, ['-tf', z]], ['unzip', ['-Z1', z]], ['python3', ['-c', py, z]], ['python', ['-c', py, z]]]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return { tool: path.basename(cmd), names: r.stdout.trim().split(/\r?\n/).filter(x => !x.endsWith('/')) };
  }
  return null;
}
function extractZip(z, dest) {
  const tries = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${z}' -DestinationPath '${dest}' -Force`]]]
    : [['unzip', ['-q', z, '-d', dest]], ['python3', ['-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', z, dest]]];
  for (const [cmd, args] of tries) if (spawnSync(cmd, args, { encoding: 'utf8' }).status === 0) return path.basename(cmd);
  return null;
}
const walk = (d, b = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), b) : [path.relative(b, path.join(d, e.name)).split(path.sep).join('/')]);
// a store-only zip, for hand-made "bad" zips (nested folder, backslashes, junk inside)
function makeZip(entries) {
  const parts = [], cd = []; let off = 0;
  for (const [name, data] of entries) {
    const nm = Buffer.from(name), crc = zlib.crc32(data) >>> 0, l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nm.length, 26);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(l, nm, data); cd.push(c, nm); off += 30 + nm.length + data.length;
  }
  const c = Buffer.concat(cd), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(c.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, c, e]);
}

// ---------- good: nothing blocking or rejectable, and a verified zip ----------
let r = check(fx('good'));
ok(r.status === 0, `good: exit 0 (got ${r.status})`);
none('good', r.j, f => f.level !== 'warn', 'block/reject on a clean extension');
expect('good', r.j, [['warn', 'function-polyfill', /Function\("return this"\)/]]);
none('good', r.j, f => /sandbox\.(js|html)/.test(f.msg) && f.level !== 'warn', 'eval in a sandboxed page');
none('good', r.j, f => f.id === 'placeholder-url', 'example.com inside an input placeholder');
ok(r.j?.manifest?.name === 'Weather Badge', `good: __MSG_appName__ resolves (got ${r.j?.manifest?.name})`);
ok(r.j?.leftOut.includes('README.md'), 'good: README.md is left out of the zip');
ok(/^No/.test(r.j?.drafts.remoteCode) && /sw\.js/.test(r.j?.drafts.permissions.alarms || ''), 'good: drafts say no remote code and name where alarms is used');
const goodZip = path.join(tmp, 'out', 'good.zip');
r = check(fx('good'), '--zip', goodZip);
ok(r.status === 0 && fs.existsSync(goodZip), `good: --zip writes the zip (status ${r.status})`);
const want = walk(fx('good')).filter(f => f !== 'README.md').sort();
const listed = listZip(goodZip);
if (!listed) console.log('  (skipped external zip listing: no bsdtar, unzip or python found)');
else {
  ok(listed.names[0] === 'manifest.json', `good: manifest.json is the first entry at the root (${listed.tool})`);
  ok(JSON.stringify([...listed.names].sort()) === JSON.stringify(want), `good: ${listed.tool} lists exactly the shipped files\n    want ${want}\n    got  ${listed.names}`);
}
const ex = path.join(tmp, 'extracted');
const tool = extractZip(goodZip, ex);
if (!tool) console.log('  (skipped extraction check: no Expand-Archive, unzip or python found)');
else ok(want.every(f => fs.readFileSync(path.join(ex, f)).equals(fs.readFileSync(path.join(fx('good'), f)))) && walk(ex).length === want.length, `good: ${tool} extracts every file byte-for-byte`);
console.log(`  upload zip verified with: ${[listed?.tool, tool].filter(Boolean).join(' + ') || 'none available'}`);
r = check(goodZip);
ok(r.status === 0 && !r.j?.findings.some(f => f.level !== 'warn'), `good.zip re-checked as a zip: clean (got ${summary(r.j)})`);
r = check(fx('good'), '--zip', path.join(fx('good'), 'inside.zip'));
ok(r.status === 1 && !fs.existsSync(path.join(fx('good'), 'inside.zip')), '--zip inside the extension folder is refused');

// ---------- manifest rules ----------
r = check(fx('mv2'));
expect('mv2', r.j, [['block', 'manifest-version', /Manifest V3/]]);
ok(r.status === 1, 'mv2: exit 1');
r = check(fx('mv2'), '--zip', path.join(tmp, 'out', 'mv2.zip'));
ok(r.status === 1 && !fs.existsSync(path.join(tmp, 'out', 'mv2.zip')), 'mv2: blocking problems mean no zip');

r = check(fx('bad-manifest'));
expect('bad-manifest', r.j, [
  ['block', 'name-length', /79 characters; the limit is 75/], ['block', 'description-length', /137 characters; the limit is 132/], ['block', 'version', /"1\.02\.0"/], ['block', 'icon-128'],
  ['warn', 'icon-size', /32x32/], ['block', 'missing-file', /icons\/missing\.png/], ['block', 'mv2-background'], ['block', 'mv2-war'], ['block', 'mv2-csp'],
  ['block', 'host-in-permissions', /https:\/\/\*\/\*/], ['warn', 'unknown-permission', /did you mean "storage"/], ['warn', 'key-field'], ['warn', 'update-url'],
  ['warn', 'homepage-placeholder'], ['block', 'match-pattern', /"https:\/\/google\.com"/],
]);

r = check(fx('locales'));
expect('locales', r.j, [['block', 'msg-key', /__MSG_appDesc__.*_locales\/en\//], ['warn', 'msg-key', /__MSG_appName__.*_locales\/fr\//], ['warn', 'description-length', /\(fr\); the limit is 132/], ['block', 'locale-messages', /_locales\/de\/messages\.json/]]);
none('locales', r.j, f => /__MSG_appName__/.test(f.msg) && /_locales\/en\//.test(f.msg), 'message keys are case-insensitive (APPNAME = appName)');
ok(r.j?.manifest?.name === 'Locale Test', 'locales: name resolved through a differently-cased key');
r = check(fx('no-default-locale'));
expect('no-default-locale', r.j, [['block', 'locale-default']]);

// ---------- files the manifest and pages point at ----------
r = check(fx('missing-files'));
expect('missing-files', r.j, [
  ['block', 'case-mismatch', /"Background\.js" but the file is "background\.js"/], ['block', 'missing-file', /"missing\.js"/], ['block', 'case-mismatch', /styles\/Content\.css/],
  ['block', 'missing-file', /options\.html/], ['block', 'missing-file', /panel\.html/], ['block', 'sidepanel-permission'], ['block', 'dnr-json'], ['block', 'dnr-permission'],
  ['warn', 'war-glob', /fonts\/\*/], ['block', 'war-matches'], ['block', 'missing-file', /inject\.js/], ['block', 'missing-permission', /chrome\.scripting/],
  ['warn', 'missing-file', /pages\/welcome\.html/], ['block', 'case-mismatch', /"Popup\.js" but the file is "popup\.js"/], ['block', 'missing-file', /missing\.css/],
  ['warn', 'missing-file', /img\/logo\.png/], ['warn', 'underscore-name', /_internal/],
]);

// ---------- remote code ----------
r = check(fx('remote-code'));
expect('remote-code', r.j, [
  ['block', 'csp', /'unsafe-eval' https:\/\/cdn\.jsdelivr\.net/], ['block', 'remote-script', /importScripts\("https:\/\/cdn\.example\.org/], ['block', 'sw-import'], ['warn', 'sw-api', /localStorage/],
  ['warn', 'mv2-api', /browserAction/], ['warn', 'string-timer', /sw\.js:5/], ['block', 'content-script-import', /cs\.js:1/], ['reject', 'eval', /cs\.js:5: .*looks fetched or stored/], ['warn', 'new-function', /cs\.js:4/],
  ['reject', 'remote-js-url', /evil\.example\.net/], ['reject', 'http-fetch', /Purple Copper/], ['block', 'remote-script', /lodash\.min\.js/], ['reject', 'inline-script', /popup\.html:4/],
  ['reject', 'inline-handler', /onclick/], ['block', 'bare-import', /"lodash"/], ['block', 'remote-import', /esm\.sh/], ['reject', 'obfuscated', /obf\.js/], ['block', 'secret', /Stripe live key/],
]);
none('remote-code', r.j, f => f.level !== 'warn' && /sandbox\.(js|html)/.test(f.msg), 'eval inside a sandboxed page');
expect('remote-code', r.j, [['warn', 'eval', /sandbox\.js:1: .*sandboxed page/], ['block', 'sw-import', /sw\.js:2:/]]);
none('remote-code', r.j, f => /cs\.js:[23]\b/.test(f.msg), 'eval in a comment or a .eval() method');
none('remote-code', r.j, f => /local-lib\.js/.test(f.msg), 'local importScripts file');
ok(!r.out.includes(TOKEN) && !check(fx('remote-code')).out.includes(TOKEN) && !spawnSync(process.execPath, [script, fx('remote-code')], { encoding: 'utf8' }).stdout.includes(TOKEN), 'remote-code: the secret is never printed');
ok(/^Yes/.test(r.j?.drafts.remoteCode), 'remote-code: draft says remote code is used');

// ---------- permissions ----------
r = check(fx('permissions'));
expect('permissions', r.j, [
  ['reject', 'unused-permission', /"alarms"/], ['reject', 'unused-permission', /"tabs"/], ['reject', 'unused-permission', /"cookies"/], ['reject', 'unused-permission', /"activeTab"/],
  ['block', 'missing-permission', /chrome\.notifications/], ['reject', 'webrequestblocking'], ['warn', 'background-permission'], ['warn', 'sensitive-permission', /cookies, history/],
  ['warn', 'broad-host', /<all_urls>/], ['reject', 'unused-host', /api\.unused-host\.io/], ['warn', 'localhost-host', /localhost:3000/],
]);
for (const p of ['storage', 'unlimitedStorage', 'history', 'downloads']) none('permissions', r.j, f => f.id === 'unused-permission' && f.msg.startsWith(`"${p}"`), `${p} is used`);
none('permissions', r.j, f => f.id === 'missing-permission' && /downloads/.test(f.msg), 'optional permission requested at runtime');
none('permissions', r.j, f => f.id === 'unused-host' && /localhost/.test(f.msg), 'localhost host is used by fetch');
ok(/bg\.js/.test(r.j?.drafts.permissions.storage || '') && /<all_urls>/.test(r.j?.drafts.permissions['Host permission'] || ''), 'permissions: drafts name files and hosts');
r = check(fx('alias'));
expect('alias', r.j, [['warn', 'unused-permission', /aliases the chrome object/]]);
none('alias', r.j, f => f.level === 'reject', 'unused permission asserted although chrome is aliased');

// ---------- package hygiene ----------
r = check(fx('hygiene'));
expect('hygiene', r.j, [['warn', 'secret-file', /\.env/], ['warn', 'secret-file', /key\.pem/], ['warn', 'ships-skipped-dir', /node_modules\/vendor\/vendor\.js/], ['reject', 'icon-size', /64x64/], ['warn', 'unreferenced-dir', /tests\//]]);
for (const f of ['.git/', 'node_modules/', '.env', 'key.pem', 'background.js.map', '.DS_Store', 'Thumbs.db', 'README.md', 'package.json', 'src/app.ts', '_metadata/'])
  ok(r.j?.leftOut.some(x => x === f || x.startsWith(f + ' ') || x.startsWith(f)), `hygiene: ${f} is left out`);
const hz = path.join(tmp, 'out', 'hygiene.zip');
r = check(fx('hygiene'), '--zip', hz);
const hl = listZip(hz)?.names || readNames(hz);
ok(r.status === 0 && hl.includes('node_modules/vendor/vendor.js') && hl.includes('popup.js') && hl.includes('tests/popup.test.js'), `hygiene: zip has the shipped files (${hl})`);
ok(!hl.some(f => /^(\.git\/|\.env|key\.pem|node_modules\/unused|_metadata\/)|\.map$|\.DS_Store|Thumbs\.db|README\.md|package\.json|\.ts$/.test(f)), `hygiene: zip has no junk or keys (${hl})`);
function readNames(z) { const b = fs.readFileSync(z), out = []; for (let p = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); p >= 0; p = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), p + 46)) out.push(b.toString('utf8', p + 46, p + 46 + b.readUInt16LE(p + 28))); return out; }

// ---------- zips made by hand ----------
const goodFiles = walk(fx('good')).filter(f => f !== 'README.md').map(f => [f, fs.readFileSync(path.join(fx('good'), f))]);
const zp = name => path.join(tmp, 'out', name);
fs.writeFileSync(zp('nested.zip'), makeZip(goodFiles.map(([f, d]) => ['myext/' + f, d])));
r = check(zp('nested.zip'));
expect('nested.zip', r.j, [['block', 'manifest-not-at-root', /"myext\/"/]]);
fs.writeFileSync(zp('dirty.zip'), makeZip([...goodFiles, ['.env', Buffer.from('K=1\n')], ['.git/HEAD', Buffer.from('ref\n')], ['notes.md', Buffer.from('# x\n')]]));
r = check(zp('dirty.zip'));
expect('dirty.zip', r.j, [['block', 'secret-file', /\.env is inside the zip/], ['warn', 'junk-in-zip', /\.git\//], ['warn', 'junk-in-zip', /notes\.md/]]);
fs.writeFileSync(zp('backslash.zip'), makeZip(goodFiles.map(([f, d]) => [f.replace(/\//g, '\\'), d])));
r = check(zp('backslash.zip'));
expect('backslash.zip', r.j, [['block', 'zip-backslash']]);

// ---------- where the built extension lives ----------
r = check(fx('dist-layout'));
ok(r.j?.notes.some(x => /checking dist\//.test(x)) && r.j?.manifest?.version === '1.9.0', `dist-layout: dist/ is checked (${r.j?.notes})`);
expect('dist-layout', r.j, [['warn', 'stale-dist', /version 1\.9\.0 but the source manifest is 2\.0\.0/], ['warn', 'stale-dist', /changed after dist\/ was built \(background\.js\)/]]);
r = check(fx('dist-layout'), '--no-dist');
ok(r.j?.manifest?.version === '2.0.0' && r.j?.leftOut.some(x => /^dist\/ \(a separate extension build/.test(x)), '--no-dist checks the root and leaves dist/ out of its zip');
r = check(fx('plasmo-layout'));
ok(r.j?.notes.some(x => /build\/chrome-mv3-prod/.test(x)) && r.j?.manifest?.name === 'Plasmo App', `plasmo-layout: the prod build is picked over dev (${r.j?.notes})`);

// ---------- the human-readable report renders for every fixture ----------
for (const name of Object.keys(SETUP)) {
  const t = spawnSync(process.execPath, [script, fx(name)], { encoding: 'utf8' });
  ok((t.status === 0 || t.status === 1) && !t.stderr && /files/.test(t.stdout), `${name}: text report renders (status ${t.status}) ${t.stderr.slice(0, 300)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n - bad}/${n} passed`); process.exit(bad ? 1 : 0);
