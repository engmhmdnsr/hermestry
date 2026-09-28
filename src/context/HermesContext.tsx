import React, { createContext, useContext, useEffect, useState, useRef, useMemo } from 'react';
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
  QueuedMessage,
  SkillInfo,
  TurnMeta,
} from '../types/hermes';
import type { ListUiState, SyncMeta, ListSyncResult } from '../services/syncState';
import { GatewayService } from '../services/gateway';
import {
  isNativeGateway,
  nativeInstall,
  nativeStart,
  nativeStop,
  nativeStatus,
  nativeHealth,
  nativeServerKey,
  nativeSetAutostart,
  nativeSetProvider,
} from '../services/nativeGateway';
import {
  mapNativeStatusToGatewayState,
  isTransitional,
  toLegacyInstallState,
  type GatewayState,
} from '../services/gatewayState';
import { resolveListUiState } from '../services/pagination';
import {
  lockVault,
  unlockVault,
  vaultLocked,
  vaultDecryptSecrets,
  sanitizeForPersist,
  sanitizeVaultPayload,
} from '../services/secureStore';
import {
  transactionalVaultSave,
  purgeAllSecretHolders,
  blankSecretHolder,
  VaultWriteError,
} from '../services/vaultTransaction';
import { loadMigratedSettings } from '../services/storageMigrations';
import {
  loadCachedPending,
  cachePending,
  reconcilePending,
} from '../components/approvals/pendingApprovals';
import {
  normalizePolicy,
  isScopeAllowed,
  fromLegacyGlobal,
  type AutoApproveScope,
} from '../components/approvals/approvalScopes';
import {
  createProvider,
  updateProvider as storeUpdateProvider,
  removeProvider as storeRemoveProvider,
  activateProvider as storeActivateProvider,
  type ProviderProfile,
} from '../services/providerStore';
import { SseParser, isTerminalSseEvent } from '../services/sseParser';
import { toAppError } from '../services/appErrors';
import { secretRefForProfile } from '../services/secretRefs';
import { normProvider, DEFAULT_MODELS, PROVIDER_OPTIONS } from '../constants/providers';
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

