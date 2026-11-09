#!/usr/bin/env node
// claude-md-doctor — mechanical checks on the instruction files Claude Code loads into every session:
// CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md (cwd and every parent), ~/.claude/CLAUDE.md, .claude/rules/*.md,
// AGENTS.md, @imports (≤4 hops), and the auto-memory MEMORY.md index. Zero dependencies. Node 22+. Read-only.
//
//   node md-doctor.mjs                 check what loads when Claude Code starts in the current folder
//   node md-doctor.mjs path/to/project
//
// Rules from https://code.claude.com/docs/en/memory: target < 200 lines per CLAUDE.md; imports resolve relative
// to the importing file, max 4 hops, and are skipped inside code spans/blocks; imported files cost context too;
// auto memory loads the first 200 lines or 25 KB of MEMORY.md; AGENTS.md is ignored when a CLAUDE.md exists;
// block-level HTML comments are stripped before loading.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const HOME = os.homedir(), CLAUDE = path.join(HOME, '.claude');
const short = p => { const r = path.relative(root, p); return (!r.startsWith('..') && !path.isAbsolute(r) && r ? './' + r : p.replace(HOME, '~')).split(path.sep).join('/'); };
const tok = s => Math.round(s.length / 4);
const findings = []; const add = (sev, file, msg) => findings.push({ sev, file: short(file), msg });
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\b[sr]k_live_[0-9a-zA-Z]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[0-9A-Za-z]{30,}|\bgithub_pat_[0-9A-Za-z_]{40,}|\bxox[abprs]-[0-9A-Za-z-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]{3,}@/;

// strip what Claude never sees / never parses for imports
const stripComments = s => s.replace(/^\s*<!--[\s\S]*?-->\s*$/gm, '');
const stripCode = s => s.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');

const loaded = []; // {file, kind, chars, lines, via}
const seen = new Set();
function load(file, kind, via = null, depth = 0, chain = []) {
  const real = path.resolve(file);
  if (chain.includes(real)) { add('medium', file, `import cycle: ${[...chain, real].map(short).join(' → ')}`); return; }
  if (seen.has(real)) return; seen.add(real);
  const raw = fs.readFileSync(real, 'utf8'), text = stripComments(raw);
  const lines = text.split('\n').length;
  loaded.push({ file: real, kind, chars: text.length, lines, via, saved: raw.length - text.length });
  if (SECRET.test(raw)) add('high', real, 'contains something that looks like a secret (key, token or credentialed URL). Instruction files are often committed: move it to an env var');
  if (kind !== 'import' && kind !== 'memory' && lines > 200) add('medium', real, `${lines} lines (docs target: under 200). Long files cost context every session and lower adherence; move area-specific parts into .claude/rules/ with a paths: filter`);
  // @imports (outside code), relative to this file; ~ and absolute allowed
  for (const m of stripCode(text).matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/])?[\w.\-~/\\]+\.[\w]+|(?:~\/|\.{1,2}\/)[\w.\-~/\\]+)/g)) {
    const target = m[1].startsWith('~/') ? path.join(HOME, m[1].slice(2)) : path.resolve(path.dirname(real), m[1]);
    if (!fs.existsSync(target)) { add('high', real, `@${m[1]} imports a file that doesn't exist (${short(target)})`); continue; }
    if (fs.statSync(target).isDirectory()) { add('medium', real, `@${m[1]} points to a folder; imports must be files`); continue; }
    if (depth + 1 > 4) { add('medium', real, `@${m[1]} is more than 4 import hops deep and will NOT load`); continue; }
    load(target, 'import', real, depth + 1, [...chain, real]);
  }
  if (kind === 'import') return;
  staleRefs(real, text);
}

