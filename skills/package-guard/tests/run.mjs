// node tests/run.mjs [--live]
//   offline: command parsing (cases.txt), decision rules on synthetic registry data, hook fail-open
//   --live:  real npm/PyPI lookups + the hook end to end (needs network)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = p => fileURLToPath(new URL(p, import.meta.url));
const script = here('../scripts/package-guard.mjs');
const { decide } = await import(pathToFileURL(script).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
const env = { ...process.env, PACKAGE_GUARD_CACHE: path.join(tmp, 'cache.json') };
let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('✘ ' + msg); } };

// 1. parsing
for (const line of fs.readFileSync(here('./cases.txt'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#'))) {
  const i = line.indexOf('|'), want = line.slice(0, i), cmd = line.slice(i + 1);
  const got = execFileSync(process.execPath, [script, 'parse', cmd], { encoding: 'utf8', cwd: tmp }).trim();
  ok(got === want, `parse: expected "${want}", got "${got}": ${cmd}`);
}
// npx of a bin the project already has is not an install
fs.mkdirSync(path.join(tmp, 'proj', 'node_modules', '.bin'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'proj', 'node_modules', '.bin', 'tsc'), '');
ok(execFileSync(process.execPath, [script, 'parse', 'npx tsc --noEmit'], { encoding: 'utf8', cwd: path.join(tmp, 'proj') }).trim() === '(none)', 'npx of a local bin is skipped');
ok(execFileSync(process.execPath, [script, 'parse', 'npx tsc --noEmit'], { encoding: 'utf8', cwd: tmp }).trim() === 'npm:tsc', 'npx without a local bin is checked');

// 2. decisions on synthetic data
const now = Date.parse('2026-11-01T00:00:00Z'), old = '2015-01-01T00:00:00Z', fresh = '2026-10-25T00:00:00Z';
const D = (eco, name, info) => decide(eco, name, { exists: true, scripts: [], deprecated: null, ...info }, now);
ok(decide('npm', 'reactt-x', { exists: false }, now).action === 'block', 'nonexistent npm blocks');
ok(/did you mean requests/.test(decide('pypi', 'reqeusts', { exists: false }, now).reasons[0]), 'nonexistent suggests nearest');
ok(D('npm', 'lodahs', { placeholder: true, weekly: 300, created: old }).action === 'block', 'security placeholder blocks');
ok(D('npm', 'react', { weekly: 2e8, created: old }).action === 'allow', 'popular allows');
ok(D('npm', 'esbuild', { weekly: 4e8, created: old, scripts: ['postinstall'] }).action === 'allow', 'popular with install script allows');
ok(/install scripts/.test(D('npm', 'tiny-helper-x', { weekly: 500, created: old, scripts: ['postinstall'] }).reasons.join()), 'obscure with install script asks');
ok(/install scripts/.test(D('npm', 'new-thing-x', { weekly: 20000, created: '2026-09-01T00:00:00Z', scripts: ['install'] }).reasons.join()), 'young (<90d) with install script asks');
ok(D('npm', 'old-native-x', { weekly: null, created: old, scripts: ['install'] }).action === 'allow', 'install script with unknown downloads, old: allows (no evidence)');
ok(/typo of express/.test(D('npm', 'expresss', { weekly: 700, created: old }).reasons.join()), 'typo asks');
ok(D('npm', 'preact', { weekly: 5e6, created: old }).action === 'allow', 'popular near-name (preact) allows');
ok(D('npm', 'vue', { weekly: 5e6, created: old }).action === 'allow', 'short popular allows');
ok(D('npm', 'ms', { weekly: 3e8, created: old }).action === 'allow', '2-char name gets no typo check');
ok(/first published 7 day/.test(D('npm', 'brand-new-pkg', { weekly: 5000, created: fresh }).reasons.join()), 'new package asks');
ok(/only 12 downloads/.test(D('npm', 'quiet-pkg-x', { weekly: 12, created: old }).reasons.join()), 'low downloads asks');
ok(/deprecated/.test(D('npm', 'request', { weekly: 1e7, created: old, deprecated: 'use fetch' }).reasons.join()), 'deprecated asks');
ok(/typo of numpy/.test(D('pypi', 'numpi', { weekly: null, created: old }).reasons.join()), 'pypi typo asks when downloads unknown');
ok(D('pypi', 'Django', { weekly: null, created: old }).action === 'allow', 'pypi popular (case-insensitive) allows');
ok(D('pypi', 'python_dateutil', { weekly: null, created: old }).action === 'allow', 'pypi name normalization');
ok(D('pypi', 'some-lib', { weekly: null, created: old }).action === 'allow', 'pypi: unknown downloads, old, not a typo allows');

// 3. hook basics and fail-open (fetch replaced by one that always throws)
const hook = (cmd, { tool = 'Bash', preload } = {}) => spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), script, 'hook'],
  { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: cmd }, cwd: tmp }), encoding: 'utf8', env, timeout: 20000 });
