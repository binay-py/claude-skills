#!/usr/bin/env node
// itch-html5-package — check an HTML5 game folder against itch.io's rules and zip it correctly.
// Zero dependencies. Node 22+.
//
//   node itch-package.mjs ./build                    check + write ./build-itch.zip
//   node itch-package.mjs ./build --out game.zip
//   node itch-package.mjs ./build --check            check only, no zip
//
// itch.io HTML5 rules (https://itch.io/docs/creators/html5): index.html in the zip, ≤1,000 files, ≤500 MB
// extracted, ≤200 MB per file, paths ≤240 chars, case-sensitive file names, relative paths only, external
// requests over https.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const CHECK_ONLY = argv.includes('--check'); if (CHECK_ONLY) argv.splice(argv.indexOf('--check'), 1);
const outArg = opt('out');
const input = argv[0] && path.resolve(argv[0]);
if (!input || !fs.existsSync(input)) { console.log('usage: node itch-package.mjs <game-folder> [--out game.zip] [--check]'); process.exit(1); }

const errors = [], warns = [];
const err = s => errors.push(s), warn = s => warns.push(s);
const JUNK = /(^|\/)(\.git|node_modules|\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\.vscode|\.idea)(\/|$)/;
const SOURCE = /\.(psd|blend|blend1|aseprite|ase|kra|xcf|ai|fla|max|mb|ma|sketch|fig|tmx~|bak|tmp)$/i;

function walk(root) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name), rel = path.relative(root, abs).split(path.sep).join('/');
      if (JUNK.test(rel)) continue;
      if (e.isDirectory()) rec(abs); else if (e.isFile()) out.push(rel);
    }
  })(root);
  return out;
}

// ---------- find the game root ----------
let root = input;
if (fs.statSync(input).isFile()) {
  if (!/\.html?$/i.test(input)) { console.log('give a folder or a single .html file'); process.exit(1); }
  console.log('single HTML file: upload it as-is on itch (no zip needed) as long as it references no other files.');
  root = path.dirname(input);
}
if (!fs.existsSync(path.join(root, 'index.html'))) {
  const sub = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'index.html')));
  if (sub.length === 1) { warn(`index.html is inside "${sub[0].name}/", not at the top. Packaging that folder as the root (zipping the parent folder is the classic "index.html not found" mistake).`); root = path.join(root, sub[0].name); }
  else if (fs.readdirSync(root).some(f => f.toLowerCase() === 'index.html')) err(`entry file must be named exactly "index.html" (found "${fs.readdirSync(root).find(f => f.toLowerCase() === 'index.html')}")`);
  else err('no index.html found at the top of the folder');
}

