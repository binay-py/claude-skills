#!/usr/bin/env node
// claude-sandbox — run Claude Code in a Docker container that can only see one project folder.
// Zero dependencies. Node 22+ and Docker.
//
//   node sandbox.mjs                       sandbox the current folder (interactive Claude Code)
//   node sandbox.mjs ~/code/app            sandbox another folder
//   node sandbox.mjs . --yolo              skip permission prompts INSIDE the container (that's what it's for)
//   node sandbox.mjs . --readonly          mount the project read-only (review / analysis only)
//   node sandbox.mjs . --no-network        no network at all (Claude can't reach the API: only for -p with a local proxy, or tests)
//   node sandbox.mjs . -- -p "fix the failing test"   pass args to claude after --
//   node sandbox.mjs --shell .             open bash in the sandbox instead of claude
//   node sandbox.mjs --rebuild             rebuild the image (e.g. to update Claude Code)
//   node sandbox.mjs --check .             verify the isolation and exit
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = process.env.CLAUDE_SANDBOX_IMAGE || 'claude-sandbox:latest';
const VOLUME = process.env.CLAUDE_SANDBOX_HOME || 'claude-sandbox-home';
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = process.argv.slice(2), dd = raw.indexOf('--');
const args = dd >= 0 ? raw.slice(0, dd) : raw, claudeArgs = dd >= 0 ? raw.slice(dd + 1) : [];
const flag = f => args.includes(f);
const project = path.resolve((args.find(a => !a.startsWith('--')) || '.').replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE));
const docker = (a, opts = {}) => spawnSync('docker', a, { encoding: 'utf8', ...opts });
const die = m => { console.error('✘ ' + m); process.exit(1); };

if (docker(['info', '--format', '{{.ServerVersion}}']).status !== 0) die('Docker is not running. Start Docker Desktop (or the docker service) and try again.');
if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) die(`not a folder: ${project}`);
const home = path.resolve(process.env.HOME || process.env.USERPROFILE || '/');
if (project === home || project === path.parse(project).root) die(`refusing to mount ${project}: that exposes your whole ${project === home ? 'home folder' : 'drive'}. Pick a project folder.`);

// build image if needed
if (flag('--rebuild') || docker(['image', 'inspect', IMAGE]).status !== 0) {
  console.log(`building ${IMAGE} (first run takes a minute)…`);
  const b = spawnSync('docker', ['build', '-t', IMAGE, here], { stdio: 'inherit' });
  if (b.status !== 0) die('docker build failed');
  if (flag('--rebuild') && !args.some(a => !a.startsWith('--'))) process.exit(0);
}

const run = [
  'run', '--rm', '--init',
  '--name', `claude-sandbox-${path.basename(project).replace(/[^a-zA-Z0-9_.-]/g, '-')}-${process.pid}`,
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '1024', '--memory', process.env.CLAUDE_SANDBOX_MEMORY || '4g',
  '-v', `${project}:/workspace${flag('--readonly') ? ':ro' : ''}`,
  '-v', `${VOLUME}:/home/claude`,
  '-w', '/workspace',
  '-e', 'CLAUDE_SANDBOX=1',
];
if (flag('--no-network')) run.push('--network', 'none');
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'TERM']) if (process.env[k]) run.push('-e', k);
const tty = process.stdin.isTTY && process.stdout.isTTY;

if (flag('--check')) {
  // prove the isolation: what the container can and cannot see
  const probe = `set -e
echo "user: $(id -un) (uid $(id -u))"
echo "workspace: $(ls -A /workspace | wc -l) entries visible"
touch /workspace/.sandbox-write-test && rm /workspace/.sandbox-write-test && echo "workspace writable: yes" || echo "workspace writable: no"
[ -e /host ] || [ -e /mnt/c ] || [ -e /Users ] && echo "HOST FILESYSTEM VISIBLE" || echo "host filesystem: not visible"
ls /home/claude/.ssh 2>/dev/null && echo "SSH KEYS VISIBLE" || echo "ssh keys: none"
(touch /etc/sandbox-test 2>/dev/null && echo "CAN WRITE /etc") || echo "system dirs: read-only for this user"
(sudo -n true 2>/dev/null && echo "SUDO AVAILABLE") || echo "sudo: not available"
echo "capabilities: $(grep CapEff /proc/self/status | awk '{print $2}')"
echo "claude: $(claude --version 2>/dev/null || echo missing)"`;
  const r = docker([...run, '--entrypoint', 'bash', IMAGE, '-c', probe]);
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  const bad = /VISIBLE|CAN WRITE|SUDO AVAILABLE|missing/.test(r.stdout);
  console.log(bad ? '\n✘ isolation check FAILED' : '\n✓ isolation check passed');
  process.exit(bad || r.status ? 1 : 0);
}

run.push(tty ? '-it' : '-i');
if (flag('--shell')) run.push('--entrypoint', 'bash', IMAGE);
else run.push(IMAGE, ...(flag('--yolo') ? ['--dangerously-skip-permissions'] : []), ...claudeArgs);
console.log(`sandbox: ${project} → /workspace${flag('--readonly') ? ' (read-only)' : ''} · home volume: ${VOLUME}${flag('--yolo') ? ' · permission prompts OFF inside the container' : ''}`);
const r = spawnSync('docker', run, { stdio: 'inherit' });
process.exit(r.status ?? 1);
