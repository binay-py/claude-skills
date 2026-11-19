// Extension tools for brave-cdp: list, reload, read errors and watch an unpacked extension folder,
// all through the browser's own extensions page (chrome://extensions and its developerPrivate API),
// on the same single DevTools connection as everything else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = JSON.stringify;

// "~\\projects\\ext" (how the extensions page shows paths) -> absolute path
export function expandPath(p) {
  if (!p) return '';
  if (p === '~' || /^~[\\/]/.test(p)) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}
const samePath = (a, b) => {
  const n = x => path.resolve(x).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

// Chrome match pattern ("https://*.youtube.com/*", "<all_urls>") -> RegExp
export function matchPattern(p) {
  if (p === '<all_urls>') return /^(https?|file|ftp):\/\//;
  const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)$/.exec(p);
  if (!m) return null;
  const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const scheme = m[1] === '*' ? 'https?' : esc(m[1]);
  let host = m[2];
  host = host === '*' ? '[^/]*' : host.startsWith('*.') ? '(?:[^/]*\\.)?' + esc(host.slice(2)) : esc(host);
  const pth = esc(m[3]).replace(/\\\*/g, '.*').replace(/\*/g, '.*');
  return new RegExp(`^${scheme}://${host}${pth}$`);
}

export function formatErrors(info) {
  const out = [];
  for (const e of info.manifestErrors || []) out.push(`  manifest: ${e.message}${e.manifestKey ? ` (${e.manifestKey})` : ''}`);
  for (const e of info.runtimeErrors || []) {
    const top = e.stackTrace?.[0];
    const where = top?.url ? `${top.url.replace(/^chrome-extension:\/\/[a-p]{32}\//, '')}:${top.lineNumber}:${top.columnNumber}` : (e.source || '').replace(/^chrome-extension:\/\/[a-p]{32}\//, '');
    out.push(`  ${e.severity === 'WARN' ? 'warning' : 'error'}${e.occurrences > 1 ? ` x${e.occurrences}` : ''}: ${e.message}${where ? `\n    at ${where}` : ''}${e.contextUrl ? `\n    on ${e.contextUrl}` : ''}`);
  }
  return out.join('\n');
}

// opens chrome://extensions in a background tab and returns helpers bound to it
export async function extensions(cdp, page) {
  const p = await page({ url: 'chrome://extensions/', background: true });
  await p.waitFor(`!!(window.chrome && chrome.developerPrivate)`, 15000).catch(() => {
    throw new Error('the extensions page did not expose chrome.developerPrivate (is this a Chromium browser?)');
  });
  const dp = (fn, ...args) => p.eval(`chrome.developerPrivate.${fn}(${args.map(a => J(a)).join(', ')})`);

  const api = {
    page: p,
    async list() {
      const all = await dp('getExtensionsInfo', { includeDisabled: true, includeTerminated: true });
      return all.map(e => ({ ...e, dir: e.location === 'UNPACKED' ? expandPath(e.prettifiedPath) : '' }));
    },
    // q = extension id, a folder on disk, or part of the name. Unpacked extensions win ties.
    async find(q) {
      const all = await api.list();
      const byId = all.find(e => e.id === q);
      if (byId) return byId;
      if (q && fs.existsSync(q)) {
        const hit = all.find(e => e.dir && samePath(e.dir, q));
        if (hit) return hit;
        throw new Error(`no loaded extension comes from ${path.resolve(q)}. Load it once with "Load unpacked" on the extensions page.`);
      }
      const ql = String(q).toLowerCase();
      const exact = all.filter(e => e.name.toLowerCase() === ql);
      const pick = exact.length ? exact : all.filter(e => e.name.toLowerCase().includes(ql));
      if (pick.length === 1) return pick[0];
      if (!pick.length) throw new Error(`no extension matches "${q}"`);
      throw new Error(`"${q}" matches ${pick.length} extensions, use the id:\n` + pick.map(e => `  ${e.id}  ${e.name} (${e.location.toLowerCase()})`).join('\n'));
    },
    info: id => dp('getExtensionInfo', id),
    clearErrors: async id => {
      const i = await api.info(id);
      const ids = [...(i.runtimeErrors || []), ...(i.manifestErrors || [])].map(e => e.id);
      if (ids.length) await dp('deleteExtensionErrors', { extensionId: id, errorIds: ids });
    },
    // Reload; returns { ok, loadError?, info }. Errors are cleared first, so what's reported is new.
    async reload(q, { reloadTabs = false, settle = 1200 } = {}) {
      const ext = await api.find(q);
      if (ext.state === 'DISABLED') await p.eval(`chrome.management.setEnabled(${J(ext.id)}, true)`).catch(() => {
        throw new Error(`${ext.name} is turned off and could not be turned on. Turn it on in the extensions page.`);
      });
      await api.clearErrors(ext.id).catch(() => {});
      const loadError = await p.eval(`chrome.developerPrivate.reload(${J(ext.id)}, { failQuietly: true, populateErrorForUnpacked: true })
        .then(x => x || null, e => ({ error: e.message }))`);
      if (loadError) return { ok: false, ext, loadError };
      await sleep(settle);
      const info = await api.info(ext.id);
      const tabs = reloadTabs ? await api.reloadTabs(ext) : [];
      if (tabs.length) { await sleep(settle); Object.assign(info, await api.info(ext.id)); }
      return { ok: !(info.runtimeErrors?.length || info.manifestErrors?.length), ext, info, tabs };
    },
    // Content scripts are not re-injected into open tabs after a reload, so reload the tabs they run on.
    async reloadTabs(ext) {
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(ext.dir, 'manifest.json'), 'utf8')); } catch { return []; }
      const res = (manifest.content_scripts || []).flatMap(c => c.matches || []).map(matchPattern).filter(Boolean);
      if (!res.length) return [];
      const { targetInfos } = await cdp.send('Target.getTargets');
      const hit = targetInfos.filter(t => t.type === 'page' && res.some(r => r.test(t.url)));
      for (const t of hit) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        await cdp.send('Page.reload', {}, sessionId).catch(() => {});
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      return hit.map(t => t.url);
    },
    close: () => p.close(),
  };
  return api;
}

