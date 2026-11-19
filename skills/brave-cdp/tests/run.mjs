// Offline tests for brave-cdp's extension helpers (no browser needed).
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { matchPattern, expandPath, formatErrors } from '../scripts/ext.mjs';

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

console.log(`\n${n} passed`);
