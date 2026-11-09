#!/usr/bin/env node
// release-notes — grouped release notes / CHANGELOG section from git history. Zero dependencies. Node 22+.
//
//   node release-notes.mjs                          last tag..HEAD, print a Keep-a-Changelog section
//   node release-notes.mjs --version 1.4.0          use this version in the header
//   node release-notes.mjs --from v1.2.0 --to v1.3.0
//   node release-notes.mjs --format github          GitHub release body ("What's Changed" + compare link)
//   node release-notes.mjs --version 1.4.0 --changelog CHANGELOG.md --write   insert at the top (backup first)
//   node release-notes.mjs --repo-url none          no links (default: auto from `git remote get-url origin`)
//   node release-notes.mjs --cwd path/to/repo
//
// Read-only unless --write. Never creates tags, commits or pushes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------- args ----------
const argv = process.argv.slice(2), opt = { to: 'HEAD', format: 'md', 'repo-url': 'auto' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--write') opt.write = true;
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
  else if (a.startsWith('--')) { const [k, v] = a.includes('=') ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a.slice(2), argv[++i]]; if (v === undefined) die(`missing value for --${k}`); opt[k] = v; }
  else die(`unknown argument: ${a}`);
}
function die(m) { console.error(`release-notes: ${m}`); process.exit(2); }
if (!['md', 'github'].includes(opt.format)) die('--format must be md or github');
if (opt.write && !opt.changelog) die('--write needs --changelog <file>');
const cwd = path.resolve(opt.cwd || '.');
const git = (...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); return r.status === 0 ? r.stdout.trim() : null; };
if (git('rev-parse', '--is-inside-work-tree') !== 'true') die(`${cwd} is not a git repository`);
if (!git('rev-parse', '--verify', '--quiet', opt.to + '^{commit}')) die(`unknown ref --to ${opt.to}`);

// ---------- range ----------
const notes = [];
let from = opt.from, prevTag = null;
if (from) { if (!git('rev-parse', '--verify', '--quiet', from + '^{commit}')) die(`unknown ref --from ${from}`); prevTag = from; }
else {
  let tag = git('describe', '--tags', '--abbrev=0', opt.to);
  // --to is itself tagged (release just tagged): describe that tag's release, from the tag before it
  if (tag && git('rev-parse', tag + '^{commit}') === git('rev-parse', opt.to + '^{commit}')) {
    const before = git('describe', '--tags', '--abbrev=0', tag + '^');
    if (!opt.version) opt.version = tag.replace(/^v/, '');
    notes.push(`${opt.to} is tagged ${tag}; describing ${before ? before + '..' + tag : 'everything up to ' + tag}`);
    tag = before;
  }
  if (tag) { from = tag; prevTag = tag; } else notes.push('no earlier tag found: using the whole history');
}
const range = from ? `${from}..${opt.to}` : opt.to;

// ---------- remote ----------
function parseRemote(u) {
  if (!u) return null;
  u = u.trim().replace(/\.git\/?$/, '').replace(/\/$/, '');
  let host, p;
  let m = u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (m) [, host, p] = m;
  else if ((m = u.match(/^(?:[^@]+@)?([^:/]+):(.+)$/))) [, host, p] = m; // scp-like: git@github.com:owner/repo
  if (!host || !p) return null;
  host = host.toLowerCase().replace(/^ssh\./, '');
  const kind = host === 'github.com' || host.endsWith('.github.com') ? 'github' : host.includes('gitlab') ? 'gitlab' : null;
  return kind ? { kind, base: `https://${host}/${p}` } : null;
}
let repo = null;
if (opt['repo-url'] === 'auto') repo = parseRemote(git('remote', 'get-url', 'origin'));
else if (opt['repo-url'] !== 'none') { repo = parseRemote(opt['repo-url']); if (!repo) repo = { kind: 'github', base: opt['repo-url'].replace(/\/$/, '') }; }
const link = {
  commit: (h, full) => repo ? `[${h}](${repo.base}/${repo.kind === 'gitlab' ? '-/' : ''}commit/${full})` : h,
  pr: (n, sigil) => repo ? `[${sigil}${n}](${repo.base}/${repo.kind === 'gitlab' && sigil === '!' ? '-/merge_requests' : repo.kind === 'gitlab' ? '-/issues' : 'pull'}/${n})` : `${sigil}${n}`,
  compare: (a, b) => repo && a ? `${repo.base}/${repo.kind === 'gitlab' ? '-/' : ''}compare/${a}...${b}` : null,
};

