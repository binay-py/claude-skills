# Security policy

Several skills here are security tools (bash-checkpoint, package-guard, secret-commit-guard, claude-safety-audit, claude-sandbox), so a bypass of one of them counts as a vulnerability.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository ([direct link](https://github.com/binay-py/claude-skills/security/advisories/new)). Please don't open a public issue for it.

Include the skill name, the version (from `.claude-plugin/plugin.json`), your OS, and the smallest input that reproduces it. For a guard bypass, that's the exact command or file content that should have been blocked.

You should get a reply within 7 days. Fixed issues are credited in the release notes unless you'd rather stay anonymous.

## What counts

- A command that bash-checkpoint should block or snapshot but doesn't (for example a new way to spell `rm -rf ~`)
- A package install that package-guard lets through without checking
- A secret format that secret-commit-guard misses, or a way to commit a `.env` file past it
- A way out of the claude-sandbox container
- Any skill printing a full secret value, or sending local data anywhere other than the service it documents
- A hook that can be made to run attacker-controlled code

The hooks fail open by design: if one crashes or times out, the command runs. A crash on unusual input is a bug, not a vulnerability. Report it as a normal issue unless it can be triggered on purpose to switch a guard off.

## Supported versions

Only the latest release gets fixes. Update with `/plugin marketplace update binay-skills`.

## What the skills send over the network

- **package-guard** sends package names to the public npm and PyPI registries to check that they exist. Nothing else leaves your machine.
- **site-qa, visual-diff, link-preview-check, pwa-check, readme-upgrade** request the URLs you give them.
- **cf-pages-deploy, cf-backup** talk to Cloudflare through your own `wrangler` login.
- **mcp-audit `--measure`** starts or connects to the MCP servers already in your config, to size their tool lists.
- **brave-cdp** connects only to your own browser on `127.0.0.1`. The browser then opens whatever pages the task asks for.
- Every other skill works offline. No skill has telemetry.
