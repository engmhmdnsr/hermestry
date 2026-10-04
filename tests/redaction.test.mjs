// Redaction contract for the /api/debug/share bundle.
//
// The bundle is a file written to disk that can outlive the session that made
// it, so it must not carry credentials. This test drives the EXACT regex taken
// out of the extras module (not a copy) so the two can never drift, and fails
// on both leaks and over-redaction: a scrubber that eats harmless log lines is
// as broken as one that leaks.
//
// Run: node tests/redaction.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extras = fs.readFileSync(
  path.join(repoRoot, 'device-patch', 'api_server_mobile_extras.py'),
  'utf-8',
);

const m = extras.match(/scrub = re\.compile\(\s*\n(?:\s*#[^\n]*\n)*\s*r"([^"]+)"/);
if (!m) {
  console.error('FAIL: could not find the scrub regex in api_server_mobile_extras.py');
  process.exit(1);
}
const scrub = new RegExp(m[1], 'gi');

// Substrings that must never survive into the bundle.
const SECRETS = [
  'sk-fakerealsecret1234567890',
  'oc_sk_fakerealfake9999',
  'abcdef123456ZZZ',
  'ZZZ-token-value',
  'AAHfakevalue',
  'hunter2fake',
  'myrealpassword1',
];

const cases = [
  ['OPENCODE_GO_API_KEY=sk-fakerealsecret1234567890', 'sk-fakerealsecret1234567890'],
  ['OPENCODE_GO_API_KEY: oc_sk_fakerealfake9999', 'oc_sk_fakerealfake9999'],
  ['authorization: Bearer abcdef123456ZZZ', 'abcdef123456ZZZ'],
  ['Authorization=Bearer QQQfakevalue', 'QQQfakevalue'],
  ['Bearer\tZZZ-token-value', 'ZZZ-token-value'],
  ['Telegram TG_BOT_TOKEN = 999:AAHfakevalue', 'AAHfakevalue'],
  ['DB_PASSWORD=hunter2fake', 'hunter2fake'],
  ['auth_token: "myrealpassword1"', 'myrealpassword1'],
];

// Benign lines that must survive untouched, or the bundle is useless.
const mustSurvive = [
  'gateway listening on 127.0.0.1:8080 ready',
  '[GATEWAY] stage=SERVER_KEY present=true',
  'run started at 2026-10-04 21:54:54',
  '2026-10-04 21:54:57,189 INFO gateway.run: Model configured',
  'provider key exported for opencode-go (OPENCODE_GO_API_KEY)',
];

let failures = 0;

for (const [line, secret] of cases) {
  const out = line.replace(scrub, '$1<redacted>');
  if (out.includes(secret)) {
    console.error(`FAIL leak: ${line}\n  -> ${out}`);
    failures += 1;
  } else if (!out.includes('<redacted>')) {
    console.error(`FAIL no-op: nothing redacted in ${line}`);
    failures += 1;
  }
}

for (const line of mustSurvive) {
  const out = line.replace(scrub, '$1<redacted>');
  if (out !== line) {
    console.error(`FAIL over-redaction: ${line}\n  -> ${out}`);
    failures += 1;
  }
}

if (failures) {
  console.error(`\nredaction: ${failures} failed`);
  process.exit(1);
}
console.log(`redaction: ${cases.length} secret cases scrubbed, ${mustSurvive.length} benign lines preserved, 0 leaks`);