export function printReload(r, log = console.log) {
  if (r.loadError) {
    log(`✗ ${r.ext.name} did not load: ${r.loadError.error}`);
    if (r.loadError.source) log(`  ${(r.loadError.source.beforeHighlight || '').split('\n').pop()}>>${r.loadError.source.highlight || ''}<<${(r.loadError.source.afterHighlight || '').split('\n')[0]}`);
    return;
  }
  log(`${r.ok ? '✓' : '✗'} reloaded ${r.ext.name} ${r.info.version}${r.tabs?.length ? `, and ${r.tabs.length} tab(s) it runs on` : ''}`);
  const errs = formatErrors(r.info);
  if (errs) log(errs);
}

// Re-run reload whenever a file in the extension's folder changes.
export async function watch(api, q, { reloadTabs = false, log = console.log, signal } = {}) {
  const ext = await api.find(q);
  if (!ext.dir) throw new Error(`${ext.name} is not an unpacked extension, there is no folder to watch`);
  log(`watching ${ext.dir} (Ctrl+C to stop)`);
  let timer = null, busy = false, again = false;
  const run = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try { printReload(await api.reload(ext.id, { reloadTabs }), m => log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`)); }
    catch (e) { log('reload failed: ' + e.message); }
    busy = false;
    if (again) { again = false; run(); }
  };
  const skip = f => !f || /(^|[\\/])(\.git|node_modules)([\\/]|$)|\.(bak[^\\/]*|swp|tmp)$|~$/.test(f);
  const w = fs.watch(ext.dir, { recursive: true }, (_, f) => { if (skip(f)) return; clearTimeout(timer); timer = setTimeout(run, 300); });
  await new Promise(res => { signal?.addEventListener('abort', res); });
  w.close();
}
