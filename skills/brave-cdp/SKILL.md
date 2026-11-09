---
name: brave-cdp
description: Drive the user's own logged-in Brave, Chrome or Edge over the Chrome DevTools Protocol with a single connection, so the browser's "Allow remote debugging?" prompt appears once instead of on every step. Use for browser tasks that need the user's real sessions (dashboards, uploads, downloads, sites that block scripted HTTP) when no browser MCP is available or wanted.
---

# brave-cdp

`scripts/cdp.mjs` is a zero-dependency Node 22+ CDP client. Run it with `node <this-skill-dir>/scripts/cdp.mjs ...`.

## The one rule: one connection per task
Modern Chromium browsers (Brave, Chrome 144+, Edge) show an **"Allow remote debugging?"** prompt for EVERY new DevTools connection, with no "always allow". Many small probe scripts = many prompts = an annoyed user.
- Plan the whole browser task first, then run it as ONE job script (`run job.mjs`) with adaptive steps and full logging.
- For long sessions with many steps, ask the user once if they want the relay (`node cdp.mjs relay`, run in the background). It holds one approved connection and every later command reuses it automatically. Stop it when the work is done.

## Setup (user does this once)
- Brave: open `brave://inspect/#remote-debugging` and turn remote debugging on. Chrome/Edge: `chrome://inspect/#remote-debugging` / `edge://inspect/#remote-debugging`.
- Or start the browser with `--remote-debugging-port=9222`. Chrome 136+ ignores that flag for the default profile, so add `--user-data-dir=<separate dir>` in that case.
- The script finds the port from the browser's `DevToolsActivePort` file. Overrides: `CDP_BROWSER=brave|chrome|edge|chromium`, `CDP_PORT`, `CDP_URL=ws://...`, `CDP_RELAY_PORT` (default 9333).

## Commands
```
node cdp.mjs tabs                              # list open tabs
node cdp.mjs eval "document.title" --match github.com
node cdp.mjs run job.mjs [args...]             # whole task, one connection
node cdp.mjs relay                             # optional: keep one connection open
```

## Writing a job
```js
export default async function ({ page, tabs, waitEvent, downloadsTo, cdp, log, args }) {
  const p = await page({ url: 'https://example.com' });  // NEW tab (default) — never hijack the user's tabs
  // or: await page({ match: 'mail.google.com' })        // reuse an existing tab only when the task needs it
  await p.click('button.save');        // real mouse events at the element centre
  await p.type('hello'); await p.key('Enter');           // modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift
  await p.waitFor(`!!document.querySelector('.done')`);
  const data = await p.eval(`[...document.querySelectorAll('h2')].map(h => h.textContent)`);
  await p.upload('input[type=file]', ['photo.jpg']);    // no OS file dialog
  await p.screenshot('step.png'); log('done', data);
  await p.close();
}
```
- `p.send(method, params)` sends any raw CDP command to that tab; `cdp.send(...)` sends browser-level ones.
- Events: `await p.send('Page.enable')`, then `await waitEvent('Page.loadEventFired', { sessionId: p.sessionId })`. Events also work through the relay.
- Downloads: `await downloadsTo('out')`. Files arrive named by GUID with no extension. Wait for `Browser.downloadProgress` with `state: 'completed'`, then rename.

## Gotchas
- Synthetic `el.click()` doesn't open file choosers, menus, or some React handlers. Use `p.click()` (real mouse events) or `p.upload()`.
- Some pages (e.g. Google Photos) render nothing while their tab is in the background. Call `await p.front()` first.
- If `p.click()` times out, the element is probably hidden or zero-size. Take a screenshot and inspect it before retrying.
- A stale `DevToolsActivePort` file stays behind after the browser closes. A connect error after that usually means the browser isn't running.

## Safety
- The connection has full control of the user's logged-in browser. Only do what the user asked.
- Never read, print or export cookies, passwords, tokens or localStorage secrets.
- Ask before anything outward-facing or hard to undo: sending messages, posting, submitting forms, purchases, deleting.
- The relay listens on 127.0.0.1 only and requires the random token in `~/.cdp-relay-token`, which is deleted on exit. Any process running as the user can still read that file, so don't leave the relay running unattended.