// ---------- commits ----------
const RS = '\x1e', US = '\x1f';
const log = git('log', '--no-color', '--date=short', `--format=%H${US}%h${US}%an${US}%ae${US}%ad${US}%P${US}%s${US}%b${RS}`, range);
if (log === null) die(`git log ${range} failed`);
const commits = log.split(RS).map(s => s.replace(/^\n/, '')).filter(Boolean).map(r => {
  const [hash, short, author, email, date, parents, subject, body = ''] = r.split(US);
  return { hash, short, author, email, date, parents: parents.split(' ').filter(Boolean), subject: subject.trim(), body: body.trim() };
});

const CC = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;
const CC_TYPES = { feat: 'Added', feature: 'Added', add: 'Added', fix: 'Fixed', bugfix: 'Fixed', hotfix: 'Fixed', perf: 'Performance', refactor: 'Changed', revert: 'Changed', style: 'Changed', docs: 'Docs', doc: 'Docs', test: 'Tests', tests: 'Tests', build: 'Build & CI', ci: 'Build & CI', chore: 'Maintenance', deps: 'Maintenance', security: 'Security', deprecate: 'Deprecated', remove: 'Removed' };
const WORDS = [
  [/^(security|cve-\d+)/i, 'Security'],
  [/^(add|adds|added|adding|new|introduce[sd]?|create[sd]?|implement(s|ed)?|support(s|ed)?|initial)\b/i, 'Added'],
  [/^(fix|fixes|fixed|fixing|resolve[sd]?|correct(s|ed)?|patch(es|ed)?|repair(s|ed)?|prevent(s|ed)?|handle[sd]?)\b/i, 'Fixed'],
  [/^(remove[sd]?|removing|delete[sd]?|deleting|drop(s|ped)?|strip(s|ped)?)\b/i, 'Removed'],
  [/^(deprecate[sd]?)\b/i, 'Deprecated'],
  [/^(docs?|readme|document(s|ed)?|documentation|typo)\b/i, 'Docs'],
  [/^(update[sd]?|updating|change[sd]?|improve[sd]?|improving|refactor(s|ed)?|rename[sd]?|move[sd]?|upgrade[sd]?|tweak(s|ed)?|clean(s|ed)?( up)?|simplif(y|ies|ied)|rework(s|ed)?|rewrite|rewrote|replace[sd]?|speed( up)?|make|use|switch(es|ed)?|allow(s|ed)?|enable[sd]?|disable[sd]?)\b/i, 'Changed'],
  [/^(test|tests)\b/i, 'Tests'],
];
const SKIP = [
  [c => c.parents.length > 1 || /^Merge (branch|pull request|remote-tracking branch|tag|.* into )/i.test(c.subject), 'merge'],
  [c => /^(fixup|squash|amend)!/i.test(c.subject), 'fixup'],
  [c => /^\W*wip\b/i.test(c.subject), 'wip'],
  [c => /^(initial|first) commit\.?$/i.test(c.subject), 'initial commit'],
  [c => /^(chore(\([^)]*\))?:\s*)?((release|bump|version|bump version)( to)?:?\s*)?v?\d+\.\d+\.\d+([-+][\w.]+)?$/i.test(c.subject) || /^(chore(\([^)]*\))?:\s*)?(release|bump( version)?)( to)?\s+v?\d+\.\d+\.\d+\S*$/i.test(c.subject), 'version bump'],
];
const ORDER = ['Breaking', 'Security', 'Added', 'Changed', 'Performance', 'Deprecated', 'Removed', 'Fixed', 'Docs', 'Tests', 'Build & CI', 'Maintenance'];
const groups = Object.fromEntries(ORDER.map(k => [k, []]));
const skipped = {}, seenSubj = new Set(), people = new Map();
let usedCC = 0, dupes = 0;
const person = (name, email) => { const k = (email || name).toLowerCase(); if (!people.has(k)) people.set(k, { name, email, commits: 0 }); return people.get(k); };

