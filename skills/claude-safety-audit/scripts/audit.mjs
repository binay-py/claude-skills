#!/usr/bin/env node
// claude-safety-audit — find the risky things Claude Code setups accumulate:
//   * secrets saved into permission rules by "Yes, and don't ask again" (tokens, keys, passwords in commands)
//   * .claude/settings.local.json or .mcp.json with secrets that git tracks, or that sit in git history
//   * over-broad allow rules (Bash(*), rm, sudo, force-push, curl | sh) and disabled safety prompts
//   * no deny rules for catastrophic commands
// Zero dependencies. Node 22+. Read-only unless --apply.
//
//   node audit.mjs                       audit ~/.claude + every repo under the current folder (depth 4)
//   node audit.mjs --root ~/code         where to look for projects (repeatable)
//   node audit.mjs --fix                 show the fixes it would make
//   node audit.mjs --fix --apply         make them (backs up every file it touches)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const roots = []; for (let i = 0; i < argv.length; i++) if (argv[i] === '--root') roots.push(path.resolve(argv[++i].replace(/^~/, os.homedir())));
if (!roots.length) roots.push(process.cwd());
const FIX = argv.includes('--fix'), APPLY = argv.includes('--apply');
const HOME = path.join(os.homedir(), '.claude');

const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'], [/\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}/, 'OpenAI-style key'],
  [/\b[sr]k_live_[0-9a-zA-Z]{16,}/, 'Stripe live key'], [/\bwhsec_[0-9a-zA-Z]{20,}/, 'Stripe webhook secret'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'], [/\bgh[pousr]_[0-9A-Za-z]{30,}/, 'GitHub token'], [/\bgithub_pat_[0-9A-Za-z_]{40,}/, 'GitHub token'],
  [/\bglpat-[0-9A-Za-z_-]{20,}/, 'GitLab token'], [/\bxox[abprs]-[0-9A-Za-z-]{10,}/, 'Slack token'], [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bnpm_[0-9A-Za-z]{36}\b/, 'npm token'], [/\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{16,}/, 'Resend key'], [/\bhf_[0-9A-Za-z]{30,}/, 'Hugging Face token'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]{3,}@/, 'database URL with password'],
  [/https?:\/\/[^\s:@/]+:[^\s@/]{6,}@/, 'URL with embedded password'],
  [/\b(?:authorization|x-api-key|api-key)\s*:\s*(?:bearer\s+)?[A-Za-z0-9._~+/=-]{20,}/i, 'auth header'],
  [/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"'$]{8,}/i, 'secret assigned in command'],
  [/--(?:password|token|api-key|secret)[= ]["']?[^\s"'$]{8,}/i, 'secret passed as a flag'],
];
const findSecret = s => { for (const [re, what] of SECRETS) { const m = s.match(re); if (m) return { what, sample: m[0].slice(0, 6) + '…' }; } return null; };
const DANGEROUS_ALLOW = [
  [/^Bash(\(\*\)|\(:\*\))?$/, 'allows EVERY shell command without asking'],
  [/^Bash\((sudo|doas)\b/, 'allows sudo'],
  [/^Bash\(rm\b(?!.*node_modules|.*dist|.*build)/, 'allows rm without asking'],
  [/^Bash\(.*git push.*(--force|-f\b)/, 'allows force-push'], [/^Bash\(git push:\*\)/, 'allows any git push (including --force)'],
  [/^Bash\(.*git (reset --hard|clean -[a-z]*f)/, 'allows discarding uncommitted work'],
  [/^Bash\((curl|wget|iwr|irm)\b.*\|\s*(ba|z)?sh/, 'allows piping downloads into a shell'],
  [/^Bash\((chmod|chown) -R/, 'allows recursive permission changes'],
  [/^Bash\((dd|mkfs|format|diskpart)\b/, 'allows disk-level commands'],
  [/^Bash\((Remove-Item|del|rmdir|rd)\b/i, 'allows deleting files without asking (Windows)'],
  [/^PowerShell(\(\*\))?$/, 'allows EVERY PowerShell command without asking'],
  [/^Write(\(\*\*?\))?$|^Edit(\(\*\*?\))?$/, 'allows writing ANY file, including outside the project'],
];
const RECOMMENDED_DENY = [
  'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)', 'Bash(rm -rf $HOME:*)', 'Bash(rm -rf /*:*)', 'Bash(sudo rm:*)',
  'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git reset --hard:*)', 'Bash(git clean -fdx:*)',
  'Bash(mkfs:*)', 'Bash(dd if=:*)', 'Bash(chmod -R 777 /:*)', 'Bash(diskpart:*)', 'Bash(format:*)',
  'Read(./.env)', 'Read(./.env.*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)',
];

const findings = []; // {sev, where, msg, fix?}
const add = (sev, where, msg, fix) => findings.push({ sev, where, msg, fix });
const short = p => p.replace(os.homedir(), '~').split(path.sep).join('/');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { add('medium', short(f), `not valid JSON (${e.message.slice(0, 60)}): Claude Code ignores it`); return null; } };

function auditSettings(file, { userLevel }) {
  const s = readJson(file); if (!s) return;
  const where = short(file), perms = s.permissions || {};
  for (const [i, rule] of (perms.allow || []).entries()) {
    const sec = findSecret(rule);
    if (sec) add('high', where, `permissions.allow[${i}] contains a ${sec.what} (${sec.sample}), probably saved by "Yes, and don't ask again"`, { file, type: 'remove-allow', rule });
    for (const [re, why] of DANGEROUS_ALLOW) if (re.test(rule)) add(/EVERY|sudo|force|disk|piping/.test(why) ? 'high' : 'medium', where, `allow rule "${rule}" ${why}`);
  }
  if (perms.defaultMode === 'bypassPermissions') add('high', where, 'defaultMode is "bypassPermissions": Claude never asks before running anything');
  if (s.skipDangerousModePermissionPrompt) add('low', where, 'skipDangerousModePermissionPrompt is on: the warning before bypass mode is hidden');
  if (perms.additionalDirectories?.some(d => /^(\/|~|[A-Z]:\\?)$/i.test(d.trim()))) add('high', where, 'additionalDirectories includes a filesystem or home root');
  if (userLevel) {
    const deny = new Set(perms.deny || []);
    const missing = RECOMMENDED_DENY.filter(r => !deny.has(r));
    if (missing.length === RECOMMENDED_DENY.length) add('medium', where, 'no deny rules: nothing stops a catastrophic command like rm -rf ~ or git push --force', { file, type: 'add-deny', rules: missing });
    else if (missing.length) add('low', where, `${missing.length} recommended deny rules missing`, { file, type: 'add-deny', rules: missing });
    const hookCmds = JSON.stringify(s.hooks?.PreToolUse || []);
    if (!/checkpoint|guard|block|safety/i.test(hookCmds)) add('info', where, 'no PreToolUse safety hook: add the bash-checkpoint hook to snapshot files before destructive commands');
  }
}

function auditMcp(file) {
  const raw = fs.readFileSync(file, 'utf8'); const sec = findSecret(raw);
  if (sec) add('medium', short(file), `MCP config contains a ${sec.what} (${sec.sample}). Use "\${ENV_VAR}" references instead of literal keys`);
  return !!sec;
}

function auditRepoFile(repo, rel, hasSecret) {
  const tracked = git(repo, 'ls-files', '--error-unmatch', rel).status === 0;
  const ignored = git(repo, 'check-ignore', '-q', rel).status === 0;
  const history = git(repo, 'log', '--all', '--format=%h %ad', '--date=short', '--', rel).stdout.trim().split('\n').filter(Boolean);
  const remote = git(repo, 'remote', 'get-url', 'origin').stdout.trim();
  const where = short(path.join(repo, rel));
  if (tracked) add(hasSecret ? 'high' : 'medium', where, `is committed to git${remote ? ` (remote: ${remote.replace(/\/\/[^@]+@/, '//')})` : ''}${hasSecret ? ' AND contains a secret: rotate that key now, removing the file does not remove it from history' : ''}`,
    rel.endsWith('settings.local.json') ? { repo, type: 'untrack', rel } : null);
  else if (history.length) add(hasSecret ? 'high' : 'medium', where, `was committed in the past (${history.length} commit(s), latest ${history[0]}). Older versions are still in history${remote ? ' and on ' + remote.replace(/\/\/[^@]+@/, '//') : ''}; rotate any key it ever held`);
  if (!ignored && rel.endsWith('settings.local.json')) add('medium', where, 'is not in .gitignore: the next "git add ." will commit it', { repo, type: 'gitignore', rel });
}

function findRepos(root, depth = 4) {
  const out = [];
  (function rec(d, n) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.name === '.git')) out.push(d);
    if (n === 0) return;
    for (const e of ents) if (e.isDirectory() && !/^(node_modules|\.git|AppData|Library|\.cache|\.npm|dist|build|\.next|vendor|venv|\.venv|__pycache__)$/.test(e.name) && !(e.name.startsWith('.') && e.name !== '.claude')) rec(path.join(d, e.name), n - 1);
  })(root, depth);
  return out;
}

// ---------- run ----------
for (const f of ['settings.json', 'settings.local.json']) { const p = path.join(HOME, f); if (fs.existsSync(p)) auditSettings(p, { userLevel: f === 'settings.json' }); }
if (!fs.existsSync(path.join(HOME, 'settings.json'))) add('medium', '~/.claude/settings.json', 'missing: no user-level deny rules', { file: path.join(HOME, 'settings.json'), type: 'add-deny', rules: RECOMMENDED_DENY });
const repos = [...new Set(roots.flatMap(r => findRepos(r)))];
for (const repo of repos) {
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const p = path.join(repo, rel); if (!fs.existsSync(p)) continue;
    auditSettings(p, { userLevel: false });
    const hasSecret = !!findSecret(fs.readFileSync(p, 'utf8'));
    auditRepoFile(repo, rel, hasSecret);
  }
  const mcp = path.join(repo, '.mcp.json');
  if (fs.existsSync(mcp)) { const s = auditMcp(mcp); if (s) auditRepoFile(repo, '.mcp.json', true); }
}
const userMcp = path.join(os.homedir(), '.claude.json');
if (fs.existsSync(userMcp)) { const raw = fs.readFileSync(userMcp, 'utf8'); const sec = findSecret(raw); if (sec) add('info', '~/.claude.json', `contains a ${sec.what} (${sec.sample}) in MCP/env config. Fine locally, but keep this file out of dotfile repos and cloud-synced folders`); }

// ---------- report ----------
const ORDER = { high: 0, medium: 1, low: 2, info: 3 }, ICON = { high: '✘', medium: '!', low: '·', info: 'i' };
findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev]);
console.log(`claude-safety-audit: ~/.claude + ${repos.length} git repo(s) under ${roots.map(short).join(', ')}\n`);
if (!findings.length) console.log('✓ nothing risky found');
for (const f of findings) console.log(`${ICON[f.sev]} [${f.sev}] ${f.where}\n    ${f.msg}`);
const count = s => findings.filter(f => f.sev === s).length;
console.log(`\n${count('high')} high · ${count('medium')} medium · ${count('low')} low · ${count('info')} info`);

// ---------- fixes ----------
const fixes = findings.map(f => f.fix).filter(Boolean);
if (!FIX) { if (fixes.length) console.log(`\n${fixes.length} fix(es) available: re-run with --fix to preview, --fix --apply to make them.`); process.exit(count('high') ? 1 : 0); }
const backup = f => { if (fs.existsSync(f)) { const b = `${f}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`; fs.copyFileSync(f, b); return b; } };
const byFile = new Map();
for (const fx of fixes) {
  if (fx.type === 'remove-allow' || fx.type === 'add-deny') { const e = byFile.get(fx.file) || { remove: [], deny: [] }; fx.type === 'remove-allow' ? e.remove.push(fx.rule) : e.deny.push(...fx.rules); byFile.set(fx.file, e); }
}
console.log(`\n${APPLY ? 'Applying' : 'Would apply'} (dry run unless --apply):`);
for (const [file, e] of byFile) {
  for (const r of e.remove) console.log(`  - remove allow rule from ${short(file)}: ${findSecret(r) ? r.replace(findSecret(r) && new RegExp(SECRETS.find(([re]) => re.test(r))[0].source), m => m.slice(0, 6) + '…[redacted]') : r}`.slice(0, 220));
  if (e.deny.length) console.log(`  - add ${e.deny.length} deny rules to ${short(file)}: ${e.deny.slice(0, 4).join(', ')}…`);
  if (APPLY) {
    const b = backup(file); const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    s.permissions ||= {};
    if (e.remove.length) s.permissions.allow = (s.permissions.allow || []).filter(r => !e.remove.includes(r));
    if (e.deny.length) s.permissions.deny = [...new Set([...(s.permissions.deny || []), ...e.deny])];
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n'); console.log(`    ✓ written${b ? ` (backup: ${short(b)})` : ''}`);
  }
}
for (const fx of fixes.filter(f => f.type === 'gitignore')) {
  console.log(`  - add ".claude/settings.local.json" to ${short(path.join(fx.repo, '.gitignore'))}`);
  if (APPLY) { const gi = path.join(fx.repo, '.gitignore'); const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : ''; fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.claude/settings.local.json\n'); console.log('    ✓ written'); }
}
for (const fx of fixes.filter(f => f.type === 'untrack')) {
  console.log(`  - stop tracking ${fx.rel} in ${short(fx.repo)} (git rm --cached; your local file stays)`);
  if (APPLY) { const r = git(fx.repo, 'rm', '--cached', '--quiet', fx.rel); console.log(r.status === 0 ? '    ✓ untracked. Commit this change; secrets in old commits still need rotating.' : '    ✘ ' + r.stderr.trim()); }
}
if (!APPLY) console.log('\nNothing changed. Re-run with --fix --apply to make these changes.');
