// node hooks/test.mjs — checks hooks/hooks.json and runs each shipped hook through run.mjs the way the plugin does (offline).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0; const ok = (c, msg) => { if (!c) { bad++; console.log('✘ ' + msg); } };

// hooks.json: valid, and every command calls run.mjs with a hook run.mjs knows
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
const known = [...fs.readFileSync(path.join(root, 'hooks', 'run.mjs'), 'utf8').matchAll(/^\s*'([\w-]+)': \['skills\//gm)].map(m => m[1]);
const cmds = Object.values(cfg.hooks).flat().flatMap(e => e.hooks.map(h => h.command));
ok(cmds.length === 4, `expected 4 hook commands, got ${cmds.length}`);
for (const c of cmds) { const m = c.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run\.mjs" ([\w-]+)$/); ok(m && known.includes(m[1]), 'bad command: ' + c); }
for (const k of known) ok(fs.existsSync(path.join(root, fs.readFileSync(path.join(root, 'hooks', 'run.mjs'), 'utf8').match(new RegExp(`'${k}': \\['([^']+)'`))[1])), 'missing script for ' + k);

// run hooks like Claude Code does: JSON on stdin, CLAUDE_PLUGIN_ROOT set
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
const big = path.join(tmp, 'big.log'); fs.writeFileSync(big, 'line of log output\n'.repeat(5000));
const small = path.join(tmp, 'small.txt'); fs.writeFileSync(small, 'hi\n');
const home = os.homedir();
const run = (hook, input, env = {}) => spawnSync(process.execPath, [path.join(root, 'hooks', 'run.mjs'), hook],
  { input: JSON.stringify(input), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, BINAY_SKILLS_HOOKS_OFF: '', ...env } });
const bash = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: tmp });
const wipe = ['rm', '-rf', '~'].join(' ');
const cases = [
  ['bash-checkpoint blocks a home wipe', run('bash-checkpoint', bash(wipe)).status === 2],
  ['bash-checkpoint allows ls', run('bash-checkpoint', bash('ls')).status === 0],
  ['read-guard denies a whole read of a big file', /"permissionDecision":"deny"/.test(run('read-guard', { tool_name: 'Read', tool_input: { file_path: big }, cwd: tmp }).stdout)],
  ['read-guard allows a small file', run('read-guard', { tool_name: 'Read', tool_input: { file_path: small }, cwd: tmp }).status === 0],
  ['session-handoff meter exits 0', run('session-handoff', {}).status === 0],
  ['opt-out by name', run('bash-checkpoint', bash(wipe), { BINAY_SKILLS_HOOKS_OFF: 'read-guard, bash-checkpoint' }).status === 0],
  ['opt-out all', run('package-guard', bash('npm install definitely-not-a-real-pkg-xyz'), { BINAY_SKILLS_HOOKS_OFF: 'all' }).status === 0],
  ['unknown hook name fails open', run('nope', {}).status === 0],
  ['garbage stdin fails open', spawnSync(process.execPath, [path.join(root, 'hooks', 'run.mjs'), 'bash-checkpoint'], { input: 'not json', encoding: 'utf8' }).status === 0],
];
for (const [name, pass] of cases) ok(pass, name);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${cases.length + cmds.length + known.length + 1 - bad}/${cases.length + cmds.length + known.length + 1} passed`);
process.exit(bad ? 1 : 0);
