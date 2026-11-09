<h1 align="center">
  <img src="docs/hero.gif" width="860" alt="claude-skills: 23 tested skills that keep Claude Code safe and cheap, and help you ship">
</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/skills-23-orange" alt="23 skills">
  <img src="https://img.shields.io/badge/npm%20dependencies-0-brightgreen" alt="zero npm dependencies">
  <img src="https://img.shields.io/badge/node-22%2B-339933" alt="Node 22+">
  <a href="https://github.com/binay-py/claude-skills/stargazers"><img src="https://img.shields.io/github/stars/binay-py/claude-skills?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#-install-and-quick-start">Install</a> ·
  <a href="#-keep-claude-code-safe">Safe</a> ·
  <a href="#-keep-claude-code-cheap">Cheap</a> ·
  <a href="#-ship-a-website">Websites</a> ·
  <a href="#-ship-any-repo">Repos</a> ·
  <a href="#-make-gifs-thumbnails-and-videos">GIFs and media</a> ·
  <a href="#-win-clients">Clients</a> ·
  <a href="#-bugs-these-caught-on-real-projects">Real bugs caught</a>
</p>

Each skill is a small **zero-dependency script plus a SKILL.md**, and every one was tested against real projects before it landed here. Claude picks the right one from a plain-English request.

## 📦 Install and quick start

```
/plugin marketplace add binay-py/claude-skills
/plugin install binay-skills@binay-skills
```
Then just ask:

| You say | Claude uses |
|---|---|
| *"Is my Claude Code setup leaking any secrets?"* | claude-safety-audit |
| *"Where are my usage limits going?"* | claude-token-audit |
| *"Check my site before I send it to the client."* | site-qa, link-preview-check |
| *"Make a GIF of this for the README."* | gif-maker |
| *"Package this game for itch.io."* | itch-html5-package |

Or copy any folder from `skills/` into `~/.claude/skills/`. Every script also runs on its own with Node 22+, e.g. `node skills/site-qa/scripts/site-qa.mjs https://example.com`.

## 🛡 Keep Claude Code safe

<p align="center"><img src="docs/safety.gif" width="760" alt="Terminal demo: safety audit finds nothing leaked, package-guard blocks a hallucinated package, bash-checkpoint blocks rm -rf ~"></p>

