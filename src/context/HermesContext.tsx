import React, { createContext, useContext, useEffect, useState, useRef, useMemo } from 'react';
import {
  AiModelInfo,
  ChatMessage,
  ConfiguredProvider,
  CronJob,
  CronRun,
  DoctorReport,
  GatewayStatus,
  InstallState,
  MobileSession,
  PendingApproval,
  QueuedMessage,
  TurnMeta,
} from '../types/hermes';
import { GatewayService } from '../services/gateway';
import {
  isNativeGateway,
  nativeInstall,
  nativeStart,
  nativeStop,
  nativeSetAutostart,
} from '../services/nativeGateway';
import {
  lockVault,
  unlockVault,
  vaultLocked,
  vaultEncryptSecrets,
  vaultDecryptSecrets,
} from '../services/secureStore';
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
  gatewayStatus: GatewayStatus;
  gatewayFailed: boolean;
  gatewayFailureReason: string | null;
  
  // Gateway control
  startGateway: () => Promise<void>;
  stopGateway: () => void;
  installGateway: () => Promise<void>;
  refreshNow: () => Promise<void>;
  
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
  stopStream: () => void;
  resolveApproval: (approval: PendingApproval, allow: boolean, mode?: string) => Promise<void>;
  
  // Vault (encrypted secrets live decrypted only in memory refs)
  vaultUnlocked: boolean;
  unlockSecrets: (pin: string) => Promise<boolean>;
  lockSecrets: () => void;
  lockNow: () => void;
  retryLast: () => boolean;

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

const DEFAULT_PROVIDERS: ConfiguredProvider[] = [
  {
    id: 'prov_deepseek_default',
    provider: 'deepseek',
    name: 'DeepSeek (Default)',
    apiKey: '',
    baseUrl: '',
    defaultModel: 'deepseek/deepseek-chat',
    enabled: true,
    validated: true,
  },
];

