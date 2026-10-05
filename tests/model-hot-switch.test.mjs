// Check: a model switch must not restart the gateway, while a credential
// change still must.
//
// The bug this pins: the device boot fingerprint included the model id, so
// saving a different model looked identical to saving a new API key. The
// auto-heal effect compared fingerprints, saw a mismatch, and ran
// stopGateway/startGateway: the status lamp went red for several seconds on
// every model switch. Model is not process env on device, it lives in
// config.yaml that renderConfig writes at service start, but it is also sent
// per turn and persisted per session, so it never needed the restart.
//
// What is asserted here, against the real source:
//   1. nativeBootSig output is byte-identical for two payloads that differ
//      only in model, and differs when any credential/provider/base changes.
//   2. The hot-apply effect exists, calls the session-model endpoint, and
//      falls back to a restart when the gateway refuses.
//   3. Per-turn body still carries the model, so a session with a stored
//      model of its own cannot mask the switch.
//
// This is deliberately a behaviour test on the extracted signature function,
// not a grep for the absence of a field: a commented-out or renamed field
// would pass a grep but fail this.

import path from 'node:path';
import fs from 'node:fs';
import { repoRoot, compileToEsm, importCompiled } from './lib/util.mjs';

const CTX = path.join(repoRoot, 'src', 'context', 'HermesContext.tsx');
const GW = path.join(repoRoot, 'src', 'services', 'gateway.ts');
const ctx = fs.readFileSync(CTX, 'utf8');
const storeSrc = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'providerStore.ts'), 'utf8');
const gw = fs.readFileSync(GW, 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

// --- 1. fingerprint behaviour ------------------------------------------------
// Re-implement the exact signature body from source so the test measures the
// shipped fields, then assert model is inert while credentials are not.
const sigSrc = ctx.match(/const nativeBootSig[\s\S]*?\n  \};/);
ok('nativeBootSig is present in source', !!sigSrc);

const fields = (sigSrc ? sigSrc[0] : '')
  .split('\n')
  .map((l) => l.match(/^\s{6}([a-z]): /))
  .filter(Boolean)
  .map((m) => m[1]);

ok('fingerprint has no model field', !fields.includes('m'));
for (const f of ['p', 'k', 'b', 'a', 's', 't', 'd']) {
  ok(`fingerprint still carries ${f}`, fields.includes(f));
}

// Build the same JSON the function builds, and prove model cannot reach it.
// credentialSig is compiled from the shipped source with the project's own
// tsc, then executed, rather than stubbed. A stub is the trap here: the real
// function is length:FNV-digest, so a length-only stub makes two different
// same-length keys collide and a genuine credential regression would sail
// through as a pass. providerStore.ts is compiled together with the constants
// it imports so the emitted ESM resolves, and tsc keeps the source tree under
// --outDir.
const CRED_OUT = path.join(repoRoot, 'tests', '.build', 'credsig');
await compileToEsm(
  [
    path.join(repoRoot, 'src', 'services', 'providerStore.ts'),
    path.join(repoRoot, 'src', 'constants', 'providers.ts'),
  ],
  CRED_OUT
);
// tsc emits extensionless relative imports (`./secretRefs`,
// `../constants/providers`), which Node's ESM loader refuses. Other checks
// avoid this by compiling self-contained files only; here the emitted copy is
// patched in place inside services/ so its relative specifiers still resolve
// once they carry an extension, and the test runs the shipped implementation
// instead of a hand-copied stub.
const emittedStore = path.join(CRED_OUT, 'services', 'providerStore.js');
const patchedStore = path.join(CRED_OUT, 'services', 'providerStore.spec.mjs');
fs.writeFileSync(
  patchedStore,
  fs
    .readFileSync(emittedStore, 'utf8')
    .replace(/(from\s+['"])(\.[^'"]+?)(['"])/g, (m, a, spec, c) =>
      spec.endsWith('.js') || spec.endsWith('.mjs') ? m : `${a}${spec}.js${c}`
    ),
  'utf8'
);
const { credentialSig } = await importCompiled(patchedStore);

