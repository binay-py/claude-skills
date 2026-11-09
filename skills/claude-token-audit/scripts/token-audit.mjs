#!/usr/bin/env node
// claude-token-audit — where do your Claude Code tokens (and limits) go?
// Reads the local session logs in ~/.claude/projects/*/*.jsonl (nothing leaves your machine).
// Zero dependencies. Node 22+.
//
//   node token-audit.mjs                   last 30 days, all projects
//   node token-audit.mjs --days 7
//   node token-audit.mjs --project myapp   only projects whose folder contains "myapp"
//   node token-audit.mjs --out report.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const DAYS = Number(opt('days', 30)), FILTER = (opt('project') || '').toLowerCase(), OUT = path.resolve(opt('out', 'token-audit.md'));
const CLAUDE = path.join(os.homedir(), '.claude'), PROJ = path.join(CLAUDE, 'projects');
const since = Date.now() - DAYS * 864e5;
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n));
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
const tok = chars => chars / 4; // rough: ~4 characters per token

if (!fs.existsSync(PROJ)) { console.log(`no session logs found at ${PROJ}`); process.exit(1); }
const sessions = new Map(), byDay = new Map(), byModel = new Map(), tools = new Map(), bigResults = [];
const seenMsg = new Set();
const blank = () => ({ fresh: 0, cacheRead: 0, cacheWrite: 0, out: 0, reqs: 0 });
const addU = (o, u) => { o.fresh += u.input_tokens || 0; o.cacheWrite += u.cache_creation_input_tokens || 0; o.cacheRead += u.cache_read_input_tokens || 0; o.out += u.output_tokens || 0; o.reqs++; };

const files = fs.readdirSync(PROJ, { withFileTypes: true }).filter(d => d.isDirectory() && (!FILTER || d.name.toLowerCase().includes(FILTER)))
  .flatMap(d => fs.readdirSync(path.join(PROJ, d.name)).filter(f => f.endsWith('.jsonl')).map(f => ({ dir: d.name, file: path.join(PROJ, d.name, f) })))
  .filter(f => fs.statSync(f.file).mtimeMs >= since);
process.stdout.write(`reading ${files.length} session log(s) from the last ${DAYS} days…\n`);

for (const { dir, file } of files) {
  const s = { id: path.basename(file, '.jsonl'), dir, title: '', cwd: '', ...blank(), maxCtx: 0, cost: null, toolCalls: 0, first: null, last: null };
  const pending = new Map(); // tool_use_id -> name
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) s.title = d.aiTitle;
    else if (d.type === 'last-prompt' && !s.title && d.lastPrompt) s.title = d.lastPrompt.slice(0, 70);
    else if (d.type === 'cost-state' && d.totalCostUSD) s.cost = Number(d.totalCostUSD);
    if (d.cwd && !s.cwd) s.cwd = d.cwd;
    const ts = d.timestamp ? Date.parse(d.timestamp) : null;
    if (ts && ts < since) continue;
    if (ts) { s.first ??= ts; s.last = ts; }
    const m = d.message;
    if (d.type === 'assistant' && m) {
      for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === 'tool_use') { pending.set(c.id, c.name); s.toolCalls++; const t = tools.get(c.name) || { calls: 0, chars: 0 }; t.calls++; tools.set(c.name, t); }
      const id = m.id || d.requestId; const u = m.usage;
      if (u && id && !seenMsg.has(id)) { // one API response is split over several lines sharing the same usage
        seenMsg.add(id); addU(s, u);
        const day = (d.timestamp || '').slice(0, 10); if (day) { const o = byDay.get(day) || blank(); addU(o, u); byDay.set(day, o); }
        const mo = byModel.get(m.model || '?') || blank(); addU(mo, u); byModel.set(m.model || '?', mo);
        s.maxCtx = Math.max(s.maxCtx, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0));
      }
    }
    if (d.type === 'user' && Array.isArray(m?.content)) {
      for (const c of m.content) if (c?.type === 'tool_result') {
        const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map(x => x.text || (x.type === 'image' ? '#'.repeat(6000) : '')).join('') : '';
        const name = pending.get(c.tool_use_id) || '?', t = tools.get(name) || { calls: 0, chars: 0 }; t.chars += text.length; tools.set(name, t);
        if (text.length > 20000) bigResults.push({ chars: text.length, tool: name, session: s.title || s.id, preview: text.slice(0, 80).replace(/\s+/g, ' ') });
      }
    }
  }
  if (s.reqs) sessions.set(s.id, s);
}

