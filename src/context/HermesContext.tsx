import React, { createContext, useContext, useCallback, useEffect, useState, useRef, useMemo } from 'react';
import type {
  AiModelInfo,
  Blueprint,
  ChatMessage,
  ConfiguredProvider,
  CronJob,
  CronRun,
  DoctorReport,
  GatewayStatus,
  InstallState,
  MemoryInfo,
  MobileSession,
  PendingApproval,
  Project,
  QueuedMessage,
  SkillInfo,
  TurnMeta,
} from '../types/hermes';
import type { ListUiState, SyncMeta, ListSyncResult } from '../services/syncState';
import { GatewayService, type StreamChatCallbacks } from '../services/gateway';
import {
  isNativeGateway,
  nativeInstall,
  nativeStart,
  nativeStop,
  nativeStatus,
  nativeHealth,
  nativeServerKey,
  nativeSecretGet,
  nativeSecretSet,
  nativeNotifyAlert,
  nativeSetAutostart,
  nativeSetProvider,
  nativePickProjectDir,
  nativeImportProjectTree,
  nativeExportProjectTree,
  nativeStreamPost,
} from '../services/nativeGateway';
import {
  mapNativeStatusToGatewayState,
  isTransitional,
  toLegacyInstallState,
  type GatewayState,
} from '../services/gatewayState';
import { resolveListUiState, readSyncedAt } from '../services/pagination';
import {
  unlockVault,
  vaultLocked,
  vaultDecryptSecrets,
  sanitizeForPersist,
  sanitizeVaultPayload,
  purgeSessionKey,
  stageVaultRotation,
  commitVaultRotation,
  rollbackVaultRotation,
} from '../services/secureStore';
import {
  transactionalVaultSave,
  purgeAllSecretHolders,
  blankSecretHolder,
  blankSecrets,
  VaultWriteError,
} from '../services/vaultTransaction';
import { loadMigratedSettings } from '../services/storageMigrations';
import { registerKnownSecrets } from '../services/redaction';
import {
  loadCachedPending,
  cachePending,
  reconcilePending,
  mergeIncoming,
  removeResolved,
} from '../components/approvals/pendingApprovals';
import {
  normalizePolicy,
  isScopeAllowed,
  fromLegacyGlobal,
  DEFAULT_AUTO_APPROVE_POLICY,
  type AutoApprovePolicy,
  type AutoApproveScope,
} from '../components/approvals/approvalScopes';
import {
  createProvider,
  credentialSig,
  updateProvider as storeUpdateProvider,
  removeProvider as storeRemoveProvider,
  activateProvider as storeActivateProvider,
  type ProviderProfile,
} from '../services/providerStore';
import { SseParser, isTerminalSseEvent } from '../services/sseParser';
import {
  isTransportFailure,
  plainGatewayFailure,
  plainResultLine,
  plainServiceFailure,
} from '../services/plainFailure';
import { toAppError } from '../services/appErrors';
import { secretRefForProfile } from '../services/secretRefs';
import { clearSessionRefs } from '../services/attachmentRefs';
import {
  normProvider,
  DEFAULT_MODELS,
  PROVIDER_OPTIONS,
  formatFallbackDisplayName,
  staticModelsFor,
  defaultBaseUrlFor,
} from '../constants/providers';
import { ThemeMode, THEME_PALETTES, applyThemeToDom, watchSystemThemePreference } from '../constants/themes';
import { LANGUAGES, getTranslation } from '../constants/languages';
import { version as APP_VERSION } from '../../package.json';

const VALID_THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];
const VALID_EFFORTS = ['none', 'low', 'medium', 'high'];
const VALID_APPROVAL_SCOPES = ['once', 'session'];

// Unique ids without Math.random. Prefers crypto.randomUUID, falls back
// to a monotonic counter so ids stay unique within the session.
let fallbackIdCounter = 0;
const newId = (prefix: string): string => {
  try {
    const uuid =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : null;
    if (uuid) return `${prefix}_${uuid.slice(0, 8)}`;
  } catch {}
  fallbackIdCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${fallbackIdCounter}`;
};

// Per-turn metadata (model, duration, stopped / estimated badges) is kept
// in memory for the live UI and mirrored per session in localStorage.
// Without the mirror a stopped or estimated turn reads as a clean success
// after a reload, which is the same class of lie as a fabricated session.
const TURN_META_PREFIX = 'hermes_turnmeta_';
const TURN_META_LIMIT = 200;

const loadTurnMetaStore = (sid: string): Record<string, TurnMeta> => {
  try {
    const raw = localStorage.getItem(`${TURN_META_PREFIX}${sid}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, TurnMeta>) : {};
  } catch {
    return {};
  }
};

const saveTurnMetaStore = (sid: string, map: Record<string, TurnMeta>): void => {
  try {
    // Newest TURN_META_LIMIT entries only: a long session cannot exhaust the
    // store, and older badges are re-derivable from the messages themselves.
    const entries = Object.entries(map).slice(-TURN_META_LIMIT);
    localStorage.setItem(`${TURN_META_PREFIX}${sid}`, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota or private mode: badges are cosmetic, the turn itself is intact.
  }
};

const dropTurnMetaStore = (sid: string): void => {
  try {
    localStorage.removeItem(`${TURN_META_PREFIX}${sid}`);
  } catch {}
};

// True while the encrypted vault cipher is on disk. False means the legacy
// no-vault App Lock setup: AppLockGate then verifies the PIN by comparing it
// with settings.appLockPin, and no unlock can ever bring a PIN that was
// blanked out of memory or storage back, because there is no cipher holding
// it. Read on demand, because a vault can appear (first time App Lock is
// switched on) or disappear (switching it off) during a session.
const vaultCipherPresent = (): boolean => {
  try {
    return !!localStorage.getItem('hermes_vault');
  } catch {
    return false;
  }
};

// Error key used when a send fails before any session exists (the first
// message of a chat whose gateway session could not be created).
const NO_SESSION_ERROR_KEY = '__no_session__';

// On-device server key adoption backoff. A device that genuinely has no
// minted key must not stall every request waiting for another round, so a
// failed attempt holds the next one off for this long.
const SERVER_KEY_RETRY_COOLDOWN_MS = 5000;

// Completion signals can also arrive on a plain "message" event as a payload
// type ({ "type": "run.completed" }) instead of a named SSE event. Without
// these, a gateway that ends the turn that way would look like a dropped
// connection to streamTurnViaSse.
const MESSAGE_COMPLETION_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.stopped',
  'run.cancelled',
  'completed',
  'complete',
  'done',
  'stop',
  'cancelled',
  'error',
  'stream.error',
]);
const MESSAGE_FAILURE_TYPES: ReadonlySet<string> = new Set(['run.failed', 'error', 'stream.error']);
const MESSAGE_STOP_TYPES: ReadonlySet<string> = new Set(['run.cancelled', 'run.stopped', 'cancelled', 'stop']);

// Why the gateway is marked failed. 'unauthorized' means an authenticated
// call was rejected with 401/403 while /health still answered: the stored key
// is wrong, which is a different fix than "the gateway is down".
export type GatewayFailureKind = 'start' | 'unhealthy' | 'unauthorized';

// Truthful settings save lifecycle for the Settings tab. 'saved' is only
// reached after every write resolved; revision bumps on every attempt so a
// caller can watch the outcome it started.
export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface HermesSettings {
  provider: string;
  apiKey: string;
  modelId: string;
  baseUrl: string;
  tgToken: string;
  discordToken: string;
  serverKey: string;
  autostart: boolean;
  onboarded: boolean;
  appLockEnabled: boolean;
  appLockPin: string;
  fontScale: number; // 0.8 to 1.3
  reasoningEffort: string; // 'none' | 'low' | 'medium' | 'high'
  autoApproveGlobal: boolean;
  autoApprovePolicy?: AutoApprovePolicy;
  approvalScope: string; // 'once' | 'session'
  providers: ConfiguredProvider[];
  activeProviderId: string;
  themePalette: string;
  themeMode: ThemeMode;
  language: string;
}

export interface ListSyncMeta {
  live: boolean;
  stale: boolean;
  error: string;
  lastSyncedAt: number | null;
  uiState: ListUiState;
}

export type ListSyncMetaMap = Record<string, ListSyncMeta>;

export const emptyListSyncMeta = (): ListSyncMeta => ({
  live: false,
  stale: false,
  error: '',
  lastSyncedAt: null,
  uiState: 'loading',
});

// startFailure token: the native start wait (4 minutes) expired even though
// the image installed successfully. It is never rendered as-is: consumers
// read startFailure from context and map the token to their own copy, so a
// 305MB install that later fails to boot is not reported as "nothing was
// installed".
const START_FAILURE_START_TIMEOUT = 'start-timeout';

// Raised when a native mirror write inside a settings persist rejects. The
// settings write itself already landed, so the failure copy must say the
// change was saved but never reached the on-device gateway, instead of the
// generic "your change was not saved" text.
class NativeMirrorWriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'NativeMirrorWriteError';
  }
}

// The native mirrors one settings persist still owes the bridge. Decided in
// updateSettings, where the previous snapshot is still available, and awaited
// inside persistSettings so settingsSaveState cannot report 'saved' over a
// mirror write that never landed.
type PersistMirror = {
  autostart: boolean;
  credentials: boolean;
};

interface HermesContextType {
  settings: HermesSettings;
  updateSettings: (newSettings: Partial<HermesSettings>) => void;
  t: (key: string) => string;
  saveKeys: (
    provider: string,
    key: string,
    model: string,
    baseUrl: string,
    tg: string,
    discord: string,
    serverKey: string,
    autostart: boolean
  ) => void;

  // Multi-provider operations
  configuredProviders: ConfiguredProvider[];
  addConfiguredProvider: (prov: Omit<ConfiguredProvider, 'id'>) => string;
  updateConfiguredProvider: (id: string, prov: Partial<ConfiguredProvider>) => void;
  removeConfiguredProvider: (id: string) => void;
  activateProvider: (id: string, keepModelId?: string) => void;
  
  // Install & Gateway state
  install: InstallState;
  installProgress: string;
  installError: string | null;
  gatewayLogs: string[];
  connected: boolean;
  gatewayState: GatewayState;
  gatewayStatus: GatewayStatus;
  gatewayFailed: boolean;
  gatewayFailureReason: string | null;
  // Distinguishes why the gateway is marked failed: a start failure, a failed
  // health check, or an authenticated call rejected while health stayed green.
  gatewayFailureKind: GatewayFailureKind | null;
  // Start-vs-install honesty. install='FAILED' covers both a broken install
  // and a gateway that installed fine but never came up, so consumers that
  // must not print "Nothing was installed" read this field instead. Null in
  // the normal case, otherwise a short stable token: START_FAILURE_START_TIMEOUT
  // after the 4-minute native start wait, cleared when the service reaches
  // RUNNING or when a real install failure is reported. Never rendered
  // as-is: map the token to translated copy in the consumer.
  startFailure: string | null;

  // Gateway control
  startGateway: () => Promise<void>;
  stopGateway: () => Promise<void>;
  installGateway: () => Promise<void>;
  refreshNow: () => Promise<void>;
  // Sync envelopes for list screens (stale/live/error kept in state).
  listsMeta: ListSyncMetaMap;
  
  // Sessions & Chat
  sessions: MobileSession[];
  currentSessionId: string | null;
  chat: ChatMessage[];
  streaming: boolean;
  streamElapsed: number;
  turnMeta: Record<string, TurnMeta>;
  usageIn: number;
  usageOut: number;
  approvals: PendingApproval[];
  queuedMessages: QueuedMessage[];
  models: AiModelInfo[];
  refreshModels: () => Promise<void>;
  ensureServerKey: () => Promise<string>;
  // Authenticated gateway client (server key wired). Screens that fetch
  // directly (drawer pagination, export) must use this instead of building
  // their own keyless GatewayService, which the server rejects with 401.
  gatewayService: GatewayService;
  // Projects: SAF-imported copies bound into the gateway (no restart to switch).
  projects: Project[];
  activeProjectId: string | null;
  sessionProjects: Record<string, string>;
  createProject: () => Promise<{ ok: boolean; error?: string }>;
  exportProject: (id: string) => Promise<{ ok: boolean; error?: string }>;
  selectProject: (id: string | null) => void;
  removeProject: (id: string) => Promise<void>;
  modelsLiveInfo: {
    error: string | null;
    liveCount: number;
    fallbackCount?: number;
    lastRefreshedAt?: number;
    isRefreshing?: boolean;
  };
  skills: SkillInfo[];
  setSkills: React.Dispatch<React.SetStateAction<SkillInfo[]>>;
  blueprints: Blueprint[];
  memory: MemoryInfo | null;
  setMemory: React.Dispatch<React.SetStateAction<MemoryInfo | null>>;
  pinnedIds: string[];
  togglePin: (id: string) => void;
  deletedSessionIds: string[];
  
  // Chat actions
  selectSession: (id: string) => void;
  newSession: () => Promise<string>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  forkSession: (id: string) => Promise<void>;
  sendMessage: (text: string, imageDataUrls?: string[]) => boolean;
  sendNow: (text: string, imageDataUrls?: string[]) => boolean | 'queued';
  queueMessage: (text: string, imageDataUrls?: string[]) => boolean;
  cancelQueued: () => void;
  stopStream: () => Promise<void>;
  resolveApproval: (approval: PendingApproval, allow: boolean, mode?: string) => Promise<'ok' | 'resolved' | 'failed'>;
  
  // Vault (encrypted secrets live decrypted only in memory refs)
  vaultUnlocked: boolean;
  unlockSecrets: (pin: string) => Promise<boolean>;
  lockSecrets: () => void;
  lockNow: () => void;
  retryLast: () => boolean;
  // Gateway-aware retry: if the gateway is not healthy this starts it and
  // waits for READY before resending. A retry that skips this just reposts
  // into a dead server and blames the turn.
  retryAfterReady: () => Promise<boolean>;
  turnImages: (msgId: string) => string[];
  // Separate stream failure surface. Transport/backend failures set this
  // and turnMeta.error; they are never appended into chat as bubbles.
  streamError: string | null;
  // Last settings/vault persist failure. Set loudly on failure, cleared on
  // success. The UI must never show Saved while this is set.
  settingsSaveError: string | null;
  // Truthful save lifecycle: settingsSaveState reaches 'saved' (with
  // settingsSavedAt) only after every write resolved, and settingsSaveRevision
  // increments once per attempt so a caller can watch the write it started.
  settingsSaveState: SettingsSaveState;
  settingsSaveRevision: number;
  settingsSavedAt: number | null;

  // Drafts
  getDraft: (sessionId: string | null) => string;
  setDraft: (sessionId: string | null, text: string) => void;
  
  // Jobs
  jobs: CronJob[];
  refreshJobs: () => Promise<void>;
  createJob: (name: string, schedule: string, prompt: string) => Promise<boolean>;
  jobAction: (id: string, action: string) => Promise<boolean>;
  updateJob: (id: string, patch: { name?: string; schedule?: string; prompt?: string }) => Promise<boolean>;
  cronRuns: Record<string, CronRun[]>;
  fetchRuns: (jobId: string) => Promise<void>;
  
  // Diagnostics & Ops
  service: GatewayService;
}

const HermesContext = createContext<HermesContextType | null>(null);

const DEFAULT_PROVIDERS: ConfiguredProvider[] = [];

const DEFAULT_SETTINGS: HermesSettings = {
  provider: '',
  apiKey: '',
  modelId: '',
  baseUrl: '',
  tgToken: '',
  discordToken: '',
  serverKey: '',
  autostart: false,
  onboarded: false,
  appLockEnabled: false,
  appLockPin: '',
  fontScale: 1.0,
  reasoningEffort: 'medium',
  autoApproveGlobal: false,
  autoApprovePolicy: DEFAULT_AUTO_APPROVE_POLICY,
  approvalScope: 'once',
  providers: DEFAULT_PROVIDERS,
  activeProviderId: '',
  themePalette: 'midnight',
  themeMode: 'dark',
  language: 'en',
};

const todayKey = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

