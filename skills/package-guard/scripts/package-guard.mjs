#!/usr/bin/env node
// package-guard — a Claude Code PreToolUse hook that checks every package an install command names
// against the public npm / PyPI registries before it runs. Blocks names that don't exist (hallucinated),
// asks before typo-looking, brand-new, barely-downloaded or deprecated packages. Zero dependencies. Node 22+.
//
//   node package-guard.mjs hook                       PreToolUse hook (reads the tool call as JSON on stdin)
//   node package-guard.mjs check react pypi:requests  check packages by hand (bare names = npm)
//   node package-guard.mjs parse "<command>"          show which packages a command would install (offline)
//
// Fails open: network errors, timeouts and its own bugs never block a command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_FILE = process.env.PACKAGE_GUARD_CACHE || path.join(os.homedir(), '.claude', 'package-guard-cache.json');
const CACHE_MS = 24 * 3600 * 1000, FETCH_MS = 4000, HOOK_BUDGET_MS = 12000;
const NEW_DAYS = 30, LOW_DL = 100, POPULAR_DL = 50000, SCRIPT_DL = 10000;
const DAY = 86400000;

// ---------- popular names (typo targets) ----------
const POPULAR_NPM = `react react-dom react-router react-router-dom next vue nuxt svelte @angular/core preact solid-js
express koa fastify @hapi/hapi @nestjs/core axios node-fetch got superagent request lodash underscore ramda moment dayjs
date-fns luxon chalk commander yargs inquirer ora debug dotenv cross-env uuid nanoid classnames clsx
typescript ts-node tsx esbuild vite webpack webpack-cli rollup parcel babel-loader @babel/core @babel/preset-env @swc/core
eslint prettier jest mocha chai vitest sinon supertest cypress playwright puppeteer jsdom cheerio
mongoose mongodb mysql mysql2 pg sequelize typeorm prisma @prisma/client knex redis ioredis sqlite3 better-sqlite3
socket.io socket.io-client ws body-parser cookie-parser cors helmet morgan multer passport jsonwebtoken bcrypt bcryptjs
express-session nodemon pm2 concurrently rimraf glob minimatch fs-extra graceful-fs mkdirp semver yaml js-yaml ini
tailwindcss postcss autoprefixer sass less styled-components @emotion/react bootstrap jquery three d3 chart.js
redux react-redux @reduxjs/toolkit zustand mobx immer rxjs graphql apollo-server @apollo/client
zod joi yup ajv validator qs query-string marked markdown-it highlight.js sharp jimp canvas
openai @anthropic-ai/sdk langchain stripe aws-sdk @aws-sdk/client-s3 firebase firebase-admin @supabase/supabase-js
electron react-native expo next-auth formik react-hook-form @tanstack/react-query swr
tslib core-js regenerator-runtime @types/node @types/react lru-cache async bluebird p-limit execa shelljs
cross-spawn which chokidar node-cron xml2js csv-parse papaparse handlebars ejs pug mustache nodemailer
winston pino bunyan colors kleur picocolors figlet boxen string-width strip-ansi ansi-styles supports-color
http-proxy http-server serve live-server browser-sync vercel netlify-cli wrangler firebase-tools turbo lerna nx
husky lint-staged @commitlint/cli standard-version semantic-release np`.split(/\s+/);
const POPULAR_PYPI = `requests numpy pandas scipy matplotlib seaborn scikit-learn tensorflow torch torchvision keras
flask django fastapi uvicorn gunicorn starlette pydantic sqlalchemy alembic psycopg2 psycopg2-binary pymysql redis celery
boto3 botocore awscli google-cloud-storage azure-storage-blob openai anthropic langchain transformers huggingface-hub
datasets tokenizers accelerate sentencepiece pillow opencv-python imageio beautifulsoup4 lxml html5lib selenium playwright
scrapy httpx aiohttp urllib3 certifi charset-normalizer idna six python-dateutil pytz tzdata attrs click typer rich tqdm
colorama pyyaml toml tomli jinja2 markupsafe werkzeug itsdangerous cryptography pyjwt bcrypt paramiko pynacl
pytest pytest-cov coverage tox nox black flake8 pylint mypy isort ruff pre-commit setuptools wheel pip virtualenv
poetry pipenv twine build packaging docutils sphinx jupyter notebook ipython ipykernel jupyterlab networkx sympy
statsmodels xgboost lightgbm plotly dash streamlit gradio nltk spacy gensim openpyxl xlrd psutil watchdog
python-dotenv loguru orjson ujson simplejson protobuf grpcio pyarrow polars dask pymongo motor elasticsearch
docker kubernetes ansible fabric invoke pexpect sh schedule apscheduler`.split(/\s+/);

