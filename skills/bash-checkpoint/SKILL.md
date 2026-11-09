---
name: bash-checkpoint
description: Undo button for shell commands Claude runs. A PreToolUse hook that snapshots files before destructive Bash/PowerShell commands (rm, mv, git clean/reset/checkout, sed -i, overwrites), blocks catastrophic ones (rm -rf ~ or /, Remove-Item -Recurse C:\, mkfs, dd to a disk), and forces a confirmation before force-push, git reset --hard and DROP TABLE, even in bypass mode. Use when the user wants protection from Claude deleting files, asks how to undo a command Claude ran, or wants to restore something Claude removed.
---

# bash-checkpoint

`scripts/checkpoint.mjs` is zero-dependency Node 22+. Claude Code's own checkpoints cover file edits, **not shell commands**. This covers those.

## Install (ask the user first, it changes their settings)
Add to `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project), using the absolute path to the script:
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell",
        "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/bash-checkpoint/scripts/checkpoint.mjs\" hook" }] }
    ]
  }
}
```
Merge into existing `hooks` rather than overwriting them. Restart Claude Code, then check with `/hooks`.

## What happens on each shell command
| Command | Action |
|---|---|
| `rm -rf ~`, `rm -rf /`, `rm -rf "$HOME"`, `Remove-Item -Recurse C:\`, `rd /s C:\`, `mkfs`, `dd of=/dev/sda`, fork bomb | **Blocked** (exit 2). Claude is told the user must run it themselves. |
| `git push --force`, `git reset --hard`, `git clean -f`, `git checkout -- .`, `branch -D`, `DROP TABLE` | **User must confirm**, even in bypass mode, plus a snapshot |
| `rm`, `mv`, `sed -i`, `find -delete`, `> file`, `Remove-Item`, `git restore/stash/rm` … | **Snapshot**, then runs normally |
| everything else | nothing (no slowdown) |

**Snapshots:** in a git repo, the whole working tree (tracked + untracked, respecting .gitignore) is stored as a commit under `refs/claude-checkpoints/`. Branches, index and stash are untouched. Outside git, the paths named in the command are copied to `~/.claude/checkpoints/<id>/` (up to 300 MB).

## Restoring
```
node checkpoint.mjs list               # checkpoints for the current folder (--all for every folder)
node checkpoint.mjs show <id>          # what differs from now
node checkpoint.mjs restore <id>       # put everything back
node checkpoint.mjs restore <id> src/  # just one path
node checkpoint.mjs prune --keep 50
node checkpoint.mjs test "rm -rf ~"    # see what the rules would do
node tests/run.mjs                    # 45 rule test cases (block / ask / snapshot / none)
```
Restoring brings back deleted and modified files and leaves files created after the snapshot alone.

## Limits (tell the user)
- It's pattern-based, so a determined or obfuscated command (`eval $(echo …)`, a script file that deletes things) can get past it. It's a seatbelt, not a sandbox. Pair it with deny rules (`claude-safety-audit --fix`) and run risky work in a container.
- The snapshot runs *before* the command, so files the same command creates and then deletes can't be saved.
- Block rules check each command segment and fire only when that segment *runs* the program (`rm`, `Remove-Item`, `mkfs`…), unwrapping `bash -c`, `sh -c`, `eval`, `powershell -Command` and `cmd /c`. Mentions inside quotes (commit messages, grep patterns) pass. A heredoc line that starts with `rm -rf ~` counts as a command and is blocked; that's deliberate, so put such test text in a file.
- Quoted text is ignored for snapshot/ask decisions, so `git commit -m "rm old docs"` or `grep "rm"` does nothing. Compound commands (`cd dir && rm x`) are followed segment by segment.
