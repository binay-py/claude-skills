#!/usr/bin/env node
// env-doctor — environment variables: what the code uses vs what .env / .env.example define.
// Finds undocumented, stale, unset and browser-exposed secret variables, real secrets in .env.example,
// and .env files committed to git. Never prints values. Zero dependencies. Node 22+.
//
//   node env-doctor.mjs [project-dir]
//   node env-doctor.mjs . --fix-example      append missing keys (empty) to .env.example, with a backup
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const root = path.resolve(argv.find(a => !a.startsWith('--')) || '.');
const FIX = argv.includes('--fix-example');
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.output|coverage|vendor|venv|\.venv|env|__pycache__|target|\.turbo|\.cache|\.vercel|\.wrangler)$/;
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|py|rb|go|php|rs|sh|bash|ya?ml|toml)$/i;
const RUNTIME = new Set('NODE_ENV PORT HOST HOME PATH PWD USER USERNAME SHELL TERM LANG TZ CI DEBUG TMPDIR TEMP TMP APPDATA LOCALAPPDATA USERPROFILE HOSTNAME VERCEL VERCEL_ENV VERCEL_URL NETLIFY RENDER RAILWAY_ENVIRONMENT CF_PAGES GITHUB_ACTIONS GITHUB_TOKEN npm_package_version npm_lifecycle_event BASE_URL MODE DEV PROD SSR VITE_USER_NODE_ENV NEXT_RUNTIME PYTHONPATH VIRTUAL_ENV GOPATH CARGO_MANIFEST_DIR RUST_LOG'.split(' '));
const PUBLIC_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_|VUE_APP_|STORYBOOK_)/;
const SECRETY = /(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|PASSWD|_PWD$|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|REFRESH_TOKEN|WEBHOOK|SIGNING|ENCRYPTION|DATABASE_URL|DB_URL|CONNECTION_STRING)/i;
const PUBLIC_OK = /(PUBLISHABLE|PUBLIC_KEY|ANON_KEY|SITE_KEY|MEASUREMENT_ID|CLIENT_ID|APP_ID|PROJECT_ID|DSN)/i;
const SECRET_VALUE = /-----BEGIN|\bsk-ant-|\bsk-(proj-)?[A-Za-z0-9_-]{32,}|\b[sr]k_live_|\bwhsec_|\bAKIA[0-9A-Z]{16}|\bgh[pousr]_[0-9A-Za-z]{30,}|\bgithub_pat_|\bxox[abprs]-|\bAIza[0-9A-Za-z_-]{35}|\bglpat-|\bnpm_[0-9A-Za-z]{36}|\beyJ[A-Za-z0-9_-]{15,}\.eyJ|:\/\/[^\s:@/]+:[^\s@/]{3,}@/;
const PLACEHOLDER = /^(|changeme|change_me|your[-_ ].*|<.*>|\$\{.*\}|xxx+|\*+|todo|example|placeholder|replace[-_ ]?me|secret|password|sk_test_.*|pk_test_.*|http:\/\/localhost.*|true|false|\d{1,5})$/i;

// ---------- collect usage in code ----------
const used = new Map(); // name -> Set(files)
const note = (name, file) => { if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.length < 2) return; (used.get(name) || used.set(name, new Set()).get(name)).add(path.relative(root, file).split(path.sep).join('/')); };
const PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g, /process\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g, /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /Bun\.env\.([A-Z_][A-Z0-9_]*)/g,
  /os\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g, /os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\bENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g, /\bENV\.fetch\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g, /\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /\$_(?:ENV|SERVER)\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /env::var(?:_os)?\(\s*"([A-Z_][A-Z0-9_]*)"/g, /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
];
function scan(file) {
  let t; try { if (fs.statSync(file).size > 2e6) return; t = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const re of PATTERNS) for (const m of t.matchAll(re)) note(m[1], file);
  for (const m of t.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env)/g)) // destructuring
    for (const part of m[1].split(',')) { const n = part.trim().split(/[:=\s]/)[0]; if (n) note(n, file); }
  if (/\.(sh|bash|ya?ml|toml)$/i.test(file) || /docker-compose|compose\.ya?ml|Dockerfile/i.test(file)) for (const m of t.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::?[-?][^}]*)?\}/g)) note(m[1], file);
}
(function walk(d) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name) && !(e.name.startsWith('.') && e.name !== '.github')) walk(p); }
    else if (CODE.test(e.name) || /^(Dockerfile|docker-compose.*)$/i.test(e.name)) scan(p);
  }
})(root);

// ---------- env files ----------
function parseEnv(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/); if (!m) continue;
    let v = m[2].trim(); if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    out.set(m[1], v);
  }
  return out;
}
const envFiles = fs.readdirSync(root).filter(f => /^\.env(\..+)?$/.test(f) && fs.statSync(path.join(root, f)).isFile());
const EXAMPLE = envFiles.find(f => /^\.env\.(example|sample|template|dist|defaults)$/.test(f));
const LOCAL = envFiles.filter(f => f !== EXAMPLE);
const example = EXAMPLE ? parseEnv(path.join(root, EXAMPLE)) : null;
const local = new Map(); for (const f of LOCAL) for (const [k, v] of parseEnv(path.join(root, f))) if (!local.has(k)) local.set(k, { v, f });