// ---------- helpers ----------
const pyNorm = n => n.toLowerCase().replace(/[-_.]+/g, '-');
function dist(a, b) { // optimal string alignment (Levenshtein + adjacent transposition)
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
// nearest popular name within `max` edits (0 = none). Short names only get 1 edit; 1-3 char names none.
function nearest(eco, name, max) {
  const list = eco === 'npm' ? POPULAR_NPM : POPULAR_PYPI.map(pyNorm), n = eco === 'npm' ? name : pyNorm(name);
  if (list.includes(n)) return null;
  const lim = max ?? (n.length >= 8 ? 2 : n.length >= 4 ? 1 : 0);
  let best = null;
  for (const p of list) { const k = dist(n, p); if (k <= lim && (!best || k < best.k)) best = { name: p, k }; }
  return best?.name || null;
}
const isPopularName = (eco, name) => eco === 'npm' ? POPULAR_NPM.includes(name) : POPULAR_PYPI.map(pyNorm).includes(pyNorm(name));

// ---------- command parsing ----------
function segments(cmd) { // quote-aware split on && || ; | & and newlines
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
const tokens = s => (s.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) || []).map(w => w.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1'));
const PREFIXES = /^(sudo|doas|command|env|nohup|time|exec|nice)$/;
const SHELLS = /^(sh|bash|zsh|dash)$/, PWSH = /^(powershell|pwsh)(\.exe)?$/i, CMDEXE = /^cmd(\.exe)?$/i;
// flags that take a value (so the value isn't mistaken for a package)
const NPM_VAL = /^(--registry|--prefix|-C|--dir|-w|--workspace|--filter|--tag|--cache|--userconfig|--loglevel|--omit|--include|--install-strategy|--cwd|--modules-folder|--network-timeout|-p|--package|-c|--call)$/;
const PIP_VAL = /^(-r|--requirement|-c|--constraint|-e|--editable|-t|--target|--prefix|--root|--src|-f|--find-links|--platform|--python-version|--implementation|--abi|--upgrade-strategy|--progress-bar|--python|-p|--group|-G|--extra|--optional|--source|--index|--index-strategy|--cache-dir|--log|--proxy|--retries|--timeout|--exists-action|--trusted-host|--cert|--client-cert|--report|--only-binary|--no-binary|--config-settings|-C|--with|--spec|--from|--suffix|--python-preference|--resolution|--prerelease|--keyring-provider|--directory|--project|--package)$/;
const CUSTOM_INDEX = /^(-i|--index-url|--extra-index-url|--default-index|--registry)(=|$)/;

function npmSpec(arg) { // returns package name or null for things that aren't registry packages
  if (/^(\.|\/|~|[A-Za-z]:[\\/])|:\/\/|^(git\+|git:|github:|gitlab:|bitbucket:|file:|link:|workspace:|portal:|patch:)|\.(tgz|tar\.gz|tar)$/i.test(arg)) return null;
  const alias = arg.match(/^[^@]*@?[^@]*@npm:(.+)$/); if (alias) arg = alias[1];
  if (!arg.startsWith('@') && arg.includes('/')) return null; // user/repo GitHub shorthand
  const at = arg.lastIndexOf('@'), name = at > 0 ? arg.slice(0, at) : arg;
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) || name.startsWith('@') && !name.includes('/')) return null;
  return name.toLowerCase();
}
function pySpec(arg) {
  if (/^(\.|\/|~|[A-Za-z]:[\\/])|:\/\/|^(git\+|hg\+|svn\+|bzr\+|file:)|[\\/]|\.(whl|zip|tar\.gz|tgz|tar\.bz2)$/i.test(arg)) return null;
  if (/\s@\s|^[^@]+@\s*\w+:/.test(arg)) return null; // name @ https://… direct reference
  const m = arg.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(@|==|>=|<=|~=|!=|===|<|>|;|,|$)/);
  return m ? m[1] : null;
}
// `npm init vite` / `npm create vite@latest` run the create-vite package
const createName = n => n.startsWith('@') ? (n.includes('/') ? n.replace('/', '/create-') : n + '/create') : 'create-' + n;

