#!/usr/bin/env node
// link-preview-check — see a page the way WhatsApp / LinkedIn / X / Facebook crawlers do (raw HTML, no JS)
// and report everything that makes a shared link look bad. Zero dependencies. Node 22+.
//
//   node preview-check.mjs https://example.com
//   node preview-check.mjs https://example.com /about /pricing      extra paths on the same site
//   node preview-check.mjs --sitemap https://example.com/sitemap.xml
//   node preview-check.mjs https://example.com --out preview.html   (default: link-preview.html)
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const OUT = path.resolve(opt('out') || 'link-preview.html');
const sitemap = opt('sitemap');
let urls = [];
const base = argv.find(a => /^https?:\/\//.test(a));
for (const a of argv) urls.push(/^https?:\/\//.test(a) ? a : base ? new URL(a, base).href : a);
if (sitemap) {
  const xml = await (await fetch(sitemap)).text();
  urls.push(...[...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]).slice(0, 50));
}
urls = [...new Set(urls)];
if (!urls.length) { console.log('usage: node preview-check.mjs <url> [more urls or /paths] [--sitemap url] [--out file.html]'); process.exit(1); }

const UA = 'Mozilla/5.0 (compatible; link-preview-check/1.0; +https://github.com/binay-py/claude-skills)';
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseHead(html) {
  const head = html.slice(0, (html.search(/<\/head>/i) + 1 || 200000) + 7);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0], attr = n => (tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || [])
      .slice(2).find(v => v !== undefined);
    const key = (attr('property') || attr('name') || '').toLowerCase(), val = attr('content');
    if (key && val !== undefined && !(key in meta)) meta[key] = decode(val.trim());
  }
  const title = decode((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '');
  const canonical = (head.match(/<link\b[^>]*rel=["']?canonical["']?[^>]*>/i) || [''])[0].match(/href=["']?([^"'\s>]+)/i)?.[1];
  const icon = (head.match(/<link\b[^>]*rel=["']?[^"'>]*icon[^"'>]*["']?[^>]*>/i) || [''])[0].match(/href=["']?([^"'\s>]+)/i)?.[1];
  return { meta, title, canonical, icon };
}

// width/height from the first bytes of PNG, JPEG, GIF or WebP
function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { type: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const f = b.toString('ascii', 12, 16);
    if (f === 'VP8 ') return { type: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (f === 'VP8L') { const n = b.readUInt32LE(21); return { type: 'webp', w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    if (f === 'VP8X') return { type: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1], len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return { type: 'jpeg' };
  }
  if (/^\s*<(\?xml|svg)/i.test(b.toString('utf8', 0, 200))) return { type: 'svg' };
  return { type: 'unknown' };
}

async function check(url) {
  const r = { url, issues: [], warn: [] };
  const bad = s => r.issues.push(s), warn = s => r.warn.push(s);
  let res;
  try { res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }); }
  catch (e) { bad(`could not fetch: ${e.cause?.code || e.message}`); return r; }
  r.status = res.status; r.finalUrl = res.url;
  if (!res.ok) { bad(`page returned HTTP ${res.status}`); return r; }
  const html = await res.text();
  Object.assign(r, parseHead(html));
  const m = r.meta;
  r.card = {
    title: m['og:title'] || m['twitter:title'] || r.title,
    description: m['og:description'] || m['twitter:description'] || m['description'] || '',
    image: m['og:image'] || m['og:image:url'] || m['og:image:secure_url'] || m['twitter:image'] || m['twitter:image:src'],
    site: m['og:site_name'] || new URL(r.finalUrl).hostname,
    host: new URL(r.finalUrl).hostname.replace(/^www\./, ''),
  };
  if (!m['og:title']) (r.title ? warn : bad)(r.title ? 'no og:title (platforms fall back to <title>)' : 'no og:title and no <title>');
  if (!m['og:description'] && !m['description']) warn('no og:description or meta description: the card will have no summary');
  if (!m['og:url'] && !r.canonical) warn('no og:url or canonical link: shares of URLs with ?utm/?fbclid count as separate pages');
  if (!m['twitter:card']) warn('no twitter:card: X shows a small card at best (use summary_large_image)');
  else if (m['twitter:card'] === 'summary' && r.card.image) warn('twitter:card is "summary": X shows a small square thumbnail; use summary_large_image for the big card');
  if ((r.card.title || '').length > 70) warn(`title is ${r.card.title.length} chars: platforms cut it around 60–70`);
  if (r.card.description.length > 200) warn(`description is ${r.card.description.length} chars: cut around 150–200`);
  if (/<div id=["']?(root|app|__next)["']?\s*>\s*<\/div>/i.test(html) && !m['og:title']) bad('looks like a client-rendered app with an empty shell: crawlers do not run JS, so tags set by JavaScript are invisible to them');

  const img = r.card.image;
  if (!img) bad('no og:image: the shared link will be plain text or a tiny icon');
  else {
    let abs;
    if (!/^https?:\/\//i.test(img)) { bad(`og:image is a relative URL ("${img}"): Facebook, LinkedIn and WhatsApp need an absolute https URL`); abs = new URL(img, r.finalUrl).href; }
    else abs = img;
    if (abs.startsWith('http://')) warn('og:image uses http://: some apps (WhatsApp, iMessage) skip non-https images');
    r.card.imageAbs = abs;
    try {
      const ir = await fetch(abs, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const buf = Buffer.from(await ir.arrayBuffer());
      r.image = { status: ir.status, bytes: buf.length, contentType: ir.headers.get('content-type') || '', ...imageSize(buf) };
      const I = r.image;
      if (!ir.ok) bad(`og:image returns HTTP ${ir.status}`);
      else {
        if (I.type === 'svg') bad('og:image is an SVG: no major platform renders SVG previews; use PNG or JPG');
        else if (I.type === 'unknown') bad(`og:image is not a recognisable image (content-type "${I.contentType}")`);
        if (I.w && I.h) {
          if (I.w < 200 || I.h < 200) bad(`og:image is ${I.w}×${I.h}: Facebook ignores images under 200×200`);
          else if (I.w < 1200 || I.h < 600) warn(`og:image is ${I.w}×${I.h}: use 1200×630 for a sharp large card`);
          const ratio = I.w / I.h;
          if (ratio < 1.6 || ratio > 2.2) warn(`og:image ratio is ${ratio.toFixed(2)}:1: large cards are 1.91:1 (1200×630), so it will be cropped`);
        }
        if (I.bytes > 5 * 1024 * 1024) bad(`og:image is ${(I.bytes / 1048576).toFixed(1)} MB: over the 5 MB limit of most platforms`);
        else if (I.bytes > 600 * 1024) warn(`og:image is ${Math.round(I.bytes / 1024)} KB: WhatsApp often drops large images; aim for under ~300 KB`);
        if (!/^image\//.test(I.contentType)) warn(`og:image is served as "${I.contentType}" instead of image/*`);
      }
    } catch (e) { bad(`og:image could not be fetched: ${e.cause?.code || e.message}`); }
  }
  return r;
}

const results = [];
for (const u of urls) { process.stdout.write(`checking ${u}\n`); results.push(await check(u)); }

// same title/image on every route = SPA serving one index.html
if (results.length > 1) {
  const ok = results.filter(r => r.card);
  const same = k => ok.length > 1 && new Set(ok.map(r => r.card[k])).size === 1;
  if (same('title')) for (const r of ok.slice(1)) r.issues.push(`same title as ${ok[0].url}: every route serves the same HTML (typical SPA). Pre-render per-route HTML with its own <title> and og: tags`);
}

for (const r of results) {
  console.log(`\n${r.url}`);
  if (r.card) console.log(`  title: ${r.card.title || '—'}\n  image: ${r.card.imageAbs || '—'}${r.image?.w ? ` (${r.image.w}×${r.image.h}, ${Math.round(r.image.bytes / 1024)} KB)` : ''}`);
  for (const s of r.issues) console.log('  ✘ ' + s);
  for (const s of r.warn) console.log('  ! ' + s);
  if (!r.issues.length && !r.warn.length) console.log('  ✓ looks good');
}

// HTML mock of the cards
const card = (r, kind) => {
  const c = r.card || {}; const img = c.imageAbs && r.image?.type !== 'svg' && r.image?.status < 400 ? c.imageAbs : '';
  const pic = img ? `<img src="${esc(img)}" alt="">` : `<div class="noimg">no image</div>`;
  if (kind === 'whatsapp') return `<div class="wa"><div class="wa-card">${img ? `<img src="${esc(img)}" alt="">` : ''}<div class="wa-t"><b>${esc(c.title)}</b><span>${esc(c.description)}</span><small>${esc(c.host)}</small></div></div><div class="wa-link">${esc(r.url)}</div></div>`;
  if (kind === 'linkedin') return `<div class="li">${pic}<div class="li-t"><b>${esc(c.title)}</b><small>${esc(c.host)}</small></div></div>`;
  if (kind === 'x') return `<div class="x">${pic}<span class="x-host">${esc(c.host)}</span><div class="x-t">${esc(c.title)}</div></div>`;
  return `<div class="fb">${pic}<div class="fb-t"><small>${esc(c.host.toUpperCase())}</small><b>${esc(c.title)}</b><span>${esc(c.description)}</span></div></div>`;
};
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link previews</title>
<style>
:root{--bg:#f4f5f7;--fg:#1c1e21;--soft:#65676b;--line:#dadde1}
@media (prefers-color-scheme:dark){:root{--bg:#18191a;--fg:#e4e6eb;--soft:#b0b3b8;--line:#3a3b3c}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
main{max-width:1100px;margin:auto} h1{font-size:22px} h2{font-size:16px;margin:32px 0 8px;word-break:break-all}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;align-items:start}
.lab{font-size:12px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
img{display:block;width:100%;aspect-ratio:1.91;object-fit:cover;background:#ccc} .noimg{aspect-ratio:1.91;display:grid;place-items:center;background:repeating-linear-gradient(45deg,#ddd 0 10px,#eee 10px 20px);color:#888;font-weight:700}
b{display:block;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical} small{color:var(--soft)}
.wa{background:#d9fdd3;border-radius:10px;padding:4px;color:#111b21}.wa-card{background:#d1f4cc;border-radius:7px;overflow:hidden}.wa-t{padding:8px 10px}.wa-t span{display:block;font-size:13px;color:#54656f;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.wa-t small{font-size:12px;color:#667781}.wa-link{padding:6px 8px;color:#027eb5;font-size:14px;word-break:break-all}
.li{background:#fff;color:#000;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden}.li-t{padding:10px 12px}.li-t small{color:#666}
.x{position:relative;border:1px solid #cfd9de;border-radius:16px;overflow:hidden;background:#000}.x img{border-radius:0}.x-host{position:absolute;left:12px;bottom:40px;background:rgba(0,0,0,.77);color:#fff;font-size:13px;padding:0 4px;border-radius:4px}.x-t{color:#e7e9ea;padding:6px 12px 10px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb{background:#fff;color:#050505;border:1px solid #dadde1}.fb-t{background:#f0f2f5;padding:10px 12px}.fb-t small{color:#65676b;font-size:12px}.fb-t span{display:block;font-size:14px;color:#65676b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
ul{margin:10px 0 0;padding-left:20px} .e{color:#d93025} .w{color:#b06000}
</style><main><h1>Link previews (approximate mock-ups, from the raw HTML crawlers see)</h1>
${results.map(r => `<h2>${esc(r.url)}</h2><div class="grid">${['whatsapp', 'linkedin', 'x', 'facebook'].map(k => `<div><div class="lab">${k === 'x' ? 'X / Twitter' : k}</div>${r.card ? card(r, k) : '<div class="noimg">page not reachable</div>'}</div>`).join('')}</div>
<ul>${r.issues.map(s => `<li class="e">${esc(s)}</li>`).join('')}${r.warn.map(s => `<li class="w">${esc(s)}</li>`).join('')}${!r.issues.length && !r.warn.length ? '<li>Looks good.</li>' : ''}</ul>`).join('')}
</main>`;
fs.writeFileSync(OUT, page);
const nIssues = results.reduce((n, r) => n + r.issues.length, 0), nWarn = results.reduce((n, r) => n + r.warn.length, 0);
console.log(`\n${nIssues} problem(s), ${nWarn} warning(s). Card mock-ups: ${OUT}`);
process.exitCode = nIssues ? 1 : 0;