for (const c of commits) {
  const why = SKIP.find(([t]) => t(c))?.[1];
  if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
  let scope = null, text = c.subject, group, breaking = false;
  const m = c.subject.match(CC);
  if (m && CC_TYPES[m[1].toLowerCase()]) { usedCC++; group = CC_TYPES[m[1].toLowerCase()]; scope = m[2] || null; breaking = !!m[3]; text = m[4]; }
  else {
    const p = c.subject.match(/^([\w./-]{2,40}):\s+(.+)$/); // free-form "area: message"
    const lead = p && WORDS.find(([re]) => re.test(p[1]) && p[1].length === p[1].match(re)[0].length)?.[1];
    if (p && lead) { group = lead; text = p[2]; } // "New: x", "Fix: y", "README: z"
    else {
      if (p && !/^https?$/i.test(p[1])) { scope = p[1]; text = p[2]; }
      group = WORDS.find(([re]) => re.test(text))?.[1] || 'Changed';
    }
  }
  const bc = c.body.match(/^BREAKING[ -]CHANGES?:\s*([\s\S]+?)(?:\n\s*\n|\n[\w-]+:\s|$)/m);
  if (bc) breaking = true;
  // PR / MR refs in subject or "(#12)" squash-merge suffix; strip them from the text, link them separately
  const refs = [...new Set([...c.subject.matchAll(/(?:^|[\s(])([#!])(\d+)\b/g)].map(r => r[1] + r[2]))];
  text = text.replace(/\s*\((?:[#!]\d+(?:,\s*)?)+\)\s*$/, '').trim();
  if (/^[a-z]+(\s|$)/.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1); // leave `foo-bar`, `npm`-style names alone
  const key = (scope || '') + '|' + text.toLowerCase().replace(/[.\s]+$/, '');
  person(c.author, c.email).commits++;
  for (const t of c.body.matchAll(/^co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/gim)) person(t[1], t[2]).coauthor = true;
  if (seenSubj.has(key)) { dupes++; continue; } seenSubj.add(key);
  const extra = [...refs.map(r => link.pr(r.slice(1), r[0])), link.commit(c.short, c.hash)].join(', ');
  const bullet = `- ${scope ? `**${scope}:** ` : ''}${text} (${extra})`;
  if (breaking) groups.Breaking.push(bullet + (bc ? `\n  ${bc[1].trim().replace(/\s*\n\s*/g, ' ')}` : ''));
  else groups[group].push(bullet);
}
const kept = ORDER.reduce((n, k) => n + groups[k].length, 0);

// ---------- version + semver suggestion ----------
const semver = s => { const m = String(s || '').match(/^v?(\d+)\.(\d+)\.(\d+)/); return m ? m.slice(1, 4).map(Number) : null; };
const bump = groups.Breaking.length ? 'major' : groups.Added.length ? 'minor' : 'patch';
const cur = semver(prevTag);
let suggested = null;
if (cur) { const [a, b, c] = cur; suggested = bump === 'major' ? (a === 0 ? `0.${b + 1}.0` : `${a + 1}.0.0`) : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`; }
else suggested = groups.Breaking.length || groups.Added.length ? '0.1.0' : '0.0.1';
const version = opt.version ? opt.version.replace(/^v/, '') : null;
const today = opt.date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// ---------- render ----------
const contributors = [...people.values()].sort((a, b) => b.commits - a.commits).map(p => `- ${p.name}${p.coauthor && !p.commits ? ' (co-author)' : ''}`);
function render() {
  const out = [];
  const sec = (h, items) => { if (items.length) out.push(`${h}\n\n${items.join('\n')}\n`); };
  if (opt.format === 'github') {
    out.push(`## What's Changed\n`);
    for (const k of ORDER) sec(`### ${k === 'Breaking' ? '⚠ Breaking changes' : k}`, groups[k]);
    sec('### Contributors', contributors);
    const cmp = link.compare(prevTag, version ? (git('rev-parse', '--verify', '--quiet', 'v' + version) ? 'v' + version : git('rev-parse', '--verify', '--quiet', version) ? version : opt.to) : opt.to);
    if (cmp) out.push(`**Full Changelog**: ${cmp}\n`);
  } else {
    out.push(version ? `## [${version}] - ${today}\n` : `## [Unreleased]\n`);
    for (const k of ORDER) sec(`### ${k}`, groups[k]);
    sec('### Contributors', contributors);
  }
  return out.join('\n').trimEnd() + '\n';
}
const section = render();

// ---------- summary (stderr, so stdout stays pipeable) ----------
const say = s => console.error(s);
say(`release-notes: ${path.basename(cwd)}  range ${range}  (${commits.length} commit${commits.length === 1 ? '' : 's'})`);
for (const n of notes) say(`  note: ${n}`);
say(`  kept ${kept}, skipped ${Object.values(skipped).reduce((a, b) => a + b, 0)}${Object.keys(skipped).length ? ' (' + Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(', ') + ')' : ''}, ${dupes} duplicate subject(s) merged`);
say(`  style: ${!kept ? 'n/a' : usedCC && usedCC >= kept / 2 ? 'Conventional Commits' : usedCC ? `mixed (${usedCC} conventional)` : 'free-form (grouped by first word)'}; links: ${repo ? repo.base : 'none (no GitHub/GitLab origin)'}`);
say(`  groups: ${ORDER.filter(k => groups[k].length).map(k => `${k} ${groups[k].length}`).join(', ') || 'none'}`);
say(`  suggested bump: ${bump} → ${suggested}${cur ? ` (from ${prevTag})` : ' (no semver tag found)'}${version ? `; using --version ${version}` : '; pass --version to set it'}`);
say('');

if (!kept) { say('nothing to release: no user-facing commits in range'); process.exit(0); }

if (!opt.write) { process.stdout.write(section); process.exit(0); }

// ---------- --write ----------
if (opt.format !== 'md') die('--write only supports --format md');
const file = path.resolve(cwd, opt.changelog);
const HEADER = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n';
const exists = fs.existsSync(file);
let text = exists ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : HEADER;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const label = version || 'Unreleased';
const hdrRe = new RegExp(`^## \\[?v?${esc(label)}\\]?(?=[\\s]|$)`, 'mi');
let next;
if (hdrRe.test(text)) {
  if (version) { say(`${path.basename(file)} already has a ## [${version}] section: nothing written (delete it first to regenerate)`); process.exit(0); }
  // [Unreleased] is meant to be regenerated: replace that section
  const start = text.search(hdrRe), after = text.slice(start + 3).search(/^## /m);
  next = text.slice(0, start) + section + (after === -1 ? '' : '\n' + text.slice(start + 3 + after));
} else {
  // insert before the first version section (below [Unreleased] if present), else at the end of the header
  const lines = text.split('\n'); let at = lines.findIndex(l => /^## /.test(l) && !/^## \[?unreleased\]?/i.test(l));
  if (at === -1) { next = text.replace(/\n*$/, '\n\n') + section; }
  else { next = lines.slice(0, at).join('\n').replace(/\n*$/, '\n\n') + section + '\n' + lines.slice(at).join('\n'); }
  if (/^## \[?unreleased\]?/im.test(text)) say('note: the file has an [Unreleased] section; move or delete its entries if they are part of this release');
}
if (next === text) { say('no change'); process.exit(0); }
if (exists) { fs.copyFileSync(file, file + '.bak'); say(`backup: ${file}.bak`); }
fs.writeFileSync(file, next);
say(`${exists ? 'updated' : 'created'} ${file} with ## [${label}]`);
process.stdout.write(section);
