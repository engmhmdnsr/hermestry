// vaultTransaction.ts
// Transactional vault writes (SEC-04) plus lock-time purge helpers (SEC-03).
//
// Transactional write protocol:
//   1. prepare   - snapshot the payload in memory (caller-owned object)
//   2. encrypt   - vaultEncryptSecrets(payload) -> cipher
//   3. verify    - vaultDecryptSecrets(cipher), deep-compare to payload
//   4. stage     - write cipher to hermes_vault.tmp
//   5. re-verify - read tmp back, decrypt, compare again
//   6. commit    - atomic swap: hermes_vault = tmp cipher, remove tmp + backup
//
// On ANY failure the previous hermes_vault value is left untouched, tmp is
// removed, and a VaultWriteError is thrown. Callers must only show "Saved"
// after the returned promise resolves.
//
// This module never imports HermesContext (T2-owned). It reads secureStore
// (T2-owned) but does not modify it.

import { vaultDecryptSecrets, vaultEncryptSecrets } from './secureStore';

export const VAULT_KEY = 'hermes_vault';
export const VAULT_TMP_KEY = 'hermes_vault.tmp';
export const VAULT_BACKUP_KEY = 'hermes_vault.bak';

export type SecretMap = Record<string, string>;

export type VaultWriteCode = 'ENCRYPT_FAILED' | 'VERIFY_FAILED' | 'STORAGE_FAILED';

export class VaultWriteError extends Error {
  readonly code: VaultWriteCode;
  constructor(code: VaultWriteCode, message: string) {
    super(message);
    this.name = 'VaultWriteError';
    this.code = code;
  }
}

export interface VaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): VaultStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage as VaultStorage;
  } catch {
    return null;
  }
}

function safeGet(storage: VaultStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw new VaultWriteError('STORAGE_FAILED', `Vault read failed for key "${key}"`);
  }
}

function safeSet(storage: VaultStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    throw new VaultWriteError('STORAGE_FAILED', `Vault write failed for key "${key}"`);
  }
}

function safeRemove(storage: VaultStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Removal failure must not fail the save; tmp leftovers are
    // overwritten on the next attempt and never read as the vault.
  }
}

/** Strict string-map equality used for decrypt round-trip verification. */
export function secretsEqual(a: SecretMap, b: SecretMap): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (String(a[ka[i]]) !== String(b[ka[i]])) return false;
  }
  return true;
}

/**
 * Transactional vault save. Resolves only after the new cipher is committed
 * AND verified readable at its final key. Rejects with VaultWriteError on
 * any failure, leaving the previous vault value intact.
 */
