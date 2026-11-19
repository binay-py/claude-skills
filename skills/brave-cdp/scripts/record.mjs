// Record mode: the user clicks through a task in a visible tab, and a replayable job script is written.
//   node cdp.mjs record https://example.com --out my-job.mjs
// Stop with the in-page "Stop recording" badge, by closing the tab, or Ctrl+C in the terminal.
import fs from 'node:fs';
import path from 'node:path';

const J = JSON.stringify;

// Runs inside the page (every document, via addScriptToEvaluateOnNewDocument). Reports actions through
// the __cdpRecord binding. Never reports what is typed into password, card or one-time-code fields.
export const RECORDER = String.raw`(() => {
  if (window.top !== window || window.__cdpRec) return;
  window.__cdpRec = true;
  const send = o => { try { window.__cdpRecord(JSON.stringify(o)); } catch {} };
  const esc = s => CSS.escape(s);
  const uniq = s => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  const autoId = id => /\d{3,}|[a-f0-9]{8,}|^(?:ember|react|mui|radix|headlessui|:r)/i.test(id);
  const label = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  function selector(el) {
    if (el.id && !autoId(el.id) && uniq('#' + esc(el.id))) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'title']) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) { const s = el.tagName.toLowerCase() + '[' + a + '=' + JSON.stringify(v) + ']'; if (uniq(s)) return s; }
    }
    if (el.tagName === 'A' && el.getAttribute('href')) { const s = 'a[href=' + JSON.stringify(el.getAttribute('href')) + ']'; if (uniq(s)) return s; }
    const parts = []; let e = el;
    while (e && e.nodeType === 1 && e !== document.body && parts.length < 6) {
      let p = e.tagName.toLowerCase();
      if (e.id && !autoId(e.id)) { parts.unshift('#' + esc(e.id)); break; }
      const sib = e.parentElement ? [...e.parentElement.children].filter(c => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(p); e = e.parentElement;
      const s = parts.join(' > '); if (uniq(s)) return s;
    }
    return parts.join(' > ');
  }
  const CLICKABLE = 'a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[onclick],[contenteditable=""],[contenteditable=true]';
  const secret = el => el.type === 'password' || /cc-|one-time-code|current-password|new-password/.test(el.autocomplete || '') || /pass|cvv|cvc|card.?num|otp|pin\b/i.test((el.name || '') + ' ' + (el.id || ''));
  const target = ev => { const t = ev.composedPath()[0]; return t && t.nodeType === 1 ? t : null; };
  const describe = el => {
    const s = selector(el), text = label(el), tag = el.tagName.toLowerCase();
    const positional = /nth-of-type/.test(s) && text && text.length <= 40;
    return { selector: s, unique: uniq(s) && !positional, text, tag: el.closest('a') ? 'a' : el.closest('button') ? 'button' : tag };
  };

  // badge
  const badge = document.createElement('div');
  badge.textContent = '● Recording - click here to stop';
  badge.setAttribute('style', 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;background:#d93025;color:#fff;font:600 13px system-ui,sans-serif;padding:8px 12px;border-radius:99px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)');
  badge.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); badge.textContent = 'Saving…'; send({ type: 'stop' }); }, true);
  const mount = () => document.documentElement && !badge.isConnected && document.documentElement.appendChild(badge);
  mount(); document.addEventListener('DOMContentLoaded', mount);

  const pending = new Map(); // element -> value typed but not yet reported
  const flush = el => {
    if (!pending.has(el)) return;
    const v = pending.get(el); pending.delete(el);
    send({ type: 'type', ...describe(el), value: secret(el) ? null : v, secret: secret(el), field: el.name || el.id || el.placeholder || el.type });
  };
  const flushAll = () => [...pending.keys()].forEach(flush);

  addEventListener('input', e => {
    const el = target(e); if (!el || badge.contains(el)) return;
    if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') return;
    pending.set(el, el.isContentEditable ? el.innerText : el.value);
  }, true);
  addEventListener('change', e => {
    const el = target(e); if (!el) return;
    if (el.tagName === 'SELECT') send({ type: 'select', ...describe(el), value: el.value });
    else if (el.type === 'file') send({ type: 'file', ...describe(el) });
    else flush(el);
  }, true);
  addEventListener('blur', e => { const el = target(e); if (el) flush(el); }, true);
  addEventListener('keydown', e => {
    if (!['Enter', 'Escape', 'Tab'].includes(e.key) || e.isComposing) return;
    const el = target(e); if (el && badge.contains(el)) return;
    if (el) flush(el);
    if (e.key === 'Tab') return; // focus moves are replayed by clicking the next field
    send({ type: 'key', key: e.key });
  }, true);
  addEventListener('pointerdown', e => {
    const raw = target(e); if (!raw || badge.contains(raw) || e.button !== 0) return;
    flushAll();
    const el = raw.closest(CLICKABLE) || (getComputedStyle(raw).cursor === 'pointer' ? raw : null);
    if (!el) return; // clicks on plain page areas (e.g. to leave a field) are not steps
    if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && /^(text|email|search|url|tel|number|password)$/.test(el.type)) || el.tagName === 'TEXTAREA') return; // typing covers these
    send({ type: 'click', ...describe(el) });
  }, true);
  addEventListener('pagehide', flushAll, true);
  send({ type: 'page', url: location.href, title: document.title });
})()`;