// ---------- context overhead (what loads before you type) ----------
const overhead = [];
const sizeIf = (label, f) => { try { const n = fs.statSync(f).size; overhead.push({ label, bytes: n }); } catch {} };
sizeIf('~/.claude/CLAUDE.md', path.join(CLAUDE, 'CLAUDE.md'));
const cwds = [...new Set([...sessions.values()].map(s => s.cwd).filter(Boolean))];
for (const c of cwds) { sizeIf(`${c}/CLAUDE.md`.replace(os.homedir(), '~'), path.join(c, 'CLAUDE.md')); sizeIf(`${c}/.claude/CLAUDE.md`.replace(os.homedir(), '~'), path.join(c, '.claude', 'CLAUDE.md')); }
let mcpCount = 0; try { const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); mcpCount = Object.keys(cj.mcpServers || {}).length + Object.values(cj.projects || {}).reduce((n, p) => n + Object.keys(p.mcpServers || {}).length, 0); } catch {}
let skillChars = 0, skillCount = 0;
const scanSkills = dir => { try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name, 'SKILL.md'); if (e.isDirectory() && fs.existsSync(f)) { const fm = fs.readFileSync(f, 'utf8').match(/^---[\s\S]*?\n---/); skillChars += fm ? fm[0].length : 0; skillCount++; } } } catch {} };
scanSkills(path.join(CLAUDE, 'skills'));
try { for (const p of fs.readdirSync(path.join(CLAUDE, 'plugins', 'cache'), { recursive: true })) if (String(p).endsWith(path.join('skills'))) scanSkills(path.join(CLAUDE, 'plugins', 'cache', String(p))); } catch {}

// ---------- report ----------
const all = [...sessions.values()];
const tot = all.reduce((o, s) => { o.fresh += s.fresh; o.cacheRead += s.cacheRead; o.cacheWrite += s.cacheWrite; o.out += s.out; o.reqs += s.reqs; return o; }, blank());
const costs = all.filter(s => s.cost != null), cost = costs.reduce((n, s) => n + s.cost, 0);
const inputAll = tot.fresh + tot.cacheRead + tot.cacheWrite;
const byProject = new Map(); for (const s of all) { const k = s.cwd ? s.cwd.replace(os.homedir(), '~') : s.dir; const o = byProject.get(k) || { ...blank(), sessions: 0, cost: 0 }; o.fresh += s.fresh; o.cacheRead += s.cacheRead; o.cacheWrite += s.cacheWrite; o.out += s.out; o.reqs += s.reqs; o.sessions++; o.cost += s.cost || 0; byProject.set(k, o); }
const totalOf = o => o.fresh + o.cacheRead + o.cacheWrite + o.out;
const toolRows = [...tools.entries()].sort((a, b) => b[1].chars - a[1].chars);
const toolChars = toolRows.reduce((n, [, t]) => n + t.chars, 0);

const tips = [];
const cacheHit = inputAll ? tot.cacheRead / inputAll : 0;
if (cacheHit < 0.7 && inputAll > 1e6) tips.push(`Only ${(cacheHit * 100).toFixed(0)}% of input came from cache. Long pauses (>5 min / 1 h depending on plan) expire the cache, so the next message re-sends the whole context at full price. Batch your questions, or /compact before a break.`);
const longSessions = all.filter(s => s.maxCtx > 150e3);
if (longSessions.length) tips.push(`${longSessions.length} session(s) ran past 150k tokens of context. Every message in a long session re-reads all of it. Start a fresh session (/clear) per task, and use /compact when you must continue.`);
const top = toolRows[0];
if (top && toolChars && top[1].chars / toolChars > 0.4) tips.push(`"${top[0]}" results are ${(top[1].chars / toolChars * 100).toFixed(0)}% of all tool output (~${fmt(tok(top[1].chars))} tokens). ${/Bash|PowerShell/.test(top[0]) ? 'Pipe noisy commands through head/tail/grep, use quiet flags (-q, --silent), and avoid dumping whole logs.' : /Read/.test(top[0]) ? 'Read files with offset/limit or grep first instead of reading whole large files.' : /Fetch|Search|mcp/i.test(top[0]) ? 'Web/MCP results are large; ask for narrower queries or summaries.' : 'Look for ways to return less output from it.'}`);
if (bigResults.length) tips.push(`${bigResults.length} single tool result(s) were over ~5k tokens each (largest ~${fmt(tok(Math.max(...bigResults.map(b => b.chars))))}). See "Biggest tool outputs" below.`);
const claudeMd = overhead.reduce((n, o) => n + o.bytes, 0);
if (claudeMd > 20000) tips.push(`CLAUDE.md files total ${kb(claudeMd)} (~${fmt(tok(claudeMd))} tokens) and load into every session. Move rarely needed detail into separate docs or skills.`);
if (mcpCount > 5) tips.push(`${mcpCount} MCP servers configured. Their tool definitions sit in context; disable the ones you don't use in a project.`);
if (skillCount > 40) tips.push(`${skillCount} skills installed (~${fmt(tok(skillChars))} tokens of descriptions in every session). Uninstall the ones you never use.`);
const opusShare = [...byModel.entries()].filter(([m]) => /opus/i.test(m)).reduce((n, [, o]) => n + totalOf(o), 0) / Math.max(1, [...byModel.values()].reduce((n, o) => n + totalOf(o), 0));
if (opusShare > 0.8) tips.push(`${(opusShare * 100).toFixed(0)}% of tokens went to Opus. Routine edits, searches and subagents run fine on Sonnet/Haiku (/model), which stretches usage limits.`);

