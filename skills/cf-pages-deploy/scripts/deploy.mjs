#!/usr/bin/env node
// cf-pages-deploy — safe, verified Cloudflare Pages deploys of static sites.
// Zero dependencies. Node 22+. Uses `npx wrangler` (must be logged in: `npx wrangler login`).
//
//   node deploy.mjs --project my-site --dir ./public            deploy to production (branch main)
//   node deploy.mjs --project my-site --dir . --include "index.html,*.css,*.js,assets/**"
//   node deploy.mjs --project my-site --dir dist --build "npm run build" --create
//   node deploy.mjs --project my-site --dir dist --branch preview   preview deploy, production untouched
//   node deploy.mjs ... --dry-run                                     show exactly what would be uploaded
//
// Steps: build -> stage a clean copy -> secret + size checks -> ensure project -> deploy -> verify live.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const project = opt('project');
const dir = path.resolve(opt('dir', '.'));
const branch = opt('branch', 'main');
const include = opt('include');
const extraExclude = opt('exclude');
const build = opt('build');
const DRY = flag('dry-run'), CREATE = flag('create'), ALLOW_SECRETS = flag('allow-secrets');
if (!project || flag('help')) {
  console.log('usage: node deploy.mjs --project <name> [--dir <folder>] [--include "a,b/**"] [--exclude "x,y/**"]\n'
    + '                      [--build "<cmd>"] [--branch main] [--create] [--dry-run] [--allow-secrets]');
  process.exit(project ? 0 : 1);
}
if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(project)) die(`invalid project name "${project}" (lowercase letters, digits, dashes)`);

function die(msg) { console.error('\n✘ ' + msg); process.exit(1); }
const step = msg => console.log('\n▸ ' + msg);
const isWin = process.platform === 'win32';

function wrangler(args, { json = false, inherit = false } = {}) {
  const r = spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'wrangler', ...args], {
    encoding: 'utf8', shell: isWin, stdio: inherit ? 'inherit' : 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die(`wrangler ${args.join(' ')} failed:\n${(r.stderr || '') + (r.stdout || '')}`.trim());
  if (!json) return r.stdout || '';
  const s = r.stdout, i = s.search(/[[{]/);
  try { return JSON.parse(s.slice(i)); } catch { die('could not parse wrangler JSON output:\n' + s); }
}

// ---------- glob matching (supports *, ** and ?) ----------
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
// A pattern without "/" matches the file name at any depth (like .gitignore).
const matcher = pats => pats.map(p => ({ p, re: globToRe(p), base: !p.includes('/') }));
const hit = (ms, rel) => ms.some(m => m.re.test(m.base ? path.posix.basename(rel) : rel) || (m.base && rel.split('/').slice(0, -1).some(seg => m.re.test(seg))));

// Never uploaded unless named in --include. Folders match at any depth.
const DEFAULT_EXCLUDE = [
  '.git', '.github', '.vscode', '.idea', 'node_modules', '.wrangler', '.cache', '.next', '.svelte-kit', '__pycache__',
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', '*.sqlite', '*.db', '*.log',
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '*.swp', '*~',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'tsconfig*.json',
  'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'README*', 'LICENSE*', 'CHANGELOG*', '*.md',
  '.gitignore', '.gitattributes', '.npmrc', '.editorconfig', '.prettierrc*', '.eslintrc*',
];
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key'],
  [/\bsk_live_[0-9a-zA-Z]{16,}/, 'Stripe live secret key'],
  [/\brk_live_[0-9a-zA-Z]{16,}/, 'Stripe restricted key'],
  [/\bwhsec_[0-9a-zA-Z]{20,}/, 'Stripe webhook secret'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[0-9A-Za-z_]{40,}/, 'GitHub token'],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/\bsk-ant-[0-9A-Za-z_-]{20,}/, 'Anthropic API key'],
  [/\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}/, 'OpenAI-style API key'],
  [/\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{16,}/, 'Resend API key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key (fine if browser-restricted)'],
];
const TEXT_EXT = /\.(html?|js|mjs|cjs|css|json|txt|xml|svg|map|webmanifest|csv|ya?ml|toml|ini|env)$/i;
const MAX_FILE = 25 * 1024 * 1024, MAX_FILES = 20000;

function walk(root) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) rec(abs); else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  })(root);
  return out;
}

// ---------- 1. build ----------
if (build) {
  step(`build: ${build}`);
  const r = spawnSync(build, { shell: true, stdio: 'inherit', cwd: process.cwd() });
  if (r.status !== 0) die('build failed');
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`--dir ${dir} is not a folder`);

// ---------- 2. stage ----------
step(`staging ${dir}`);
const inc = include && matcher(list(include)), exc = matcher([...DEFAULT_EXCLUDE, ...list(extraExclude)]);
const all = walk(dir);
const files = all.filter(rel => inc ? hit(inc, rel) : !hit(exc, rel));
const skipped = all.filter(f => !files.includes(f));
if (!files.length) die('nothing to deploy after filtering');
if (!files.some(f => /(^|\/)index\.html$/i.test(f))) console.warn('  ! no index.html — the site root will 404');

