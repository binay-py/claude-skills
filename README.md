# claude-skills

**Claude Code skills that keep Claude Code safe and cheap, and help you ship websites, web games and videos.** Each one is a single zero-dependency script plus a SKILL.md, tested against real projects (not toy demos) before it landed here.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![Skills: 9](https://img.shields.io/badge/skills-9-orange) ![Dependencies: 0](https://img.shields.io/badge/npm%20dependencies-0-brightgreen) ![Node 22+](https://img.shields.io/badge/node-22%2B-339933)

![brave-cdp running a whole browser job on one connection](docs/demo.gif)

### Keep Claude Code safe and cheap
| Skill | What it does |
|---|---|
| **[claude-safety-audit](skills/claude-safety-audit)** | Finds the **API keys and tokens "Yes, and don't ask again" saved into your permission rules**, `settings.local.json` / `.mcp.json` committed to git (or still in history), `Bash(*)` / `git push:*` / bypass mode, and missing deny rules. `--fix --apply` repairs them with backups. Never prints a full secret. |
| **[bash-checkpoint](skills/bash-checkpoint)** | An **undo button for shell commands**. A PreToolUse hook that snapshots your files before `rm`, `mv`, `git clean`, `sed -i`…, **blocks** `rm -rf ~`, `rm -rf /` and `Remove-Item -Recurse C:\`, and makes you confirm force-pushes and `git reset --hard`, even in bypass mode. `restore <id>` brings files back, including uncommitted and untracked ones. |
| **[claude-token-audit](skills/claude-token-audit)** | **Where do your limits go?** Reads your local session logs: tokens by project, session, model and day, peak context per session, which tools flood the context, the biggest single outputs, and what loads into every session (CLAUDE.md, MCP servers, skills), with specific fixes. 200 MB of logs in ~4 s. |

### Ship a website
| Skill | What it does |
|---|---|
| **[site-qa](skills/site-qa)** | Crawls a site in headless Chrome and writes a **prioritized QA report**: JS errors, failed requests, broken images and links, mobile sideways-scroll, missing viewport/SEO/Open Graph tags, alt text, unlabeled inputs, page weight, plus desktop and mobile screenshots. |
| **[link-preview-check](skills/link-preview-check)** | Shows how your URL looks when shared on **WhatsApp, LinkedIn, X and Facebook**, the way their crawlers see it (no JS). Flags missing/relative/SVG/oversized og:images and **SPAs that serve the same title on every route**, and renders a page of mock cards. |
| **[cf-pages-deploy](skills/cf-pages-deploy)** | Deploys to **Cloudflare Pages** without leaking `.env`, `node_modules` or keys. It stages a clean copy, scans for secrets, deploys, then checks the live file matches **byte for byte**. |

### Ship a web game
| Skill | What it does |
|---|---|
| **[itch-html5-package](skills/itch-html5-package)** | Checks an HTML5 build against **itch.io's rules** and zips it right. Catches the `Player.png` vs `player.png` **case mismatch** that works on Windows but 403s on itch, absolute `/` paths, `http://` requests, and the file/size limits. |

### Drive your browser
| Skill | What it does |
|---|---|
| **[brave-cdp](skills/brave-cdp)** | Lets Claude drive **your own logged-in Brave / Chrome / Edge** over the DevTools Protocol on **one connection**, so you click "Allow remote debugging?" once instead of 20 times. Real mouse and keyboard input, uploads, downloads, and a token-protected relay. |

### Make a video
| Skill | What it does |
|---|---|
| **[event-recap-video](skills/event-recap-video)** | Turns hundreds of phone photos and videos from an event into a hooky recap: 16:9 main cut, 9:16 version, and a 45 s **beat-synced** reel. ffmpeg + Python. |

## link-preview-check: see your link the way WhatsApp sees it

```bash
node preview-check.mjs https://your-site.com /about /pricing
```

Real output, a page with proper tags vs one without:

![link-preview-check mock cards: a page with og tags vs example.com without](docs/link-preview-check.png)

## Bugs these caught on real projects
- **claude-token-audit:** on my own machine, one session peaked at 866k tokens of context, and `Read` produced 57% of all tool output. Splitting sessions per task and reading files with offset/limit are the two biggest savings.
- **bash-checkpoint:** tested by snapshotting a repo, running a real `rm -rf src`, and restoring: the committed file, an *uncommitted edit* and a *brand-new untracked file* all came back, with branches, index and stash untouched.
- **link-preview-check / site-qa:** a portfolio built as a Vite SPA served *"Web Developer & Content Creator"* as the title of every page, so `/about` and each project page shared with the homepage's preview. The fix (per-route static HTML from a tiny Vite plugin) is written up in the skill.
- **itch-html5-package:** a three.js game that waited forever on itch.io because the YouTube Playables SDK thought itch's iframe was YouTube.
- **cf-pages-deploy:** `wrangler pages project create` in wrangler 4.15x silently goes through "Pages in Workers" and can create a Worker instead. The skill forces a classic Pages project and verifies it.
- **brave-cdp:** synthetic Enter key presses didn't submit forms (the key event needs `text: "\r"`), and pages returned before leaving `about:blank`. Both were found while recording the demo above.

## Install

In Claude Code:
```
/plugin marketplace add binay-py/claude-skills
/plugin install binay-skills@binay-skills
```
Or copy a single skill folder into `~/.claude/skills/`.

---

## brave-cdp: why it exists

Brave (and Chrome 144+ and Edge) show an **"Allow remote debugging?"** dialog for *every new DevTools connection*, and there's no "always allow". Agents love firing off many small scripts, so you end up clicking Allow over and over.

brave-cdp fixes that two ways:
1. **Job mode.** Claude writes the whole task as one job file, runs it on a single connection, and you get one prompt.
2. **Relay mode.** `node cdp.mjs relay` holds one approved connection open. Every later command reuses it automatically (token-protected, localhost only, events included).

```bash
node cdp.mjs tabs                         # list tabs
node cdp.mjs eval "document.title" --match github.com
node cdp.mjs run job.mjs                  # whole task, one connection
```

```js
// job.mjs
export default async function ({ page, log }) {
  const p = await page({ url: 'https://example.com' }); // opens a new tab, leaves yours alone
  await p.click('a');                                     // real mouse events
  log(await p.eval('document.title'));
  await p.screenshot('page.png');
  await p.close();
}
```

Built in: real mouse/keyboard input, file uploads without the OS dialog, download capture, screenshots, wait-for helpers, raw CDP access, and auto-detection of Brave/Chrome/Edge on Windows, macOS and Linux. Enable it once at `brave://inspect/#remote-debugging`.

## event-recap-video: what you get

- `analyze.py` scores every file (blur, brightness, duplicates, loudness, capture time from EXIF) and builds contact sheets so Claude can actually *look* at your footage.
- `build.py` renders the edit from one `edit.json`: cold-open hook, title card, day labels, music ducking under speeches, crossfades, −14 LUFS loudness, segment cache for fast re-renders.
- `reel.py` makes a TikTok/Reels cut where every cut lands exactly on the beat, with safe-area text.
- The SKILL.md holds the editing lessons learned the hard way: lead with video, chain two songs, don't restyle an approved edit, and what to do when Facebook mutes your music.

Requires `ffmpeg` and `pip install pillow pillow-heif numpy`.

## Contributing

Issues and PRs welcome. If a skill saved you time, a ⭐ helps others find it.

## License

MIT