const L = [];
L.push(`# Claude Code token audit`, ``, `Last ${DAYS} days · ${all.length} sessions · ${fmt(tot.reqs)} API requests${FILTER ? ` · projects matching "${FILTER}"` : ''}`, ``);
L.push(`| | Tokens |`, `|---|---|`, `| Input, fresh | ${fmt(tot.fresh)} |`, `| Input, cache write | ${fmt(tot.cacheWrite)} |`, `| Input, cache read (cheap) | ${fmt(tot.cacheRead)} |`, `| Output | ${fmt(tot.out)} |`, `| Cache hit rate | ${(cacheHit * 100).toFixed(0)}% |`);
if (costs.length) L.push(`| API-equivalent cost (from Claude Code's own counter, ${costs.length} sessions) | $${cost.toFixed(2)} |`);
L.push(``, `## What to change`, ``, ...(tips.length ? tips.map(t => `- ${t}`) : ['- Nothing stands out. Your usage looks efficient.']), ``);
L.push(`## By project`, ``, `| Project | Sessions | Total tokens | Output | Cost |`, `|---|---|---|---|---|`,
  ...[...byProject.entries()].sort((a, b) => totalOf(b[1]) - totalOf(a[1])).slice(0, 15).map(([k, o]) => `| ${k} | ${o.sessions} | ${fmt(totalOf(o))} | ${fmt(o.out)} | ${o.cost ? '$' + o.cost.toFixed(2) : '–'} |`), ``);
L.push(`## Heaviest sessions`, ``, `| Session | Requests | Total tokens | Peak context | Tool calls | Cost |`, `|---|---|---|---|---|---|`,
  ...all.sort((a, b) => totalOf(b) - totalOf(a)).slice(0, 10).map(s => `| ${(s.title || s.id).replace(/\|/g, '/').slice(0, 60)} | ${s.reqs} | ${fmt(totalOf(s))} | ${fmt(s.maxCtx)} | ${s.toolCalls} | ${s.cost != null ? '$' + s.cost.toFixed(2) : '–'} |`), ``);
L.push(`## Tool output fed back into context`, ``, `| Tool | Calls | Output (~tokens) | Avg per call |`, `|---|---|---|---|`,
  ...toolRows.slice(0, 15).map(([n, t]) => `| ${n} | ${t.calls} | ${fmt(tok(t.chars))} | ${fmt(tok(t.chars / Math.max(1, t.calls)))} |`), ``);
if (bigResults.length) L.push(`## Biggest tool outputs`, ``, ...bigResults.sort((a, b) => b.chars - a.chars).slice(0, 10).map(b => `- ~${fmt(tok(b.chars))} tokens from **${b.tool}** in "${b.session.slice(0, 50)}": \`${b.preview.replace(/`/g, "'")}\``), ``);
L.push(`## By model`, ``, `| Model | Requests | Total tokens | Output |`, `|---|---|---|---|`, ...[...byModel.entries()].sort((a, b) => totalOf(b[1]) - totalOf(a[1])).map(([m, o]) => `| ${m} | ${o.reqs} | ${fmt(totalOf(o))} | ${fmt(o.out)} |`), ``);
L.push(`## By day`, ``, `| Day | Requests | Total tokens | Output |`, `|---|---|---|---|`, ...[...byDay.entries()].sort().slice(-14).map(([d, o]) => `| ${d} | ${o.reqs} | ${fmt(totalOf(o))} | ${fmt(o.out)} |`), ``);
L.push(`## Loaded into every session`, ``, ...overhead.map(o => `- ${o.label}: ${kb(o.bytes)} (~${fmt(tok(o.bytes))} tokens)`), `- MCP servers configured: ${mcpCount}`, `- Skills installed: ${skillCount} (~${fmt(tok(skillChars))} tokens of descriptions)`, ``,
  `_Token counts come from the API usage recorded in your logs. Tool output sizes are estimated at ~4 characters per token._`);
fs.writeFileSync(OUT, L.join('\n'));

console.log(`\n${all.length} sessions · input ${fmt(inputAll)} (cache hit ${(cacheHit * 100).toFixed(0)}%) · output ${fmt(tot.out)}${costs.length ? ` · ≈$${cost.toFixed(2)} API-equivalent` : ''}`);
console.log('\nWhat to change:'); for (const t of tips.length ? tips : ['Nothing stands out.']) console.log('  • ' + t);
console.log(`\nFull report: ${OUT}`);
