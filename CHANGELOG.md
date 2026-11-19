# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **brave-cdp: MCP server** (`scripts/mcp.mjs`, no dependencies). 14 browser tools for the user's own logged-in browser: open, tabs, navigate, read (text plus numbered elements to click by number), click, type, key, scroll, wait, screenshot (JPEG, max 1280 px), eval, show, close, and extension list/reload/errors. Connects on first use, reuses the relay, and opens tabs hidden.
- **brave-cdp: background mode, on by default.** Job tabs open in an off-screen work window with emulated focus, so the user can keep working in the browser and other apps while Claude does. The window is made once when the relay starts and its tabs are pooled, because on Windows creating a window or tab steals focus and navigating an existing one doesn't. `p.show()` brings it on screen, `visible: true` or `CDP_VISIBLE=1` opts out, `cleanup --all` closes the window.
- **brave-cdp:** `ext list | reload | errors | watch` for Chrome extensions you are developing. Reload an unpacked extension by id, folder or name and print only the errors raised since the reload; `--tabs` also reloads the open pages its content scripts match; `watch` reloads on every save. Works through the browser's own extensions page, so it needs no launch flags. Jobs get the same through `ext()`. Pages can be opened in the background with `page({ url, background: true })`.

## [1.4.0] - 2026-11-16

### Added
- **lean:** a token-lean mode. Invoking it makes Claude read only what it needs, cap command output, skip narration and keep answers short. `scripts/lean_check.py` reports the fixed overhead loaded every session (default model, 1M context, CLAUDE.md, MEMORY.md, MCP servers, skill descriptions, prompt hooks, auto-compact) with a fix for each.
- **promo-video**: promo videos of your own site from one command (`quick <url>`). Records the real page frame by frame and renders a 9:16 and a 16:9 cut with a hook from frame 0, chunked captions inside the Reels/TikTok safe zone, music or an optional edge-tts voiceover, two-pass loudness to -14 LUFS, and a `check` command that verifies every rule from ffprobe numbers instead of frames.
- SECURITY.md (private reporting, what counts as a guard bypass, which skills use the network), CODE_OF_CONDUCT.md and a pull request template.

### Fixed
- **package-guard** compared registry URLs by substring, so a host such as `registry.npmjs.org.evil.example` counted as the public npm registry. It now compares exact hostnames.
- Three regexes that could backtrack catastrophically on crafted input (read-guard, pwa-check), incomplete regex escaping (secret-commit-guard, freelance-proposal, pwa-check) and cmd.exe quoting in mcp-audit, all found by CodeQL.
- **readme-upgrade:** HTML comments that span several lines are now skipped when checking links (CodeQL js/bad-tag-filter).
- CI: the lean skill was missing from the plugin manifest. Workflow now has a read-only token and SHA-pinned actions, kept current by Dependabot.

## [1.3.0] - 2026-11-16

### Changed
- **The plugin ships its hooks.** Installing binay-skills now turns on bash-checkpoint, read-guard, package-guard and the session-handoff meter through `hooks/hooks.json`, with no settings to paste. Turn any of them off with `"env": { "BINAY_SKILLS_HOOKS_OFF": "read-guard,session-handoff" }` (or `"all"`). If you added these hooks to your settings by hand before, remove those entries, or each hook runs twice.

### Fixed
- **package-guard:** shell redirections were read as package names (`pip install x 2>&1` checked a package called "2", `> log.txt` one called "log.txt").
- **gif-maker, event-recap-video:** lines that mix English and Nepali (or emoji) now render correctly, not just lines that start with the Nepali word.

## [1.2.0] - 2026-11-15

Every skill was re-tested against real repos, logs, sites and media; each one had bugs, now fixed. Three new skills (26 in total).

### Added
- **cws-extension-check:** checks a Chrome extension against the Chrome Web Store's rules before upload (MV3 manifest limits, icon sizes, exact-case file references, remote code, unused and missing permissions, placeholder URLs, package junk), builds a verified upload zip and drafts the dashboard's permission justifications.
- **cf-backup:** read-only backups of Cloudflare D1 databases and KV namespaces with a checksum manifest, `verify`, a RESTORE.md with the exact commands, and pruning that only touches its own folders.
- **pwa-check:** whether a web app installs as a PWA and really works offline, for a live URL or a build folder, with Chrome's own verdict next to manifest, icon and service-worker checks.
- CI runs the three new test suites.