// -> [{eco, name, cmd}] for one shell segment's tokens
function fromTokens(t, ctx) {
  const out = [], c0 = (t[0] || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|ps1)$/i, '').toLowerCase();
  const collect = (args, eco, valFlags, opts = {}) => {
    const names = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (CUSTOM_INDEX.test(a) && !/registry\.npmjs\.org|pypi\.org\/simple/.test(a + ' ' + (args[i + 1] || ''))) return []; // private/custom index: not ours to judge
      if (a === '--') { if (opts.stopAtDashDash) break; continue; }
      if (a.startsWith('-')) { if (!a.includes('=') && (valFlags.test(a) || CUSTOM_INDEX.test(a))) i++; continue; }
      names.push(a); if (opts.first) break;
    }
    return names.map(a => eco === 'npm' ? npmSpec(a) : pySpec(a)).filter(Boolean).map(name => ({ eco, name }));
  };
  const npxPkgs = args => { // npx [-p pkg]… <pkg|cmd> [args]: -p packages, else the first positional
    const p = []; let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (/^(-p|--package)$/.test(a)) { p.push(args[++i]); continue; }
      const m = a.match(/^--package=(.+)/); if (m) { p.push(m[1]); continue; }
      if (a.startsWith('-')) { if (NPM_VAL.test(a)) i++; continue; }
      break;
    }
    if (p.length) return p.map(npmSpec).filter(Boolean).map(name => ({ eco: 'npm', name }));
    const first = args[i]; if (!first) return [];
    const name = npmSpec(first); if (!name) return [];
    if (ctx.hasLocalBin(name)) return []; // npx runs the project's own bin
    return [{ eco: 'npm', name }];
  };
  if (c0 === 'npm' || c0 === 'pnpm' || c0 === 'yarn' || c0 === 'bun') {
    let args = t.slice(1); while (args.length && args[0].startsWith('-')) args = args.slice(NPM_VAL.test(args[0]) && !args[0].includes('=') ? 2 : 1);
    const s = (args[0] || '').toLowerCase(), rest = args.slice(1);
    if (c0 === 'yarn' && s === 'global' && /^add$/i.test(rest[0])) return collect(rest.slice(1), 'npm', NPM_VAL);
    if (/^(i|install|add|in|ins|inst|insta|instal|isnt|isntall|isntal)$/.test(s) && !(c0 === 'yarn' && s === 'install')) return collect(rest, 'npm', NPM_VAL);
    if (s === 'exec' && c0 === 'npm' || s === 'dlx' || s === 'x' && c0 === 'bun') return npxPkgs(rest);
    if (s === 'init' || s === 'create') { const n = collect(rest, 'npm', NPM_VAL, { first: true }); return n.map(x => ({ ...x, name: createName(x.name) })); }
    return out;
  }
  if (c0 === 'npx' || c0 === 'bunx' || c0 === 'pnpx') return npxPkgs(t.slice(1));
  // python -m pip install … / py -3 -m pip install …
  let pt = t;
  if (/^(python[\d.]*|py)$/.test(c0)) { const mi = t.indexOf('-m'); if (mi < 0 || !/^pip3?$/.test(t[mi + 1] || '')) return out; pt = ['pip', ...t.slice(mi + 2)]; }
  const p0 = (pt[0] || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (/^pip[\d.]*$/.test(p0) && pt[1] === 'install') return collect(pt.slice(2), 'pypi', PIP_VAL);
  if (p0 === 'uv' && pt[1] === 'pip' && pt[2] === 'install') return collect(pt.slice(3), 'pypi', PIP_VAL);
  if (p0 === 'uv' && pt[1] === 'add') return collect(pt.slice(2), 'pypi', PIP_VAL);
  if (p0 === 'uv' && pt[1] === 'tool' && /^(install|run)$/.test(pt[2] || '')) return collect(pt.slice(3), 'pypi', PIP_VAL, { first: true });
  if (p0 === 'uvx') return collect(pt.slice(1), 'pypi', PIP_VAL, { first: true });
  if (p0 === 'poetry' && pt[1] === 'add') return collect(pt.slice(2), 'pypi', PIP_VAL);
  if (p0 === 'pipx' && /^(install|run)$/.test(pt[1] || '')) return collect(pt.slice(2), 'pypi', PIP_VAL, { first: pt[1] === 'run' });
  return out;
}

