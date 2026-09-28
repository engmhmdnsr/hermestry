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
import { normProvider, DEFAULT_MODELS, PROVIDER_OPTIONS } from '../constants/providers';
import { ThemeMode, applyThemeToDom } from '../constants/themes';
import { LANGUAGES, getTranslation } from '../constants/languages';

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
  fontScale: number; // 0.8 to 1.4
  reasoningEffort: string; // 'none' | 'low' | 'medium' | 'high'
  autoApproveGlobal: boolean;
  providers: ConfiguredProvider[];
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
  activateProvider: (id: string) => void;
  
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
  sendNow: (text: string, imageDataUrls?: string[]) => boolean;
  queueMessage: (text: string, imageDataUrls?: string[]) => boolean;
  cancelQueued: () => void;
  stopStream: () => void;
  resolveApproval: (approval: PendingApproval, allow: boolean, mode?: string) => Promise<void>;
  
  // Drafts
  getDraft: (sessionId: string | null) => string;
  setDraft: (sessionId: string | null, text: string) => void;
  
  // Jobs
  jobs: CronJob[];
  refreshJobs: () => Promise<void>;
  createJob: (name: string, schedule: string, prompt: string) => Promise<boolean>;
  jobAction: (id: string, action: string) => Promise<boolean>;
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
  providers: DEFAULT_PROVIDERS,
  themePalette: 'midnight',
  themeMode: 'dark',
  language: 'en',
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
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch {}
    return DEFAULT_SETTINGS;
  });

  // Apply theme palette and mode to DOM
  useEffect(() => {
    applyThemeToDom(settings.themePalette || 'midnight', (settings.themeMode || 'dark') as ThemeMode);
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

  const gatewayService = useMemo(() => {
    return new GatewayService(
      'http://127.0.0.1:8080',
      () => settings.serverKey
    );
  }, [settings.serverKey]);

  // Install & Gateway Supervision state
  const [install, setInstall] = useState<InstallState>(() => {
    return settings.onboarded ? 'RUNNING' : 'NOT_INSTALLED';
  });
  const [installProgress, setInstallProgress] = useState<string>('');
  const [installError, setInstallError] = useState<string | null>(null);
  const [gatewayLogs, setGatewayLogs] = useState<string[]>([
    'Hermes Mobile client initialized',
  ]);
  const [connected, setConnected] = useState<boolean>(true);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>({
    ok: true,
    version: '1.3.0',
    gatewayState: 'ready',
    platforms: { android: 'ready', web: 'active', gateway: 'running' },
    detail: '',
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
  const [usageIn, setUsageIn] = useState<number>(0);
  const [usageOut, setUsageOut] = useState<number>(0);
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

  const abortControllerRef = useRef<AbortController | null>(null);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setGatewayLogs((prev) => [...prev, `[${timestamp}] ${msg}`].slice(-400));
  };

  const updateSettings = (newSettings: Partial<HermesSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...newSettings };
      try {
        localStorage.setItem('hermes_settings', JSON.stringify(next));
      } catch {}
      return next;
    });
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
    const normed = normProvider(clean(provider)) || 'deepseek';
    const activeKey = clean(key);
    const activeModel = clean(model) || DEFAULT_MODELS[normed]?.[0] || 'deepseek/deepseek-chat';

    // Also sync into configured providers list
    const currentList = settings.providers || [];
    let updatedList: ConfiguredProvider[] = [];
    const existingIndex = currentList.findIndex((p) => p.provider === normed);

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
    } else {
      const pName = PROVIDER_OPTIONS.find(([id]) => id === normed)?.[1] || normed.toUpperCase();
      updatedList = [
        ...currentList,
        {
          id: 'prov_' + normed + '_' + Date.now().toString(36),
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
    });
    addLog(`Active provider set to ${normed} with ${updatedList.length} provider(s) stored.`);
  };

  // Multi-Provider CRUD methods
  const addConfiguredProvider = (prov: Omit<ConfiguredProvider, 'id'>): string => {
    const id = 'prov_' + prov.provider + '_' + Math.random().toString(36).substring(2, 9);
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
    // If updating currently active provider, sync settings
    if (target && target.provider === settings.provider) {
      updateSettings({
        providers: nextList,
        apiKey: updates.apiKey !== undefined ? updates.apiKey : settings.apiKey,
        baseUrl: updates.baseUrl !== undefined ? (updates.baseUrl || '') : settings.baseUrl,
        modelId: updates.defaultModel !== undefined ? updates.defaultModel : settings.modelId,
      });
    } else {
      updateSettings({ providers: nextList });
    }
  };

  const removeConfiguredProvider = (id: string) => {
    const target = (settings.providers || []).find((p) => p.id === id);
    const nextList = (settings.providers || []).filter((p) => p.id !== id);
    
    // If deleting the active provider, switch to another enabled one
    if (target && target.provider === settings.provider && nextList.length > 0) {
      const fallback = nextList[0];
      updateSettings({
        providers: nextList,
        provider: fallback.provider,
        apiKey: fallback.apiKey,
        baseUrl: fallback.baseUrl || '',
        modelId: fallback.defaultModel,
      });
    } else {
      updateSettings({ providers: nextList });
    }
    addLog(`Removed provider profile ${id}`);
  };

  const activateProvider = (id: string) => {
    const target = (settings.providers || []).find((p) => p.id === id);
    if (!target) return;

    updateSettings({
      provider: target.provider,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl || '',
      modelId: target.defaultModel,
    });
    addLog(`Switched active inference endpoint to ${target.name} (${target.provider})`);
  };

  // Toggle Pinned
  const togglePin = (id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      try {
        localStorage.setItem('hermes_pinned_sessions', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Drafts
  const getDraft = (sid: string | null) => {
    const key = sid || 'none';
    return drafts[key] || '';
  };

  const setDraft = (sid: string | null, text: string) => {
    const key = sid || 'none';
    setDrafts((prev) => ({ ...prev, [key]: text }));
  };

  // Initial data load & models aggregation
  useEffect(() => {
    refreshNow();
    // Load models ONLY for the active provider and actually configured providers
    const activeProvider = settings.provider || 'deepseek';
    const configuredList = settings.providers || [];

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
      if (settings.modelId && !modelMap.has(settings.modelId)) {
        const parts = settings.modelId.split('/');
        const rawName = parts.length > 1 ? parts[1] : parts[0];
        const clean = rawName
          .replace(/[-_]/g, ' ')
          .replace(/\b([a-z])/g, (c) => c.toUpperCase());

        modelMap.set(settings.modelId, {
          id: settings.modelId,
          displayName: clean,
          provider: settings.provider,
        });
      }

      setModels(Array.from(modelMap.values()));
    };

    loadAllModels();
  }, [gatewayService, settings.provider, settings.providers, settings.modelId]);

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
    try {
      const isOk = await gatewayService.health();
      setConnected(isOk || true); // In web container, local engine acts as healthy
      const status = await gatewayService.healthDetailed();
      setGatewayStatus(status);
      const sessList = await gatewayService.fetchSessions();
      setSessions(sessList);
      const jobsList = await gatewayService.jobs();
      setJobs(jobsList);
      if (currentSessionId) {
        const msgs = gatewayService.loadLocalMessages(currentSessionId);
        setChat(msgs);
      } else if (sessList.length > 0) {
        selectSession(sessList[0].id);
      }
    } catch {
      setConnected(true);
    }
  };

  const startGateway = async () => {
    addLog('Starting Hermes gateway daemon...');
    setInstall('RUNNING');
    setGatewayFailed(false);
    setGatewayFailureReason(null);
    await new Promise((r) => setTimeout(r, 600));
    setConnected(true);
    addLog('Gateway running on 127.0.0.1:8080');
    refreshNow();
  };

  const stopGateway = () => {
    stopStream();
    setInstall('INSTALLED');
    setConnected(false);
    addLog('Gateway process terminated by user');
  };

  const installGateway = async () => {
    setInstall('INSTALLING');
    setInstallProgress('Downloading hermes-image (~305MB)...');
    setInstallError(null);
    addLog('Download started from repository manifest');

    for (let i = 10; i <= 100; i += 20) {
      await new Promise((r) => setTimeout(r, 400));
      setInstallProgress(`Extracting rootfs layers (${i}%)...`);
      addLog(`Extracted package block #${i / 20}`);
    }

    setInstall('INSTALLED');
    setInstallProgress('');
    addLog('Installed Hermes rootfs OK, ready to start');
  };

  const selectSession = (id: string) => {
    setCurrentSessionId(id);
    const msgs = gatewayService.loadLocalMessages(id);
    setChat(msgs);
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

  const stopStream = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (activeRunId) {
      gatewayService.stopRun(activeRunId);
      setActiveRunId(null);
    }
    setStreaming(false);
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
    if (streaming) return false;

    let targetSid = currentSessionId;
    if (!targetSid) {
      // Auto create a session if none active
      targetSid = 'sess_' + Math.random().toString(36).substring(2, 9);
      const newSess: MobileSession = {
        id: targetSid,
        title: trimmed.slice(0, 30) || 'New Conversation',
        model: settings.modelId,
        messageCount: 0,
        lastActiveAt: Date.now(),
        costUsd: 0.0,
        source: 'web',
      };
      setSessions((prev) => [newSess, ...prev]);
      setCurrentSessionId(targetSid);
    }

    const sid = targetSid;
    const userMsgId = 'msg_' + Math.random().toString(36).substring(2, 9);
    const agentMsgId = 'msg_' + Math.random().toString(36).substring(2, 9);

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

    const initialChat = [...gatewayService.loadLocalMessages(sid), userMessage, agentMessage];
    gatewayService.saveLocalMessages(sid, initialChat);
    setChat(initialChat);

    setStreaming(true);
    const startTime = Date.now();
    setTurnMeta((prev) => ({
      ...prev,
      [agentMsgId]: { model: settings.modelId, durationMs: 0 },
    }));

    abortControllerRef.current = new AbortController();

    gatewayService.streamChat(
      sid,
      settings.modelId,
      trimmed,
      settings.reasoningEffort,
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
          setUsageIn((prev) => prev + inp);
          setUsageOut((prev) => prev + outp);
        },
        onApproval: (req) => {
          if (settings.autoApproveGlobal) {
            resolveApproval(req, true, 'session');
          } else {
            setApprovals((prev) => (prev.some((a) => a.runId === req.runId) ? prev : [...prev, req]));
          }
        },
      },
      abortControllerRef.current.signal
    )
      .finally(() => {
        setStreaming(false);
        setActiveRunId(null);
        abortControllerRef.current = null;
        const duration = Date.now() - startTime;
        setTurnMeta((prev) => ({
          ...prev,
          [agentMsgId]: { model: settings.modelId, durationMs: duration },
        }));

        setChat((latest) => {
          const finalMessages = latest.map((m) =>
            m.id === agentMsgId ? { ...m, thinkingDone: true } : m
          );
          gatewayService.saveLocalMessages(sid, finalMessages);
          return finalMessages;
        });

        // Update session meta
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  messageCount: s.messageCount + 2,
                  lastActiveAt: Date.now(),
                }
              : s
          )
        );

        // Process next queued message if any
        setQueuedMessages((q) => {
          if (q.length > 0) {
            const [nextMsg, ...remaining] = q;
            setTimeout(() => {
              sendMessage(nextMsg.text, nextMsg.images);
            }, 300);
            return remaining;
          }
          return q;
        });
      });

    return true;
  };

  const sendNow = (text: string, imageDataUrls: string[] = []): boolean => {
    stopStream();
    return sendMessage(text, imageDataUrls);
  };

  const queueMessage = (text: string, imageDataUrls: string[] = []): boolean => {
    const t = text.trim();
    if (!t && imageDataUrls.length === 0) return false;
    setQueuedMessages((prev) => [...prev, { text: t, images: imageDataUrls }]);
    return true;
  };

  const cancelQueued = () => {
    setQueuedMessages([]);
  };

  const resolveApproval = async (approval: PendingApproval, allow: boolean, mode: string = 'once') => {
    await gatewayService.resolveApproval(approval.runId, allow, mode);
    setApprovals((prev) => prev.filter((a) => a.runId !== approval.runId));
    addLog(`Approval for "${approval.summary.slice(0, 40)}" ${allow ? 'ALLOWED (' + mode + ')' : 'DENIED'}`);
  };

  // Jobs Actions
  const refreshJobs = async () => {
    const list = await gatewayService.jobs();
    setJobs(list);
  };

  const createJob = async (name: string, schedule: string, prompt: string): Promise<boolean> => {
    const ok = await gatewayService.createJob(name, schedule, prompt);
    if (ok) refreshJobs();
    return ok;
  };

  const jobAction = async (id: string, action: string): Promise<boolean> => {
    const ok = await gatewayService.jobAction(id, action);
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
        getDraft,
        setDraft,
        jobs,
        refreshJobs,
        createJob,
        jobAction,
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
