#!/usr/bin/env node
// bash-checkpoint — a Claude Code PreToolUse hook that snapshots your files before destructive shell
// commands, blocks catastrophic ones, and asks before force-pushes / hard resets. Zero dependencies. Node 22+.
//
// As a hook (reads the tool call as JSON on stdin):   node checkpoint.mjs hook
// Manage snapshots:
//   node checkpoint.mjs list [--all]          snapshots for this folder (or all)
//   node checkpoint.mjs show <id>             what changed since the snapshot
//   node checkpoint.mjs restore <id> [path]   put files back (whole snapshot or one path)
//   node checkpoint.mjs prune [--keep 50]     delete old snapshots
//   node checkpoint.mjs test "<command>"      dry-run the rules on a command
//
// Git repos: snapshot = a commit of the whole working tree (tracked + untracked, respecting .gitignore)
// stored under refs/claude-checkpoints/ — your branches, index and stash are never touched.
// Other folders: the files/folders named in the command are copied to ~/.claude/checkpoints/<id>/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE = path.join(os.homedir(), '.claude', 'checkpoints');
const LOG = path.join(STORE, 'log.jsonl');
const MAX_COPY = 300 * 1024 * 1024; // non-git copies larger than this are skipped (with a note)
const norm = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const inside = (child, parent) => { const c = norm(child), q = norm(parent); return c === q || c.startsWith(q.endsWith(path.sep) ? q : q + path.sep); };
const git = (cwd, args, env) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 25000, maxBuffer: 64 * 1024 * 1024 });