export const HermesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Load settings from localStorage through the versioned migration chain.
  // Shape folding lives in storageMigrations (migrateV1toV2/V2toV3); init
  // here only merges defaults, validates, and writes back the migrated copy.
  const [settings, setSettings] = useState<HermesSettings>(() => {
    try {
      const migrated = loadMigratedSettings(localStorage, (raw) => {
        try {
          localStorage.setItem('hermes_settings', raw);
        } catch {}
      }, (bad) => {
        // Quarantine the corrupt payload with a timestamp instead of leaving
        // it on disk to fail parsing on every launch.
        try {
          localStorage.setItem(`hermes_settings.corrupt.${Date.now()}`, bad);
          localStorage.removeItem('hermes_settings');
        } catch {}
      });
      if (migrated) {
        const parsed = { ...(migrated.data as Partial<HermesSettings>) };
        const merged = { ...DEFAULT_SETTINGS, ...parsed };
        if (!VALID_APPROVAL_SCOPES.includes(merged.approvalScope)) {
          merged.approvalScope = 'once';
        }
        // Session elevation never survives a restart: a persisted 'session'
        // scope would silently outlive the intent it was granted with.
        if (merged.approvalScope === 'session') {
          merged.approvalScope = 'once';
        }
        if (parsed.autoApprovePolicy) {
          merged.autoApprovePolicy = normalizePolicy(parsed.autoApprovePolicy);
          merged.autoApproveGlobal = Boolean(merged.autoApprovePolicy.enabled);
        } else if (parsed.autoApproveGlobal !== undefined) {
          merged.autoApprovePolicy = fromLegacyGlobal(Boolean(parsed.autoApproveGlobal));
          merged.autoApproveGlobal = Boolean(merged.autoApprovePolicy.enabled);
        } else {
          merged.autoApprovePolicy = DEFAULT_AUTO_APPROVE_POLICY;
          merged.autoApproveGlobal = false;
        }
        if (!merged.activeProviderId && Array.isArray(merged.providers) && merged.providers.length > 0) {
          const match =
            merged.providers.find((p: ConfiguredProvider) => p.provider === merged.provider) ||
            merged.providers[0];
          merged.activeProviderId = match.id;
        }
        if (merged.activeProviderId && Array.isArray(merged.providers) && merged.providers.length > 0) {
          const activeProf = merged.providers.find((p: ConfiguredProvider) => p.id === merged.activeProviderId);
          if (activeProf) {
            if (!merged.provider) merged.provider = activeProf.provider;
            if (!merged.modelId) merged.modelId = activeProf.defaultModel || '';
            if (!merged.baseUrl && activeProf.baseUrl) merged.baseUrl = activeProf.baseUrl;
          }
        }
        try {
          if (merged.appLockEnabled && localStorage.getItem('hermes_vault')) {
            merged.apiKey = '';
            merged.serverKey = '';
            merged.tgToken = '';
            merged.discordToken = '';
            merged.appLockPin = '';
          }
        } catch {}
        return merged;
      }
    } catch {}
    return DEFAULT_SETTINGS;
  });

  // Apply theme palette and mode to DOM; follow OS changes in system mode
  useEffect(() => {
    applyThemeToDom(settings.themePalette || 'midnight', (settings.themeMode || 'dark') as ThemeMode);
    if ((settings.themeMode || 'dark') === 'system') {
      return watchSystemThemePreference(settings.themePalette || 'midnight');
    }
    return undefined;
  }, [settings.themePalette, settings.themeMode]);

  // Apply language locale and direction to DOM
  useEffect(() => {
    const lang = settings.language || 'en';
    const langItem = LANGUAGES.find((l) => l.id === lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = langItem?.dir || 'ltr';
  }, [settings.language]);

  // Apply font scale to DOM globally on root so typography scales regardless of visited tabs
  useEffect(() => {
    const scale = typeof settings.fontScale === 'number' && Number.isFinite(settings.fontScale)
      ? Math.min(1.3, Math.max(0.8, settings.fontScale))
      : 1.0;
    document.documentElement.style.setProperty('--font-scale', String(scale));
  }, [settings.fontScale]);

  const t = (key: string): string => {
    return getTranslation(key, settings.language || 'en');
  };

  // New copy introduced here may not exist in constants/languages yet, so a
  // missing key degrades to the English fallback instead of printing the key.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Transport failures used to surface raw strings ('Stream failed: HTTP
  // 404', 'Auth failed: HTTP 401', 'Failed to fetch') straight into the chat
  // error banner. Every status now maps to cause + action, the same shape the
  // list loaders already use.
  const isHttpAuthStatus = (status: number): boolean => status === 401 || status === 403;

  const authFailureCopy = (): string =>
    tx(
      'errGatewayAuthHint',
      'Hermes rejected the stored key. Check the provider key and Base URL in Settings, then try again.'
    );

  const sessionGoneCopy = (): string =>
    tx('errSessionGone', 'This chat is no longer on the gateway. Start a new chat.');

  const unreachableCopy = (): string =>
    // Existing key: the list loaders already use this exact cause+action copy.
    tx('errUnavailable', 'Hermes is unreachable. Make sure it is running, then try again.');

  const streamClosedCopy = (): string =>
    tx(
      'errStreamClosed',
      'Hermes closed the connection before the answer finished. Try again.'
    );

  const gatewayRejectedCopy = (): string =>
    tx('errUnknown', 'Something went wrong. Try again, and run diagnostics if it continues.');

  // Cause + action for a non-OK response from an authenticated gateway
  // endpoint. Shared by the stream runner and the first-message session
  // creator so both give the same advice for the same status.
  const httpStatusCopy = (status: number): string => {
    if (isHttpAuthStatus(status)) return authFailureCopy();
    if (status === 404) return sessionGoneCopy();
    if (status >= 500) return `${tx('errServerMessagePlain', 'The Hermes server or the provider returned an error. Retry, and check the connection if it repeats.')} (HTTP ${status})`;
    return gatewayRejectedCopy();
  };

  // A fetch that never reached the gateway throws TypeError('Failed to
  // fetch') / 'NetworkError' / 'Load failed' depending on the platform, and
  // the message can also be any transport wording the shared classifier
  // knows ('read ECONNRESET', 'getaddrinfo ENOTFOUND', TLS). One source of
  // truth: this used to carry its own shorter list and told a DNS failure
  // that the answer had finished.
  const isNetworkFailure = (err: unknown): boolean => {
    if (err instanceof TypeError) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return isTransportFailure(msg);
  };

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // In-memory vault-map mirror (secretRef -> key) backing the providerStore
  // single credential write path. Seeded lazily from legacy plaintext
  // entries once; never persisted except through transactionalVaultSave.
  const providerSecretsRef = useRef<Record<string, string> | null>(null);
  const getProviderSecrets = (): Record<string, string> => {
    if (providerSecretsRef.current) return providerSecretsRef.current;
    const seeded: Record<string, string> = {};
    for (const p of settingsRef.current.providers || []) {
      const key = (p as ConfiguredProvider).apiKey;
      if (key) seeded[secretRefForProfile(p.id)] = key;
    }
    providerSecretsRef.current = seeded;
    return seeded;
  };
  // Decrypted secrets live here when AppLock is enabled. localStorage
  // holds only ciphertext in that case.
  const secretsRef = useRef({
    apiKey: settings.apiKey,
    serverKey: settings.serverKey,
    tgToken: settings.tgToken,
    discordToken: settings.discordToken,
    appLockPin: settings.appLockPin,
  });
  secretsRef.current = {
    apiKey: settings.apiKey,
    serverKey: settings.serverKey,
    tgToken: settings.tgToken,
    discordToken: settings.discordToken,
    appLockPin: settings.appLockPin,
  };

  const gatewayService = useMemo(() => {
    return new GatewayService(
      'http://127.0.0.1:8080',
      () => secretsRef.current.serverKey || settingsRef.current.serverKey
    );
  }, []);

  // Install & Gateway Supervision state
  const [install, setInstall] = useState<InstallState>(() => {
    return settings.onboarded ? 'RUNNING' : 'NOT_INSTALLED';
  });
  const [installProgress, setInstallProgress] = useState<string>('');
  const [installError, setInstallError] = useState<string | null>(null);
  const [gatewayLogs, setGatewayLogs] = useState<string[]>(() => [
    `Hermes Mobile v${APP_VERSION} started at ${new Date().toLocaleString()}`,
  ]);
  const [connected, setConnected] = useState<boolean>(false);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>({
    ok: false,
    version: '',
    gatewayState: 'down',
    platforms: {},
    detail: 'Probing gateway health',
  });
  const [gatewayFailed, setGatewayFailed] = useState<boolean>(false);
  const [gatewayFailureReason, setGatewayFailureReason] = useState<string | null>(null);
  const [gatewayFailureKind, setGatewayFailureKind] = useState<GatewayFailureKind | null>(null);
  // Single gateway lifecycle machine (GATEWAY-03). On native this mirrors
  // HermesGatewayPlugin.status() via the poll loop below; every UI flag
  // (connected/install) derives from it. Web builds stay on CHECKING.
  const [gatewayState, setGatewayState] = useState<GatewayState>('CHECKING');
  const gatewayStateRef = useRef<GatewayState>('CHECKING');
  gatewayStateRef.current = gatewayState;
  // See START_FAILURE_START_TIMEOUT. Kept apart from install='FAILED' so the
  // start-timeout path after a good install stays distinguishable for the UI.
  const [startFailure, setStartFailure] = useState<string | null>(null);

  // Sessions and Chat
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  // Projects: host folders bound into the gateway. sessionProjects tags
  // chats; activeProjectId filters the drawer and is inherited by new
  // chats. All three persist in localStorage; the server bind lives in
  // /root/.projects/<id> and is recreated on demand.
  const [projects, setProjects] = useState<Project[]>(() => {
    try {
      const raw = localStorage.getItem('hermes_projects');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((p) => p && typeof p.id === 'string') : [];
    } catch { return []; }
  });
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    try { return localStorage.getItem('hermes_active_project') || null; } catch { return null; }
  });
  const [sessionProjects, setSessionProjects] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem('hermes_session_projects');
      const p = raw ? JSON.parse(raw) : {};
      return p && typeof p === 'object' ? p : {};
    } catch { return {}; }
  });
  // Tombstones for ids deleted while a list screen holds stale pages: the
  // drawer merges loaded-more pages the context refresh never reprunes.
  const [deletedSessionIds, setDeletedSessionIds] = useState<string[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [streamElapsed, setStreamElapsed] = useState<number>(0);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [turnMeta, setTurnMeta] = useState<Record<string, TurnMeta>>({});
  const [usageIn, setUsageIn] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('hermes_usage');
      if (raw) {
        const p = JSON.parse(raw);
        if (p.date === todayKey()) return Number(p.in) || 0;
      }
    } catch {}
    return 0;
  });
  const [usageOut, setUsageOut] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('hermes_usage');
      if (raw) {
        const p = JSON.parse(raw);
        if (p.date === todayKey()) return Number(p.out) || 0;
      }
    } catch {}
    return 0;
  });
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [modelsLiveInfo, setModelsLiveInfo] = useState<{
    error: string | null;
    liveCount: number;
    fallbackCount?: number;
    lastRefreshedAt?: number;
    isRefreshing?: boolean;
  }>({ error: null, liveCount: 0, fallbackCount: 0, lastRefreshedAt: 0, isRefreshing: false });
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  // Per-list sync envelopes: stale/live/error kept in state and mapped to
  // list UI states via resolveListUiState. Never render a bare empty list
  // as success while one of these carries an error.
  const [listsMeta, setListsMeta] = useState<ListSyncMetaMap>({});
  const [streamError, setStreamError] = useState<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [settingsSaveState, setSettingsSaveState] = useState<SettingsSaveState>('idle');
  const [settingsSaveRevision, setSettingsSaveRevision] = useState<number>(0);
  const [settingsSavedAt, setSettingsSavedAt] = useState<number | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('hermes_pinned_sessions');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  // Drafts store
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Jobs
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [cronRuns, setCronRuns] = useState<Record<string, CronRun[]>>({});

  // True when secrets are available in memory. False at boot while
  // AppLock is enabled and the vault has not been unlocked yet.
  const [vaultUnlocked, setVaultUnlocked] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('hermes_settings');
      if (raw) {
        const p = JSON.parse(raw);
        if (p && p.appLockEnabled) return false;
      }
    } catch {}
    return true;
  });

  // Persist usage counters so a reload keeps totals. Counters reset daily.
  useEffect(() => {
    try {
      localStorage.setItem('hermes_usage', JSON.stringify({ date: todayKey(), in: usageIn, out: usageOut }));
    } catch {}
  }, [usageIn, usageOut]);

  // Bound turnMeta to messages present in the current chat.
  useEffect(() => {
    if (chat.length === 0) return;
    setTurnMeta((prev) => {
      const ids = new Set(chat.map((m) => m.id));
      let dropped = false;
      const next: Record<string, TurnMeta> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (ids.has(k)) next[k] = v;
        else dropped = true;
      }
      return dropped ? next : prev;
    });
  }, [chat]);

  // Session key for a stream failure: the current session, or a sentinel when
  // a send failed before any gateway session existed.
  const streamErrorKey = (): string => currentSessionIdRef.current || NO_SESSION_ERROR_KEY;

  // Record a stream failure against ONE session, and only surface it while
  // that session is on screen. Selecting another chat switches the visible
  // error to that chat's own (or none) instead of leaking it across chats.
  const setStreamErrorFor = (key: string, message: string | null) => {
    if (message) streamErrorsRef.current[key] = message;
    else delete streamErrorsRef.current[key];
    if (streamErrorKey() === key) setStreamError(message);
  };

  // Load the persisted badges for a session and claim ownership of the
  // in-memory map, so the persist effect below cannot cross sessions.
  const hydrateTurnMeta = (sid: string | null) => {
    turnMetaOwnerRef.current = sid;
    setTurnMeta(sid ? loadTurnMetaStore(sid) : {});
  };

  // Persist the badges for the session they belong to. Owner-gated: a switch
  // mid-render must never write one chat's meta under another chat's id.
  useEffect(() => {
    const owner = turnMetaOwnerRef.current;
    if (!owner || owner !== currentSessionId) return;
    saveTurnMetaStore(owner, turnMeta);
  }, [turnMeta, currentSessionId]);

  const abortControllerRef = useRef<AbortController | null>(null);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Synchronous mirrors so stop-then-send in the same tick works (state lags a render).
  const streamingRef = useRef<boolean>(false);
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const queuedRef = useRef<QueuedMessage[]>([]);
  // Image payloads of recent user turns, keyed by user message id. History
  // persists text only, so without this retry/regenerate silently resend
  // image turns as text-only. Capped: data URLs are heavy.
  const turnImagesRef = useRef<Record<string, string[]>>({});
  const turnImages = (msgId: string): string[] => turnImagesRef.current[msgId] || [];
  const rememberTurnImages = (msgId: string, images: string[]) => {
    if (!images || images.length === 0) return;
    turnImagesRef.current[msgId] = images;
    const keys = Object.keys(turnImagesRef.current);
    if (keys.length > 10) {
      for (const k of keys.slice(0, keys.length - 10)) delete turnImagesRef.current[k];
    }
  };
  const refreshTokenRef = useRef<number>(0);
  const sessionsRef = useRef<MobileSession[]>(sessions);
  sessionsRef.current = sessions;
  const projectsRef = useRef<Project[]>(projects);
  projectsRef.current = projects;
  const activeProjectIdRef = useRef<string | null>(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const sessionProjectsRef = useRef<Record<string, string>>(sessionProjects);
  sessionProjectsRef.current = sessionProjects;
  // Per-turn usage tracking for the estimation fallback.
  const turnUsageSeenRef = useRef<boolean>(false);
  const turnOutCharsRef = useRef<number>(0);
  // Agent bubble id of the in-flight turn, so stopStream can mark its
  // turnMeta.stopped even though state lags a render.
  const lastAgentMsgIdRef = useRef<string | null>(null);
  // Ownership token of the current turn. runTurn claims a fresh value on
  // every entry; any async tail left over from an earlier turn (its stream
  // finally, its stop verdict, its error/stop callbacks) compares against the
  // token it captured and bails when another turn has claimed the shared
  // stream refs since. Without it a cancelled turn settling late would clear
  // the run id and abort handle of the turn started right after it.
  const turnTokenRef = useRef<number>(0);
  // runIds already pushed to the system alert channel: the in-app list can
  // re-render freely, but each approval notifies at most once per session.
  const notifiedApprovalIdsRef = useRef<Set<string>>(new Set());
  // Latest run id seen on the wire this turn: the runTurn finally block
  // purges that run's cards, and it lives outside streamTurnViaSse's scope.
  const seenRunIdRef = useRef<string>('');
  // Guards the approvals cache write-back until the startup hydration below
  // has run once (otherwise the initial [] would clobber the stored cache).
  const approvalsHydratedRef = useRef<boolean>(false);
  // Stream failures are per session: the visible streamError switches when the
  // user selects another chat instead of leaking one chat's failure into all.
  const streamErrorsRef = useRef<Record<string, string>>({});
  // Session id the in-memory turnMeta state currently belongs to, so the
  // persistence effect never writes one chat's badges under another's id.
  const turnMetaOwnerRef = useRef<string | null>(null);
  // Synchronous mirror of connected: sendMessage decides queue-vs-post without
  // waiting for the next render.
  const connectedRef = useRef<boolean>(false);
  // Auto-heal bookkeeping: the credential fingerprint the running gateway
  // process booted with (null until a start records it), the fingerprint an
  // automatic restart already handled (one attempt per fingerprint, manual
  // retry stays the fallback), and a single-flight guard.
  const bootCredSigRef = useRef<string | null>(null);
  const autoHealForRef = useRef<string | null>(null);
  const autoHealInFlightRef = useRef(false);
  // Queue draining is single-flight: a queued message is popped once and sent
  // 300ms later, so a second drain must not pop the next one meanwhile.
  const queueDrainPendingRef = useRef<boolean>(false);
  const wasConnectedRef = useRef<boolean>(false);
  connectedRef.current = connected;

  // Persist chat outside of state updaters (StrictMode purity).
  useEffect(() => {
    if (!currentSessionId || chat.length === 0) return;
    try {
      gatewayService.saveLocalMessages(currentSessionId, chat);
    } catch {}
  }, [chat, currentSessionId, gatewayService]);

  // Write approvals back to the local cache whenever they change, so a
  // reload or offline boot can restore them. Skipped until the startup
  // hydration below has run once.
  useEffect(() => {
    if (!approvalsHydratedRef.current) return;
    cachePending(approvals);
  }, [approvals]);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    // Scrub live secret values so logs never leak credentials.
    let safe = msg;
    try {
      const secrets = [
        secretsRef.current.apiKey,
        secretsRef.current.serverKey,
        secretsRef.current.tgToken,
        secretsRef.current.discordToken,
        secretsRef.current.appLockPin,
      ];
      for (const s of secrets) {
        if (s && s.length >= 4 && safe.includes(s)) {
          safe = safe.split(s).join('***REDACTED***');
        }
      }
    } catch {}
    setGatewayLogs((prev) => [...prev, `[${timestamp}] ${safe}`].slice(-400));
  };

  // Record a list sync envelope in state and map it to its UI state via
  // resolveListUiState. Callers pass the envelope straight from the
  // *WithState fetchers so stale/live/error survive in state for list
  // screens instead of collapsing to a bare array.
  const setListMeta = (
    key: string,
    meta: Pick<SyncMeta, 'live' | 'stale' | 'error' | 'lastSyncedAt'>,
    itemCount: number,
    flags?: { loading?: boolean; refreshing?: boolean; offline?: boolean }
  ) => {
    const uiState = resolveListUiState(meta, itemCount, flags);
    setListsMeta((prev) => ({
      ...prev,
      [key]: {
        live: meta.live,
        stale: meta.stale,
        error: meta.error || '',
        lastSyncedAt: meta.lastSyncedAt,
        uiState,
      },
    }));
  };

  // Vault payload for a settings snapshot. Provider keys travel under
  // provider.<id>.apiKey refs, globals under global.* keys; the flat legacy
  // apiKey folds into the active provider so sanitizeVaultPayload never
  // drops it (unmapped keys are denied, not persisted).
  const buildVaultPayload = (next: HermesSettings): Record<string, string> => {
    const raw: Record<string, unknown> = {
      'global.serverKey': next.serverKey || '',
      'global.tgToken': next.tgToken || '',
      'global.discordToken': next.discordToken || '',
      'global.appLockPin': next.appLockPin || '',
    };
    const secrets = getProviderSecrets();
    for (const p of next.providers || []) {
      const ref =
        p.secretRef && p.secretRef.startsWith('provider.') ? p.secretRef : secretRefForProfile(p.id);
      const key = secrets[ref] ?? p.apiKey ?? '';
      if (key) raw[ref] = key;
    }
    const flatKey = (next.apiKey || '').trim();
    if (flatKey) {
      const list = next.providers || [];
      const active =
        list.find((p) => p.id === next.activeProviderId) ||
        list.find((p) => p.provider === next.provider);
      const ref =
        active && active.secretRef && active.secretRef.startsWith('provider.')
          ? active.secretRef
          : secretRefForProfile(active ? active.id : 'legacy');
      raw[ref] = flatKey;
      const live = getProviderSecrets();
      live[ref] = flatKey;
    }
    return sanitizeVaultPayload(raw);
  };

  // Human-readable reason for a failed settings write. Vault cipher failures
  // say what the user can do; storage failures keep the cause text.
  const describeSaveFailure = (e: unknown): string => {
    if (e instanceof VaultWriteError) {
      return tx(
        'errSettingsVaultWrite',
        'Settings were not saved. Unlock the app and try again.'
      );
    }
    // A storage failure arrives as raw platform text (quota, security,
    // DOM exception names). The classifier keeps an honest sentence and
    // replaces anything machine-made, so no raw e.message reaches the UI.
    // The banner above already says "Your change was not saved" in the
    // reader's language, so the English "Settings write failed" prefix this
    // used to carry is gone rather than translated.
    const cause = plainResultLine(e instanceof Error ? e.message : String(e), '');
    return cause || plainServiceFailure(e);
  };

  // Transactional persist. AppLock on: sanitized settings to localStorage +
  // cipher committed via transactionalVaultSave (rejects with VaultWriteError
  // on any failure, previous vault kept). AppLock off: legacy plaintext
  // write. The native mirrors owed by this snapshot are awaited before
  // 'saved'. Failures set settingsSaveError loudly and rethrow; callers must
  // never report Saved when this rejects.
  const persistSettings = async (
    next: HermesSettings,
    mirror?: PersistMirror
  ): Promise<void> => {
    secretsRef.current = {
      apiKey: next.apiKey,
      serverKey: next.serverKey,
      tgToken: next.tgToken,
      discordToken: next.discordToken,
      appLockPin: next.appLockPin,
    };
    setSettingsSaveState('saving');
    try {
      if (next.appLockEnabled && !vaultLocked()) {
        // Sanitized public copy first, then the cipher: transactionalVaultSave
        // rejects (VaultWriteError) and keeps the previous vault on failure.
        const pub = sanitizeForPersist({ ...next } as unknown as Record<string, unknown>) as unknown as HermesSettings;
        localStorage.setItem('hermes_settings', JSON.stringify(pub));
        await transactionalVaultSave(buildVaultPayload(next));
      } else if (!next.appLockEnabled) {
        // No-lock path used to write the full snapshot, secrets included.
        // Now it writes the sanitized public copy like every other branch;
        // the secrets ride to the encrypted native store via the mirror
        // below (native) or stay in memory for this session (web). The
        // vault cipher, if any, is dropped: nothing may rehydrate it.
        const pub = sanitizeForPersist({ ...next } as unknown as Record<string, unknown>) as unknown as HermesSettings;
        // Web legacy without a bridge: no vault, no native store, so the PIN
        // stays in this copy or the next boot has no gate key. Native builds
        // blank it via the sanitizer above and rehydrate from SecurePrefs.
        if (!isNativeGateway() && !vaultCipherPresent() && next.appLockPin) {
          pub.appLockPin = next.appLockPin;
        }
        localStorage.setItem('hermes_settings', JSON.stringify(pub));
        try {
          localStorage.removeItem('hermes_vault');
        } catch {}
      } else {
        // Vault locked: persist the sanitized public copy only, never secrets.
        const pub = sanitizeForPersist({ ...next } as unknown as Record<string, unknown>) as unknown as HermesSettings;
        // Legacy no-vault setup: the sanitized copy is the ONLY copy, and it
        // is all AppLockGate reads after a restart, so blanking the PIN here
        // would hand the next boot a gate with no key and no cipher to rehydrate
        // it from. That setup carries the PIN in plaintext by design (boot only
        // strips it when a vault is present), so it survives this write. The
        // vault path above is untouched: whenever a cipher exists the PIN is
        // sealed in it and stays out of this copy.
        if (!vaultCipherPresent() && next.appLockPin) {
          pub.appLockPin = next.appLockPin;
        }
        localStorage.setItem('hermes_settings', JSON.stringify(pub));
      }
      // The native mirrors ride on this persist and are AWAITED: the boot
      // receiver and the gateway renderer read only those prefs, so reaching
      // 'saved' while they still hold the previous values would be a lie the
      // Settings banner and its Retry could never correct. The settings write
      // above already landed and is never rolled back, so a mirror rejection
      // only marks this save as failed.
      // Secret slots ride every persist on native (no-op on web): the
      // sanitized copy above holds no secrets, so without this the native
      // store would keep the previous values and lie about the save.
      // Secrets go FIRST: nativeSetProvider below converges KEY_PROVIDER
      // from the per-profile slots, so they must already hold the fresh
      // key when it inspects them. Mirrors-first left a blank wire to purge
      // or strand the key and the gateway booted credentialless.
      await mirrorSecretsToNative(next);
      if (mirror) await applyNativeMirrors(next, mirror);
      // Register live vault values for content scrubbing (LOG-01): gateway
      // log/doctor/debug-share responses pass through redactSecrets, which
      // now also scrubs these values wherever they leak into free text.
      registerKnownSecrets([
        next.serverKey,
        next.tgToken,
        next.discordToken,
        next.appLockPin,
        ...(next.providers || []).map((p) => (p as ConfiguredProvider).apiKey as string),
      ]);
      // 'saved' is honest only here: every write above resolved without throw.
      setSettingsSaveError(null);
      setSettingsSaveState('saved');
      setSettingsSavedAt(Date.now());
    } catch (e) {
      const mirrorError = e instanceof NativeMirrorWriteError ? e : null;
      const msg = mirrorError
        ? tx(
            'applyFailedPlain',
            'The change was saved, but Hermes did not pick it up. Restart Hermes, then try again.'
          )
        : describeSaveFailure(e);
      setSettingsSaveError(msg);
      setSettingsSaveState('error');
      addLog(
        mirrorError
          ? `Settings saved locally but the on-device mirror failed: ${mirrorError.message}`
          : `Settings save failed: ${msg}`
      );
      throw e;
    } finally {
      // One bump per attempt, success or failure, so a caller watching a
      // revision always learns the outcome of the write it started.
      setSettingsSaveRevision((n) => n + 1);
    }
  };

  // Mirror the active provider plus the global credentials into the native
  // prefs renderConfig reads on every gateway (re)start. Without it the
  // on-device gateway keeps the old provider and chat fails auth, and the
  // Telegram/Discord platform tokens never reach the gateway process.
  // The bridge treats a blank serverKey as "leave the stored key alone" and a
  // blank token as "this slot was cleared", and it no-ops on builds that
  // predate these fields. Every rejection is logged truthfully AND rethrown
  // (wrapped) so a save path can refuse to report 'saved' over a mirror that
  // never landed; callers outside a save path catch the rejection themselves.
  // Single resolution of what the gateway boots with: the ACTIVE profile
  // first, flat legacy field last. Both the credential mirror and the
  // auto-heal fingerprint below read this, so they can never disagree about
  // which key the running process holds.
  const resolveNativeProviderPayload = (
    next: HermesSettings
  ): {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    activeProfileId: string;
    serverKey: string;
    tgToken: string;
    discordToken: string;
  } => {
    const profiles = (next.providers || []) as ConfiguredProvider[];
    const active =
      profiles.find((p) => p && p.id === next.activeProviderId) ||
      profiles.find((p) => p && p.provider === next.provider);
    // The profile's own key, then the in-memory secret holder (the edit form
    // saves profiles blank and keeps the key only in the holder), then the
    // flat legacy field. Order matters: the first non-empty wins, and a
    // fully blank result is sent as-is so the bridge leaves the stored key
    // alone instead of clearing it.
    const resolvedKey =
      ((active?.apiKey as string) || '').trim() ||
      ((secretsRef.current?.apiKey as string) || '').trim() ||
      ((next.apiKey as string) || '').trim();
    return {
      provider: active?.provider || next.provider || '',
      apiKey: resolvedKey,
      // Empty base URL inherits the provider default so the gateway never
      // runs a provider against an empty host.
      baseUrl:
        (active?.baseUrl ?? next.baseUrl ?? '').trim() ||
        defaultBaseUrlFor(active?.provider || next.provider || ''),
      model: active?.defaultModel || next.modelId || '',
      activeProfileId: active?.id || next.activeProviderId || '',
      serverKey: next.serverKey || '',
      tgToken: next.tgToken || '',
      discordToken: next.discordToken || '',
    };
  };

  // Fingerprint of a boot payload. Secrets enter as length+digest only, so
  // this string is safe to compare and log. A mismatch against the boot
  // signature means the running process holds stale credentials.
  const nativeBootSig = (payload: ReturnType<typeof resolveNativeProviderPayload>): string =>
    JSON.stringify({
      p: payload.provider,
      k: credentialSig(payload.apiKey),
      b: (payload.baseUrl || '').trim(),
      m: (payload.model || '').trim(),
      a: payload.activeProfileId,
      s: credentialSig(payload.serverKey),
      t: credentialSig(payload.tgToken),
      d: credentialSig(payload.discordToken),
    });

  const mirrorCredentialsToNative = (
    next: HermesSettings,
    reason: string
  ): Promise<void> => {
    if (!isNativeGateway()) return Promise.resolve();
    // P0: the flat settings.apiKey is blank on native (keys live in the
    // provider profiles and rehydrate fills only those), so mirroring it
    // verbatim wipes KEY_PROVIDER on every boot and every provider change.
    // Resolve the key from the ACTIVE profile first, flat field last.
    const payload = resolveNativeProviderPayload(next);
    return nativeSetProvider({
      provider: payload.provider,
      apiKey: payload.apiKey,
      baseUrl: payload.baseUrl,
      model: payload.model,
      activeProfileId: payload.activeProfileId,
      serverKey: payload.serverKey,
      tgToken: payload.tgToken,
      discordToken: payload.discordToken,
    }).catch((e: unknown) => {
      addLog(
        `Native credential sync failed (${reason}): ${e instanceof Error ? e.message : String(e)}`
      );
      throw new NativeMirrorWriteError(e);
    });
  };

  // Secret slots mirror (S1): every secret the snapshot carries is written
  // to the encrypted native store under its secretRef/global key, so
  // localStorage never holds a key or token again on native builds. Blank
  // clears the slot. Rejections are loud (NativeMirrorWriteError) like the
  // credential mirror above: a save must not report 'saved' over secrets
  // that never landed.
  const mirrorSecretsToNative = (next: HermesSettings): Promise<void> => {
    if (!isNativeGateway()) return Promise.resolve();
    const writes: Array<Promise<boolean>> = [];
    const activeId = next.activeProviderId || '';
    const liveKey = ((secretsRef.current?.apiKey as string) || '').trim() || ((next.apiKey as string) || '').trim();
    // Active profile first: the edit form's key may live only in the secret
    // holder (the profile object itself is saved blank), so the resolver
    // falls back to it before giving up on a profile.
    const resolvedKeyFor = (profile: ConfiguredProvider): string => {
      const own = ((profile.apiKey as string) || '').trim();
      if (own) return own;
      if (activeId && profile.id === activeId) return liveKey;
      return '';
    };
    for (const p of next.providers || []) {
      const profile = p as ConfiguredProvider;
      if (!profile || !profile.id) continue;
      // A blank key on the snapshot means 'unknown', not 'delete': the flat
      // field is empty on native (keys live in the encrypted store and are
      // rehydrated separately), so writing it verbatim wiped every stored
      // key on boot and left the gateway credentialless. Removal is explicit
      // through the delete path, never through an ordinary mirror. The one
      // exception is a tombstoned ref (user erased the key in the form):
      // that gets a single explicit blank write, which the bridge turns
      // into a real slot removal.
      const profileKey = resolvedKeyFor(profile);
      const ref = profile.secretRef && profile.secretRef.startsWith('provider.')
        ? profile.secretRef
        : secretRefForProfile(profile.id);
      if (!profileKey) {
        if (erasedSecretRefsRef.current.has(ref)) {
          erasedSecretRefsRef.current.delete(ref);
          writes.push(nativeSecretSet(ref, ''));
        }
        continue;
      }
      // A real key write cancels any pending erasure for this slot, so a
      // re-entered key can never be blanked by a stale tombstone.
      erasedSecretRefsRef.current.delete(ref);
      writes.push(nativeSecretSet(secretRefForProfile(profile.id), profileKey));
    }
    // Leftover tombstones belong to profiles that are gone (deleted while
    // holding an erased key): flush them so no orphan slot survives.
    for (const ref of Array.from(erasedSecretRefsRef.current)) {
      erasedSecretRefsRef.current.delete(ref);
      writes.push(nativeSecretSet(ref, ''));
    }
    // Legacy flat-key install: no active profile carried the key, so preserve
    // it under the active profile's slot instead of dropping it.
    if (liveKey && !(next.providers || []).some((p) => p && p.id === activeId)) {
      writes.push(nativeSecretSet(secretRefForProfile(activeId || 'legacy'), liveKey));
    }
    // Same rule for the globals: a blank snapshot value must not clear a
    // stored token. Each is written only when it has content.
    for (const [slot, value] of [
      ['global.serverKey', next.serverKey || ''],
      ['global.tgToken', next.tgToken || ''],
      ['global.discordToken', next.discordToken || ''],
      ['global.appLockPin', next.appLockPin || ''],
    ] as Array<[string, string]>) {
      if (!value.trim()) continue;
      writes.push(nativeSecretSet(slot, value));
    }
    return Promise.all(writes).then((results) => {
      if (results.some((ok) => !ok)) {
        const e = new Error('native secret mirror unavailable');
        addLog(`Native secret sync failed: ${e.message}`);
        throw new NativeMirrorWriteError(e);
      }
    });
  };

  // Autostart mirror for the flag BootReceiver reads, same contract as the
  // credential mirror: log the raw cause, then reject.
  const mirrorAutostartToNative = (enabled: boolean): Promise<void> => {
    if (!isNativeGateway()) return Promise.resolve();
    return nativeSetAutostart(enabled).catch((e: unknown) => {
      addLog(`Native autostart sync failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new NativeMirrorWriteError(e);
    });
  };

  // Both native mirrors owed by one persist, awaited in order. Rejections
  // arrive as NativeMirrorWriteError so persistSettings can tell "the
  // settings write failed" apart from "settings written, mirror refused".
  const applyNativeMirrors = async (
    next: HermesSettings,
    mirror: PersistMirror
  ): Promise<void> => {
    if (mirror.autostart) await mirrorAutostartToNative(next.autostart);
    if (mirror.credentials) await mirrorCredentialsToNative(next, 'provider change');
  };

  // Which mirrors this persist owes, decided where the previous snapshot is
  // still in hand. A theme-only change pushes nothing to the bridge, and web
  // builds never do.
  const mirrorPlanFor = (prev: HermesSettings, next: HermesSettings): PersistMirror => {
    const prevProfiles = (prev.providers || []) as ConfiguredProvider[];
    const nextProfiles = (next.providers || []) as ConfiguredProvider[];
    const prevActive =
      prevProfiles.find((p) => p && p.id === prev.activeProviderId) ||
      prevProfiles.find((p) => p && p.provider === prev.provider);
    const nextActive =
      nextProfiles.find((p) => p && p.id === next.activeProviderId) ||
      nextProfiles.find((p) => p && p.provider === next.provider);
    const activeProfileChanged =
      prevActive?.id !== nextActive?.id ||
      prevActive?.provider !== nextActive?.provider ||
      prevActive?.apiKey !== nextActive?.apiKey ||
      prevActive?.baseUrl !== nextActive?.baseUrl ||
      prevActive?.defaultModel !== nextActive?.defaultModel;

    return {
      autostart: isNativeGateway() && next.autostart !== prev.autostart,
      credentials:
        isNativeGateway() &&
        (activeProfileChanged ||
          next.provider !== prev.provider ||
          next.activeProviderId !== prev.activeProviderId ||
          next.apiKey !== prev.apiKey ||
          next.baseUrl !== prev.baseUrl ||
          next.modelId !== prev.modelId ||
          next.serverKey !== prev.serverKey ||
          next.tgToken !== prev.tgToken ||
          next.discordToken !== prev.discordToken),
    };
  };

  // One FIFO for every settings persist. Two branches below persist only
  // after an await (lockVault), so without a queue a later update could write
  // its snapshot first and the older one would then overwrite it, both in
  // hermes_settings and in the vault. Queueing keeps disk order equal to call
  // order, so the newest snapshot always commits last.
  const persistBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const enqueuePersist = (op: () => Promise<void>): Promise<void> => {
    const queued = persistBarrierRef.current.then(op);
    persistBarrierRef.current = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  };

  const updateSettings = (newSettings: Partial<HermesSettings>) => {
    const prev = settingsRef.current;
    const next = { ...prev, ...newSettings };
    // Clamp and validate user-facing preferences so stored settings stay sane.
    if (typeof next.fontScale === 'number' && Number.isFinite(next.fontScale)) {
      next.fontScale = Math.min(1.3, Math.max(0.8, next.fontScale));
    } else {
      next.fontScale = 1.0;
    }
    if (!THEME_PALETTES.some((th) => th.id === next.themePalette)) {
      next.themePalette = 'midnight';
    }
    if (!LANGUAGES.some((l) => l.id === next.language)) {
      next.language = 'en';
    }
    if (!VALID_THEME_MODES.includes(next.themeMode)) {
      next.themeMode = 'dark';
    }
    if (!VALID_EFFORTS.includes(next.reasoningEffort)) {
      next.reasoningEffort = 'medium';
    }
    if (!VALID_APPROVAL_SCOPES.includes(next.approvalScope)) {
      next.approvalScope = 'once';
    }
    if (newSettings.autoApprovePolicy) {
      next.autoApprovePolicy = normalizePolicy(newSettings.autoApprovePolicy);
      next.autoApproveGlobal = Boolean(next.autoApprovePolicy.enabled);
    } else if (newSettings.autoApproveGlobal !== undefined) {
      next.autoApprovePolicy = fromLegacyGlobal(Boolean(newSettings.autoApproveGlobal));
      next.autoApproveGlobal = Boolean(next.autoApprovePolicy.enabled);
    } else if (next.autoApprovePolicy) {
      next.autoApprovePolicy = normalizePolicy(next.autoApprovePolicy);
      next.autoApproveGlobal = Boolean(next.autoApprovePolicy.enabled);
    }
    // Decide the native mirrors from THIS snapshot before anything awaits, so
    // the queued persist pushes exactly the change the user just made.
    const mirror = mirrorPlanFor(prev, next);
    if (newSettings.appLockEnabled && !prev.appLockEnabled && next.appLockPin) {
      enqueuePersist(() =>
        // Staged rotation: the new cipher must save under the new key BEFORE
        // salt/verifier commit, or a failed save bricks the vault.
        stageVaultRotation(next.appLockPin)
          .then(() => persistSettings(next, mirror))
          .then(() => commitVaultRotation())
          .then(() => {
            setVaultUnlocked(true);
          })
          .catch((e: unknown) => {
            rollbackVaultRotation();
            throw e;
          })
      ).catch((e: unknown) => {
        // persistSettings already surfaced settingsSaveError + log loudly.
        addLog(`Vault persist after lock needs attention: ${e instanceof Error ? e.message : String(e)}`);
      });
    } else if (
      next.appLockEnabled &&
      prev.appLockEnabled &&
      next.appLockPin &&
      next.appLockPin !== prev.appLockPin
    ) {
      // PIN rotation (U6): the session key must be re-derived under the new
      // PIN *before* re-encrypting. Persisting first would seal the vault
      // under the old key and the old PIN would keep unlocking it.
      if (vaultLocked()) {
        // Locked means every secret copy is blanked from memory, so there is
        // nothing safe to re-encrypt. Refuse honestly and keep the old PIN
        // instead of writing a vault the user can no longer open.
        next.appLockPin = prev.appLockPin;
        setSettingsSaveError('PIN change blocked while locked: unlock the app first, then change the PIN.');
        addLog('PIN change blocked while vault locked; keeping the existing PIN.');
        // Still persist (the PIN field itself is unchanged), but a rejection
        // must never vanish: persistSettings also drives settingsSaveState.
        void enqueuePersist(() => persistSettings(next, mirror)).catch((e: unknown) => {
          addLog(
            `Settings persist after blocked PIN change needs attention: ${e instanceof Error ? e.message : String(e)}`
          );
        });
      } else {
        enqueuePersist(() =>
          stageVaultRotation(next.appLockPin)
            .then(() => persistSettings(next, mirror))
            .then(() => commitVaultRotation())
            .then(() => {
              setVaultUnlocked(true);
            })
            .catch((e: unknown) => {
              rollbackVaultRotation();
              throw e;
            })
        ).catch((e: unknown) => {
          addLog(`Vault persist after PIN rotation needs attention: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } else {
      if (!next.appLockEnabled) setVaultUnlocked(true);
      // persistSettings surfaces failures via settingsSaveError + log; this
      // catch only stops the rejection from escaping as unhandled.
      void enqueuePersist(() => persistSettings(next, mirror)).catch((e: unknown) => {
        addLog(`Settings persist failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    // On-device APK: both native mirrors (BootReceiver's autostart flag and
    // renderConfig's provider/credentials) are no longer fired here. They run
    // inside persistSettings and are awaited there, so a bridge rejection
    // lands in settingsSaveError with a Retry instead of vanishing as a log
    // line while the banner reports Saved.
    // Mirror before the state update: settingsRef is otherwise only refreshed
    // during the next render, so a second updateSettings arriving in the same
    // tick would merge on top of the PREVIOUS snapshot and silently drop the
    // change made here (theme, key, provider, anything).
    settingsRef.current = next;
    setSettings(next);
  };

  const unlockSecrets = async (pin: string): Promise<boolean> => {
    const ok = await unlockVault(pin);
    if (!ok) return false;
    try {
      const cipher = localStorage.getItem('hermes_vault');
      if (cipher) {
        let s: Record<string, string>;
        try {
          s = await vaultDecryptSecrets(cipher);
        } catch (e) {
          // Decrypt failure (stale key, tampered envelope): purge the key
          // unlockVault just set, or the UI reads locked while the vault is
          // effectively open. Report failure instead of a half-unlock.
          purgeSessionKey();
          addLog(`Vault unlock failed: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
        const liveSecrets: Record<string, string> = {};
        const providerKeyById: Record<string, string> = {};
        for (const [k, v] of Object.entries(s)) {
          if (k.startsWith('provider.') && k.endsWith('.apiKey')) {
            liveSecrets[k] = v;
            providerKeyById[k.slice('provider.'.length, -'.apiKey'.length)] = v;
          }
        }
        providerSecretsRef.current = liveSecrets;
        const cur = settingsRef.current;
        const providers = (cur.providers || []).map((p) => {
          const ref =
            p.secretRef && p.secretRef.startsWith('provider.') ? p.secretRef : secretRefForProfile(p.id);
          const key = providerKeyById[p.id] ?? liveSecrets[ref] ?? '';
          return { ...p, secretRef: ref, apiKey: key };
        });
        // Legacy flat-shape ciphers predate secretRefs; fold the flat key
        // into the active provider so it is rehydrated, not lost.
        const flatKey = (s.apiKey || '').trim();
        if (flatKey) {
          const active =
            providers.find((p) => p.id === cur.activeProviderId) ||
            providers.find((p) => p.provider === cur.provider);
          if (active && !providerKeyById[active.id]) {
            const ref =
              active.secretRef && active.secretRef.startsWith('provider.')
                ? active.secretRef
                : secretRefForProfile(active.id);
            providerSecretsRef.current = { ...(providerSecretsRef.current || {}), [ref]: flatKey };
            active.secretRef = ref;
            active.apiKey = flatKey;
          }
        }
        const next = {
          ...cur,
          apiKey: flatKey,
          serverKey: s['global.serverKey'] ?? s.serverKey ?? '',
          tgToken: s['global.tgToken'] ?? s.tgToken ?? '',
          discordToken: s['global.discordToken'] ?? s.discordToken ?? '',
          appLockPin: s['global.appLockPin'] ?? s.appLockPin ?? cur.appLockPin,
          providers,
        };
        secretsRef.current = {
          apiKey: next.apiKey,
          serverKey: next.serverKey,
          tgToken: next.tgToken,
          discordToken: next.discordToken,
          appLockPin: next.appLockPin,
        };
        // Mirror now: the render-time settingsRef update lands after the
        // re-render, and any same-tick updateSettings would otherwise merge
        // on top of the still-blanked snapshot and wipe the unlocked keys.
        settingsRef.current = next;
        setSettings(next);
      }
    } catch {
      return false;
    }
    setVaultUnlocked(true);
    return true;
  };

  // Lock-time purge (SEC-03): drop every secret reference (top-level state,
  // per-provider keys, registered holders) and never write secrets while
  // locked. NOTE: secureStore exposes no session-key invalidation, so the
  // WebCrypto key outlives the lock; every reachable copy is blanked here.
  const lockSecrets = () => {
    secretsRef.current = blankSecretHolder();
    providerSecretsRef.current = {};
    purgeAllSecretHolders();
    // The WebCrypto session key outlives every state blanking: without this
    // the vault reads as unlocked after a lock and decrypt keeps working.
    purgeSessionKey();
    setVaultUnlocked(false);
    // Build the blanked snapshot from the ref, not from the pending state:
    // settingsRef is only refreshed during the next render, so an
    // updateSettings landing in this tick would otherwise read the pre-lock
    // serverKey/apiKey/providers from it and persist secrets while locked.
    const cur = settingsRef.current;
    const next: HermesSettings = {
      // Top-level secrets blanked by the shared helper (the same one the
      // persist path uses), so this snapshot cannot reintroduce a key.
      ...blankSecrets(cur),
      providers: (cur.providers || []).map((p) => blankSecrets(p, ['apiKey'])),
    };
    // Legacy no-vault setup: the PIN is the one value this path keeps. It is
    // the only credential AppLockGate compares against, App.tsx re-arms the
    // gate on backgrounding only while settings.appLockPin is still in memory
    // (a gate it could not reopen must not be reopened), and with no vault
    // there is no way to bring a blanked PIN back. That setup already carries
    // the PIN in plaintext, in memory and on disk, so keeping it here exposes
    // nothing new. A vault setup is unchanged: the PIN lives inside the cipher
    // and is blanked above, exactly as before. Applied last so the holder purge
    // above cannot take it straight back out.
    if (!vaultCipherPresent() && cur.appLockPin) {
      next.appLockPin = cur.appLockPin;
      secretsRef.current.appLockPin = cur.appLockPin;
    }
    settingsRef.current = next;
    setSettings(next);
  };

  const vaultUnlockedRef = useRef(vaultUnlocked);
  vaultUnlockedRef.current = vaultUnlocked;

  // Immediate relock entry point for backgrounding or manual lock buttons.
  const lockNow = () => {
    if (!settingsRef.current.appLockEnabled) return;
    lockSecrets();
    addLog('App locked');
  };

  // Relock when the app goes to the background while AppLock is enabled.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && settingsRef.current.appLockEnabled && vaultUnlockedRef.current) {
        lockSecrets();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // providerStore bridge: ConfiguredProvider (settings shape, keeps a
  // transient apiKey mirror for the active profile) <-> ProviderProfile
  // (persistable shape, secretRef only). Every key write funnels through
  // writeProviderCredential via createProvider/updateProvider; this file
  // never writes providerSecretsRef directly.
  const toProfile = (p: ConfiguredProvider): ProviderProfile => ({
    id: p.id,
    provider: p.provider,
    name: p.name,
    ...(p.secretRef ? { secretRef: p.secretRef } : {}),
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    defaultModel: p.defaultModel,
    enabled: p.enabled,
    ...(p.validated !== undefined ? { validated: p.validated } : {}),
  });
  const toConfigured = (p: ProviderProfile, secrets: Record<string, string>): ConfiguredProvider => ({
    id: p.id,
    provider: p.provider,
    name: p.name,
    apiKey: p.secretRef ? secrets[p.secretRef] || '' : '',
    ...(p.secretRef ? { secretRef: p.secretRef } : {}),
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel,
    enabled: p.enabled,
    validated: p.validated,
  });
  const applyStoreResult = (
    list: ProviderProfile[],
    secrets: Record<string, string>
  ): ConfiguredProvider[] => {
    providerSecretsRef.current = secrets;
    return list.map((p) => toConfigured(p, secrets));
  };
  // Erasure tombstones: the secret mirror skips blank keys by design (blank
  // means 'unknown' on boot), so an explicit key deletion would never reach
  // the vault and rehydrate would resurrect it. Refs landed here get one
  // explicit blank write, then leave the set.
  const erasedSecretRefsRef = useRef<Set<string>>(new Set());

  const saveKeys = (
    provider: string,
    key: string,
    model: string,
    baseUrl: string,
    tg: string,
    discord: string,
    serverKey: string,
    autostart: boolean
  ) => {
    const clean = (s: string) => s.trim().replace(/[\r\n]+/g, '');
    const normed = normProvider(clean(provider)) || '';
    const activeKey = clean(key);
    // No silent model fallback: an empty model persists as '' so the picker
    // shows its placeholder instead of inheriting a static id.
    const activeModel = clean(model);

    // Single-write-path sync into the configured list: key material goes
    // through providerStore (writeProviderCredential), never a direct
    // apiKey assignment here.
    const currentProfiles = (settingsRef.current.providers || []).map(toProfile);
    const secrets = getProviderSecrets();
    let updatedList: ConfiguredProvider[];
    let activeId = '';
    const existing = currentProfiles.find((p) => p.provider === normed);
    if (existing) {
      const res = storeUpdateProvider(currentProfiles, existing.id, {
        apiKey: activeKey,
        baseUrl: clean(baseUrl),
        defaultModel: activeModel,
        enabled: true,
        validated: true,
      }, secrets);
      updatedList = applyStoreResult(res.list, res.secrets);
      activeId = existing.id;
      // Same tombstone as the CRUD path: a blanked main-form key must clear
      // the vault slot, or rehydrate resurrects it on the next unlock.
      if (!activeKey) {
        erasedSecretRefsRef.current.add(existing.secretRef || secretRefForProfile(existing.id));
        addLog(`Key erased for provider ${normed}: vault slot queued for removal.`);
      }
    } else {
      const pName = PROVIDER_OPTIONS.find(([id]) => id === normed)?.[1] || normed.toUpperCase();
      const res = createProvider(currentProfiles, {
        provider: normed,
        name: pName,
        apiKey: activeKey,
        baseUrl: clean(baseUrl),
        defaultModel: activeModel,
        enabled: true,
        validated: true,
      }, secrets);
      updatedList = applyStoreResult(res.list, res.secrets);
      activeId = res.id;
    }

    updateSettings({
      provider: normed,
      apiKey: activeKey,
      modelId: activeModel,
      baseUrl: clean(baseUrl),
      tgToken: clean(tg),
      discordToken: clean(discord),
      serverKey: clean(serverKey),
      autostart,
      providers: updatedList,
      activeProviderId: activeId,
    });
    addLog(`Active provider set to ${normed} with ${updatedList.length} provider(s) stored.`);
  };

  // Multi-Provider CRUD methods (all key writes via providerStore).
  const addConfiguredProvider = (prov: Omit<ConfiguredProvider, 'id'>): string => {
    const res = createProvider(
      (settingsRef.current.providers || []).map(toProfile),
      {
        provider: prov.provider,
        name: prov.name,
        apiKey: prov.apiKey ?? '',
        baseUrl: prov.baseUrl || '',
        defaultModel: prov.defaultModel,
        enabled: prov.enabled,
        validated: prov.validated,
      },
      getProviderSecrets()
    );
    const nextList = applyStoreResult(res.list, res.secrets);
    updateSettings({ providers: nextList });
    addLog(`Added provider ${prov.name} (${prov.provider})`);
    return res.id;
  };

  const updateConfiguredProvider = (id: string, updates: Partial<ConfiguredProvider>) => {
    const profiles = (settingsRef.current.providers || []).map(toProfile);
    const res = storeUpdateProvider(profiles, id, {
      ...(updates.provider !== undefined ? { provider: updates.provider } : {}),
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      // apiKey omitted (undefined) leaves the stored key untouched; ''
      // erases it via writeProviderCredential. Never assigned directly.
      ...(updates.apiKey !== undefined ? { apiKey: updates.apiKey } : {}),
      ...(updates.baseUrl !== undefined ? { baseUrl: updates.baseUrl || '' } : {}),
      ...(updates.defaultModel !== undefined ? { defaultModel: updates.defaultModel } : {}),
      ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
      ...(updates.validated !== undefined ? { validated: updates.validated } : {}),
    }, getProviderSecrets());
    const nextList = applyStoreResult(res.list, res.secrets);
    const target = nextList.find((p) => p.id === id);
    // Explicit erasure ('', not omitted) tombstones the vault slot: without
    // this the mirror's blank-means-unknown rule keeps the old entry and
    // rehydrate resurrects a key the user deleted.
    if (updates.apiKey !== undefined && (updates.apiKey || '').trim() === '') {
      const ref = target?.secretRef || secretRefForProfile(id);
      erasedSecretRefsRef.current.add(ref);
      addLog(`Key erased for provider ${target?.name || id}: vault slot queued for removal.`);
    }
    // Sync settings only when the edited profile is the active one,
    // matched by id so duplicate profiles of the same slug do not bleed.
    const activeId = settingsRef.current.activeProviderId;
    const isActiveById = activeId ? target?.id === activeId : target?.provider === settingsRef.current.provider;
    if (target && isActiveById) {
      const cur = settingsRef.current;
      const liveKey = target.secretRef ? (providerSecretsRef.current || {})[target.secretRef] || '' : '';
      updateSettings({
        providers: nextList,
        provider: target.provider,
        apiKey: updates.apiKey !== undefined ? liveKey : cur.apiKey,
        baseUrl: updates.baseUrl !== undefined ? (updates.baseUrl || '') : cur.baseUrl,
        modelId: updates.defaultModel !== undefined ? updates.defaultModel : cur.modelId,
      });
    } else {
      updateSettings({ providers: nextList });
    }
  };

  const removeConfiguredProvider = (id: string) => {
    const target = (settingsRef.current.providers || []).find((p) => p.id === id);
    // removeProvider also erases the profile's vault entry.
    const res = storeRemoveProvider(
      (settingsRef.current.providers || []).map(toProfile),
      id,
      getProviderSecrets()
    );
    // Tombstone the slot: the profile is gone so the mirror loop will not
    // see it, and the leftover flush turns this into a real vault removal.
    if (target?.secretRef) erasedSecretRefsRef.current.add(target.secretRef);
    else erasedSecretRefsRef.current.add(secretRefForProfile(id));
    const nextList = applyStoreResult(res.list, res.secrets);

    // If deleting the active provider, switch to another enabled one.
    // Active is matched by id so same-slug duplicates do not bleed.
    const activeId = settingsRef.current.activeProviderId;
    const isActive = activeId ? target?.id === activeId : target?.provider === settingsRef.current.provider;
    if (target && isActive && nextList.length > 0) {
      const fallback = nextList.find((p) => p.enabled !== false) || nextList[0];
      const fallbackKey = fallback.secretRef
        ? (providerSecretsRef.current || {})[fallback.secretRef] || ''
        : '';
      updateSettings({
        providers: nextList,
        activeProviderId: fallback.id,
        provider: fallback.provider,
        apiKey: fallbackKey,
        baseUrl: fallback.baseUrl || '',
        modelId: fallback.defaultModel,
      });
    } else {
      // Last profile deleted: clear the flat leftovers too, so the header
      // and the model sheet stop naming a provider that no longer exists.
      // The flat change marks credentials dirty, so the mirror tells the
      // native side to drop the deleted key as well.
      updateSettings({
        providers: nextList,
        activeProviderId: '',
        provider: '',
        apiKey: '',
        baseUrl: '',
        modelId: '',
      });
    }
    addLog(`Removed provider profile ${id}`);
  };

  const activateProvider = (id: string, keepModelId?: string) => {
    // Resolution only via the store: no list/secret writes here. The live
    // key resolves from the in-memory secrets map ('' when locked/absent).
    const resolved = storeActivateProvider(
      (settingsRef.current.providers || []).map(toProfile),
      id,
      getProviderSecrets()
    );
    if (!resolved) return;

    const keep = (keepModelId || '').trim();
    let nextProviders = settingsRef.current.providers || [];
    if (resolved.profile.enabled === false) {
      nextProviders = nextProviders.map((p) =>
        p.id === resolved.profile.id ? { ...p, enabled: true } : p
      );
    }
    updateSettings({
      providers: nextProviders,
      activeProviderId: resolved.profile.id,
      provider: resolved.profile.provider,
      apiKey: resolved.apiKey,
      baseUrl: resolved.profile.baseUrl || '',
      modelId: keep || resolved.profile.defaultModel,
    });
    addLog(`Switched active inference endpoint to ${resolved.profile.name} (${resolved.profile.provider})`);
  };

  // Toggle Pinned
  const togglePin = (id: string) => {
    const prev = pinnedIds;
    const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
    try {
      localStorage.setItem('hermes_pinned_sessions', JSON.stringify(next));
    } catch {}
    setPinnedIds(next);
  };

  // Drafts (persisted per session so input survives refresh)
  const getDraft = (sid: string | null) => {
    const key = sid || 'none';
    if (drafts[key] !== undefined) return drafts[key];
    try {
      return localStorage.getItem(`hermes_draft_${key}`) || '';
    } catch {
      return '';
    }
  };

  const setDraft = (sid: string | null, text: string) => {
    const key = sid || 'none';
    try {
      if (text) localStorage.setItem(`hermes_draft_${key}`, text);
      else localStorage.removeItem(`hermes_draft_${key}`);
    } catch {}
    setDrafts((prev) => {
      const next = { ...prev, [key]: text };
      const keys = Object.keys(next);
      if (keys.length > 50) {
        for (const old of keys.slice(0, keys.length - 50)) {
          delete next[old];
          try {
            localStorage.removeItem(`hermes_draft_${old}`);
          } catch {}
        }
      }
      return next;
    });
  };

  // On-device server key adoption. The Capacitor bridge registers its plugin
  // asynchronously and SecurePrefs may still be minting the key, so one
  // boot-time read can come back empty while the native side already holds a
  // 48-character key: every call then went out keyless and the UI read
  // 'unreachable'. Callers that need auth await this instead: it waits for
  // the bridge, retries an empty answer, and backs off after a failed round
  // so a device with no key does not stall each request.
  const keyAttemptRef = useRef<Promise<string> | null>(null);
  const keyRetryAtRef = useRef(0);
  const ensureServerKey = (): Promise<string> => {
    const held = () => secretsRef.current.serverKey || settingsRef.current.serverKey;
    if (held()) return Promise.resolve(held());
    if (!isNativeGateway()) return Promise.resolve('');
    if (keyAttemptRef.current) return keyAttemptRef.current;
    if (Date.now() < keyRetryAtRef.current) return Promise.resolve('');
    const attempt = nativeServerKey()
      .then((k) => {
        if (!k) {
          keyRetryAtRef.current = Date.now() + SERVER_KEY_RETRY_COOLDOWN_MS;
          addLog(
            'Local gateway key unavailable on the device. Authenticated calls may fail until Settings holds the key.'
          );
          return '';
        }
        // Adopt into the refs as well as settings: the request that waited
        // for this answer must not read the pre-render value.
        secretsRef.current = { ...secretsRef.current, serverKey: k };
        settingsRef.current = { ...settingsRef.current, serverKey: k };
        updateSettings({ serverKey: k });
        addLog('Local gateway key adopted from the device.');
        return k;
      })
      .catch((e: unknown) => {
        keyRetryAtRef.current = Date.now() + SERVER_KEY_RETRY_COOLDOWN_MS;
        addLog(`Local gateway key read failed: ${plainServiceFailure(e)}`);
        return '';
      })
      .finally(() => {
        keyAttemptRef.current = null;
      });
    keyAttemptRef.current = attempt;
    return attempt;
  };

  // S1 rehydrate + one-time migration (native only). SecurePrefs is the
  // single source of truth for secrets; localStorage keeps the sanitized
  // public copy. For each slot: native wins, legacy plaintext migrates up
  // when the slot is empty, then the stored copy is rewritten sanitized so
  // no key or token survives on disk. Memory merges trigger one rerender;
  // the provider-secrets cache is reset so it reseeds from the merged list.
  const rehydrateSecretsFromNative = async (): Promise<void> => {
    if (!isNativeGateway()) return;
    try {
      let stored: Record<string, unknown> = {};
      try {
        const raw = localStorage.getItem('hermes_settings');
        if (raw) stored = JSON.parse(raw) as Record<string, unknown>;
      } catch {}
      const cur = settingsRef.current;
      const merged: Record<string, unknown> = {};
      let changed = false;
      const takeSlot = async (slot: string, legacy: string): Promise<string> => {
        let val = (await nativeSecretGet(slot)) || '';
        if (!val.trim() && legacy) {
          // Verify the migration write: a failed set that still returns the
          // legacy value would claim a migration that never landed.
          const ok = await nativeSecretSet(slot, legacy);
          if (!ok) throw new Error(`native secret migration failed for ${slot}`);
          val = legacy;
        }
        return val;
      };
      const globals = ['serverKey', 'tgToken', 'discordToken'] as const;
      // appLockPin is deliberately NOT rehydrated when a vault cipher exists:
      // the vault path verifies from the user's entry, and pulling the PIN
      // into JS memory pre-unlock would expose it to any script running in
      // the WebView. Legacy no-vault setups have no cipher, so the PIN is
      // the only gate key and must come back.
      if (!vaultCipherPresent()) {
        const legacyPin = typeof stored.appLockPin === 'string' ? (stored.appLockPin as string) : '';
        const pin = await takeSlot('global.appLockPin', legacyPin);
        const livePin = (cur as unknown as Record<string, unknown>).appLockPin || '';
        if (pin && pin !== livePin) {
          merged.appLockPin = pin;
          changed = true;
        }
      }
      for (const name of globals) {
        const legacy = typeof stored[name] === 'string' ? (stored[name] as string) : '';
        const val = await takeSlot(`global.${name}`, legacy);
        const live = (cur as unknown as Record<string, unknown>)[name] || '';
        if (val && val !== live) {
          merged[name] = val;
          changed = true;
        }
      }
      const profiles = Array.isArray(cur.providers) ? cur.providers : [];
      const storedProviders = Array.isArray(stored.providers)
        ? (stored.providers as Array<Record<string, unknown>>)
        : [];
      if (profiles.length > 0) {
        const nextProviders = [];
        for (const p of profiles) {
          const prof = p as ConfiguredProvider;
          const ref = secretRefForProfile(prof.id);
          const sp = storedProviders.find((s) => s && s.id === prof.id);
          const legacy = sp && typeof sp.apiKey === 'string' ? (sp.apiKey as string) : '';
          const val = await takeSlot(ref, legacy);
          if ((val || '') !== (prof.apiKey || '')) {
            nextProviders.push({ ...prof, apiKey: val || '' });
            changed = true;
          } else {
            nextProviders.push(prof);
          }
        }
        if (changed) {
          merged.providers = nextProviders;
          const activeId = cur.activeProviderId;
          const activeProf = nextProviders.find((p) => (activeId ? p.id === activeId : p.provider === cur.provider));
          if (activeProf && activeProf.apiKey) {
            merged.apiKey = activeProf.apiKey;
          }
        }
      }
      if (changed) {
        const next = { ...settingsRef.current, ...merged } as HermesSettings;
        settingsRef.current = next;
        providerSecretsRef.current = null;
        setSettings(next);
      }
      try {
        const raw = localStorage.getItem('hermes_settings');
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          localStorage.setItem('hermes_settings', JSON.stringify(sanitizeForPersist(parsed)));
        }
      } catch {}
    } catch (e) {
      addLog(`Native secret rehydrate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Initial data load once on boot. The models list below aggregates every
  // configured provider, so it must not refetch when the active provider
  // or model selection changes.
  useEffect(() => {
    // Secrets rehydrate inside the native boot chain below (awaited before
    // the mirror), never fire-and-forget: see the ordering comment there.
    // On-device: adopt the minted local-API key before the first request.
    // ensureServerKey retries a bridge that answers late or empty, and
    // refreshNow below awaits the same attempt, so the keyless first pass
    // this effect used to make can no longer happen.
    const keyReady = isNativeGateway() ? ensureServerKey() : Promise.resolve('');

    // On-device: push the already-saved web provider/key into the native
    // prefs once, so upgrades do not leave the gateway on a stale provider.
    // It waits for the adoption above: mirroring first would push the blank
    // web serverKey over the key the native side already minted.
    // The rehydrate above is awaited first: the stored settings copy is
    // sanitized (blank secrets), so mirroring before it lands would wipe the
    // native provider key with blanks, most dangerously on a vault-locked
    // boot where memory holds no secrets at all.
    if (isNativeGateway()) {
      // Upgrade path: push whatever the web side already saved, credentials
      // included, so the first gateway start after an update is not stale.
      keyReady
        .catch(() => '')
        .then(() => rehydrateSecretsFromNative())
        .then(() => mirrorCredentialsToNative(settingsRef.current, 'boot sync'))
        // Boot is not a save path, so there is no settingsSaveError to fold
        // the rejection into; the mirror already logged its own cause and
        // this only keeps it from escaping as an unhandled rejection.
        .catch(() => undefined);
    }
    refreshNowRef.current();
    // Pending approvals startup: show the cached list instantly (offline
    // boot included), then reconcile with the gateway's live list. Cached
    // entries for runs the gateway no longer reports are dropped, so a
    // reload never resurrects resolved approvals.
    const cachedPending = loadCachedPending();
    setApprovals(cachedPending);
    approvalsHydratedRef.current = true;
    cachePending(cachedPending);
    // Everything cached at this instant is older than the fetch: rows with a
    // createdAt past this mark arrived while the fetch was in flight (an SSE
    // approval racing the poll) and must survive one reconcile round.
    const fetchStart = Date.now();
    gatewayService
      .listPendingApprovals()
      .then((fresh) => {
        // Reconcile only against a live answer: when the gateway is down
        // fresh.live is false and the cached cards stand (an empty list and
        // a dead server must never look the same in a security surface).
        if (!fresh.live) {
          addLog('Approvals kept from cache: gateway did not answer.');
          return;
        }
        // Reconcile against the CURRENT list, not the startup snapshot: the
        // cached array captured above is stale the moment an SSE approval
        // lands, and a plain setApprovals(merged) would drop it.
        setApprovals((prev) => {
          const merged = reconcilePending(prev, fresh.items, fetchStart);
          cachePending(merged);
          return merged;
        });
      })
      .catch(() => {
        // Offline gateway: the cached list stands; refreshNow logged health.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic catalog refresh cadence (opencode-go and other providers add models often)
  const MODEL_CATALOG_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

  // Dependency key: changes when active provider, active profile ID, credentials / keys,
  // base URLs, default models, or provider enabled status change.
  // This ensures key rotation, profile switching, and provider additions immediately
  // trigger a fresh catalog fetch.
  const providersKey = useMemo(() => {
    const secrets = providerSecretsRef.current || {};
    const list = (settings.providers || [])
      .map((p) => {
        const k = (p.secretRef ? secrets[p.secretRef] : p.apiKey) || '';
        return `${p.id}:${normProvider(p.provider)}:${p.enabled !== false}:${p.baseUrl || ''}:${p.defaultModel || ''}:${k ? 'k:' + k : 'noKey'}`;
      })
      .join(';');
    const activeKey = (settings.apiKey || '').trim();
    return `${normProvider(settings.provider || '')}:${settings.activeProviderId || ''}:${activeKey ? 'k:' + activeKey : 'noActiveKey'};${list}`;
  }, [settings.provider, settings.activeProviderId, settings.apiKey, settings.providers]);

  // Model catalog refresh, callable from the models sheet and periodic cadence.
  // Queries live catalog first (source of truth); uses DEFAULT_MODELS only as offline fallback.
  const refreshModels = useCallback(async () => {
    // Auth first: the local gateway rejects keyless /api/model/options with
    // 401, which the sheet would then misread as 'no models'. Awaiting here
    // covers every caller (sheet open, manual refresh, cadence, visibility).
    await ensureServerKey();
    const activeProvider = normProvider(settingsRef.current.provider || '');
    const configuredList = settingsRef.current.providers || [];
    const selectedModel = settingsRef.current.modelId;

    setModelsLiveInfo((prev) => ({ ...prev, isRefreshing: true }));

    const activeProviderKeys = new Set<string>();
    if (activeProvider) {
      activeProviderKeys.add(activeProvider);
    }
    for (const prov of configuredList) {
      if (prov.enabled !== false && prov.provider) {
        activeProviderKeys.add(normProvider(prov.provider));
      }
    }

    const modelMap = new Map<string, AiModelInfo>();
    const liveModelsByProvider = new Map<string, AiModelInfo[]>();

    // 1. Fetch live catalog.
    // Query general endpoint first (some gateways answer unfiltered or with all models)
    try {
      const globalLive = await gatewayService.modelOptions('');
      for (const m of globalLive) {
        const prov = normProvider(m.provider || activeProvider);
        if (!liveModelsByProvider.has(prov)) liveModelsByProvider.set(prov, []);
        liveModelsByProvider.get(prov)!.push({ ...m, provider: prov, source: 'live' });
      }
    } catch {}

    // 2. For each configured provider that yielded 0 models in the global fetch,
    // query specifically with ?provider= hint so provider-specific adapters
    // (e.g. opencode-go) return their full model catalog.
    for (const provKey of activeProviderKeys) {
      const existing = liveModelsByProvider.get(provKey);
      if (!existing || existing.length === 0) {
        try {
          const provLive = await gatewayService.modelOptions(provKey);
          if (provLive.length > 0) {
            const list = provLive.map((m) => ({ ...m, provider: provKey, source: 'live' as const }));
            liveModelsByProvider.set(provKey, list);
          }
        } catch {}
      }
    }

    let totalLiveCount = 0;
    let totalFallbackCount = 0;

    // 3. For every active/configured provider, resolve models live-first.
    // If live models exist, use them. Otherwise, fall back to DEFAULT_MODELS.
    for (const provKey of activeProviderKeys) {
      const liveList = liveModelsByProvider.get(provKey) || [];
      if (liveList.length > 0) {
        for (const m of liveList) {
          if (!modelMap.has(m.id)) {
            modelMap.set(m.id, m);
            totalLiveCount++;
          }
        }
      } else {
        const fallbackList = staticModelsFor(provKey).models;
        for (const id of fallbackList) {
          if (!modelMap.has(id)) {
            modelMap.set(id, {
              id,
              displayName: formatFallbackDisplayName(id),
              provider: provKey,
              source: 'offline-fallback',
            });
            totalFallbackCount++;
          }
        }
      }
    }

    // 4. Add custom defaultModel from configured providers if not already present
    for (const prov of configuredList) {
      if (prov.enabled === false) continue;
      if (prov.defaultModel && !modelMap.has(prov.defaultModel)) {
        modelMap.set(prov.defaultModel, {
          id: prov.defaultModel,
          displayName: formatFallbackDisplayName(prov.defaultModel),
          provider: normProvider(prov.provider),
          source: 'offline-fallback',
        });
      }
    }

    // 5. Ensure current selected model is present in the list
    if (selectedModel && !modelMap.has(selectedModel)) {
      modelMap.set(selectedModel, {
        id: selectedModel,
        displayName: formatFallbackDisplayName(selectedModel),
        provider: activeProvider,
        source: 'offline-fallback',
      });
    }

    setModels(Array.from(modelMap.values()));
    setModelsLiveInfo({
      error: gatewayService.lastModelsError,
      liveCount: totalLiveCount,
      fallbackCount: totalFallbackCount,
      lastRefreshedAt: Date.now(),
      isRefreshing: false,
    });
  }, [gatewayService]);

  useEffect(() => {
    void refreshModels();
  }, [gatewayService, providersKey, refreshModels]);

  // Periodic catalog refresh cadence and document visibility listener.
  // opencode-go and other providers add models often.
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshModels();
    }, MODEL_CATALOG_REFRESH_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshModels();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshModels]);

  // Streaming elapsed timer
  useEffect(() => {
    if (streaming) {
      const start = Date.now();
      setStreamElapsed(0);
      streamTimerRef.current = setInterval(() => {
        setStreamElapsed(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    } else {
      if (streamTimerRef.current) clearInterval(streamTimerRef.current);
      setStreamElapsed(0);
    }
    return () => {
      if (streamTimerRef.current) clearInterval(streamTimerRef.current);
    };
  }, [streaming]);

  // An authenticated endpoint rejecting our stored key while /health still
  // answers means the key is stale, not that the gateway is down. Mark the
  // machine failed with a distinct 'unauthorized' kind so the UI stops
  // reporting everything as fine. Every call is logged truthfully.
  const markGatewayUnauthorized = (source: string, status?: number) => {
    setGatewayFailed(true);
    setGatewayFailureKind('unauthorized');
    // A rejected key is not a connection: leaving connected=true paints the
    // header green while every authenticated call fails.
    setConnected(false);
    setGatewayFailureReason(
      tx(
        'errGatewayKeyRejected',
        'Hermes rejected the stored key. Check the key and Base URL in Settings, then retry.'
      )
    );
    addLog(
      `Gateway rejected an authenticated request (${source}${status ? `, HTTP ${status}` : ''}); the stored key may be stale.`
    );
  };

  const authStatusFromError = (text: string | undefined): number | undefined => {
    const m = /\bhttp\s*(40[13])\b/i.exec(text || '');
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  };

  const refreshNow = async () => {
    const token = ++refreshTokenRef.current;
    const alive = () => token === refreshTokenRef.current;
    // Snapshot of what is currently cached, so the offline catch below can
    // serve it honestly as stale (U12) instead of leaving lists unloadable.
    const cachedCounts = {
      sessions: sessionsRef.current.length,
      jobs: jobs.length,
      skills: skills.length,
      blueprints: blueprints.length,
      memory: memory ? 1 : 0,
    };
    // Loading flags up front: first load shows loading, refetch with cached
    // items shows refreshing. lastSyncedAt is preserved until fresh data lands.
    setListsMeta((prev) => {
      const next: ListSyncMetaMap = { ...prev };
      for (const [k, count] of Object.entries(cachedCounts)) {
        next[k] = {
          live: false,
          stale: prev[k]?.stale ?? false,
          error: '',
          lastSyncedAt: prev[k]?.lastSyncedAt ?? null,
          uiState: count > 0 ? 'refreshing' : 'loading',
        };
      }
      return next;
    });
    try {
      // Re-check the on-device key before any authenticated call: a bridge
      // that answered late must not leave this refresh keyless.
      if (isNativeGateway() && !settingsRef.current.serverKey) {
        await ensureServerKey();
      }
      // On-device the WebView fetch can be blocked (mixed content), so ask
      // the native side, which probes 127.0.0.1:8080 directly.
      const isOk = isNativeGateway() ? await nativeHealth() : await gatewayService.health();
      if (!alive()) return;
      setConnected(isOk);
      // Nothing else ever moves the legacy install flag on the web: it boots
      // as RUNNING for onboarded installs and the web build has no
      // supervision poll, so a failed probe left Home/Header reporting
      // "starting" forever instead of offline. Resolve it here. Web only:
      // on-device the start flows own that transition.
      if (!isOk && !isNativeGateway()) {
        setInstall((prev) => (prev === 'RUNNING' ? 'INSTALLED' : prev));
      }
      const status = await gatewayService.healthDetailed();
      if (!alive()) return;
      setGatewayStatus(status);
      // Sessions through the sync envelope (DATA-01/03): the server page is
      // authoritative and its stale/live/error ships to listsMeta. The
      // local-only merge below keeps sessions created while offline that
      // the gateway has not confirmed yet.
      const sessPage = await gatewayService.fetchSessionsPage({ limit: 100, offset: 0 });
      if (!alive()) return;
      const sessList = sessPage.items;
      setListMeta('sessions', sessPage, sessList.length, {
        loading: sessionsRef.current.length === 0,
        refreshing: sessionsRef.current.length > 0,
      });
      // Merge instead of wholesale clobber so locally created sessions survive.
      const localOnly = sessionsRef.current.filter(
        (ls) => !sessList.some((s) => s.id === ls.id)
      );
      const merged = [...localOnly, ...sessList];
      sessionsRef.current = merged;
      setSessions(merged);
      // Authenticated call rejected while /health (checked above) answered:
      // the stored key is stale, not the gateway. Say so instead of leaving
      // the UI claiming everything is fine.
      const sessionsAuthStatus = authStatusFromError(sessPage.error);
      if (sessionsAuthStatus) {
        markGatewayUnauthorized('sessions list', sessionsAuthStatus);
      } else if (sessPage.live) {
        // Health and the authenticated sessions list both answered, so any
        // older failure banner is stale: clear it truthfully.
        setGatewayFailed(false);
        setGatewayFailureReason(null);
        setGatewayFailureKind(null);
      }
      const jobsRes: ListSyncResult<CronJob> = await gatewayService.jobsWithState();
      if (!alive()) return;
      setJobs(jobsRes.items);
      setListMeta('jobs', jobsRes, jobsRes.items.length, {
        loading: jobsRes.items.length === 0 && !jobsRes.live && !jobsRes.stale,
      });
      const jobsAuthStatus = authStatusFromError(jobsRes.error);
      if (jobsAuthStatus) markGatewayUnauthorized('jobs list', jobsAuthStatus);
      const skillsRes = await gatewayService.skillsWithState();
      if (!alive()) return;
      setSkills(skillsRes.items);
      setListMeta('skills', skillsRes, skillsRes.items.length, {});
      const blueprintsRes = await gatewayService.blueprintsWithState();
      if (!alive()) return;
      setBlueprints(blueprintsRes.items);
      setListMeta('blueprints', blueprintsRes, blueprintsRes.items.length, {});
      const memRes = await gatewayService.memoryGet();
      if (!alive()) return;
      setMemory({
        enabled: memRes.enabled,
        provider: memRes.provider,
        summary: memRes.summary,
        entries: memRes.entries,
      });
      setListMeta(
        'memory',
        {
          live: memRes.live,
          stale: memRes.stale,
          error: memRes.live ? undefined : memRes.summary,
          lastSyncedAt: memRes.live ? Date.now() : readSyncedAt(GatewayService.SYNC_KEYS.memory),
        },
        memRes.entries
      );
      if (!memRes.live) addLog(`Memory unavailable: ${memRes.summary}`);
      // Keep the current session; only auto-select when none is active.
      // Revalidate: the current id may have been deleted server-side while
      // we were away. Fall back to the newest instead of an empty chat.
      const cur = currentSessionIdRef.current;
      if (cur && merged.some((m) => m.id === cur)) {
        const msgs = gatewayService.loadLocalMessages(cur);
        setChat(msgs);
        // Restore the persisted per-turn badges with the messages, so a
        // stopped or estimated turn still reads as stopped after a reload.
        hydrateTurnMeta(cur);
      } else if (merged.length > 0) {
        selectSession(merged[0].id);
      }
    } catch {
      if (!alive()) return;
      setConnected(false);
      // Offline with cache: emit stale envelopes (U12) so list screens show
      // "offline, showing cached data" + lastSyncedAt instead of hanging on
      // loading. No cache: emit error envelopes. Copy is cause + action with
      // no addresses, ports, or log-file internals (U15).
      const offlineError = (count: number) =>
        count > 0
          ? 'Gateway unreachable. Showing cached data, pull to retry.'
          : 'Gateway unreachable. Check the gateway status and retry.';
      setListsMeta((prev) => {
        const next: ListSyncMetaMap = { ...prev };
        for (const [k, count] of Object.entries(cachedCounts)) {
          const stale = count > 0;
          const meta = { live: false, stale, error: offlineError(count) };
          next[k] = {
            live: false,
            stale,
            error: meta.error,
            lastSyncedAt: prev[k]?.lastSyncedAt ?? null,
            uiState: resolveListUiState(meta, count),
          };
        }
        return next;
      });
    }
  };

  // Long-lived effects (boot refresh, autostart, native supervision poll)
  // capture the FIRST render's refreshNow, whose jobs/skills/blueprints/
  // memory reads are frozen at their initial empty values. Every caller that
  // outlives a render goes through this ref so list envelopes are computed
  // from live data instead of the boot snapshot (offline refreshes used to
  // report "loading / gateway unreachable" over cached data because of it).
  const refreshNowRef = useRef<() => Promise<void>>(() => Promise.resolve());
  refreshNowRef.current = refreshNow;

  const startGateway = async () => {
    addLog('Starting Hermes gateway daemon');
    // Leave the install state alone on-device: the wizard shows its Continue
    // button only for INSTALLED, and 'RUNNING' would strand the user there.
    if (!isNativeGateway()) setInstall('RUNNING');
    setGatewayFailed(false);
    setGatewayFailureReason(null);
    setGatewayFailureKind(null);
    // A fresh attempt is under way, so the previous run's start verdict no
    // longer describes reality; this one sets its own (the timeout path
    // below, or null on any other outcome).
    setStartFailure(null);
    // On-device APK: start the real gateway process via the native runner.
    if (isNativeGateway()) {
      // Pre-start sync: the gateway reads the provider key once at process
      // start, so a key saved by a path that missed the mirror (or an old
      // wipe) would otherwise boot a live-but-keyless gateway that answers
      // nothing. Blank fields mean 'leave stored alone', so this can only
      // add, never remove. A failed sync must not block the start: the
      // stored prefs may still be good.
      try {
        await mirrorCredentialsToNative(settingsRef.current, 'pre-start sync');
      } catch {
        addLog('Pre-start credential sync failed, starting with stored settings');
      }
      try {
        await nativeStart();
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        // The banner takes plain copy; the raw platform text stays in the log
        // where a support dump can read it.
        const reason = plainGatewayFailure(raw, tx);
        setConnected(false);
        setGatewayFailed(true);
        // A 401/403 start failure is a rejected key: the kind keeps the auth
        // state visible even though the reason itself is plain copy.
        setGatewayFailureKind(/\b(?:401|403)\b/.test(raw) ? 'unauthorized' : 'start');
        setGatewayFailureReason(reason);
        addLog(`Gateway start failed: ${raw}`);
        return;
      }
      // First boot prepares the runtime inside proot (minutes). Poll health
      // instead of probing once, or the UI reports failure while boot is
      // still in progress.
      addLog('Gateway process starting, waiting for health');
      let nativeHealthy = false;
      for (let i = 0; i < 48; i++) {
        try {
          if (await nativeHealth()) {
            nativeHealthy = true;
            break;
          }
        } catch {
          /* not up yet */
        }
        if (i % 6 === 5) addLog(`Still waiting for gateway (${(i + 1) * 5}s)`);
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (nativeHealthy) {
        setConnected(true);
        setInstall('INSTALLED');
        setInstallProgress('');
        setStartFailure(null);
        // Record what this process booted with: the auto-heal effect below
        // compares it against live settings and restarts on drift.
        try {
          bootCredSigRef.current = nativeBootSig(resolveNativeProviderPayload(settingsRef.current));
        } catch {
          bootCredSigRef.current = null;
        }
        addLog('Gateway running');
        refreshNowRef.current();
      } else {
        setConnected(false);
        setGatewayFailed(true);
        setGatewayFailureKind('unhealthy');
        setInstall('FAILED');
        setInstallProgress('');
        // The image installed fine; only the service failed to come up.
        // Consumers read this token to say so instead of reprinting install
        // copy that claims nothing was installed.
        setStartFailure(START_FAILURE_START_TIMEOUT);
        const reason = 'Gateway did not start within 4 minutes. Press Retry to try again.';
        setGatewayFailureReason(reason);
        setInstallError(reason);
        addLog(reason);
      }
      return;
    }
    let healthy = false;
    try {
      healthy = await gatewayService.health();
    } catch {
      healthy = false;
    }
    if (healthy) {
      setConnected(true);
      // Mirror the native branch: a verified start resolves the legacy flag
      // to INSTALLED instead of leaving it stuck on RUNNING (the web build
      // has no supervision poll to ever move it out again, so a later
      // disconnect would keep reporting "starting" instead of offline).
      setInstall('INSTALLED');
      setStartFailure(null);
      addLog('Gateway running');
      refreshNowRef.current();
    } else {
      setConnected(false);
      setGatewayFailed(true);
      setGatewayFailureKind('unhealthy');
      // Same reason, opposite outcome: the start failed, so RUNNING is no
      // longer true. Not FAILED, because nothing was installed wrongly and
      // the Home retry CTA must stay on "restart".
      setInstall('INSTALLED');
      const reason = 'Gateway start failed: the health check did not pass. Press Retry to try again.';
      setGatewayFailureReason(reason);
      addLog(reason);
    }
  };

  const stopGateway = async () => {
    await stopStream();
    // On-device APK: stop the real gateway process via the native runner,
    // then verify before reporting STOPPED. nativeGateway.ts exposes only
    // stop()/status(), so the verified-stop lives here: stop, then poll
    // nativeStatus() until the machine settles.
    if (isNativeGateway()) {
      try {
        await nativeStop();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        addLog(`Gateway stop failed: ${reason}`);
        return;
      }
      let verified: GatewayState | null = null;
      for (let i = 0; i < 10; i++) {
        try {
          const rep = await nativeStatus();
          const mapped = mapNativeStatusToGatewayState({
            running: rep.running,
            state: rep.state,
          });
          if (mapped === 'STOPPED' || (!rep.running && mapped === 'INSTALLED')) {
            verified = 'STOPPED';
            break;
          }
          if (mapped === 'RUNNING' || mapped === 'STARTING') {
            // Still up; keep waiting for the process to exit.
          } else {
            verified = mapped;
            break;
          }
        } catch {
          // Status bridge unavailable mid-stop; treat a closed health
          // probe as exited below.
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (verified === null) {
        try {
          if (!(await nativeHealth())) verified = 'STOPPED';
        } catch {}
      }
      if (verified === 'STOPPED') {
        setGatewayState('STOPPED');
        setInstall('INSTALLED');
        setConnected(false);
        addLog('Gateway process terminated by user (stop verified)');
      } else {
        // Never report STOPPED on an unverified stop: the process may
        // still be running and the UI would lie about it.
        addLog(
          `Gateway stop sent but not verified (state: ${verified || 'unknown'}). ` +
            'The process may still be running.'
        );
      }
      return;
    }
    setInstall('INSTALLED');
    setConnected(false);
    addLog('Gateway process terminated by user');
  };

  // Native gateway supervision: poll nativeStatus() into the single machine
  // and derive the UI flags from it. Transitional states poll fast (2s);
  // stable states poll slow (15s). Web builds have no native bridge and
  // skip polling entirely.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The Capacitor bridge can register a beat after this effect runs, so
    // keep looking for it instead of skipping native supervision for the
    // whole session: without this poll the machine never moves and a late
    // bridge never gets another key adoption attempt.
    let bridgeWait = 0;
    const applyState = (mapped: GatewayState) => {
      setGatewayState(mapped);
      gatewayStateRef.current = mapped;
      if (mapped === 'RUNNING') {
        setConnected(true);
        // The service is up, so the legacy flag resolves to INSTALLED. It can
        // be parked on a transitional INSTALLING below (relaunch in the middle
        // of a start) or on FAILED left by a start timeout, and either one
        // would contradict the RUNNING state on screen. A healthy run also
        // retires any start-failure verdict from an earlier attempt.
        setInstall('INSTALLED');
        setStartFailure(null);
      } else if (
        mapped === 'STOPPED' ||
        mapped === 'INSTALLED' ||
        mapped === 'NOT_INSTALLED'
      ) {
        setConnected(false);
        setInstall(toLegacyInstallState(mapped) as InstallState);
      } else if (mapped === 'FAILED' || mapped === 'DEGRADED') {
        setConnected(false);
        setInstall(toLegacyInstallState(mapped) as InstallState);
      } else if (
        mapped === 'INSTALLING' ||
        mapped === 'CHECKING' ||
        mapped === 'STARTING' ||
        mapped === 'STOPPING'
      ) {
        // Transitional states used to fall through every branch, so a relaunch
        // mid-install kept the first-paint value and the setup guards never
        // armed. Fold them into the legacy INSTALLING flag: the machine state
        // above still carries the exact phase (Installing, Starting, Stopping)
        // for the status surfaces, and the next RUNNING or FAILED report
        // overwrites this flag with the real outcome.
        setInstall('INSTALLING');
      }
    };
    const poll = async () => {
      if (cancelled) return;
      if (!isNativeGateway()) {
        bridgeWait += 1;
        // Up to 30s of bridge discovery before supervision gives up.
        if (bridgeWait < 60) timer = setTimeout(poll, 500);
        return;
      }
      // Re-check the on-device key while this WebView holds none: adoption
      // refreshes the lists, so the app does not stay keyless once the
      // native side has a key (ensureServerKey cools itself down).
      if (!settingsRef.current.serverKey) {
        ensureServerKey().then((adopted) => {
          if (adopted && !cancelled) refreshNowRef.current();
        });
      }
      try {
        const rep = await nativeStatus();
        if (cancelled) return;
        const mapped = mapNativeStatusToGatewayState({
          running: rep.running,
          state: rep.state,
        });
        applyState(mapped);
        const fast = isTransitional(mapped);
        timer = setTimeout(poll, fast ? 2000 : 15000);
      } catch {
        if (cancelled) return;
        // Status bridge hiccup: retry fast once, the machine keeps its
        // last known value instead of flapping to failure.
        timer = setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autostart the gateway once on boot when the setting is enabled.
  // The ref guard keeps StrictMode double-effects and re-renders
  // from starting it more than once.
  const autostartedRef = useRef(false);
  useEffect(() => {
    if (autostartedRef.current) return;
    if (!settingsRef.current.autostart || !settingsRef.current.onboarded) return;
    autostartedRef.current = true;
    addLog('Autostart enabled, starting gateway');
    startGateway().catch(() => {
      // startGateway publishes its own failure state and plain copy;
      // this only stops a late rejection from escaping unhandled.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-heal: a key/provider change saved while the gateway runs leaves the
  // process on stale credentials (empty model list) until someone restarts
  // it by hand. When connected with a fingerprint the boot signature does
  // not match, restart once automatically so the new key applies itself.
  // No user-facing copy: this surfaces only as a log line.
  useEffect(() => {
    if (!connected || !isNativeGateway()) return;
    if (autoHealInFlightRef.current) return;
    let sig: string;
    try {
      sig = nativeBootSig(resolveNativeProviderPayload(settingsRef.current));
    } catch {
      return;
    }
    if (!bootCredSigRef.current) {
      bootCredSigRef.current = sig;
      return;
    }
    if (sig === bootCredSigRef.current) return;
    if (autoHealForRef.current === sig) return;
    autoHealForRef.current = sig;
    autoHealInFlightRef.current = true;
    addLog('Provider credentials changed while the gateway is running; restarting to apply them.');
    (async () => {
      try {
        await stopGateway();
      } catch {
        // stopGateway reports its own failure; still try to start fresh.
      }
      try {
        await startGateway();
      } catch {
        // startGateway publishes its own failure state; the manual retry
        // stays the fallback for this fingerprint.
      }
      autoHealInFlightRef.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, settings]);

  const installGateway = async () => {
    setInstall('INSTALLING');
    setInstallError(null);
    // A real install attempt supersedes any earlier start-timeout verdict:
    // from here on the install outcome is what the UI must report.
    setStartFailure(null);
    // On-device APK: run the real one-shot image install via the native
    // runner (download + sha256 verify + extract + proot). Logs stream live.
    if (isNativeGateway()) {
      setInstallProgress('Downloading hermes-image (~305MB)');
      addLog('Download started from repository manifest');
      let res: { ok: boolean; error?: string };
      try {
        res = await nativeInstall(
          (line) => addLog(line),
          (downloaded, total) => {
            const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
            setInstallProgress(`Installing on-device image (${pct}%)`);
          }
        );
      } catch (e) {
        // The wizard fires installGateway() without a catch, and a bridge
        // that dies mid-install must not strand the state on INSTALLING.
        // Report FAILED with plain copy instead of rejecting the caller.
        const raw = e instanceof Error ? e.message : String(e);
        setInstall('FAILED');
        setInstallProgress('');
        setInstallError(
          plainResultLine(raw, 'On-device install failed. Press Retry to try again.', tx)
        );
        setConnected(false);
        addLog(`Install failed: ${raw}`);
        return;
      }
      if (!res.ok) {
        setInstall('FAILED');
        setInstallProgress('');
        setInstallError(
          plainResultLine(
            res.error || '',
            'On-device install failed. Press Retry to try again.',
            tx
          )
        );
        setConnected(false);
        addLog(`Install failed: ${res.error || 'unknown error'}`);
        return;
      }
      // Install done only means the image is on disk; the gateway is not
      // running yet, so a health probe here would fail spuriously. Hand off
      // to startGateway, which boots the real process then probes honestly.
      setInstallProgress('Image ready, starting gateway');
      addLog('Installed Hermes rootfs OK, starting gateway');
      await startGateway();
      return;
    } else {
      // Web preview has no local installer: there is nothing to download
      // or extract here. Keep progress indeterminate and let the health
      // probe below decide the outcome honestly.
      setInstallProgress('Checking gateway');
      addLog('Web preview has no local installer; probing gateway health');
    }

    // Probe real gateway health before declaring success.
    let healthy = false;
    try {
      healthy = await gatewayService.health();
    } catch {
      healthy = false;
    }
    if (healthy) {
      setInstall('INSTALLED');
      setInstallProgress('');
      addLog('Installed Hermes rootfs OK, ready to start');
      // Long-lived closure: take the ref so the counts are current, not the
      // ones captured at first render.
      refreshNowRef.current();
    } else {
      setInstall('FAILED');
      setInstallProgress('');
      setInstallError('Install finished but the gateway health check failed. Press Retry to try again.');
      setConnected(false);
      addLog('Install failed: gateway health check did not pass after install');
    }
  };

  // A dead run's cards decide nothing: purge them wherever a run dies
  // (stop, stream end, session switch, terminal SSE events), so no card
  // outlives the run that asked for it. The notify tombstone goes too, so
  // a retried run may alert again.
  const purgeApprovalsForRun = (deadRunId: string) => {
    notifiedApprovalIdsRef.current.delete(deadRunId);
    setApprovals((prev) => {
      const next = removeResolved(prev, deadRunId);
      if (next.length !== prev.length) cachePending(next);
      return next;
    });
  };

  const selectSession = (id: string) => {
    // Capture the in-flight turn before anything below runs: aborting is what
    // makes its async tail fire, and by the time those callbacks run chat and
    // turnMeta already point at the session being selected.
    const abortedToken = turnTokenRef.current;
    const abortedAgentId = lastAgentMsgIdRef.current;
    const abortedSid = currentSessionIdRef.current;
    // Abort any in-flight stream before switching.
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
    if (activeRunId) {
      const stopping = activeRunId;
      // Fire-and-forget on session switch, but log an unconfirmed stop
      // truthfully instead of swallowing it.
      gatewayService.stopRun(stopping).then((confirmed) => {
        if (!confirmed) addLog(`Stop for run ${stopping} did not confirm; it may have already finished.`);
      });
      setActiveRunId(null);
      // The old run's cards belong to the old session: they go with it, so
      // the new chat never inherits decisions nothing is waiting for.
      purgeApprovalsForRun(stopping);
    }
    streamingRef.current = false;
    setStreaming(false);
    // Record the verdict of the turn this switch just aborted, in the same
    // shape stopStream records it: its turn meta flagged stopped, and every
    // thinking bubble that never finished closed. The stream's own callbacks
    // cannot do this, because they fire only after this handler has already
    // swapped chat and turnMeta over to the next session, so the verdict would
    // land on the wrong chat (or nowhere) and the aborted turn would come back
    // as a thinking bubble that never finishes. Both mirrors are written for
    // the LEAVING session, which is exactly what hydrateTurnMeta and
    // loadLocalMessages read when it is selected again. Ownership is checked
    // with the token this turn carried, the pattern runTurn, stopStream and
    // every stream callback use: a turn that already handed the stream over is
    // not this call's to record. The session being left must still exist as
    // well, because deleting a session strips its message cache and its
    // badges, and writing them back here would resurrect exactly what that
    // cleanup removed. The token stays with the aborted turn on purpose, so
    // its own callbacks still settle its usage and session bookkeeping on top
    // of this record, while a turn started later claims a fresh token and
    // shuts those callbacks out of its own state.
    const leavingSessionExists = sessionsRef.current.some((s) => s.id === abortedSid);
    if (
      turnTokenRef.current === abortedToken &&
      abortedAgentId &&
      abortedSid &&
      leavingSessionExists
    ) {
      const live = turnMeta[abortedAgentId];
      saveTurnMetaStore(abortedSid, {
        ...loadTurnMetaStore(abortedSid),
        [abortedAgentId]: {
          ...(live || { model: settingsRef.current.modelId, durationMs: 0 }),
          stopped: true,
        },
      });
      gatewayService.saveLocalMessages(
        abortedSid,
        chat.map((m) => (m.sender === 'hermes' && !m.thinkingDone ? { ...m, thinkingDone: true } : m))
      );
      lastAgentMsgIdRef.current = null;
      addLog('Session switched mid-turn; the interrupted turn was recorded as stopped.');
    }
    setCurrentSessionId(id);
    // Stream failures are per chat: show THIS chat's failure (or none) rather
    // than the one the previously selected chat hit.
    setStreamError(streamErrorsRef.current[id] || null);
    // Restore this chat's persisted turn badges (stopped / estimated) with
    // its messages, so a reload does not turn a stopped turn into a success.
    hydrateTurnMeta(id);
    const local = gatewayService.loadLocalMessages(id);
    setChat(local);
    // Merge server history with local messages (dedupe by id, chronological).
    gatewayService
      .sessionMessages(id)
      .then((server) => {
        if (!server || server.length === 0) return;
        setChat((prev) => {
          const ids = new Set(server.map((m) => m.id));
          const onlyLocal = prev.filter((m) => !ids.has(m.id));
          return [...server, ...onlyLocal].sort(
            (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
          );
        });
      })
      .catch((e: unknown) => {
        // History merge failed: the local copy is already on screen, so log
        // the reason instead of silently pretending the server had nothing.
        addLog(`Session history unavailable: ${e instanceof Error ? e.message : String(e)}`);
      });
  };

  const newSessionInFlightRef = useRef<Promise<string> | null>(null);
  // --- Projects: host folders bound into the gateway ---------------------
  const persistProjects = (list: Project[]) => {
    try { localStorage.setItem('hermes_projects', JSON.stringify(list)); } catch {}
  };
  const persistSessionProjects = (map: Record<string, string>) => {
    try { localStorage.setItem('hermes_session_projects', JSON.stringify(map)); } catch {}
  };
  const projectForSession = (sessionId: string): Project | null => {
    const pid = sessionProjectsRef.current[sessionId];
    if (!pid) return null;
    return projectsRef.current.find((p) => p.id === pid) || null;
  };
  const projectSystemPrompt = (proj: Project): string => {
    const devicePart = proj.hostPath
      ? ` (device folder: ${proj.hostPath})`
      : ' (imported copy inside app storage)';
    return (
      `The user works in project '${proj.name}'. Project root: ${proj.guestPath}` +
      devicePart +
      '. Read and modify files under it with absolute paths, and run commands with that directory.'
    );
  };
  const tagSessionProject = (sessionId: string) => {
    const active = activeProjectIdRef.current;
    if (!active || !projectsRef.current.some((p) => p.id === active)) return;
    setSessionProjects((prev) => {
      if (prev[sessionId] === active) return prev;
      const next = { ...prev, [sessionId]: active };
      persistSessionProjects(next);
      return next;
    });
  };
  const selectProject = (id: string | null) => {
    setActiveProjectId(id);
    try {
      if (id) localStorage.setItem('hermes_active_project', id);
      else localStorage.removeItem('hermes_active_project');
    } catch {}
    addLog(id ? `Project selected: ${id}` : 'Project filter cleared');
  };
  const createProject = async (): Promise<{ ok: boolean; error?: string }> => {
    // No permission gate: the SAF picker grants access to the chosen folder,
    // and the app imports a copy into its own storage (Play-safe, no
    // all-files permission). Legacy device-folder binds are gone.
    const picked = await nativePickProjectDir();
    if (!picked) return { ok: false, error: 'cancelled' };
    const slug = picked.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
    const id = `${slug}-${Date.now().toString(36)}`;
    const imported = await nativeImportProjectTree(picked.uri, id);
    if (!imported.ok) {
      return { ok: false, error: imported.error || 'copy_failed' };
    }
    const bound = await gatewayService.bindLocalProject(id);
    if (!bound.ok || !bound.guestPath) {
      addLog(`Project bind failed: ${bound.error || 'no guest path'}`);
      return { ok: false, error: bound.error || 'bind failed' };
    }
    const proj: Project = {
      id, name: picked.name, hostPath: picked.hostPath,
      guestPath: bound.guestPath, createdAt: Date.now(),
    };
    setProjects((prev) => {
      const next = [...prev, proj];
      persistProjects(next);
      return next;
    });
    selectProject(id);
    addLog(`Project created: ${proj.name} -> ${proj.guestPath} (${imported.count} files)`);
    return { ok: true };
  };
  const exportProject = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    const r = await nativeExportProjectTree(id);
    if (r.ok) addLog(`Project exported (${r.count} files)`);
    return r;
  };
  const removeProject = async (id: string) => {
    try { await gatewayService.unbindProject(id); } catch {}
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id);
      persistProjects(next);
      return next;
    });
    setSessionProjects((prev) => {
      const next: Record<string, string> = {};
      for (const [sid, pid] of Object.entries(prev)) if (pid !== id) next[sid] = pid;
      persistSessionProjects(next);
      return next;
    });
    if (activeProjectIdRef.current === id) selectProject(null);
    addLog(`Project removed: ${id}`);
  };

  const newSession = async (): Promise<string> => {
    // Single-flight: two entry points (drawer/Home guard locally, the Chat
    // failure card and /new do not) must never mint two chats.
    if (newSessionInFlightRef.current) return newSessionInFlightRef.current;
    const run = (async () => {
    try {
      // Re-check the on-device key before an authenticated call: a bridge
      // that answered late must not create the session keyless.
      await ensureServerKey();
      const id = await gatewayService.createSession(settingsRef.current.modelId);
      let updated: MobileSession[];
      try {
        updated = await gatewayService.fetchSessions();
      } catch {
        // The session exists server-side but the list refresh failed
        // (fetchSessions swallows into stale cache): prepend a local row so
        // the just-created id is selectable until the next refresh.
        updated = [
          {
            id,
            title: 'New chat',
            model: settingsRef.current.modelId,
            messageCount: 0,
            lastActiveAt: Date.now(),
            costUsd: 0,
            source: 'local',
          },
          ...sessionsRef.current,
        ];
      }
      setSessions(updated);
      selectSession(id);
      tagSessionProject(id);
      addLog(`Created session ${id}`);
      return id;
    } catch (e) {
      // createSession throws on failure: log loudly and rethrow so callers
      // never navigate to a phantom session or log a false success.
      const appErr = toAppError(e);
      const reason = appErr.message;
      if (isHttpAuthStatus(typeof appErr.status === 'number' ? appErr.status : 0)) {
        // Authenticated endpoint rejected while health was fine: surface the
        // stale key instead of only logging a raw HTTP string.
        markGatewayUnauthorized('create session', appErr.status);
      }
      addLog(`Create session failed (${appErr.code}): ${reason}`);
      throw e;
    }
    })();
    newSessionInFlightRef.current = run;
    try {
      return await run;
    } finally {
      newSessionInFlightRef.current = null;
    }
  };

  const deleteSession = async (id: string) => {
    const ok = await gatewayService.deleteSession(id);
    if (!ok) {
      // Throw so the drawer catch fires its error state; returning silently
      // would close the dialog as if the delete had succeeded (U4).
      addLog(`Delete session ${id} failed: the gateway did not confirm. Keeping the local copy.`);
      throw new Error(`Delete session ${id} failed: the gateway did not confirm.`);
    }
    const updated = await gatewayService.fetchSessions();
    sessionsRef.current = updated;
    setSessions(updated);
    // The session is gone: drop its persisted turn badges and its scoped
    // stream error so nothing about it survives a reload or a chat switch.
    dropTurnMetaStore(id);
    delete streamErrorsRef.current[id];
    // Local-only artifacts never reach the gateway, so nothing else would
    // ever reclaim them: the message cache, the draft and the attachment
    // refs (localStorage entries plus the blob / object-URL registry) used
    // to stay behind for every deleted session and grew for the life of the
    // app.
    gatewayService.removeLocalMessages(id);
    localStorage.removeItem(`hermes_draft_${id}`);
    clearSessionRefs(id, { revokeBlobs: true });
    // Pinned ids are append-only elsewhere: prune the deleted id so dead
    // pins do not accumulate in storage, and record it for list screens
    // (the drawer's loaded-more pages are not refreshed by this delete).
    if (pinnedIds.includes(id)) {
      const next = pinnedIds.filter((p) => p !== id);
      try {
        localStorage.setItem('hermes_pinned_sessions', JSON.stringify(next));
      } catch {}
      setPinnedIds(next);
    }
    setDeletedSessionIds((prev) => (prev.includes(id) ? prev : [...prev.slice(-49), id]));
    // Read the current id from the ref: state here can predate a session
    // switch racing this delete and would leave a dangling current id.
    if (currentSessionIdRef.current === id) {
      if (updated.length > 0) selectSession(updated[0].id);
      else {
        setCurrentSessionId(null);
        setChat([]);
        hydrateTurnMeta(null);
        setStreamError(null);
      }
    }
    addLog(`Deleted session ${id}`);
  };

  const renameSession = async (id: string, title: string) => {
    // Validate at the source, not just in the drawer: empty or runaway
    // titles must never round-trip to the gateway.
    const clean = title.trim().slice(0, 120);
    if (!clean) throw new Error('Rename session failed: title is empty.');
    const ok = await gatewayService.renameSession(id, clean);
    if (!ok) {
      // Throw so the drawer catch shows its rename error (U4).
      addLog(`Rename session ${id} failed: the gateway did not confirm. Title unchanged.`);
      throw new Error(`Rename session ${id} failed: the gateway did not confirm.`);
    }
    const updated = await gatewayService.fetchSessions();
    setSessions(updated);
    addLog(`Renamed session to "${clean}"`);
  };

  const forkSession = async (id: string) => {
    const newId = await gatewayService.forkSession(id);
    if (!newId) {
      // Throw (same contract as delete/rename) so the caller catch fires its
      // branch-failed state instead of silently staying put.
      addLog(`Fork session ${id} failed: the gateway did not confirm. Staying on the current session.`);
      throw new Error(`Fork session ${id} failed: the gateway did not confirm.`);
    }
    const updated = await gatewayService.fetchSessions();
    setSessions(updated);
    selectSession(newId);
    addLog(`Forked branch to session ${newId}`);
  };

  const dropQueued = (reason: string): number => {
    const n = queuedRef.current.length;
    if (n > 0) {
      queuedRef.current = [];
      setQueuedMessages([]);
      persistOutbox([]);
      addLog(`Dropped ${n} queued message(s) (${reason})`);
    }
    return n;
  };

  // Map an approval request to a granular auto-approve scope. Returns null
  // when nothing matches: unmapped capabilities default to manual approval
  // (deny), never to auto-allow.
  const approvalScopeOf = (req: PendingApproval): AutoApproveScope | null => {
    const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ');
    const toolN = norm(req.tool || '');
    const cmd = (req.command || '').toLowerCase();
    // args carry the real payload ('powershell', '-Command', the script):
    // classifying on tool+command alone misses interpreters entirely.
    const argText = (req.args || []).join(' ');
    // The free-text summary is LLM prose and never classifies: benign verbs
    // in a description ("show disk status") must not move a dangerous action
    // into a lesser scope. Identifier glue (run_command) normalizes to
    // spaces so executor names match their spaced keyword forms.
    const hay = norm(`${req.tool || ''} ${cmd} ${argText} ${req.path || ''}`);
    // An executor TOOL NAME is decisive on its own, whatever the args say:
    // run_command running 'cat /etc/shadow' is exec, not read.
    if (
      /(^|[^a-z])(run command|command runner|exec(ute|utor)?|shell|bash|powershell|pwsh|terminal|process|cli|interpreter|subprocess|eval)([^a-z]|$)/.test(
        toolN
      )
    )
      return 'exec';
    // A mutator TOOL NAME is decisive too: update_file on 'src/list.ts' is
    // write even though the path contains the read verb 'list'.
    if (
      /(^|[^a-z])(write|edit|create|update|save|append|delete|remove|patch|truncate|touch|mkdir)([^a-z]|$)/.test(
        toolN
      )
    )
      return 'write';
    // Bare 'install' alone is often a noun ('the install failed'); require a
    // verb-object shape or a package-manager command to call it install.
    if (/(^|[^a-z])(apt( |-get)? |brew |npm (i|install|clean-install) |pip install |cargo add |to install |install (the|a|an|this|that|these|those|all|latest|new|missing|required|dependencies|packages?|modules?|\S+@\S+) )/.test(hay)) return 'install';
    if (/(^|[^a-z])(exec|execute|shell|bash|sh -|powershell|pwsh|cmd(\.exe)?|python3?|node|perl|ruby|osascript|terminal|run command|rm|mv|cp|sudo|chmod|chown|kill|pkill|dd)([^a-z]|$)/.test(hay)) return 'exec';
    // Write before network: an action doing both ('download and write file')
    // must classify as the more privileged one, never the lesser.
    if (/(^|[^a-z])(write|edit|create|update|save|append|delete|remove|mkdir|apply_patch|apply patch|patch|truncate|touch)([^a-z]|$)/.test(hay)) return 'write';
    if (/(^|[^a-z])(fetch|https?|curl|wget|network|download|request)([^a-z]|$)/.test(hay)) return 'network';
    if (/(^|[^a-z])(read|list|glob|grep|search|show|cat)([^a-z]|$)/.test(hay)) return 'read';
    return null;
  };

  // Raw SSE turn runner. Drives SseParser directly: TextDecoder chunks feed
  // the parser (split CRLF / multibyte safe), flush() drains the tail at
  // stream end, and terminal events (done/run.completed vs run.failed/error)
  // decide the turn outcome. Auth and URL match GatewayService
  // (http://127.0.0.1:8080 + Bearer serverKey) since this file cannot reach
  // its private transport.
  const streamTurnViaSse = async (
    sessionId: string,
    model: string,
    message: string,
    reasoningEffort: string,
    imageDataUrls: string[],
    callbacks: StreamChatCallbacks,
    abortSignal?: AbortSignal
  ): Promise<void> => {
    // Re-check the on-device key before the request: a bridge that answered
    // late must not send this turn out keyless.
    if (isNativeGateway() && !secretsRef.current.serverKey && !settingsRef.current.serverKey) {
      await ensureServerKey();
    }
    const key = secretsRef.current.serverKey || settingsRef.current.serverKey;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const body: Record<string, unknown> = { model };
    if (imageDataUrls && imageDataUrls.length > 0) {
      const parts: unknown[] = [];
      if (message) parts.push({ type: 'text', text: message });
      for (const url of imageDataUrls) parts.push({ type: 'image_url', image_url: { url } });
      body.message = parts;
    } else {
      body.message = message;
    }
    if (reasoningEffort && reasoningEffort !== 'none') {
      body.model_options = { reasoning_effort: reasoningEffort.toLowerCase() };
    }
    // Project chats carry their root as an ephemeral system prompt so the
    // agent works on device files. The user text stays untouched.
    const turnProject = projectForSession(sessionId);
    if (turnProject) body.system_message = projectSystemPrompt(turnProject);
    // On device the WebView fetch below never runs: https://localhost to
    // http://127.0.0.1:8080 gets no CORS headers back. The native bridge
    // takes the stream instead (see the reader try below).
    const nativeStream = isNativeGateway();
    let res: Response | null = null;
    let webConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let webConnectTimedOut = false;
    if (!nativeStream) {
      webConnectTimer = setTimeout(() => {
        webConnectTimedOut = true;
        try { (abortSignal as unknown as AbortController)?.abort?.(); } catch {}
      }, 15000);
    }
    if (!nativeStream) {
      try {
        const webRes = await fetch(
          `http://127.0.0.1:8080/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
          { method: 'POST', headers, body: JSON.stringify(body), signal: abortSignal }
        );
        if (webConnectTimer) { clearTimeout(webConnectTimer); webConnectTimer = null; }
        if (webConnectTimedOut) {
          callbacks.onError?.(unreachableCopy());
          return;
        }
        res = webRes;
      } catch (err) {
        if (webConnectTimer) { clearTimeout(webConnectTimer); webConnectTimer = null; }
        if (webConnectTimedOut) {
          callbacks.onError?.(unreachableCopy());
          return;
        }
        if (err instanceof Error && err.name === 'AbortError') {
          callbacks.onStopped?.();
          return;
        }
        // Never surface raw transport text ('Failed to fetch') to the user.
        callbacks.onError?.(isNetworkFailure(err) ? unreachableCopy() : streamClosedCopy());
        return;
      }
      if (!res.ok) {
        // 401/403 while /health is green means a stale key, so say that and
        // flag the gateway distinctly; 404 means this chat is gone. No raw
        // 'Stream failed: HTTP 404' reaches the chat error banner.
        if (isHttpAuthStatus(res.status)) markGatewayUnauthorized('chat stream', res.status);
        callbacks.onError?.(httpStatusCopy(res.status));
        addLog(`Chat stream rejected by the gateway (HTTP ${res.status})`);
        return;
      }
      if (!res.body) {
        callbacks.onError?.(streamClosedCopy());
        return;
      }
    }
    const asRecord = (v: unknown): Record<string, unknown> =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
    const parser = new SseParser();
    // Created inside the try, so a getReader() failure reports as a stream
    // failure instead of rejecting this promise with no catch around it.
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const decoder = new TextDecoder();
    let failedMessage: string | null = null;
    let stoppedByServer = false;
    let sawTerminal = false;
    let hasFirstToken = false;
    const FIRST_TOKEN_MS = 30000;
    const STALL_MS = 60000;
    let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!hasFirstToken && !sawTerminal && !failedMessage && !stoppedByServer) {
        callbacks.onError?.(streamClosedCopy());
        addLog('Stream stalled waiting for first token');
      }
    }, FIRST_TOKEN_MS);
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!sawTerminal && !failedMessage && !stoppedByServer) {
          callbacks.onError?.(streamClosedCopy());
          addLog('Stream stalled');
        }
      }, STALL_MS);
    };
    const clearStreamTimers = () => {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (stallTimer) clearTimeout(stallTimer);
      firstTokenTimer = null;
      stallTimer = null;
    };
    // Every event carrying this turn's run id refreshes it: the runTurn
    // finally block purges that run's cards, so a card never outlives a
    // stream that died while the decision was still pending.
    const dispatchEvent = (ev: { event: string; json: unknown; data?: string }) => {
      const data = asRecord(ev.json);
      const runId = asString(data.run_id);
      if (runId) {
        callbacks.onRunId?.(runId);
        seenRunIdRef.current = runId;
      }
      const usage = asRecord(data.usage);
      if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
        callbacks.onUsage(Number(usage.input_tokens || 0), Number(usage.output_tokens || 0));
      }
      switch (ev.event) {
        case 'assistant.delta': {
          const delta = asString(data.delta);
          if (delta) {
            callbacks.onThinkingDone();
            callbacks.onText(delta);
          }
          break;
        }
        case 'assistant.commentary': {
          const text = asString(data.text);
          if (text) {
            callbacks.onThinkingDone();
            callbacks.onText(text);
          }
          break;
        }
        case 'tool.progress': {
          const name = asString(data.tool_name) || 'tool';
          if (name === '_thinking' || name === 'thinking') {
            callbacks.onThinking(asString(data.delta) || asString(data.preview));
          } else {
            callbacks.onTool(name);
          }
          break;
        }
        case 'tool.started':
        case 'tool.completed': {
          callbacks.onThinkingDone();
          const name = asString(data.tool_name) || 'tool';
          callbacks.onTool(name);
          const output = asString(data.output);
          if (output) callbacks.onToolOutput?.(name, output);
          break;
        }
        case 'approval.request': {
          if (runId) {
            const args = Array.isArray(data.args)
              ? (data.args as unknown[]).map((a) => String(a))
              : undefined;
            const toolName = asString(data.tool_name || data.tool);
            callbacks.onApproval({
              runId,
              sessionId,
              summary: asString(data.description || data.command) || 'Approval requested for action',
              tool: toolName || undefined,
              command: asString(data.command) || undefined,
              path: asString(data.path) || undefined,
              args,
              risk: asString(data.risk) || undefined,
              cwd: asString(data.cwd) || undefined,
              reason: asString(data.reason) || undefined,
              createdAt: Date.now(),
            });
          }
          break;
        }
        case 'run.failed':
        case 'error':
        case 'stream.error': {
          failedMessage =
            asString(data.error || data.message || data.description || data.detail) ||
            tx(
              'errServerMessagePlain',
              'The Hermes server or the provider returned an error. Retry, and check the connection if it repeats.'
            );
          // The turn is dead: its cards decide nothing anymore.
          if (runId) purgeApprovalsForRun(runId);
          break;
        }
        case 'run.cancelled':
        case 'run.stopped':
        case 'cancelled':
        case 'stop': {
          stoppedByServer = true;
          if (runId) purgeApprovalsForRun(runId);
          break;
        }
        default: {
          if (isTerminalSseEvent(ev.event)) {
            // Terminal completion (done/run.completed/complete): the turn
            // simply ends; bookkeeping happens in the caller finally block.
            sawTerminal = true;
          } else if (ev.event === 'message') {
            const type = asString(data.type);
            if (MESSAGE_COMPLETION_TYPES.has(type)) {
              // A completion or failure shipped on a message envelope: the
              // turn is over even though the event name is not terminal.
              sawTerminal = true;
              if (MESSAGE_FAILURE_TYPES.has(type)) {
                failedMessage =
                  asString(data.error || data.message || data.description) ||
                  tx(
                    'errServerMessagePlain',
                    'The Hermes server or the provider returned an error. Retry, and check the connection if it repeats.'
                  );
              } else if (MESSAGE_STOP_TYPES.has(type)) {
                stoppedByServer = true;
              }
            } else if ((ev.data || '').trim() === '[DONE]') {
              // Bare terminator on a data-only line: it has no event name, so
              // it would otherwise read as a dropped connection.
              sawTerminal = true;
            } else {
              const text = asString(data.delta || data.text || data.content);
              if (text) {
                callbacks.onThinkingDone();
                callbacks.onText(text);
              }
            }
          }
          break;
        }
      }
    };
    // A UI callback that throws must not kill the read loop or be reported
    // as a transport failure: guard the dispatch and keep reading.
    const dispatch = (ev: { event: string; json: unknown; data?: string }) => {
      try {
        dispatchEvent(ev);
        if (!hasFirstToken) {
          hasFirstToken = true;
          if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
        }
        resetStallTimer();
        if (sawTerminal || failedMessage || stoppedByServer) clearStreamTimers();
      } catch {
        addLog(
          tx('streamUpdateSkipped', 'A live update could not be applied; the answer keeps streaming.')
        );
      }
    };
    // Shared turn-end verdict for both transports (WebView fetch and the
    // native stream bridge): a dead turn reports honestly instead of
    // presenting a truncated reply as success.
    const finishStream = () => {
      clearStreamTimers();
      if (failedMessage) {
        // Backend failure text is not user copy: the classifier keeps an
        // honest sentence and replaces raw transport or platform payloads.
        callbacks.onError?.(
          plainResultLine(
            failedMessage,
            tx(
              'errServerMessagePlain',
              'The Hermes server or the provider returned an error. Retry, and check the connection if it repeats.'
            )
          )
        );
      } else if (stoppedByServer) {
        callbacks.onStopped?.();
      } else if (!sawTerminal) {
        // The read ended with no completion event: a mid-answer drop is
        // not a finished turn, so say the connection closed instead of
        // presenting a truncated reply as a success.
        callbacks.onError?.(streamClosedCopy());
      } else {
        callbacks.onThinkingDone();
      }
    };
    try {
      // Native bridge path: same parser, same tail, same end verdict as the
      // web path below. The POST runs on HttpURLConnection (no WebView
      // CORS) and arrives as raw byte chunks; decoding stays streamed, so
      // multibyte characters split across chunks survive intact.
      if (nativeStream) {
        let nativeStatus = 0;
        const outcome = await nativeStreamPost({
          url: `http://127.0.0.1:8080/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
          onStatus: (s) => {
            nativeStatus = s;
          },
          onBytes: (bytes) => {
            const chunk = decoder.decode(bytes, { stream: true });
            for (const ev of parser.feed(chunk)) dispatch(ev);
          },
        });
        if (nativeStatus) {
          if (isHttpAuthStatus(nativeStatus)) markGatewayUnauthorized('chat stream', nativeStatus);
          callbacks.onError?.(httpStatusCopy(nativeStatus));
          addLog(`Chat stream rejected by the gateway (HTTP ${nativeStatus})`);
          clearStreamTimers();
          return;
        }
        if (outcome === 'cancelled') {
          clearStreamTimers();
          callbacks.onStopped?.();
          return;
        }
        if (outcome === 'error' || (typeof outcome === 'string' && outcome.startsWith('error:'))) {
          const detail = typeof outcome === 'string' && outcome.startsWith('error:') ? outcome.slice(6) : '';
          if (/ConnectException|Failed to connect to/.test(detail)) {
            callbacks.onError?.(unreachableCopy());
          } else if (detail && isNetworkFailure(new Error(detail))) {
            callbacks.onError?.(unreachableCopy());
          } else {
            callbacks.onError?.(streamClosedCopy());
          }
          clearStreamTimers();
          return;
        }
        const tail = decoder.decode();
        if (tail) for (const ev of parser.feed(tail)) dispatch(ev);
        for (const ev of parser.flush()) dispatch(ev);
        finishStream();
        return;
      }
      const bodyReader = res!.body!.getReader();
      reader = bodyReader;
      for (;;) {
        const { done, value } = await bodyReader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const ev of parser.feed(chunk)) dispatch(ev);
      }
      // Flush the decoder first: a multibyte character split across the last
      // chunk would otherwise be dropped. Then drain the tail: a final event
      // without a trailing blank line still counts.
      const tail = decoder.decode();
      if (tail) for (const ev of parser.feed(tail)) dispatch(ev);
      for (const ev of parser.flush()) dispatch(ev);
      finishStream();
    } catch (err) {
      clearStreamTimers();
      if (err instanceof Error && err.name === 'AbortError') {
        callbacks.onStopped?.();
      } else {
        callbacks.onError?.(isNetworkFailure(err) ? unreachableCopy() : streamClosedCopy());
      }
    } finally {
      clearStreamTimers();
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // Stream already closed, nothing to cancel.
        }
        try {
          reader.releaseLock();
        } catch {
          // Lock already released, ignore.
        }
      }
    }
  };

  const stopStream = async () => {
    // Capture ownership BEFORE the first await. stop-then-send releases the
    // stream synchronously and immediately starts the next turn, so anything
    // written after `await stopRun` would land on that newer turn's ref,
    // queue and bubbles: the new agent message would inherit stopped:true and
    // its thinking badge would be force-closed. Everything that touches shared
    // turn state therefore runs in this synchronous section, where these ids
    // still belong to the turn being stopped.
    const stopToken = turnTokenRef.current;
    turnTokenRef.current += 1;
    const stoppedAgentId = lastAgentMsgIdRef.current;
    const runId = activeRunId;
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
    // Flags clear first so stop-then-send works sync (state lags a render).
    streamingRef.current = false;
    setStreaming(false);
    if (runId) {
      setActiveRunId(null);
      purgeApprovalsForRun(runId);
    }
    dropQueued('stream stopped');
    // Mark pending assistant message as finished thinking, and flag the
    // in-flight turn as stopped so its meta reads stopped:true, not success.
    if (stoppedAgentId) {
      setTurnMeta((prev) =>
        prev[stoppedAgentId] ? { ...prev, [stoppedAgentId]: { ...prev[stoppedAgentId], stopped: true } } : prev
      );
      lastAgentMsgIdRef.current = null;
    }
    setChat((prev) =>
      prev.map((m) =>
        m.sender === 'hermes' && !m.thinkingDone ? { ...m, thinkingDone: true } : m
      )
    );
    addLog('Stream interrupted by user');
    if (runId) {
      // Await the stop result so the log tells the truth: confirmed means the
      // gateway acknowledged the stop, unconfirmed usually means the run had
      // already finished. No shared turn state is written past this await.
      const confirmed = await gatewayService.stopRun(runId);
      if (turnTokenRef.current !== stopToken) {
        // A newer turn claimed the stream while the stop was in flight: its
        // refs, queue and bubbles are not ours to write, so the verdict above
        // (already recorded on the stopped turn) is all this call reports.
        addLog(
          `Stop for run ${runId} ${confirmed ? 'confirmed' : 'sent without confirmation'} after a newer turn started; that turn's state was left alone.`
        );
        return;
      }
      addLog(
        confirmed
          ? `Stop confirmed by gateway for run ${runId}`
          : `Stop sent for run ${runId} but the gateway did not confirm; the run may have already finished.`
      );
    }
  };

  // Runs one turn against a gateway session that is known to exist. Extracted
  // from sendMessage so a brand new chat can create its session on the gateway
  // FIRST and still reuse this body unchanged.
  const runTurn = (
    sid: string,
    trimmed: string,
    imageDataUrls: string[],
    userMsgId: string,
    agentMsgId: string
  ): boolean => {
    // Claim the shared stream refs for THIS turn. Every async tail below
    // carries this token and bails when a later turn has claimed them, so a
    // cancelled turn settling late cannot clear the newer turn's run id,
    // abort handle or bubble.
    const turnToken = ++turnTokenRef.current;
    // New turn, new run identity: the previous turn's id must not leak into
    // this turn's end-of-stream purge.
    seenRunIdRef.current = '';
    const userMessage: ChatMessage = {
      id: userMsgId,
      sender: 'you',
      content: trimmed,
      timestamp: Date.now(),
    };

    const agentMessage: ChatMessage = {
      id: agentMsgId,
      sender: 'hermes',
      content: '',
      thinking: '',
      thinkingDone: false,
      tools: [],
      timestamp: Date.now(),
    };

    const initialHistory = gatewayService.loadLocalMessages(sid);
    // Strip trailing failed or empty hermes bubbles so a retry resend
    // does not accumulate duplicates.
    let cut = initialHistory.length;
    while (cut > 0) {
      const m = initialHistory[cut - 1];
      if (m.sender !== 'hermes') break;
      const empty =
        !(m.content || '').trim() &&
        !(m.thinking || '').trim() &&
        (m.tools || []).length === 0 &&
        (m.toolOutputs || []).length === 0;
      // A failed turn is any agent bubble that carried a stream failure: the
      // current 'Stream error:'/'Turn error:' prefixes (approval cards show a
      // retry bar instead and never enter the bubble stream).
      const failed = /^(Stream error|Turn error):/.test(m.content || '');
      if (!empty && !failed) break;
      cut -= 1;
    }
    const cleanHistory = cut === initialHistory.length ? initialHistory : initialHistory.slice(0, cut);
    const initialChat = [...cleanHistory, userMessage, agentMessage];
    gatewayService.saveLocalMessages(sid, initialChat);
    setChat(initialChat);

    streamingRef.current = true;
    setStreaming(true);
    // Clear THIS chat's scoped failure; other chats keep their own.
    setStreamErrorFor(sid, null);
    turnMetaOwnerRef.current = sid;
    lastAgentMsgIdRef.current = agentMsgId;
    turnUsageSeenRef.current = false;
    turnOutCharsRef.current = 0;
    // A failed turn still sent the user message (+1) but produced no reply:
    // the finally block bumps +1 instead of +2 for it. Set in onError below.
    let turnFailed = false;
    const startTime = Date.now();
    const activeModel = settingsRef.current.modelId;
    const activeEffort = settingsRef.current.reasoningEffort;
    setTurnMeta((prev) => ({
      ...prev,
      [agentMsgId]: { model: activeModel, durationMs: 0 },
    }));

    abortControllerRef.current = new AbortController();

    // U11: per-token batching. SSE deltas arrive per token and each one used
    // to map the whole chat array (O(tokens x messages)). Deltas now
    // accumulate here and flush in a single setChat per ~32ms frame; the row
    // only re-renders the changed bubble by id, so one batched update per
    // frame is all the UI needs. Control events (tool/approval/error/stop)
    // flush synchronously first so ordering is preserved.
    let pendingText = '';
    let pendingThinking = '';
    let thinkingDonePending = false;
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStreamBuffers = () => {
      if (streamFlushTimer !== null) {
        clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
      if (!pendingText && !pendingThinking && !thinkingDonePending) return;
      const text = pendingText;
      const thinking = pendingThinking;
      const done = thinkingDonePending;
      pendingText = '';
      pendingThinking = '';
      thinkingDonePending = false;
      setChat((prev) =>
        prev.map((m) =>
          m.id === agentMsgId
            ? {
                ...m,
                content: text ? (m.content || '') + text : m.content,
                thinking: thinking ? (m.thinking || '') + thinking : m.thinking,
                ...(done ? { thinkingDone: true } : {}),
              }
            : m
        )
      );
    };
    const scheduleStreamFlush = () => {
      if (streamFlushTimer !== null) return;
      streamFlushTimer = setTimeout(() => {
        streamFlushTimer = null;
        flushStreamBuffers();
      }, 32);
    };

    // Raw SSE path (SseParser): terminal run.failed/error events land in
    // onError above (streamError + turnMeta.error, no bubble); clean
    // completion flows through the finally block below.
    streamTurnViaSse(
      sid,
      activeModel,
      trimmed,
      activeEffort,
      imageDataUrls,
      {
        onRunId: (rId) => {
          // A run id reported by a turn that has already been superseded must
          // not overwrite the active run of the turn streaming now: stopping
          // the wrong run id is how a cancelled turn steals the next one.
          if (turnTokenRef.current === turnToken) setActiveRunId(rId);
        },
        onThinking: (delta) => {
          pendingThinking += delta;
          scheduleStreamFlush();
        },
        onThinkingDone: () => {
          thinkingDonePending = true;
          scheduleStreamFlush();
        },
        onText: (delta) => {
          turnOutCharsRef.current += delta.length;
          pendingText += delta;
          scheduleStreamFlush();
        },
        onTool: (toolName) => {
          flushStreamBuffers();
          setChat((prev) =>
            prev.map((m) =>
              m.id === agentMsgId
                ? { ...m, tools: Array.from(new Set([...(m.tools || []), toolName])) }
                : m
            )
          );
        },
        onToolOutput: (toolName, output) => {
          flushStreamBuffers();
          setChat((prev) =>
            prev.map((m) =>
              m.id === agentMsgId
                ? {
                    ...m,
                    toolOutputs: [
                      ...(m.toolOutputs || []),
                      { toolName, output },
                    ],
                  }
                : m
            )
          );
        },
        onUsage: (inp, outp) => {
          turnUsageSeenRef.current = true;
          setUsageIn((prev) => prev + inp);
          setUsageOut((prev) => prev + outp);
        },
        onApproval: (req) => {
          // Fresh policy per decision, not the turn-start snapshot: flipping
          // the switch mid-turn must take effect on the NEXT approval, or
          // the emergency kill-switch is decorative until the turn ends.
          const livePolicy = normalizePolicy(
            (settingsRef.current as unknown as { autoApprovePolicy?: unknown }).autoApprovePolicy ??
              fromLegacyGlobal(settingsRef.current.autoApproveGlobal)
          );
          const scope = approvalScopeOf(req);
          // A gateway/model risk flag outranks every auto-approve toggle:
          // high-risk actions always need a human tap.
          const risk = (req.risk || '').toLowerCase();
          const highRisk = risk === 'high' || risk === 'critical' || risk === 'severe';
          if (scope && !highRisk && isScopeAllowed(livePolicy, scope)) {
            // Auto-approvals always grant 'once': a session grant would hand
            // the tool server-side execution rights for the rest of the
            // session with no human ever tapping anything.
            // resolveApproval never rejects (it returns its outcome), so the
            // fallback rides on the resolved value: a failed auto-approval
            // reappears as a manual card instead of blocking the turn
            // forever behind an invisible decision.
            void resolveApproval(req, true, 'once').then((outcome) => {
              if (outcome === 'failed') {
                setApprovals((prev) => {
                  const merged = mergeIncoming(prev, req);
                  cachePending(merged);
                  return merged;
                });
                addLog(`Auto-approval failed for ${req.runId}: awaiting manual decision.`);
              }
            });
          } else {
            // Closed-app path: the in-app card is invisible, so a best-effort
            // system alert carries genuinely new approvals. The notified set
            // (not the updater) dedupes: updaters must stay pure.
            if (!notifiedApprovalIdsRef.current.has(req.runId)) {
              notifiedApprovalIdsRef.current.add(req.runId);
              void nativeNotifyAlert(
                'Hermes approval needed',
                req.summary.slice(0, 120) || 'A tool action is waiting for review.'
              );
            }
            setApprovals((prev) => (prev.some((a) => a.runId === req.runId) ? prev : [...prev, req]));
          }
        },
        onError: (message: string) => {
          turnFailed = true;
          // Failures surface via streamError + turnMeta.error, never as a
          // 'Stream error:' chat bubble (bubbles pollute history and get
          // re-sent as context on retry). Flush buffered deltas first so the
          // partial turn content is not lost.
          flushStreamBuffers();
          const msg = message || streamClosedCopy();
          // Scoped to this session AND to this turn. A late failure from a
          // turn the user already replaced must not paint an error banner
          // over the turn running now, so it is logged instead of surfaced.
          if (turnTokenRef.current !== turnToken) {
            addLog(`Stream error after the turn was replaced: ${msg}`);
            return;
          }
          setStreamErrorFor(sid, msg);
          setTurnMeta((prev) => ({
            ...prev,
            [agentMsgId]: {
              model: activeModel,
              durationMs: Date.now() - startTime,
              error: msg,
            } as TurnMeta,
          }));
          addLog(`Stream error: ${msg}`);
        },
        onStopped: () => {
          thinkingDonePending = true;
          // The buffered deltas belong to THIS turn's own bubble id, so they
          // are safe to flush even now; everything below is the turn verdict.
          flushStreamBuffers();
          // A newer turn owns the stream: stopStream recorded this turn's
          // verdict in the synchronous section before it released the stream,
          // so writing it again here would race the turn running now.
          if (turnTokenRef.current !== turnToken) return;
          setChat((prev) =>
            prev.map((m) =>
              m.id === agentMsgId ? { ...m, thinkingDone: true } : m
            )
          );
          setTurnMeta((prev) => ({
            ...prev,
            [agentMsgId]: {
              model: activeModel,
              durationMs: Date.now() - startTime,
              stopped: true,
            } as TurnMeta,
          }));
          addLog('Stream stopped by gateway');
        },
      } as StreamChatCallbacks,
      abortControllerRef.current.signal
    )
      .finally(() => {
        // Ownership check FIRST. stop-then-send releases the stream
        // synchronously, so this turn can settle AFTER the next one claimed
        // these refs; clearing them unconditionally would drop the newer
        // turn's abort handle and run id, and its own stop would then find
        // nothing to stop and report a stale bubble as its verdict.
        const ownsStream = turnTokenRef.current === turnToken;
        if (ownsStream) {
          streamingRef.current = false;
          setStreaming(false);
          setActiveRunId(null);
          lastAgentMsgIdRef.current = null;
          abortControllerRef.current = null;
          // A stream that ended (or died) with a decision still pending
          // leaves a card nothing will ever consume: it goes with the run.
          // (A live approval keeps the stream open server-side, so reaching
          // here with cards means this run will never ask again.)
          if (seenRunIdRef.current) purgeApprovalsForRun(seenRunIdRef.current);
        }
        // Drain any deltas still buffered before turn bookkeeping runs.
        flushStreamBuffers();
        const duration = Date.now() - startTime;
        // Fallback: when the stream produced no usage events, estimate
        // tokens from text length so totals do not silently stay at zero.
        // The counters are shared, so only the turn that still owns the
        // stream may add to them: otherwise this turn's estimate would land
        // on top of the newer turn's usage.
        const estimated = ownsStream && !turnUsageSeenRef.current;
        if (estimated) {
          const estIn = Math.max(1, Math.ceil(trimmed.length / 4));
          const estOut = Math.max(1, Math.ceil(turnOutCharsRef.current / 4));
          setUsageIn((prev) => prev + estIn);
          setUsageOut((prev) => prev + estOut);
          addLog(`Usage estimated for turn (no usage events): +${estIn} in / +${estOut} out tokens`);
        }
        setTurnMeta((prev) => ({
          ...prev,
          [agentMsgId]: {
            ...prev[agentMsgId],
            model: activeModel,
            durationMs: duration,
            ...(estimated ? { estimated: true } : {}),
          } as TurnMeta,
        }));

        // Pure updater; persistence happens in the chat persist effect.
        setChat((latest) =>
          latest.map((m) =>
            m.id === agentMsgId ? { ...m, thinkingDone: true } : m
          )
        );

        // Update session meta (computed outside the updater; StrictMode purity).
        // Failed turns sent the user message but produced no reply: +1, not +2.
        const bump = turnFailed ? 1 : 2;
        const bumped = sessionsRef.current.map((s) =>
          s.id === sid
            ? { ...s, messageCount: s.messageCount + bump, lastActiveAt: Date.now() }
            : s
        );
        sessionsRef.current = bumped;
        setSessions(bumped);
        try {
          gatewayService.saveLocalSessions(bumped);
        } catch {}

        // Deliver the next queued message now that this turn released the
        // stream. drainQueue also refuses while the gateway is unreachable, so
        // a queued message cannot be fired into a dead gateway.
        drainQueue();
      })
      .catch((e: unknown) => {
        // The stream reports its own failure; this only stops a late
        // callback rejection from escaping as an unhandled rejection.
        addLog(`Turn cleanup failed: ${plainServiceFailure(e)}`);
      });

    return true;
  };

  // Deliver the next queued message once the way is clear: not streaming, and
  // the gateway actually reachable. Single-flight, because the queued send
  // lands 300ms later and a second drain must not pop the following message.
  const drainQueue = () => {
    if (queueDrainPendingRef.current) return;
    if (streamingRef.current || !connectedRef.current) return;
    const next = queuedRef.current[0];
    if (!next) return;
    // Pin the session the message was queued for: if the user switches chats
    // inside the 300ms window, firing would land it in the wrong chat.
    const drainSid = currentSessionIdRef.current;
    queueDrainPendingRef.current = true;
    queuedRef.current = queuedRef.current.slice(1);
    setQueuedMessages([...queuedRef.current]);
    persistOutbox(queuedRef.current);
    setTimeout(() => {
      queueDrainPendingRef.current = false;
      if (currentSessionIdRef.current !== drainSid) {
        queuedRef.current = [next, ...queuedRef.current];
        setQueuedMessages([...queuedRef.current]);
        persistOutbox(queuedRef.current);
        addLog('Queued message kept: chat switched before delivery.');
        return;
      }
      sendMessage(next.text, next.images);
    }, 300);
  };

  // The chat banner promises queued messages are delivered when the gateway
  // comes back, so a reconnect must actually drain them. Without this the
  // queue only moved on the next user-sent turn, which is part of the
  // dishonest-banner problem.
  useEffect(() => {
    const was = wasConnectedRef.current;
    wasConnectedRef.current = connected;
    if (connected && !was) {
      addLog('Gateway reachable again, delivering queued message(s)');
      drainQueue();
    }
  }, [connected]);

  const sendMessage = (text: string, imageDataUrls: string[] = []): boolean => {
    const trimmed = text.trim();
    if (!trimmed && imageDataUrls.length === 0) return false;
    // Defense in depth: the Chat composer guards this at UI level, but any
    // other caller of the context API must never post a model-less turn.
    if (!settingsRef.current.modelId) {
      addLog('Send refused: no model selected.');
      return false;
    }
    // Never silently drop while a stream is live: queue it for the next turn.
    if (streamingRef.current) {
      queueMessage(trimmed, imageDataUrls);
      addLog('Stream busy, message queued for next turn');
      return true;
    }
    // Offline honesty: an unreachable gateway used to get the POST anyway,
    // which failed with a raw transport error and could leave a ghost chat.
    // Queue it instead (that is what the banner promises) and let the
    // reconnect drain above deliver it. No session is created for it.
    if (!connectedRef.current) {
      queueMessage(trimmed, imageDataUrls);
      addLog('Gateway offline, message queued until it is reachable again');
      return true;
    }

    const userMsgId = newId('msg');
    const agentMsgId = newId('msg');
    rememberTurnImages(userMsgId, imageDataUrls);
    const existingSid = currentSessionIdRef.current;
    if (existingSid) {
      return runTurn(existingSid, trimmed, imageDataUrls, userMsgId, agentMsgId);
    }

    // First message of a new chat: create the session on the gateway BEFORE
    // streaming to it. Inventing a local sess_* id and streaming to it 404s on
    // the very first message and persists a session the gateway never heard
    // of, which is the ghost chat that then shows up in the sidebar.
    const title = trimmed.slice(0, 30) || 'New Conversation';
    const model = settingsRef.current.modelId;
    // Claim ownership while the session is still being created: a second send
    // releases streamingRef synchronously (stop-then-send) and may start its
    // own turn before this promise settles, and its refs must survive this
    // create's failure path.
    const createToken = ++turnTokenRef.current;
    streamingRef.current = true;
    setStreaming(true);
    setStreamErrorFor(NO_SESSION_ERROR_KEY, null);
    lastAgentMsgIdRef.current = agentMsgId;
    setTurnMeta((prev) => ({ ...prev, [agentMsgId]: { model, durationMs: 0 } }));

    ensureServerKey()
      .then(() => gatewayService.createSession(model, title))
      .then((createdId) => {
        if (!createdId) throw new Error('the gateway returned no session id');
        const newSess: MobileSession = {
          id: createdId,
          title,
          model,
          messageCount: 0,
          lastActiveAt: Date.now(),
          costUsd: 0.0,
          source: 'web',
        };
        const nextKnown = [newSess, ...sessionsRef.current.filter((s) => s.id !== createdId)];
        sessionsRef.current = nextKnown;
        gatewayService.saveLocalSessions(nextKnown);
        setSessions(nextKnown);
        setCurrentSessionId(createdId);
        tagSessionProject(createdId);
        addLog(`Created session ${createdId} on the gateway before the first message`);
        // A Stop during the create must stick: without this guard the turn
        // fires anyway after the user cancelled it.
        if (turnTokenRef.current !== createToken) {
          addLog('First message dropped: stopped while the session was being created.');
          return;
        }
        runTurn(createdId, trimmed, imageDataUrls, userMsgId, agentMsgId);
      })
      .catch((e: unknown) => {
        // The session never existed, so there is no ghost to clean up: report
        // the failure and leave the chat exactly where it was.
        const appErr = toAppError(e);
        const status = typeof appErr.status === 'number' ? appErr.status : 0;
        const message = isHttpAuthStatus(status)
          ? authFailureCopy()
          : appErr.offline || appErr.code === 'unavailable'
            ? unreachableCopy()
            : tx(
                'errSessionCreateFailed',
                'Could not start a new chat. Check the connection and try again.'
              );
        if (turnTokenRef.current === createToken) {
          // This create still owns the shared refs, so releasing them here is
          // safe. When a newer turn has claimed them meanwhile, clearing them
          // would strand that live turn with no abort handle or run id.
          streamingRef.current = false;
          setStreaming(false);
          lastAgentMsgIdRef.current = null;
        }
        setStreamErrorFor(NO_SESSION_ERROR_KEY, message);
        setTurnMeta((prev) => {
          const next = { ...prev };
          delete next[agentMsgId];
          return next;
        });
        addLog(`Create session failed (${appErr.code}): ${appErr.message}`);
        if (isHttpAuthStatus(status)) markGatewayUnauthorized('create session', status);
      });

    return true;
  };

  const sendNow = (text: string, imageDataUrls: string[] = []): boolean | 'queued' => {
    const trimmed = text.trim();
    if (!trimmed && imageDataUrls.length === 0) return false;
    // Offline first: stopping the (absent) stream would wipe the queue and
    // then discover there is nowhere to send. Queue straight away.
    if (!connectedRef.current) {
      queueMessage(trimmed, imageDataUrls);
      addLog('Gateway offline, message queued until it is reachable again');
      return 'queued';
    }
    // Stop-then-send in the same tick: stopStream clears streamingRef synchronously.
    if (streamingRef.current) {
      stopStream();
    }
    if (streamingRef.current) {
      queueMessage(trimmed, imageDataUrls);
      return 'queued';
    }
    const ok = sendMessage(trimmed, imageDataUrls);
    if (!ok) {
      queueMessage(trimmed, imageDataUrls);
      return 'queued';
    }
    return true;
  };

  // The queue only drains once a stream frees up, and every entry carries the
  // full message plus base64 image payloads: bound it so a long offline
  // stretch cannot grow it without limit. Newest entries win.
  const QUEUED_MESSAGE_LIMIT = 50;
  const OUTBOX_STORAGE_KEY = 'hermes_outbox_v1';
  // The queue used to live in memory only: a restart wiped it while the
  // banner promised delivery. Persist text always; image payloads ride
  // along best-effort (quota failures fall back to text with a log line).
  const persistOutbox = (items: QueuedMessage[]) => {
    try {
      window.localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(items));
    } catch {
      try {
        const slim = items.map((m) => ({ text: m.text, images: [] as string[] }));
        window.localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(slim));
        addLog('Outbox images dropped: storage quota. Text kept.');
      } catch {
        addLog('Outbox persist failed: storage unavailable.');
      }
    }
  };
  const restoreOutbox = (): QueuedMessage[] => {
    try {
      const raw = window.localStorage.getItem(OUTBOX_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as Array<{ text?: string; images?: string[] }>;
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((m) => m && ((m.text || '').trim() || (m.images || []).length > 0))
        .slice(-QUEUED_MESSAGE_LIMIT)
        .map((m) => ({ text: (m.text || '').trim(), images: Array.isArray(m.images) ? m.images : [] }));
    } catch {
      return [];
    }
  };

  const queueMessage = (text: string, imageDataUrls: string[] = []): boolean => {
    const t = text.trim();
    if (!t && imageDataUrls.length === 0) return false;
    const next = [...queuedRef.current, { text: t, images: imageDataUrls }];
    let dropped = 0;
    while (next.length > QUEUED_MESSAGE_LIMIT) { next.shift(); dropped += 1; }
    if (dropped > 0) addLog(`Outbox full: dropped ${dropped} oldest message(s).`);
    queuedRef.current = next;
    setQueuedMessages(next);
    persistOutbox(next);
    return true;
  };

  const cancelQueued = () => {
    queuedRef.current = [];
    setQueuedMessages([]);
    persistOutbox([]);
  };

  // Boot restore: the outbox survives restarts, so the queued bar is
  // truthful instead of a memory-only promise.
  useEffect(() => {
    const saved = restoreOutbox();
    if (saved.length > 0) {
      queuedRef.current = saved;
      setQueuedMessages(saved);
      addLog(`Outbox restored: ${saved.length} queued message(s) kept.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resend the last user message after clearing any trailing failed or
  // empty hermes bubbles. sendMessage strips those as well. NOTE: this
  // starts a NEW gateway run (there is no server-side resume token); the
  // resent text plus the cleaned history is the resume mechanism.
  const retryLast = (): boolean => {
    const sid = currentSessionIdRef.current;
    if (!sid || streamingRef.current) return false;
    const history = gatewayService.loadLocalMessages(sid);
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.sender === 'you' && (m.content || '').trim()) {
        return sendMessage(m.content, turnImages(m.id));
      }
    }
    return false;
  };

  // Retry with a readiness gate: a failed turn on a dead gateway must heal
  // the server first (start + wait for health) and only resend on READY.
  // Returns false when there is nothing to retry or the server never became
  // ready; the caller says that out loud instead of reposting blindly.
  const retryAfterReady = async (): Promise<boolean> => {
    if (!connectedRef.current) {
      addLog('Retry: gateway not healthy, starting it before resending');
      try {
        await startGateway();
      } catch {
        /* startGateway publishes its own failure state */
      }
      for (let i = 0; i < 24; i++) {
        if (connectedRef.current) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!connectedRef.current || streamingRef.current) return false;
    return retryLast();
  };

  const resolveApproval = async (
    approval: PendingApproval,
    allow: boolean,
    mode: string = 'once'
  ): Promise<'ok' | 'resolved' | 'failed'> => {
    let outcome: 'ok' | 'resolved' | 'failed' = 'failed';
    try {
      outcome = await gatewayService.resolveApproval(approval.runId, allow, mode);
    } catch {
      outcome = 'failed';
    }
    if (outcome === 'ok' || outcome === 'resolved') {
      setApprovals((prev) => removeResolved(prev, approval.runId));
      // Release the notify tombstone: a reused runId must be able to alert
      // again, and the set must not grow for the life of the session.
      notifiedApprovalIdsRef.current.delete(approval.runId);
      addLog(
        outcome === 'ok'
          ? `Approval for "${approval.summary.slice(0, 40)}" ${allow ? 'ALLOWED (' + mode + ')' : 'DENIED'}`
          : `Approval for "${approval.summary.slice(0, 40)}" already resolved elsewhere (run ${approval.runId}); dropping the card.`
      );
    } else {
      // Keep the card and surface the failure WITHOUT a chat bubble: a
      // 'hermes' bubble here would ride along in the next turn's history
      // and read as assistant speech. The retry bar carries the message.
      addLog(`Approval ${allow ? 'grant' : 'deny'} failed: gateway did not confirm. Keeping the pending approval.`);
      setStreamError(
        tx(
          'approvalNotConfirmedPlain',
          'Hermes did not confirm this decision, so it is still waiting. Retry it, and check the connection if it repeats.',
        ),
      );
    }
    return outcome;
  };

  // Jobs Actions
  const refreshJobs = async () => {
    // Loading flag up front so the jobs list never hangs without a state.
    setListsMeta((prev) => ({
      ...prev,
      jobs: {
        live: false,
        stale: prev.jobs?.stale ?? false,
        error: '',
        lastSyncedAt: prev.jobs?.lastSyncedAt ?? null,
        uiState: jobs.length > 0 ? 'refreshing' : 'loading',
      },
    }));
    let res: ListSyncResult<CronJob>;
    try {
      res = await gatewayService.jobsWithState();
    } catch (e: unknown) {
      // jobsWithState envelopes failures itself, but a transport-level throw
      // must still land an honest error envelope (never a silent hang).
      // Copy stays cause + action; raw transport text never reaches the UI.
      setListsMeta((prev) => {
        const count = jobs.length;
        const meta = {
          live: false,
          stale: count > 0,
          error: count > 0
            ? 'Jobs unavailable. Showing cached jobs, pull to retry.'
            : 'Jobs unavailable. Check the gateway status and retry.',
        };
        return {
          ...prev,
          jobs: {
            live: false,
            stale: meta.stale,
            error: meta.error,
            lastSyncedAt: prev.jobs?.lastSyncedAt ?? null,
            uiState: resolveListUiState(meta, count),
          },
        };
      });
      throw e;
    }
    setJobs(res.items);
    setListMeta('jobs', res, res.items.length, {});
    const ids = new Set(res.items.map((j) => j.id));
    setCronRuns((prev) => {
      const next: Record<string, CronRun[]> = {};
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        if (ids.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  };

  const createJob = async (name: string, schedule: string, prompt: string): Promise<boolean> => {
    const ok = await gatewayService.createJob(name, schedule, prompt);
    if (ok) {
      // refreshJobs published the stale envelope already; this catch only
      // keeps its rethrow from escaping as an unhandled rejection.
      void refreshJobs().catch(() => {});
    }
    return ok;
  };

  const jobAction = async (id: string, action: string): Promise<boolean> => {
    const ok = await gatewayService.jobAction(id, action);
    if (ok) {
      if (action === 'delete') {
        setCronRuns((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      // refreshJobs published the stale envelope already; this catch only
      // keeps its rethrow from escaping as an unhandled rejection.
      void refreshJobs().catch(() => {});
    }
    return ok;
  };

  const updateJob = async (id: string, patch: { name?: string; schedule?: string; prompt?: string }): Promise<boolean> => {
    const ok = await gatewayService.updateJob(id, patch);
    if (ok) {
      // refreshJobs published the stale envelope already; this catch only
      // keeps its rethrow from escaping as an unhandled rejection.
      void refreshJobs().catch(() => {});
    }
    return ok;
  };

  const fetchRuns = async (jobId: string) => {
    try {
      const runs = await gatewayService.cronRuns(jobId);
      // LiveList carries the gateway live flag: a failed fetch stores an
      // empty list with live === false, which must never wipe the
      // last-known-good history behind the stale/error panel.
      if ((runs as unknown as { live?: boolean }).live === false) return;
      setCronRuns((prev) => ({ ...prev, [jobId]: runs }));
    } catch {
      // Transport failure: keep last-known-good history as well.
    }
  };

  return (
    <HermesContext.Provider
      value={{
        settings,
        updateSettings,
        saveKeys,
        configuredProviders: settings.providers || [],
        addConfiguredProvider,
        updateConfiguredProvider,
        removeConfiguredProvider,
        activateProvider,
        install,
        installProgress,
        installError,
        gatewayLogs,
        connected,
        gatewayState,
        gatewayStatus,
        gatewayFailed,
        gatewayFailureReason,
        gatewayFailureKind,
        // startFailure: null normally, or a short stable token when the
        // gateway failed to come up AFTER a successful install (currently
        // 'start-timeout', set by the 4-minute native start wait and cleared
        // by a later RUNNING, by a fresh start attempt, or by a real install
        // attempt). install='FAILED' alone cannot tell those two stories
        // apart, so consumers map this token to their own copy instead of
        // printing install copy over an install that succeeded.
        startFailure,
        startGateway,
        stopGateway,
        installGateway,
        refreshNow,
        listsMeta,
        sessions,
        currentSessionId,
        chat,
        streaming,
        streamElapsed,
        turnMeta,
        usageIn,
        usageOut,
        approvals,
        queuedMessages,
        models,
        refreshModels,
        ensureServerKey,
        gatewayService,
        projects,
        activeProjectId,
        sessionProjects,
        createProject,
        exportProject,
        selectProject,
        removeProject,
        modelsLiveInfo,
        skills,
        setSkills,
        blueprints,
        memory,
        setMemory,
        pinnedIds,
        togglePin,
        deletedSessionIds,
        selectSession,
        newSession,
        deleteSession,
        renameSession,
        forkSession,
        sendMessage,
        sendNow,
        queueMessage,
        cancelQueued,
        stopStream,
        resolveApproval,
        vaultUnlocked,
        unlockSecrets,
        lockSecrets,
        lockNow,
        retryLast,
        retryAfterReady,
        turnImages,
        streamError,
        settingsSaveError,
        settingsSaveState,
        settingsSaveRevision,
        settingsSavedAt,
        getDraft,
        setDraft,
        jobs,
        refreshJobs,
        createJob,
        jobAction,
        updateJob,
        cronRuns,
        fetchRuns,
        service: gatewayService,
        t,
      }}
    >
      {children}
    </HermesContext.Provider>
  );
};

export const useHermes = () => {
  const ctx = useContext(HermesContext);
  if (!ctx) throw new Error('useHermes must be used within HermesProvider');
  return ctx;
};
