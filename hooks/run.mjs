#!/usr/bin/env node
// Entry point for the hooks this plugin ships (hooks/hooks.json): node run.mjs <hook-name>
// Turn hooks off without disabling the plugin by setting, e.g. in ~/.claude/settings.json:
//   "env": { "BINAY_SKILLS_HOOKS_OFF": "read-guard,session-handoff" }   (or "all")
// Fails open: if anything here goes wrong, the tool call goes ahead.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS = {
  'bash-checkpoint': ['skills/bash-checkpoint/scripts/checkpoint.mjs', 'hook'],
  'read-guard': ['skills/read-guard/scripts/read-guard.mjs', 'hook'],
  'package-guard': ['skills/package-guard/scripts/package-guard.mjs', 'hook'],
  'session-handoff': ['skills/session-handoff/scripts/handoff.mjs', 'meter'],
};

const name = process.argv[2];
const off = (process.env.BINAY_SKILLS_HOOKS_OFF || '').split(/[\s,]+/).filter(Boolean);
if (!HOOKS[name] || off.includes('all') || off.includes(name)) process.exit(0);

try {
  const [rel, mode] = HOOKS[name];
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel);
  process.argv = [process.argv[0], script, mode]; // the hook scripts read their mode from argv
  await import(pathToFileURL(script).href);
} catch (e) {
  process.stderr.write(`binay-skills ${name} hook skipped: ${e.message}\n`);
  process.exit(0);
}