// ---------- findings ----------
const findings = []; const add = (sev, msg) => findings.push({ sev, msg });
const names = [...used.keys()].filter(n => !RUNTIME.has(n)).sort();
const where = n => { const s = [...used.get(n)]; return s.slice(0, 2).join(', ') + (s.length > 2 ? ` +${s.length - 2}` : ''); };

for (const n of names) if (PUBLIC_PREFIX.test(n) && SECRETY.test(n.replace(PUBLIC_PREFIX, '')) && !PUBLIC_OK.test(n))
  add('high', `${n} is bundled into the browser (${n.match(PUBLIC_PREFIX)[1]} prefix) but its name says it's a secret. Anyone can read it in the page source. Move it server-side (${where(n)})`);
if (example) {
  const LOCALISH = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|mysql|redis|mongo|example\.(com|org))\b|:\/\/(user|username|postgres|root|admin):(pass|password|postgres|secret|changeme)@/i;
  for (const [k, v] of example) if (v && !PLACEHOLDER.test(v) && !LOCALISH.test(v) && SECRET_VALUE.test(v)) add('high', `${EXAMPLE} has a real-looking value for ${k}. Example files get committed; replace it with a placeholder and rotate the key`);
  const undocumented = names.filter(n => !example.has(n));
  if (undocumented.length) add('medium', `${undocumented.length} variable(s) used in code but missing from ${EXAMPLE}, so new setups won't know to set them: ${undocumented.map(n => `${n} (${where(n)})`).slice(0, 12).join(', ')}${undocumented.length > 12 ? ' …' : ''}`);
  const stale = [...example.keys()].filter(k => !used.has(k) && !RUNTIME.has(k));
  if (stale.length) add('low', `${stale.length} variable(s) in ${EXAMPLE} that no code reads (stale, or read by a tool/framework config): ${stale.slice(0, 12).join(', ')}`);
} else if (names.length) add('medium', `no .env.example: ${names.length} variable(s) used in code are documented nowhere. Run with --fix-example to create one`);
if (LOCAL.length) {
  const unset = names.filter(n => !local.has(n) && !(example && example.get(n)));
  if (unset.length) add('medium', `${unset.length} variable(s) used in code but not set in ${LOCAL.join(' / ')}. They'll be undefined locally: ${unset.slice(0, 12).join(', ')}${unset.length > 12 ? ' …' : ''}`);
  const empty = names.filter(n => local.has(n) && local.get(n).v === '');
  if (empty.length) add('low', `set but empty in ${[...new Set(empty.map(n => local.get(n).f))].join(', ')}: ${empty.join(', ')}`);
}
const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).stdout.trim() === 'true';
if (inGit) for (const f of LOCAL) {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', f], { cwd: root }).status === 0;
  const ignored = spawnSync('git', ['check-ignore', '-q', f], { cwd: root }).status === 0;
  const hist = spawnSync('git', ['log', '--all', '--full-history', '--format=%h', '--', f], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  if (tracked) add('high', `${f} is committed to git. Every value in it is exposed to anyone with the repo: git rm --cached ${f}, add it to .gitignore, and rotate the secrets`);
  else if (hist.length) add('high', `${f} was committed in the past (${hist.length} commit(s), e.g. ${hist[0]}). The values are still in git history; rotate them`);
  if (!ignored && !tracked) add('medium', `${f} is not in .gitignore. The next "git add ." will commit it`);
}

// ---------- report ----------
console.log(`env-doctor: ${root}\n  code uses ${names.length} variable(s)${used.size - names.length ? ` (+${used.size - names.length} standard runtime ones ignored)` : ''} · env files: ${envFiles.join(', ') || 'none'}\n`);
const ORDER = { high: 0, medium: 1, low: 2 };
if (!findings.length) console.log('✓ everything lines up');
for (const f of findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev])) console.log(`${f.sev === 'high' ? '✘' : f.sev === 'medium' ? '!' : '·'} [${f.sev}] ${f.msg}`);
if (FIX) {
  const target = path.join(root, EXAMPLE || '.env.example'), missing = names.filter(n => !(example && example.has(n)));
  if (!missing.length) console.log('\n--fix-example: nothing to add');
  else {
    if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak');
    const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    fs.writeFileSync(target, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + `\n# added by env-doctor: used in code, fill in a placeholder or description\n` + missing.map(n => `${n}=`).join('\n') + '\n');
    console.log(`\n--fix-example: added ${missing.length} key(s) to ${path.basename(target)}${fs.existsSync(target + '.bak') ? ' (backup: ' + path.basename(target) + '.bak)' : ''}`);
  }
}
process.exitCode = findings.some(f => f.sev === 'high') ? 1 : 0;
