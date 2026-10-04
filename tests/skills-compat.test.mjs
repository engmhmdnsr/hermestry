// GET /v1/skills compat shim contract.
//
// api_server._handle_skills calls _find_all_skills(include_editorial=True),
// but that keyword only exists in a newer tools/skills_tool.py than the one
// in the mobile image. The mismatch surfaced as an empty Skills screen: the
// handler turns the TypeError into a 500 and the app has nothing to show.
//
// The shim must repair an OLD agent, leave a FUTURE agent alone, and never
// double-wrap. Run: node tests/skills-compat.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extras = fs.readFileSync(
  path.join(repoRoot, 'device-patch', 'api_server_mobile_extras.py'),
  'utf-8',
);

if (!extras.includes('def _apply_skills_compat')) {
  console.error('FAIL: _apply_skills_compat is missing from api_server_mobile_extras.py');
  process.exit(1);
}
if (!extras.includes('_apply_skills_compat()\n')) {
  console.error('FAIL: the shim is never invoked from _http_routes');
  process.exit(1);
}

let failures = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

// The wrapper must accept the offending kwarg and drop it, since no code in
// this agent version references "editorial" and there is no filter to honour.
check(
  'wrapper declares include_editorial',
  /def _find_all_skills\(\*args,\s*include_editorial:\s*bool\s*=\s*False,\s*\*\*kwargs\)/.test(extras),
);
check(
  'wrapper drops the kwarg instead of forwarding it',
  /def _find_all_skills\(\*args,\s*include_editorial: bool = False, \*\*kwargs\):\s*\n\s*return original\(\*args, \*\*kwargs\)/.test(extras),
);
check('guards against double-wrapping', extras.includes('_hermes_mobile_compat'));
check('is a no-op when the agent already supports the kwarg', extras.includes('"include_editorial" in params'));
check('is marked idempotent', extras.includes('_SKILLS_COMPAT_APPLIED'));
// The shim must not invent filtering behind the kwarg it swallows: every
// mention of "editorial" inside the shim is either the dropped parameter or
// prose explaining why it is dropped. Anything else would be fabricated
// behaviour, which is exactly what this repair is meant to avoid.
const shim = extras.slice(
  extras.indexOf('_SKILLS_COMPAT_APPLIED = False'),
  extras.indexOf('def _http_routes'),
);
const invents = [...shim.matchAll(/editorial/gi)]
  .map((m) => shim.split('\n').findIndex((l) => l.includes('editorial')) )
  .filter((i) => i >= 0)
  .map((i) => shim.split('\n')[i])
  .filter((line) => !/include_editorial|kwarg|parameter|drop|accept|no behaviour|not to invent|honest repair/i.test(line));
check('never invents editorial filtering', invents.length === 0);

if (failures) {
  console.error(`\nskills-compat: ${failures} failed`);
  process.exit(1);
}
console.log('skills-compat: shim present, kwarg dropped, idempotent, no-op on future agents');