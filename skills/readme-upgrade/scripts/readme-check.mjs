#!/usr/bin/env node
// readme-check — audit a repo's README and check that its commands, links and images are real. Zero deps. Node 22+.
//
//   node readme-check.mjs [path]              path = repo folder or README file (default: .)
//   node readme-check.mjs [path] --run        also run the SAFE README commands in a temporary copy of the repo
//   node readme-check.mjs [path] --run --timeout 120   per-command timeout in seconds (default 120)
//   node readme-check.mjs [path] --offline    skip http(s) link and badge checks
//   node readme-check.mjs [path] --keep       keep the temporary copy after --run
//
// Read-only on the repo. --run executes only allowlisted commands, in a copy, never in the repo itself.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- args ----------
const argv = process.argv.slice(2), opt = { timeout: 120 };
let target = '.';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--run') opt.run = true; else if (a === '--offline') opt.offline = true; else if (a === '--keep') opt.keep = true;
  else if (a === '--timeout') opt.timeout = Number(argv[++i]) || 120;
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
  else target = a;
}
let readme, root;
{
  const t = path.resolve(target);
  if (!fs.existsSync(t)) { console.error(`not found: ${t}`); process.exit(2); }
  if (fs.statSync(t).isFile()) { readme = t; root = path.dirname(t); }
  else { root = t; const f = fs.readdirSync(t).find(n => /^readme(\.(md|markdown|mdx))?$/i.test(n)); readme = f ? path.join(t, f) : null; }
}
const findings = []; const add = (sev, msg, line) => findings.push({ sev, msg, line });
const rel = p => path.relative(root, p).split(path.sep).join('/') || '.';
if (!readme) { console.log(`readme-check: ${root}\n✘ [high] no README.md found`); process.exit(1); }

const raw = fs.readFileSync(readme, 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n');

// ---------- markdown structure ----------
// mask fenced code (keep line numbers) so links/headings inside code are ignored
const blocks = []; // {lang, start, body[]}
const masked = [...lines];
for (let i = 0, open = null; i < lines.length; i++) {
  const m = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/);
  if (open) { if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length && !m[2]) { blocks.push(open); open = null; } else open.body.push({ text: lines[i], line: i + 1 }); masked[i] = ''; continue; }
  if (m) { open = { fence: m[1], lang: m[2].toLowerCase(), start: i + 1, body: [] }; masked[i] = ''; }
}
const textNoCode = masked.map(l => l.replace(/`[^`\n]*`/g, '``'));
const headings = [];
for (let i = 0; i < masked.length; i++) {
  let m = masked[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (m) { headings.push({ level: m[1].length, text: m[2], line: i + 1 }); continue; }
  if (i > 0 && /^\s{0,3}(=+|-+)\s*$/.test(masked[i]) && masked[i - 1].trim() && !/^\s*([-*+]|\d+\.|\||>)/.test(masked[i - 1]))
    headings.push({ level: masked[i].trim()[0] === '=' ? 1 : 2, text: masked[i - 1].trim(), line: i });
  m = masked[i].match(/<h([1-6])[^>]*>(.*?)<\/h\1>/i);
  if (m) headings.push({ level: +m[1], text: m[2], line: i + 1, html: true });
}
// GitHub-style slugs
const plain = s => s.replace(/<[^>]+>/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(^|\W)[*_](\S.*?\S|\S)[*_](?=\W|$)/g, '$1$2').replace(/~~(.*?)~~/g, '$1');
const slugify = s => plain(s).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
function anchorsOf(mdLines, hs) {
  const set = new Set(), count = new Map();
  for (const h of hs) { const b = slugify(h.text); const n = count.get(b) || 0; count.set(b, n + 1); set.add(n ? `${b}-${n}` : b); }
  for (const l of mdLines) for (const m of l.matchAll(/<a\s[^>]*(?:name|id)=["']([^"']+)["']|\sid=["']([^"']+)["']/gi)) set.add(m[1] || m[2]);
  return set;
}
const anchors = anchorsOf(lines, headings);
const anchorCache = new Map();
function anchorsOfFile(f) {
  if (!anchorCache.has(f)) {
    const ls = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/^(`{3,}|~{3,})[\s\S]*?^\1/gm, '').split('\n');
    anchorCache.set(f, anchorsOf(ls, ls.map((l, i) => { const m = l.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/); return m && { text: m[1], line: i + 1 }; }).filter(Boolean)));
  }
  return anchorCache.get(f);
}

