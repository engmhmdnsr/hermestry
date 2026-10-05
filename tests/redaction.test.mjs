// Redaction contract for the /api/debug/share bundle, driven against the real
// redact_secrets() in the extras module.
//
// This file used to extract the scrub regex out of the Python source with a
// fragile regex match, so it failed the moment the pattern moved. The scrubber
// is now a set of compiled patterns behind a function, so the test calls that
// function instead: still the shipped code rather than a copy, but it can no
// longer break because the source text was reformatted.
//
// tests/python-redaction.test.mjs covers the recursive backup path and a wider
// JSON corpus. This file keeps the provider-shaped fixtures that a real
// gateway log contains, including the benign lines a user needs in order to
// report a problem at all.
//
// Run: node tests/redaction.test.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRAS = path.join(repoRoot, 'device-patch', 'api_server_mobile_extras.py');
const PY = process.env.HERMES_PYTHON || 'python';

// Credential shapes this app actually stores, as they appear in a log line.
// Substrings listed here must never survive into the bundle.
const cases = [
  ['OPENCODE_GO_API_KEY=oc_sk_fakerealfake9999', 'oc_sk_fakerealfake9999'],
  ['OPENCODE_GO_API_KEY: oc_sk_fakerealfake9999', 'oc_sk_fakerealfake9999'],
  ['authorization: Bearer abcdef123456ZZZ', 'abcdef123456ZZZ'],
  ['Authorization=Bearer QQQfakevalue', 'QQQfakevalue'],
  ['Bearer\tZZZ-token-value', 'ZZZ-token-value'],
  ['Telegram TG_BOT_TOKEN = 999999999:AAHfakevalue', '999999999:AAHfakevalue'],
  ['DB_PASSWORD=hunter2fake', 'hunter2fake'],
  ['auth_token: "myrealpassword1"', 'myrealpassword1'],
];

// Benign lines that must survive untouched, or the bundle is useless: a user
// reporting a problem has to be able to quote what the log actually said.
const mustSurvive = [
  'gateway listening on 127.0.0.1:8080 ready',
  '[GATEWAY] stage=SERVER_KEY present=true',
  'run started at 2026-10-04 21:54:54',
  '2026-10-04 21:54:57,189 INFO gateway.run: Model configured',
  'provider key exported for opencode-go (OPENCODE_GO_API_KEY)',
  'no provider key stored for deepseek, the gateway will start without credentials',
];

// Passed to Python as a JSON *literal* string and decoded there, so escapes
// like \t survive. Interpolating raw JSON would embed a literal tab inside a
// Python string literal and be a syntax error.
const fixturesLiteral = JSON.stringify(JSON.stringify({ cases, mustSurvive }));

const pyScript = `
import importlib.util, json, sys, types

sys.modules.setdefault("aiohttp", types.ModuleType("aiohttp"))
web_stub = types.ModuleType("aiohttp.web")
web_stub.json_response = lambda *a, **k: None
web_stub.Response = object
web_stub.Request = object
sys.modules["aiohttp"].web = web_stub
sys.modules["aiohttp.web"] = web_stub

spec = importlib.util.spec_from_file_location("extras", ${JSON.stringify(EXTRAS)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

payload = json.loads(${fixturesLiteral})
print(json.dumps({
    "scrubbed": [[line, mod.redact_secrets(line)] for line, _ in payload["cases"]],
    "survived": [[line, mod.redact_secrets(line)] for line in payload["mustSurvive"]],
}))
`;

const proc = spawnSync(PY, ['-c', pyScript], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (proc.status !== 0) {
  console.error(`FAIL: could not run the shipped scrubber: ${proc.stderr?.slice(0, 900)}`);
  process.exit(1);
}

let results;
try {
  results = JSON.parse(proc.stdout.trim());
} catch {
  console.error(`FAIL: python did not return JSON: ${proc.stdout.slice(0, 400)}`);
  process.exit(1);
}

let failures = 0;

for (const [line, out] of results.scrubbed) {
  const secret = cases.find(([l]) => l === line)?.[1];
  if (secret && out.includes(secret)) {
    console.error(`FAIL leak: ${line}\n  -> ${out}`);
    failures += 1;
  } else if (!out.includes('redacted')) {
    console.error(`FAIL no-op: nothing redacted in ${line}\n  -> ${out}`);
    failures += 1;
  }
}

for (const [line, out] of results.survived) {
  if (out !== line) {
    console.error(`FAIL over-redaction: ${line}\n  -> ${out}`);
    failures += 1;
  }
}

if (failures) {
  console.error(`\nredaction: ${failures} failed`);
  process.exit(1);
}
console.log(
  `redaction: ${results.scrubbed.length} secret cases scrubbed, ` +
    `${results.survived.length} benign lines preserved, 0 leaks`
);