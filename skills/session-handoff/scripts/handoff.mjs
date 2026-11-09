#!/usr/bin/env node
// session-handoff — keep long Claude Code sessions cheap.
//   meter : Stop hook. Reads the session transcript and warns the user (systemMessage) when the context passes
//           ~150k tokens, then again every +50k. Every turn re-reads the whole context, so this is where limits go.
//   write : builds HANDOFF.md from the session log (files changed, commands, recent requests, todos, git state)
//           with sections for Claude to fill in, so a fresh session (/clear) can pick up where this one stopped.
// Zero dependencies. Node 22+.
//
//   node handoff.mjs write [--out HANDOFF.md] [--session <id-prefix> | --transcript <file.jsonl>] [--cwd <dir>]
//   node handoff.mjs meter            (as a Stop hook; reads the hook JSON on stdin)
//   node handoff.mjs status [--transcript <file>]   print the current context size
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2), mode = argv[0];
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const WARN = Number(process.env.HANDOFF_WARN_TOKENS || 150000), STEP = Number(process.env.HANDOFF_STEP_TOKENS || 50000);
const PROJ = path.join(os.homedir(), '.claude', 'projects');
const k = n => Math.round(n / 1000) + 'k';
const REDACT = [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, /\bsk-ant-[A-Za-z0-9_-]{20,}/g, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, /\b[sr]k_live_[0-9a-zA-Z]{16,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bgh[pousr]_[0-9A-Za-z]{30,}/g, /\bgithub_pat_[0-9A-Za-z_]{40,}/g, /\bxox[abprs]-[0-9A-Za-z-]{10,}/g, /\bAIza[0-9A-Za-z_-]{35}\b/g, /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, /(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{8,}/gi, /(:\/\/[^\s:@/]+:)[^\s@/]{3,}@/g];
const redact = s => REDACT.reduce((t, re) => t.replace(re, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? p1 : '') + '[redacted]'), s);

function tail(file, bytes) { const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd); return buf.toString('utf8'); }
function latestTranscript(cwd, session) {
  const all = fs.existsSync(PROJ) ? fs.readdirSync(PROJ).flatMap(d => { try { return fs.readdirSync(path.join(PROJ, d)).filter(x => x.endsWith('.jsonl')).map(x => path.join(PROJ, d, x)); } catch { return []; } }) : [];
  if (session) return all.find(f => path.basename(f).startsWith(session)) || null;
  const dir = path.join(PROJ, path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  let cands = all.filter(f => path.dirname(f) === dir);
  if (!cands.length) cands = all; // ran from a subfolder: fall back to every project
  cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  // several sessions may be open: prefer the one that is running this command right now
  const recent = cands.filter(f => Date.now() - fs.statSync(f).mtimeMs < 15 * 60 * 1000);
  return recent.find(f => /handoff\.mjs[^"\n]{0,40}\bwrite\b/.test(tail(f, 400 * 1024))) || cands[0] || null;
}
function readLines(file) { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function contextOf(entries) {
  for (let i = entries.length - 1; i >= 0; i--) { const u = entries[i].type === 'assistant' && entries[i].message?.usage; if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); }
  return 0;
}

// ---------- meter (Stop hook) ----------
function meter() {
  let ev; try { ev = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  try {
    if (!ev.transcript_path || !fs.existsSync(ev.transcript_path)) process.exit(0);
    // read only the tail: transcripts get large
    const fd = fs.openSync(ev.transcript_path, 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, 2 * 1024 * 1024), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const ctx = contextOf(buf.toString('utf8').split('\n').slice(1).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    if (ctx < WARN) process.exit(0);
    const stateFile = path.join(os.homedir(), '.claude', 'handoff-meter.json');
    let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    const level = Math.floor((ctx - WARN) / STEP), key = ev.session_id || ev.transcript_path;
    if (st[key] !== undefined && st[key] >= level) process.exit(0);
    st[key] = level; const keys = Object.keys(st); if (keys.length > 200) for (const x of keys.slice(0, keys.length - 200)) delete st[x];
    fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(st));
    process.stdout.write(JSON.stringify({ systemMessage: `Context is at ~${k(ctx)} tokens, and every message re-reads all of it. If this task is done or drifting, ask Claude to "write a handoff" (session-handoff skill), then /clear and continue from HANDOFF.md. Or run /compact.` }));
  } catch {}
  process.exit(0);
}

// ---------- write ----------
function write() {
  const cwd = path.resolve(opt('cwd') || process.cwd());
  const tf = opt('transcript') || latestTranscript(cwd, opt('session'));
  if (!tf || !fs.existsSync(tf)) { console.error(`no session log found for ${cwd} (looked in ${PROJ}). Pass --transcript <file.jsonl>.`); process.exit(1); }
  const E = readLines(tf);
  let title = '', branch = '', started = null, todos = null;
  const prompts = [], files = new Map(), cmds = [];
  for (const e of E) {
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.gitBranch) branch = e.gitBranch;
    if (e.timestamp && !started) started = e.timestamp;
    const c = e.message?.content;
    if (e.type === 'user' && !e.isMeta && !e.toolUseResult) {
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join(' ') : '';
      const t = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t && !t.startsWith('[Request interrupted') && !/^(Caveat:|<command)/.test(t)) prompts.push({ t, at: e.timestamp });
    }
    if (e.type === 'assistant' && Array.isArray(c)) for (const b of c) {
      if (b?.type !== 'tool_use') continue;
      const i = b.input || {};
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && (i.file_path || i.notebook_path)) { const f = i.file_path || i.notebook_path; files.set(f, (files.get(f) || 0) + 1); }
      if (/^(Bash|PowerShell)$/.test(b.name) && i.command) cmds.push(i.command.split('\n')[0].slice(0, 140));
      if (b.name === 'TodoWrite' && Array.isArray(i.todos)) todos = i.todos;
    }
  }
  const ctx = contextOf(E);
  const g = a => spawnSync('git', a, { cwd, encoding: 'utf8' });
  const inGit = g(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  const rel = f => { const r = path.relative(cwd, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : f.replace(os.homedir(), '~').split(path.sep).join('/'); };
  const L = [];
  L.push(`# Handoff: ${title || path.basename(cwd)}`, '',
    `_Written ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from session \`${path.basename(tf, '.jsonl').slice(0, 8)}\` (started ${String(started || '').slice(0, 16).replace('T', ' ')}, context at handoff ~${k(ctx)} tokens)._`,
    `_Folder: \`${cwd.replace(os.homedir(), '~')}\`${branch ? ` · branch \`${branch}\`` : ''}_`, '',
    `> New session: read this file, check \`git status\`, then continue from **Next steps**.`, '',
    `## Goal`, `<!-- CLAUDE: one or two sentences: what the user is trying to achieve overall -->`, '',
    `## Done so far`, `<!-- CLAUDE: bullet list of what was completed and verified (with how it was verified) -->`, '',
    `## Decisions and why`, `<!-- CLAUDE: choices made, alternatives rejected, user preferences learned in this session -->`, '',
    `## Open problems / gotchas`, `<!-- CLAUDE: what is broken, half-done, risky, or surprising; exact error messages -->`, '',
    `## Next steps`, `<!-- CLAUDE: numbered, concrete, first step first -->`, '');
  L.push(`## Facts from the session log`, '');
  if (todos?.length) L.push(`**Todo list (last state):**`, ...todos.map(t => `- [${t.status === 'completed' ? 'x' : ' '}] ${redact(t.content || t.subject || '')}${t.status === 'in_progress' ? ' _(in progress)_' : ''}`), '');
  if (files.size) L.push(`**Files edited (${files.size}):**`, ...[...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([f, n]) => `- \`${rel(f)}\`${n > 1 ? ` ×${n}` : ''}`), '');
  if (inGit) {
    const st = g(['status', '--short']).stdout.trim(), ds = g(['diff', '--stat', 'HEAD']).stdout.trim().split('\n').slice(-1)[0], log = g(['log', '--oneline', '-8']).stdout.trim();
    L.push(`**Git:** ${st ? `${st.split('\n').length} uncommitted change(s)${ds ? ` (${ds.trim()})` : ''}` : 'working tree clean'}`, '');
    if (st) L.push('```', ...st.split('\n').slice(0, 30), '```', '');
    if (log) L.push(`Recent commits:`, '```', log, '```', '');
  }
  if (cmds.length) L.push(`**Last commands run:**`, '```', ...cmds.slice(-12).map(redact), '```', '');
  if (prompts.length) L.push(`**Recent user requests (newest last):**`, ...prompts.slice(-8).map(p => `- ${redact(p.t).slice(0, 220)}${p.t.length > 220 ? '…' : ''}`), '');
  const out = path.resolve(cwd, opt('out') || 'HANDOFF.md');
  fs.writeFileSync(out, L.join('\n'));
  console.log(`wrote ${out}\n  ${files.size} files edited · ${cmds.length} commands · ${prompts.length} user messages · context ~${k(ctx)} tokens`);
  console.log(`Next: fill the <!-- CLAUDE: … --> sections from what you know about this session (keep each short and concrete), then tell the user to /clear and say "Read HANDOFF.md and continue".`);
  if (inGit && g(['check-ignore', '-q', out]).status !== 0) console.log(`Note: ${path.basename(out)} is not gitignored. It's a working note; don't commit it unless the user wants to.`);
}

if (mode === 'meter') meter();
else if (mode === 'write') write();
else if (mode === 'status') {
  const tf = opt('transcript') || latestTranscript(process.cwd(), opt('session'));
  if (!tf) { console.log('no session log for this folder'); process.exit(1); }
  console.log(`~${k(contextOf(readLines(tf)))} tokens of context in ${path.basename(tf)}`);
} else console.log('usage: node handoff.mjs write [--out HANDOFF.md] [--transcript file.jsonl] [--cwd dir] | meter | status');