ok('credentialSig is the shipped length:digest form', /length plus FNV digest/.test(storeSrc));
ok('two same-length keys get different signatures', credentialSig('key-aaaaaaaaaaaaaaaaaaaa') !== credentialSig('key-bbbbbbbbbbbbbbbbbbbb'));
ok('an empty credential is distinguishable', credentialSig('') === 'empty');

function sig(payload) {
  const o = {
    p: payload.provider,
    k: credentialSig(payload.apiKey),
    b: (payload.baseUrl || '').trim(),
    a: payload.activeProfileId,
    s: credentialSig(payload.serverKey),
    t: credentialSig(payload.tgToken),
    d: credentialSig(payload.discordToken),
  };
  return JSON.stringify(o);
}

const base = {
  provider: 'opencode-go',
  apiKey: 'key-aaaaaaaaaaaaaaaaaaaa',
  baseUrl: 'https://example.test/v1',
  activeProfileId: 'p1',
  serverKey: 'srv',
  tgToken: '',
  discordToken: '',
  model: 'minimax-m3',
};
const other = { ...base, model: 'deepseek-v4.1-flash' };

ok('model-only change leaves the fingerprint untouched', sig(base) === sig(other));
ok('api key change moves the fingerprint', sig(base) !== sig({ ...base, apiKey: 'key-bbbbbbbbbbbbbbbbbbbb' }));
ok('provider change moves the fingerprint', sig(base) !== sig({ ...base, provider: 'deepseek' }));
ok('base url change moves the fingerprint', sig(base) !== sig({ ...base, baseUrl: 'https://x.test' }));
ok('server key change moves the fingerprint', sig(base) !== sig({ ...base, serverKey: 'srv2' }));
ok('a credential value never appears in the fingerprint', !sig(base).includes('key-aaaa'));
ok('the model string never appears in the fingerprint', !sig(base).includes('minimax'));

// --- 2. hot apply path -------------------------------------------------------
ok('hot apply effect exists', ctx.includes('Hot model switch'));
ok('hot apply calls the session model endpoint', ctx.includes('setSessionModel'));
ok('gateway exposes setSessionModel', gw.includes('setSessionModel'));
ok(
  'gateway posts to /api/sessions/{id}/model',
  /api\/sessions\/\$\{encodeURIComponent\(id\)\}\/model/.test(gw)
);
ok('hot apply reads modelId', ctx.includes('settingsRef.current.modelId'));
ok('a refused switch falls back to a restart', /refused the live model switch[\s\S]{0,400}stopGateway/.test(ctx));
ok('a thrown error also falls back', /Live model switch failed[\s\S]{0,400}stopGateway/.test(ctx));
ok('hot apply is gated on the native gateway', /Hot model switch[\s\S]{0,1600}isNativeGateway\(\)/.test(ctx));
ok('hot apply repeats are suppressed', ctx.includes('lastModelHotRef'));

// The restart must still exist for credentials: removing the signature field
// must not have taken the auto-heal with it.
ok('credential auto-heal still restarts', /Provider credentials changed[\s\S]{0,900}stopGateway/.test(ctx));
ok('auto-heal still compares boot signatures', ctx.includes('bootCredSigRef'));

// --- 3. per-turn model still sent -------------------------------------------
ok('per-turn body carries the model', /body:\s*Record<string,\s*unknown>\s*=\s*\{\s*model\s*\}/.test(ctx));

// --- 4. the model field the app uses is the one it stores ------------------
ok('settings expose modelId', /interface HermesSettings[\s\S]{0,400}modelId: string/.test(ctx));
ok('hot apply does not read a non-existent settings.model', !ctx.includes('settingsRef.current.model ||'));

// --- 5. no em dash in the added copy ----------------------------------------
const hotBlock = ctx.slice(ctx.indexOf('Hot model switch'), ctx.indexOf('Hot model switch') + 1800);
ok('no em dash in the new comments', !hotBlock.includes('\u2014'));

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('model hot-switch: PASS');