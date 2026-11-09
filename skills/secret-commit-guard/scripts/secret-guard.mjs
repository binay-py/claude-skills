#!/usr/bin/env node
// secret-guard — a git pre-commit hook that blocks commits containing API keys, tokens, passwords and
// private keys. Works in any git repo. Zero dependencies. Node 22+.
//
//   node secret-guard.mjs install          add the pre-commit hook to the current repo (chains an existing hook)
//   node secret-guard.mjs uninstall        remove it (and put a chained hook back)
//   node secret-guard.mjs scan-staged      scan the added lines of the staged diff (what the hook runs)
//   node secret-guard.mjs scan [path]      scan files git tracks in the working tree
//   node secret-guard.mjs scan-history     scan every commit on every branch (git log -p --all)
//   node secret-guard.mjs test "<line>"    show what the rules say about one line
//
// False positives: put `secret-guard: allow` in a comment on the line, or add a glob to .secret-guard-ignore.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MARK = '# secret-commit-guard hook';
const CHAINED = 'pre-commit.secret-guard-chained';
const MAX_FILE = 2 * 1024 * 1024, MAX_LINE = 4000;

// ---------- rules ----------
// [regex, type, {generic}] — prefix rules only skip values containing "EXAMPLE" (AWS's documented key);
// generic rules also skip placeholders, variable references and low-entropy values.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/, 'private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/, 'OpenAI API key'],
  [/\b[sr]k_live_[0-9a-zA-Z]{16,}/, 'Stripe live key'], [/\bwhsec_[0-9a-zA-Z]{20,}/, 'Stripe webhook secret'],
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/, 'AWS access key ID'],
  [/\baws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}\b/i, 'AWS secret access key'],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/, 'GitHub token'], [/\bgithub_pat_[0-9A-Za-z_]{40,}/, 'GitHub token'],
  [/\bglpat-[0-9A-Za-z_-]{20,}/, 'GitLab token'],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}/, 'Slack token'], [/https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/, 'Slack webhook URL'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'], [/\bGOCSPX-[0-9A-Za-z_-]{20,}/, 'Google OAuth client secret'],
  [/\bnpm_[0-9A-Za-z]{36}\b/, 'npm token'], [/\bpypi-AgEIcHlwaS5vcmc[0-9A-Za-z_-]{40,}/, 'PyPI token'],
  [/\bhf_[0-9A-Za-z]{30,}/, 'Hugging Face token'], [/\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{16,}/, 'Resend key'],
  [/\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/, 'SendGrid key'], [/\bgsk_[0-9A-Za-z]{48}\b/, 'Groq key'],
  [/\bdop_v1_[0-9a-f]{64}\b/, 'DigitalOcean token'], [/\bshp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}\b/, 'Shopify token'],
  [/\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/, 'Telegram bot token'],
  [/AccountKey=[A-Za-z0-9+/]{80,}={0,2}/, 'Azure storage key'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s:@/'"]+:([^\s@/'"]{3,})@/, 'database URL with password', { generic: true }],
  [/\bhttps?:\/\/[^\s:@/'"]+:([^\s@/'"]{6,})@/, 'URL with embedded password', { generic: true }],
  [/\b(?:authorization|x-api-key|api-key)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+|token\s+)?([A-Za-z0-9._~+/=-]{20,})/i, 'auth header', { generic: true }],
  [/--(?:password|token|api-key|secret)[= ]["']?([^\s"'$]{8,})/i, 'secret passed as a flag', { generic: true }],
  // ENV-style: UPPER_CASE name with TOKEN/SECRET/PASSWORD/API_KEY…, then = or ": "
  [/(?:^|[\s;,{(])(?:export\s+)?["']?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY)[A-Z0-9_]*["']?\s*(?:=|:\s)\s*["']?([^\s"'#,;]{8,})/, 'secret assigned to a variable', { generic: true }],
  // any-case name containing key/secret/token/password with a quoted high-entropy literal
  [/[A-Za-z0-9_]*(?:key|secret|token|passw(?:or)?d|pwd)[A-Za-z0-9_]*["']?\s*(?::|=|=>|:=)\s*[rbf]?["'`]([A-Za-z0-9+/=_.-]{16,})["'`]/i, 'high-entropy string assigned to a secret-like name', { generic: true, entropy: true }],
];
const PLACEHOLDER = /example|sample|placeholder|your[_-]?|changeme|change[_-]me|dummy|redacted|replace|insert|fixme|todo|xxxx|\*\*\*|<|>|\$\{|\{\{|%\(|^\{[A-Za-z0-9_]+\}$|^(x+|0+|\.+|-+)$|^(password|pass|pwd|secret|token|user|username|admin|root|test|testing)$/i;
// values that are references to something else, not a literal secret
const REFERENCE = /^\$|^%|^[/\\.~[]|^[A-Z_][A-Z0-9_]*$|^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$|\(|process\.env|os\.environ|getenv|ENV\[|secrets\.|^(true|false|null|none|undefined|required|optional|True|False|None|NULL|nil)$|^\d+$|^[a-z][a-z0-9+.-]*:\/\//;
function entropy(s) { const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1; return Object.values(f).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0); }
function highEntropy(v) {
  if (!/[A-Za-z]/.test(v) || (v.match(/\d/g) || []).length < 2) return false;
  if (/^[a-z0-9]+([-_.][a-z0-9]+)+$/i.test(v) && !/[A-Za-z0-9]{16,}/.test(v)) return false; // slug like user-profile-v2
  if (/^[0-9a-f]+$/i.test(v)) return v.length >= 32 && entropy(v) >= 3.0;
  return v.length >= 20 && entropy(v) >= 3.7;
}
export function findSecret(line) {
  if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE);
  if (/secret-guard:\s*allow/i.test(line)) return null;
  for (const [re, type, o = {}] of SECRETS) {
    const m = line.match(re); if (!m) continue;
    const value = m[1] ?? m[0];
    if (/example/i.test(value)) continue;
    if (type === 'private key') { // a one-line "BEGIN…XXXX…END" in docs is a placeholder; real keys are long
      const end = line.indexOf('-----END', m.index); const body = end > 0 ? line.slice(m.index + m[0].length, end) : '';
      if (end > 0 && (body.length < 200 || /x{4}|\.\.\./i.test(body))) continue;
    }
    if (o.generic && (PLACEHOLDER.test(value) || REFERENCE.test(value))) continue;
    if (o.entropy && !highEntropy(value)) continue;
    const at = m.index + m[0].indexOf(value);
    return { type, sample: line.slice(at, at + 6) + '…' };
  }
  return null;
}
// files that should never be committed, whatever they contain
const SENSITIVE_FILES = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$|dist$|defaults?$|schema$)[^/]+)?$/i, 'environment file (.env)'],
  [/\.(pem|key)$/i, 'private key / certificate file'], [/\.(p12|pfx)$/i, 'PKCS#12 key bundle'], [/\.(jks|keystore)$/i, 'Java keystore'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, 'SSH private key'],
];
const sensitiveFile = f => SENSITIVE_FILES.find(([re]) => re.test(f))?.[1] || null;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json|flake\.lock)$/;

// ---------- ignore file ----------
function globRe(g) {
  let s = g.trim().replace(/\\/g, '/'); const dir = s.endsWith('/'); if (dir) s = s.slice(0, -1);
  const anchored = s.includes('/'); s = s.replace(/^\//, '');
  const body = s.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp((anchored ? '^' : '(^|/)') + body + (dir ? '/' : '(/|$)'));
}
function loadIgnore(root) {
  try { return fs.readFileSync(path.join(root, '.secret-guard-ignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(globRe); }
  catch { return []; }
}
const skipFile = (f, ignore) => LOCKFILES.test(f) || ignore.some(re => re.test(f));

// ---------- git helpers ----------
const git = (args, cwd = process.cwd()) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
function repoRoot() { const r = git(['rev-parse', '--show-toplevel']); if (r.status) { console.error('secret-guard: not inside a git repository'); process.exit(1); } return r.stdout.trim(); }
const unq = p => p.startsWith('"') ? p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : p;

// parse unified diff (-U0) text, calling onLine(file, lineNo, text) for each added line
function diffParser(onAdd, onFile) {
  let file = null, ln = 0, isNew = false;
  return line => {
    if (line.startsWith('diff --git ')) { const m = line.match(/^diff --git "?a\/.*?"? "?b\/(.*?)"?$/); file = m ? m[1] : null; isNew = false; ln = 0; return; }
    if (line.startsWith('new file mode')) { isNew = true; return; }
    if (line.startsWith('+++ ')) { const p = unq(line.slice(4).replace(/\t$/, '')) /* git appends a tab to paths with spaces */; if (p !== '/dev/null') file = p.replace(/^b\//, ''); onFile?.(file, isNew); return; }
    if (line.startsWith('Binary files ')) { onFile?.(file, isNew); return; }
    if (line.startsWith('@@')) { const m = line.match(/\+(\d+)/); ln = m ? +m[1] : 0; return; }
    if (line.startsWith('+') && file) { onAdd(file, ln, line.slice(1)); ln++; }
  };
}

// ---------- scans ----------
function scanStaged() {
  const root = repoRoot(), ignore = loadIgnore(root), hits = [];
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root).stdout.split('\0').filter(Boolean);
  for (const f of names) { const why = sensitiveFile(f); if (why && !ignore.some(re => re.test(f))) hits.push({ file: f, line: null, type: why, sample: '' }); }
  const d = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-filter=ACMR'], root);
  if (d.status) { console.error('secret-guard: git diff failed, commit allowed: ' + d.stderr.trim()); return 0; }
  const parse = diffParser((file, ln, text) => {
    if (skipFile(file, ignore) || hits.some(h => h.file === file && h.line === null)) return;
    const s = findSecret(text); if (s) hits.push({ file, line: ln, ...s });
  });
  for (const l of d.stdout.split('\n')) parse(l.replace(/\r$/, ''));
  if (!hits.length) return 0;
  console.error(`\nsecret-guard: commit blocked — ${hits.length} possible secret${hits.length > 1 ? 's' : ''} in staged changes:\n`);
  for (const h of hits) console.error(`  ${(h.line ? `${h.file}:${h.line}` : h.file).padEnd(40)} ${h.type}${h.sample ? `  (${h.sample})` : ''}`);
  console.error(`
How to fix:
  - Remove the secret from the file and read it from an environment variable or a secret manager.
  - Unstage a file that shouldn't be committed:  git reset HEAD <file>   (then add it to .gitignore)
  - False positive: add a comment containing "secret-guard: allow" on that line,
    or add the file's path or a glob to .secret-guard-ignore in the repo root.
  - git commit --no-verify skips this check. Only use it if you are certain.
If this secret was ever pushed or shared, rotate it at the provider; deleting it from git is not enough.
`);
  return 1;
}

function scanTree(target) {
  const root = repoRoot(), ignore = loadIgnore(root), hits = [];
  const rel = target ? path.relative(root, path.resolve(target)).split(path.sep).join('/') : '';
  const files = git(['ls-files', '-z', '--', rel || '.'], root).stdout.split('\0').filter(Boolean);
  for (const f of files) {
    if (skipFile(f, ignore)) continue;
    const why = sensitiveFile(f); if (why) { hits.push({ file: f, line: null, type: why + ' tracked by git', sample: '' }); continue; }
    let buf; try { const st = fs.statSync(path.join(root, f)); if (!st.isFile() || st.size > MAX_FILE) continue; buf = fs.readFileSync(path.join(root, f)); } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    buf.toString('utf8').split(/\r?\n/).forEach((text, i) => { const s = findSecret(text); if (s) hits.push({ file: f, line: i + 1, ...s }); });
  }
  for (const h of hits) console.log(`${(h.line ? `${h.file}:${h.line}` : h.file).padEnd(40)} ${h.type}${h.sample ? `  (${h.sample})` : ''}`);
  console.log(hits.length ? `\n${hits.length} possible secret(s) in ${new Set(hits.map(h => h.file)).size} file(s).` : `No secrets found in ${files.length} tracked file(s).`);
  return hits.length ? 1 : 0;
}

async function scanHistory() {
  const root = repoRoot(), ignore = loadIgnore(root), hits = [], seen = new Set();
  const p = spawn('git', ['-c', 'core.quotepath=off', 'log', '-p', '--exclude=refs/claude-checkpoints/*', '--all', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--format=@@COMMIT %h %ad %s', '--date=short'], { cwd: root });
  let commit = '';
  const add = (file, line, type, sample) => { const k = `${file}|${type}|${sample}`; if (seen.has(k)) return; seen.add(k); hits.push({ commit, file, line, type, sample }); };
  const parse = diffParser((file, ln, text) => { if (skipFile(file, ignore)) return; const s = findSecret(text); if (s) add(file, ln, s.type, s.sample); },
    (file, isNew) => { if (isNew && file) { const why = sensitiveFile(file); if (why && !ignore.some(re => re.test(file))) add(file, null, why + ' committed', ''); } });
  const rl = readline.createInterface({ input: p.stdout, crlfDelay: Infinity });
  for await (const l of rl) { if (l.startsWith('@@COMMIT ')) { commit = l.slice(9, 90); continue; } parse(l); }
  // git log is newest first, so `seen` keeps the newest commit that added each secret; list oldest first
  hits.reverse();
  for (const h of hits) console.log(`${h.commit.split(' ')[0]}  ${(h.line ? `${h.file}:${h.line}` : h.file).padEnd(38)} ${h.type}${h.sample ? `  (${h.sample})` : ''}   ${h.commit.split(' ').slice(1).join(' ').slice(0, 50)}`);
  console.log(hits.length ? `\n${hits.length} possible secret(s) in history. Anything pushed must be rotated; then clean history with git filter-repo or BFG if needed.` : 'No secrets found in history.');
  return hits.length ? 1 : 0;
}

// ---------- install / uninstall ----------
function hooksDir(root) {
  const hp = git(['config', '--get', 'core.hooksPath'], root).stdout.trim();
  if (hp) return { custom: hp };
  return { dir: path.resolve(root, git(['rev-parse', '--git-path', 'hooks'], root).stdout.trim()) };
}
const HOOK = `#!/bin/sh
${MARK} (installed by secret-guard.mjs; remove with: node <path>/secret-guard.mjs uninstall)
HOOK_DIR="$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  node "$HOOK_DIR/secret-guard.mjs" scan-staged || exit 1
else
  echo "secret-guard: node not found on PATH, secret scan skipped" >&2
fi
if [ -f "$HOOK_DIR/${CHAINED}" ]; then
  "$HOOK_DIR/${CHAINED}" "$@" || exit $?
fi
exit 0
`;
function install() {
  const root = repoRoot(), h = hooksDir(root);
  if (h.custom) {
    console.log(`This repo uses core.hooksPath = ${h.custom} (husky, lefthook or similar), so .git/hooks is ignored.\nAdd this line to that pre-commit hook instead:\n  node "${fileURLToPath(import.meta.url).split(path.sep).join('/')}" scan-staged || exit 1`);
    return 1;
  }
  fs.mkdirSync(h.dir, { recursive: true });
  const hook = path.join(h.dir, 'pre-commit'), chained = path.join(h.dir, CHAINED);
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : null;
  if (existing && !existing.includes(MARK)) {
    if (fs.existsSync(chained)) { console.error(`secret-guard: both pre-commit and ${CHAINED} exist; resolve that by hand first.`); return 1; }
    fs.renameSync(hook, chained);
    console.log(`Kept your existing pre-commit hook as ${CHAINED}; it still runs after the secret scan.`);
  }
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(h.dir, 'secret-guard.mjs'));
  fs.writeFileSync(hook, HOOK); fs.chmodSync(hook, 0o755);
  console.log(`${existing?.includes(MARK) ? 'Updated' : 'Installed'} secret-guard pre-commit hook in ${h.dir}`);
  return 0;
}
function uninstall() {
  const root = repoRoot(), h = hooksDir(root);
  if (h.custom) { console.log(`core.hooksPath is set (${h.custom}); remove the secret-guard line from that hook by hand.`); return 1; }
  const hook = path.join(h.dir, 'pre-commit'), chained = path.join(h.dir, CHAINED);
  if (!fs.existsSync(hook) || !fs.readFileSync(hook, 'utf8').includes(MARK)) { console.log('No secret-guard hook installed here; nothing changed.'); return 0; }
  fs.rmSync(hook); fs.rmSync(path.join(h.dir, 'secret-guard.mjs'), { force: true });
  if (fs.existsSync(chained)) { fs.renameSync(chained, hook); console.log('Removed secret-guard and restored your previous pre-commit hook.'); }
  else console.log('Removed the secret-guard pre-commit hook.');
  return 0;
}

const [mode, ...args] = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const run = { install, uninstall, 'scan-staged': scanStaged, scan: () => scanTree(args[0]), 'scan-history': scanHistory,
    test: () => { const s = findSecret(args.join(' ')); const f = sensitiveFile(args.join(' ')); console.log(s ? `${s.type} (${s.sample})` : f ? `sensitive file: ${f}` : 'clean'); return s || f ? 1 : 0; } }[mode];
  if (!run) { console.log('usage: node secret-guard.mjs install | uninstall | scan-staged | scan [path] | scan-history | test "<line or filename>"'); process.exit(1); }
  Promise.resolve(run()).then(c => process.exit(c ?? 0), e => { console.error('secret-guard error: ' + e.message); process.exit(mode === 'scan-staged' ? 0 : 1); });
}