### Fixed
- **bash-checkpoint:** now blocks `rm -rf ~/*`, `rm -- ~`, long flags, `bash -lc`/`sudo -u` wrappers, `Remove-Item -r -fo ~`, `rd /s /q C:\` and Git Bash `/c/` paths; asks before `git -C <dir> reset --hard` and force-pushes; snapshots Git Bash paths and files outside the repo. Heredoc text fed to `git commit` or `cat` is no longer treated as commands. `rm -rf "$HOME"/build` is no longer blocked.
- **package-guard:** the hook did nothing when its own path contained a space or non-ASCII character (e.g. `C:\Users\John Smith`); it also catches `bash -lc`, `sudo -H`/`-E` installs and `uvx --from`.
- **read-guard:** catches `cat big 2>&1`, `Get-Content -Raw` and Git Bash paths; allows pipes into programs that limit output.
- **secret-commit-guard:** placeholders like `ghp_xxxx` are no longer flagged; tokens in JS template strings are caught.
- **claude-safety-audit:** the `--fix` preview no longer prints Bearer and `token=` values; settings backups are kept out of the repo.
- **claude-sandbox:** refuses to mount the home folder written in lowercase or its parent.
- **claude-token-audit:** counts subagent logs and only installed, enabled skills.
- **session-handoff:** finds the current session when the script path is quoted, survives API-error entries, and redacts before truncating.
- **env-doctor:** understands Cloudflare Workers (`env.X`, `.dev.vars`, wrangler bindings).
- **claude-md-doctor, mcp-audit, release-notes:** off-by-one line counts, auto memory from subfolders, real crash reasons for MCP servers, CRLF changelogs kept as CRLF.
- **site-qa, visual-diff:** no more 30-second waits and false "slow" findings on pages with beacons or redirects; site-qa follows http→https and checks same-site file links. On Windows, a force-killed headless Edge leaves blank entries stuck in Alt+Tab, so site-qa, visual-diff, gif-maker and pwa-check now always close the browser over DevTools and wait for it (Ctrl+C and crashes included). A small watchdog does the same when a run is killed outright, and the next run closes browsers left behind by older versions.
- **cf-pages-deploy:** `.dev.vars` is never uploaded, every text file is scanned for secrets, and `--include` no longer pulls in `node_modules`.
- **brave-cdp:** one relay token per port, `CDP_URL`/`CDP_BROWSER` respected while a relay runs, and tabs left by killed jobs are closed on the next run (`cleanup`).
- **link-preview-check, readme-upgrade:** Git Bash paths, sitemap edge cases, bare links checked.
- **thumbnail-maker, event-recap-video, gif-maker:** Nepali/Hindi (Devanagari) text renders correctly instead of as boxes or broken conjuncts; event-recap-video's analyze step no longer crashes and HEIC photos work.
- **itch-html5-package, freelance-proposal:** `Index.html` case mismatches are errors; timelines no longer count as proof.

### Changed
- CI uses Node 24 versions of the GitHub actions.

## [1.1.0] - 2026-11-09

First tagged release: 23 skills, tested on Windows, macOS and Linux in CI.

### Added
- **Safety:** claude-safety-audit, bash-checkpoint (undo for shell commands), package-guard (blocks hallucinated and typosquatted packages), secret-commit-guard (pre-commit key scanner) and claude-sandbox (Docker isolation).
- **Usage and cost:** claude-token-audit, read-guard, session-handoff, mcp-audit and claude-md-doctor.
- **Websites:** site-qa, link-preview-check, visual-diff, cf-pages-deploy and env-doctor.
- **Repositories and games:** release-notes, readme-upgrade and itch-html5-package.
- **Media:** gif-maker, thumbnail-maker and event-recap-video.
- **Freelance and browser:** freelance-proposal and brave-cdp.
- Continuous integration on Windows, macOS and Linux: syntax checks for every script, the bash-checkpoint, package-guard and secret-commit-guard test suites, README link checks and smoke tests.
- Issue templates, CONTRIBUTING.md and a private security-report link.

### Changed
- bash-checkpoint blocks recursive deletes of **any** user's home folder (`C:\Users\<name>`, `/home/<name>`, `/Users/<name>`, `/root`), not just the current user's. CI on fresh machines exposed the gap.
- bash-checkpoint checks each command segment for block rules, unwraps `bash -c`, `sh -c`, `eval`, `powershell -Command` and `cmd /c`, follows `cd`, and ignores quoted text, so commit messages that mention dangerous commands are no longer blocked.
- thumbnail-maker defaults to a clean look (flat color or blurred photo), supports real screenshots with a hand-drawn circle and arrow, puts cut-out photos in front of the title, and checks YouTube's timestamp corner and a squint test.
- The README demo is a real terminal recording instead of a decorative banner.

### Fixed
- brave-cdp: Enter now submits forms, pages wait until they leave `about:blank`, and tabs a job opened are closed even when the job fails.

[1.3.0]: https://github.com/binay-py/claude-skills/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/binay-py/claude-skills/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/binay-py/claude-skills/releases/tag/v1.1.0
