#!/usr/bin/env python3
"""lean_check: print the fixed token overhead Claude Code loads every session, with fixes.
Read-only. Usage: python lean_check.py [project_dir]"""
import json, os, re, sys
from pathlib import Path

HOME = Path.home()
CL = HOME / ".claude"
PROJ = Path(sys.argv[1] if len(sys.argv) > 1 else os.getcwd()).resolve()
tok = lambda s: len(s) // 4  # rough tokens
issues, rows = [], []


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return {}


def text(p):
    try:
        return Path(p).read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


settings = load(CL / "settings.json")
claude_json = load(HOME / ".claude.json")

# Model / effort
model = str(settings.get("model", "default"))
rows.append(("model", model))
if "opus" in model.lower():
    issues.append("Default model is Opus. Use Sonnet as default (/model sonnet), switch to Opus only for hard tasks.")
if "[1m]" in model:
    issues.append("1M-context model is default: long sessions get huge before auto-compact. Use the normal context size unless you need it.")
eff = settings.get("effortLevel")
rows.append(("effort", eff or "default"))
if eff in ("max", "xhigh"):
    issues.append(f"effortLevel={eff}: thinking tokens are output tokens. Use /effort medium for routine work.")

# Instruction files
for p in [CL / "CLAUDE.md", PROJ / "CLAUDE.md", PROJ / ".claude" / "CLAUDE.md", PROJ / "CLAUDE.local.md"]:
    t = text(p)
    if t:
        n = t.count("\n") + 1
        rows.append((f"CLAUDE.md {p}", f"{n} lines ~{tok(t)} tok"))
        if n > 200:
            issues.append(f"{p} is {n} lines. Keep <200; move workflow-specific parts into skills (load on demand).")

slug = re.sub(r"[^A-Za-z0-9]", "-", str(PROJ))
mem = text(CL / "projects" / slug / "memory" / "MEMORY.md")
if mem:
    n = mem.count("\n") + 1
    rows.append(("MEMORY.md", f"{n} lines ~{tok(mem)} tok"))
    if n > 60 or tok(mem) > 2500:
        issues.append("MEMORY.md index is big. Shorten each line to a few words; merge or delete stale memories.")

# MCP servers
mcp = dict(claude_json.get("mcpServers") or {})
pj = (claude_json.get("projects") or {})
for k, v in pj.items():
    if Path(k).resolve() == PROJ if os.path.isabs(k) else False:
        mcp.update(v.get("mcpServers") or {})
mcp.update(load(PROJ / ".mcp.json").get("mcpServers") or {})
rows.append(("MCP servers (local config)", f"{len(mcp)}: {', '.join(mcp) or '-'}"))
if len(mcp) > 3:
    issues.append(f"{len(mcp)} MCP servers configured. Disable unused ones in /mcp; prefer CLI tools (gh, wrangler) which cost 0 context.")
rows.append(("claude.ai connectors", "not visible here: check /mcp and disconnect unused ones in claude.ai settings"))

# Plugins + skill descriptions
enabled = [k for k, v in (settings.get("enabledPlugins") or {}).items() if v]
installed = load(CL / "plugins" / "installed_plugins.json").get("plugins", {})
skill_files = list((CL / "skills").glob("*/SKILL.md"))
for name in enabled:
    for ent in installed.get(name, []):
        ip = ent.get("installPath")
        if ip and (ent.get("scope") == "user" or Path(ent.get("projectPath", "/x")).resolve() == PROJ):
            skill_files += list(Path(ip).glob("skills/*/SKILL.md"))
            break
desc_tok = 0
for f in skill_files:
    m = re.search(r"^description:\s*(.+?)(?=^\w[\w-]*:|^---)", text(f), re.S | re.M)
    desc_tok += tok(m.group(1)) if m else 0
rows.append(("plugins enabled", len(enabled)))
rows.append(("skills listed every session", f"{len(skill_files)} ~{desc_tok} tok of descriptions"))
if len(skill_files) > 40:
    issues.append(f"{len(skill_files)} skills: every description loads each session. Uninstall/disable plugins you don't use (/plugin).")

# Hooks that add text to every prompt
hooks = settings.get("hooks") or {}
ups = hooks.get("UserPromptSubmit") or []
for name in enabled:
    for ent in installed.get(name, [])[:1]:
        hj = load(Path(ent.get("installPath", "")) / "hooks" / "hooks.json")
        if (hj.get("hooks") or {}).get("UserPromptSubmit"):
            ups.append(name)
rows.append(("UserPromptSubmit hooks", len(ups)))
if ups:
    issues.append("UserPromptSubmit hooks inject text into EVERY prompt. Keep their output tiny or disable when not needed.")
if settings.get("autoCompactEnabled") is False:
    issues.append("Auto-compact is off: context can grow until it fails. Turn it on or /clear often.")

w = max(len(r[0]) for r in rows)
print("LEAN CHECK  (" + str(PROJ) + ")")
for k, v in rows:
    print(f"  {k.ljust(w)}  {v}")
print("\nFIXES" if issues else "\nNo big overhead found.")
for i, s in enumerate(issues, 1):
    print(f"  {i}. {s}")
print("\nHabits: /clear between tasks | specific prompts with file paths | plan mode for big changes | Esc early | /usage to see what costs most")
