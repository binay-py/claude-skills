#!/usr/bin/env node
// read-guard — a Claude Code PreToolUse hook that stops whole-file reads of huge files (the #1 way context
// fills up) and points Claude at Grep / offset+limit instead. Zero dependencies. Node 22+.
//
// As a hook:   node read-guard.mjs hook        (matcher: Read|Bash|PowerShell)
// Try it:      node read-guard.mjs test <file> [--offset N --limit N]
//              node read-guard.mjs test-cmd "cat big.log"
//
// Escape hatch: if Claude retries the exact same full read within 10 minutes, it's allowed — so a file that
// genuinely has to be read whole (e.g. right before editing it) still can be, it just costs one extra turn.
// Tune with env vars: READ_GUARD_MAX_LINES (default 800), READ_GUARD_MAX_KB (default 80).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LINES = Number(process.env.READ_GUARD_MAX_LINES || 800);
const MAX_BYTES = Number(process.env.READ_GUARD_MAX_KB || 80) * 1024;
const STATE = path.join(os.homedir(), '.claude', 'read-guard-state.json');
const RETRY_MS = 10 * 60 * 1000;
// Read handles these specially (images, PDFs, notebooks) or they aren't text
const SKIP = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb|mp[34]|wav|ogg|webm|mov|zip|gz|tgz|7z|rar|exe|dll|so|dylib|woff2?|ttf|otf|eot|bin|wasm|class|jar|pyc|db|sqlite)$/i;

function measure(file) {
  const st = fs.statSync(file); if (!st.isFile()) return null;
  if (st.size > 50 * 1024 * 1024) return { bytes: st.size, lines: Math.round(st.size / 60), estimated: true };
  const buf = fs.readFileSync(file); let lines = 1; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
  return { bytes: st.size, lines };
}
const fmt = n => n.toLocaleString('en-US');
const tokens = bytes => Math.round(bytes / 4);

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); const now = Date.now(); for (const k of Object.keys(s)) if (now - s[k] > RETRY_MS) delete s[k]; fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} }

// returns null (allow) or a reason string (deny)
function judgeRead(file, offset, limit, { remember = true, stateless = false } = {}) {
  if (!file || SKIP.test(file)) return null;
  if (limit != null && Number(limit) > 0 && Number(limit) <= MAX_LINES) return null; // targeted read
  let m; try { m = measure(file); } catch { return null; } if (!m) return null;
  const effLines = limit ? Math.min(Number(limit), m.lines) : m.lines - (Number(offset) || 0);
  if (effLines <= MAX_LINES && m.bytes <= MAX_BYTES * (limit ? 10 : 1)) return null;
  const key = `${path.resolve(file)}|${offset || ''}|${limit || ''}`, state = stateless ? {} : loadState();
  if (state[key] && Date.now() - state[key] < RETRY_MS) { delete state[key]; if (remember) saveState(state); return null; } // second attempt: allow
  if (remember) { state[key] = Date.now(); saveState(state); }
  const est = m.estimated ? '~' : '';
  return `read-guard: ${path.basename(file)} is ${est}${fmt(m.lines)} lines / ${fmt(Math.round(m.bytes / 1024))} KB (~${fmt(tokens(m.bytes))} tokens). ` +
    `Reading it whole fills the context window and every later turn re-reads it. Instead: use Grep (pattern + -n) to find the lines you need, ` +
    `then Read with offset/limit around them (e.g. offset: 1200, limit: 200). If you really need the entire file, repeat the exact same Read and it will be allowed.`;
}

// cat/type/Get-Content of a big file with nothing limiting the output
function judgeCommand(cmd, cwd, { stateless = false } = {}) {
  const segs = cmd.split(/&&|\|\||;|\n/);
  let dir = cwd;
  for (const seg of segs) {
    const parts = seg.split('|').map(s => s.trim()); const first = parts[0];
    const cd = first.match(/^(?:cd|Set-Location|pushd|sl)\s+("[^"]+"|'[^']+'|\S+)\s*$/i);
    if (cd) { dir = path.resolve(dir, cd[1].replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, os.homedir())); continue; }
    const m = first.match(/^(?:cat|type|more|Get-Content|gc)\s+((?:"[^"]+"|'[^']+'|[^\s|;&<>]+)(?:\s+(?:"[^"]+"|'[^']+'|[^\s|;&<>-][^\s|;&<>]*))*)\s*$/i);
    if (!m) continue;
    if (parts.length > 1 && /^(head|tail|grep|rg|findstr|Select-String|Select-Object|sls|wc|less|jq|sort|uniq|awk|sed|cut|tr)\b/i.test(parts[1])) continue;
    if (/-(TotalCount|Tail|First|Last|Head)\b/i.test(first)) continue;
    for (const raw of m[1].match(/"[^"]+"|'[^']+'|\S+/g) || []) {
      const f = path.resolve(dir, raw.replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, os.homedir()));
      if (SKIP.test(f)) continue;
      let s; try { s = measure(f); } catch { continue; } if (!s) continue;
      if (s.lines > MAX_LINES || s.bytes > MAX_BYTES) {
        if (stateless) return `read-guard: would dump ${fmt(s.lines)} lines`;
        const key = `cmd|${cmd.trim()}|${dir}`, state = loadState(); // keyed by the exact command: a different command isn't a retry
        if (state[key] && Date.now() - state[key] < RETRY_MS) { delete state[key]; saveState(state); return null; }
        state[key] = Date.now(); saveState(state);
        return `read-guard: \`${first.slice(0, 80)}\` would dump ${fmt(s.lines)} lines (~${fmt(tokens(s.bytes))} tokens) into the context. ` +
          `Use \`grep -n "pattern" ${raw}\`, \`head -n 100 ${raw}\`, \`tail -n 100 ${raw}\`, or Read with offset/limit. Repeat the same command to run it anyway.`;
      }
    }
  }
  return null;
}

function hook() {
  let ev; try { ev = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  let reason = null;
  try {
    const ti = ev.tool_input || {};
    if (ev.tool_name === 'Read') reason = judgeRead(ti.file_path, ti.offset, ti.limit);
    else if ((ev.tool_name === 'Bash' || ev.tool_name === 'PowerShell') && typeof ti.command === 'string') reason = judgeCommand(ti.command, ev.cwd || process.cwd());
  } catch { reason = null; } // fail open
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'hook') hook();
else if (mode === 'test') {
  const o = n => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };
  const r = judgeRead(path.resolve(rest[0]), o('offset'), o('limit'), { remember: false, stateless: true });
  console.log(r ? 'DENY\n' + r : 'allow');
} else if (mode === 'test-cmd') { const r = judgeCommand(rest.join(' '), process.cwd(), { stateless: true }); console.log(r ? 'DENY\n' + r : 'allow'); }
else console.log('usage: node read-guard.mjs hook | test <file> [--offset N --limit N] | test-cmd "<command>"');
