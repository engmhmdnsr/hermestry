#!/usr/bin/env node
// Hermes Mobile verification harness.
//
//   node scripts/verify.mjs            run every check
//   node scripts/verify.mjs --only=i18n  run checks whose name matches
//
// Exit code 0 when every check passes, 1 otherwise (failure list printed).
// Checks 1..7 can fail the run; the dead code scan only emits warnings.
// Scope: this script and the tests/ check modules it loads are the only files
// this harness writes (build output goes under tests/.build).
import process from 'node:process';
import { checkTypes, checkViteBuild } from '../tests/check.build.mjs';
import { checkI18n } from '../tests/check.i18n.mjs';
import { checkEmDash, checkRawHex, checkEllipsis } from '../tests/check.static.mjs';
import { checkUnits } from '../tests/check.unit.mjs';
import { checkDeadCode } from '../tests/check.deadcode.mjs';
import { repoRoot } from '../tests/lib/util.mjs';

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length).toLowerCase();

const CHECKS = [
  ['typescript: tsc --noEmit', checkTypes],
  ['vite build', checkViteBuild],
  ['i18n parity (en/ar)', checkI18n],
  ['no em dash characters', () => checkEmDash()],
  ['no raw hex colors outside themes.ts / index.css', () => checkRawHex()],
  ['no three dot ellipsis in user facing strings', () => checkEllipsis()],
  ['unit assertions (plainFailure + code fence splitter)', checkUnits],
  ['dead code signals (exported symbols with zero callers)', () => checkDeadCode()],
];

function pad(s, n) {
  return String(s).padEnd(n);
}

const results = [];
let totalAssertionsPassed = 0;
let totalAssertionsFailed = 0;

console.log('Hermes Mobile verification harness');
console.log(`repo:  ${repoRoot}`);
console.log(`node:  ${process.version}`);
console.log(`time:  ${new Date().toISOString()}`);
console.log('');

let index = 0;
for (const [name, fn] of CHECKS) {
  if (only && !name.toLowerCase().includes(only)) continue;
  index++;
  const started = Date.now();
  let res;
  try {
    res = await fn();
  } catch (err) {
    res = { name, passed: 0, failures: [`check threw: ${err && err.stack ? err.stack : err}`], warnings: [], note: 'check crashed' };
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const failed = res.failures.length;
  const status = failed ? 'FAIL' : 'PASS';
  const warn = res.warnings.length ? `, ${res.warnings.length} warning(s)` : '';
  console.log(`${String(index).padStart(2)}. [${status}] ${pad(res.name || name, 52)} ${res.note || ''} (${secs}s${warn})`);
  results.push({ name: res.name || name, failed, failures: res.failures, warnings: res.warnings, status });
  if (res.note && /assertions passed/.test(res.note)) {
    const m = res.note.match(/(\d+) assertions passed, (\d+) failed/);
    if (m) {
      totalAssertionsPassed = Number(m[1]);
      totalAssertionsFailed = Number(m[2]);
    }
  }
}

const allFailures = results.flatMap((r) => r.failures.map((f) => ({ check: r.name, text: f })));
const allWarnings = results.flatMap((r) => r.warnings.map((w) => ({ check: r.name, text: w })));

console.log('');
if (allFailures.length) {
  console.log(`FAILURES (${allFailures.length}):`);
  for (const f of allFailures) {
    console.log(`  - [${f.check}]`);
    for (const line of String(f.text).split('\n')) console.log(`      ${line}`);
  }
  console.log('');
}
const MAX_WARNINGS_SHOWN = 10;
if (allWarnings.length) {
  console.log(`WARNINGS (${allWarnings.length}, not failing the run):`);
  for (const r of results) {
    r.warnings.slice(0, MAX_WARNINGS_SHOWN).forEach((w) => console.log(`  - [${r.name}] ${w}`));
    if (r.warnings.length > MAX_WARNINGS_SHOWN) {
      console.log(`  - [${r.name}] ... ${r.warnings.length - MAX_WARNINGS_SHOWN} more warning(s) not shown`);
    }
  }
  console.log('');
}

const passedChecks = results.filter((r) => !r.failed).length;
const failedChecks = results.filter((r) => r.failed).length;
console.log(`Checks: ${passedChecks} passed, ${failedChecks} failed, ${results.length} total`);
if (totalAssertionsPassed || totalAssertionsFailed) {
  console.log(`Assertions executed: ${totalAssertionsPassed} passed, ${totalAssertionsFailed} failed`);
}
console.log(`Result: ${failedChecks === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failedChecks === 0 ? 0 : 1);
