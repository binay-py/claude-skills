// node tests/run.mjs — rule cases (cases.txt) plus end-to-end tests in throwaway git repos.
// Fake secrets are assembled here at runtime so no literal token is ever committed to this repo.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = p => fileURLToPath(new URL(p, import.meta.url));
const script = here('../scripts/secret-guard.mjs');
const { findSecret } = await import(pathToFileURL(script).href);
let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('✘ ' + msg); } };

const r = (k, len, set = 'aB3xY9kLmN2pQ7rS5tUvW4zC8dE6fG1hJ0') => Array.from({ length: len }, (_, i) => set[(i * 7 + k) % set.length]).join('');
const FAKE = {
  GH: 'ghp_' + 'A'.repeat(36), GHPAT: 'github' + '_pat_' + r(1, 50), AKIA: 'AKIA' + 'QWERTYUIOPASDFGH', AWSSECRET: r(2, 40),
  ANT: 'sk-' + 'ant-api03-' + r(3, 40), OAI: 'sk-' + 'proj-' + r(4, 48), STRIPE: 'sk_' + 'live_' + r(5, 24), SLACK: 'xox' + 'b-' + '1234567890-' + r(6, 24),
  GOOGLE: 'AI' + 'za' + r(7, 35), NPM: 'npm' + '_' + r(8, 36), HF: 'hf' + '_' + r(9, 34), JWT: 'ey' + 'J' + r(10, 20) + '.ey' + 'J' + r(11, 30) + '.' + r(12, 20),
  RSA: 'RSA', PRIV: 'PRIVATE', PW: 'Pq7' + 'zLm2Vx9', PW2: 'Tr0ub4dor' + '-and-3', PW3: 'q8Zr2' + 'mXv9Lk', PW4: 's3cr3t' + '-value-99', B64: r(13, 32), HEX: r(14, 40, '0123456789abcdef'), LONGB64: r(15, 600),
};
const fill = s => s.replace(/\{([A-Z0-9]+)\}/g, (m, k) => FAKE[k] ?? m);