// Turn recorded actions into a job script.
export function toJob(actions, { startUrl, recordedAt = new Date().toISOString() } = {}) {
  const L = [], env = [];
  let needText = false, lastWasClick = false;
  const sel = a => a.unique || !a.text ? `p.click(${J(a.selector)})` : (needText = true, `clickText(p, ${J(a.tag)}, ${J(a.text)})`);
  for (const a of actions) {
    if (a.type === 'goto') { L.push(`  await p.goto(${J(a.url)});`); lastWasClick = false; continue; }
    if (a.type === 'navigated') { if (lastWasClick) L.push(`  await p.waitFor(\`document.readyState === 'complete'\`);`); lastWasClick = false; continue; }
    lastWasClick = false;
    if (a.type === 'click') { L.push(`  await ${sel(a)};${a.text ? ` // ${a.text.replace(/\n/g, ' ').slice(0, 50)}` : ''}`); lastWasClick = true; }
    if (a.type === 'type') {
      let val;
      if (a.secret) {
        const name = ('JOB_' + String(a.field || 'secret').replace(/[^a-z0-9]+/gi, '_')).toUpperCase().slice(0, 40);
        if (!env.includes(name)) env.push(name);
        val = `process.env.${name} ?? ''`;
      } else val = J(a.value ?? '');
      L.push(`  await p.click(${J(a.selector)});`);
      L.push(`  await p.eval(\`(e => { if (!e) return; if ('value' in e) e.select?.(); else getSelection().selectAllChildren(e); })(document.querySelector(${J(J(a.selector)).slice(1, -1)}))\`);`);
      L.push(`  await p.type(${val});${a.secret ? ' // not recorded: set this environment variable before running' : ''}`);
    }
    if (a.type === 'select') L.push(`  await p.eval(\`(e => { e.value = ${J(J(a.value)).slice(1, -1)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector(${J(J(a.selector)).slice(1, -1)}))\`);`);
    if (a.type === 'key') L.push(`  await p.key(${J(a.key)});`);
    if (a.type === 'file') L.push(`  // await p.upload(${J(a.selector)}, ['path/to/file']); // file picked while recording: set the path`);
  }
  const helper = needText ? `
// Clicks the first visible <tag> whose text contains \`text\` (used where no unique CSS selector existed).
async function clickText(p, tag, text) {
  const pt = await p.waitFor(\`(() => { for (const e of document.querySelectorAll(\${JSON.stringify(tag)})) {
    const t = (e.getAttribute('aria-label') || e.innerText || e.value || '').trim().replace(/\\\\s+/g, ' ');
    const b = e.getBoundingClientRect();
    if (b.width && b.height && t.includes(\${JSON.stringify(text)})) { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } } return null; })()\`);
  await p.mouse(pt.x, pt.y);
}
` : '';
  return `// Recorded with brave-cdp record on ${recordedAt.slice(0, 16).replace('T', ' ')}. Edit freely.
// Run: node cdp.mjs run ${'<this file>'}${env.length ? `\n// Needs: ${env.join(', ')} (secrets typed while recording are not saved)` : ''}
export default async function ({ page, log }) {
  const p = await page({ url: ${J(startUrl)} }); // add visible: true to watch it
${L.join('\n')}
  log('done:', await p.eval('location.href'));
}
${helper}`;
}

export async function record(cdp, page, { url = 'about:blank', match, out = 'recorded-job.mjs', log = console.log } = {}) {
  const p = await page({ url: match ? undefined : url, match, visible: true });
  await p.front().catch(() => {});
  const actions = [];
  let startUrl = match ? await p.eval('location.href') : url, stopped;
  const done = new Promise(r => { stopped = r; });
  let lastClickAt = 0;

  const off = cdp.on(m => {
    if (m.sessionId !== p.sessionId) return;
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__cdpRecord') {
      let a; try { a = JSON.parse(m.params.payload); } catch { return; }
      if (a.type === 'stop') return stopped('badge');
      if (a.type === 'page') return;
      if (a.type === 'click') lastClickAt = Date.now();
      if (a.type === 'key' && a.key === 'Enter') lastClickAt = Date.now();
      actions.push(a);
      log(`  ${a.type}${a.text ? ` "${a.text.slice(0, 40)}"` : ''}${a.type === 'type' ? (a.secret ? ' (secret, not saved)' : ` "${String(a.value).slice(0, 30)}"`) : ''}${a.key ? ' ' + a.key : ''}${a.unique === false ? '  [by text]' : ''}`);
    }
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      const u = m.params.frame.url;
      if (u.startsWith('about:') || u.startsWith('chrome')) return;
      const byUser = Date.now() - lastClickAt > 2500; // not caused by a recorded click/Enter: typed in the address bar, back button, etc.
      actions.push(byUser ? { type: 'goto', url: u } : { type: 'navigated', url: u });
      log(`  ${byUser ? 'go to' : 'page'} ${u.slice(0, 90)}`);
    }
    if (m.method === 'Inspector.detached' || m.method === 'Target.detachedFromTarget') stopped('tab closed');
  });
  const tabGone = cdp.on(m => { if (m.method === 'Target.targetDestroyed' && m.params.targetId === p.targetId) stopped('tab closed'); });
  await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});

  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await p.send('Runtime.addBinding', { name: '__cdpRecord' });
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await p.eval(RECORDER).catch(() => {});
  log(`recording ${startUrl}\nclick through the task in the browser, then press the red "Stop recording" badge (or Ctrl+C here)`);

  const sig = () => stopped('Ctrl+C');
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, sig);
  const why = await done;
  off(); tabGone();
  // drop a leading goto to the start URL (the job opens it already)
  while (actions[0]?.type === 'goto' && actions[0].url.replace(/\/$/, '') === startUrl.replace(/\/$/, '')) actions.shift();
  if (actions[0]?.type === 'goto' && startUrl === 'about:blank') startUrl = actions.shift().url;
  const file = path.resolve(out);
  fs.writeFileSync(file, toJob(actions, { startUrl }));
  log(`stopped (${why}). ${actions.filter(a => a.type !== 'navigated').length} steps written to ${file}`);
  if (why !== 'tab closed') {
    await p.eval(`document.querySelectorAll('div').forEach(d => d.textContent.startsWith('● Recording') || d.textContent === 'Saving…' ? d.remove() : 0)`).catch(() => {});
    await p.send('Runtime.removeBinding', { name: '__cdpRecord' }).catch(() => {});
  }
  return { file, actions, page: p };
}