// ---------- title + description ----------
const isBadgeLine = l => /^\s*(\[?!\[[^\]]*\]\([^)]*\)\]?(\([^)]*\))?\s*)+$/.test(l) || /^\s*(<a [^>]*>\s*)?<img [^>]*>(\s*<\/a>)?\s*$/i.test(l);
const firstH = headings[0];
const contentStart = lines.findIndex(l => l.trim() && !/^\s*<!--.*-->\s*$/.test(l) && !isBadgeLine(l) && !/^\s*<\/?(p|div|picture|source|br)\b[^>]*>\s*$/i.test(l));
// an HTML <h1> near the top (common in designed READMEs: <h1 align="center"><img alt="…"></h1>) counts as the title
const htmlH1 = lines.slice(0, 15).some(l => /<h1\b/i.test(l));
if (!htmlH1 && (!firstH || firstH.level !== 1 || firstH.line > Math.max(contentStart + 3, 12))) add('medium', firstH ? `the first heading (line ${firstH.line}) is not a level-1 title near the top: start with "# Project name"` : 'no title: start the README with "# Project name"');
{
  const from = firstH ? firstH.line : 0, nextH = headings[1]?.line ?? lines.length + 1;
  let desc = null;
  for (let i = from; i < Math.min(nextH - 1, from + 20, lines.length); i++) {
    const l = masked[i].trim();
    if (!l || isBadgeLine(l) || /^(#|<!--|\||[-=]+$)/.test(l) || /^<\/?\w+[^>]*>$/.test(l)) continue;
    const t = plain(l).replace(/<[^>]+>/g, '').trim();
    if (t.length >= 20) { desc = t; break; }
  }
  if (!desc) add('medium', 'no one-line description under the title: add a sentence saying what it is and who it is for');
}

// ---------- sections ----------
const H = re => headings.find(h => re.test(plain(h.text)));
const hasInstall = H(/install|setup|set up|getting started|requirements|download/i);
const hasUsage = H(/usage|quick\s*start|getting started|examples?|how to (use|run)|run(ning)?\b|commands|cli\b|tutorial/i);
const hasLicense = H(/licen[cs]e/i);
if (!hasInstall) add('medium', 'no Install / Setup section: say how to get it running (requirements + exact commands)');
if (!hasUsage) add('medium', 'no Usage / Quick start section: show the smallest working example');
const LICENSE_FILES = fs.readdirSync(root).filter(n => /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i.test(n));
const licType = t => {
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return /Version 2/i.test(t) ? 'GPL-2.0' : 'GPL-3.0';
  if (/Apache License,?\s+Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Mozilla Public License,?\s+(v\.|version)\s*2\.0/i.test(t)) return 'MPL-2.0';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(t)) return /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  return null;
};
const normLic = s => s.toUpperCase().replace(/[\s_-]+/g, '').replace(/LICENSE$/, '').replace(/^(GPL|AGPL|LGPL)V?(\d)(\.0)?$/, '$1$2').replace(/\.0$/, '').replace(/^APACHE2$/, 'APACHE2').replace(/CLAUSE$/, '');
const fileLic = LICENSE_FILES.length ? licType(fs.readFileSync(path.join(root, LICENSE_FILES[0]), 'utf8')) : null;
let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
{
  const mentions = new Set();
  for (const m of raw.matchAll(/(?:img\.shields\.io\/badge\/licen[cs]e-|badgen\.net\/badge\/licen[cs]e\/)([A-Za-z0-9.%+]+?)(?:-[a-z]+)?(?:\.svg)?(?=[)"'\s?])/gi)) mentions.add(decodeURIComponent(m[1]).replace(/--/g, '-'));
  for (const m of raw.matchAll(/\b(MIT|Apache[- ]2\.0|GPL-?[23](?:\.0)?|AGPL-?3(?:\.0)?|LGPL|MPL-?2\.0|BSD-[23]-Clause|ISC|Unlicense)\b(?=[^\n]{0,20}licen[cs]e|)/g)) { const ctx = raw.slice(Math.max(0, m.index - 40), m.index + 40); if (/licen[cs]e/i.test(ctx)) mentions.add(m[1]); }
  if (!hasLicense) add('medium', `no License section${LICENSE_FILES.length ? ` (there is a ${LICENSE_FILES[0]} file: add "## License" with one line naming it)` : ''}`);
  if (!LICENSE_FILES.length) add(mentions.size ? 'high' : 'medium', mentions.size ? `README mentions ${[...mentions].join('/')} but there is no LICENSE file: without one, the code is "all rights reserved"` : 'no LICENSE file: without one, nobody may legally reuse the code');
  else if (fileLic) {
    const bad = [...mentions].filter(m => normLic(m) !== normLic(fileLic));
    if (bad.length) add('high', `README says ${bad.join('/')} but ${LICENSE_FILES[0]} is ${fileLic}`);
    if (pkg?.license && normLic(pkg.license) !== normLic(fileLic)) add('medium', `package.json "license": "${pkg.license}" but ${LICENSE_FILES[0]} is ${fileLic}`);
  }
}

// ---------- links + images ----------
const links = []; // {url, line, image, badge}
for (let i = 0; i < textNoCode.length; i++) {
  const l = textNoCode[i];
  for (const m of l.matchAll(/(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+["'(][^)]*["')])?\s*\)/g)) links.push({ url: m[3], line: i + 1, image: m[1] === '!', inner: m[2] });
  for (const m of l.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/g)) links.push({ url: m[2], line: i + 1, image: false, ref: m[1] });
  for (const m of l.matchAll(/<(a|img|source)\s[^>]*?(href|src|srcset)=["']([^"']+)["']/gi)) links.push({ url: m[3].split(/\s/)[0], line: i + 1, image: m[1].toLowerCase() !== 'a' });
}
// nested badge: [![x](img)](link) — the regex above caught the outer link; catch inner images too
for (const L of [...links]) if (L.inner) for (const m of L.inner.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)/g)) links.push({ url: m[1], line: L.line, image: true });
const isBadge = u => /shields\.io|badgen\.net|badge\.fury\.io|\/badge(\.svg)?(\?|$)|\/badges?\/|codecov\.io\/.*graph|travis-ci|circleci\.com\/.*svg|github\.com\/.*\/actions\/workflows\/.*\.svg|coveralls\.io\/repos/i.test(u);
const existsExact = p => { // GitHub is case-sensitive even when this filesystem is not
  if (!fs.existsSync(p)) return false;
  const parts = path.relative(root, p).split(path.sep).filter(Boolean); let d = root;
  for (const part of parts) { if (part === '..') { d = path.dirname(d); continue; } let names; try { names = fs.readdirSync(d); } catch { return true; } if (!names.includes(part)) return { wrongCase: names.find(n => n.toLowerCase() === part.toLowerCase()) }; d = path.join(d, part); }
  return true;
};
const remote = [];
let relCount = 0, imgCount = 0;
for (const L of links) {
  const u = L.url.trim();
  if (L.image && !isBadge(u)) imgCount++;
  if (/^(mailto|tel|data|javascript):/i.test(u)) continue;
  if (/^https?:\/\//i.test(u)) { remote.push(L); continue; }
  if (/^\/\//.test(u) || /^[a-z][\w+.-]*:/i.test(u)) continue;
  relCount++;
  const [pth, anchor] = u.split('#'); const p0 = decodeURIComponent(pth.split('?')[0]);
  if (!p0) { if (anchor !== undefined && !anchors.has(decodeURIComponent(anchor).toLowerCase()) && !anchors.has(decodeURIComponent(anchor))) add('medium', `#${anchor} points to no heading in this README${nearest(anchor)}`, L.line); continue; }
  const abs = p0.startsWith('/') ? path.join(root, p0) : path.resolve(path.dirname(readme), p0);
  const ex = existsExact(abs);
  if (!ex) { add('high', `${L.image ? 'image' : 'link'} ${p0} does not exist`, L.line); continue; }
  if (ex.wrongCase) { add('high', `${p0}: wrong letter case (on disk: ${ex.wrongCase}). Works on Windows/macOS, broken on GitHub`, L.line); continue; }
  if (anchor && /\.(md|markdown)$/i.test(abs) && fs.statSync(abs).isFile() && !anchorsOfFile(abs).has(decodeURIComponent(anchor).toLowerCase())) add('medium', `${p0}#${anchor}: no such heading in that file`, L.line);
}
function nearest(a) {
  const lev = (x, y) => { const d = Array.from({ length: x.length + 1 }, (_, i) => [i]); for (let j = 1; j <= y.length; j++) d[0][j] = j; for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); return d[x.length][y.length]; };
  const t = decodeURIComponent(a).toLowerCase(); let best = null, bd = 4;
  for (const x of anchors) { const dd = x.includes(t) || t.includes(x) ? 1 : lev(t, x); if (dd < bd) { bd = dd; best = x; } }
  return best ? ` (did you mean #${best}?)` : '';
}

// ---------- commands in code blocks ----------
const SHELL = /^(bash|sh|shell|console|zsh|shell-session|sh-session|powershell|ps1|pwsh|ps|cmd|bat|fish|terminal)$/;
const commands = []; // {cmd, line, lang}
for (const b of blocks) {
  const shell = SHELL.test(b.lang), consoleish = /console|session|terminal/.test(b.lang);
  if (!shell && b.lang) continue;
  let buf = '', startLine = 0;
  for (const { text, line } of b.body) {
    let t = text.trim();
    const prompt = t.match(/^(\$|PS[^>]*>|>|%|C:\\[^>]*>)\s+/);
    if (prompt) t = t.slice(prompt[0].length);
    else if (buf) { /* continuation */ }
    else if (consoleish || !shell) continue; // output lines / untagged blocks: only "$ " lines count
    if (!buf && (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith('REM '))) continue;
    if (!buf) startLine = line;
    if (/(\\|`|\^)$/.test(t) && !/^#/.test(t)) { buf += t.slice(0, -1).trimEnd() + ' '; continue; }
    buf += t; commands.push({ cmd: buf.replace(/\s+#\s.*$/, '').trim(), line: startLine, block: b.start }); buf = '';
  }
}
const PLACEHOLDER = /<(?:your|my)[-_ ][^>]*>|<[A-Z][A-Z0-9_]{2,}>|\b(?:YOUR|MY)_[A-Z0-9_]+\b|\bx{3,}\b|\bX{3,}\b|\bREPLACE[_-]?ME\b|\bCHANGE[_-]?ME\b|<(?:token|api[-_ ]?key|username|password|secret|repo|org|owner|name)>|\byour-(?:api-)?(?:key|token|username|user|repo|project|org|domain|site|app|server|host|bucket|email|password|name)\b/i;
const NPM_BUILTIN = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'exec', 'x', 'dlx', 'create', 'init', 'publish', 'link', 'unlink', 'why', 'outdated', 'list', 'ls', 'll', 'audit', 'config', 'global', 'store', 'info', 'view', 'workspace', 'workspaces', 'set', 'version', 'pack', 'rebuild', 'prune', 'import', 'licenses', 'patch', 'dedupe', 'bin', 'root', 'cache', 'env', 'setup', 'help', 'login', 'logout', 'whoami', 'search', 'doctor', 'fund', 'explain', 'npx', 'self-update', 'plugin', 'constraints', 'dlx', 'node', 'tag', 'owner', 'deprecate', 'restart', 'stop', 'pkg', 'query', 'sbom', 'ping', 'prefix', 'completion', 'shrinkwrap', 'star', 'unstar', 'team', 'token', 'access', 'hook', 'org', 'profile', 'repo', 'docs', 'home', 'bugs', 'edit', 'explore', 'diff', 'test', 't', 'start', 'run', 'run-script', 'rb']);
const LONG_RUNNING = /^(dev|start|serve|server|watch|preview|develop|storybook|start:.*|dev:.*|watch:.*|serve:.*)$/;
function pkgAt(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } }
// split "a && b; c" into segments (outside quotes)
function segments(cmd) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) { out.push({ s: cur.trim(), op: ch + ch }); cur = ''; i++; continue; }
    if (ch === ';') { out.push({ s: cur.trim(), op: ';' }); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push({ s: cur.trim(), op: null });
  return out.filter(x => x.s);
}
const words = s => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
// static checks, tracking cd within a block; git clone <url> [dir] maps dir → root
const cloned = new Set();
let blockCwd = new Map();
const scriptIssues = new Set(), fileIssues = new Set(), movedIssues = new Set(), placeholderIssues = new Set();
const made = new Set(); // folders created by mkdir earlier in the README
let allFiles = null;
function findByName(f) { // same file somewhere else in the repo (README meant to be run from a subfolder)
  if (!allFiles) {
    allFiles = [];
    (function walk(d, depth) {
      if (depth > 8 || allFiles.length > 20000) return; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { if (/^(node_modules|\.git|\.venv|venv|dist|build|target|__pycache__)$/.test(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else allFiles.push(p); }
    })(root, 0);
  }
  const tail = f.replace(/^\.[\\/]/, '').split(/[\\/]/).join(path.sep);
  return allFiles.filter(p => p.endsWith(path.sep + tail)).map(rel);
}
for (const c of commands) {
  let cwd = blockCwd.has(c.block) ? blockCwd.get(c.block) : root;
  if (PLACEHOLDER.test(c.cmd)) placeholderIssues.add(`line ${c.line}: ${c.cmd.match(PLACEHOLDER)[0]}`);
  for (const { s } of segments(c.cmd)) {
    const w = words(s); if (!w.length) continue;
    const [cmd0, a1, a2] = w; const tool = cmd0.toLowerCase().replace(/\.(cmd|exe)$/, '');
    if (tool === 'git' && a1 === 'clone' && a2) { const d = w[3] && !w[3].startsWith('-') ? w[3] : path.basename(a2.replace(/\.git$/, '').replace(/\/$/, '')); cloned.add(d); continue; }
    if (tool === 'cd' || tool === 'set-location' || tool === 'pushd') {
      const d = w.slice(1).find(x => !x.startsWith('-'));
      if (!d) { cwd = null; continue; }
      if (cwd && cloned.has(d.replace(/\/$/, ''))) { cwd = root; continue; }
      if (cwd === null || /[$~%<]/.test(d) || path.isAbsolute(d)) { cwd = null; continue; }
      const nd = path.resolve(cwd, d);
      if (!fs.existsSync(nd) && !made.has(nd) && !/^(build|dist|out|tmp|\.\.)$/.test(d)) fileIssues.add(`line ${c.line}: \`${s}\`: there is no ${rel(nd)} folder (build output? say which command creates it)`);
      cwd = fs.existsSync(nd) ? nd : null; continue;
    }
    if (tool === 'mkdir' || tool === 'md' || tool === 'new-item') { for (const x of w.slice(1)) if (!x.startsWith('-') && cwd) made.add(path.resolve(cwd, x)); continue;
    }
    if (!cwd) continue; // unknown directory: can't verify
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(tool)) {
      let script = null;
      if (a1 === 'run' || a1 === 'run-script') script = a2;
      else if (tool === 'npm' && (a1 === 'test' || a1 === 't' || a1 === 'start')) script = a1 === 't' ? 'test' : a1;
      else if (tool !== 'npm' && a1 && !a1.startsWith('-') && !NPM_BUILTIN.has(a1)) script = a1;
      else if (tool !== 'npm' && (a1 === 'test' || a1 === 'start')) script = a1;
      if (script && !script.startsWith('-')) {
        const p = pkgAt(cwd);
        if (!p) scriptIssues.add(`line ${c.line}: \`${s}\` but there is no package.json in ${rel(cwd)}`);
        else if (!(p.scripts && script in p.scripts) && !(script === 'start' && fs.existsSync(path.join(cwd, 'server.js')))) scriptIssues.add(`line ${c.line}: \`${s}\`: no "${script}" script in ${rel(path.join(cwd, 'package.json'))}${p.scripts ? ` (has: ${Object.keys(p.scripts).join(', ') || 'none'})` : ''}`);
      }
      continue;
    }
    const RUNNERS = { node: /\.(m?js|cjs|ts|mts)$/, deno: /\.(m?js|ts|tsx)$/, tsx: /\.(m?ts|tsx|m?js)$/, 'ts-node': /\.ts$/, python: /\.py$/, python3: /\.py$/, py: /\.py$/, bash: /\.sh$/, sh: /\.sh$/, zsh: /\.sh$/, pwsh: /\.ps1$/, powershell: /\.ps1$/, ruby: /\.rb$/, php: /\.php$/, go: /\.go$/ };
    let file = null;
    if (RUNNERS[tool]) file = w.slice(1).filter(x => !x.startsWith('-') && x !== 'run').find(x => RUNNERS[tool].test(x));
    else if (/^\.{1,2}[\\/]/.test(cmd0)) file = cmd0;
    if (file && !/[$~%<>*{}]/.test(file) && !path.isAbsolute(file) && !fs.existsSync(path.resolve(cwd, file))) { const elsewhere = findByName(file); (elsewhere.length ? movedIssues : fileIssues).add(`line ${c.line}: \`${s}\`: ${file} is not in ${rel(cwd) === '.' ? 'the repo root' : rel(cwd)}${elsewhere.length ? ` (found at ${elsewhere.slice(0, 2).join(', ')}${elsewhere.length > 2 ? ' …' : ''}): say which folder to run it from, or use the path from the repo root` : ''}`); }
  }
  blockCwd.set(c.block, cwd);
}
for (const s of scriptIssues) add('high', `command runs a missing package.json script — ${s}`);
for (const s of fileIssues) add('high', `command references a missing file — ${s}`);
for (const s of movedIssues) add('low', `command assumes a different folder — ${s}`);
if (placeholderIssues.size) add('low', `${placeholderIssues.size} command(s) contain placeholders the reader must replace (${[...placeholderIssues].slice(0, 4).join('; ')}${placeholderIssues.size > 4 ? '; …' : ''}). Say right above the block what to put there and where to get it`);
for (const { text, line } of blocks.flatMap(b => b.body)) if (/\bsudo\s+(npm|pip|yarn|pnpm)\b|curl[^|\n]*\|\s*(sudo\s+)?(ba)?sh\b|wget[^|\n]*\|\s*(sudo\s+)?(ba)?sh\b|\biwr\b.*\|\s*iex\b/i.test(text)) add('low', `${text.trim().slice(0, 80)} — pipe-to-shell / sudo install; offer a version readers can inspect first`, line);

// ---------- suggestions ----------
const hasToc = headings.some(h => /contents|table of contents|toc\b/i.test(plain(h.text))) || /<!--\s*toc\s*-->|\[\[_?TOC_?\]\]/i.test(raw) || lines.filter(l => /^\s*[-*+]\s*\[[^\]]+\]\(#/.test(l)).length >= 3;
if (lines.length > 300 && !hasToc) add('info', `${lines.length} lines and no table of contents: add one after the intro (a list of links to the ## sections)`);
{
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const ui = Object.keys(deps).find(d => /^(react|react-dom|vue|svelte|@sveltejs\/kit|next|nuxt|@angular\/core|vite|electron|astro|solid-js|preact|phaser|three|expo|react-native|tauri|@tauri-apps\/api)$/.test(d))
    || (fs.existsSync(path.join(root, 'index.html')) && 'index.html')
    || (() => { try { const r = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8'); return (r.match(/^(streamlit|gradio|flask|django|pygame|tkinter|PyQt\d|kivy|dash)\b/im) || [])[1]; } catch { return null; } })();
  if (ui && !imgCount) add('info', `looks like a UI project (${ui}) but the README has no screenshot or GIF: one image near the top shows what it does faster than a paragraph`);
}

// ---------- remote links (network) ----------
const BOT_BLOCKERS = /(^|\.)(linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|medium\.com|reddit\.com|npmjs\.com|stackoverflow\.com|quora\.com|fiverr\.com|upwork\.com|tiktok\.com|cloudflare\.com|amazon\.\w+|udemy\.com|crates\.io|pypi\.org)$/i;
async function probe(url) {
  const tries = ['HEAD', 'GET'];
  let last;
  for (const method of tries) {
    try {
      const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 (readme-check; +https://github.com/binay-py/claude-skills)', accept: '*/*' } });
      try { await r.body?.cancel(); } catch {}
      last = { status: r.status, type: r.headers.get('content-type') || '' };
      if (r.status < 400) return last;
      if (![403, 404, 405, 400, 501, 429].includes(r.status)) return last; // HEAD sometimes 404/405s where GET works: retry with GET
    } catch (e) { last = { error: e.name === 'TimeoutError' ? 'timeout after 10 s' : (e.cause?.code || e.message) }; }
  }
  return last;
}
const netStats = { checked: 0, ok: 0, broken: 0, unverified: 0 };
if (!opt.offline && remote.length) {
  const uniq = [...new Map(remote.filter(L => !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|example\.(com|org)|[^/]*\.example\.)/i.test(L.url)).map(L => [L.url.replace(/#.*$/, ''), L])).values()];
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < uniq.length) {
      const L = uniq[i++], u = L.url.replace(/#.*$/, ''), badge = L.image && isBadge(u), host = new URL(u).hostname;
      const r = await probe(u); netStats.checked++;
      const what = badge ? 'badge' : L.image ? 'image' : 'link';
      if (r.error) { netStats.broken++; add('medium', `${what} ${u} — ${r.error}`, L.line); }
      else if (r.status === 429 || r.status === 999 || ((r.status === 403 || r.status === 401) && BOT_BLOCKERS.test(host))) { netStats.unverified++; add('info', `${what} ${u} — HTTP ${r.status}, unverified (this site blocks scripts; open it in a browser)`, L.line); }
      else if (r.status >= 400) { netStats.broken++; add(r.status === 404 || r.status === 410 ? 'high' : 'medium', `${what} ${u} — HTTP ${r.status}${r.status === 403 ? ' (may be bot blocking: check in a browser)' : r.status >= 500 ? ' (server error, may be temporary: recheck later)' : ''}`, L.line); }
      else if ((badge || L.image) && r.type && !/^image\/|octet-stream/.test(r.type)) { netStats.broken++; add('medium', `${what} ${u} returns ${r.type.split(';')[0]}, not an image`, L.line); }
      else netStats.ok++;
    }
  }));
}

// ---------- --run ----------
const runResults = [];
let RUN_ROOT = null;
if (opt.run) await runCommands();
async function runCommands() {
  const tmp = RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-run-'));
  const EXCL = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.cache', 'target', '.pytest_cache', '.mypy_cache', '.parcel-cache']);
  let files = 0;
  fs.cpSync(root, tmp, { recursive: true, filter: s => { const b = path.basename(s); if (s !== root && EXCL.has(b)) return false; if (fs.lstatSync(s).isFile()) files++; return true; } });
  console.error(`--run: copied ${files} files to ${tmp} (without node_modules/.git/venv)`);
  let venv = null;
  const ensureVenv = () => {
    if (venv) return venv;
    const py = ['python', 'python3', 'py'].find(p => spawnSync(p, ['--version'], { encoding: 'utf8' }).status === 0);
    if (!py) return null;
    const dir = path.join(tmp, '.readme-venv');
    if (spawnSync(py, ['-m', 'venv', dir], { encoding: 'utf8', timeout: 120000 }).status !== 0) return null;
    venv = process.platform === 'win32' ? path.join(dir, 'Scripts') : path.join(dir, 'bin');
    return venv;
  };
  const blockCwdRun = new Map();
  for (const c of commands) {
    let cwd = blockCwdRun.has(c.block) ? blockCwdRun.get(c.block) : tmp;
    const segs = segments(c.cmd);
    if (PLACEHOLDER.test(c.cmd)) { runResults.push({ c, skip: 'contains a placeholder' }); continue; }
    let stop = false;
    for (const { s } of segs) {
      if (stop) break;
      const w = words(s), tool = (w[0] || '').toLowerCase().replace(/\.(cmd|exe)$/, '');
      if (tool === 'cd' || tool === 'set-location' || tool === 'pushd') {
        const d = w.slice(1).find(x => !x.startsWith('-'));
        if (d && cloned.has(d.replace(/\/$/, ''))) { cwd = tmp; continue; }
        const nd = d && !/[$~%<]/.test(d) && !path.isAbsolute(d) ? path.resolve(cwd, d) : null;
        if (!nd || !fs.existsSync(nd) || path.relative(tmp, nd).startsWith('..')) { runResults.push({ c, s, skip: `cd to ${d || '(home)'}: not inside the copy` }); stop = true; continue; }
        cwd = nd; continue;
      }
      const why = unsafe(s, w, tool, cwd);
      if (why) { runResults.push({ c, s, skip: why }); if (/long-running|missing/.test(why)) continue; stop = true; continue; }
      let exe = s;
      if (/^(python3?|py|pip3?|pytest)$/.test(tool)) {
        const vb = ensureVenv(); if (!vb) { runResults.push({ c, s, skip: 'no Python found to create a venv' }); stop = true; continue; }
        const map = { python: 'python', python3: 'python', py: 'python', pip: 'python -m pip', pip3: 'python -m pip', pytest: 'python -m pytest' };
        exe = `"${path.join(vb, process.platform === 'win32' ? 'python.exe' : 'python')}"${map[tool].replace(/^python/, '')} ${s.slice(w[0].length).trim()}`;
      }
      const r = await execOne(exe, cwd, opt.timeout * 1000);
      runResults.push({ c, s, ...r });
      if (r.code !== 0) { stop = true; }
    }
    blockCwdRun.set(c.block, cwd);
  }
  if (!opt.keep) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.error(`could not remove ${tmp}: ${e.message}`); } }
  else console.error(`kept ${tmp}`);
}
function unsafe(s, w, tool, cwd) {
  if (['sudo', 'su', 'doas', 'rm', 'del', 'rmdir', 'remove-item', 'curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'iex', 'invoke-expression', 'docker', 'podman', 'kubectl', 'ssh', 'scp', 'chmod', 'chown', 'mv', 'cp', 'dd', 'mkfs', 'brew', 'apt', 'apt-get', 'choco', 'winget', 'scoop', 'gh', 'vercel', 'netlify', 'wrangler', 'firebase', 'heroku', 'aws', 'gcloud', 'az', 'terraform'].includes(tool)) return `${tool}: never run`;
  if (/[|<>`]|\$\(|&\s*$|\$\{?[A-Za-z_]/.test(s.replace(/"[^"]*"|'[^']*'/g, '""'))) return 'uses pipes, redirection, variables or substitution';
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] || '')) return 'sets environment variables';
  if (/(^|\s)(-g|--global|--location=global)\b/.test(s)) return 'global install';
  const sub = (w[1] || '').toLowerCase(), rest = w.slice(1);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(tool)) {
    if (!sub && tool === 'yarn') return null;
    if (['install', 'i', 'ci'].includes(sub)) return rest.slice(1).some(x => !x.startsWith('-')) ? 'installs named packages (only plain installs from package.json run)' : null;
    if (['--version', '-v'].includes(sub)) return null;
    let script = ['run', 'run-script'].includes(sub) ? w[2] : ['test', 't'].includes(sub) ? 'test' : sub === 'start' ? 'start' : (tool !== 'npm' && sub && !NPM_BUILTIN.has(sub)) ? sub : null;
    if (sub === 'build') script = 'build';
    if (!script) return `${tool} ${sub}: not on the allowlist`;
    const p = pkgAt(cwd);
    if (!p?.scripts?.[script]) return `script "${script}" missing from package.json`;
    if (LONG_RUNNING.test(script) || /\b(--watch|nodemon|vite(?!\s+build)\b|next dev|webpack[- ]dev[- ]server|http-server|live-server|serve\b|browser-sync|wrangler dev|astro dev)/.test(p.scripts[script])) return `long-running ("${script}" starts a server or watcher)`;
    return null;
  }
  if (tool === 'node') {
    if (['--version', '-v'].includes(sub)) return null;
    const f = rest.find(x => !x.startsWith('-'));
    if (!f || rest.some(x => /^(-e|--eval|-p|--print)$/.test(x))) return 'node without a local script file (or -e)';
    const abs = path.resolve(cwd, f);
    if (path.isAbsolute(f) || path.relative(RUN_ROOT, abs).startsWith('..') || !fs.existsSync(abs)) return `node ${f}: file not in the repo`;
    return null;
  }
  if (tool === 'npx' || tool === 'pnpx' || tool === 'bunx') {
    const bin = rest.find(x => !x.startsWith('-'));
    const local = bin && (fs.existsSync(path.join(cwd, 'node_modules', '.bin', bin)) || fs.existsSync(path.join(cwd, 'node_modules', '.bin', bin + '.cmd')));
    return local ? null : `npx ${bin}: not installed locally, would download a package`;
  }
  if (/^(python3?|py)$/.test(tool)) {
    if (['--version', '-V'].includes(sub)) return null;
    if (sub === '-m') { const mod = w[2]; if (['pytest', 'unittest'].includes(mod)) return null; if (mod === 'pip') return pipOk(w.slice(3)); return `python -m ${mod}: not on the allowlist`; }
    const f = rest.find(x => !x.startsWith('-'));
    if (!f || !/\.py$/.test(f) || !fs.existsSync(path.resolve(cwd, f)) || path.isAbsolute(f)) return 'python without a local .py file';
    return null;
  }
  if (tool === 'pip' || tool === 'pip3') return pipOk(rest);
  if (tool === 'pytest') return null;
  if (tool === 'go') return ['build', 'test', 'vet'].includes(sub) ? null : `go ${sub}: only build/test/vet run`;
  if (tool === 'cargo') return ['build', 'test', 'check'].includes(sub) ? null : `cargo ${sub}: only build/test/check run`;
  if (tool === 'make') { if (!sub || sub.startsWith('-')) return 'make without a target'; return /^(install|uninstall|deploy|publish|release|push|upload|clean|distclean|run|serve|dev|start|watch|docker.*)$/.test(sub) ? `make ${sub}: not run (installs, deploys, deletes or never exits)` : null; }
  if (['ls', 'dir', 'cat', 'type', 'echo', 'pwd'].includes(tool)) return rest.some(x => path.isAbsolute(x) || x.startsWith('~') || x.includes('..')) ? 'reads outside the copy' : null;
  if (tool === 'git') return 'git: not run (the copy is the checkout; never pushes)';
  return `${tool || s}: not on the allowlist`;
}
function pipOk(args) {
  const i = args.findIndex(a => a === '-r' || a === '--requirement');
  const positional = args.slice(1).filter((a, j) => !a.startsWith('-') && j + 1 !== i + 1);
  return args[0] === 'install' && i !== -1 && args[i + 1] && !positional.length ? null : 'pip: only "pip install -r <file>" runs (inside a fresh venv)';
}
function execOne(cmd, cwd, ms) {
  return new Promise(resolve => {
    const t0 = Date.now(); let out = '';
    const ch = spawn(cmd, { cwd, shell: true, env: { ...process.env, CI: '1', npm_config_audit: 'false', npm_config_fund: 'false', FORCE_COLOR: '0', NO_COLOR: '1' }, detached: process.platform !== 'win32', windowsHide: true });
    ch.stdout.on('data', d => { out = (out + d).slice(-20000); }); ch.stderr.on('data', d => { out = (out + d).slice(-20000); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { windowsHide: true });
      else try { process.kill(-ch.pid, 'SIGKILL'); } catch {}
    }, ms);
    ch.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? 'timeout' : code, secs: ((Date.now() - t0) / 1000).toFixed(1), tail: out.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-4).join('\n') }); });
  });
}

// ---------- report ----------
const ORDER = { high: 0, medium: 1, low: 2, info: 3 }, ICON = { high: '✘', medium: '!', low: '·', info: 'i' };
findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || (a.line || 0) - (b.line || 0));
console.log(`readme-check: ${rel(readme)} in ${root}  (${lines.length} lines, ${headings.length} headings, ${relCount} relative links/images, ${remote.length} http(s) links, ${commands.length} shell commands)`);
console.log(`  sections: install ${hasInstall ? '✓' : '✗'}  usage ${hasUsage ? '✓' : '✗'}  license ${hasLicense ? '✓' : '✗'}  LICENSE file ${LICENSE_FILES[0] || '✗'}${fileLic ? ` (${fileLic})` : ''}`);
if (opt.offline) console.log('  http(s) links: skipped (--offline)');
else if (remote.length) console.log(`  http(s) links: ${netStats.checked} unique checked, ${netStats.ok} ok, ${netStats.broken} broken, ${netStats.unverified} unverified`);
console.log(findings.length ? '\nFindings:' : '\n✓ no problems found');
for (const f of findings) console.log(`${ICON[f.sev]} [${f.sev}]${f.line ? ` line ${f.line}:` : ''} ${f.msg}`);
if (opt.run) {
  console.log(`\nCommands (--run, timeout ${opt.timeout} s, in a temporary copy):`);
  if (!runResults.length) console.log('  (no shell commands found in the README)');
  for (const r of runResults) {
    const label = `line ${r.c.line}: ${r.s || r.c.cmd}`;
    if (r.skip) console.log(`  – skipped  ${label}  (${r.skip})`);
    else console.log(`  ${r.code === 0 ? '✓' : '✗'} ${r.code === 0 ? 'ran     ' : r.code === 'timeout' ? 'timeout ' : `exit ${r.code}`.padEnd(8)} ${label}  [${r.secs} s]${r.code !== 0 && r.tail ? '\n      ' + r.tail.split('\n').join('\n      ') : ''}`);
  }
  const ran = runResults.filter(r => !r.skip), ok = ran.filter(r => r.code === 0).length;
  console.log(`  summary: ${ok} passed, ${ran.length - ok} failed, ${runResults.length - ran.length} skipped`);
}
const n = s => findings.filter(f => f.sev === s).length;
console.log(`\nSummary: ${n('high')} high, ${n('medium')} medium, ${n('low')} low, ${n('info')} info`);
process.exitCode = n('high') || (opt.run && runResults.some(r => !r.skip && r.code !== 0)) ? 1 : 0;