// Error key used when a send fails before any session exists (the first
// message of a chat whose gateway session could not be created).
const NO_SESSION_ERROR_KEY = '__no_session__';

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
  activeRunId: string | null;
  turnMeta: Record<string, TurnMeta>;
  usageIn: number;
  usageOut: number;
  approvals: PendingApproval[];
  queuedMessages: QueuedMessage[];
  models: AiModelInfo[];
  skills: SkillInfo[];
  blueprints: Blueprint[];
  memory: MemoryInfo | null;
  pinnedIds: string[];
  togglePin: (id: string) => void;
  
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
  resolveApproval: (approval: PendingApproval, allow: boolean, mode?: string) => Promise<void>;
  
  // Vault (encrypted secrets live decrypted only in memory refs)
  vaultUnlocked: boolean;
  unlockSecrets: (pin: string) => Promise<boolean>;
  lockSecrets: () => void;
  lockNow: () => void;
  retryLast: () => boolean;
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
  addLog: (msg: string) => void;
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
  appLockPin: '1234',
  fontScale: 1.0,
  reasoningEffort: 'medium',
  autoApproveGlobal: false,
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
      });
      if (migrated) {
        const parsed = { ...(migrated.data as Partial<HermesSettings>) };
        const merged = { ...DEFAULT_SETTINGS, ...parsed };
        if (!VALID_APPROVAL_SCOPES.includes(merged.approvalScope)) {
          merged.approvalScope = 'once';
        }
        if (!merged.activeProviderId && Array.isArray(merged.providers) && merged.providers.length > 0) {
          const match =
            merged.providers.find((p: ConfiguredProvider) => p.provider === merged.provider) ||
            merged.providers[0];
          merged.activeProviderId = match.id;
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
      'The gateway rejected the stored key. Check the provider key and Base URL in Settings, then try again.'
    );

  const sessionGoneCopy = (): string =>
    tx('errSessionGone', 'This chat is no longer on the gateway. Start a new chat.');

  const unreachableCopy = (): string =>
    // Existing key: the list loaders already use this exact cause+action copy.
    t('errUnavailable') ||
    'The gateway is unreachable. Make sure it is running, then try again.';

  const streamClosedCopy = (): string =>
    tx(
      'errStreamClosed',
      'The gateway closed the connection before the answer finished. Try again.'
    );

  const gatewayRejectedCopy = (): string =>
    t('errUnknown') || 'Something went wrong. Try again, and run diagnostics if it continues.';

  // Cause + action for a non-OK response from an authenticated gateway
  // endpoint. Shared by the stream runner and the first-message session
  // creator so both give the same advice for the same status.
  const httpStatusCopy = (status: number): string => {
    if (isHttpAuthStatus(status)) return authFailureCopy();
    if (status === 404) return sessionGoneCopy();
    return gatewayRejectedCopy();
  };

  // A fetch that never reached the gateway throws TypeError('Failed to
  // fetch') / 'NetworkError' / 'Load failed' depending on the platform.
  const isNetworkFailure = (err: unknown): boolean => {
    if (err instanceof TypeError) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return /failed to fetch|networkerror|network error|load failed|econnrefused|unreachable/i.test(msg);
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
    detail: 'Probing gateway health...',
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

  // Sessions and Chat
  const [sessions, setSessions] = useState<MobileSession[]>([]);
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
  const refreshTokenRef = useRef<number>(0);
  const sessionsRef = useRef<MobileSession[]>(sessions);
  sessionsRef.current = sessions;
  // Per-turn usage tracking for the estimation fallback.
  const turnUsageSeenRef = useRef<boolean>(false);
  const turnOutCharsRef = useRef<number>(0);
  // Agent bubble id of the in-flight turn, so stopStream can mark its
  // turnMeta.stopped even though state lags a render.
  const lastAgentMsgIdRef = useRef<string | null>(null);
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
        'Settings were not saved: the encrypted vault write failed. Unlock the app and try again.'
      );
    }
    const detail = e instanceof Error ? e.message : String(e);
    return `Settings write failed: ${detail}`;
  };

  // Transactional persist. AppLock on: sanitized settings to localStorage +
  // cipher committed via transactionalVaultSave (rejects with VaultWriteError
  // on any failure, previous vault kept). AppLock off: legacy plaintext
  // write. Failures set settingsSaveError loudly and rethrow; callers must
  // never report Saved when this rejects.
  const persistSettings = async (next: HermesSettings): Promise<void> => {
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
        localStorage.setItem('hermes_settings', JSON.stringify(next));
        try {
          localStorage.removeItem('hermes_vault');
        } catch {}
      } else {
        // Vault locked: persist the sanitized public copy only, never secrets.
        const pub = sanitizeForPersist({ ...next } as unknown as Record<string, unknown>) as unknown as HermesSettings;
        localStorage.setItem('hermes_settings', JSON.stringify(pub));
      }
      // 'saved' is honest only here: every write above resolved without throw.
      setSettingsSaveError(null);
      setSettingsSaveState('saved');
      setSettingsSavedAt(Date.now());
    } catch (e) {
      const msg = describeSaveFailure(e);
      setSettingsSaveError(msg);
      setSettingsSaveState('error');
      addLog(`Settings save failed: ${msg}`);
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
  // predate these fields. Every rejection is logged truthfully and never
  // thrown, because the settings write itself already landed.
  const mirrorCredentialsToNative = (next: HermesSettings, reason: string) => {
    if (!isNativeGateway()) return;
    nativeSetProvider({
      provider: next.provider || '',
      apiKey: next.apiKey || '',
      baseUrl: next.baseUrl || '',
      model: next.modelId || '',
      serverKey: next.serverKey || '',
      tgToken: next.tgToken || '',
      discordToken: next.discordToken || '',
    }).catch((e: unknown) => {
      addLog(
        `Native credential sync failed (${reason}): ${e instanceof Error ? e.message : String(e)}`
      );
    });
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
    if (newSettings.appLockEnabled && !prev.appLockEnabled && next.appLockPin) {
      lockVault(next.appLockPin)
        .then(() => {
          setVaultUnlocked(true);
          return persistSettings(next);
        })
        .catch((e: unknown) => {
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
        void persistSettings(next).catch((e: unknown) => {
          addLog(
            `Settings persist after blocked PIN change needs attention: ${e instanceof Error ? e.message : String(e)}`
          );
        });
      } else {
        lockVault(next.appLockPin)
          .then(() => {
            setVaultUnlocked(true);
            return persistSettings(next);
          })
          .catch((e: unknown) => {
            addLog(`Vault persist after PIN rotation needs attention: ${e instanceof Error ? e.message : String(e)}`);
          });
      }
    } else {
      if (!next.appLockEnabled) setVaultUnlocked(true);
      // persistSettings surfaces failures via settingsSaveError + log; this
      // catch only stops the rejection from escaping as unhandled.
      void persistSettings(next).catch((e: unknown) => {
        addLog(`Settings persist failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    // On-device APK: mirror the autostart switch into the native prefs
    // that BootReceiver reads, so boot start follows the same toggle.
    if (next.autostart !== prev.autostart && isNativeGateway()) {
      nativeSetAutostart(next.autostart).catch((e: unknown) => {
        addLog(`Native autostart sync failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    // On-device APK: mirror the active provider/key/model into the native
    // prefs renderConfig reads on every gateway (re)start. Otherwise the
    // gateway keeps the old provider and chat fails auth. Sync failures are
    // logged truthfully instead of swallowed.
    if (
      isNativeGateway() &&
      (next.provider !== prev.provider ||
        next.apiKey !== prev.apiKey ||
        next.baseUrl !== prev.baseUrl ||
        next.modelId !== prev.modelId ||
        next.serverKey !== prev.serverKey ||
        next.tgToken !== prev.tgToken ||
        next.discordToken !== prev.discordToken)
    ) {
      mirrorCredentialsToNative(next, 'provider change');
    }
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
          // Decrypt failure (stale key, tampered envelope): report failure
          // instead of a half-unlocked vault.
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
    setVaultUnlocked(false);
    setSettings((prev) => ({
      ...prev,
      apiKey: '',
      serverKey: '',
      tgToken: '',
      discordToken: '',
      appLockPin: '',
      providers: (prev.providers || []).map((p) => ({ ...p, apiKey: '' })),
    }));
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
    const activeModel = clean(model) || DEFAULT_MODELS[normed]?.[0] || '';

    // Single-write-path sync into the configured list: key material goes
    // through providerStore (writeProviderCredential), never a direct
    // apiKey assignment here.
    const currentProfiles = (settings.providers || []).map(toProfile);
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
      (settings.providers || []).map(toProfile),
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
    const profiles = (settings.providers || []).map(toProfile);
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
    // Sync settings only when the edited profile is the active one,
    // matched by id so duplicate profiles of the same slug do not bleed.
    const activeId = settingsRef.current.activeProviderId;
    const isActiveById = activeId ? target?.id === activeId : target?.provider === settingsRef.current.provider;
    if (target && isActiveById) {
      const cur = settingsRef.current;
      const liveKey = target.secretRef ? (providerSecretsRef.current || {})[target.secretRef] || '' : '';
      updateSettings({
        providers: nextList,
        apiKey: updates.apiKey !== undefined ? liveKey : cur.apiKey,
        baseUrl: updates.baseUrl !== undefined ? (updates.baseUrl || '') : cur.baseUrl,
        modelId: updates.defaultModel !== undefined ? updates.defaultModel : cur.modelId,
      });
    } else {
      updateSettings({ providers: nextList });
    }
  };

  const removeConfiguredProvider = (id: string) => {
    const target = (settings.providers || []).find((p) => p.id === id);
    // removeProvider also erases the profile's vault entry.
    const res = storeRemoveProvider(
      (settings.providers || []).map(toProfile),
      id,
      getProviderSecrets()
    );
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
      updateSettings({ providers: nextList });
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
    updateSettings({
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

  // Initial data load once on boot. The models list below aggregates every
  // configured provider, so it must not refetch when the active provider
  // or model selection changes.
  useEffect(() => {
    // On-device: pull the minted local-API key into settings once. Without
    // it every /api/* call fails auth (empty sessions, jobs, model lists).
    if (isNativeGateway() && !settingsRef.current.serverKey) {
      nativeServerKey()
        .then((k) => {
          if (k) {
            updateSettings({ serverKey: k });
            // Re-run with auth: the first refreshNow above went out keyless.
            refreshNow();
          }
        })
        .catch((e: unknown) => {
          // Silent failure here means every authenticated call goes out
          // keyless (empty sessions/jobs), so it must be visible in the log.
          addLog(
            `Local gateway key unavailable: ${e instanceof Error ? e.message : String(e)}. Authenticated calls may fail until Settings holds the key.`
          );
        });
    }
    // On-device: push the already-saved web provider/key into the native
    // prefs once, so upgrades do not leave the gateway on a stale provider.
    if (isNativeGateway()) {
      // Upgrade path: push whatever the web side already saved, credentials
      // included, so the first gateway start after an update is not stale.
      mirrorCredentialsToNative(settingsRef.current, 'boot sync');
    }
    refreshNow();
    // Pending approvals startup: show the cached list instantly (offline
    // boot included), then reconcile with the gateway's live list. Cached
    // entries for runs the gateway no longer reports are dropped, so a
    // reload never resurrects resolved approvals.
    const cachedPending = loadCachedPending();
    setApprovals(cachedPending);
    approvalsHydratedRef.current = true;
    cachePending(cachedPending);
    gatewayService
      .listPendingApprovals()
      .then((fresh) => {
        const merged = reconcilePending(cachedPending, fresh);
        setApprovals(merged);
        cachePending(merged);
      })
      .catch(() => {
        // Offline gateway: the cached list stands; refreshNow logged health.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable key over the configured provider set. Editing unrelated settings
  // (active provider, model, theme) keeps this key identical, so switching
  // providers does not refetch the whole model catalog.
  const providersKey = (settings.providers || [])
    .map((p) => `${p.id}:${p.provider}:${p.enabled !== false}:${p.defaultModel}`)
    .join('|');

  useEffect(() => {
    // Load models ONLY for the active provider and actually configured providers.
    // Provider and model are read from the ref so selecting them does not
    // retrigger this effect.
    const activeProvider = settingsRef.current.provider || 'deepseek';
    const configuredList = settingsRef.current.providers || [];
    const selectedModel = settingsRef.current.modelId;

    const loadAllModels = async () => {
      const modelMap = new Map<string, AiModelInfo>();

      // Collect ONLY the providers that are actually configured / added and enabled
      const activeProviderKeys = new Set<string>();
      if (activeProvider) {
        activeProviderKeys.add(normProvider(activeProvider));
      }
      for (const prov of configuredList) {
        if (prov.enabled !== false && prov.provider) {
          activeProviderKeys.add(normProvider(prov.provider));
        }
      }

      // 1. Populate models ONLY from DEFAULT_MODELS for the actually configured providers
      for (const provKey of activeProviderKeys) {
        const modelList = DEFAULT_MODELS[provKey] || [];
        for (const id of modelList) {
          const parts = id.split('/');
          const rawName = parts.length > 1 ? parts[1] : parts[0];
          const clean = rawName
            .replace(/[-_]/g, ' ')
            .replace(/\b([a-z])/g, (c) => c.toUpperCase());

          modelMap.set(id, {
            id,
            displayName: clean,
            provider: provKey,
          });
        }

        // Fetch from gateway/presets for this configured provider to supplement
        try {
          const provOptions = await gatewayService.modelOptions(provKey);
          provOptions.forEach((m) => {
            if (!modelMap.has(m.id)) {
              modelMap.set(m.id, {
                ...m,
                provider: m.provider || provKey,
              });
            }
          });
        } catch {}
      }

      // 2. Add custom models for configured providers
      for (const prov of configuredList) {
        if (prov.enabled === false) continue;
        if (prov.defaultModel && !modelMap.has(prov.defaultModel)) {
          const parts = prov.defaultModel.split('/');
          const rawName = parts.length > 1 ? parts[1] : parts[0];
          const clean = rawName
            .replace(/[-_]/g, ' ')
            .replace(/\b([a-z])/g, (c) => c.toUpperCase());

          modelMap.set(prov.defaultModel, {
            id: prov.defaultModel,
            displayName: clean,
            provider: prov.provider,
          });
        }
      }

      // 3. Ensure current selected model is present in the list
      if (selectedModel && !modelMap.has(selectedModel)) {
        const parts = selectedModel.split('/');
        const rawName = parts.length > 1 ? parts[1] : parts[0];
        const clean = rawName
          .replace(/[-_]/g, ' ')
          .replace(/\b([a-z])/g, (c) => c.toUpperCase());

        modelMap.set(selectedModel, {
          id: selectedModel,
          displayName: clean,
          provider: activeProvider,
        });
      }

      setModels(Array.from(modelMap.values()));
    };

    loadAllModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayService, providersKey]);

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
    setGatewayFailureReason(
      tx(
        'errGatewayKeyRejected',
        'The gateway rejected the stored key. Check the key and Base URL in Settings, then retry.'
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
      // On-device the WebView fetch can be blocked (mixed content), so ask
      // the native side, which probes 127.0.0.1:8080 directly.
      const isOk = isNativeGateway() ? await nativeHealth() : await gatewayService.health();
      if (!alive()) return;
      setConnected(isOk);
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
          lastSyncedAt: null,
        },
        memRes.entries
      );
      if (!memRes.live) addLog(`Memory unavailable: ${memRes.summary}`);
      // Keep the current session; only auto-select when none is active.
      const cur = currentSessionIdRef.current;
      if (cur) {
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

  const startGateway = async () => {
    addLog('Starting Hermes gateway daemon...');
    // Leave the install state alone on-device: the wizard shows its Continue
    // button only for INSTALLED, and 'RUNNING' would strand the user there.
    if (!isNativeGateway()) setInstall('RUNNING');
    setGatewayFailed(false);
    setGatewayFailureReason(null);
    setGatewayFailureKind(null);
    // On-device APK: start the real gateway process via the native runner.
    if (isNativeGateway()) {
      try {
        await nativeStart();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        setConnected(false);
        setGatewayFailed(true);
        setGatewayFailureKind('start');
        setGatewayFailureReason(reason);
        addLog(`Gateway start failed: ${reason}`);
        return;
      }
      // First boot prepares the runtime inside proot (minutes). Poll health
      // instead of probing once, or the UI reports failure while boot is
      // still in progress.
      addLog('Gateway process starting, waiting for health...');
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
        if (i % 6 === 5) addLog(`Still waiting for gateway (${(i + 1) * 5}s)...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (nativeHealthy) {
        setConnected(true);
        setInstall('INSTALLED');
        setInstallProgress('');
        addLog('Gateway running');
        refreshNow();
      } else {
        setConnected(false);
        setGatewayFailed(true);
        setGatewayFailureKind('unhealthy');
        setInstall('FAILED');
        setInstallProgress('');
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
      addLog('Gateway running');
      refreshNow();
    } else {
      setConnected(false);
      setGatewayFailed(true);
      setGatewayFailureKind('unhealthy');
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
    if (!isNativeGateway()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const applyState = (mapped: GatewayState) => {
      setGatewayState(mapped);
      gatewayStateRef.current = mapped;
      if (mapped === 'RUNNING') {
        setConnected(true);
        // Leave install alone while running: the wizard shows Continue
        // only for INSTALLED and start flows own the transition.
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
      }
    };
    const poll = async () => {
      if (cancelled) return;
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
    addLog('Autostart enabled, starting gateway...');
    startGateway();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installGateway = async () => {
    setInstall('INSTALLING');
    setInstallError(null);
    // On-device APK: run the real one-shot image install via the native
    // runner (download + sha256 verify + extract + proot). Logs stream live.
    if (isNativeGateway()) {
      setInstallProgress('Downloading hermes-image (~305MB)...');
      addLog('Download started from repository manifest');
      const res = await nativeInstall(
        (line) => addLog(line),
        (downloaded, total) => {
          const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          setInstallProgress(`Installing on-device image (${pct}%)...`);
        }
      );
      if (!res.ok) {
        setInstall('FAILED');
        setInstallProgress('');
        setInstallError(res.error || 'On-device install failed. Press Retry to try again.');
        setConnected(false);
        addLog(`Install failed: ${res.error || 'unknown error'}`);
        return;
      }
      // Install done only means the image is on disk; the gateway is not
      // running yet, so a health probe here would fail spuriously. Hand off
      // to startGateway, which boots the real process then probes honestly.
      setInstallProgress('Image ready, starting gateway...');
      addLog('Installed Hermes rootfs OK, starting gateway');
      await startGateway();
      return;
    } else {
      // Web preview has no local installer: there is nothing to download
      // or extract here. Keep progress indeterminate and let the health
      // probe below decide the outcome honestly.
      setInstallProgress('Checking gateway...');
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
      refreshNow();
    } else {
      setInstall('FAILED');
      setInstallProgress('');
      setInstallError('Install finished but the gateway health check failed. Press Retry to try again.');
      setConnected(false);
      addLog('Install failed: gateway health check did not pass after install');
    }
  };

  const selectSession = (id: string) => {
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
    }
    streamingRef.current = false;
    setStreaming(false);
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

  const newSession = async (): Promise<string> => {
    try {
      const id = await gatewayService.createSession(settings.modelId);
      const updated = await gatewayService.fetchSessions();
      setSessions(updated);
      selectSession(id);
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
    setSessions(updated);
    // The session is gone: drop its persisted turn badges and its scoped
    // stream error so nothing about it survives a reload or a chat switch.
    dropTurnMetaStore(id);
    delete streamErrorsRef.current[id];
    if (currentSessionId === id) {
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
    const ok = await gatewayService.renameSession(id, title);
    if (!ok) {
      // Throw so the drawer catch shows its rename error (U4).
      addLog(`Rename session ${id} failed: the gateway did not confirm. Title unchanged.`);
      throw new Error(`Rename session ${id} failed: the gateway did not confirm.`);
    }
    const updated = await gatewayService.fetchSessions();
    setSessions(updated);
    addLog(`Renamed session to "${title}"`);
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
      addLog(`Dropped ${n} queued message(s) (${reason})`);
    }
    return n;
  };

  // Map an approval request to a granular auto-approve scope. Returns null
  // when nothing matches: unmapped capabilities default to manual approval
  // (deny), never to auto-allow.
  const approvalScopeOf = (req: PendingApproval): AutoApproveScope | null => {
    const tool = (req.tool || '').toLowerCase();
    const cmd = (req.command || '').toLowerCase();
    const hay = `${tool} ${cmd} ${req.path || ''} ${req.summary}`.toLowerCase();
    if (/(^|[^a-z])(install|apt|brew|npm install|pip install|cargo add)([^a-z]|$)/.test(hay)) return 'install';
    if (/(^|[^a-z])(exec|execute|shell|bash|sh -|terminal|run command)([^a-z]|$)/.test(hay)) return 'exec';
    if (/(^|[^a-z])(fetch|http|curl|wget|network|download|request)([^a-z]|$)/.test(hay)) return 'network';
    if (/(^|[^a-z])(write|edit|create|delete|remove|mkdir|apply_patch)([^a-z]|$)/.test(hay)) return 'write';
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
    callbacks: Parameters<GatewayService['streamChat']>[5],
    abortSignal?: AbortSignal
  ): Promise<void> => {
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
    let res: Response;
    try {
      res = await fetch(
        `http://127.0.0.1:8080/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
        { method: 'POST', headers, body: JSON.stringify(body), signal: abortSignal }
      );
    } catch (err) {
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
    const asRecord = (v: unknown): Record<string, unknown> =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
    const parser = new SseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let failedMessage: string | null = null;
    let stoppedByServer = false;
    const dispatch = (ev: { event: string; json: unknown }) => {
      const data = asRecord(ev.json);
      const runId = asString(data.run_id);
      if (runId) callbacks.onRunId?.(runId);
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
            asString(data.error || data.message || data.description) ||
            'the gateway reported a run failure';
          break;
        }
        case 'run.cancelled':
        case 'run.stopped':
        case 'cancelled':
        case 'stop': {
          stoppedByServer = true;
          break;
        }
        default: {
          if (isTerminalSseEvent(ev.event)) {
            // Terminal completion (done/run.completed/complete): the turn
            // simply ends; bookkeeping happens in the caller finally block.
          } else if (ev.event === 'message') {
            const text = asString(data.delta || data.text || data.content);
            if (text) {
              callbacks.onThinkingDone();
              callbacks.onText(text);
            }
          }
          break;
        }
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const ev of parser.feed(chunk)) dispatch(ev);
      }
      // Drain the tail: a final event without a trailing blank line still counts.
      for (const ev of parser.flush()) dispatch(ev);
      if (failedMessage) {
        callbacks.onError?.(failedMessage);
      } else if (stoppedByServer) {
        callbacks.onStopped?.();
      } else {
        callbacks.onThinkingDone();
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        callbacks.onStopped?.();
      } else {
        callbacks.onError?.(isNetworkFailure(err) ? unreachableCopy() : streamClosedCopy());
      }
    } finally {
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
  };

  const stopStream = async () => {
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
    // Await the stop result so the log tells the truth: confirmed means the
    // gateway acknowledged the stop, unconfirmed usually means the run had
    // already finished. Flags clear first so stop-then-send works sync.
    const runId = activeRunId;
    streamingRef.current = false;
    setStreaming(false);
    if (runId) {
      setActiveRunId(null);
      const confirmed = await gatewayService.stopRun(runId);
      addLog(
        confirmed
          ? `Stop confirmed by gateway for run ${runId}`
          : `Stop sent for run ${runId} but the gateway did not confirm; the run may have already finished.`
      );
    }
    dropQueued('stream stopped');
    // Mark pending assistant message as finished thinking, and flag the
    // in-flight turn as stopped so its meta reads stopped:true, not success.
    const stoppedAgentId = lastAgentMsgIdRef.current;
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
      const failed = (m.content || '').startsWith('Stream error:');
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
    const startTime = Date.now();
    const activeModel = settingsRef.current.modelId;
    const activeEffort = settingsRef.current.reasoningEffort;
    // Scoped auto-approve: the legacy global maps to a disabled policy
    // (fromLegacyGlobal), so only an explicit policy with matching scopes
    // auto-allows; unmapped capabilities default to manual approval.
    const autoPolicy = normalizePolicy(
      (settingsRef.current as unknown as { autoApprovePolicy?: unknown }).autoApprovePolicy ??
        fromLegacyGlobal(settingsRef.current.autoApproveGlobal)
    );
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
        onRunId: (rId) => setActiveRunId(rId),
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
          const scope = approvalScopeOf(req);
          if (scope && isScopeAllowed(autoPolicy, scope)) {
            resolveApproval(req, true, settingsRef.current.approvalScope || 'once');
          } else {
            setApprovals((prev) => (prev.some((a) => a.runId === req.runId) ? prev : [...prev, req]));
          }
        },
        onError: (message: string) => {
          // Failures surface via streamError + turnMeta.error, never as a
          // 'Stream error:' chat bubble (bubbles pollute history and get
          // re-sent as context on retry). Flush buffered deltas first so the
          // partial turn content is not lost.
          flushStreamBuffers();
          const msg = message || 'the gateway closed the stream unexpectedly';
          // Scoped to this session: a failure here must not paint an error
          // banner over whatever chat the user switched to meanwhile.
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
          flushStreamBuffers();
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
      } as Parameters<GatewayService['streamChat']>[5],
      abortControllerRef.current.signal
    )
      .finally(() => {
        streamingRef.current = false;
        setStreaming(false);
        setActiveRunId(null);
        lastAgentMsgIdRef.current = null;
        abortControllerRef.current = null;
        // Drain any deltas still buffered before turn bookkeeping runs.
        flushStreamBuffers();
        const duration = Date.now() - startTime;
        // Fallback: when the stream produced no usage events, estimate
        // tokens from text length so totals do not silently stay at zero.
        const estimated = !turnUsageSeenRef.current;
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
        const bumped = sessionsRef.current.map((s) =>
          s.id === sid
            ? { ...s, messageCount: s.messageCount + 2, lastActiveAt: Date.now() }
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
    queueDrainPendingRef.current = true;
    queuedRef.current = queuedRef.current.slice(1);
    setQueuedMessages([...queuedRef.current]);
    setTimeout(() => {
      queueDrainPendingRef.current = false;
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
    streamingRef.current = true;
    setStreaming(true);
    setStreamErrorFor(NO_SESSION_ERROR_KEY, null);
    lastAgentMsgIdRef.current = agentMsgId;
    setTurnMeta((prev) => ({ ...prev, [agentMsgId]: { model, durationMs: 0 } }));

    gatewayService
      .createSession(model, title)
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
        addLog(`Created session ${createdId} on the gateway before the first message`);
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
                'Could not start a new chat. Check the gateway status and try again.'
              );
        streamingRef.current = false;
        setStreaming(false);
        lastAgentMsgIdRef.current = null;
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

  const queueMessage = (text: string, imageDataUrls: string[] = []): boolean => {
    const t = text.trim();
    if (!t && imageDataUrls.length === 0) return false;
    const next = [...queuedRef.current, { text: t, images: imageDataUrls }];
    queuedRef.current = next;
    setQueuedMessages(next);
    return true;
  };

  const cancelQueued = () => {
    queuedRef.current = [];
    setQueuedMessages([]);
  };

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
        return sendMessage(m.content);
      }
    }
    return false;
  };

  const resolveApproval = async (approval: PendingApproval, allow: boolean, mode: string = 'once') => {
    let ok = false;
    try {
      ok = await gatewayService.resolveApproval(approval.runId, allow, mode);
    } catch {
      ok = false;
    }
    if (ok) {
      setApprovals((prev) => prev.filter((a) => a.runId !== approval.runId));
      addLog(`Approval for "${approval.summary.slice(0, 40)}" ${allow ? 'ALLOWED (' + mode + ')' : 'DENIED'}`);
    } else {
      // Keep the card and surface the failure.
      addLog(`Approval ${allow ? 'grant' : 'deny'} failed: gateway did not confirm. Keeping the pending approval.`);
      if (currentSessionIdRef.current === approval.sessionId) {
        const errBubble: ChatMessage = {
          id: newId('msg'),
          sender: 'hermes',
          content: `Approval ${allow ? 'grant' : 'deny'} failed: the gateway did not confirm. The approval is still pending.`,
          thinkingDone: true,
          timestamp: Date.now(),
        };
        setChat((prev) => [...prev, errBubble]);
      }
    }
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
    if (ok) refreshJobs();
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
      refreshJobs();
    }
    return ok;
  };

  const updateJob = async (id: string, patch: { name?: string; schedule?: string; prompt?: string }): Promise<boolean> => {
    const ok = await gatewayService.updateJob(id, patch);
    if (ok) refreshJobs();
    return ok;
  };

  const fetchRuns = async (jobId: string) => {
    const runs = await gatewayService.cronRuns(jobId);
    setCronRuns((prev) => ({ ...prev, [jobId]: runs }));
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
        activeRunId,
        turnMeta,
        usageIn,
        usageOut,
        approvals,
        queuedMessages,
        models,
        skills,
        blueprints,
        memory,
        pinnedIds,
        togglePin,
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
        addLog,
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