// backticked paths and npm scripts that no longer exist
const pkgCache = new Map();
function scriptsFor(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, 'package.json');
    if (fs.existsSync(p)) { if (!pkgCache.has(p)) { try { pkgCache.set(p, Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).scripts || {})); } catch { pkgCache.set(p, null); } } return pkgCache.get(p); }
    if (path.dirname(d) === d) return null;
  }
}
function staleRefs(file, text) {
  const base = path.dirname(file).endsWith(path.sep + '.claude') ? path.dirname(path.dirname(file)) : path.dirname(file);
  if (base === HOME || base === CLAUDE) return; // user-level files talk about many projects
  const missing = new Set();
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const ref = m[1].replace(/[:#].*$/, '').replace(/[),.;]+$/, '');
    if (!/^(\.{0,2}\/)?[\w.-]+(\/[\w.-]+)+$/.test(ref) && !/^[\w-]+\.(js|ts|tsx|jsx|mjs|py|go|rs|json|ya?ml|toml|md|css|html|sh|sql)$/.test(ref)) continue;
    if (/^(https?|node_modules|dist|build|\.next|out|coverage|\.env|tmp)\b/.test(ref) || /[*<>{}$]/.test(ref) || ref.startsWith('/')) continue;
    if (!fs.existsSync(path.resolve(base, ref))) missing.add(ref);
  }
  if (missing.size) add('low', file, `mentions ${missing.size} path(s) that don't exist here anymore: ${[...missing].slice(0, 6).join(', ')}${missing.size > 6 ? ' …' : ''}. Stale paths make Claude look for files that moved`);
  const scripts = scriptsFor(base);
  if (scripts) {
    const bad = [...new Set([...text.matchAll(/\b(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)/g)].map(m => m[1]))]
      .filter(s => !scripts.includes(s) && !['install', 'add', 'test', 'start', 'dlx', 'exec', 'create', 'i'].includes(s));
    if (bad.length) add('medium', file, `tells Claude to run script(s) missing from package.json: ${bad.join(', ')}`);
  }
}

// ---------- what loads at launch ----------
const userMd = path.join(CLAUDE, 'CLAUDE.md'); if (fs.existsSync(userMd)) load(userMd, 'user');
for (const f of fs.existsSync(path.join(CLAUDE, 'rules')) ? fs.readdirSync(path.join(CLAUDE, 'rules'), { recursive: true }).filter(f => String(f).endsWith('.md')) : []) load(path.join(CLAUDE, 'rules', String(f)), 'user rule');
const chain = []; for (let d = root; ; d = path.dirname(d)) { chain.unshift(d); if (path.dirname(d) === d) break; }
let anyClaudeMd = false;
for (const d of chain) for (const [rel, kind] of [['CLAUDE.md', 'project'], ['.claude/CLAUDE.md', 'project'], ['CLAUDE.local.md', 'local']]) {
  const f = path.join(d, rel); if (fs.existsSync(f) && !(d === HOME && rel === '.claude/CLAUDE.md')) { anyClaudeMd = true; load(f, kind); }
}
for (const d of chain) { const a = path.join(d, 'AGENTS.md'); if (fs.existsSync(a)) { if (anyClaudeMd && !seen.has(path.resolve(a))) add('info', a, 'AGENTS.md is NOT read because a CLAUDE.md exists here or above. Add "@AGENTS.md" to CLAUDE.md if you want both'); else if (!anyClaudeMd) load(a, 'agents'); } }
// project rules: those without a paths: filter load at launch
const rulesDir = path.join(root, '.claude', 'rules');
if (fs.existsSync(rulesDir)) for (const f of fs.readdirSync(rulesDir, { recursive: true }).filter(f => String(f).endsWith('.md'))) {
  const p = path.join(rulesDir, String(f)), head = fs.readFileSync(p, 'utf8').slice(0, 500);
  if (/^---[\s\S]*?\npaths\s*:/m.test(head)) loaded.push({ file: p, kind: 'rule (on demand)', chars: 0, lines: 0, onDemand: true }); else load(p, 'rule');
}
// auto memory
const memDir = path.join(CLAUDE, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'), memIdx = path.join(memDir, 'MEMORY.md');
if (fs.existsSync(memIdx)) {
  const t = fs.readFileSync(memIdx, 'utf8'), n = t.split('\n').length, kept = Math.min(t.length, 25 * 1024, t.split('\n').slice(0, 200).join('\n').length);
  loaded.push({ file: memIdx, kind: 'auto memory', chars: kept, lines: Math.min(n, 200) });
  if (n > 200 || t.length > 25 * 1024) add('medium', memIdx, `${n} lines / ${(t.length / 1024).toFixed(1)} KB: only the first 200 lines or 25 KB load, so ${n > 200 ? n - 200 + ' line(s)' : 'the end'} are invisible to Claude. Merge or prune entries`);
  const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const orphan = files.filter(f => !t.includes(f)); if (orphan.length) add('low', memIdx, `${orphan.length} memory file(s) not linked from MEMORY.md, so never recalled: ${orphan.slice(0, 5).join(', ')}`);
  const dead = [...t.matchAll(/\]\(([^)]+\.md)\)/g)].map(m => m[1]).filter(f => !fs.existsSync(path.join(memDir, f))); if (dead.length) add('low', memIdx, `links to missing memory file(s): ${dead.join(', ')}`);
}
// nested CLAUDE.md files (load on demand) — report sizes only
const nested = [];
(function rec(d, depth) { if (depth > 4) return; let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) { if (!e.isDirectory() || e.name.startsWith('.') || /^(node_modules|dist|build|vendor|venv|AppData|Library|go|pkg|target|__pycache__)$/.test(e.name)) continue; const p = path.join(d, e.name), f = path.join(p, 'CLAUDE.md'); if (fs.existsSync(f)) nested.push(f); rec(p, depth + 1); } })(root, 0);

