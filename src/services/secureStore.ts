// secureStore.ts
// At-rest encryption for app secrets using WebCrypto only.
// Key derivation: PBKDF2 (SHA-256, 600k iterations, random 16 byte salt)
// Cipher: AES-GCM-256 with a random 12 byte IV per encryption.
// The salt, IV and ciphertext travel together as a base64 JSON envelope.

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SALT_STORAGE_KEY = "hermes.vault.salt";
const VERIFIER_STORAGE_KEY = "hermes.vault.verifier";
// Known plaintext used to check a PIN on unlock. GCM auth tag failure
// means the PIN was wrong, so no comparison step is needed.
const VERIFIER_PLAINTEXT = "hermes-vault-ok";

interface VaultEnvelope {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

let sessionKey: CryptoKey | null = null;
let sessionSalt: Uint8Array | null = null;

// Hard purge: the WebCrypto key outlives every state blanking unless this
// runs. Call on lock and on any failed unlock/decrypt.
export function purgeSessionKey(): void {
  sessionKey = null;
  sessionSalt = null;
}

// Staged PIN rotation: derive under a fresh salt and swap the session key
// WITHOUT committing salt/verifier yet, so the cipher can be re-encrypted
// first. commitVaultRotation() lands salt+verifier only after the new cipher
// saved; rollbackVaultRotation() restores the old key when the save fails.
// Committing first (the old lockVault order) bricks the vault whenever the
// cipher write fails afterwards.
let stagedRotation: {
  salt: Uint8Array;
  key: CryptoKey;
  verifier: string;
  prevKey: CryptoKey | null;
  prevSalt: Uint8Array | null;
} | null = null;

export async function stageVaultRotation(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(pin, salt);
  const verifier = await encryptWithKey(key, salt, VERIFIER_PLAINTEXT);
  stagedRotation = { salt, key, verifier, prevKey: sessionKey, prevSalt: sessionSalt };
  sessionKey = key;
  sessionSalt = salt;
}

export function commitVaultRotation(): void {
  if (!stagedRotation) return;
  try {
    localStorage.setItem(SALT_STORAGE_KEY, bytesToBase64(stagedRotation.salt));
    localStorage.setItem(VERIFIER_STORAGE_KEY, stagedRotation.verifier);
  } catch {
    rollbackVaultRotation();
    throw new Error("Vault storage is unavailable");
  }
  stagedRotation = null;
}

export function rollbackVaultRotation(): void {
  if (!stagedRotation) return;
  sessionKey = stagedRotation.prevKey;
  sessionSalt = stagedRotation.prevSalt;
  stagedRotation = null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptWithKey(
  key: CryptoKey,
  salt: Uint8Array,
  plaintext: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  );
  const envelope: VaultEnvelope = {
    v: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipherBuf)),
  };
  return btoa(JSON.stringify(envelope));
}

async function decryptWithKey(key: CryptoKey, raw: string): Promise<string> {
  let envelope: VaultEnvelope;
  try {
    envelope = JSON.parse(atob(raw)) as VaultEnvelope;
  } catch {
    throw new Error("Malformed vault envelope");
  }
  if (
    !envelope ||
    envelope.v !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.data !== "string" ||
    typeof envelope.salt !== "string"
  ) {
    throw new Error("Malformed vault envelope");
  }
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) as BufferSource },
    key,
    base64ToBytes(envelope.data) as BufferSource
  );
  return new TextDecoder().decode(plainBuf);
}

function loadStoredSalt(): Uint8Array | null {
  try {
    const b64 = localStorage.getItem(SALT_STORAGE_KEY);
    return b64 ? base64ToBytes(b64) : null;
  } catch {
    return null;
  }
}

// Set (or reset) the vault PIN. Generates a fresh salt, derives the
// session key, and stores a verifier envelope so unlockVault can check
// the PIN later. Leaves the vault unlocked for this session.
export async function lockVault(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(pin, salt);
  const verifier = await encryptWithKey(key, salt, VERIFIER_PLAINTEXT);
  try {
    localStorage.setItem(SALT_STORAGE_KEY, bytesToBase64(salt));
    localStorage.setItem(VERIFIER_STORAGE_KEY, verifier);
  } catch {
    throw new Error("Vault storage is unavailable");
  }
  sessionSalt = salt;
  sessionKey = key;
}

// Try to unlock with a PIN. Returns false on a wrong PIN (GCM auth tag
// failure) without throwing. Returns false when no vault exists yet.
export async function unlockVault(pin: string): Promise<boolean> {
  const salt = loadStoredSalt();
  let verifier: string | null = null;
  try {
    verifier = localStorage.getItem(VERIFIER_STORAGE_KEY);
  } catch {
    verifier = null;
  }
  if (!salt || !verifier) {
    return false;
  }
  const key = await deriveKey(pin, salt);
  try {
    const check = await decryptWithKey(key, verifier);
    if (check !== VERIFIER_PLAINTEXT) {
      return false;
    }
  } catch {
    // Wrong PIN or tampered verifier: auth tag check failed.
    return false;
  }
  sessionSalt = salt;
  sessionKey = key;
  return true;
}

export function vaultLocked(): boolean {
  return sessionKey === null;
}

// Encrypt a string map into a self contained base64 JSON envelope.
// Throws when the vault is locked.
export async function vaultEncryptSecrets(
  obj: Record<string, string>
): Promise<string> {
  if (!sessionKey || !sessionSalt) {
    throw new Error("Vault is locked");
  }
  return encryptWithKey(sessionKey, sessionSalt, JSON.stringify(obj));
}

