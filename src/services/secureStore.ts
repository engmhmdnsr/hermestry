// secureStore.ts
// At-rest encryption for app secrets using WebCrypto only.
// Key derivation: PBKDF2 (SHA-256, 120k iterations, random 16 byte salt)
// Cipher: AES-GCM-256 with a random 12 byte IV per encryption.
// The salt, IV and ciphertext travel together as a base64 JSON envelope.

const ITERATIONS = 120_000;
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