const files = walk(root);
const lower = new Map(files.map(f => [f.toLowerCase(), f]));
const fileSet = new Set(files);
let total = 0;
for (const f of files) {
  const size = fs.statSync(path.join(root, f)).size; total += size;
  if (size > 200 * 1024 * 1024) err(`${f} is ${(size / 1048576).toFixed(0)} MB (itch limit: 200 MB per file)`);
  if (f.length > 240) err(`path is ${f.length} chars (itch limit: 240): ${f.slice(0, 80)}…`);
  if (SOURCE.test(f)) warn(`source/working file shipped to players: ${f}`);
  if (/[^\x20-\x7e]/.test(f)) warn(`non-ASCII file name (fine if UTF-8, but easy to break in references): ${f}`);
  if (/[\\:*?"<>|]/.test(f)) err(`file name has characters that break on Linux servers: ${f}`);
}
if (files.length > 1000) err(`${files.length} files (itch limit: 1,000). Pack sprites into atlases or bundle scripts.`);
if (total > 500 * 1024 * 1024) err(`${(total / 1048576).toFixed(0)} MB total (itch limit: 500 MB extracted)`);
// two files that differ only by case can't both exist on case-insensitive machines and confuse references
const byLower = {}; for (const f of files) (byLower[f.toLowerCase()] ||= []).push(f);
for (const g of Object.values(byLower)) if (g.length > 1) warn(`files differ only by case: ${g.join(', ')}`);

// ---------- reference scan ----------
const ASSET = 'png|jpe?g|gif|webp|avif|svg|bmp|ico|mp3|ogg|oga|wav|m4a|aac|flac|opus|mp4|webm|json|js|mjs|css|wasm|data|pck|glb|gltf|bin|obj|mtl|fbx|ttf|otf|woff2?|atlas|fnt|xml|txt|csv|tmx|tsx|ldtk|html?|frag|vert|glsl|unityweb|mem|br|gz';
const refRe = new RegExp(`(?:src|href|data)\\s*=\\s*["']([^"'#?]+)["']|url\\(\\s*["']?([^"')?#]+)["']?\\s*\\)|["'\`]([^"'\`\\s?#]+\\.(?:${ASSET}))(?:[?#][^"'\`]*)?["'\`]`, 'gi');
const checked = new Set(); let refs = 0;
for (const f of files.filter(f => /\.(html?|js|mjs|css|json)$/i.test(f))) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  if (text.length > 15 * 1024 * 1024) continue; // huge bundles: skip
  const isDoc = /\.html?$/i.test(f), isCss = /\.css$/i.test(f);
  for (const m of text.matchAll(refRe)) {
    let ref = (m[1] || m[2] || m[3] || '').trim();
    if (!ref || ref.length > 300 || /^(data:|blob:|javascript:|mailto:|about:|#|\$\{)/i.test(ref) || /[{}<>()\s*,;]/.test(ref)) continue;
    const key = f + '|' + ref; if (checked.has(key)) continue; checked.add(key); refs++;
    if (/^http:\/\//i.test(ref)) { err(`${f}: insecure http:// request (itch requires https): ${ref}`); continue; }
    if (/^(https:)?\/\//i.test(ref)) continue;
    if (ref.startsWith('/')) { err(`${f}: absolute path "${ref}" (itch serves your game from a subfolder; use "${ref.slice(1)}")`); continue; }
    if (ref.endsWith('/')) continue;
    let rel; try { rel = decodeURIComponent(ref); } catch { rel = ref; }
    // HTML/CSS resolve against their own folder; JS strings usually resolve against the page (root)
    const bases = isDoc || isCss ? [path.posix.dirname(f)] : ['.', path.posix.dirname(f)];
    const cands = bases.map(b => path.posix.normalize(path.posix.join(b, rel))).filter(c => !c.startsWith('..'));
    if (!cands.length || cands.some(c => fileSet.has(c))) continue;
    const ci = cands.map(c => lower.get(c.toLowerCase())).find(Boolean);
    if (ci) err(`${f}: "${ref}" — the file is "${ci}". Case differs: works on Windows/macOS, 403 on itch.io`);
    else if (isDoc || isCss) warn(`${f}: "${ref}" not found in the build`);
  }
}

// ---------- index.html sanity ----------
if (fs.existsSync(path.join(root, 'index.html'))) {
  const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (!/<meta[^>]+name=["']viewport/i.test(idx)) warn('index.html has no <meta name="viewport">: on phones the game renders zoomed out');
  if (/youtube\.com\/game_api|ytgame/i.test(idx)) warn('YouTube Playables SDK found: inside itch\'s iframe it can think it is on YouTube and wait forever. Ship a build without it or add a timeout.');
}

// ---------- report ----------
console.log(`\n${path.relative(process.cwd(), root) || '.'}: ${files.length} files, ${(total / 1048576).toFixed(1)} MB, ${refs} references checked`);
for (const e of errors) console.log('  ✘ ' + e);
for (const w of warns) console.log('  ! ' + w);
if (!errors.length && !warns.length) console.log('  ✓ ready for itch.io');
if (errors.length) { console.log(`\n${errors.length} problem(s) would break the game on itch.io. Fix them, then run again.`); process.exit(1); }
if (CHECK_ONLY) process.exit(0);

// ---------- zip (STORE for already-compressed media, DEFLATE for the rest) ----------
const out = path.resolve(outArg || input.replace(/[\\/]+$/, '') + '-itch.zip');
if (out.startsWith(root + path.sep)) { console.log('--out must be outside the game folder'); process.exit(1); }
const STORED = /\.(png|jpe?g|gif|webp|avif|mp3|ogg|oga|m4a|aac|opus|mp4|webm|woff2|br|gz|zip|unityweb)$/i;
const chunks = [], central = []; let offset = 0;
const dosTime = d => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
for (const f of files.sort()) {
  const data = fs.readFileSync(path.join(root, f)), name = Buffer.from(f, 'utf8');
  const store = STORED.test(f); const body = store ? data : zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data), { time, date } = dosTime(fs.statSync(path.join(root, f)).mtime);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(store ? 0 : 8, 8);
  local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, body);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
  c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += 30 + name.length + body.length;
}
const cd = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.writeFileSync(out, Buffer.concat([...chunks, cd, end]));
console.log(`\n✓ ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB). On itch: Kind of project = HTML, upload the zip, tick "This file will be played in the browser".`);
