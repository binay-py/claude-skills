# Contributing

Thanks for helping. Bug reports from macOS and Linux are especially useful, since most hands-on testing so far was on Windows.

## Reporting a bug
Open an issue with the bug report form. Include the exact command, your OS and Node version, and the output. Remove secrets, tokens and private paths from anything you paste.

Security problems (for example a way to get past one of the guard hooks) should go through a [private security advisory](https://github.com/binay-py/claude-skills/security/advisories/new), not a public issue.

## Changing a skill
Each skill lives in `skills/<name>/`:

```
skills/<name>/
  SKILL.md          frontmatter (name, description) + instructions for Claude
  scripts/          the code Claude runs
  tests/            optional: cases.txt + run.mjs
```

Ground rules:
- **No npm dependencies.** Node 22 standard library only. Python skills may use Pillow.
- **Read-only by default.** Anything that changes files or settings needs an explicit flag and keeps a backup.
- **Never print secrets.** Show at most the first few characters.
- **Hooks fail open.** If a hook errors or times out, the command must still run.
- **Test against something real** (a real repo, site or log), and add cases to `tests/cases.txt` when the skill has a suite.

Before opening a pull request, run what CI runs:

```bash
for f in $(find skills -name '*.mjs'); do node --check "$f"; done
node skills/bash-checkpoint/tests/run.mjs
node skills/package-guard/tests/run.mjs
node skills/secret-commit-guard/tests/run.mjs
node skills/readme-upgrade/scripts/readme-check.mjs . --offline
```

## Adding a skill
Open a "Skill idea" issue first so we can agree on scope. New skills should solve a problem you've actually hit, include a `SKILL.md` that says when Claude should use it, be added to `.claude-plugin/marketplace.json`, and get a row in the README.
