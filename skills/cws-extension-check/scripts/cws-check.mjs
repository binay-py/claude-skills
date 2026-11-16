#!/usr/bin/env node
// cws-extension-check — check a Chrome extension against the Chrome Web Store's rules and build a correct upload zip.
// Zero dependencies. Node 22+. Read-only unless --zip is given.
//
//   node cws-check.mjs ./my-extension                  check only
//   node cws-check.mjs ./my-extension --zip out.zip    check, then write the upload zip (refused if anything blocks)
//   node cws-check.mjs ./upload.zip                    check a zip you already made
//   node cws-check.mjs ./repo --no-dist                check the folder itself even when dist/ has a manifest
//   node cws-check.mjs ./my-extension --json           findings as JSON
//
// Rules from developer.chrome.com, checked 2026-11: manifest reference (name ≤75, description ≤132, version format,
// MV3 CSP minimum), icons + webstore/images (128x128 PNG required), webstore/publish (2 GB package limit),
// webstore/program-policies/mv3-requirements (no remotely hosted code), webstore/troubleshooting (violation names).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf('--' + n); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const JSON_OUT = flag('json'), NO_DIST = flag('no-dist'), zipOut = opt('zip');
const input = argv[0] && path.resolve(argv[0]);
if (!input || !fs.existsSync(input)) { console.log('usage: node cws-check.mjs <extension-folder | upload.zip> [--zip out.zip] [--no-dist] [--json]'); process.exit(1); }