| Skill | What it does |
|---|---|
| **[claude-safety-audit](skills/claude-safety-audit)** | Finds **API keys "Yes, and don't ask again" saved into your permission rules**, `settings.local.json` / `.mcp.json` committed to git (or still in history), `Bash(*)`, `git push:*` (which includes `--force`), bypass mode and missing deny rules. `--fix --apply` repairs them with backups. Never prints a secret. |
| **[bash-checkpoint](skills/bash-checkpoint)** | An **undo button for shell commands**: a hook that snapshots files before `rm`, `mv`, `git clean`, `sed -i`…, **blocks** `rm -rf ~` / `Remove-Item -Recurse C:\` (even inside `bash -c`), and asks before force-push and `reset --hard`. 37-case test suite. |
| **[package-guard](skills/package-guard)** | Stops **hallucinated and typosquatted packages** ("slopsquatting"): checks every `npm i` / `pip install` against the registry, blocks names that don't exist, asks about look-alikes and brand-new packages. 82-case test suite. |
| **[secret-commit-guard](skills/secret-commit-guard)** | A git **pre-commit hook that blocks commits containing keys and tokens** (any repo, not just Claude's), plus scans of the working tree and full history. 90-case test suite. |
| **[claude-sandbox](skills/claude-sandbox)** | Runs Claude Code in **Docker with only your project folder mounted**: non-root, all capabilities dropped, no sudo, `~/.claude` and SSH keys never visible. `--check` proves the isolation. |

## ⚡ Keep Claude Code cheap

| Skill | What it does |
|---|---|
| **[claude-token-audit](skills/claude-token-audit)** | **Where do your limits go?** Tokens by project, session, model and day from your local logs, peak context per session, and which tools flood the context, with specific fixes. 200 MB of logs in ~4 s. |
| **[read-guard](skills/read-guard)** | A hook that stops **whole-file reads of huge files and log dumps** and points Claude to Grep + a slice. Repeating the same call is allowed, so it never dead-ends. |
| **[session-handoff](skills/session-handoff)** | Writes a **HANDOFF.md** (files, commands, decisions, next steps) so you can `/clear` and continue cheaply, plus a hook that warns when context passes 150k tokens. |
| **[mcp-audit](skills/mcp-audit)** | Lists every **MCP server** across scopes and plugins, how often each is actually used, duplicates, broken ones and secrets in config. `--measure` sizes each server's tools in tokens. |
| **[claude-md-doctor](skills/claude-md-doctor)** | Shows **what loads into every session** and catches broken or too-deep `@imports`, CLAUDE.md over 200 lines, a truncated MEMORY.md, stale paths and an ignored AGENTS.md. |

## 🚀 Ship a website

| Skill | What it does |
|---|---|
| **[site-qa](skills/site-qa)** | Crawls a site in headless Chrome: a **prioritized QA report** of JS errors, failed requests, broken images and links, mobile sideways-scroll, missing SEO/Open Graph tags, alt text and page weight, plus screenshots. |
| **[link-preview-check](skills/link-preview-check)** | How your URL looks when shared on **WhatsApp, LinkedIn, X and Facebook**, read the way their crawlers do (no JS). Catches bad og:images and **SPAs with the same title on every route**. |
| **[visual-diff](skills/visual-diff)** | **Before/after screenshots** around a deploy (desktop + mobile, animations frozen) with changed regions boxed and an HTML report. |
| **[cf-pages-deploy](skills/cf-pages-deploy)** | Deploys to **Cloudflare Pages** without leaking `.env`, `node_modules` or keys, then checks the live file matches **byte for byte**. |
| **[env-doctor](skills/env-doctor)** | Env vars the code reads vs `.env` / `.env.example`: undocumented, stale, unset, **secrets exposed to the browser** via `VITE_` / `NEXT_PUBLIC_`, and committed `.env` files. Never prints values. |

<details>
<summary><b>See link-preview-check output</b>: a page with proper tags vs one without</summary>
<br>
<img src="docs/link-preview-check.png" width="760" alt="link-preview-check mock cards">
</details>

## 🧰 Ship any repo

| Skill | What it does |
|---|---|
| **[release-notes](skills/release-notes)** | Keep-a-Changelog **release notes from git history** (conventional or free-form commits) with PR/commit links and a semver suggestion. `--write` updates CHANGELOG.md safely. |
| **[readme-upgrade](skills/readme-upgrade)** | Audits a README (sections, broken links, images, anchors, license) and with `--run` **executes its install/usage commands in a temp copy** to prove they work. |
| **[itch-html5-package](skills/itch-html5-package)** | Checks an HTML5 game against **itch.io's rules** and zips it right. Catches the `Player.png` vs `player.png` **case mismatch** that works on Windows but 403s on itch. |

## 🎬 Make GIFs, thumbnails and videos

| Skill | What it does |
|---|---|
| **[gif-maker](skills/gif-maker)** | **Sharp, small, smooth GIFs** from an HTML/CSS animation (recorded on a virtual clock: perfectly smooth and identical every run), a scripted terminal session, a video clip or images, with an automatic size budget. **Every animation on this page was made with it.** |
| **[thumbnail-maker](skills/thumbnail-maker)** | **Bright, huge-text YouTube and social thumbnails** with a highlighted keyword and a photo card, plus a readability check at YouTube's tiny search size. |
| **[event-recap-video](skills/event-recap-video)** | Hundreds of phone photos and videos from an event → a hooky 16:9 recap, a 9:16 version and a **beat-synced** reel. ffmpeg + Python. |

<p align="center">
  <img src="skills/thumbnail-maker/examples/pop-photo.jpg" width="420" alt="thumbnail-maker example: yellow background, huge white text with a red keyword box, photo card">
  <img src="skills/thumbnail-maker/examples/green-emoji.jpg" width="420" alt="thumbnail-maker example: green style with emoji sticker">
</p>

## 💼 Win clients

| Skill | What it does |
|---|---|
| **[freelance-proposal](skills/freelance-proposal)** | Upwork proposals, Fiverr gigs and cold emails **from your real portfolio only**, then **scored**: template openers, AI-isms, placeholders, no proof, no question, ignoring the job post. |

## 🌐 Drive your browser

| Skill | What it does |
|---|---|
| **[brave-cdp](skills/brave-cdp)** | Claude drives **your own logged-in Brave / Chrome / Edge** on **one DevTools connection**, so you click "Allow remote debugging?" once instead of 20 times. |

<details>
<summary><b>See brave-cdp run a whole browser job on one connection</b></summary>
<br>
<img src="docs/demo.gif" width="760" alt="brave-cdp demo">
</details>

## 🐛 Bugs these caught on real projects
- **mcp-audit:** of 18 configured MCP servers, only one had been called in 30 days; one named "fetch" was actually the MCP protocol *test* server; nine were duplicates.
- **claude-token-audit:** one session peaked at 866k tokens of context, and `Read` produced 55% of all tool output. That's what read-guard and session-handoff fix.
- **bash-checkpoint:** a real `rm -rf src` was restored, including an *uncommitted edit* and a *brand-new untracked file*. Running it live also exposed (and fixed) false alarms on commit messages that only mention dangerous commands.
- **link-preview-check / site-qa:** a Vite SPA portfolio served the homepage title on every route. The fix (per-route static HTML from a tiny Vite plugin) is in the skill.
- **itch-html5-package:** a three.js game hung forever on itch.io because the YouTube Playables SDK thought itch's iframe was YouTube.
- **cf-pages-deploy:** `wrangler pages project create` (4.15x) can create a Worker instead of a Pages project; the skill forces a classic one.
- **env-doctor:** caught a `VITE_SUPABASE_SERVICE_ROLE_KEY`, a service key shipped to every browser.

## 🤝 Contributing

Issues and PRs welcome, especially "this broke on my setup" reports from macOS and Linux. If a skill saved you time, a ⭐ helps others find it.

## License

MIT
