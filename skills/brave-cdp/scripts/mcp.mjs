#!/usr/bin/env node
// brave-cdp as an MCP server (stdio, zero dependencies). Gives Claude browser tools that work in the
// user's own logged-in Brave/Chrome/Edge over ONE DevTools connection, in the hidden background window
// by default. Register:  claude mcp add brave-cdp -- node /path/to/skills/brave-cdp/scripts/mcp.mjs
// The browser connection is opened on the first tool call, not at start-up, so starting Claude Code
// never pops the browser's "Allow remote debugging?" prompt. A running relay (cdp.mjs relay) is reused.
import { connect, page, tabs } from './cdp.mjs';
import { extensions, formatErrors } from './ext.mjs';

const VERSION = '1.0.0';
let cdp = null;
const pages = new Map();     // short id -> page object (tabs this server opened or attached to)
let current = null;          // short id used when a tool call gives no tab
const sid = targetId => targetId.slice(0, 6).toLowerCase();
const log = (...a) => process.stderr.write('[brave-cdp] ' + a.join(' ') + '\n');

async function browser() {
  if (cdp && !cdp.closed) return cdp;
  cdp = await connect();
  const onclose = cdp.onclose; cdp.onclose = () => { cdp.closed = true; pages.clear(); current = null; onclose?.(); };
  return cdp;
}
async function getPage(tab) {
  const id = (tab || current || '').toLowerCase();
  if (!id) throw new Error('no tab yet: call browser_open first (or pass a tab id from browser_tabs)');
  if (pages.has(id)) return pages.get(id);
  const c = await browser();
  const hit = (await tabs(c)).find(t => sid(t.targetId) === id || t.targetId === tab);
  if (!hit) throw new Error(`no tab "${tab}". Use browser_tabs to list them.`);
  const p = await page(c, { targetId: hit.targetId });
  p.attached = true; pages.set(id, p); current = id;
  return p;
}
const settle = p => p.waitFor(`document.readyState !== 'loading'`, 15000).catch(() => {});

// Text of the page plus numbered interactive elements. Refs are stored on the elements as data-cdp-ref,
// so browser_click/browser_type can target "[12]" instead of a CSS selector.
const READ = (max, sel, onlyView) => `(() => {
  const root = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document.body'};
  if (!root) return { error: 'no element matches ' + ${JSON.stringify(sel || '')} };
  document.querySelectorAll('[data-cdp-ref]').forEach(e => e.removeAttribute('data-cdp-ref'));
  const q = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=switch],[contenteditable=""],[contenteditable=true]';
  const items = []; let n = 0, skipped = 0;
  for (const el of root.querySelectorAll(q)) {
    const b = el.getBoundingClientRect(), st = getComputedStyle(el);
    if (!b.width || !b.height || st.visibility === 'hidden' || st.display === 'none') continue;
    const inView = b.bottom > 0 && b.top < innerHeight;
    if (${onlyView} && !inView) { skipped++; continue; }
    if (n >= 200) { skipped++; continue; }
    el.setAttribute('data-cdp-ref', ++n);
    const tag = el.tagName.toLowerCase();
    const kind = tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : ['textarea', 'select', 'summary'].includes(tag) ? tag : (el.getAttribute('role') || (el.isContentEditable ? 'editable' : tag));
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('alt') || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const extra = tag === 'a' ? ' -> ' + (el.getAttribute('href') || '').slice(0, 90) : el.checked ? ' (checked)' : el.disabled ? ' (disabled)' : '';
    items.push('[' + n + '] ' + kind + ' "' + name + '"' + extra + (inView ? '' : ' (scroll)'));
  }
  const text = (root.innerText || '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, text: text.slice(0, ${max}), cut: text.length > ${max} ? text.length : 0, items, skipped };
})()`;
const target = a => a.ref != null ? `[data-cdp-ref="${String(a.ref).replace(/\D/g, '')}"]` : a.selector;

async function describe(p) {
  return `tab ${sid(p.targetId)}: ${await p.eval('document.title').catch(() => '')}\n${await p.eval('location.href').catch(() => '')}`;
}