export function parseCommand(cmd, cwd = process.cwd(), depth = 0) {
  let dir = cwd; const found = [];
  const hasLocalBin = name => { const bin = name.replace(/^@[^/]+\//, ''); for (let d = dir; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, 'node_modules', '.bin', bin)) || fs.existsSync(path.join(d, 'node_modules', name, 'package.json'))) return true; if (path.dirname(d) === d) return false; } };
  for (const seg of segments(cmd)) {
    let t = tokens(seg);
    while (t.length && (PREFIXES.test(t[0]) || /^\w+=/.test(t[0]))) t = t.slice(1);
    if (!t.length) continue;
    const c0 = t[0].replace(/^.*[\\/]/, '');
    if (/^(cd|Set-Location|pushd|sl)$/i.test(c0) && t[1]) { dir = path.resolve(dir, t[1].replace(/^~(?=$|[\\/])/, os.homedir())); continue; }
    if (depth < 2) {
      let inner = null; const ci = t.indexOf('-c'), pi = t.findIndex(w => /^-(c|command)$/i.test(w)), ki = t.findIndex(w => /^\/c$/i.test(w));
      if (SHELLS.test(c0) && ci > 0) inner = t[ci + 1]; else if (PWSH.test(c0) && pi > 0) inner = t.slice(pi + 1).join(' '); else if (CMDEXE.test(c0) && ki > 0) inner = t.slice(ki + 1).join(' ');
      if (inner) { found.push(...parseCommand(inner, dir, depth + 1)); continue; }
    }
    for (const p of fromTokens(t, { hasLocalBin })) found.push({ ...p, cwd: dir });
  }
  const seen = new Set();
  return found.filter(p => { const k = p.eco + ':' + (p.eco === 'pypi' ? pyNorm(p.name) : p.name); if (seen.has(k)) return false; seen.add(k); return true; });
}

// private registries configured outside the command: leave those packages alone
function privateRegistry(eco, name, cwd) {
  if (eco === 'pypi') return [process.env.PIP_INDEX_URL, process.env.UV_INDEX_URL, process.env.UV_DEFAULT_INDEX].some(u => u && !/pypi\.org/.test(u));
  if (process.env.npm_config_registry && !/registry\.npmjs\.org/.test(process.env.npm_config_registry)) return true;
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  for (let d = cwd; ; d = path.dirname(d)) {
    for (const f of [path.join(d, '.npmrc')]) {
      let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*(@[\w.-]+:)?registry\s*=\s*(\S+)/); if (!m) continue;
        if (/registry\.npmjs\.org/.test(m[2])) continue;
        if (!m[1] || (scope && m[1] === scope + ':')) return true;
      }
    }
    if (path.dirname(d) === d) break;
  }
  try { const txt = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8'); for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*(@[\w.-]+:)?registry\s*=\s*(\S+)/); if (m && !/registry\.npmjs\.org/.test(m[2]) && (!m[1] || (scope && m[1] === scope + ':'))) return true; } } catch {}
  return false;
}

// ---------- registry lookups ----------
let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
let cacheDirty = false;
const saveCache = () => { if (!cacheDirty) return; try { const now = Date.now(); for (const k of Object.keys(cache)) if (now - cache[k].t > CACHE_MS) delete cache[k]; fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {} };
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { 'user-agent': 'package-guard (claude-skills)' } });
  if (r.status === 404) return { status: 404 };
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return { status: 200, body: await r.json() };
}
const enc = n => n.startsWith('@') ? '@' + encodeURIComponent(n.slice(1)) : encodeURIComponent(n);