const DEFAULT_SETTINGS: HermesSettings = {
  provider: 'deepseek',
  apiKey: '',
  modelId: 'deepseek/deepseek-chat',
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
  activeProviderId: 'prov_deepseek_default',
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
  // Load settings from localStorage
  const [settings, setSettings] = useState<HermesSettings>(() => {
    try {
      const raw = localStorage.getItem('hermes_settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed.providers || parsed.providers.length === 0) {
          parsed.providers = [
            {
              id: 'prov_' + (parsed.provider || 'deepseek'),
              provider: parsed.provider || 'deepseek',
              name: parsed.provider ? parsed.provider.toUpperCase() : 'DeepSeek',
              apiKey: parsed.apiKey || '',
              baseUrl: parsed.baseUrl || '',
              defaultModel: parsed.modelId || 'deepseek/deepseek-chat',
              enabled: true,
              validated: true,
            },
          ];
        }
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

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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

  // Persist chat outside of state updaters (StrictMode purity).
  useEffect(() => {
    if (!currentSessionId || chat.length === 0) return;
    try {
      gatewayService.saveLocalMessages(currentSessionId, chat);
    } catch {}
  }, [chat, currentSessionId, gatewayService]);

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

  const persistSettings = (next: HermesSettings) => {
    secretsRef.current = {
      apiKey: next.apiKey,
      serverKey: next.serverKey,
      tgToken: next.tgToken,
      discordToken: next.discordToken,
      appLockPin: next.appLockPin,
    };
    if (next.appLockEnabled && !vaultLocked()) {
      const pub = { ...next, apiKey: '', serverKey: '', tgToken: '', discordToken: '', appLockPin: '' };
      try {
        localStorage.setItem('hermes_settings', JSON.stringify(pub));
      } catch {}
      try {
        if (next.appLockPin) localStorage.setItem('hermes_pinlen', String(next.appLockPin.length));
      } catch {}
      vaultEncryptSecrets({
        apiKey: next.apiKey || '',
        serverKey: next.serverKey || '',
        tgToken: next.tgToken || '',
        discordToken: next.discordToken || '',
        appLockPin: next.appLockPin || '',
      })
        .then((cipher) => {
          try {
            localStorage.setItem('hermes_vault', cipher);
          } catch {}
        })
        .catch(() => {});
    } else if (!next.appLockEnabled) {
      try {
        localStorage.setItem('hermes_settings', JSON.stringify(next));
      } catch {}
      try {
        localStorage.removeItem('hermes_vault');
        localStorage.removeItem('hermes_pinlen');
      } catch {}
    } else {
      const pub = { ...next, apiKey: '', serverKey: '', tgToken: '', discordToken: '', appLockPin: '' };
      try {
        localStorage.setItem('hermes_settings', JSON.stringify(pub));
      } catch {}
    }
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
      try {
        localStorage.setItem('hermes_pinlen', String(next.appLockPin.length));
      } catch {}
      lockVault(next.appLockPin)
        .then(() => {
          setVaultUnlocked(true);
          persistSettings(next);
        })
        .catch(() => {
          persistSettings(next);
        });
    } else {
      if (!next.appLockEnabled) setVaultUnlocked(true);
      persistSettings(next);
    }
    // On-device APK: mirror the autostart switch into the native prefs
    // that BootReceiver reads, so boot start follows the same toggle.
    if (next.autostart !== prev.autostart && isNativeGateway()) {
      nativeSetAutostart(next.autostart).catch(() => {});
    }
    setSettings(next);
  };

  const unlockSecrets = async (pin: string): Promise<boolean> => {
    const ok = await unlockVault(pin);
    if (!ok) return false;
    setVaultUnlocked(true);
    try {
      const cipher = localStorage.getItem('hermes_vault');
      if (cipher) {
        const s = await vaultDecryptSecrets(cipher);
        const next = {
          ...settingsRef.current,
          apiKey: s.apiKey || '',
          serverKey: s.serverKey || '',
          tgToken: s.tgToken || '',
          discordToken: s.discordToken || '',
          appLockPin: s.appLockPin || settingsRef.current.appLockPin,
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
    } catch {}
    return true;
  };

  const lockSecrets = () => {
    secretsRef.current = { apiKey: '', serverKey: '', tgToken: '', discordToken: '', appLockPin: '' };
    setVaultUnlocked(false);
    setSettings((prev) => ({ ...prev, apiKey: '', serverKey: '', tgToken: '', discordToken: '', appLockPin: '' }));
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
    const normed = normProvider(clean(provider)) || 'deepseek';
    const activeKey = clean(key);
    const activeModel = clean(model) || DEFAULT_MODELS[normed]?.[0] || 'deepseek/deepseek-chat';

    // Also sync into configured providers list
    const currentList = settings.providers || [];
    let updatedList: ConfiguredProvider[] = [];
    const existingIndex = currentList.findIndex((p) => p.provider === normed);
    let activeId = '';

    if (existingIndex >= 0) {
      updatedList = currentList.map((p, idx) =>
        idx === existingIndex
          ? {
              ...p,
              apiKey: activeKey,
              baseUrl: clean(baseUrl),
              defaultModel: activeModel,
              enabled: true,
              validated: true,
            }
          : p
      );
      activeId = updatedList[existingIndex].id;
    } else {
      const pName = PROVIDER_OPTIONS.find(([id]) => id === normed)?.[1] || normed.toUpperCase();
      const createdId = newId('prov_' + normed);
      activeId = createdId;
      updatedList = [
        ...currentList,
        {
          id: createdId,
          provider: normed,
          name: pName,
          apiKey: activeKey,
          baseUrl: clean(baseUrl),
          defaultModel: activeModel,
          enabled: true,
          validated: true,
        },
      ];
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

  // Multi-Provider CRUD methods
  const addConfiguredProvider = (prov: Omit<ConfiguredProvider, 'id'>): string => {
    const id = newId('prov_' + prov.provider);
    const newProv: ConfiguredProvider = {
      ...prov,
      id,
    };
    const nextList = [...(settings.providers || []), newProv];
    updateSettings({ providers: nextList });
    addLog(`Added provider ${prov.name} (${prov.provider})`);
    return id;
  };

  const updateConfiguredProvider = (id: string, updates: Partial<ConfiguredProvider>) => {
    const nextList = (settings.providers || []).map((p) => (p.id === id ? { ...p, ...updates } : p));
    const target = nextList.find((p) => p.id === id);
    // Sync settings only when the edited profile is the active one,
    // matched by id so duplicate profiles of the same slug do not bleed.
    const activeId = settingsRef.current.activeProviderId;
    const isActiveById = activeId ? target?.id === activeId : target?.provider === settingsRef.current.provider;
    if (target && isActiveById) {
      const cur = settingsRef.current;
      updateSettings({
        providers: nextList,
        apiKey: updates.apiKey !== undefined ? updates.apiKey : cur.apiKey,
        baseUrl: updates.baseUrl !== undefined ? (updates.baseUrl || '') : cur.baseUrl,
        modelId: updates.defaultModel !== undefined ? updates.defaultModel : cur.modelId,
      });
    } else {
      updateSettings({ providers: nextList });
    }
  };

  const removeConfiguredProvider = (id: string) => {
    const target = (settings.providers || []).find((p) => p.id === id);
    const nextList = (settings.providers || []).filter((p) => p.id !== id);

    // If deleting the active provider, switch to another enabled one.
    // Active is matched by id so same-slug duplicates do not bleed.
    const activeId = settingsRef.current.activeProviderId;
    const isActive = activeId ? target?.id === activeId : target?.provider === settingsRef.current.provider;
    if (target && isActive && nextList.length > 0) {
      const fallback = nextList[0];
      updateSettings({
        providers: nextList,
        activeProviderId: fallback.id,
        provider: fallback.provider,
        apiKey: fallback.apiKey || '',
        baseUrl: fallback.baseUrl || '',
        modelId: fallback.defaultModel,
      });
    } else {
      updateSettings({ providers: nextList });
    }
    addLog(`Removed provider profile ${id}`);
  };

  const activateProvider = (id: string, keepModelId?: string) => {
    const list = settingsRef.current.providers || [];
    const normed = normProvider(id);
    const target =
      list.find((p) => p.id === id) ||
      (normed ? list.find((p) => normProvider(p.provider) === normed) : undefined);
    if (!target) return;

    const keep = (keepModelId || '').trim();
    updateSettings({
      activeProviderId: target.id,
      provider: target.provider,
      apiKey: target.apiKey || '',
      baseUrl: target.baseUrl || '',
      modelId: keep || target.defaultModel,
    });
    addLog(`Switched active inference endpoint to ${target.name} (${target.provider})`);
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
    refreshNow();
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

  const refreshNow = async () => {
    const token = ++refreshTokenRef.current;
    const alive = () => token === refreshTokenRef.current;
    try {
      const isOk = await gatewayService.health();
      if (!alive()) return;
      setConnected(isOk);
      const status = await gatewayService.healthDetailed();
      if (!alive()) return;
      setGatewayStatus(status);
      const sessList = await gatewayService.fetchSessions();
      if (!alive()) return;
      // Merge instead of wholesale clobber so locally created sessions survive.
      const localOnly = sessionsRef.current.filter(
        (ls) => !sessList.some((s) => s.id === ls.id)
      );
      const merged = [...localOnly, ...sessList];
      sessionsRef.current = merged;
      setSessions(merged);
      const jobsList = await gatewayService.jobs();
      if (!alive()) return;
      setJobs(jobsList);
      // Keep the current session; only auto-select when none is active.
      const cur = currentSessionIdRef.current;
      if (cur) {
        const msgs = gatewayService.loadLocalMessages(cur);
        setChat(msgs);
      } else if (merged.length > 0) {
        selectSession(merged[0].id);
      }
    } catch {
      if (!alive()) return;
      setConnected(false);
    }
  };

  const startGateway = async () => {
    addLog('Starting Hermes gateway daemon...');
    setInstall('RUNNING');
    setGatewayFailed(false);
    setGatewayFailureReason(null);
    // On-device APK: start the real gateway process via the native runner.
    if (isNativeGateway()) {
      try {
        await nativeStart();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        setConnected(false);
        setGatewayFailed(true);
        setGatewayFailureReason(reason);
        addLog(`Gateway start failed: ${reason}`);
        return;
      }
    }
    let healthy = false;
    try {
      healthy = await gatewayService.health();
    } catch {
      healthy = false;
    }
    if (healthy) {
      setConnected(true);
      addLog('Gateway running on 127.0.0.1:8080');
      refreshNow();
    } else {
      setConnected(false);
      setGatewayFailed(true);
      const reason = 'Gateway start failed: health check did not pass on 127.0.0.1:8080';
      setGatewayFailureReason(reason);
      addLog(reason);
    }
  };

  const stopGateway = () => {
    stopStream();
    // On-device APK: stop the real gateway process via the native runner.
    if (isNativeGateway()) {
      nativeStop().catch(() => {});
    }
    setInstall('INSTALLED');
    setConnected(false);
    addLog('Gateway process terminated by user');
  };

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
      setInstallProgress('Verifying gateway health...');
    } else {
      setInstallProgress('Downloading hermes-image (~305MB)...');
      addLog('Download started from repository manifest');

      for (let i = 10; i <= 100; i += 20) {
        await new Promise((r) => setTimeout(r, 400));
        setInstallProgress(`Extracting rootfs layers (${i}%)...`);
        addLog(`Extracted package block #${i / 20}`);
      }
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
      gatewayService.stopRun(activeRunId);
      setActiveRunId(null);
    }
    streamingRef.current = false;
    setStreaming(false);
    setCurrentSessionId(id);
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
      .catch(() => {});
  };

  const newSession = async (): Promise<string> => {
    const id = await gatewayService.createSession(settings.modelId);
    const updated = await gatewayService.fetchSessions();
    setSessions(updated);
    selectSession(id);
    addLog(`Created session ${id}`);
    return id;
  };

  const deleteSession = async (id: string) => {
    await gatewayService.deleteSession(id);
    const updated = await gatewayService.fetchSessions();
    setSessions(updated);
    if (currentSessionId === id) {
      if (updated.length > 0) selectSession(updated[0].id);
      else {
        setCurrentSessionId(null);
        setChat([]);
      }
    }
    addLog(`Deleted session ${id}`);
  };

  const renameSession = async (id: string, title: string) => {
    await gatewayService.renameSession(id, title);
    const updated = await gatewayService.fetchSessions();
    setSessions(updated);
    addLog(`Renamed session to "${title}"`);
  };

  const forkSession = async (id: string) => {
    const newId = await gatewayService.forkSession(id);
    if (newId) {
      const updated = await gatewayService.fetchSessions();
      setSessions(updated);
      selectSession(newId);
      addLog(`Forked branch to session ${newId}`);
    }
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

  const stopStream = () => {
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
    if (activeRunId) {
      gatewayService.stopRun(activeRunId);
      setActiveRunId(null);
    }
    streamingRef.current = false;
    setStreaming(false);
    dropQueued('stream stopped');
    // Mark pending assistant message as finished thinking
    setChat((prev) =>
      prev.map((m) =>
        m.sender === 'hermes' && !m.thinkingDone ? { ...m, thinkingDone: true } : m
      )
    );
    addLog('Stream interrupted by user');
  };

  const sendMessage = (text: string, imageDataUrls: string[] = []): boolean => {
    const trimmed = text.trim();
    if (!trimmed && imageDataUrls.length === 0) return false;
    // Never silently drop: queue when a stream is active.
    if (streamingRef.current) {
      queueMessage(trimmed, imageDataUrls);
      addLog('Stream busy, message queued for next turn');
      return true;
    }

    let targetSid = currentSessionIdRef.current;
    if (!targetSid) {
      // Auto create a session if none active
      targetSid = newId('sess');
      const newSess: MobileSession = {
        id: targetSid,
        title: trimmed.slice(0, 30) || 'New Conversation',
        model: settingsRef.current.modelId,
        messageCount: 0,
        lastActiveAt: Date.now(),
        costUsd: 0.0,
        source: 'web',
      };
      try {
        const known = sessionsRef.current;
        if (!known.some((s) => s.id === targetSid)) {
          const nextKnown = [newSess, ...known];
          sessionsRef.current = nextKnown;
          gatewayService.saveLocalSessions(nextKnown);
        }
      } catch {}
      setSessions((prev) => (prev.some((s) => s.id === targetSid) ? prev : [newSess, ...prev]));
      setCurrentSessionId(targetSid);
    }

    const sid = targetSid;
    const userMsgId = newId('msg');
    const agentMsgId = newId('msg');

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
    turnUsageSeenRef.current = false;
    turnOutCharsRef.current = 0;
    const startTime = Date.now();
    const activeModel = settingsRef.current.modelId;
    const activeEffort = settingsRef.current.reasoningEffort;
    const autoApprove = settingsRef.current.autoApproveGlobal;
    setTurnMeta((prev) => ({
      ...prev,
      [agentMsgId]: { model: activeModel, durationMs: 0 },
    }));

    abortControllerRef.current = new AbortController();

    gatewayService.streamChat(
      sid,
      activeModel,
      trimmed,
      activeEffort,
      imageDataUrls,
      {
        onRunId: (rId) => setActiveRunId(rId),
        onThinking: (delta) => {
          setChat((prev) =>
            prev.map((m) =>
              m.id === agentMsgId ? { ...m, thinking: (m.thinking || '') + delta } : m
            )
          );
        },
        onThinkingDone: () => {
          setChat((prev) =>
            prev.map((m) =>
              m.id === agentMsgId ? { ...m, thinkingDone: true } : m
            )
          );
        },
        onText: (delta) => {
          turnOutCharsRef.current += delta.length;
          setChat((prev) =>
            prev.map((m) =>
              m.id === agentMsgId ? { ...m, content: (m.content || '') + delta } : m
            )
          );
        },
        onTool: (toolName) => {
          setChat((prev) =>
            prev.map((m) =>
              m.id === agentMsgId
                ? { ...m, tools: Array.from(new Set([...(m.tools || []), toolName])) }
                : m
            )
          );
        },
        onToolOutput: (toolName, output) => {
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
          if (autoApprove) {
            resolveApproval(req, true, settingsRef.current.approvalScope || 'once');
          } else {
            setApprovals((prev) => (prev.some((a) => a.runId === req.runId) ? prev : [...prev, req]));
          }
        },
        onError: (message: string) => {
          const errBubble: ChatMessage = {
            id: newId('msg'),
            sender: 'hermes',
            content: `Stream error: ${message || 'the gateway closed the stream unexpectedly'}`,
            thinkingDone: true,
            timestamp: Date.now(),
          };
          setChat((prev) => [...prev, errBubble]);
          addLog(`Stream error: ${message || 'unknown gateway error'}`);
        },
        onStopped: () => {
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
        abortControllerRef.current = null;
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

        // Process next queued message if any (outside the updater; StrictMode purity).
        const nextMsg = queuedRef.current[0];
        if (nextMsg) {
          queuedRef.current = queuedRef.current.slice(1);
          setQueuedMessages([...queuedRef.current]);
          setTimeout(() => {
            sendMessage(nextMsg.text, nextMsg.images);
          }, 300);
        }
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
  // empty hermes bubbles. sendMessage strips those as well.
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
    const list = await gatewayService.jobs();
    setJobs(list);
    const ids = new Set(list.map((j) => j.id));
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
        gatewayStatus,
        gatewayFailed,
        gatewayFailureReason,
        startGateway,
        stopGateway,
        installGateway,
        refreshNow,
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
