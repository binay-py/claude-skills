# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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

[1.1.0]: https://github.com/binay-py/claude-skills/releases/tag/v1.1.0