// git hygiene
const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).stdout.trim() === 'true';
if (inGit) for (const l of loaded.filter(x => x.kind === 'local')) {
  if (spawnSync('git', ['ls-files', '--error-unmatch', l.file], { cwd: root }).status === 0) add('medium', l.file, 'CLAUDE.local.md is committed to git: it is meant to be personal. git rm --cached it and add it to .gitignore');
  else if (spawnSync('git', ['check-ignore', '-q', l.file], { cwd: root }).status !== 0) add('low', l.file, 'CLAUDE.local.md is not in .gitignore');
}

// ---------- report ----------
const atLaunch = loaded.filter(l => !l.onDemand), total = atLaunch.reduce((n, l) => n + l.chars, 0);
console.log(`claude-md-doctor: ${short(root)}\n\nLoaded at launch (~${tok('x'.repeat(total))} tokens every session):`);
if (!atLaunch.length) console.log('  (nothing: no CLAUDE.md, rules or memory found)');
for (const l of atLaunch) console.log(`  ${String(tok('x'.repeat(l.chars))).padStart(6)} tok  ${String(l.lines).padStart(4)} lines  [${l.kind}] ${short(l.file)}${l.via ? `  ← @import from ${short(l.via)}` : ''}${l.saved > 50 ? `  (${tok('x'.repeat(l.saved))} tok of HTML comments stripped)` : ''}`);
const od = loaded.filter(l => l.onDemand);
if (od.length || nested.length) console.log(`\nLoaded on demand: ${od.map(l => short(l.file)).concat(nested.map(short)).join(', ')}`);
const ORDER = { high: 0, medium: 1, low: 2, info: 3 }, ICON = { high: '✘', medium: '!', low: '·', info: 'i' };
findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev]);
console.log(findings.length ? '\nFindings:' : '\n✓ no problems found');
for (const f of findings) console.log(`${ICON[f.sev]} [${f.sev}] ${f.file}\n    ${f.msg}`);
if (total > 40000) console.log(`\nTip: ~${tok('x'.repeat(total))} tokens load before you type anything. Run /doctor prompt-audit in Claude Code to find contradictions, and move area-specific rules into .claude/rules/ with paths: filters.`);
process.exitCode = findings.some(f => f.sev === 'high') ? 1 : 0;
