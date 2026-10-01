import { normProvider } from '../constants/providers';

// PROVIDER-02: validation result shape. Every result carries a timestamp so
// callers can expire it; invalidation is fingerprint-based (key/url/provider
// change drops the cached result, never a timer alone).
export interface ProviderValidationResult {
  valid: boolean;
  provider: string;
  models: string[];
  capabilities: string[];
  latencyMs: number;
  validatedAt: number;
  source: 'live';
  error?: string;
}

export interface ProviderValidationInput {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  envVar?: string;
}

export interface ProviderValidationCacheEntry {
  result: ProviderValidationResult;
  fingerprint: string;
}

export const VALIDATION_MAX_AGE_MS = 5 * 60 * 1000;

// Fingerprint covers exactly the fields that invalidate a validation:
// normalized provider id, a key signature, plus baseUrl. Model changes do not
// invalidate. The key itself never enters the string: fingerprints get
// compared, cached and logged, so the credential must stay out of it.
export function validationFingerprint(input: ProviderValidationInput): string {
  const key = (input.apiKey || '').trim();
  return [
    normProvider(input.provider || ''),
    key ? `k${key.length}:${keySignature(key)}` : 'k0',
    (input.baseUrl || '').trim(),
  ].join('|');
}

/** FNV-1a hex digest: identity for change detection only, not a secret. */
function keySignature(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function shouldInvalidateValidation(
  prev: ProviderValidationInput,
  next: ProviderValidationInput
): boolean {
  return validationFingerprint(prev) !== validationFingerprint(next);
}

export function isValidationFresh(result: ProviderValidationResult, maxAgeMs: number = VALIDATION_MAX_AGE_MS): boolean {
  if (!result.valid) return false;
  return Date.now() - result.validatedAt <= maxAgeMs;
}

// Store helper: keep one entry per normalized provider. A stored entry is
// usable only when its fingerprint still matches the current input.
export class ProviderValidationStore {
  private entries = new Map<string, ProviderValidationCacheEntry>();

  set(input: ProviderValidationInput, result: ProviderValidationResult): void {
    this.entries.set(normProvider(input.provider || ''), {
      result,
      fingerprint: validationFingerprint(input),
    });
  }

  get(input: ProviderValidationInput): ProviderValidationResult | null {
    const entry = this.entries.get(normProvider(input.provider || ''));
    if (!entry) return null;
    if (entry.fingerprint !== validationFingerprint(input)) {
      this.entries.delete(normProvider(input.provider || ''));
      return null;
    }
    return entry.result;
  }

  clear(provider?: string): void {
    if (provider) this.entries.delete(normProvider(provider));
    else this.entries.clear();
  }
}

export interface ValidateDeps {
  gatewayBaseUrl: string;
  serverKey: () => string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

// Live validation against the gateway (single source of truth):
// POST /api/providers/validate returns {valid,...}; models come from
// GET /api/model/options. Returns null only when the gateway is unreachable
// (caller falls back to the static offline catalog, never a cached valid).
export async function validateProvider(
  input: ProviderValidationInput,
  deps: ValidateDeps,
  callerSignal?: AbortSignal
): Promise<ProviderValidationResult | null> {
  const started = Date.now();
  const provider = normProvider(input.provider || '');
  const fetchFn = deps.fetchFn || fetch;
  const timeoutMs = deps.timeoutMs || 15000;
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sk = deps.serverKey();
  if (sk) headers['Authorization'] = `Bearer ${sk}`;

  try {
    const res = await fetchFn(`${deps.gatewayBaseUrl.replace(/\/+$/, '')}/api/providers/validate`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        provider,
        key: input.apiKey,
        env_var: input.envVar || '',
        base_url: input.baseUrl || undefined,
        model: input.model || undefined,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const latencyMs = Date.now() - started;
    const models: string[] = Array.isArray(data.models) ? data.models.filter((m: unknown) => typeof m === 'string') : [];
    const capabilities: string[] = Array.isArray(data.capabilities)
      ? data.capabilities.filter((c: unknown) => typeof c === 'string')
      : [];
    return {
      valid: Boolean(data.valid),
      provider,
      models,
      capabilities,
      latencyMs,
      validatedAt: Date.now(),
      source: 'live',
      error: typeof data.error === 'string' && data.error ? data.error : undefined,
    };
  } catch {
    return null;
  }
}

// PROVIDER-04: server key policy. Keys are strong random 256-bit values,
// base64url-encoded, generated with crypto.getRandomValues. Never a generic
// text field default, never hardcoded, never derived from user input.
export const SERVER_KEY_BYTES = 32;
export const SERVER_KEY_MIN_LENGTH = 43;

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateServerKey(): string {
  const g = globalThis.crypto;
  if (!g || typeof g.getRandomValues !== 'function') {
    throw new Error('Secure random source unavailable: crypto.getRandomValues is required');
  }
  const bytes = new Uint8Array(SERVER_KEY_BYTES);
  g.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface ServerKeyRotation {
  previous: string;
  next: string;
  rotatedAt: number;
}

// Rotate: mint a fresh key, keep the previous only in memory until the
// gateway acks the new one, then drop it. Caller must not persist next
// until canSaveServerKey(nativeAck=true, healthOk=true).
export function rotateServerKey(previous: string): ServerKeyRotation {
  return { previous, next: generateServerKey(), rotatedAt: Date.now() };
}

export function isServerKeyStrong(key: string): boolean {
  if (key.length < SERVER_KEY_MIN_LENGTH) return false;
  return /^[A-Za-z0-9\-_]+$/.test(key);
}

// PROVIDER-05: save gate. Persist a server key only after BOTH hold:
// 1) native plugin acked the key write, 2) an authenticated health probe
// (/health with the new key) succeeded. Otherwise show failure and keep old.
export interface ServerKeySaveGate {
  nativeAck: boolean;
  authenticatedHealthOk: boolean;
}

export function canSaveServerKey(gate: ServerKeySaveGate): boolean {
  return gate.nativeAck === true && gate.authenticatedHealthOk === true;
}

export function serverKeySaveError(gate: ServerKeySaveGate): string | null {
  if (canSaveServerKey(gate)) return null;
  if (!gate.nativeAck) return 'Server key not saved: native gateway did not acknowledge the key.';
  return 'Server key not saved: authenticated health check failed with the new key.';
}

// FORBIDDEN FILES ARE NOT TOUCHED (nativeGateway.ts, HermesGatewayPlugin.kt,
// HermesContext.tsx, wizard/settings UI). Integrators follow these exact specs.
export interface IntegrationSpec {
  file: string;
  steps: string[];
}

export const PROVIDER_INTEGRATION_SPECS: IntegrationSpec[] = [
  {
    file: 'src/context/HermesContext.tsx',
    steps: [
      'Model catalog: call GET /api/model/options first (live). Use resolveModelsLiveFirst(live, provider) from constants/providers; static DEFAULT_MODELS is fallback only.',
      'Validation: call validateProvider() from services/providerValidation; cache via ProviderValidationStore; drop entry when shouldInvalidateValidation(prev, next) is true (key/url/provider change).',
      'Server key boot sync: after nativeServerKey() returns k, run authenticated GET /health with k before updateSettings({serverKey:k}); on failure keep old key and surface failure.',
    ],
  },
  {
    file: 'src/components/wizard/OnboardingWizard.tsx + src/components/tabs/SettingsTab.tsx',
    steps: [
      'Provider test button: call validateProvider({provider, apiKey, baseUrl, model}); show result.valid plus latencyMs and validatedAt; store result in ProviderValidationStore.',
      'Server key field: add Generate and Rotate buttons calling generateServerKey()/rotateServerKey(); add temporary Reveal (auto-hide 15s, never persist revealed flag).',
      'Server key Save: enable only when isServerKeyStrong(key); on save require canSaveServerKey({nativeAck, authenticatedHealthOk}); else show serverKeySaveError() and keep the previous key.',
    ],
  },
  {
    file: 'android native (HermesGatewayPlugin.kt via T5 owner)',
    steps: [
      'Expose serverKey write with an ack result; expose authenticated /health probe; do not change the plugin API shape from this task.',
    ],
  },
];
