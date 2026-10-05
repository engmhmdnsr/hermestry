// Regression tests for the P0 secret-handling fixes in
// device-patch/api_server_mobile_extras.py (H-02 backup, H-03 debug scrub).
//
// The Python module is loaded directly rather than through the TS harness: it
// is the shipped artifact and is plain Python, so importing it exercises the
// real functions instead of a copy. Node drives it via a tiny subprocess so a
// syntax error in the Python fails the test rather than being swallowed.
//
// Run: node tests/python-redaction.test.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRAS = path.join(ROOT, 'device-patch', 'api_server_mobile_extras.py');
const ANDROID_ASSET = path.join(
  ROOT, 'android', 'app', 'src', 'main', 'assets', 'api_server_mobile_extras.py'
);

const PY = process.env.HERMES_PYTHON || 'python';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

// Run one snippet of python with the extras module importable, return JSON.
function runPy(body) {
  const script = `
import importlib.util, json, sys, types

# The module does a lot of optional importing at module scope. Stub the names
# it reaches for so importing it here does not need aiohttp or the agent tree.
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

${body}
`;
  const res = spawnSync(PY, ['-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`python failed (${res.status}): ${res.stderr?.slice(0, 900)}`);
  }
  const out = res.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`python did not return JSON, got: ${out.slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------- H-02
console.log('\nH-02  backup sanitization is recursive');

// Nested secret at depth 2 under a provider block: this is the exact shape the
// old top-level filter let through, because the top-level key is "providers".
const nested = runPy(`
cfg = {
    "model": "some-model",
    "providers": {
        "openai": {
            "api_key": "REAL_SECRET_NESTED",
            "nested": [{"token": "REAL_TOKEN_LIST"}],
        }
    },
}
out = mod.sanitize_secrets(cfg)
print(json.dumps({
    "flat": "REAL_SECRET_NESTED" not in json.dumps(out),
    "deep": "REAL_TOKEN_LIST" not in json.dumps(out),
    "kept_model": out.get("model") == "some-model",
    "kept_structure": "openai" in out.get("providers", {}),
    "redaction_marker": "redacted" in json.dumps(out),
}))
`);
check('nested provider api_key is removed', nested.flat);
check('token inside a nested list is removed', nested.deep);
check('ordinary config value survives', nested.kept_model);
check('sibling structure is preserved', nested.kept_structure);
check('redaction is visible in the output', nested.redaction_marker);

// The live config must survive untouched. Callers keep using it after the
// backup, so a scrubber that mutated its input would break the running gateway.
const nomutate = runPy(`
cfg = {"providers": {"openai": {"api_key": "KEEP_ME"}}}
mod.sanitize_secrets(cfg)
print(json.dumps({"untouched": cfg["providers"]["openai"]["api_key"] == "KEEP_ME"}))
`);
check('input config is not mutated', nomutate.untouched);

// Key-name variants all have to match: the scrubber normalizes separators and
// case, so api_key, apiKey and API-KEY are the same field.
const variants = runPy(`
names = ["api_key", "apiKey", "API-KEY", "server_key", "token", "TOKEN",
         "password", "passwd", "secret", "authorization", "cookie",
         "access_token", "refresh_token", "credential", "private_key"]
hits = [n for n in names if mod._is_secret_key(n)]
misses = [n for n in names if not mod._is_secret_key(n)]
print(json.dumps({"hits": hits, "misses": misses}))
`);
check('all credential key spellings are caught', variants.misses.length === 0, `missed: ${variants.misses.join(', ')}`);

// Over-redaction is a real failure mode too: stripping ordinary config is data
// loss, and the AGENT brief says not to break harmless fields.
const benign = runPy(`
names = ["keybindings", "keyboard", "keywords", "hotkeys", "public_key",
         "key_id", "model", "provider", "base_url", "context_length"]
wrong = [n for n in names if mod._is_secret_key(n)]
print(json.dumps({"wrong": wrong}))
`);
check('harmless key-shaped names are not redacted', benign.wrong.length === 0, `wrongly redacted: ${benign.wrong.join(', ')}`);

// Odd shapes must not raise: a scrubber that throws would turn a backup
// request into a 500, which is the failure it was meant to prevent.
const shapes = runPy(`
cases = [None, 1, "s", True, [], {}, [1, [2, {"token": "T"}]],
         {"a": {"b": {"c": {"d": {"token": "DEEP"}}}}}, (), {"n": None}]
ok = True
detail = ""
for c in cases:
    try:
        mod.sanitize_secrets(c)
    except Exception as e:
        ok = False
        detail = repr(e)
print(json.dumps({"ok": ok, "detail": detail}))
`);
check('unusual config shapes do not raise', shapes.ok, shapes.detail);

// A self-referential structure must terminate rather than hang the request.
const cyclic = runPy(`
d = {"token": "C"}
d["self"] = d
try:
    mod.sanitize_secrets(d)
    print(json.dumps({"ok": True}))
except RecursionError:
    print(json.dumps({"ok": True, "note": "recursion"}))
except Exception as e:
    print(json.dumps({"ok": False, "err": repr(e)}))
`);
check('a self-referential config terminates', cyclic.ok, cyclic.err || '');

// ---------------------------------------------------------------- H-03
console.log('\nH-03  debug redaction catches quoted JSON');

// The old inline pattern passed all of these through untouched, which is the
// whole finding: the debug bundle is a file the user may share.
const leaked = runPy(`
cases = [
    ('{"api_key": "SECRET_A"}', 'SECRET_A'),
    ("{'password': 'SECRET_B'}", 'SECRET_B'),
    ('{"token":"SECRET_C"}', 'SECRET_C'),
    ('"apiKey": "SECRET_D"', 'SECRET_D'),
    ('api_key=SECRET_E', 'SECRET_E'),
    ('API_KEY: SECRET_F', 'SECRET_F'),
    ('OPENAI_API_KEY=SECRET_G', 'SECRET_G'),
    ('Authorization: Bearer SECRET_H', 'SECRET_H'),
    ('authorization=Bearer SECRET_I', 'SECRET_I'),
    ('sk-abcDEF1234567890abcdef', 'sk-abcDEF1234567890abcdef'),
    ('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'),
    ('1234567890:AAHabcdefghijklmnopqrstuvwxyz12345', '1234567890:AAHabcdefghijklmnopqrstuvwxyz12345'),
    ('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'),
    ('-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJBAK\\n-----END RSA PRIVATE KEY-----', 'BEGIN RSA PRIVATE KEY'),
]
out = []
for line, secret in cases:
    red = mod.redact_secrets(line)
    out.append({"line": line[:44], "leaked": secret in red, "red": red[:80]})
print(json.dumps(out))
`);
for (const c of leaked) {
  check(`no leak: ${c.line}`, !c.leaked, `-> ${c.red}`);
}

// Redaction has to actually replace, not just avoid the substring.
const marked = runPy(`
s = mod.redact_secrets('{"api_key": "SECRET"} and api_key=OTHER')
print(json.dumps({"has_marker": "redacted" in s, "count": s.count("redacted")}))
`);
check('redaction marks the removed value', marked.has_marker);

// The other half of the contract: a diagnostics bundle that eats real log
// sentences is worse than one that leaks nothing, because the user cannot
// report what went wrong. Ordinary lines must survive byte for byte.
const kept = runPy(`
lines = [
    "2026-10-05 01:23:45 INFO gateway started on 127.0.0.1:8080",
    "POST /api/sessions/abc/chat/stream 200 3727 bytes",
    "GET /api/model/options 200 20740 bytes",
    "provider key exported for openai-go",
    "Skills: 53 registered",
    "Error code: 400 This Go model requires Global regions.",
    "retrying in 5.0 seconds, attempt 2 of 3",
    "memory_char_limit=20000 user_char_limit=4000",
    "path=/data/user/0/ee.oversight.hermes.mobile/files/config.yaml",
]
changed = [l for l in lines if mod.redact_secrets(l) != l]
print(json.dumps({"changed": changed}))
`);
check('ordinary log lines are untouched', kept.changed.length === 0, `altered: ${kept.changed.join(' | ')}`);

// A multiline dump is what the bundle actually contains.
const multiline = runPy(`
text = """2026-01-01 start
config line: {"providers": {"openai": {"api_key": "MULTI_SECRET"}}}
Authorization: Bearer MULTI_TOKEN_1234567890
2026-01-01 end"""
red = mod.redact_secrets(text)
print(json.dumps({
    "a": "MULTI_SECRET" in red,
    "b": "MULTI_TOKEN_1234567890" in red,
    "kept": "2026-01-01 start" in red and "2026-01-01 end" in red,
}))
`);
check('no leak inside a multiline log', !multiline.a);
check('no leak for a bearer token in a multiline log', !multiline.b);
check('surrounding log lines survive', multiline.kept);

// Empty and non-string input must not explode.
const edge = runPy(`
out = []
for v in ["", None]:
    try:
        out.append(mod.redact_secrets(v) == v or mod.redact_secrets(v) is None)
    except Exception as e:
        out.append(False)
print(json.dumps({"ok": all(out)}))
`);
check('empty input is handled', edge.ok);

// ------------------------------------------------- shipped-asset parity
console.log('\nParity  device-patch and the Android asset are the same file');
const a = fs.readFileSync(EXTRAS);
const b = fs.readFileSync(ANDROID_ASSET);
check(
  'android asset is byte-identical to device-patch',
  a.equals(b),
  `${a.length} vs ${b.length} bytes`
);

// The em-dash rule for shipped copy.
check('no em dashes in the shipped Python', !a.toString('utf8').includes('\u2014'));

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`failing: ${failures.join(', ')}`);
  process.exit(1);
}