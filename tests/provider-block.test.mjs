// Check: provider-refusal classification, executed against shipped source.
//
// The four known refusal causes (missing subscription, workspace region,
// spent quota, rejected key) are account settings on the provider's website,
// not code problems. The upstream wording is written for a web dashboard
// ("Select Global in your workspace's Privacy settings"), which a phone user
// cannot act on, so today the raw sentence surfaces verbatim. This pins the
// mapping to plain cause+action copy, and pins the two properties that keep it
// honest: an unrecognised refusal is NEVER diagnosed, and ordinary prose is
// never mistaken for a refusal.
//
// The refusal strings below are the exact ones the provider returned on the
// device (errors.log, 2026-10-05), copied verbatim. A provider reword must
// fail this check on purpose instead of silently degrading to raw text.
import path from 'node:path';
import { repoRoot, compileToEsm, importCompiled } from './lib/util.mjs';

const SRC = path.join(repoRoot, 'src', 'services', 'providerBlock.ts');
const [emitted] = await compileToEsm([SRC]);
const { classifyProviderBlock, plainProviderFailure, PROVIDER_BLOCK_I18N_KEYS } =
  await importCompiled(emitted);

let pass = 0;
let fail = 0;
function eq(label, got, want) {
  if (got === want) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// --- the exact refusals seen on device (errors.log, 2026-10-05) -----------
const SUBSCRIPTION =
  'Upstream request failed: An active OpenCode Go subscription is required to use Go models.';
const REGION =
  'Upstream request failed: This Go model requires Global regions. Select Global in your workspace\u2019s Privacy settings to use it.';

eq('device subscription wording', classifyProviderBlock(SUBSCRIPTION), 'subscription');
eq('device region wording', classifyProviderBlock(REGION), 'region');
eq(
  'subscription maps to its key',
  plainProviderFailure(SUBSCRIPTION, (k) => k),
  PROVIDER_BLOCK_I18N_KEYS.subscription
);
eq('region maps to its key', plainProviderFailure(REGION, (k) => k), PROVIDER_BLOCK_I18N_KEYS.region);

// --- other wordings of the same four causes --------------------------------
eq('plan required', classifyProviderBlock('a paid plan is required for this model'), 'subscription');
eq('subscription expired', classifyProviderBlock('Your subscription expired'), 'subscription');
eq('not allowed in region', classifyProviderBlock('model is not available in your region'), 'region');
eq('geoblocked', classifyProviderBlock('request geoblocked'), 'region');
eq('quota exceeded', classifyProviderBlock('monthly quota exceeded'), 'quota');
eq('out of credits', classifyProviderBlock('You are out of credits'), 'quota');
eq('insufficient funds', classifyProviderBlock('insufficient funds on this account'), 'quota');
eq('invalid key', classifyProviderBlock('invalid API key provided'), 'auth');
eq('revoked key', classifyProviderBlock('this key was revoked'), 'auth');

// --- honesty: never invent a diagnosis -------------------------------------
// An unknown refusal keeps the caller's existing behaviour (null) rather than
// being labelled as one of the four known causes.
eq('unknown refusal not diagnosed (1)', classifyProviderBlock('upstream exploded, retry later'), null);
eq('unknown refusal not diagnosed (2)', classifyProviderBlock('model is overloaded right now'), null);
eq('unknown refusal not diagnosed (3)', classifyProviderBlock('the request was malformed by the caller'), null);
eq('empty input', classifyProviderBlock(''), null);
eq('null input', classifyProviderBlock(null), null);
eq('undefined input', classifyProviderBlock(undefined), null);
eq('plain refusal returns null', plainProviderFailure('upstream exploded'), null);

// --- honesty: ordinary prose is not a refusal -------------------------------
eq('benign: hello', classifyProviderBlock('hello there'), null);
eq('benign: answer text', classifyProviderBlock('The answer is 42 because...'), null);
eq(
  'benign: mentions region casually',
  classifyProviderBlock('the region where you live determines the timezone'),
  null
);
eq('benign: mentions key casually', classifyProviderBlock('press the home key to go back'), null);
eq('benign: mentions quota casually', classifyProviderBlock('the memory quota of the agent'), null);

// --- every classified kind produces a distinct, non-empty i18n key ---------
const kinds = ['subscription', 'region', 'quota', 'auth'];
const keys = kinds.map((k) => PROVIDER_BLOCK_I18N_KEYS[k]);
eq('four kinds have keys', keys.every(Boolean), true);
eq('four distinct keys', new Set(keys).size, 4);

// --- fallback copy is actionable and free of dashboard jargon ---------------
// "provider workspace region" is the user's own account setting and stays.
// What must not survive is the upstream instruction to open a specific
// dashboard page ("Select Global in your workspace's Privacy settings"),
// which is written for a web console and tells a phone user nothing.
const fallbackEn = (raw) => plainProviderFailure(raw, (_k, f) => f);
for (const raw of [SUBSCRIPTION, REGION, 'monthly quota exceeded', 'invalid API key provided']) {
  const line = fallbackEn(raw);
  eq('fallback is non-empty', line.length > 0, true);
  eq('fallback drops the dashboard instruction', /privacy settings|select global|go models/i.test(line), false);
  eq('fallback names an action', /settings|provider account|try again|top up/i.test(line), true);
}

console.log(`provider-block: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);