export async function transactionalVaultSave(
  payload: SecretMap,
  storage: VaultStorage | null = defaultStorage(),
): Promise<void> {
  if (!storage) {
    throw new VaultWriteError('STORAGE_FAILED', 'Vault storage is unavailable');
  }
  const previous = safeGet(storage, VAULT_KEY);

  // 1-2. Encrypt. Throws (locked vault, bad key) -> never touch storage.
  let cipher: string;
  try {
    cipher = await vaultEncryptSecrets({ ...payload });
  } catch (e) {
    throw new VaultWriteError(
      'ENCRYPT_FAILED',
      `Vault encrypt failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 3. Verify decrypt round-trip before writing anything.
  try {
    const roundTrip = await vaultDecryptSecrets(cipher);
    if (!secretsEqual(roundTrip, payload)) {
      throw new VaultWriteError('VERIFY_FAILED', 'Vault round-trip mismatch before write');
    }
  } catch (e) {
    if (e instanceof VaultWriteError) throw e;
    throw new VaultWriteError(
      'VERIFY_FAILED',
      `Vault round-trip decrypt failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 4. Backup the old cipher so a failed swap can restore it.
  if (previous !== null) {
    safeSet(storage, VAULT_BACKUP_KEY, previous);
  }

  // 5. Stage to tmp.
  safeSet(storage, VAULT_TMP_KEY, cipher);

  // 6. Re-verify what is actually on disk, not just what is in memory.
  try {
    const staged = safeGet(storage, VAULT_TMP_KEY);
    if (staged !== cipher) {
      throw new Error('tmp read-back differs from staged cipher');
    }
    const recheck = await vaultDecryptSecrets(staged);
    if (!secretsEqual(recheck, payload)) {
      throw new Error('tmp decrypt mismatch');
    }
  } catch (e) {
    safeRemove(storage, VAULT_TMP_KEY);
    if (e instanceof VaultWriteError) throw e;
    throw new VaultWriteError(
      'VERIFY_FAILED',
      `Vault staged-cipher verification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 7. Atomic swap (as atomic as localStorage gets: single setItem).
  try {
    safeSet(storage, VAULT_KEY, cipher);
  } catch (e) {
    try {
      const current = storage.getItem(VAULT_KEY);
      if (current !== previous && previous !== null) {
        storage.setItem(VAULT_KEY, previous);
      }
    } catch {
      // Best effort restore; surface the original failure below.
    }
    safeRemove(storage, VAULT_TMP_KEY);
    if (e instanceof VaultWriteError) throw e;
    throw new VaultWriteError('STORAGE_FAILED', 'Vault commit failed; previous credentials kept');
  }

  safeRemove(storage, VAULT_TMP_KEY);
  safeRemove(storage, VAULT_BACKUP_KEY);
}

/** Read the committed vault cipher without decrypting (for T2 unlock gating). */
export function readVaultCipher(storage: VaultStorage | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(VAULT_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lock-time purge helpers (SEC-03). JS strings are immutable, so "purge"
// means: drop every reference (state, refs, holders) and never write the
// values to localStorage, logs, or the DOM while locked.
// ---------------------------------------------------------------------------

export const TOP_LEVEL_SECRET_KEYS = [
  'apiKey',
  'serverKey',
  'tgToken',
  'discordToken',
  'appLockPin',
] as const;

export type TopLevelSecretKey = (typeof TOP_LEVEL_SECRET_KEYS)[number];

/** Shallow copy with the named secret fields blanked. */
export function blankSecrets<T extends object>(
  obj: T,
  keys: readonly string[] = TOP_LEVEL_SECRET_KEYS,
): T {
  const next = { ...obj } as Record<string, unknown>;
  for (const k of keys) {
    if (k in next) next[k] = '';
  }
  return next as T;
}

export interface ProviderLike {
  apiKey?: string;
  [k: string]: unknown;
}

/** Copy of a providers list with every apiKey blanked. */
export function blankProviderSecrets<T extends ProviderLike>(list: T[]): T[] {
  return list.map((p) => ({ ...p, apiKey: '' }));
}

/** Full public (safe-to-persist) copy of settings: top-level + providers. */
export function publicSettings<T extends { providers?: ProviderLike[] } & object>(settings: T): T {
  const pub = blankSecrets(settings);
  if (Array.isArray(settings.providers)) {
    (pub as { providers?: ProviderLike[] }).providers = blankProviderSecrets(settings.providers);
  }
  return pub;
}

/** Blanked secret holder used when entering the locked state. */
export function blankSecretHolder(): Record<TopLevelSecretKey, string> {
  return { apiKey: '', serverKey: '', tgToken: '', discordToken: '', appLockPin: '' };
}

/** Redact known secret values from a log line. Values shorter than 4 chars are skipped. */
export function scrubSecretsFromText(text: string, secrets: Array<string | null | undefined>): string {
  let safe = text;
  for (const s of secrets) {
    if (s && s.length >= 4 && safe.includes(s)) {
      safe = safe.split(s).join('***REDACTED***');
    }
  }
  return safe;
}

// Registry of in-memory secret holders (context refs, caches). T2 registers
// each holder's clear function; lock-time purge calls purgeAllSecretHolders().
type PurgeFn = () => void;
const holders = new Set<PurgeFn>();

/** Register a holder clear function. Returns an unregister function. */
export function registerSecretHolder(fn: PurgeFn): () => void {
  holders.add(fn);
  return () => {
    holders.delete(fn);
  };
}

/** Run every registered holder clear function. Never throws. */
export function purgeAllSecretHolders(): void {
  for (const fn of Array.from(holders)) {
    try {
      fn();
    } catch {
      // One bad holder must not stop the purge of the rest.
    }
  }
}