// ---------- rules ----------
const HOME_RE = String.raw`(~|\$HOME|"\$HOME"|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%|${os.homedir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/\\\\/g, '[\\\\/]')})`;
const ROOT_RE = String.raw`(/|/\*|[A-Za-z]:[\\/]?\*?|\\\\)`;
const TARGET = String.raw`["']?(${HOME_RE}|${ROOT_RE})[\\/]?["']?(\s|$|;|&|\|)`;
// Block rules apply per command segment, only when the segment actually RUNS the program named
// (so `git commit -m "mention mkfs"` passes, `rm -rf "$HOME"` and `bash -c "rm -rf ~"` don't).
const BLOCK = [
  [/^rm$/, new RegExp(String.raw`^rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+|-[a-zA-Z]*f[a-zA-Z]*\s+)*(-[a-zA-Z]*\s+)*` + TARGET), 'recursive delete of your home folder or a filesystem root'],
  [/^(Remove-Item|rm|ri|del|erase|rd|rmdir)$/i, new RegExp(String.raw`^\S+\b[^;|&]*-Recurse[^;|&]*\s` + TARGET, 'i'), 'recursive delete of your home folder or a drive root'],
  [/^(Remove-Item|ri)$/i, new RegExp(String.raw`^\S+\s+(-(Path|LiteralPath)\s+)?` + TARGET + String.raw`[^;|&]*-Recurse`, 'i'), 'recursive delete of your home folder or a drive root'],
  [/^(rd|rmdir)$/i, new RegExp(String.raw`^\S+\s+/s\b[^;|&]*\s` + TARGET, 'i'), 'recursive delete of your home folder or a drive root'],
  [/^(mkfs(\.\w+)?|diskpart)$/i, /^/, 'disk formatting'],
  [/^dd$/, /\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/, 'raw write to a disk device'],
  [/^format$/i, /^format\s+[a-z]:/i, 'disk formatting'],
  [/^(chmod|chown)$/, /^(chmod\s+-R\s+[0-7]{3,4}|chown\s+-R\s+\S+)\s+\/(\s|$)/, 'recursive permission change on /'],
];
const SHELLS = /^(sh|bash|zsh|dash|ksh|fish)$/, PWSH = /^(powershell|pwsh)(\.exe)?$/i, CMDEXE = /^cmd(\.exe)?$/i;
const PREFIXES = /^(sudo|doas|command|env|nohup|time|exec|nice|xargs)$/;
// quote-aware split on && || ; | & and newlines
function segments(cmd) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') { if (cur.trim()) out.push(cur.trim()); cur = ''; if ((c === '|' || c === '&') && cmd[i + 1] === c) i++; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// second quoted form: PowerShell/cmd, where \" is not an escape (e.g. "... C:\")
const tokens = s => (s.match(/"(?:[^"\\]|\\.)*"|"[^"]*"|'[^']*'|[^\s]+/g) || []).map(w => w.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1'));
function blockReason(cmd, depth = 0) {
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(cmd)) return 'fork bomb';
  for (const seg of segments(cmd)) {
    let t = tokens(seg);
    while (t.length && (PREFIXES.test(t[0]) || /^\w+=/.test(t[0]))) t = t.slice(1);
    if (!t.length) continue;
    const c0 = t[0].replace(/^.*[\\/]/, ''); // /bin/rm -> rm
    if (depth < 3) { // unwrap bash -c "…", powershell -Command "…", cmd /c …, eval …
      const ci = t.findIndex(w => w === '-c'), pi = t.findIndex(w => /^-(c|command)$/i.test(w)), ki = t.findIndex(w => /^\/c$/i.test(w));
      let inner = null;
      if (SHELLS.test(c0) && ci > 0) inner = t[ci + 1];
      else if (PWSH.test(c0) && pi > 0) inner = t.slice(pi + 1).join(' ');
      else if (CMDEXE.test(c0) && ki > 0) inner = t.slice(ki + 1).join(' ');
      else if (c0 === 'eval') inner = t.slice(1).join(' ');
      if (inner) { const r = blockReason(inner, depth + 1); if (r) return r; continue; }
    }
    const line = [c0, ...t.slice(1)].join(' ');
    for (const [cmdRe, re, why] of BLOCK) if (cmdRe.test(c0) && re.test(line)) return why;
  }
  return null;
}
const ASK = [
  [/\bgit\s+push\b[^;|&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, 'force-push rewrites remote history'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard discards uncommitted work'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean deletes untracked files'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'discards all uncommitted changes'],
  [/\bgit\s+(branch\s+-D|stash\s+(drop|clear))\b/, 'deletes a branch or stash'],
];
// SQL is usually quoted (psql -c "DROP TABLE x"), so look inside quotes when a database client runs
const SQL = /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i;
const DB_CLIENT = /\b(psql|mysql|mariadb|sqlite3|sqlcmd|duckdb|mongosh?|clickhouse-client|cockroach|supabase|prisma)\b/i;
const DESTRUCTIVE = /\b(rm|rmdir|unlink|shred|mv|truncate|Remove-Item|Move-Item|Clear-Content|Set-Content|Out-File|ri|del|erase|rd|move|ren|rename)\b|\bfind\b[^;|&]*\s-delete\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bgit\s+(reset|clean|checkout|restore|stash|rm|mv)\b|(^|[^0-9&>|])>\s*(?!\/dev\/null|&|\$null|nul\b)["']?[\w./~\\-]/i;

// Quoted text (grep patterns, commit messages, echo strings) shouldn't trigger snapshots or prompts.
const unquote = cmd => cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
function classify(cmd) {
  const why = blockReason(cmd); if (why) return { action: 'block', why };
  const bare = unquote(cmd);
  for (const [re, why] of ASK) if (re.test(bare)) return { action: 'ask', why };
  if (SQL.test(bare) || (DB_CLIENT.test(bare) && SQL.test(cmd))) return { action: 'ask', why: 'destructive SQL' };
  if (DESTRUCTIVE.test(bare)) return { action: 'snapshot' };
  return { action: 'none' };
}

// Split "cd x && rm a; mv b c | …" into segments, following cd, and return the existing paths that
// destructive segments act on (resolved against the folder they run in).
const DESTRUCTIVE_CMD = /^(sudo\s+)?(rm|rmdir|unlink|shred|mv|truncate|Remove-Item|ri|Move-Item|Clear-Content|Set-Content|del|erase|rd|move|ren|rename|sed|perl|find)$/i;
function destructiveTargets(cwd, cmd) {
  const words = s => (s.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) || []).map(w => w.replace(/^["']|["']$/g, ''));
  const resolve = (dir, p) => path.resolve(dir, p.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/^\$HOME(?=$|[\\/])/, os.homedir()));
  let dir = cwd; const out = new Set();
  for (const seg of cmd.split(/&&|\|\||;|\|(?!\|)|\n/)) {
    const w = words(seg.trim()); if (!w.length) continue;
    if (/^(cd|Set-Location|pushd)$/i.test(w[0]) && w[1]) { dir = resolve(dir, w[1]); continue; }
    const redirect = seg.match(/(?:^|[^0-9&>|])>\s*(?!\/dev\/null|&|\$null|nul\b)("[^"]+"|'[^']+'|[^\s;|&]+)/);
    if (redirect) out.add(resolve(dir, redirect[1].replace(/^["']|["']$/g, '')));
    const cmdWord = w[0] === 'sudo' ? w[1] : w[0];
    if (!cmdWord || !DESTRUCTIVE_CMD.test(cmdWord)) continue;
    for (const a of w.slice(w[0] === 'sudo' ? 2 : 1)) if (!a.startsWith('-') && !/^s[/|#]/.test(a) && !/[*?]/.test(a)) out.add(resolve(dir, a));
    if (w.some(a => /[*?]/.test(a))) out.add(dir); // globs: keep the folder they expand in
  }
  return { dir, targets: [...out] };
}

// ---------- snapshots ----------
const newId = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') + '-' + Math.random().toString(36).slice(2, 6);
function snapshotGit(cwd, id, cmd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']); if (top.status) return null;
  const repo = path.resolve(top.stdout.trim()), idx = path.join(os.tmpdir(), `cc-checkpoint-${id}.idx`), env = { GIT_INDEX_FILE: idx };
  try {
    const head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).stdout.trim();
    if (head) git(repo, ['read-tree', 'HEAD'], env);
    const add = git(repo, ['add', '-A', '--', '.'], env); if (add.status) return null;
    const tree = git(repo, ['write-tree'], env).stdout.trim(); if (!tree) return null;
    const c = git(repo, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `claude checkpoint before: ${cmd.slice(0, 200)}`],
      { GIT_AUTHOR_NAME: 'claude-checkpoint', GIT_AUTHOR_EMAIL: 'checkpoint@localhost', GIT_COMMITTER_NAME: 'claude-checkpoint', GIT_COMMITTER_EMAIL: 'checkpoint@localhost' });
    const sha = c.stdout.trim(); if (!sha) return null;
    git(repo, ['update-ref', `refs/claude-checkpoints/${id}`, sha]);
    return { kind: 'git', repo, ref: `refs/claude-checkpoints/${id}`, sha };
  } finally { fs.rmSync(idx, { force: true }); }
}
function snapshotCopy(cwd, id, cmd) {
  // copy the existing files/folders that destructive parts of the command act on
  const targets = destructiveTargets(cwd, cmd).targets.filter(p => { try { return fs.existsSync(p) && p !== path.parse(p).root && p !== os.homedir(); } catch { return false; } });
  if (!targets.length) return null;
  let size = 0; const sizeOf = p => { const st = fs.statSync(p); if (st.isFile()) return st.size; let s = 0; for (const e of fs.readdirSync(p)) { s += sizeOf(path.join(p, e)); if (s > MAX_COPY) break; } return s; };
  for (const t of targets) { size += sizeOf(t); if (size > MAX_COPY) return { kind: 'skipped', reason: `targets are over ${MAX_COPY / 1048576} MB` }; }
  const dir = path.join(STORE, id); fs.mkdirSync(dir, { recursive: true });
  const map = targets.map((t, i) => { const dst = path.join(dir, String(i)); fs.cpSync(t, dst, { recursive: true }); return { from: t, stored: dst }; });
  return { kind: 'copy', files: map };
}

function hook() {
  let input = ''; try { input = fs.readFileSync(0, 'utf8'); } catch {}
  let ev; try { ev = JSON.parse(input); } catch { process.exit(0); }
  const tool = ev.tool_name, cmd = ev.tool_input?.command;
  if (!['Bash', 'PowerShell'].includes(tool) || typeof cmd !== 'string') process.exit(0);
  const cwd = ev.cwd || process.cwd();
  const c = classify(cmd);
  if (c.action === 'block') {
    process.stderr.write(`bash-checkpoint blocked this command: ${c.why}. If you really need it, the user must run it themselves.\n`);
    process.exit(2); // exit 2 = block the tool call; stderr goes back to Claude
  }
  if (c.action === 'ask') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `bash-checkpoint: ${c.why}` } }));
    // fall through to also take a snapshot
  }
  if (c.action === 'snapshot' || c.action === 'ask') {
    const id = newId();
    let snap = null; try { const dir = destructiveTargets(cwd, cmd).dir; snap = snapshotGit(fs.existsSync(dir) ? dir : cwd, id, cmd) || snapshotCopy(cwd, id, cmd); } catch (e) { snap = { kind: 'error', reason: e.message }; }
    if (snap) {
      fs.mkdirSync(STORE, { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify({ id, time: new Date().toISOString(), cwd, tool, command: cmd.slice(0, 500), ...snap }) + '\n');
    }
  }
  process.exit(0);
}

// ---------- CLI ----------
const readLog = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'hook') hook();
else if (cmd === 'test') { const c = classify(rest.join(' ')); console.log(c.action + (c.why ? `: ${c.why}` : '')); }
else if (cmd === 'list') {
  const all = rest.includes('--all'), here = process.cwd();
  const rows = readLog().filter(r => all || (r.repo ? inside(here, r.repo) || inside(r.repo, here) : inside(here, r.cwd) || inside(r.cwd, here))).slice(-30);
  if (!rows.length) console.log(all ? 'no checkpoints yet' : 'no checkpoints for this folder (try --all)');
  for (const r of rows) console.log(`${r.id}  ${r.time.slice(0, 19).replace('T', ' ')}  [${r.kind}]  ${r.command.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '').slice(0, 90)}`);
} else if (cmd === 'show' || cmd === 'restore') {
  const r = readLog().find(x => x.id === rest[0]); if (!r) { console.log('unknown id; see: node checkpoint.mjs list --all'); process.exit(1); }
  if (r.kind === 'git') {
    if (cmd === 'show') { console.log(git(r.repo, ['diff', '--stat', r.sha]).stdout || 'no differences from the working tree'); process.exit(0); }
    const target = rest[1] ? path.relative(r.repo, path.resolve(rest[1])) || '.' : '.';
    const res = git(r.repo, ['restore', `--source=${r.sha}`, '--worktree', '--', target]);
    console.log(res.status ? '✘ ' + res.stderr.trim() : `✓ restored ${target} in ${r.repo} from checkpoint ${r.id}. Files created after the checkpoint were left alone.`);
  } else if (r.kind === 'copy') {
    for (const f of r.files) { if (cmd === 'show') { console.log(`${f.from}  ${fs.existsSync(f.from) ? '(exists now)' : '(missing now)'}`); continue; }
      if (rest[1] && norm(rest[1]) !== norm(f.from)) continue;
      fs.cpSync(f.stored, f.from, { recursive: true }); console.log(`✓ restored ${f.from}`); }
  } else console.log(`checkpoint ${r.id} has no data (${r.kind}${r.reason ? ': ' + r.reason : ''})`);
} else if (cmd === 'prune') {
  const keep = Number(rest[rest.indexOf('--keep') + 1]) || 50, rows = readLog(), drop = rows.slice(0, Math.max(0, rows.length - keep));
  for (const r of drop) { if (r.kind === 'git') git(r.repo, ['update-ref', '-d', r.ref]); if (r.kind === 'copy') fs.rmSync(path.join(STORE, r.id), { recursive: true, force: true }); }
  fs.writeFileSync(LOG, rows.slice(drop.length).map(r => JSON.stringify(r)).join('\n') + (rows.length > drop.length ? '\n' : ''));
  console.log(`pruned ${drop.length}, kept ${rows.length - drop.length}`);
} else console.log('usage: node checkpoint.mjs hook | list [--all] | show <id> | restore <id> [path] | prune [--keep N] | test "<command>"');
