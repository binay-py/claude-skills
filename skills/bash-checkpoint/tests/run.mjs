// node tests/run.mjs — checks every "expected|command" line in cases.txt against the hook's rules
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = p => fileURLToPath(new URL(p, import.meta.url));
let bad = 0, n = 0;
for (const line of fs.readFileSync(here('./cases.txt'), 'utf8').split(/\r?\n/).filter(Boolean)) {
  const i = line.indexOf('|'), want = line.slice(0, i), cmd = line.slice(i + 1); n++;
  const got = execFileSync(process.execPath, [here('../scripts/checkpoint.mjs'), 'test', cmd], { encoding: 'utf8' }).trim().split(':')[0];
  if (got !== want) { bad++; console.log(`✘ expected ${want}, got ${got}: ${cmd}`); }
}
console.log(`${n - bad}/${n} passed`); process.exit(bad ? 1 : 0);