// Decrypt an envelope produced by vaultEncryptSecrets.
// Throws when the vault is locked, the envelope is malformed, or the
// auth tag does not verify.
export async function vaultDecryptSecrets(
  cipher: string
): Promise<Record<string, string>> {
  if (!sessionKey) {
    throw new Error("Vault is locked");
  }
  const plain = await decryptWithKey(sessionKey, cipher);
  const parsed: unknown = JSON.parse(plain);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Malformed vault payload");
  }
  return parsed as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret separation (SEC-02): the vault payload holds ONLY secrets as a
// flat Record<string,string> and NEVER the provider list or any metadata.
// Provider keys live under "provider.<profileId>.apiKey"; global secrets
// (serverKey, tgToken, discordToken, appLockPin) under "global.<name>".
// Plaintext settings (localStorage hermes_settings) carry secretRef values
// only. Use sanitizeForPersist() before writing settings to localStorage.
// ---------------------------------------------------------------------------

/** Storage keys owned by the vault layer. No provider list here by design. */
export const VAULT_CIPHER_KEY = "hermes_vault";
export const SETTINGS_PLAINTEXT_KEY = "hermes_settings";

/** Vault-map keys for global (non-provider) secrets. */
export const VAULT_GLOBAL_KEYS = {
  serverKey: "global.serverKey",
  tgToken: "global.tgToken",
  discordToken: "global.discordToken",
  appLockPin: "global.appLockPin",
} as const;

const PROVIDER_KEY_RE = /^provider\.[A-Za-z0-9_-]{1,64}\.apiKey$/;

/** True for any key allowed inside the vault payload. */
export function isVaultPayloadKey(key: string): boolean {
  if (PROVIDER_KEY_RE.test(key)) return true;
  return (Object.values(VAULT_GLOBAL_KEYS) as string[]).includes(key);
}

/**
 * Drop anything that is not a string secret under an allowed key.
 * Guards the encrypt path so metadata (e.g. a provider list) can never
 * be sealed into the vault envelope.
 */
export function sanitizeVaultPayload(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string") continue;
    if (k.startsWith("provider.") && PROVIDER_KEY_RE.test(k)) out[k] = v;
    else if ((Object.values(VAULT_GLOBAL_KEYS) as string[]).includes(k)) out[k] = v;
  }
  return out;
}

const SETTINGS_SECRET_FIELDS = ["apiKey", "serverKey", "tgToken", "discordToken", "appLockPin"];

/**
 * Return a persistable copy of a settings-like object: secret fields
 * blanked, provider entries reduced to secretRef (no apiKey), provider
 * list itself preserved (it is metadata and lives in plaintext).
 */
export function sanitizeForPersist<T extends Record<string, unknown>>(settings: T): T {
  const pub: Record<string, unknown> = { ...settings };
  for (const field of SETTINGS_SECRET_FIELDS) {
    if (field in pub) pub[field] = "";
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

export interface LegacySettingsMigration {
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

/**
 * One-time migration for legacy hermes_settings payloads: pulls flat
 * secrets (apiKey/serverKey/tgToken/discordToken/appLockPin) and per
 * provider apiKey entries into a vault secrets map, rewrites providers
 * to secretRef entries, and returns sanitized settings. Never writes
 * to storage itself; the caller seals `secrets` with vaultEncryptSecrets
 * and persists `settings` with sanitizeForPersist applied.
 */
export function migrateLegacySettings(settings: Record<string, unknown>): LegacySettingsMigration {
  const secrets: Record<string, string> = {};
  const next: Record<string, unknown> = { ...settings };

  const takeGlobal = (field: string, vaultKey: string) => {
    const v = next[field];
    if (typeof v === "string" && v.trim()) secrets[vaultKey] = v;
    next[field] = "";
  };
  takeGlobal("serverKey", VAULT_GLOBAL_KEYS.serverKey);
  takeGlobal("tgToken", VAULT_GLOBAL_KEYS.tgToken);
  takeGlobal("discordToken", VAULT_GLOBAL_KEYS.discordToken);
  takeGlobal("appLockPin", VAULT_GLOBAL_KEYS.appLockPin);
  // Legacy flat provider/key pair folds into a provider entry below.
  const flatProvider = typeof next.provider === "string" ? (next.provider as string) : "";
  const flatKey = typeof next.apiKey === "string" ? (next.apiKey as string) : "";
  const flatModel = typeof next.modelId === "string" ? (next.modelId as string) : "";
  const flatBase = typeof next.baseUrl === "string" ? (next.baseUrl as string) : "";
  next.apiKey = "";

  if (Array.isArray(next.providers)) {
    next.providers = (next.providers as Array<Record<string, unknown>>).map((p, index) => {
      const clean: Record<string, unknown> = { ...p };
      const id =
        (typeof clean.id === "string" && clean.id.trim()) ||
        `prov_${String(clean.provider || "custom")}_legacy_${index}`;
      clean.id = id;
      const ref = `provider.${id}.apiKey`;
      clean.secretRef = ref;
      const key = clean.apiKey;
      if (typeof key === "string" && key.trim()) secrets[ref] = key;
      delete clean.apiKey;
      return clean;
    });
  }
  if (flatProvider || flatKey) {
    const list = Array.isArray(next.providers) ? [...(next.providers as Array<Record<string, unknown>>)] : [];
    const slug = flatProvider.trim() || "custom";
    const id = `prov_${slug}`;
    const ref = `provider.${id}.apiKey`;
    if (!list.some((p) => p.id === id)) {
      list.push({
        id,
        provider: slug,
        name: slug.toUpperCase(),
        secretRef: ref,
        baseUrl: flatBase,
        defaultModel: flatModel,
        enabled: true,
        validated: true,
      });
    }
    if (flatKey.trim()) secrets[ref] = flatKey;
    next.providers = list;
  }
  return { settings: sanitizeForPersist(next), secrets: sanitizeVaultPayload(secrets) };
}