const stage = fs.mkdtempSync(path.join(os.tmpdir(), `cfpd-${project}-`));
process.on('exit', () => fs.rmSync(stage, { recursive: true, force: true })); // also on errors and dry runs
let total = 0; const big = [];
for (const rel of files) {
  const src = path.join(dir, rel), dst = path.join(stage, rel), size = fs.statSync(src).size;
  if (size > MAX_FILE) die(`${rel} is ${(size / 1048576).toFixed(1)} MiB; Pages allows 25 MiB per file`);
  total += size; big.push([size, rel]);
  fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
}
if (files.length > MAX_FILES) die(`${files.length} files; Pages allows ${MAX_FILES}`);
console.log(`  ${files.length} files, ${(total / 1048576).toFixed(2)} MiB  (left out ${skipped.length})`);
for (const [s, f] of big.sort((a, b) => b[0] - a[0]).slice(0, 5)) console.log(`    ${(s / 1024).toFixed(0).padStart(7)} KiB  ${f}`);
if (skipped.length) console.log('  left out: ' + [...new Set(skipped.map(f => f.split('/')[0]))].slice(0, 12).join(', ') + (skipped.length > 12 ? ' …' : ''));

// ---------- 3. secret scan ----------
step('scanning for secrets');
const findings = [];
for (const rel of files) {
  if (!TEXT_EXT.test(rel) && !/^[^.]+$/.test(path.posix.basename(rel))) continue;
  const text = fs.readFileSync(path.join(stage, rel), 'utf8');
  for (const [re, what] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) findings.push(`${rel}: ${what} (${m[0].slice(0, 8)}…)`);
  }
}
if (findings.length) {
  console.log(findings.map(f => '  ! ' + f).join('\n'));
  if (!ALLOW_SECRETS) die('possible secrets in files that would be PUBLIC. Remove them, or pass --allow-secrets if they are meant to be public (e.g. a browser-restricted key).');
} else console.log('  none found');

if (DRY) { console.log('\n(dry run) nothing uploaded. Files that would go live:\n' + files.map(f => '    ' + f).join('\n')); process.exit(0); }

// ---------- 4. project ----------
step(`checking project "${project}"`);
const findProject = () => wrangler(['pages', 'project', 'list', '--json'], { json: true }).find(p => p['Project Name'] === project);
let proj = findProject();
if (!proj) {
  if (!CREATE) die(`Pages project "${project}" doesn't exist. Re-run with --create to make it.`);
  // wrangler 4.15x+ delegates `pages project create` to "Pages in Workers" by default, which can fail or
  // produce a Worker instead of a Pages project. --force (hidden flag) creates a classic Pages project.
  wrangler(['pages', 'project', 'create', project, '--production-branch', 'main', '--force'], { inherit: true });
  proj = findProject();
  if (!proj) die(`"${project}" still isn't listed as a Pages project after create. Check the dashboard: some wrangler versions made a Worker instead.`);
}
const domains = proj['Project Domains'].split(',').map(s => s.trim()).filter(Boolean);
const pagesDev = domains.find(d => d.endsWith('.pages.dev'));
console.log('  domains: ' + domains.join(', '));

// ---------- 5. deploy ----------
step(`deploying to ${branch === 'main' ? 'PRODUCTION (main)' : 'preview branch ' + branch}`);
const out = wrangler(['pages', 'deploy', stage, '--project-name', project, '--branch', branch, '--commit-dirty=true']);
process.stdout.write(out.split('\n').filter(l => /Uploaded|Success|Deployment complete|https:\/\//.test(l)).map(l => '  ' + l.trim()).join('\n') + '\n');
const deployUrl = (out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i) || [])[0];

// ---------- 6. verify ----------
const liveBase = branch === 'main' ? `https://${pagesDev}` : deployUrl;
const probe = files.find(f => /^index\.html$/i.test(f)) || files.find(f => /\.html$/i.test(f)) || files[0];
const probeUrl = liveBase && liveBase.replace(/\/$/, '') + '/' + (probe === 'index.html' ? '' : probe.replace(/\.html$/i, ''));
if (!probeUrl) die('deployed, but could not determine the live URL to verify');
step(`verifying ${probeUrl}`);
const want = fs.readFileSync(path.join(stage, probe));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let ok = false, last = '';
for (let i = 0; i < 20 && !ok; i++) {
  try {
    const r = await fetch(probeUrl + (probeUrl.includes('?') ? '&' : '?') + 'cfpd=' + Date.now(), { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
    const body = Buffer.from(await r.arrayBuffer());
    last = `HTTP ${r.status}, ${body.length} bytes`;
    ok = r.ok && sha(body) === sha(want);
  } catch (e) { last = e.message; }
  if (!ok) await new Promise(r => setTimeout(r, 3000));
}
if (!ok) die(`live ${probe} doesn't match what was uploaded yet (${last}). It may still be propagating; check ${probeUrl}`);
console.log(`  ✓ live ${probe} matches the upload byte for byte`);
console.log(`\n✓ ${branch === 'main' ? 'Production' : 'Preview'}: ${liveBase}` + (deployUrl && deployUrl !== liveBase ? `\n  This deployment: ${deployUrl}` : ''));