// 1. rules
for (const line of fs.readFileSync(here('./cases.txt'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#'))) {
  const i = line.indexOf('|'), want = line.slice(0, i), text = fill(line.slice(i + 1));
  const got = findSecret(text)?.type || 'clean';
  ok(got === want, `rule: expected "${want}", got "${got}": ${line.slice(i + 1)}`);
}
// this skill's own files must scan clean (they are committed to a public repo)
for (const f of ['./cases.txt', './run.mjs', '../scripts/secret-guard.mjs', '../SKILL.md']) {
  if (!fs.existsSync(here(f))) continue;
  const dirty = fs.readFileSync(here(f), 'utf8').split(/\r?\n/).map((l, i) => [i + 1, findSecret(l)]).filter(x => x[1]);
  ok(!dirty.length, `${f} scans clean (${dirty.map(([i, x]) => i + ': ' + x.type).join(', ')})`);
}
const s = findSecret(`x = "${FAKE.GH}"`); ok(s.sample === 'ghp_AA…' && !s.sample.includes(FAKE.GH), 'sample shows only 6 characters');

// 2. end to end in throwaway repos
const base = fs.mkdtempSync(path.join(process.env.SECRET_GUARD_TEST_DIR || os.tmpdir(), 'sg-test-'));
const G = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
const git = (cwd, ...a) => sh(cwd, 'git', [...G, ...a]);
const guard = (cwd, ...a) => sh(cwd, process.execPath, [script, ...a]);
const repo = name => { const d = path.join(base, name); fs.mkdirSync(d); git(d, 'init', '-q'); fs.writeFileSync(path.join(d, 'README.md'), 'hi\n'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'init', '--no-verify'); return d; };
const write = (d, f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
const commit = (d, msg) => git(d, 'commit', '-m', msg);
const head = d => git(d, 'rev-parse', 'HEAD').stdout.trim();

let d = repo('basic');
ok(guard(d, 'install').status === 0 && fs.existsSync(path.join(d, '.git/hooks/pre-commit')) && fs.existsSync(path.join(d, '.git/hooks/secret-guard.mjs')), 'install writes hook + script copy');
write(d, 'src/config.js', `export const gh = "${FAKE.GH}";\n`); git(d, 'add', '.');
let h0 = head(d), c = commit(d, 'add token');
ok(c.status !== 0 && head(d) === h0, 'commit with GitHub token is blocked');
ok(/src\/config\.js:1\s+GitHub token\s+\(ghp_AA…\)/.test(c.stderr) && !c.stderr.includes(FAKE.GH), 'block message has file:line, type, 6-char sample only');
ok(/git reset HEAD <file>/.test(c.stderr) && /--no-verify/.test(c.stderr) && /secret-guard: allow/.test(c.stderr), 'block message explains fixes');
write(d, 'src/config.js', `export const gh = "${FAKE.GH}"; // secret-guard: allow\n`); git(d, 'add', '.');
ok(commit(d, 'allowed').status === 0, 'line with "secret-guard: allow" commits');
write(d, 'aws.ini', `[default]\naws_access_key_id = ${FAKE.AKIA}\n`); git(d, 'add', '.');
c = commit(d, 'aws'); ok(c.status !== 0 && /aws\.ini:2\s+AWS access key ID/.test(c.stderr), 'AWS key blocked with correct line number');
git(d, 'reset', '-q', 'HEAD', 'aws.ini'); fs.rmSync(path.join(d, 'aws.ini'));
write(d, 'src/app.js', 'const key = process.env.API_KEY;\nconsole.log("ok");\n'); git(d, 'add', '.');
ok(commit(d, 'clean').status === 0, 'clean commit passes');
// only ADDED lines count: editing a file that already has an allowed secret elsewhere passes
write(d, 'src/config.js', `export const gh = "${FAKE.GH}"; // secret-guard: allow\nexport const x = 1;\n`); git(d, 'add', '.');
ok(commit(d, 'touch file').status === 0, 'only added lines are scanned');
write(d, '.env', 'DEBUG=1\n'); git(d, 'add', '.');
c = commit(d, 'env'); ok(c.status !== 0 && /\.env\s+environment file/.test(c.stderr), '.env file is blocked even without secrets');
git(d, 'reset', '-q', 'HEAD', '.env'); fs.rmSync(path.join(d, '.env'));
write(d, '.env.example', 'API_KEY=your-key-here\n'); git(d, 'add', '.env.example');
ok(commit(d, 'env example').status === 0, '.env.example is allowed');
write(d, 'certs/server.pem', 'x\n'); write(d, 'keys/id_rsa', 'x\n'); write(d, 'store.p12', Buffer.from([0, 1, 2, 3])); git(d, 'add', 'certs', 'keys', 'store.p12');
c = commit(d, 'keys'); ok(c.status !== 0 && /server\.pem/.test(c.stderr) && /id_rsa/.test(c.stderr) && /store\.p12/.test(c.stderr), '.pem, id_rsa and .p12 (binary) are blocked');
write(d, '.secret-guard-ignore', '# test fixtures\ncerts/\n*.p12\nkeys/id_rsa\n'); git(d, 'add', '.secret-guard-ignore');
ok(commit(d, 'ignored').status === 0, '.secret-guard-ignore globs (dir/, *.ext, path) whitelist files');
write(d, 'package-lock.json', `{"x": "${FAKE.GH}"}\n`); write(d, 'img.png', Buffer.concat([Buffer.from([0x89, 0x50, 0, 0]), Buffer.from(FAKE.GH)])); git(d, 'add', '.');
ok(commit(d, 'lock + binary').status === 0, 'lockfiles and binary files are skipped');
write(d, 'my dir/sp ace.txt', `token=${FAKE.NPM}\n`); git(d, 'add', '.');
c = commit(d, 'space'); ok(c.status !== 0 && /my dir\/sp ace\.txt:1/.test(c.stderr), 'paths with spaces are reported');
git(d, 'reset', '-q', 'HEAD', 'my dir'); fs.rmSync(path.join(d, 'my dir'), { recursive: true });
write(d, 'crlf.txt', `a\r\nSLACK=${FAKE.SLACK}\r\n`); git(d, 'add', 'crlf.txt');
c = commit(d, 'crlf'); ok(c.status !== 0 && /crlf\.txt:2\s+Slack token/.test(c.stderr), 'CRLF files are scanned');
git(d, 'reset', '-q', 'HEAD', 'crlf.txt'); fs.rmSync(path.join(d, 'crlf.txt'));
// history + tree scan: commit a secret with --no-verify, then remove it
write(d, 'old.py', `STRIPE_KEY = "${FAKE.STRIPE}"\n`); git(d, 'add', 'old.py'); git(d, 'commit', '-qm', 'oops', '--no-verify');
const oops = git(d, 'rev-parse', '--short', 'HEAD').stdout.trim();
let t = guard(d, 'scan'); ok(t.status === 1 && /old\.py:1\s+Stripe live key/.test(t.stdout), 'scan finds secret in tracked files');
t = guard(d, 'scan', 'src'); ok(t.status === 0 && !/old\.py/.test(t.stdout), 'scan [path] limits to that path');
git(d, 'rm', '-q', 'old.py'); commit(d, 'remove');
t = guard(d, 'scan-history'); ok(t.status === 1 && new RegExp(`${oops}\\s+old\\.py:1\\s+Stripe live key`).test(t.stdout) && !t.stdout.includes(FAKE.STRIPE), `scan-history reports commit + file + type (${t.stdout.split('\n').find(l => /old\.py/.test(l)) || 'missing'})`);
ok(!/server\.pem|store\.p12/.test(t.stdout), 'scan-history honours .secret-guard-ignore');
ok(/src\/config\.js/.test(t.stdout) === false, 'scan-history honours "secret-guard: allow"');
git(d, 'checkout', '-qb', 'side'); write(d, 'side.txt', `hf=${FAKE.HF}\n`); git(d, 'add', '.'); git(d, 'commit', '-qm', 'side', '--no-verify'); git(d, 'checkout', '-q', '-');
t = guard(d, 'scan-history'); ok(/side\.txt:1\s+Hugging Face token/.test(t.stdout), 'scan-history covers other branches (--all)');
ok(guard(d, 'uninstall').status === 0 && !fs.existsSync(path.join(d, '.git/hooks/pre-commit')), 'uninstall removes hook');
write(d, 'after.js', `const t = "${FAKE.GH}";\n`); git(d, 'add', 'after.js'); ok(commit(d, 'after uninstall').status === 0, 'after uninstall commits are not scanned');

// chaining an existing hook
d = repo('chain');
const prev = '#!/bin/sh\necho "previous hook ran" >&2\nif grep -q FORBIDDEN $(git diff --cached --name-only) 2>/dev/null; then echo "previous hook says no" >&2; exit 3; fi\nexit 0\n';
write(d, '.git/hooks/pre-commit', prev); fs.chmodSync(path.join(d, '.git/hooks/pre-commit'), 0o755);
t = guard(d, 'install'); ok(t.status === 0 && /Kept your existing pre-commit hook/.test(t.stdout) && fs.readFileSync(path.join(d, '.git/hooks/pre-commit.secret-guard-chained'), 'utf8') === prev, 'install keeps the existing hook as -chained');
ok(guard(d, 'install').status === 0 && fs.readFileSync(path.join(d, '.git/hooks/pre-commit.secret-guard-chained'), 'utf8') === prev, 'second install updates in place, does not chain itself');
write(d, 'a.txt', 'fine\n'); git(d, 'add', '.'); c = commit(d, 'a');
ok(c.status === 0 && /previous hook ran/.test(c.stderr), 'chained hook runs after a clean scan');
write(d, 'b.txt', 'FORBIDDEN\n'); git(d, 'add', '.'); c = commit(d, 'b');
ok(c.status !== 0 && /previous hook says no/.test(c.stderr), 'chained hook can still block');
git(d, 'reset', '-q', 'HEAD', 'b.txt');
write(d, 'c.txt', `k=${FAKE.GH}\n`); git(d, 'add', 'c.txt'); c = commit(d, 'c');
ok(c.status !== 0 && /GitHub token/.test(c.stderr) && !/previous hook ran/.test(c.stderr), 'secret blocks before the chained hook runs');
git(d, 'reset', '-q', 'HEAD', 'c.txt');
ok(guard(d, 'uninstall').status === 0 && fs.readFileSync(path.join(d, '.git/hooks/pre-commit'), 'utf8') === prev && !fs.existsSync(path.join(d, '.git/hooks/pre-commit.secret-guard-chained')), 'uninstall restores the previous hook');
// core.hooksPath (husky etc.): don't touch, print instructions
d = repo('husky'); git(d, 'config', 'core.hooksPath', '.husky');
t = guard(d, 'install'); ok(t.status === 1 && /core\.hooksPath/.test(t.stdout) && !fs.existsSync(path.join(d, '.git/hooks/pre-commit')), 'core.hooksPath: refuses and explains');
ok(guard(base, 'scan').status === 1, 'outside a repo: clear error');

fs.rmSync(base, { recursive: true, force: true });
console.log(`${n - bad}/${n} passed`); process.exit(bad ? 1 : 0);
