// providerStore.ts
// Provider CRUD with secret separation.
//
// A ProviderProfile carries `secretRef` (a vault-map key) and NEVER a
// plaintext apiKey. The actual key lives in a secrets map
// (Record<string,string>) that the caller persists through the encrypted
// vault (secureStore) and keeps decrypted only in memory.
//
// SINGLE CREDENTIAL WRITE PATH: every write of a provider key funnels
// through writeProviderCredential(). Nothing else in this module mutates
// the secrets map. Non-key edits (name, model, baseUrl, enabled) never
// touch secrets; key edits never duplicate into global settings. This
// fixes the PROVIDER-03 split-brain where providers[] and the global
// apiKey were updated separately.

import { keysValid, normProvider } from '../constants/providers';
import {
  hasSecret,
  isProviderSecretRef,
  secretRefForProfile,
} from './secretRefs';

/** Persistable provider profile. No plaintext key material. */
export interface ProviderProfile {
  id: string;
  provider: string;
  name: string;
  secretRef?: string;
  baseUrl?: string;
  defaultModel: string;
  enabled: boolean;
  validated?: boolean;
}

export interface ProviderCreateInput {
  provider: string;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  enabled?: boolean;
  validated?: boolean;
}

export interface ProviderPatch {
  provider?: string;
  name?: string;
  /** undefined = leave stored key untouched; '' = erase it. */
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  enabled?: boolean;
  validated?: boolean;
}

export interface ProviderStoreResult {
  list: ProviderProfile[];
  secrets: Record<string, string>;
}

let idCounter = 0;

