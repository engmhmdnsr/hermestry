import type { ConfiguredProvider } from '../types/hermes';

// Versioned settings storage. Every persisted `hermes_settings` payload
// carries a `schemaVersion`; on load, pending migrations run in order.
// Callers must never mutate stored state ad hoc at init: add a migration
// function below and bump CURRENT_SCHEMA_VERSION instead.

export const SETTINGS_KEY = 'hermes_settings';

export const CURRENT_SCHEMA_VERSION = 3;

export const VERIFIED_OPENCODE_GO_MODEL = 'deepseek-v4.1-flash';

type SettingsRecord = Record<string, unknown>;

export type Migration = (parsed: SettingsRecord) => SettingsRecord;

const isProvider = (p: unknown): p is ConfiguredProvider =>
  typeof p === 'object' && p !== null && 'id' in p && 'provider' in p;

const asProviderList = (value: unknown): ConfiguredProvider[] =>
  Array.isArray(value) ? value.filter(isProvider) : [];

// v1 -> v2: fold legacy flat provider/key pairs into the providers list,
// drop the old hardcoded DeepSeek seed (id prov_deepseek_default with no
// key; never user data), and clear a dead active-provider selection.
export const migrateV1toV2: Migration = (parsed) => {
  const next: SettingsRecord = { ...parsed };
  let providers = asProviderList(next.providers);
  if (providers.length === 0) {
    const provider = next.provider;
    const apiKey = next.apiKey;
    if (typeof provider === 'string' && provider && typeof apiKey === 'string' && apiKey) {
      providers = [
        {
          id: 'prov_' + provider,
          provider,
          name: provider.toUpperCase(),
          apiKey,
          baseUrl: typeof next.baseUrl === 'string' ? next.baseUrl : '',
          defaultModel: typeof next.modelId === 'string' ? next.modelId : '',
          enabled: true,
          validated: true,
        },
      ];
    }
  }
  providers = providers.filter((p) => !(p.id === 'prov_deepseek_default' && !p.apiKey));
  next.providers = providers;
  if (typeof next.provider === 'string' && next.provider) {
    const hasKeyed = providers.some((p) => p.provider === next.provider && !!p.apiKey);
    if (!hasKeyed) {
      next.provider = '';
      next.modelId = '';
    }
  }
  next.schemaVersion = 2;
  return next;
};

// v2 -> v3: retire the placeholder model ids the old opencode-go catalog
// wrote (the `opencode-go/*` prefix never resolved to a real model) and
// map them to the verified model id.
export const migrateV2toV3: Migration = (parsed) => {
  const next: SettingsRecord = { ...parsed };
  const providers = asProviderList(next.providers);
  if (next.provider === 'opencode-go' && String(next.modelId || '').startsWith('opencode-go/')) {
    next.modelId = VERIFIED_OPENCODE_GO_MODEL;
    providers.forEach((p) => {
      if (p.provider === 'opencode-go' && String(p.defaultModel || '').startsWith('opencode-go/')) {
        p.defaultModel = VERIFIED_OPENCODE_GO_MODEL;
      }
    });
    next.providers = providers;
  }
  next.schemaVersion = 3;
  return next;
};

// Ordered migration chain. Key = target version; each entry migrates
// from the previous version. Add new versions by appending here.
export const MIGRATIONS: Record<number, Migration> = {
  2: migrateV1toV2,
  3: migrateV2toV3,
};

export interface MigrationResult {
  data: SettingsRecord;
  migratedFrom: number;
  applied: number[];
}

// Detect the stored version (unversioned payloads are v1) and run every
// pending migration in ascending order. Pure: no storage access.
// A stored version NEWER than this build is returned untouched: stamping it
// with the current version would silently downgrade a newer payload.
export function migrateSettings(parsed: SettingsRecord): MigrationResult {
  const rawVersion = parsed.schemaVersion;
  const from = typeof rawVersion === 'number' && Number.isInteger(rawVersion) ? rawVersion : 1;
  if (from > CURRENT_SCHEMA_VERSION) return { data: { ...parsed }, migratedFrom: from, applied: [] };
  let data = { ...parsed };
  const applied: number[] = [];
  for (let v = from + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const fn = MIGRATIONS[v];
    if (!fn) continue;
    try {
      data = fn(data);
    } catch {
      // One bad migration must never nuke the whole settings object: keep
      // the pre-migration copy and stop instead of throwing into the init
      // fallback that resets everything to defaults.
      return { data: { ...parsed }, migratedFrom: from, applied };
    }
    applied.push(v);
  }
  data.schemaVersion = CURRENT_SCHEMA_VERSION;
  return { data, migratedFrom: from, applied };
}

// Read + migrate the stored settings payload. Returns null when nothing
// is stored or the payload is corrupt (caller falls back to defaults).
// `persist` lets the caller write back the migrated payload; `onCorrupt`
// receives the raw string when JSON parsing fails so the caller can
// quarantine it instead of re-parsing a dead payload on every launch.
export function loadMigratedSettings(
  storage: Pick<Storage, 'getItem'>,
  persist?: (raw: string) => void,
  onCorrupt?: (raw: string) => void
): MigrationResult | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: SettingsRecord;
  try {
    parsed = JSON.parse(raw) as SettingsRecord;
  } catch {
    try {
      onCorrupt?.(raw);
    } catch {}
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const result = migrateSettings(parsed);
  if (persist && result.applied.length > 0) {
    try {
      persist(JSON.stringify({ ...result.data }));
    } catch {
      /* best effort: keep running on the in-memory migrated copy */
    }
  }
  return result;
}
