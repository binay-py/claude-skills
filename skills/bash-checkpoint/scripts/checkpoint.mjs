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
const BLOCK = [
  [new RegExp(String.raw`\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+|-[a-zA-Z]*f[a-zA-Z]*\s+)*(-[a-zA-Z]*\s+)*` + TARGET), 'recursive delete of your home folder or a filesystem root'],
  [new RegExp(String.raw`\b(Remove-Item|rm|ri|del|rd|rmdir)\b[^;|&]*-Recurse[^;|&]*\s` + TARGET, 'i'), 'recursive delete of your home folder or a drive root'],
  [new RegExp(String.raw`\b(Remove-Item|ri)\s+` + TARGET + String.raw`[^;|&]*-Recurse`, 'i'), 'recursive delete of your home folder or a drive root'],
  [new RegExp(String.raw`\b(rd|rmdir)\s+/s\b[^;|&]*\s` + TARGET, 'i'), 'recursive delete of your home folder or a drive root'],
  [/\bmkfs(\.\w+)?\b|\bdd\b[^;|&]*\bof=\/dev\/(sd|nvme|disk|hd)|\bdiskpart\b|\bformat\s+[a-z]:/i, 'disk formatting / raw disk write'],
  [/\bchmod\s+-R\s+[0-7]{3,4}\s+\/(\s|$)|\bchown\s+-R\s+\S+\s+\/(\s|$)/, 'recursive permission change on /'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
];
const ASK = [
  [/\bgit\s+push\b[^;|&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, 'force-push rewrites remote history'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard discards uncommitted work'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean deletes untracked files'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'discards all uncommitted changes'],
  [/\bgit\s+(branch\s+-D|stash\s+(drop|clear))\b/, 'deletes a branch or stash'],
  [/\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, 'destructive SQL'],
];
const DESTRUCTIVE = /\b(rm|rmdir|unlink|shred|mv|truncate|Remove-Item|Move-Item|Clear-Content|Set-Content|Out-File|ri|del|erase|rd|move|ren|rename)\b|\bfind\b[^;|&]*\s-delete\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bgit\s+(reset|clean|checkout|restore|stash|rm|mv)\b|(^|[^0-9&>|])>\s*(?!\/dev\/null|&|\$null|nul\b)["']?[\w./~\\-]/i;

function classify(cmd) {
  for (const [re, why] of BLOCK) if (re.test(cmd)) return { action: 'block', why };
  for (const [re, why] of ASK) if (re.test(cmd)) return { action: 'ask', why };
  if (DESTRUCTIVE.test(cmd)) return { action: 'snapshot' };
  return { action: 'none' };
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
  // copy existing paths that appear as arguments in the command
  const args = (cmd.match(/"[^"]+"|'[^']+'|[^\s;|&]+/g) || []).map(a => a.replace(/^["']|["']$/g, '')).filter(a => !a.startsWith('-') && !/^(rm|mv|del|rd|rmdir|Remove-Item|Move-Item|sudo|sed|find|git)$/i.test(a));
  const targets = [...new Set(args.map(a => path.resolve(cwd, a.replace(/^~(?=$|[\\/])/, os.homedir()))))].filter(p => { try { return fs.existsSync(p) && p !== path.parse(p).root && p !== os.homedir(); } catch { return false; } });
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
    let snap = null; try { snap = snapshotGit(cwd, id, cmd) || snapshotCopy(cwd, id, cmd); } catch (e) { snap = { kind: 'error', reason: e.message }; }
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
  for (const r of rows) console.log(`${r.id}  ${r.time.slice(0, 19).replace('T', ' ')}  [${r.kind}]  ${r.command.slice(0, 90)}`);
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