const TOOLS = {
  browser_open: {
    description: "Open a URL in a new tab of the user's own browser (logged-in sessions). Runs hidden in an off-screen window by default so the user can keep working; visible:true opens it in the user's window. Returns the tab id. Then use browser_read to see the page.",
    schema: { url: { type: 'string' }, visible: { type: 'boolean' } }, required: ['url'],
    async run({ url, visible }) {
      const p = await page(await browser(), { url, visible: !!visible });
      const id = sid(p.targetId); pages.set(id, p); current = id;
      await settle(p);
      return describe(p);
    },
  },
  browser_tabs: {
    description: 'List open tabs (id, title, url). Tabs opened by this server are marked *. Any id can be passed as `tab` to the other tools to work in the user\'s own tabs.',
    schema: {},
    async run() {
      return (await tabs(await browser())).filter(t => !t.url.startsWith('data:text/html,<title>Claude'))
        .map(t => `${pages.has(sid(t.targetId)) ? '*' : ' '} ${sid(t.targetId)}  ${t.title.slice(0, 60)}  ${t.url.slice(0, 100)}`).join('\n') || 'no tabs';
    },
  },
  browser_navigate: {
    description: 'Load a URL in a tab (default: the current tab).',
    schema: { url: { type: 'string' }, tab: { type: 'string' } }, required: ['url'],
    async run({ url, tab }) {
      const p = await getPage(tab);
      await p.send('Page.navigate', { url });
      await new Promise(r => setTimeout(r, 400)); await settle(p);
      return describe(p);
    },
  },
  browser_read: {
    description: 'Read the page: visible text (capped) and numbered interactive elements like [12] button "Save". Use the numbers as `ref` in browser_click / browser_type. Cheaper than a screenshot; prefer it.',
    schema: { tab: { type: 'string' }, selector: { type: 'string', description: 'only read inside this element' }, max_chars: { type: 'number', description: 'text cap, default 6000' }, in_view_only: { type: 'boolean', description: 'only list elements currently on screen' } },
    async run({ tab, selector, max_chars = 6000, in_view_only = false }) {
      const p = await getPage(tab);
      const r = await p.eval(READ(Math.max(200, Math.min(+max_chars || 6000, 50000)), selector, !!in_view_only));
      if (r.error) throw new Error(r.error);
      return `${r.title}\n${r.url}\n\n${r.text}${r.cut ? `\n[text cut at ${max_chars} of ${r.cut} chars; raise max_chars or pass a selector]` : ''}\n\nInteractive elements:\n${r.items.join('\n') || '(none)'}${r.skipped ? `\n(${r.skipped} more not listed)` : ''}`;
    },
  },
  browser_click: {
    description: 'Click an element with a real mouse event. Give `ref` (number from browser_read) or a CSS `selector`. Run browser_read again afterwards: refs change when the page changes.',
    schema: { ref: { type: 'number' }, selector: { type: 'string' }, tab: { type: 'string' } },
    async run(a) {
      const p = await getPage(a.tab), sel = target(a);
      if (!sel) throw new Error('give ref or selector');
      await p.click(sel);
      await new Promise(r => setTimeout(r, 500)); await settle(p);
      return 'clicked. ' + await describe(p);
    },
  },
  browser_type: {
    description: 'Type text into a field (ref or selector). clear:true replaces what is there; submit:true presses Enter after.',
    schema: { text: { type: 'string' }, ref: { type: 'number' }, selector: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' }, tab: { type: 'string' } }, required: ['text'],
    async run(a) {
      const p = await getPage(a.tab), sel = target(a);
      if (sel) {
        await p.click(sel);
        if (a.clear) await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e && 'value' in e) { e.select?.(); } else if (e) { const r = document.createRange(); r.selectNodeContents(e); getSelection().removeAllRanges(); getSelection().addRange(r); } })()`);
      }
      await p.type(a.text);
      if (a.submit) { await p.key('Enter'); await new Promise(r => setTimeout(r, 600)); await settle(p); }
      return a.submit ? 'typed and submitted. ' + await describe(p) : 'typed';
    },
  },
  browser_key: {
    description: 'Press a key in the page: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, or a letter. modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.',
    schema: { key: { type: 'string' }, modifiers: { type: 'number' }, tab: { type: 'string' } }, required: ['key'],
    async run({ key, modifiers = 0, tab }) { await (await getPage(tab)).key(key, modifiers); return 'pressed ' + key; },
  },
  browser_scroll: {
    description: 'Scroll the page by a number of screens (negative = up), or to an element (ref/selector).',
    schema: { screens: { type: 'number' }, ref: { type: 'number' }, selector: { type: 'string' }, tab: { type: 'string' } },
    async run(a) {
      const p = await getPage(a.tab), sel = target(a);
      const y = await p.eval(sel ? `(document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' }), scrollY)` : `(scrollBy(0, innerHeight * ${+a.screens || 1}), scrollY)`);
      return `scrolled, y=${Math.round(y)}`;
    },
  },
  browser_wait: {
    description: 'Wait until text appears on the page or a CSS selector matches (default timeout 15 s).',
    schema: { text: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'number' }, tab: { type: 'string' } },
    async run({ text, selector, timeout_ms = 15000, tab }) {
      const p = await getPage(tab);
      const cond = selector ? `!!document.querySelector(${JSON.stringify(selector)})` : `document.body.innerText.includes(${JSON.stringify(text || '')})`;
      await p.waitFor(cond, Math.min(+timeout_ms || 15000, 120000));
      return 'found';
    },
  },
  browser_screenshot: {
    description: 'Screenshot of what the tab shows (JPEG, scaled to at most 1280 px wide). Costs far more tokens than browser_read; use it only when layout or images matter.',
    schema: { tab: { type: 'string' }, full_page: { type: 'boolean' } },
    async run({ tab, full_page }) {
      const p = await getPage(tab);
      const m = await p.send('Page.getLayoutMetrics');
      const vw = m.cssLayoutViewport.clientWidth, vh = full_page ? Math.min(m.cssContentSize.height, 8000) : m.cssLayoutViewport.clientHeight;
      const scale = Math.min(1, 1280 / vw);
      const { data } = await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: !!full_page,
        clip: { x: 0, y: full_page ? 0 : m.cssLayoutViewport.pageY, width: vw, height: vh, scale } });
      return { image: data };
    },
  },
  browser_eval: {
    description: 'Run JavaScript in the page and return the JSON result (awaits promises). For reading data the other tools miss.',
    schema: { js: { type: 'string' }, tab: { type: 'string' } }, required: ['js'],
    async run({ js, tab }) {
      const v = await (await getPage(tab)).eval(js);
      const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
      return s === undefined ? 'undefined' : s.length > 20000 ? s.slice(0, 20000) + `\n[cut, ${s.length} chars]` : s;
    },
  },
  browser_show: {
    description: "Bring a hidden tab's window onto the screen, e.g. so the user can log in or solve a CAPTCHA. It hides again when the tab is closed.",
    schema: { tab: { type: 'string' } },
    async run({ tab }) { await (await getPage(tab)).show(); return 'shown on screen'; },
  },
  browser_close: {
    description: "Close a tab this server opened (a user's own tab is only detached, never closed).",
    schema: { tab: { type: 'string' } },
    async run({ tab }) {
      const id = (tab || current || '').toLowerCase(), p = pages.get(id);
      if (!p) return 'not a tab this server holds';
      await p.close(); pages.delete(id); if (current === id) current = [...pages.keys()].pop() || null;
      return 'closed';
    },
  },
  browser_extension: {
    description: "Chrome extensions under development: action list | reload | errors. `ext` is an id, folder or part of the name. reload with tabs:true also reloads the pages its content scripts run on, and returns only new errors.",
    schema: { action: { type: 'string', enum: ['list', 'reload', 'errors'] }, ext: { type: 'string' }, tabs: { type: 'boolean' } }, required: ['action'],
    async run({ action, ext, tabs: reloadTabs }) {
      const c = await browser();
      const api = await extensions(c, o => page(c, o));
      try {
        if (action === 'list') return (await api.list()).map(e => `${e.id}  ${e.state === 'ENABLED' ? 'on ' : 'off'}  ${e.location === 'UNPACKED' ? 'unpacked' : 'store'}  ${e.name} ${e.version}${e.dir ? '  ' + e.dir : ''}`).join('\n');
        if (!ext) throw new Error('give ext');
        if (action === 'errors') { const e = await api.find(ext); return formatErrors(await api.info(e.id)) || `no errors for ${e.name}`; }
        const r = await api.reload(ext, { reloadTabs: !!reloadTabs });
        if (r.loadError) return `${r.ext.name} did not load: ${r.loadError.error}`;
        return `reloaded ${r.ext.name} ${r.info.version}${r.tabs?.length ? ` and ${r.tabs.length} tab(s)` : ''}\n${formatErrors(r.info) || 'no errors'}`;
      } finally { await api.close().catch(() => {}); }
    },
  },
};

