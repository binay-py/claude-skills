// Offline tests for brave-cdp's extension helpers (no browser needed).
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { matchPattern, expandPath, formatErrors } from '../scripts/ext.mjs';
import { toJob } from '../scripts/record.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('match patterns', () => {
  const yt = matchPattern('https://www.youtube.com/*');
  assert.ok(yt.test('https://www.youtube.com/watch?v=x'));
  assert.ok(!yt.test('https://m.youtube.com/'));
  assert.ok(!yt.test('http://www.youtube.com/'));
  const sub = matchPattern('*://*.google.com/*');
  assert.ok(sub.test('https://mail.google.com/mail/u/0'));
  assert.ok(sub.test('http://google.com/'));
  assert.ok(!sub.test('https://evilgoogle.com/'));
  assert.ok(!sub.test('https://google.com.evil.example/'));
  const all = matchPattern('<all_urls>');
  assert.ok(all.test('https://a.b/') && all.test('file:///C:/x.html') && !all.test('chrome://extensions/'));
  const path_ = matchPattern('https://example.com/app/*.html');
  assert.ok(path_.test('https://example.com/app/a.html') && !path_.test('https://example.com/other/a.html'));
  assert.equal(matchPattern('not a pattern'), null);
});

t('expand ~ paths from the extensions page', () => {
  if (process.platform === 'win32') assert.equal(expandPath('~\\projects\\ext'), path.join(os.homedir(), 'projects', 'ext'));
  assert.equal(expandPath('~/projects/ext'), path.join(os.homedir(), 'projects', 'ext'));
  assert.equal(expandPath(''), '');
  assert.equal(expandPath(path.join(os.tmpdir(), 'x')), path.join(os.tmpdir(), 'x'));
});

t('format errors', () => {
  const s = formatErrors({
    manifestErrors: [{ message: "Unrecognized manifest key 'foo'.", manifestKey: 'foo' }],
    runtimeErrors: [
      { severity: 'ERROR', occurrences: 3, message: 'Uncaught TypeError: x is undefined', contextUrl: 'https://www.youtube.com/',
        stackTrace: [{ url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.js', lineNumber: 12, columnNumber: 5 }] },
      { severity: 'ERROR', occurrences: 1, message: 'An unknown error occurred when fetching the script.', stackTrace: [{ url: '', lineNumber: 0, columnNumber: 1 }] },
    ],
  });
  assert.match(s, /manifest: Unrecognized manifest key 'foo'\. \(foo\)/);
  assert.match(s, /error x3: Uncaught TypeError: x is undefined\n {4}at panel\.js:12:5\n {4}on https:\/\/www\.youtube\.com\//);
  assert.ok(!/at :0:1/.test(s), 'no empty location');
  assert.equal(formatErrors({}), '');
});

t('record: job from actions, secrets never written', () => {
  const j = toJob([
    { type: 'click', selector: '#go', unique: true, text: 'Go' }, { type: 'navigated' },
    { type: 'type', selector: '#pw', unique: true, secret: true, field: 'password', value: null },
    { type: 'click', selector: 'div > button:nth-of-type(2)', unique: false, text: 'Save', tag: 'button' },
    { type: 'key', key: 'Enter' },
  ], { startUrl: 'https://x.test/' });
  assert.match(j, /page\(\{ url: "https:\/\/x\.test\/" \}\)/);
  assert.match(j, /process\.env\.JOB_PASSWORD/);
  assert.match(j, /clickText\(p, "button", "Save"\)/);
  assert.match(j, /readyState === 'complete'/);
  assert.match(j, /await once\("Save", \(\) => clickText/, 'Save is guarded');
  assert.match(j, /await once\("Enter", \(\) => p\.key\("Enter"\)\)/, 'Enter is guarded');
  assert.match(j, /await p\.click\("#go"\); \/\/ Go/, 'plain click is not guarded');
  assert.ok(!/import fs/.test(toJob([{ type: 'click', selector: '#a', unique: true, text: 'Next' }], { startUrl: 'https://x.test/' })), 'no guard code when nothing to guard');
});

// Run a generated job against a fake page: crash after the submit, then rerun.
const fs = await import('node:fs');
const { pathToFileURL } = await import('node:url');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-rec-'));
const jobFile = path.join(tmp, 'job.mjs');
fs.writeFileSync(jobFile, toJob([
  { type: 'click', selector: '#name', unique: true, text: 'Next' },
  { type: 'click', selector: '#send', unique: true, text: 'Submit' },
  { type: 'click', selector: '#after', unique: true, text: 'Back to list' },
], { startUrl: 'https://x.test/' }));
const fakeRun = async (args, crashOn) => {
  const clicks = [], logs = [];
  const p = { click: async s => { if (s === crashOn) throw new Error('browser restarted'); clicks.push(s); }, eval: async () => 'https://x.test/done', waitFor: async () => true };
  const job = await import(pathToFileURL(jobFile).href + '?' + Math.random());
  let err = null;
  await job.default({ page: async () => p, log: (...a) => logs.push(a.join(' ')), args }).catch(e => { err = e; });
  return { clicks, logs: logs.join('\n'), err };
};
const doneFile = jobFile + '.done.json';
const r1 = await fakeRun([], '#after');
assert.ok(r1.err && r1.clicks.includes('#send'), 'first run submitted then crashed');
assert.ok(fs.existsSync(doneFile), 'done-log written after submit');
const r2 = await fakeRun([]);
assert.deepEqual(r2.clicks, [], 'rerun does nothing');
assert.match(r2.logs, /stopped: the last run did "Submit"/);
const r3 = await fakeRun(['--again']);
assert.deepEqual(r3.clicks, ['#name', '#send', '#after'], '--again replays everything');
assert.ok(!fs.existsSync(doneFile), 'finished run clears the log');
const r4 = await fakeRun([]);
assert.equal(r4.clicks.length, 3, 'normal rerun after a finished run works');
fs.rmSync(tmp, { recursive: true, force: true });
n++; console.log('ok record: safe rerun after a crash');

console.log(`\n${n} passed`);