function newProfileId(providerSlug: string): string {
  idCounter += 1;
  const slug = (providerSlug || 'custom').replace(/[^A-Za-z0-9_-]/g, '') || 'custom';
  try {
    const uuid =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : null;
    if (uuid) return `prov_${slug}_${uuid.slice(0, 8)}`;
  } catch {
    // fall through to counter fallback
  }
  return `prov_${slug}_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * THE single credential write path. Trims the key; a blank key erases the
 * vault entry instead of storing an empty string. Returns the (possibly
 * new) secrets map; never mutates its input.
 */
export function writeProviderCredential(
  secrets: Record<string, string>,
  secretRef: string,
  apiKey: string | undefined | null
): Record<string, string> {
  const next = { ...secrets };
  if (apiKey === undefined || apiKey === null) return next;
  const cleaned = apiKey.trim().replace(/[\r\n]+/g, '');
  if (!cleaned) {
    delete next[secretRef];
  } else {
    next[secretRef] = cleaned;
  }
  return next;
}

/** Read path: resolve a profile's live key from the in-memory secrets map. */
export function resolveProviderKey(
  profile: Pick<ProviderProfile, 'secretRef'> | undefined | null,
  secrets: Record<string, string>
): string {
  if (!profile || !isProviderSecretRef(profile.secretRef)) return '';
  return secrets[profile.secretRef as string] || '';
}

/** True when the profile has a usable stored key (or is keyless). */
export function providerHasCredential(
  profile: ProviderProfile,
  secrets: Record<string, string>,
  baseUrl?: string
): boolean {
  return keysValid(profile.provider, resolveProviderKey(profile, secrets), baseUrl ?? profile.baseUrl ?? '');
}

/**
 * Fingerprint of a provider profile and its current credential state.
 * Changes on key rotation, provider switch, or profile edits.
 */
export function providerProfileFingerprint(
  profile: ProviderProfile,
  secrets: Record<string, string>
): string {
  const key = resolveProviderKey(profile, secrets);
  return `${profile.id}:${normProvider(profile.provider)}:${profile.enabled !== false}:${profile.defaultModel || ''}:${(profile.baseUrl || '').trim()}:${key ? 'has_key:' + key.length : 'no_key'}:${key}`;
}

function ensureSecretRef(profile: ProviderProfile): ProviderProfile {
  if (isProviderSecretRef(profile.secretRef)) return profile;
  return { ...profile, secretRef: secretRefForProfile(profile.id) };
}

/** Add a provider. The key (if any) is written via writeProviderCredential. */
export function createProvider(
  list: ProviderProfile[],
  input: ProviderCreateInput,
  secrets: Record<string, string>
): ProviderStoreResult & { id: string } {
  const slug = normProvider((input.provider || '').trim()) || 'custom';
  const id = newProfileId(slug);
  const ref = secretRefForProfile(id);
  const profile: ProviderProfile = {
    id,
    provider: slug,
    name: input.name.trim() || slug.toUpperCase(),
    secretRef: ref,
    baseUrl: (input.baseUrl || '').trim(),
    defaultModel: (input.defaultModel || '').trim(),
    enabled: input.enabled !== false,
    validated: input.validated,
  };
  return {
    list: [...list, profile],
    secrets: writeProviderCredential(secrets, ref, input.apiKey ?? ''),
    id,
  };
}

/**
 * Update a provider. Key updates go through writeProviderCredential;
 * omitting apiKey leaves the stored key untouched (no split-brain with
 * any global field; this module never writes global settings).
 */
export function updateProvider(
  list: ProviderProfile[],
  id: string,
  patch: ProviderPatch,
  secrets: Record<string, string>
): ProviderStoreResult {
  let nextSecrets = secrets;
  const nextList = list.map((p) => {
    if (p.id !== id) return p;
    const withRef = ensureSecretRef(p);
    if (patch.apiKey !== undefined) {
      nextSecrets = writeProviderCredential(nextSecrets, withRef.secretRef as string, patch.apiKey);
    }
    const updated: ProviderProfile = { ...withRef };
    if (patch.provider !== undefined) {
      const slug = normProvider(patch.provider.trim()) || withRef.provider;
      updated.provider = slug;
    }
    if (patch.name !== undefined) updated.name = patch.name;
    if (patch.baseUrl !== undefined) updated.baseUrl = patch.baseUrl;
    if (patch.defaultModel !== undefined) updated.defaultModel = patch.defaultModel;
    if (patch.enabled !== undefined) updated.enabled = patch.enabled;
    if (patch.validated !== undefined) updated.validated = patch.validated;
    return updated;
  });
  return { list: nextList, secrets: nextSecrets };
}

/** Remove a provider and erase its vault entry. */
export function removeProvider(
  list: ProviderProfile[],
  id: string,
  secrets: Record<string, string>
): ProviderStoreResult {
  const target = list.find((p) => p.id === id);
  const nextList = list.filter((p) => p.id !== id);
  if (!target || !isProviderSecretRef(target.secretRef)) {
    return { list: nextList, secrets };
  }
  const nextSecrets = { ...secrets };
  delete nextSecrets[target.secretRef as string];
  return { list: nextList, secrets: nextSecrets };
}

export interface ActiveProviderResolution {
  profile: ProviderProfile;
  secretRef: string;
  /** Live key from the in-memory secrets map ('' when locked/absent). */
  apiKey: string;
}

/**
 * Activate (select) a provider. Resolution only: no writes to the list
 * or the secrets map. Callers copy profile.provider/baseUrl/defaultModel
 * into ephemeral runtime state, never into persisted settings.
 */
export function activateProvider(
  list: ProviderProfile[],
  id: string,
  secrets: Record<string, string>
): ActiveProviderResolution | null {
  const slug = normProvider(id);
  const target =
    list.find((p) => p.id === id) ||
    (slug ? list.find((p) => normProvider(p.provider) === slug) : undefined);
  if (!target) return null;
  const withRef = ensureSecretRef(target);
  const ref = withRef.secretRef as string;
  return { profile: withRef, secretRef: ref, apiKey: secrets[ref] || '' };
}

/**
 * Validate a candidate key against the gateway. Returns true (valid),
 * false (rejected), or null (gateway unreachable, unknown). The key is
 * passed through for the check and never stored here; callers persist
 * via createProvider/updateProvider after a true result.
 */
export async function validateProviderKey(
  validateFn: (provider: string, envVar: string, key: string) => Promise<boolean | null>,
  provider: string,
  key: string,
  baseUrl: string
): Promise<boolean | null> {
  const slug = normProvider(provider.trim()) || 'custom';
  const cleaned = key.trim();
  if (!keysValid(slug, cleaned, baseUrl.trim())) return false;
  if (!hasSecret(cleaned)) return true; // keyless provider, nothing to check
  return validateFn(slug, 'HERMES_API_KEY', cleaned);
}

export interface LegacyProviderEntry {
  id?: string;
  provider: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  enabled?: boolean;
  validated?: boolean;
}

/**
 * One-time migration: legacy provider entries carrying plaintext apiKey
 * become secretRef profiles plus vault-map entries. Plaintext never
 * survives in the returned list.
 */
export function migrateLegacyProviders(
  legacy: LegacyProviderEntry[],
  secrets: Record<string, string> = {}
): ProviderStoreResult {
  let nextSecrets = { ...secrets };
  const list: ProviderProfile[] = legacy.map((entry, index) => {
    const slug = normProvider((entry.provider || '').trim()) || 'custom';
    const id = (entry.id || '').trim() || `prov_${slug}_legacy_${index}`;
    const ref = secretRefForProfile(id);
    nextSecrets = writeProviderCredential(nextSecrets, ref, entry.apiKey ?? '');
    return {
      id,
      provider: slug,
      name: (entry.name || '').trim() || slug.toUpperCase(),
      secretRef: ref,
      baseUrl: (entry.baseUrl || '').trim(),
      defaultModel: (entry.defaultModel || '').trim(),
      enabled: entry.enabled !== false,
      validated: entry.validated,
    };
  });
  return { list, secrets: nextSecrets };
}
