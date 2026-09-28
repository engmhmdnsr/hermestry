// secretRefs.ts
// Secret-reference scheme for provider credentials.
//
// Target model:
// - AppSettings (persisted, non-secret): provider metadata only, never keys.
// - ProviderProfile: carries `secretRef` (a vault-map key), never plaintext.
// - RuntimeState: in-memory only, resolves secretRef -> key for gateway calls.
// - Vault payload: Record<string,string> secrets ONLY. The provider list is
//   never written into the vault envelope.
//
// A secretRef IS the vault-map key, so no lookup table is needed:
// - provider key:  "provider.<profileId>.apiKey"
// - global secret: "global.serverKey" | "global.tgToken" |
//                  "global.discordToken" | "global.appLockPin"

export const PROVIDER_SECRET_PREFIX = 'provider.';
export const PROVIDER_SECRET_SUFFIX = '.apiKey';
export const GLOBAL_SECRET_PREFIX = 'global.';

export const GLOBAL_SECRET_KEYS = {
  serverKey: 'global.serverKey',
  tgToken: 'global.tgToken',
  discordToken: 'global.discordToken',
  appLockPin: 'global.appLockPin',
} as const;

export type GlobalSecretName = keyof typeof GLOBAL_SECRET_KEYS;

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Vault-map key holding the API key for a provider profile id. */
export function secretRefForProfile(profileId: string): string {
  const safe = PROFILE_ID_RE.test(profileId) ? profileId : 'unknown';
  return `${PROVIDER_SECRET_PREFIX}${safe}${PROVIDER_SECRET_SUFFIX}`;
}

/** True when the value is a well-formed provider secretRef. */
export function isProviderSecretRef(ref: string | undefined | null): boolean {
  if (!ref || typeof ref !== 'string') return false;
  if (!ref.startsWith(PROVIDER_SECRET_PREFIX)) return false;
  if (!ref.endsWith(PROVIDER_SECRET_SUFFIX)) return false;
  const id = ref.slice(PROVIDER_SECRET_PREFIX.length, -PROVIDER_SECRET_SUFFIX.length);
  return PROFILE_ID_RE.test(id);
}

/** True when the value is a known global secret key. */
export function isGlobalSecretKey(key: string | undefined | null): boolean {
  if (!key || typeof key !== 'string') return false;
  return (Object.values(GLOBAL_SECRET_KEYS) as string[]).includes(key);
}

/** True for any vault-map secret key (provider or global). */
export function isVaultSecretKey(key: string | undefined | null): boolean {
  if (!key || typeof key !== 'string') return false;
  return isProviderSecretRef(key) || isGlobalSecretKey(key);
}

/** True when a credential value actually holds a secret (non-blank). */
export function hasSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Redact a secret for logs. Returns '' for empty, '[set]' otherwise. */
export function redactSecret(value: string | undefined | null): string {
  return hasSecret(value) ? '[set]' : '';
}

// Plaintext fields that must never be persisted to localStorage.
const SETTINGS_SECRET_FIELDS = [
  'apiKey',
  'serverKey',
  'tgToken',
  'discordToken',
  'appLockPin',
] as const;

/**
 * Return a copy of a settings-like object with every secret field blanked
 * and every provider entry stripped down to its secretRef (no apiKey).
 * Safe to JSON.stringify into localStorage.
 */
export function sanitizeSettingsForPersist<T extends Record<string, unknown>>(settings: T): T {
  const pub: Record<string, unknown> = { ...settings };
  for (const field of SETTINGS_SECRET_FIELDS) {
    if (field in pub) pub[field] = '';
  }
  if (Array.isArray(pub.providers)) {
    pub.providers = (pub.providers as Array<Record<string, unknown>>).map((p) => {
      const clean: Record<string, unknown> = { ...p };
      delete clean.apiKey;
      return clean;
    });
  }
  return pub as T;
}

/**
 * Strip a single provider-like object to its persistable shape
 * (secretRef only, no plaintext key material).
 */
export function sanitizeProviderForPersist<T extends Record<string, unknown>>(provider: T): T {
  const clean: Record<string, unknown> = { ...provider };
  delete clean.apiKey;
  return clean as T;
}