async function infoNpm(name) {
  const [latest, dl] = await Promise.all([getJson(`https://registry.npmjs.org/${enc(name)}/latest`), getJson(`https://api.npmjs.org/downloads/point/last-week/${name}`).catch(() => null)]);
  if (latest.status === 404) {
    // /latest 404s when there's no "latest" tag too (e.g. only prereleases): confirm with the full document
    const full = await getJson(`https://registry.npmjs.org/${enc(name)}`);
    if (full.status === 404) return { exists: false };
    return { exists: true, weekly: dl?.body?.downloads ?? null, created: full.body.time?.created ?? null, scripts: [], deprecated: null, note: 'no "latest" dist-tag' };
  }
  const v = latest.body, weekly = dl?.status === 200 ? dl.body.downloads : null;
  const scripts = ['preinstall', 'install', 'postinstall'].filter(s => v.scripts?.[s]);
  const info = { exists: true, version: v.version, weekly, scripts, deprecated: typeof v.deprecated === 'string' ? v.deprecated || 'deprecated' : null,
    placeholder: /-security$/.test(v.version || '') || /npm\/security-holder/.test(JSON.stringify(v.repository || v.bugs || '')) };
  // only fetch the (possibly multi-MB) full document for packages that aren't already popular
  if (weekly === null || weekly < POPULAR_DL) { try { const full = await getJson(`https://registry.npmjs.org/${enc(name)}`); info.created = full.body?.time?.created ?? null; } catch {} }
  return info;
}
async function infoPypi(name) {
  const n = pyNorm(name);
  const [j, st] = await Promise.all([getJson(`https://pypi.org/pypi/${encodeURIComponent(n)}/json`), getJson(`https://pypistats.org/api/packages/${encodeURIComponent(n)}/recent`).catch(() => null)]);
  if (j.status === 404) return { exists: false };
  const rel = j.body.releases || {}, ups = Object.values(rel).flat().map(f => f.upload_time_iso_8601 || f.upload_time).filter(Boolean).sort();
  const cls = j.body.info?.classifiers || [];
  return { exists: true, version: j.body.info?.version, created: ups[0] || null, releases: Object.keys(rel).length,
    weekly: st?.status === 200 ? st.body?.data?.last_week ?? null : null,
    deprecated: j.body.info?.yanked ? `latest release is yanked${j.body.info.yanked_reason ? ': ' + j.body.info.yanked_reason : ''}` : cls.some(c => /7 - Inactive/.test(c)) ? 'marked "Development Status :: 7 - Inactive"' : null, scripts: [] };
}
async function lookup(eco, name) {
  const key = eco + ':' + (eco === 'pypi' ? pyNorm(name) : name);
  if (cache[key] && Date.now() - cache[key].t < CACHE_MS) return cache[key].info;
  const info = eco === 'npm' ? await infoNpm(name) : await infoPypi(name);
  cache[key] = { t: Date.now(), info }; cacheDirty = true;
  return info;
}

// ---------- decision ----------
const REG = { npm: 'npm', pypi: 'PyPI' };
export function decide(eco, name, info, now = Date.now()) {
  const reasons = [], label = `${eco === 'npm' ? 'npm' : 'pypi'}:${name}`;
  if (!info.exists) {
    const m = nearest(eco, name, 3);
    return { action: 'block', label, reasons: [`does not exist on ${REG[eco]} — possibly a hallucinated name${m ? `; did you mean ${m}?` : ''}`] };
  }
  if (info.placeholder) { const m = nearest(eco, name, 3); return { action: 'block', label, reasons: [`is an npm security placeholder (the original was removed as malicious or a typosquat)${m ? `; did you mean ${m}?` : ''}`] }; }
  const popular = isPopularName(eco, name) || (info.weekly ?? 0) >= POPULAR_DL;
  const ageDays = info.created ? (now - Date.parse(info.created)) / DAY : null;
  if (!popular) { const m = nearest(eco, name); if (m) reasons.push(`looks like a typo of ${m}`); }
  if (ageDays !== null && ageDays < NEW_DAYS) reasons.push(`was first published ${Math.max(0, Math.floor(ageDays))} day(s) ago`);
  if (info.weekly !== null && info.weekly !== undefined && info.weekly < LOW_DL) reasons.push(`has only ${info.weekly} downloads last week`);
  if (info.scripts?.length && !isPopularName(eco, name) && ((info.weekly != null && info.weekly < SCRIPT_DL) || (ageDays !== null && ageDays < 90))) reasons.push(`runs install scripts (${info.scripts.join(', ')}) and is new or not widely used`);
  if (info.deprecated) reasons.push(`is deprecated: ${String(info.deprecated).slice(0, 160)}`);
  return { action: reasons.length ? 'ask' : 'allow', label, reasons, info };
}