const noNet = 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("offline (test)")}';
let r = hook('npm i react-dom-utils-helper-pro-xyz123', { preload: noNet });
ok(r.status === 0 && !r.stdout && /could not check/.test(r.stderr), `network failure fails open (status ${r.status}, stderr ${r.stderr.trim()})`);
r = hook('ls -la'); ok(r.status === 0 && !r.stdout, 'unrelated command allows silently');
r = hook('npm i react', { tool: 'Read' }); ok(r.status === 0 && !r.stdout, 'non-shell tool ignored');
r = spawnSync(process.execPath, [script, 'hook'], { input: 'not json', encoding: 'utf8', env }); ok(r.status === 0, 'bad stdin fails open');
fs.writeFileSync(path.join(tmp, 'proj', '.npmrc'), 'registry=https://npm.mycorp.local/\n');
r = spawnSync(process.execPath, [script, 'hook'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm i internal-only-pkg-xyz' }, cwd: path.join(tmp, 'proj') }), encoding: 'utf8', env: { ...env } });
ok(r.status === 0 && !r.stdout, 'package from a private registry (.npmrc) is skipped');

// 4. live
if (process.argv.includes('--live')) {
  const live = { allow: ['react', 'express', 'lodash', 'esbuild', 'bcrypt', '@types/node', 'pypi:requests', 'pypi:numpy', 'pypi:Django'],
    ask: ['expresss', 'request', 'pypi:beautifulsoup'], block: ['react-dom-utils-helper-pro-xyz123', 'lodahs', 'pypi:reqeusts', 'pypi:react-dom-utils-helper-pro-xyz123'] };
  const res = JSON.parse(spawnSync(process.execPath, [script, 'check', '--json', ...Object.values(live).flat()], { encoding: 'utf8', env }).stdout);
  for (const [want, list] of Object.entries(live)) for (const p of list) { const g = res.find(x => x.label.endsWith(':' + p.replace(/^pypi:/, ''))); ok(g?.action === want, `live ${p}: expected ${want}, got ${g?.action} ${g?.reasons?.join('; ') || g?.error || ''}`); }
  r = hook('cd x && npm install react-dom-utils-helper-pro-xyz123'); ok(r.status === 2 && /does not exist on npm/.test(r.stderr), 'hook blocks nonexistent (exit 2)');
  r = hook('pip install reqeusts', { tool: 'PowerShell' }); ok(r.status === 2 && /did you mean requests/.test(r.stderr), 'hook blocks nonexistent pypi typo (PowerShell tool)');
  r = hook('npm i expresss'); const o = r.stdout ? JSON.parse(r.stdout) : {};
  ok(r.status === 0 && o.hookSpecificOutput?.permissionDecision === 'ask' && /typo of express/.test(o.hookSpecificOutput.permissionDecisionReason), 'hook asks on typosquat');
  r = hook('npm i react esbuild && pip install requests numpy'); ok(r.status === 0 && !r.stdout, 'hook allows popular packages silently');
  const t0 = Date.now(); hook('npm i react'); const ms = Date.now() - t0; ok(ms < 1500, `cached hook is fast (${ms} ms)`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n - bad}/${n} passed`); process.exit(bad ? 1 : 0);