// ---------- MCP over stdio (newline-delimited JSON-RPC) ----------
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m) {
  if (m.id === undefined) return; // notifications (initialized, cancelled) need no answer
  if (m.method === 'initialize') return reply(m.id, {
    protocolVersion: m.params?.protocolVersion || '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'brave-cdp', version: VERSION },
    instructions: "Tools for the user's own logged-in browser. Pages open hidden in an off-screen window, so the user can keep working. Prefer browser_read (text + numbered elements) over screenshots. Ask before sending messages, posting, buying, deleting, or submitting forms.",
  });
  if (m.method === 'ping') return reply(m.id, {});
  if (m.method === 'tools/list') return reply(m.id, {
    tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.schema, ...(t.required ? { required: t.required } : {}) } })),
  });
  if (m.method === 'tools/call') {
    const t = TOOLS[m.params?.name];
    if (!t) return fail(m.id, -32602, 'unknown tool ' + m.params?.name);
    try {
      const out = await t.run(m.params.arguments || {});
      return reply(m.id, { content: [out?.image ? { type: 'image', data: out.image, mimeType: 'image/jpeg' } : { type: 'text', text: String(out) }] });
    } catch (e) {
      const msg = /Could not connect|ECONNREFUSED|DevToolsActivePort/i.test(e.message)
        ? `${e.message}\nIs the browser open with remote debugging on (brave://inspect/#remote-debugging), and was the "Allow remote debugging?" prompt accepted?`
        : e.message;
      return reply(m.id, { content: [{ type: 'text', text: msg }], isError: true });
    }
  }
  fail(m.id, -32601, 'method not found: ' + m.method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    handle(m).catch(e => m.id !== undefined && fail(m.id, -32603, e.message));
  }
});
const shutdown = async () => {
  for (const p of pages.values()) await (p.attached ? p.send('Runtime.evaluate', { expression: '0' }) : p.close()).catch(() => {});
  try { cdp?.close(); } catch {}
  process.exit(0);
};
process.stdin.on('end', shutdown);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, shutdown);
log(`MCP server ${VERSION} ready (browser connects on first use)`);
