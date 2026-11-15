// node tests/run.mjs: offline tests for cf-backup (no network, no wrangler, no Cloudflare account).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const script = fileURLToPath(new URL('../scripts/cf-backup.mjs', import.meta.url));
const B = await import(pathToFileURL(script).href);
let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('✘ ' + msg); } };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-test-'));
const cli = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8', cwd: base, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: '' } });
const mk = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

try {
  // ---------- 1. KV entry encode/decode round trip ----------
  const values = [
    ['text', Buffer.from('{"order":1,"name":"Ann"}')],
    ['unicode', Buffer.from('नमस्ते 👋 “quotes”')],
    ['empty', Buffer.alloc(0)],
    ['bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('after bom')])],
    ['literal U+FFFD', Buffer.from('a � b')],
    ['invalid utf8', Buffer.from([0x61, 0xff, 0xfe, 0x62])],
    ['audio-ish', crypto.randomBytes(70000)],
    ['lone continuation byte', Buffer.from([0x80])],
    ['nul bytes', Buffer.from([0, 0, 0])],
  ];
  const exp = 2000000000;
  const dirKv = mk('kv-roundtrip');
  const w = new B.ChunkWriter(dirKv, 'part', { maxBytes: 40000 });
  values.forEach(([key, bytes], i) => w.add(B.encodeKvEntry({ key: `k/${i} ${key} & "q"`, bytes, expiration: i % 2 ? exp : undefined, metadata: i % 3 ? undefined : { i, tag: 'x' } })));
  const files = w.close();
  ok(files.length > 1, `ChunkWriter rotates on maxBytes (${files.length} files)`);
  ok(files.reduce((a, f) => a + f.entries, 0) === values.length, 'ChunkWriter counts every entry');
  const back = files.flatMap(f => B.parseKvFile(path.join(dirKv, f.name)));
  ok(back.length === values.length, 'every entry parses back');
  values.forEach(([key, bytes], i) => {
    const e = back[i], d = B.decodeKvEntry(e);
    ok(d.key === `k/${i} ${key} & "q"`, `key survives: ${key}`);
    ok(Buffer.compare(d.bytes, bytes) === 0, `value bytes survive: ${key}`);
    ok(d.expiration === (i % 2 ? exp : undefined), `expiration survives: ${key}`);
    ok(JSON.stringify(d.metadata) === JSON.stringify(i % 3 ? undefined : { i, tag: 'x' }), `metadata survives: ${key}`);
    // the exact shape `wrangler kv bulk put` validates
    ok(typeof e.key === 'string' && typeof e.value === 'string' && (e.base64 === undefined || e.base64 === true)
      && (e.metadata === undefined || typeof e.metadata === 'object') && (e.expiration === undefined || typeof e.expiration === 'number')
      && Object.keys(e).every(k => ['key', 'value', 'base64', 'expiration', 'metadata'].includes(k)), `bulk-put schema: ${key}`);
  });
  ok(!back[0].base64 && !back[1].base64 && !back[3].base64 && !back[4].base64, 'valid UTF-8 (incl. BOM, literal U+FFFD) is stored as text');
  ok(back[5].base64 && back[6].base64 && back[7].base64, 'invalid UTF-8 is stored as base64');
  ok(back[3].value.charCodeAt(0) === 0xfeff, 'leading BOM is kept in the text value');
  ok(B.encodeKvEntry({ key: 'a', text: 'from bulk' }).value === 'from bulk', 'text from a bulk read is stored as-is');
  ok(fs.readFileSync(path.join(dirKv, files[0].name), 'utf8').split('\n').length === files[0].entries + 3, 'one entry per line inside a JSON array');
  let threw = false;
  try { B.decodeKvEntry({ key: 'x', value: 'not base64!!', base64: true }); } catch { threw = true; }
  ok(threw, 'decode rejects non-canonical base64');
  ok(!B.bulkPutCompatible({ key: 'x', value: 'y', metadata: 'a string' }) && B.bulkPutCompatible({ key: 'x', value: 'y', metadata: { a: 1 } }) && B.bulkPutCompatible({ key: 'x', value: 'y' }),
    'non-object metadata is flagged (wrangler kv bulk put rejects it)');

  // ---------- 2. SQL splitting and checks ----------
  const sql = `PRAGMA defer_foreign_keys=TRUE;
-- a comment; with a semicolon
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, bio TEXT, n INTEGER DEFAULT 0);
CREATE TABLE "odd ""name""" (k TEXT, v BLOB);
CREATE TABLE [br;acket] (x);
CREATE TABLE audit (msg TEXT);
CREATE TRIGGER trg AFTER INSERT ON users BEGIN
  INSERT INTO audit VALUES ('new; ' || NEW.email);
  UPDATE users SET n = CASE WHEN NEW.id > 1 THEN 1 ELSE 0 END WHERE id = NEW.id;
END;
/* block; comment */
INSERT INTO users VALUES(1,'a@example.com','it''s; tricky -- not a comment',0);
INSERT INTO users VALUES(2,'b@example.com','line1
line2; still a string',0);
INSERT INTO "odd ""name""" VALUES('k;1',X'00FF10');
INSERT INTO [br;acket] VALUES('-- x');
`;
  const sp = new B.SqlSplitter();
  const parts = [];
  for (let i = 0; i < sql.length; i += 7) parts.push(...sp.push(sql.slice(i, i + 7))); // tiny chunks: state carries across
  ok(parts.length === 10, `splitter finds 10 statements across chunk boundaries (got ${parts.length})`);
  ok(parts[5].startsWith('CREATE TRIGGER') && parts[5].endsWith('END;'), 'trigger body (with CASE ... END) stays one statement');
  ok(sp.end().state === 0 && !B.stripLead(sp.end().rest), 'splitter ends clean');
  const sqlDir = mk('sql');
  const good = path.join(sqlDir, 'good.sql');
  fs.writeFileSync(good, sql);
  const a = await B.analyzeSqlFile(good);
  ok(a.statements === 10 && !a.problems.length, `analyze: 10 statements, no problems (${a.problems.join('; ')})`);
  ok(a.inserts.users === 2 && a.inserts['odd "name"'] === 1 && a.inserts['br;acket'] === 1, 'INSERTs counted per table, quoted names unquoted');
  if (a.replayed) ok(a.rows.users === 2 && a.rows.audit === 2 && a.tables === 4, 'SQLite replay counts rows (trigger fired)');
  else console.log('  (node:sqlite not available: replay checks skipped)');
  const trunc = path.join(sqlDir, 'trunc.sql');
  fs.writeFileSync(trunc, sql.slice(0, sql.indexOf("tricky") + 3));
  ok((await B.analyzeSqlFile(trunc)).problems.some(p => /quoted string/.test(p)), 'truncated file (inside a string) is a problem');
  const junk = path.join(sqlDir, 'junk.sql');
  fs.writeFileSync(junk, 'hello world; <html>;\n');
  ok((await B.analyzeSqlFile(junk, { sqlite: false })).problems.some(p => /SQL keyword/.test(p)), 'non-SQL statements are a problem');
  const noSemi = path.join(sqlDir, 'nosemi.sql');
  fs.writeFileSync(noSemi, 'CREATE TABLE t(a);\nINSERT INTO t VALUES(1)');
  ok((await B.analyzeSqlFile(noSemi, { sqlite: false })).problems.some(p => /after the last/.test(p)), "missing final ';' is a problem");

  // ---------- 3. manifest + verify ----------
  const mkBackup = async name => {
    const d = mk('verify', name);
    fs.writeFileSync(path.join(d, '.gitignore'), '*\n');
    fs.mkdirSync(path.join(d, 'd1'));
    fs.copyFileSync(good, path.join(d, 'd1', 'app.sql'));
    const kw = new B.ChunkWriter(path.join(d, 'kv', 'orders__abcdef12'), 'part');
    kw.add(B.encodeKvEntry({ key: 'o1', bytes: Buffer.from('{"total":5}') }));
    kw.add(B.encodeKvEntry({ key: 'o2', bytes: crypto.randomBytes(300), metadata: { m: 1 } }));
    kw.close();
    const an = await B.analyzeSqlFile(path.join(d, 'd1', 'app.sql'));
    const m = { tool: B.TOOL, format: 1, name, createdAt: new Date().toISOString(), complete: true, source: 'remote', account: { id: 'f'.repeat(32), name: 'test' }, version: B.VERSION,
      d1: [{ name: 'app', file: 'd1/app.sql', bytes: 1, statements: an.statements, inserts: an.inserts, rows: an.rows, tables: an.tables }],
      kv: [{ id: 'abcdef12' + '0'.repeat(24), title: 'orders', keys: 2, written: 2, text: 1, binary: 1, valueBytes: 311, withMetadata: 1, withExpiration: 0, files: ['kv/orders__abcdef12/part-0001.json'], parts: [{ file: 'kv/orders__abcdef12/part-0001.json', entries: 2 }] }], errors: [] };
    fs.writeFileSync(path.join(d, 'RESTORE.md'), B.restoreMd({ ...m, dir: d }));
    await B.finalizeBackup(d, m);
    return d;
  };
  let d = await mkBackup('cf-backup-20260101-000000Z');
  let v = await B.verifyBackup(d);
  ok(v.ok && v.files === 4, `fresh backup verifies (${v.problems.join('; ')})`);
  ok(cli('verify', d).status === 0, 'CLI verify exits 0 on a good backup');
  const md = fs.readFileSync(path.join(d, 'RESTORE.md'), 'utf8');
  ok(md.includes('npx wrangler kv bulk put "kv/orders__abcdef12/part-0001.json" --namespace-id abcdef12' + '0'.repeat(24) + ' --remote'), 'RESTORE.md has the exact kv bulk put command');
  ok(md.includes('npx wrangler d1 execute app-restored --remote --file "d1/app.sql" -y') && md.includes('npx wrangler d1 create app-restored'), 'RESTORE.md has the exact d1 commands');
  ok(/Nothing below has been run/.test(md), 'RESTORE.md says nothing was run');
  // tamper: flip one byte of the KV file, same size
  const kvf = path.join(d, 'kv', 'orders__abcdef12', 'part-0001.json');
  const orig = fs.readFileSync(kvf);
  const t = Buffer.from(orig); t[10] = t[10] === 0x41 ? 0x42 : 0x41;
  fs.writeFileSync(kvf, t);
  v = await B.verifyBackup(d);
  ok(!v.ok && v.problems.some(p => /part-0001\.json: sha256 doesn't match/.test(p)), 'verify detects a tampered KV file');
  ok(cli('verify', d).status === 1, 'CLI verify exits 1 on a tampered backup');
  fs.writeFileSync(kvf, orig);
  ok((await B.verifyBackup(d)).ok, 'restoring the original bytes verifies again');
  fs.appendFileSync(path.join(d, 'd1', 'app.sql'), "INSERT INTO users VALUES(3,'c','',0);\n");
  v = await B.verifyBackup(d);
  ok(!v.ok && v.problems.some(p => /app\.sql: size/.test(p)) && v.problems.some(p => /statements, manifest says/.test(p)), 'verify detects an edited SQL file (size + statement count)');
  d = await mkBackup('cf-backup-20260101-000001Z');
  fs.rmSync(path.join(d, 'RESTORE.md'));
  fs.writeFileSync(path.join(d, 'extra.txt'), 'x');
  v = await B.verifyBackup(d);
  ok(!v.ok && v.problems.some(p => /RESTORE\.md: missing/.test(p)), 'verify detects a missing file');
  ok(v.warnings.some(w => /extra\.txt: not in the manifest/.test(w)), 'an extra file is a warning');
  ok(!(await B.verifyBackup(mk('verify', 'empty'))).ok, 'a folder without a manifest fails verify');

  // ---------- 4. prune touches only its own folders ----------
  const out = mk('prune');
  const own = (name, createdAt, { complete = true, account = 'a'.repeat(32), tool = 'cf-backup', manifestName = name } = {}) => {
    const dd = mk('prune', name);
    fs.writeFileSync(path.join(dd, 'manifest.json'), JSON.stringify({ tool, name: manifestName, createdAt, complete, account: { id: account }, files: {} }));
    fs.writeFileSync(path.join(dd, 'data.txt'), 'user data');
    return dd;
  };
  own('cf-backup-20260101-000000Z', '2026-01-01T00:00:00Z');
  own('cf-backup-20260102-000000Z', '2026-01-02T00:00:00Z', { complete: false });
  own('cf-backup-20260103-000000Z', '2026-01-03T00:00:00Z');
  own('cf-backup-20260104-000000Z', '2026-01-04T00:00:00Z');
  own('cf-backup-20260105-000000Z', '2026-01-05T00:00:00Z', { complete: false }); // newer failed run: kept
  own('cf-backup-20260106-000000Z', '2026-01-06T00:00:00Z');
  own('cf-backup-20250101-000000Z', '2025-01-01T00:00:00Z', { account: 'b'.repeat(32) }); // other account
  own('cf-backup-20240101-000000Z', '2024-01-01T00:00:00Z', { tool: 'something-else' });
  own('cf-backup-20240102-000000Z', '2024-01-02T00:00:00Z', { manifestName: 'cf-backup-20990101-000000Z' }); // copied manifest
  own('my-photos', '2020-01-01T00:00:00Z'); // our manifest, but not our folder name
  mk('prune', 'cf-backup-20240103-000000Z'); // our name, no manifest
  mk('prune', 'cf-backup-20240104-000000Z.partial');
  fs.writeFileSync(path.join(out, 'cf-backup-20240105-000000Z'), 'a file, not a folder');
  const before = fs.readdirSync(out).sort();
  const dry = cli('prune', out, '--keep', '2', '--dry-run');
  ok(dry.status === 0 && /would delete 3 backups/.test(dry.stdout), `prune --dry-run reports 3 (${dry.stdout.trim()})`);
  ok(JSON.stringify(fs.readdirSync(out).sort()) === JSON.stringify(before), 'prune --dry-run deletes nothing');
  const p = B.prune(out, 2, { account: 'a'.repeat(32) });
  const after = new Set(fs.readdirSync(out));
  ok(JSON.stringify(p.deleted.sort()) === JSON.stringify(['cf-backup-20260101-000000Z', 'cf-backup-20260102-000000Z', 'cf-backup-20260103-000000Z']), `prune --keep 2 deletes the 3 oldest own backups (${p.deleted})`);
  for (const k of ['cf-backup-20260104-000000Z', 'cf-backup-20260105-000000Z', 'cf-backup-20260106-000000Z', 'cf-backup-20250101-000000Z', 'cf-backup-20240101-000000Z', 'cf-backup-20240102-000000Z', 'my-photos', 'cf-backup-20240103-000000Z', 'cf-backup-20240104-000000Z.partial', 'cf-backup-20240105-000000Z'])
    ok(after.has(k), `prune leaves ${k}`);
  ok(B.prune(out, 1, { account: 'b'.repeat(32) }).deleted.length === 0, "another account's only backup is never pruned");
  ok(B.planPrune([{ name: 'cf-backup-20260101-000000Z', manifest: { createdAt: '2026-01-01', complete: false, account: { id: 'x' } } }], 1).length === 0, 'with no complete backup, nothing is pruned');

  // ---------- 5. refuses to write inside a git work tree ----------
  const repo = mk('repo');
  const g = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  if (g.status !== 0) fs.mkdirSync(path.join(repo, '.git'));
  const target = path.join(repo, 'backups', 'nested');
  ok(B.findGitWorkTree(target) && path.resolve(B.findGitWorkTree(target)).toLowerCase() === path.resolve(repo).toLowerCase(), 'findGitWorkTree finds the repo for a path that does not exist yet');
  const r = cli('backup', '--out', target, '--d1', 'x');
  ok(r.status === 2 && /inside the git work tree/.test(r.stderr), `backup into a git work tree is refused (exit ${r.status})`);
  ok(!fs.existsSync(path.join(repo, 'backups')), 'refusal happens before anything is written');
  const wt = mk('worktree-file'); fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
  ok(cli('backup', '--out', path.join(wt, 'b'), '--dry-run').status === 2, 'a .git file (worktree/submodule) counts as a work tree');
  const plain = mk('plain');
  if (!B.findGitWorkTree(os.tmpdir())) ok(B.findGitWorkTree(plain) === null, 'a plain temp folder is not a work tree');

  // ---------- 6. output hygiene ----------
  const red = B.redact('\x1b[31mX\x1b[0m download https://example.r2.cloudflarestorage.com/x?X-Amz-Signature=abc token ' + 'Ab9_'.repeat(12));
  ok(!/https?:|Signature|\x1b/.test(red) && red.includes('<url>') && red.includes('<redacted>'), 'redact strips URLs, long tokens and ANSI codes');
  ok(cli('--bogus').status === 2 && cli('prune', out).status === 2, 'bad options exit 2 with usage');
  const src = fs.readFileSync(script, 'utf8');
  ok(!/console\.log\([^)]*\b(value|bytes|text)\b[^)]*\)/.test(src), 'no console.log of value/bytes/text variables in the script');

  // ---------- 7. KV reads against a localhost mock of the Cloudflare API ----------
  // Pagination, bulk text reads, raw re-reads of binary values, 429 Retry-After, 503 backoff, a key deleted mid-backup.
  const http = await import('node:http');
  const N = 2500, A = 'acc', NS = 'ns1';
  const keys = Array.from({ length: N }, (_, i) => ({ name: `k${String(i).padStart(5, '0')}${i === 42 ? ' & é/?' : ''}`, ...(i % 100 === 0 ? { expiration: 2000000000 } : {}), ...(i % 250 === 0 ? { metadata: { i } } : {}) }));
  const vals = new Map(keys.map((k, i) => [k.name, i % 500 === 7 ? Buffer.concat([Buffer.from([0xff, 0x00]), crypto.randomBytes(5000)]) : Buffer.from(JSON.stringify({ i, s: 'x'.repeat(i % 40) }))]));
  const gone = keys[1234].name; // listed, then deleted before its value is read
  let reqs = 0, raws = 0, bulks = 0, auth = true;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c)).on('end', () => {
      reqs++;
      if (req.headers.authorization !== 'Bearer test-token') auth = false;
      const json = (code, j, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
      if (reqs === 3 || reqs === 12) return json(429, { success: false, errors: [{ code: 10000, message: 'rate limited' }] }, { 'retry-after': '1' });
      if (reqs === 7) return json(503, { success: false, errors: [{ code: 1, message: 'unavailable' }] });
      const u = new URL(req.url, 'http://x'), pre = `/accounts/${A}/storage/kv/namespaces/${NS}`;
      if (u.pathname === `${pre}/keys`) {
        const start = Number(u.searchParams.get('cursor') || 0), page = keys.slice(start, start + 1000);
        return json(200, { success: true, result: page, result_info: { count: page.length, cursor: start + 1000 < N ? String(start + 1000) : '' } });
      }
      if (u.pathname === `${pre}/bulk/get` && req.method === 'POST') {
        bulks++;
        const ks = JSON.parse(Buffer.concat(chunks)).keys;
        if (ks.length > 100) return json(400, { success: false, errors: [{ code: 2, message: 'max 100 keys' }] });
        return json(200, { success: true, result: { values: Object.fromEntries(ks.map(k => [k, k === gone || !vals.has(k) ? null : vals.get(k).toString('utf8')])) } });
      }
      if (u.pathname.startsWith(`${pre}/values/`)) {
        raws++;
        const k = decodeURIComponent(u.pathname.slice(pre.length + 8));
        if (k === gone || !vals.has(k)) return json(404, { success: false, errors: [{ code: 10009, message: 'key not found' }] });
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(vals.get(k));
      }
      json(404, { success: false, errors: [{ code: 7003, message: 'no route' }] });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const stats = { requests: 0, retries: 0, rateLimited: 0 }, gate = new B.Gate(200);
    const api = new B.CfApi(A, { authorization: 'Bearer test-token' }, gate, stats, null, `http://127.0.0.1:${srv.address().port}`);
    const kdir = mk('mock-kv'), t0 = Date.now();
    const s = await B.backupKv({ id: NS, title: 'mock' }, { o: {}, T: B.apiTransport(api), gate, stats, dir: kdir, notes: new Set() });
    ok(auth, 'every mock request carried the bearer token');
    ok(s.keys === N && s.written === N - 1 && s.vanished === 1 && s.failed === 0, `all keys listed across 3 pages, ${N - 1} written, 1 deleted mid-read (${s.written}/${s.vanished}/${s.failed})`);
    ok(s.binary === 5 && raws === 6, `binary values re-read raw (${s.binary} binary, ${raws} raw reads incl. the deleted key)`);
    ok(bulks === 25 && s.reads.bulk === 25, `text values come from 25 bulk reads of 100 (${s.reads.bulk} counted, ${bulks} served)`);
    ok(stats.rateLimited === 2 && stats.retries >= 3, `429s and the 503 are retried (${stats.rateLimited} rate limited, ${stats.retries} retries)`);
    ok(Date.now() - t0 >= 2000, 'Retry-After is honoured (waited at least 2 x 1 s)');
    const got = new Map(s.files.flatMap(f => B.parseKvFile(path.join(kdir, ...f.split('/')))).map(e => [e.key, B.decodeKvEntry(e)]));
    let same = 0;
    for (const k of keys) if (k.name !== gone && Buffer.compare(got.get(k.name)?.bytes ?? Buffer.alloc(1), vals.get(k.name)) === 0 && got.get(k.name).expiration === k.expiration && JSON.stringify(got.get(k.name).metadata) === JSON.stringify(k.metadata)) same++;
    ok(same === N - 1, `every saved value, expiration and metadata matches the source (${same}/${N - 1})`);
  } finally { srv.close(); }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(bad ? `\n${bad} of ${n} checks failed` : `\n✓ all ${n} checks passed`);
process.exit(bad ? 1 : 0);