const F = [], notes = [];
const add = (level, id, msg, tag) => F.push({ level, id, msg: tag ? `${msg} [${tag}]` : msg, file: msg.match(/^([^\s:"]+\.[a-z]+)(?::\d+)*:/i)?.[1] });
const block = (id, m, t) => add('block', id, m, t), reject = (id, m, t) => add('reject', id, m, t), warn = (id, m, t) => add('warn', id, m, t);
const STORED = /\.(png|jpe?g|gif|webp|avif|mp3|ogg|m4a|aac|opus|mp4|webm|woff2|br|gz|zip)$/i; // already compressed: zip them as-is
const KB = n => n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// ---------- minimal zip reader (checking an existing zip, and verifying the one we write) ----------
function readZip(buf) {
  const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (e < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const out = [];
  for (let i = 0, p = buf.readUInt32LE(e + 16), n = buf.readUInt16LE(e + 10); i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name.endsWith('/')) continue;
    const at = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(at, at + size);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name}: unsupported compression method ${method}`);
    if (zlib.crc32(data) >>> 0 !== crc >>> 0) throw new Error(`${name}: CRC mismatch`);
    out.push({ name, data });
  }
  return out;
}

// ---------- where is the extension? ----------
let root = input, tmp = null, fromZip = false;
const hasManifest = d => fs.existsSync(path.join(d, 'manifest.json'));
if (fs.statSync(input).isFile()) {
  if (!/\.zip$/i.test(input)) { console.log('give an extension folder or a .zip'); process.exit(1); }
  fromZip = true; tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-check-'));
  let entries; try { entries = readZip(fs.readFileSync(input)); } catch (e) { console.log(`✘ ${path.basename(input)}: ${e.message}`); process.exit(1); }
  for (const { name, data } of entries) {
    if (name.includes('\\')) { block('zip-backslash', `zip entry "${name}" uses "\\" as the folder separator (old PowerShell Compress-Archive does this). Re-zip with --zip.`); continue; }
    const rel = path.posix.normalize(name);
    if (rel.startsWith('..') || path.posix.isAbsolute(rel)) { block('zip-path', `zip entry "${name}" points outside the package`); continue; }
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), data);
  }
  root = tmp;
  if (!hasManifest(root)) {
    const sub = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && hasManifest(path.join(root, e.name)));
    block('manifest-not-at-root', `"No manifest found in package": manifest.json must be at the top of the zip${sub.length ? `, not inside "${sub[0].name}/" (zip the folder's contents, not the folder)` : ''}`);
    if (sub.length) root = path.join(root, sub[0].name);
  }
} else {
  const BUILD = ['dist', 'build', '.output', 'out', 'extension', 'release'];
  const cands = [];
  for (const d of BUILD) {
    const abs = path.join(input, d); if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    if (hasManifest(abs)) cands.push(d);
    else for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (e.isDirectory() && hasManifest(path.join(abs, e.name))) cands.push(`${d}/${e.name}`);
  }
  // WXT/Plasmo write build/chrome-mv3-prod, .output/chrome-mv3; prefer production builds over dev ones
  cands.sort((a, b) => /dev/i.test(a) - /dev/i.test(b));
  if (cands.length && !NO_DIST) {
    root = path.join(input, cands[0]);
    notes.push(hasManifest(input) ? `checking ${cands[0]}/ (the built extension). The folder itself also has a manifest.json; pass --no-dist to check that instead.` : `checking ${cands[0]}/ (the built extension)`);
  } else if (!hasManifest(input)) { console.log(`no manifest.json in ${input}${cands.length ? '' : ' or its dist/, build/ or .output/ folders'}`); process.exit(1); }
}
const rootLabel = fromZip ? path.basename(input) : path.relative(process.cwd(), root).startsWith('..') ? root : path.relative(process.cwd(), root) || '.';

// ---------- walk: shipped files vs. files left out of the zip ----------
const SKIP_DIR = /^(\.git|\.svn|\.hg|node_modules|__MACOSX|\.vscode|\.idea|\.github|\.cache|\.parcel-cache|\.turbo|\.wxt|\.plasmo|_metadata)$/;
const SECRET = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(pem|p12|pfx)|id_rsa[^/]*|id_ed25519[^/]*|\.npmrc)$/i;
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.git(ignore|attributes|modules)|\.editorconfig|\.prettierrc[^/]*|\.eslintrc[^/]*|\.(eslint|npm|prettier)ignore|\.nvmrc|[^/]*\.(log|map|zip|crx|swp)|[^/]*~)$/i;
const DEV = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|tsconfig[^/]*\.json|jsconfig\.json|[^/]*\.config\.(js|cjs|mjs|ts)|[^/]*\.(md|markdown|ts|tsx|jsx|scss|sass|less|vue|svelte))$/i;
const all = [], skippedDirs = [];
const countFiles = d => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(d, e.name)) : 1; } catch {} return n; };
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const abs = path.join(d, e.name), rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) skippedDirs.push(`${rel}/ (${countFiles(abs)} files)`);
      else if (hasManifest(abs)) skippedDirs.push(`${rel}/ (a separate extension build, ${countFiles(abs)} files)`);
      else walk(abs);
    }
    else if (e.isFile()) all.push(rel);
  }
})(root);
const allSet = new Set(all), size = f => fs.statSync(path.join(root, f)).size;
const ext = f => path.posix.extname(f).toLowerCase();
const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };

// exact-case resolution against the real directory listing (Windows and macOS hide case mistakes)
const lsCache = new Map();
const ls = d => { if (!lsCache.has(d)) { try { lsCache.set(d, fs.readdirSync(d)); } catch { lsCache.set(d, null); } } return lsCache.get(d); };
function resolveRel(rel) {
  rel = path.posix.normalize(rel);
  if (rel.startsWith('..')) return { outside: true };
  let dir = root, actual = [], diff = false;
  for (const s of rel.split('/').filter(s => s && s !== '.')) {
    const names = ls(dir); if (!names) return { missing: true };
    const hit = names.includes(s) ? s : names.find(n => n.toLowerCase() === s.toLowerCase());
    if (!hit) return { missing: true };
    if (hit !== s) diff = true; actual.push(hit); dir = path.join(dir, hit);
  }
  if (!fs.statSync(dir).isFile()) return { missing: true };
  return diff ? { case: actual.join('/') } : { ok: actual.join('/') };
}
const referenced = new Set(), edges = []; // edges: [from, to] so we can tell what the manifest actually reaches
const clean = p => p.replace(/[?#].*$/, '').replace(/^\.?\//, '');
function checkRef(from, what, ref, level = 'block') {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const r = resolveRel(clean(ref)), say = level === 'block' ? block : warn;
  if (r.ok || r.case) edges.push([from, r.ok || r.case]);
  if (r.ok) { referenced.add(r.ok); return r.ok; }
  if (r.case) { referenced.add(r.case); block('case-mismatch', `${from}: ${what} "${ref}" but the file is "${r.case}". Case differs: works on Windows/macOS, breaks on Linux/ChromeOS and for reviewers`, 'Yellow Magnesium'); return r.case; }
  say('missing-file', `${from}: ${what} "${ref}" ${r.outside ? 'points outside the extension folder' : 'does not exist'}`);
  return null;
}

// ---------- manifest ----------
let m = null, raw = '';
if (!hasManifest(root)) block('manifest-missing', 'no manifest.json');
else {
  raw = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) { warn('manifest-bom', 'manifest.json starts with a UTF-8 byte-order mark; save it as UTF-8 without BOM'); raw = raw.slice(1); }
  try { m = JSON.parse(raw); } catch (e) {
    try { m = JSON.parse(raw.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '$1').replace(/,(\s*[}\]])/g, '$1')); warn('manifest-comments', 'manifest.json has comments or trailing commas. Chrome tolerates them; strict JSON parsers and tools do not. Remove them.'); }
    catch { block('manifest-json', `manifest.json is not valid JSON: ${e.message}`); }
  }
  if (m && (typeof m !== 'object' || Array.isArray(m))) { block('manifest-json', 'manifest.json must be a JSON object'); m = null; }
}

// _locales and __MSG_ keys
const locales = {}; // locale -> lower-cased message map
const locDir = (ls(root) || []).includes('_locales') && fs.statSync(path.join(root, '_locales')).isDirectory() ? ls(path.join(root, '_locales')) : null;
for (const loc of locDir || []) {
  const mf = `_locales/${loc}/messages.json`;
  if (!fs.existsSync(path.join(root, mf))) { if (fs.statSync(path.join(root, '_locales', loc)).isDirectory()) block('locale-messages', `${mf} is missing`); continue; }
  try { locales[loc] = Object.fromEntries(Object.entries(JSON.parse(read(mf).replace(/^﻿/, ''))).map(([k, v]) => [k.toLowerCase(), v?.message])); }
  catch (e) { block('locale-json', `${mf} is not valid JSON: ${e.message}`); locales[loc] = {}; }
}
const def = m?.default_locale;
const msg = (s, loc = def) => typeof s === 'string' ? s.replace(/__MSG_(\w+)__/g, (x, k) => locales[loc]?.[k.toLowerCase()] ?? x) : s;

if (m) {
  if (def && !locDir) block('locale-missing', `default_locale is "${def}" but there is no _locales/ folder`);
  else if (def && !locales[def]) block('locale-missing', `default_locale is "${def}" but _locales/${def}/messages.json is missing (found: ${Object.keys(locales).join(', ') || 'none'})`);
  if (!def && locDir) block('locale-default', '_locales/ exists but manifest.json has no default_locale');
  const keys = [...raw.matchAll(/__MSG_(\w+)__/g)].map(x => x[1]);
  if (keys.length && !def) block('locale-default', `manifest uses __MSG_${keys[0]}__ but has no default_locale`);
  for (const k of new Set(keys)) for (const loc of Object.keys(locales)) {
    if (locales[loc][k.toLowerCase()] == null) (loc === def ? block : warn)('msg-key', `__MSG_${k}__ is not defined in _locales/${loc}/messages.json${loc === def ? ' (the store would show the raw key)' : ' (falls back to the default locale)'}`);
  }

  // required keys and their formats
  if (m.manifest_version !== 3) block('manifest-version', `manifest_version is ${JSON.stringify(m.manifest_version)}. The Chrome Web Store only accepts Manifest V3`);
  if (!m.name) block('name', 'name is missing');
  if (!m.description) block('description', 'description is missing (required by the Chrome Web Store)');
  for (const loc of def && Object.keys(locales).length ? Object.keys(locales) : [undefined]) {
    const where = loc ? ` (${loc})` : '';
    const name = msg(m.name, loc), desc = msg(m.description, loc);
    // the documented limits; translations over them are a warning because some published items ship them
    const over = !loc || loc === def ? block : warn, tr = !loc || loc === def ? '' : '. Shorten the translation to be safe';
    if (typeof name === 'string' && name.length > 75) over('name-length', `name is ${name.length} characters${where}; the limit is 75${tr}`);
    if (typeof desc === 'string' && desc.length > 132) over('description-length', `description is ${desc.length} characters${where}; the limit is 132${tr}`);
    if (typeof desc === 'string' && /<[a-z/][^>]*>/i.test(desc)) warn('description-html', `description${where} contains HTML; it must be plain text`);
  }
  const v = String(m.version ?? '');
  if (!m.version) block('version', 'version is missing');
  else if (typeof m.version !== 'string') block('version', `version must be a string ("${m.version}"), not a JSON number`);
  else if (!/^\d+(\.\d+){0,3}$/.test(v) || v.split('.').some(p => +p > 65535 || /^0\d/.test(p)) || v.split('.').every(p => +p === 0))
    block('version', `version "${v}" is invalid: 1-4 dot-separated integers, each 0-65535, no leading zeros, not all zero (put text in version_name)`);
  if (/[([\-–]\s*(dev|local|localhost|debug|staging|test)\s*[)\]]?\s*$|\b(localhost|staging)\b/i.test(msg(m.name) || '')) warn('dev-name', `name "${msg(m.name)}" looks like a development build`);
  if (m.key) warn('key-field', 'manifest has a "key" field. A first upload can fail with "key field is not allowed in manifest", and on updates it must match the item. Strip it from the store build.');
  if (m.update_url) warn('update-url', 'update_url is for self-hosted extensions; the Web Store manages updates. Remove it.');
  if (/^https?:\/\/(www\.)?(example\.(com|org|net)|localhost)/i.test(m.homepage_url || '')) warn('homepage-placeholder', `homepage_url is a placeholder: ${m.homepage_url}`);

  // Manifest V2 leftovers
  if (m.manifest_version === 3) {
    for (const k of ['browser_action', 'page_action']) if (m[k]) block('mv2-key', `"${k}" is Manifest V2 and is ignored in MV3; rename it to "action"`);
    if (m.background && !m.background.service_worker && (m.background.scripts || m.background.page)) block('mv2-background', `background.${m.background.scripts ? 'scripts' : 'page'} is not supported in MV3; use background.service_worker`);
    else if (m.background?.scripts) warn('background-scripts', 'background.scripts is ignored by Chrome when service_worker is set (fine if it is there for Firefox)');
    if (m.background?.persistent !== undefined) warn('mv2-persistent', 'background.persistent does nothing in MV3; remove it');
    if ((m.web_accessible_resources || []).some(x => typeof x === 'string')) block('mv2-war', 'web_accessible_resources must be a list of {resources, matches} objects in MV3, not a list of strings');
    if (typeof m.content_security_policy === 'string') block('mv2-csp', 'content_security_policy must be an object ({"extension_pages": "..."}) in MV3');
  }
  const csp = typeof m.content_security_policy === 'object' ? m.content_security_policy?.extension_pages : null;
  if (typeof csp === 'string') for (const dir of csp.split(';')) {
    const [d, ...srcs] = dir.trim().split(/\s+/);
    if (!/^(script-src|script-src-elem|object-src|worker-src|default-src)$/.test(d || '')) continue;
    const bad = srcs.filter(s => !/^('self'|'wasm-unsafe-eval'|'none'|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(s));
    if (bad.length) block('csp', `content_security_policy.extension_pages ${d} allows ${bad.join(' ')}. MV3 only permits 'self' and 'wasm-unsafe-eval' for scripts (Chrome refuses to install otherwise)`);
  }

  // icons
  const ICON_BAD = { svg: 'SVG', webp: 'WebP', empty: 'an empty file', unknown: 'not an image Chrome can decode' };
  function checkIcon(where, sizeKey, ref) {
    const f = checkRef('manifest.json', where, ref); if (!f) return;
    const buf = Buffer.alloc(32), fd = fs.openSync(path.join(root, f), 'r'), n = fs.readSync(fd, buf, 0, 32, 0); fs.closeSync(fd);
    const png = n >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR';
    const type = png ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpeg' : buf.toString('latin1', 0, 3) === 'GIF' ? 'gif' : buf.toString('latin1', 0, 2) === 'BM' ? 'bmp'
      : buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : /^\s*(<\?xml|<svg)/i.test(buf.toString('utf8')) ? 'svg' : buf.readUInt32LE(0) === 0x10000 ? 'ico' : n ? 'unknown' : 'empty';
    if (ICON_BAD[type]) return block('icon-format', `${where} "${f}" is ${ICON_BAD[type]}. Icons must be PNG (or another raster format Chrome decodes; not SVG/WebP)`);
    if (sizeKey === '128' && type !== 'png') reject('icon-128-png', `icons.128 "${f}" is ${type.toUpperCase()}; the store requires a PNG`, 'Yellow Zinc');
    if (png && sizeKey) {
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      if (w !== +sizeKey || h !== +sizeKey) (sizeKey === '128' && where === 'icons' ? reject : warn)('icon-size', `${where}.${sizeKey} "${f}" is ${w}x${h}, declared as ${sizeKey}x${sizeKey}`, sizeKey === '128' && where === 'icons' ? 'Yellow Zinc' : undefined);
    }
  }
  if (!m.icons || typeof m.icons !== 'object') block('icon-128', 'no "icons" in manifest.json; the store requires a 128x128 PNG icon');
  else {
    if (!m.icons['128']) block('icon-128', `icons has no "128" entry (has ${Object.keys(m.icons).join(', ') || 'none'}); the store requires a 128x128 PNG icon`);
    for (const [k, p] of Object.entries(m.icons)) checkIcon('icons', k, p);
  }
  const di = m.action?.default_icon;
  if (typeof di === 'string') checkIcon('action.default_icon', null, di);
  else if (di && typeof di === 'object') for (const [k, p] of Object.entries(di)) checkIcon('action.default_icon', k, p);

  // every other file the manifest points at
  const R = (what, p) => checkRef('manifest.json', what, p);
  R('background.service_worker', m.background?.service_worker);
  (m.content_scripts || []).forEach((cs, i) => { for (const j of cs.js || []) R(`content_scripts[${i}].js`, j); for (const c of cs.css || []) R(`content_scripts[${i}].css`, c); });
  R('action.default_popup', m.action?.default_popup);
  R('options_page', m.options_page); R('options_ui.page', m.options_ui?.page); R('devtools_page', m.devtools_page);
  R('side_panel.default_path', m.side_panel?.default_path);
  for (const [k, p] of Object.entries(m.chrome_url_overrides || {})) R(`chrome_url_overrides.${k}`, p);
  for (const p of m.sandbox?.pages || []) R('sandbox.pages', p);
  R('storage.managed_schema', m.storage?.managed_schema);
  const rulesets = m.declarative_net_request?.rule_resources || [];
  if (rulesets.length > 100) block('dnr-limit', `${rulesets.length} static rulesets; the limit is 100`);
  for (const r of rulesets) { const f = R(`declarative_net_request ruleset "${r.id}"`, r.path); if (f) { try { if (!Array.isArray(JSON.parse(read(f)))) throw new Error('not an array'); } catch (e) { block('dnr-json', `${f}: rule file must be a JSON array of rules (${e.message})`); } } }
  for (const [i, w] of (m.web_accessible_resources || []).entries()) {
    if (typeof w !== 'object') continue;
    if (!w.matches && !w.extension_ids) block('war-matches', `web_accessible_resources[${i}] needs "matches" or "extension_ids"`);
    for (const r of w.resources || []) {
      if (!r.includes('*')) { checkRef('manifest.json', `web_accessible_resources[${i}]`, r); continue; }
      const re = new RegExp('^' + clean(r).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      const hits = all.filter(f => re.test(f)); hits.forEach(f => { referenced.add(f); edges.push(['manifest.json', f]); });
      if (!hits.length) warn('war-glob', `web_accessible_resources[${i}] "${r}" matches no files`);
    }
  }
  if (m.side_panel && !(m.permissions || []).includes('sidePanel')) block('sidepanel-permission', 'side_panel is set but "sidePanel" is not in permissions');
  if (rulesets.length && !(m.permissions || []).some(p => /^declarativeNetRequest(WithHostAccess)?$/.test(p))) block('dnr-permission', 'declarative_net_request rulesets need the "declarativeNetRequest" or "declarativeNetRequestWithHostAccess" permission');

  // match patterns
  const MATCH = /^(<all_urls>|(\*|https?|wss?|file|ftp|urn):\/\/(\*|\*\.[^/*]+|[^/*]+)?\/.*)$/;
  const patterns = [...(m.host_permissions || []).map(p => ['host_permissions', p]), ...(m.optional_host_permissions || []).map(p => ['optional_host_permissions', p]),
    ...(m.content_scripts || []).flatMap((cs, i) => (cs.matches || []).map(p => [`content_scripts[${i}].matches`, p]))];
  for (const [w, p] of patterns) if (!MATCH.test(p) || (/^file/.test(p) ? false : /^[^:]+:\/\/\//.test(p))) block('match-pattern', `${w}: "${p}" is not a valid match pattern (needs scheme://host/path, e.g. "https://example.com/*")`);
}

// ---------- shipped files ----------
const isLeftOut = f => SECRET.test(f) || JUNK.test(f) || DEV.test(f);
const sandboxPages = new Set((m?.sandbox?.pages || []).map(clean));
const sandboxScripts = new Set();
const textFiles = all.filter(f => /\.(m?js|cjs|html?)$/i.test(f) && !isLeftOut(f) && size(f) < 30 * 1048576);
const TEXT = new Map(textFiles.map(f => [f, read(f)]));
const lineOf = (text, i) => { let n = 1; for (let k = text.indexOf('\n'); k >= 0 && k < i; k = text.indexOf('\n', k + 1)) n++; return n; };
const at = (f, text, i) => { const ln = lineOf(text, i), start = text.lastIndexOf('\n', i - 1) + 1, col = i - start + 1; return `${f}:${ln}${col > 200 ? ':' + col : ''}`; };
const excerpt = (text, i, len = 60) => { const start = Math.max(text.lastIndexOf('\n', i - 1) + 1, i - 20); return text.slice(start, start + len).split('\n')[0].trim(); };
const inComment = (text, i) => { const start = text.lastIndexOf('\n', i - 1) + 1, before = text.slice(start, i); return /^\s*(\/\/|\*|\/\*|<!--)/.test(before) || /(^|[\s;{}()])\/\//.test(before) || text.lastIndexOf('/*', i) > text.lastIndexOf('*/', i); };
const inString = (text, i) => /["'`]\s*$/.test(text.slice(Math.max(0, i - 2), i)); // `'setTimeout("x")'` as data, e.g. a filter list
// resolve a reference the way the browser does (relative to the file, "../" clamps at the root, %20 decoded)
const urlRel = (from, ref) => { try { return decodeURIComponent(new URL(ref, 'chrome-extension://x/' + from).pathname.slice(1)); } catch { return null; } };
const strings = s => [...s.matchAll(/["'`]([^"'`]+)["'`]/g)].map(x => x[1]);
const REMOTE = /^(https?:)?\/\//i;

// HTML pages: scripts, styles, inline code
const moduleFiles = new Set();
if (m?.background?.type === 'module' && m.background.service_worker) moduleFiles.add(clean(m.background.service_worker));
const uiPages = new Set([m?.action?.default_popup, m?.options_page, m?.options_ui?.page, m?.side_panel?.default_path, m?.devtools_page, ...Object.values(m?.chrome_url_overrides || {})].filter(p => typeof p === 'string').map(clean));
for (const [f, text] of TEXT) {
  if (!/\.html?$/i.test(f)) continue;
  const sandbox = sandboxPages.has(f), ui = uiPages.has(f);
  const local = ref => urlRel(f, ref) ?? ref;
  for (const t of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)) {
    const attrs = t[1], src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1], type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (src) {
      if (REMOTE.test(src)) (sandbox ? warn : block)('remote-script', `${at(f, text, t.index)}: <script src="${src}"> loads code from the internet. MV3 bans remotely hosted code: download it into the package`, 'Blue Argon');
      else if (!/^(data|blob|chrome-extension):/i.test(src)) { const r = checkRef(f, '<script src>', local(src)); if (r && type === 'module') moduleFiles.add(r); if (r && sandbox) sandboxScripts.add(r); }
    } else if (t[2].trim() && !sandbox && !/json|importmap|template|speculationrules|text\/plain/.test(type || '')) {
      (ui ? reject : warn)('inline-script', `${at(f, text, t.index)}: inline <script> never runs on an extension page (MV3 CSP is script-src 'self'). Move it to a .js file`, ui ? 'Yellow Magnesium' : undefined);
    }
  }
  const handler = !sandbox && text.match(/<[a-z][^>]*\s(on(click|load|change|submit|input|keyup|keydown|mouseover|error))\s*=\s*["']/i);
  if (handler) (ui ? reject : warn)('inline-handler', `${at(f, text, handler.index)}: inline ${handler[1]}="..." handler is blocked by the MV3 CSP; use addEventListener`, ui ? 'Yellow Magnesium' : undefined);
  for (const l of text.matchAll(/<link\b[^>]*>/gi)) {
    const href = l[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]; if (!href || REMOTE.test(href) || /^(data|blob|#)/i.test(href)) continue;
    checkRef(f, '<link href>', local(href), /stylesheet|modulepreload/i.test(l[0]) ? 'block' : 'warn');
  }
  for (const s of text.matchAll(/<(img|source|audio|video|iframe)\b[^>]*\bsrc\s*=\s*["']([^"'{}]+)["']/gi))
    if (!REMOTE.test(s[2]) && !/^(data|blob|chrome|chrome-extension|about|javascript):/i.test(s[2])) checkRef(f, `<${s[1]} src>`, local(s[2]), 'warn');
}

// JS: imports, importScripts, injected files, remote code
const swFile = m?.background?.service_worker && clean(m.background.service_worker);
const csFiles = new Set((m?.content_scripts || []).flatMap(cs => (cs.js || []).map(clean)));
const IMPORT_RE = /(?<=^|[;}\n])[ \t]*(?:import\s*(?:[\w$*{][^;'"]*?\bfrom\s*)?|export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*)["']([^"'\n]+)["']|\bimport\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g;
const queue = [...moduleFiles];
for (let i = 0; i < queue.length; i++) { // follow the module graph so bare/missing imports are checked in module files
  const f = queue[i], text = TEXT.get(f); if (!text) continue;
  for (const x of text.matchAll(IMPORT_RE)) {
    const spec = x[1] || x[2]; if (!spec || REMOTE.test(spec) || inComment(text, x.index)) continue;
    if (!/^[./]/.test(spec)) { if (x[1]) block('bare-import', `${at(f, text, x.index)}: import "${spec}" is a bare package name; extensions can't resolve it. Bundle the code or import a relative file`); continue; }
    const r = resolveRel(urlRel(f, spec) ?? spec);
    if (r.ok && !moduleFiles.has(r.ok)) { moduleFiles.add(r.ok); queue.push(r.ok); }
  }
}
const SECRETS = [[/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic key'], [/\bsk-(proj-)?[A-Za-z0-9_-]{40,}/g, 'OpenAI key'], [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, 'GitHub token'], [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS key'], [/\b[sr]k_live_[0-9A-Za-z]{20,}/g, 'Stripe live key'], [/\bxox[baprs]-[0-9A-Za-z-]{10,}/g, 'Slack token'], [/\bgsk_[A-Za-z0-9]{40,}/g, 'Groq key'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key']];
const MV2_API = /\b(?:chrome|browser)\s*\.\s*(browserAction|pageAction|tabs\s*\.\s*(?:executeScript|insertCSS|removeCSS|getSelected)|extension\s*\.\s*(?:getBackgroundPage|sendRequest|onRequest|getURL|getExtensionTabs)|runtime\s*\.\s*getBackgroundPage)\b\s*[.(]/g;
const hosts = new Map(); // external host -> first file that names it
let remoteCode = false, aliasedChrome = null;
for (const [f, text] of TEXT) {
  const isJs = !/\.html?$/i.test(f), sandbox = sandboxPages.has(f) || sandboxScripts.has(f), dir = path.posix.dirname(f);
  for (const [re, what] of SECRETS) for (const x of text.matchAll(re)) block('secret', `${at(f, text, x.index)}: ${what} in shipped code (${x[0].slice(0, 4)}…, ${x[0].length} chars). Anyone who installs the extension can read it; move it to a server and revoke it`);
  for (const x of text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/gi)) if (!/(^|\.)(w3\.org|example\.(com|org|net)|schema\.org|xmlsoap\.org|purl\.org)$/i.test(x[1]) && !hosts.has(x[1].toLowerCase())) hosts.set(x[1].toLowerCase(), f);
  for (const x of text.matchAll(/https?:\/\/(www\.)?(example\.(com|org|net)|your-?domain\.com)\b[^"'`\s)]*/gi)) {
    const before = text.slice(Math.max(0, x.index - 40), x.index);
    if (!inComment(text, x.index) && !/placeholder|e\.g\.|eg:|example:|like\s*$/i.test(before)) reject('placeholder-url', `${at(f, text, x.index)}: placeholder URL ${x[0].slice(0, 60)} (a button or link that goes to example.com fails review)`, 'Yellow Magnesium');
  }
  if (!isJs) continue;
  // `const api = chrome;`, `browser || chrome`, `})(chrome)`: permission use can't be traced by name
  if (!aliasedChrome && /(?:const|let|var)\s+[\w$]+\s*=\s*(?:globalThis\.|window\.|self\.)?chrome\s*[;,\n]|\bbrowser\s*\|\|\s*chrome\b|\bchrome\s*\|\|\s*browser\b|\}\s*\)\s*\(\s*(?:globalThis\.)?chrome\s*\)/.test(text)) aliasedChrome = f;
  // eval of a string that came from a server/storage/message is the Blue Argon violation; eval of a local string is
  // allowed by policy but throws on extension pages and in the service worker (MV3 CSP), so it's a warning
  const FETCHED = /\bfetch\s*\(|XMLHttpRequest|responseText|\.text\s*\(\s*\)|onMessage|storage\s*\.\s*(local|sync|session)\s*\.\s*get|\batob\s*\(/;
  const flagCode = (re, id, why, ok) => { for (const x of text.matchAll(re)) {
    if (inComment(text, x.index) || inString(text, x.index)) continue;
    const ex = excerpt(text, x.index), where = at(f, text, x.index);
    if (ok && ok.test(text.slice(x.index, x.index + 60))) { warn('function-polyfill', `${where}: ${ex} (a common library polyfill; usually accepted, but reviewers can ask)`); continue; }
    const end = text.slice(x.index, x.index + 160).search(/[;\n]/), context = text.slice(Math.max(0, x.index - 200), x.index + (end < 0 ? 160 : end)); // 200 chars before, to the end of the statement
    if (sandbox) warn(id, `${where}: ${ex} runs strings as code in a sandboxed page. Allowed there, but reviewers must still be able to see what it runs`);
    else if (FETCHED.test(context)) { reject(id, `${where}: ${why}, and the string looks fetched or stored, which is remotely hosted code: ${ex}`, 'Blue Argon'); remoteCode = true; }
    else warn(id, `${where}: ${why}. It throws on extension pages and in the service worker (MV3 CSP), and reviewers check where the string comes from: ${ex}`);
  } };
  flagCode(/(?<![.\w$])eval\s*\(|\b(?:window|globalThis|self)\.eval\s*\(/g, 'eval', 'eval() runs a string as code');
  flagCode(/\bnew\s+Function\s*\(|(?<![.\w$])Function\s*\(\s*["'`]/g, 'new-function', 'new Function() runs a string as code', /^(new\s+)?Function\s*\(\s*["'](return this|r["']\s*,\s*["']regeneratorRuntime\s*=\s*r)["']\s*\)/);
  flagCode(/\bset(?:Timeout|Interval)\s*\(\s*["'`]/g, 'string-timer', 'setTimeout/setInterval with a string argument is eval');
  for (const x of text.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    if (inComment(text, x.index)) continue;
    if (f === swFile && m?.background?.type === 'module') block('importscripts-module', `${at(f, text, x.index)}: importScripts() throws in a module service worker ("type": "module"); use import`);
    for (const s of strings(x[1])) {
      if (REMOTE.test(s)) { block('remote-script', `${at(f, text, x.index)}: importScripts("${s}") loads code from the internet; MV3 bans remotely hosted code`, 'Blue Argon'); remoteCode = true; }
      else checkRef(f, 'importScripts', urlRel(f, s) ?? s);
    }
  }
  for (const x of text.matchAll(IMPORT_RE)) {
    const spec = x[1] || x[2]; if (!spec || inComment(text, x.index)) continue;
    if (REMOTE.test(spec)) { (sandbox ? warn : block)('remote-import', `${at(f, text, x.index)}: import of "${spec}" loads code from the internet; MV3 bans remotely hosted code`, 'Blue Argon'); remoteCode ||= !sandbox; }
    else if (/^[./]/.test(spec)) checkRef(f, 'import', urlRel(f, spec) ?? spec);
    if (x[1] && csFiles.has(f)) block('content-script-import', `${at(f, text, x.index)}: content scripts are classic scripts and can't use import statements; bundle them or use dynamic import() of a web-accessible file`);
    else if (x[1] && f === swFile && m?.background?.type !== 'module') block('sw-import', `${at(f, text, x.index)}: the service worker uses import but background.type is not "module"; Chrome fails with "Service worker registration failed"`);
  }
  for (const x of text.matchAll(/\b(executeScript|insertCSS|registerContentScripts|updateContentScripts)\s*\([\s\S]{0,400}?\bfiles\s*:\s*\[([^\]]*)\]/g)) for (const s of strings(x[2])) if (!s.includes('${')) checkRef(f, `${x[1]} files`, s);
  for (const x of text.matchAll(/\bgetURL\s*\(\s*["'`]([^"'`$]+\.[a-z0-9]+)["'`]\s*\)/gi)) checkRef(f, 'runtime.getURL', x[1], 'warn');
  // any string naming a shipped file is a load edge (pages opened with tabs.create, offscreen documents, workers…)
  for (const x of text.matchAll(/["'`]\/?((?:[\w.-]+\/)*[\w.-]+\.(?:html?|m?js|css|json|wasm))(?:[?#][^"'`]*)?["'`]/g))
    for (const c of [clean(x[1]), urlRel(f, x[1])]) if (c && allSet.has(c)) { edges.push([f, c]); break; }
  for (const x of text.matchAll(/\b(?:path|url|default_path)\s*:\s*["']([^"':]+\.html)(?:[?#][^"']*)?["']/g)) checkRef(f, 'page', x[1], 'warn');
  // a remote .js URL assigned to a src (script injection); bare URL strings are usually data (filter lists, docs links)
  for (const x of text.matchAll(/(?:\.src\s*=\s*|setAttribute\s*\(\s*["']src["']\s*,\s*|\bsrc\s*:\s*)["'`]((?:https?:)?\/\/[^"'`\s]+\.m?js)(?:\?[^"'`]*)?["'`]/g)) if (!sandbox && !inComment(text, x.index)) { reject('remote-js-url', `${at(f, text, x.index)}: remote JavaScript URL ${x[1].slice(0, 70)}. Injecting or running it is remotely hosted code`, 'Blue Argon'); remoteCode = true; }
  const obf = (text.match(/\b_0x[0-9a-f]{4,6}\b/g) || []).length;
  if (obf >= 30) reject('obfuscated', `${f}: looks obfuscated (${obf} _0x… identifiers). Obfuscation is banned; minification is fine`, 'Red Titanium');
  for (const x of text.matchAll(MV2_API)) if (!inComment(text, x.index)) warn('mv2-api', `${at(f, text, x.index)}: chrome.${x[1].replace(/\s/g, '')} does not exist in MV3; this line throws if it runs (fine behind a feature check)`);
  for (const x of text.matchAll(/\bfetch\s*\(\s*["'`]http:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/g)) reject('http-fetch', `${at(f, text, x.index)}: request over plain http://; send data over https only`, 'Purple Copper');
  if (f === swFile) for (const x of text.matchAll(/\b(localStorage\s*\.\s*(getItem|setItem)|new\s+XMLHttpRequest)\b/g)) if (!inComment(text, x.index)) warn('sw-api', `${at(f, text, x.index)}: ${x[1].replace(/\s/g, '')} does not exist in a service worker; use chrome.storage / fetch`);
}

// ---------- permissions ----------
const KNOWN = new Set('accessibilityFeatures.modify accessibilityFeatures.read activeTab alarms audio background bookmarks browsingData certificateProvider clipboardRead clipboardWrite contentSettings contextMenus cookies debugger declarativeContent declarativeNetRequest declarativeNetRequestWithHostAccess declarativeNetRequestFeedback dns desktopCapture documentScan downloads downloads.open downloads.ui enterprise.deviceAttributes enterprise.hardwarePlatform enterprise.networkingAttributes enterprise.platformKeys favicon fileBrowserHandler fileSystemProvider fontSettings gcm geolocation history identity identity.email idle loginState management nativeMessaging notifications offscreen pageCapture platformKeys power printerProvider printing printingMetrics privacy processes proxy publicSuffix readingList runtime scripting search sessions sidePanel storage system.cpu system.display system.memory system.storage tabCapture tabGroups tabs topSites tts ttsEngine unlimitedStorage userScripts vpnProvider wallpaper webAuthenticationProxy webNavigation webRequest webRequestAuthProvider webRequestBlocking'.split(' ')); // permissions-list page + webRequestAuthProvider (webRequest API page)
const CODE = [...TEXT].filter(([f]) => !/\.html?$/i.test(f) || /<script/i.test(TEXT.get(f)));
const uses = re => CODE.filter(([, t]) => re.test(t)).map(([f]) => f);
const api = ns => uses(new RegExp(`\\b(?:chrome|browser)\\s*(?:\\?\\.|\\.)\\s*${ns.replace(/\./g, '\\s*\\.\\s*')}\\b|\\bchrome\\s*\\[\\s*["']${ns}["']`));
const SPECIAL = {
  activeTab: () => m?.action || m?.browser_action || m?.commands || m?.omnibox || api('contextMenus').length ? ['(user gesture)'] : [],
  unlimitedStorage: () => [...api('storage'), ...uses(/\bindexedDB\b|\bcaches\s*\.\s*open\b/)],
  tabs: () => api('tabs').length || api('windows').length ? uses(/\.(url|title|favIconUrl|pendingUrl)\b/) : [],
  clipboardWrite: () => uses(/navigator\s*\.\s*clipboard\s*\.\s*write|execCommand\s*\(\s*["'](copy|cut)/), clipboardRead: () => uses(/navigator\s*\.\s*clipboard\s*\.\s*read|execCommand\s*\(\s*["']paste/),
  geolocation: () => uses(/navigator\s*\.\s*geolocation/), nativeMessaging: () => uses(/connectNative|sendNativeMessage/), favicon: () => uses(/_favicon\//),
  declarativeNetRequest: () => m?.declarative_net_request ? ['manifest'] : api('declarativeNetRequest'), declarativeNetRequestWithHostAccess: () => SPECIAL.declarativeNetRequest(),
  declarativeNetRequestFeedback: () => uses(/getMatchedRules|onRuleMatchedDebug/), sidePanel: () => m?.side_panel ? ['manifest'] : api('sidePanel'),
  'downloads.open': () => uses(/downloads\s*\.\s*(open|show)\b/), 'downloads.ui': () => uses(/setUiOptions|setShelfEnabled/), 'identity.email': () => uses(/getProfileUserInfo/),
  background: () => ['(no API)'], webRequestBlocking: () => ['(no API)'], ttsEngine: () => m?.tts_engine ? ['manifest'] : api('ttsEngine'),
  webRequestAuthProvider: () => uses(/onAuthRequired/), 'accessibilityFeatures.read': () => api('accessibilityFeatures'), 'accessibilityFeatures.modify': () => api('accessibilityFeatures'), runtime: () => ['(always)'], publicSuffix: () => ['(no API)'],
};
const usedBy = p => (SPECIAL[p] || (() => api(p)))();
const perms = [...(m?.permissions || []).map(p => [p, 'permissions']), ...(m?.optional_permissions || []).map(p => [p, 'optional_permissions'])];
const declared = new Set(perms.map(([p]) => p));
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const unusedLevel = aliasedChrome ? warn : reject;
for (const [p, where] of perms) {
  if (typeof p !== 'string') continue;
  if (/:\/\/|^<all_urls>$/.test(p)) { if (m.manifest_version === 3) block('host-in-permissions', `${where} contains the host pattern "${p}". MV3 ignores it there; move it to ${where === 'permissions' ? 'host_permissions' : 'optional_host_permissions'}`); continue; }
  if (!KNOWN.has(p)) { const near = [...KNOWN].find(k => lev(k.toLowerCase(), p.toLowerCase()) <= 2); warn('unknown-permission', `${where}: "${p}" is not in Chrome's permission list${near ? ` (did you mean "${near}"?)` : ' (typo, or Firefox-only?)'}`); continue; }
  if (p === 'webRequestBlocking') { reject('webrequestblocking', '"webRequestBlocking" only works for policy-installed extensions in MV3; use declarativeNetRequest', 'Purple Potassium'); continue; }
  if (p === 'background') { warn('background-permission', '"background" keeps Chrome running after the last window closes; reviewers ask why. Remove it unless you need that'); continue; }
  if (!usedBy(p).length) unusedLevel('unused-permission', `"${p}" (${where}) is declared but nothing uses it${p === 'tabs' ? ' (chrome.tabs works without it; "tabs" only unlocks tab.url/title/favIconUrl)' : p === 'activeTab' ? ' (it is only granted by clicking the toolbar button, a context menu item or a shortcut, and this extension has none)' : ` (no chrome.${p} calls found)`}. Remove it${aliasedChrome ? `. Unsure: ${aliasedChrome} aliases the chrome object, so check by hand` : ''}`, aliasedChrome ? undefined : 'Purple Potassium');
}
// namespaces that are undefined without their permission (chrome.management.getSelf works without one, so it's not here)
const NEEDS = 'storage alarms contextMenus notifications scripting cookies downloads history bookmarks sidePanel offscreen webRequest webNavigation identity idle tabGroups topSites tts debugger proxy privacy sessions browsingData contentSettings fontSettings gcm pageCapture tabCapture desktopCapture readingList search power userScripts declarativeNetRequest'.split(' ');
for (const ns of NEEDS) {
  if (declared.has(ns) || (ns === 'declarativeNetRequest' && declared.has('declarativeNetRequestWithHostAccess'))) continue;
  const hit = CODE.map(([f, t]) => [f, t, t.search(new RegExp(`\\b(?:chrome|browser)\\s*(?:\\?\\.|\\.)\\s*${ns}\\s*(?:\\?\\.|\\.)\\s*\\w+`))]).find(([, , i]) => i >= 0);
  if (hit) block('missing-permission', `${at(hit[0], hit[1], hit[2])}: uses chrome.${ns} but "${ns}" is not in permissions (chrome.${ns} is undefined without it)`);
}
const BROAD = /^(<all_urls>|(\*|https?|wss?):\/\/\*\/.*|\*:\/\/\*)$/;
const hostPats = [...(m?.host_permissions || []).map(p => ['host_permissions', p]), ...(m?.content_scripts || []).flatMap(cs => (cs.matches || []).map(p => ['content_scripts', p]))];
const broad = [...new Set(hostPats.filter(([, p]) => BROAD.test(p)).map(([w, p]) => `${p} (${w})`))];
const SENSITIVE = ['debugger', 'cookies', 'history', 'webRequest', 'management', 'proxy', 'nativeMessaging', 'privacy', 'browsingData', 'tabCapture', 'desktopCapture', 'userScripts', 'webNavigation', 'topSites', 'pageCapture', 'clipboardRead', 'declarativeNetRequestWithHostAccess'].filter(p => declared.has(p));
if (broad.length) warn('broad-host', `broad host access: ${broad.join(', ')}. Review takes longer and reviewers ask why you need every site; use specific hosts, activeTab, or optional_host_permissions if you can`);
if (SENSITIVE.length) warn('sensitive-permission', `sensitive permissions slow down review: ${SENSITIVE.join(', ')}. Each needs a clear justification`);
const local = (m?.host_permissions || []).filter(p => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(p));
if (local.length) warn('localhost-host', `host_permissions include ${local.join(', ')}. Fine for a local server feature (e.g. Ollama), but remove it if it is a dev leftover`);
const injects = ['scripting', 'webRequest', 'declarativeNetRequest', 'cookies', 'webNavigation', 'debugger', 'proxy'].some(ns => api(ns).length) || declared.has('declarativeNetRequestWithHostAccess');
const csHosts = new Set((m?.content_scripts || []).flatMap(cs => cs.matches || []));
const allText = [...TEXT.values()].join('\n').toLowerCase();
if (!injects) for (const p of m?.host_permissions || []) {
  const host = p.match(/^[^:]+:\/\/([^/]+)\//)?.[1]?.replace(/^\*\./, '').replace(/:\d+$/, '').toLowerCase();
  if (!host || host === '*' || BROAD.test(p) || csHosts.has(p)) continue;
  if (!allText.includes(host) && !allText.includes(host.replace(/^www\./, '')) && ![...csHosts].some(c => c.toLowerCase().includes(host))) unusedLevel('unused-host', `host permission "${p}" looks unused: no content script runs there and no shipped file mentions ${host}. Remove it, or say in the justification how the URL is built at runtime`, aliasedChrome ? undefined : 'Purple Potassium');
}
if (m?.action?.default_popup && api('action.onClicked').length) warn('onclicked-with-popup', 'chrome.action.onClicked never fires while action.default_popup is set');

// ---------- package contents ----------
const ship = all.filter(f => f === 'manifest.json' || (referenced.has(f) && !SECRET.test(f)) || !isLeftOut(f));
for (const f of referenced) if (!all.includes(f)) { ship.push(f); warn('ships-skipped-dir', `${f} is loaded by the extension, so it is packaged even though ${f.split('/')[0]}/ is otherwise left out. Copying it into your own folder is cleaner`); }
const shipSet = new Set(ship), leftOut = [...skippedDirs, ...all.filter(f => !shipSet.has(f))];
for (const f of all.filter(f => SECRET.test(f))) (fromZip ? block : warn)('secret-file', fromZip ? `${f} is inside the zip. It holds secrets/keys; anyone who installs the extension can read it` : `${f} holds secrets/keys. It is kept out of the zip; never zip this folder by hand`);
if (fromZip) {
  for (const d of skippedDirs) warn('junk-in-zip', `${d} is inside the zip; it isn't needed at runtime`);
  const junk = all.filter(f => JUNK.test(f) || DEV.test(f)); if (junk.length) warn('junk-in-zip', `${junk.length} dev/junk file(s) in the zip: ${junk.slice(0, 6).join(', ')}${junk.length > 6 ? ' …' : ''}`);
}
for (const n of ls(root) || []) if (n.startsWith('_') && !['_locales', '_metadata', '__MACOSX'].includes(n)) warn('underscore-name', `"${n}" starts with "_": Chrome warns "Filenames starting with "_" are reserved for use by the system". Rename it`);
// dead weight: folders and scripts nothing at runtime loads (only text from loaded files and the manifest counts)
const reach = new Set(['manifest.json']);
for (const q = ['manifest.json']; q.length;) { const f = q.pop(); for (const [a, b] of edges) if (a === f && !reach.has(b)) { reach.add(b); q.push(b); } }
const runtimeText = [raw, ...[...TEXT].filter(([f]) => reach.has(f)).map(([, t]) => t)].join('\n').toLowerCase();
const topDirs = [...new Set(ship.filter(f => f.includes('/')).map(f => f.split('/')[0]))].filter(d => d !== '_locales');
const pathMention = d => new RegExp(`["'\`(/]${d.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(runtimeText); // "icons/x", './utils/', not "see tools/x" in a comment
const idle = topDirs.filter(d => !ship.some(f => reach.has(f) && f.startsWith(d + '/')) && !pathMention(d));
const inIdle = f => f && idle.some(d => f.startsWith(d + '/'));
const hidden = F.filter(x => inIdle(x.file) && !/^(secret|remote-|eval|new-function|string-timer|obfuscated)/.test(x.id));
for (const x of hidden) F.splice(F.indexOf(x), 1); // functional nits inside never-loaded folders are noise; security findings stay
if (idle.length) warn('unreferenced-dir', `found nothing that loads ${idle.map(d => `${d}/ (${ship.filter(f => f.startsWith(d + '/')).length} files)`).join(', ')}, but it ships to every user${hidden.length ? ` (${hidden.length} minor finding(s) inside hidden)` : ''}. Leave it out of the build or package dist/`);
const deadJs = ship.filter(f => /\.(m?js|cjs)$/i.test(f) && !inIdle(f) && !reach.has(f) && !runtimeText.includes(path.posix.basename(f).toLowerCase()));
if (deadJs.length) warn('unreferenced-js', `found nothing that loads ${deadJs.slice(0, 5).join(', ')}${deadJs.length > 5 ? ` and ${deadJs.length - 5} more` : ''}. Reviewers read every shipped script, so leave out build/dev scripts (ignore this for webpack chunks or files loaded by a computed name)`);
const total = ship.reduce((s, f) => s + size(f), 0);
if (total > 2 * 1024 ** 3) block('size', `package is ${KB(total)}; the Chrome Web Store limit is 2 GB`);
// a stale build: the source next to dist/ changed after it was built
if (!fromZip && root !== input && hasManifest(input)) {
  try { const src = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json'), 'utf8').replace(/^﻿/, '')); if (src.version && m?.version && src.version !== m.version) warn('stale-dist', `${path.relative(input, root)}/manifest.json is version ${m.version} but the source manifest is ${src.version}; rebuild?`); } catch {}
  const newer = ship.filter(f => fs.existsSync(path.join(input, f)) && fs.statSync(path.join(input, f)).mtimeMs > fs.statSync(path.join(root, f)).mtimeMs + 2000);
  if (newer.length) warn('stale-dist', `${newer.length} source file(s) changed after ${path.relative(input, root)}/ was built (${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ' …' : ''}); rebuild before packaging`);
}

// ---------- dashboard drafts (Privacy practices tab) ----------
const WHY = {
  storage: "Saves the user's settings and results locally with chrome.storage", unlimitedStorage: 'Stores more local data than the default 10 MB chrome.storage.local quota allows ([what: cached results, history])',
  alarms: 'Runs scheduled background tasks with chrome.alarms ([what runs, and when])', scripting: "Injects the extension's own bundled script into the page the user is working on, when they use the extension",
  activeTab: 'Gets temporary access to the current tab only when the user clicks the extension, instead of access to every site', tabs: 'Reads the URL and title of open tabs to [find the tab the extension works with]',
  downloads: 'Saves files the user exports ([CSV/...]) to their Downloads folder', notifications: 'Tells the user when [a long-running task] finishes', sidePanel: "Shows the extension's interface in Chrome's side panel",
  contextMenus: "Adds the extension's actions to the right-click menu", cookies: 'Reads the [site] session cookie to [...]', offscreen: "Uses an offscreen document for work the service worker can't do ([DOM parsing/audio/clipboard])",
  declarativeNetRequest: 'Blocks or changes network requests with declarative rules the user can see ([what is blocked])', webNavigation: 'Detects page navigations on [site] to [...]', webRequest: 'Observes requests to [site] to [...]',
  identity: 'Signs the user in with their Google account (chrome.identity)', clipboardWrite: 'Copies results to the clipboard when the user clicks Copy', clipboardRead: 'Reads the clipboard when the user clicks Paste',
  history: 'Reads browsing history to [user-facing feature]', bookmarks: 'Reads and edits bookmarks to [user-facing feature]', idle: 'Pauses [work] while the user is away', tabGroups: 'Creates and edits tab groups when the user asks',
};
const drafts = { singlePurpose: msg(m?.description) || '[one sentence: the single thing this extension does]', permissions: {}, remoteCode: remoteCode ? 'Yes: remove the remote code flagged above first.' : `No, I am not using Remote code. All JavaScript is in the package.${F.some(f => /^(eval|new-function|string-timer)$/.test(f.id)) ? ' (Only true if the eval/new Function calls listed above run strings shipped in the package.)' : ''}` };
for (const [p] of perms) if (typeof p === 'string' && KNOWN.has(p)) { const files = usedBy(p).filter(f => !f.startsWith('(') && f !== 'manifest'); drafts.permissions[p] = `${WHY[p] || `Used for [user-facing feature] (chrome.${p})`}${files.length ? ` (${files.slice(0, 3).join(', ')})` : ''}.`; }
const hp = m?.host_permissions || [];
if (hp.length) {
  const onPages = hp.filter(p => csHosts.has(p)), apis = hp.filter(p => !csHosts.has(p));
  drafts.permissions['Host permission'] = [onPages.length && `Runs on ${onPages.join(', ')} to [what it reads or changes on those pages].`, apis.length && `Accesses ${apis.join(', ')} to [what it reads or changes there, or what it requests from it].`, 'It does not access any other site.'].filter(Boolean).join(' ');
}
const external = [...hosts].filter(([h, f]) => !inIdle(f) && !/^(localhost|127\.0\.0\.1)$/.test(h)).map(([h]) => h);

// ---------- report ----------
const order = { block: 0, reject: 1, warn: 2 };
const seen = new Set(), findings = F.filter(f => !seen.has(f.level + f.msg) && seen.add(f.level + f.msg)).sort((a, b) => order[a.level] - order[b.level]);
const nBlock = findings.filter(f => f.level === 'block').length;
const result = { root: rootLabel, manifest: m && { name: msg(m.name), version: m.version, manifest_version: m.manifest_version }, files: ship.length, bytes: total, notes, findings, leftOut, drafts, externalHosts: external };
let zipInfo = null;
if (zipOut && !nBlock) zipInfo = writeZip(path.resolve(zipOut));
if (JSON_OUT) { console.log(JSON.stringify({ ...result, zip: zipInfo }, null, 2)); cleanup(); process.exit(nBlock ? 1 : 0); }

console.log(`\n${rootLabel}: ${m ? `"${msg(m.name)}" ${m.version}, MV${m.manifest_version}, ` : ''}${fromZip ? `${all.length} files in the zip, ${KB(fs.statSync(input).size)}` : `${ship.length} files, ${KB(total)}`}`);
for (const n of notes) console.log('  ' + n);
const sections = [['block', '✘', 'BLOCKING: the store refuses it, or Chrome won\'t load it / a declared part won\'t work'], ['reject', '▲', 'LIKELY REJECTION: matches a documented review violation [code name]'], ['warn', '!', 'WARNINGS']];
for (const [lv, sym, title] of sections) { const g = findings.filter(f => f.level === lv); if (!g.length) continue; console.log(`\n${title}`); for (const f of g) console.log(`  ${sym} ${f.msg}`); }
if (!findings.length) console.log('  ✓ no problems found');
if (leftOut.length && !fromZip) console.log(`\nLeft out of the zip (${leftOut.length}): ${leftOut.slice(0, 12).join(', ')}${leftOut.length > 12 ? ' …' : ''}`);
if (m) {
  console.log('\nDashboard drafts (Privacy practices tab). Fill in the [brackets]; vague text gets rejected:');
  console.log(`  Single purpose: ${drafts.singlePurpose}`);
  for (const [p, t] of Object.entries(drafts.permissions)) console.log(`  ${p} justification: ${t}`);
  console.log(`  Remote code: ${drafts.remoteCode}`);
  if (external.length) console.log(`  Data usage: the code references ${external.slice(0, 8).join(', ')}${external.length > 8 ? ' …' : ''}. If any user data goes there, declare it and link a privacy policy [Purple Lithium].`);
}
if (zipInfo) console.log(`\n✓ wrote ${zipInfo.path} (${KB(zipInfo.bytes)}, ${zipInfo.entries} files, read back and CRC-checked; manifest.json at the root). Store limit: 2 GB.`);
if (nBlock) console.log(`\n${nBlock} blocking problem(s).${zipOut ? ' No zip written.' : ''} Fix them and run again.`);
else if (!zipOut && !fromZip) console.log(`\nAdd --zip <out.zip> to build the upload zip (estimated ${KB(estimate())}).`);
cleanup();
process.exit(nBlock ? 1 : 0);

function cleanup() { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
function estimate() { return ship.reduce((s, f) => s + (STORED.test(f) ? size(f) : zlib.deflateRawSync(fs.readFileSync(path.join(root, f))).length) + 76 + 2 * f.length, 22); }

// ---------- zip writer: STORE for already-compressed media, DEFLATE for the rest ----------
function writeZip(out) {
  const outRel = path.relative(root, out);
  if (!outRel.startsWith('..') && !path.isAbsolute(outRel)) { console.error('--zip must be outside the extension folder'); cleanup(); process.exit(1); }
  const files = ['manifest.json', ...ship.filter(f => f !== 'manifest.json').sort()], parts = [], cd = [];
  let off = 0;
  for (const f of files) {
    const data = fs.readFileSync(path.join(root, f)), name = Buffer.from(f), store = STORED.test(f), body = store ? data : zlib.deflateRawSync(data, { level: 9 });
    const d = fs.statSync(path.join(root, f)).mtime, time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = Math.max(0, d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate();
    const h = Buffer.alloc(46); // central header; the local header is the same fields shifted
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(store ? 0 : 8, 10); h.writeUInt16LE(time, 12); h.writeUInt16LE(date, 14);
    h.writeUInt32LE(zlib.crc32(data) >>> 0, 16); h.writeUInt32LE(body.length, 20); h.writeUInt32LE(data.length, 24); h.writeUInt16LE(name.length, 28); h.writeUInt32LE(off, 42);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); h.copy(l, 4, 6, 30); // version needed .. name length
    parts.push(l, name, body); cd.push(h, name); off += 30 + name.length + body.length;
  }
  const c = Buffer.concat(cd), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(c.length, 12); e.writeUInt32LE(off, 16);
  const buf = Buffer.concat([...parts, c, e]);
  const back = readZip(buf); // verify before writing: every entry inflates, CRCs match, manifest.json at the root
  if (back.length !== files.length || !back.some(x => x.name === 'manifest.json')) throw new Error('zip verification failed');
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, buf);
  return { path: out, bytes: buf.length, entries: files.length };
}
