// Provider refusal classification.
//
// A provider (or its billing backend) can refuse a turn for reasons that are
// account settings, not code problems: a missing subscription, a workspace
// pinned to the wrong region, an exhausted allowance. The upstream message
// says all of that, but it is written for a web dashboard: "Select Global in
// your workspace's Privacy settings". A phone user cannot act on that, so
// today the raw sentence surfaces verbatim and the user has no idea the fix
// lives in the provider's own website.
//
// plainProviderFailure() turns the known refusals into one cause+action line
// per locale, and for anything it does not recognise it returns null so the
// caller keeps whatever it does today. It never invents a diagnosis: an
// unrecognised refusal falls through unchanged rather than being labelled.

export type ProviderBlockKind = 'subscription' | 'region' | 'quota' | 'auth';

/** Detect a known provider refusal. Returns null for anything unrecognised. */
export function classifyProviderBlock(raw: string | null | undefined): ProviderBlockKind | null {
  const s = (raw || '').trim();
  if (!s) return null;

  // Subscription: the account has no active plan for this model family.
  if (/\b(?:an\s+)?active\s+(?:opencode\s+go\s+)?subscription\b/i.test(s)) return 'subscription';
  if (/\bsubscription\s+(?:is\s+)?(?:required|expired|inactive|not\s+(?:active|found))\b/i.test(s))
    return 'subscription';
  // Covers both "requires a plan" and "a plan is required for this model".
  if (/\b(?:plan|subscription)\s+(?:is|are)\s+required\b/i.test(s)) return 'subscription';
  if (/\b(?:requires?|needs?)\s+(?:an?\s+)?(?:active\s+)?(?:paid\s+)?(?:plan|subscription)\b/i.test(s))
    return 'subscription';

  // Region: the workspace is pinned to a data region that cannot serve the
  // requested model. The action is in the provider dashboard, not the app.
  if (/\bregions?\b/i.test(s) && /\b(?:global|requires?|select|privacy|setting|workspace)\b/i.test(s))
    return 'region';
  if (/\bnot\s+(?:available|enabled|permitted|allowed)\s+in\s+(?:this|your)\s+(?:region|workspace)\b/i.test(s))
    return 'region';
  if (/\bgeo(?:graphy|graphic)?\s*(?:block|restrict|unavailable)/i.test(s)) return 'region';

  // Quota: the allowance is spent, which is a billing state, not a bad key.
  if (/\b(?:quota|credit(?:s)?|balance|allowance)\s+(?:exceeded|depleted|exhausted|insufficient|ran\s+out)\b/i.test(s))
    return 'quota';
  if (/\binsufficient\s+(?:funds|credits?|balance|quota)\b/i.test(s)) return 'quota';
  if (/\bexceeded\s+your\s+current\s+(?:quota|limit|usage)\b/i.test(s)) return 'quota';
  if (/\b(?:out\s+of|ran\s+out\s+of)\s+(?:credits?|balance|funds|quota)\b/i.test(s)) return 'quota';
  if (/\bbilling\b/i.test(s) && /\b(?:fail|invalid|required|declin|error)/i.test(s)) return 'quota';

  // Auth: a key the provider will not accept. Distinct from quota because the
  // fix is a different screen (the key field) rather than the billing page.
  if (/\b(?:invalid|incorrect|revoked|expired|unknown|malformed)\s+(?:api\s*)?key\b/i.test(s))
    return 'auth';
  if (/\bkey\s+(?:was\s+)?(?:revoked|invalid|expired|rejected|disabled)\b/i.test(s)) return 'auth';
  if (/\b(?:401|403)\b/.test(s) && /\bkey\b/i.test(s)) return 'auth';

  return null;
}

// Fallbacks are plain cause+action English with no provider brand and no
// dashboard jargon, so a user who never visits the provider site still knows
// what to do next. Kept in step with the err* keys in constants/languages.
const FALLBACKS: Record<ProviderBlockKind, { key: string; en: string }> = {
  subscription: {
    key: 'errProviderSubscription',
    en: 'Your model provider needs an active subscription for this model. Check the provider account, then try again.',
  },
  region: {
    key: 'errProviderRegion',
    en: 'This model is not available in your provider workspace region. Change the region in the provider account, then try again.',
  },
  quota: {
    key: 'errProviderQuota',
    en: 'Your model provider ran out of credits or allowance. Top up the provider account, then try again.',
  },
  auth: {
    key: 'errProviderKeyRejected',
    en: 'The provider rejected the API key. Add or fix it under Settings.',
  },
};

/**
 * Map a known provider refusal to plain localized copy.
 * Returns null when the text is not a recognised refusal, so the caller can
 * fall back to its existing behaviour instead of losing the message.
 */
export function plainProviderFailure(
  raw: string | null | undefined,
  tx: (key: string, fallback: string) => string = (_k, f) => f
): string | null {
  const kind = classifyProviderBlock(raw);
  if (!kind) return null;
  const f = FALLBACKS[kind];
  return tx(f.key, f.en);
}

/** Exposed for tests: the i18n key each refusal maps to. */
export const PROVIDER_BLOCK_I18N_KEYS: Record<ProviderBlockKind, string> = {
  subscription: FALLBACKS.subscription.key,
  region: FALLBACKS.region.key,
  quota: FALLBACKS.quota.key,
  auth: FALLBACKS.auth.key,
};