async function evaluate(pkgs, limit = 6) { // at most `limit` lookups in flight
  const results = [], queue = pkgs.map((p, i) => [p, i]);
  const worker = async () => { for (let job; (job = queue.shift());) results[job[1]] = await evaluateOne(job[0]); };
  await Promise.all(Array.from({ length: Math.min(limit, pkgs.length) }, worker));
  return results;
}
async function evaluateOne(p) {
  {
    if (privateRegistry(p.eco, p.name, p.cwd || process.cwd())) return { action: 'allow', label: `${p.eco}:${p.name}`, reasons: [], note: 'private registry configured; skipped' };
    try { return decide(p.eco, p.name, await lookup(p.eco, p.name)); }
    catch (e) { return { action: 'allow', label: `${p.eco}:${p.name}`, reasons: [], error: e.name === 'TimeoutError' ? `registry timeout after ${FETCH_MS / 1000}s` : e.message }; }
  }
}

// ---------- modes ----------
async function hook() {
  setTimeout(() => process.exit(0), HOOK_BUDGET_MS).unref(); // fail open if the network hangs
  let ev; try { ev = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
  const cmd = ev?.tool_input?.command;
  if (!['Bash', 'PowerShell'].includes(ev?.tool_name) || typeof cmd !== 'string' || process.env.PACKAGE_GUARD_OFF === '1') return 0;
  if (!/\b(npm|pnpm|yarn|bun|npx|bunx|pnpx|pip[\d.]*|uv|uvx|poetry|pipx|python[\d.]*|py)\b/i.test(cmd)) return 0; // fast path
  const pkgs = parseCommand(cmd, ev.cwd || process.cwd());
  if (!pkgs.length) return 0;
  const res = await evaluate(pkgs); saveCache();
  const errs = res.filter(r => r.error);
  if (errs.length) process.stderr.write(`package-guard: could not check ${errs.map(r => r.label).join(', ')} (${errs[0].error}); allowed.\n`);
  const blocks = res.filter(r => r.action === 'block'), asks = res.filter(r => r.action === 'ask');
  if (blocks.length) {
    process.stderr.write(`package-guard blocked this install:\n${blocks.map(r => `  - ${r.label} ${r.reasons.join('; ')}`).join('\n')}\n` +
      `Check the exact package name (registry page, the project's docs) before trying again. Do not guess a similar name.\n`);
    return 2;
  }
  if (asks.length) {
    const reason = `package-guard: ${asks.map(r => `${r.label} ${r.reasons.join('; ')}`).join(' | ')}. Confirm this is the package you meant.`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }));
  }
  return 0;
}

async function check(args) {
  const json = args.includes('--json'); args = args.filter(a => a !== '--json');
  if (!args.length) { console.log('usage: node package-guard.mjs check <pkg> [npm:<pkg>] [pypi:<pkg>] … [--json]'); return 1; }
  const pkgs = args.map(a => { const m = a.match(/^(npm|pypi|pip|py):(.+)$/i); return m ? { eco: /^npm$/i.test(m[1]) ? 'npm' : 'pypi', name: m[2] } : { eco: 'npm', name: a }; });
  const res = await evaluate(pkgs); saveCache();
  if (json) { console.log(JSON.stringify(res, null, 2)); return res.some(r => r.action === 'block') ? 2 : 0; }
  for (const r of res) {
    const i = r.info || {}, facts = [i.version && `v${i.version}`, i.weekly != null && `${i.weekly.toLocaleString('en-US')}/week`, i.created && `since ${i.created.slice(0, 10)}`, i.releases && `${i.releases} releases`, i.scripts?.length && `scripts: ${i.scripts.join(',')}`].filter(Boolean).join(', ');
    console.log(`${r.action.toUpperCase().padEnd(5)} ${r.label}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}${facts ? `  (${facts})` : ''}${r.error ? `  [not checked: ${r.error}]` : ''}${r.note ? `  [${r.note}]` : ''}`);
  }
  return res.some(r => r.action === 'block') ? 2 : 0;
}

const [mode, ...rest] = process.argv.slice(2);
const run = async () => {
  if (mode === 'hook') return hook();
  if (mode === 'check') return check(rest);
  if (mode === 'parse') { const p = parseCommand(rest.join(' ')); console.log(p.map(x => `${x.eco}:${x.name}`).join(' ') || '(none)'); return 0; }
  console.log('usage: node package-guard.mjs hook | check <pkg|npm:pkg|pypi:pkg>… [--json] | parse "<command>"'); return 1;
};
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  run().then(code => process.exit(code ?? 0), e => { if (mode === 'hook') { process.stderr.write(`package-guard error (allowed): ${e.message}\n`); process.exit(0); } console.error(e); process.exit(1); });
}
