import React, { useState, useEffect } from 'react';
import {
  Eye,
  EyeOff,
  Play,
  Square,
  CheckCircle2,
  XCircle,
  Lock,
  Unlock,
  Check,
  X,
  Sun,
  Moon,
  Monitor,
  Search,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  normProvider,
  DEFAULT_MODELS,
  keysValid,
} from '../../constants/providers';
import { THEME_PALETTES, ThemeMode } from '../../constants/themes';
import { LANGUAGES } from '../../constants/languages';
import {
  Blueprint,
  DoctorReport,
  BackupResult,
  DebugShare,
  SkillInfo,
  MemoryInfo,
  ConfiguredProvider,
} from '../../types/hermes';

type SectionId = 'connection' | 'security' | 'gateway' | 'automation' | 'appearance' | 'advanced';

type RiskLevel = 'high' | 'medium' | 'low' | 'off';

const RiskBadge: React.FC<{ level: RiskLevel; label: string }> = ({ level, label }) => {
  const styles: Record<RiskLevel, string> = {
    high: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
    medium: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    low: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
    off: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${styles[level]}`}>
      {level === 'off' ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
      {label}
    </span>
  );
};

type DataState = 'loading' | 'empty' | 'offline' | 'error' | 'stale' | 'refreshing' | 'ready';

const StateNote: React.FC<{ state: DataState; message: string; onRetry?: () => void }> = ({
  state,
  message,
  onRetry,
}) => {
  if (state === 'ready') return null;
  const styles: Record<DataState, string> = {
    loading: 'text-slate-400 border-white/[0.06]',
    empty: 'text-slate-500 border-white/[0.06]',
    offline: 'text-rose-300 border-rose-500/20 bg-rose-500/[0.04]',
    error: 'text-rose-300 border-rose-500/20 bg-rose-500/[0.04]',
    stale: 'text-amber-300 border-amber-500/20 bg-amber-500/[0.04]',
    refreshing: 'text-indigo-300 border-indigo-500/20 bg-indigo-500/[0.04]',
    ready: '',
  };
  return (
    <div className={`flex items-center gap-2 p-3 rounded-xl border text-[11px] ${styles[state]}`}>
      {state === 'offline' ? (
        <WifiOff className="w-3.5 h-3.5 shrink-0" />
      ) : state === 'refreshing' || state === 'loading' ? (
        <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${state === 'refreshing' ? 'animate-spin' : 'animate-pulse'}`} />
      ) : state === 'error' ? (
        <XCircle className="w-3.5 h-3.5 shrink-0" />
      ) : (
        <Wifi className="w-3.5 h-3.5 shrink-0 opacity-60" />
      )}
      <span className="flex-1">{message}</span>
      {onRetry && (state === 'error' || state === 'offline') && (
        <button onClick={onRetry} className="text-indigo-300 hover:text-indigo-200 font-semibold cursor-pointer shrink-0">
          Retry
        </button>
      )}
    </div>
  );
};

const Section: React.FC<{
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, subtitle, open, onToggle, badge, children }) => (
  <section className="rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] shadow-xs overflow-hidden">
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="w-full px-5 py-4 flex items-center gap-3 text-left cursor-pointer hover:bg-white/[0.02] transition"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white tracking-tight">{title}</h3>
          {badge}
        </div>
        <p className="text-xs text-slate-400 mt-0.5 truncate">{subtitle}</p>
      </div>
      <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="px-5 pb-5 pt-1 divide-y divide-white/[0.06]">{children}</div>}
  </section>
);

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="py-3.5 first:pt-1 last:pb-1">{children}</div>
);

export const SettingsTab: React.FC = () => {
  const {
    settings,
    updateSettings,
    configuredProviders,
    addConfiguredProvider,
    updateConfiguredProvider,
    removeConfiguredProvider,
    activateProvider,
    install,
    installProgress,
    installError,
    connected,
    gatewayStatus,
    gatewayFailed,
    gatewayFailureReason,
    startGateway,
    stopGateway,
    installGateway,
    refreshNow,
    service,
    approvals,
    jobs,
    lockNow,
    vaultUnlocked,
    t,
  } = useHermes();

  // Multi-provider form modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [newProvType, setNewProvType] = useState('deepseek');
  const [newProvName, setNewProvName] = useState('');
  const [newProvKey, setNewProvKey] = useState('');
  const [newProvBaseUrl, setNewProvBaseUrl] = useState('');
  const [newProvModel, setNewProvModel] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);

  // Key testing state. testedKey records which exact key produced keyOk,
  // so a save only marks the profile validated after a real successful
  // validation of the key being saved.
  const [testingKey, setTestingKey] = useState(false);
  const [keyResult, setKeyResult] = useState<string | null>(null);
  const [keyOk, setKeyOk] = useState<boolean | null>(null);
  const [testedKey, setTestedKey] = useState('');

  // External bot bridges state
  const [tgToken, setTgToken] = useState(settings.tgToken || '');
  const [discordToken, setDiscordToken] = useState(settings.discordToken || '');
  const [serverKey, setServerKey] = useState(settings.serverKey || '');

  useEffect(() => {
    setTgToken(settings.tgToken || '');
  }, [settings.tgToken]);

  useEffect(() => {
    setDiscordToken(settings.discordToken || '');
  }, [settings.discordToken]);

  useEffect(() => {
    setServerKey(settings.serverKey || '');
  }, [settings.serverKey]);

  // App lock PIN setup state
  const [showPinForm, setShowPinForm] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const validatePin = (pin: string): string | null => {
    if (!/^\d{4,8}$/.test(pin)) return t('pinLength');
    if (pin === '1234' || pin === '0000') return t('pinCommon');
    if (/^(\d)\1+$/.test(pin)) return t('pinRepeated');
    return null;
  };

  // UX-07: locale strings still carry the stale "4-Digit" title while the
  // validator and placeholders accept 4-8 digits. languages.ts is owned
  // elsewhere, so the copy is normalised here at render time.
  const rawLockTitle = t('appLock') || 'App Lock PIN';
  const appLockTitle = rawLockTitle.replace(/4\s?[- ]?\s?digit\S*/gi, '').replace(/\s{2,}/g, ' ').trim() || 'App Lock PIN';

  // Toast feedback
  const [toast, setToast] = useState<string | null>(null);

  // Ops state
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [runningDoctor, setRunningDoctor] = useState(false);
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [runningBackup, setRunningBackup] = useState(false);
  const [debugResult, setDebugResult] = useState<DebugShare | null>(null);
  const [sharingDebug, setSharingDebug] = useState(false);

  // Library & Skills state with distinct data states (UX-04)
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsState, setSkillsState] = useState<DataState>('loading');
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  const [memoryState, setMemoryState] = useState<DataState>('loading');
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [blueprintsState, setBlueprintsState] = useState<DataState>('loading');
  const [selectedBlueprint, setSelectedBlueprint] = useState<Blueprint | null>(null);
  const [blueprintSlots, setBlueprintSlots] = useState<Record<string, string>>({});

  // Gateway status summary entry point (UX-05): always visible, tap for details
  const [showGatewayDetails, setShowGatewayDetails] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);

  // Section grouping with progressive disclosure (UX-02). Connection and
  // Security start open; the rest disclose on tap so the page stays scannable.
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
    connection: true,
    security: true,
    gateway: false,
    automation: false,
    appearance: false,
    advanced: false,
  });
  const toggleSection = (id: SectionId) => setOpenSections((p) => ({ ...p, [id]: !p[id] }));

  // Preferences search filters
  const [themeSearch, setThemeSearch] = useState('');
  const [langSearch, setLangSearch] = useState('');
  const [showAllThemes, setShowAllThemes] = useState(false);

  // Font scale slider commits through a 150ms debounce so per-tick
  // dragging does not re-render the full tree on every tick.
  const [fontScaleLocal, setFontScaleLocal] = useState(settings.fontScale || 1);
  const updateSettingsRef = React.useRef(updateSettings);
  updateSettingsRef.current = updateSettings;
  const settingsFontScaleRef = React.useRef(settings.fontScale || 1);
  settingsFontScaleRef.current = settings.fontScale || 1;

  useEffect(() => {
    setFontScaleLocal(settings.fontScale || 1);
    // Expose chat font scale as a CSS var so chrome text scales via index.css
    document.documentElement.style.setProperty('--font-scale', String(settings.fontScale || 1));
  }, [settings.fontScale]);

  useEffect(() => {
    if (fontScaleLocal === settingsFontScaleRef.current) return;
    const id = setTimeout(() => {
      if (fontScaleLocal !== settingsFontScaleRef.current) {
        updateSettingsRef.current({ fontScale: fontScaleLocal });
      }
    }, 150);
    return () => clearTimeout(id);
  }, [fontScaleLocal]);

  const EFFORT_LEVELS = [
    { id: 'none', label: t('effortNone') },
    { id: 'low', label: t('effortLow') },
    { id: 'medium', label: t('effortMedium') },
    { id: 'high', label: t('effortHigh') },
  ] as const;
  const currentTheme = settings.themePalette || 'midnight';
  const currentMode = settings.themeMode || 'dark';

  const filteredThemes = THEME_PALETTES.filter((th) =>
    th.name.toLowerCase().includes(themeSearch.toLowerCase()) ||
    th.description.toLowerCase().includes(themeSearch.toLowerCase())
  );
  const visibleThemes = showAllThemes ? filteredThemes : filteredThemes.slice(0, 6);

  const filteredLanguages = LANGUAGES.filter((l) =>
    l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.code.toLowerCase().includes(langSearch.toLowerCase())
  );

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;
    setSkillsState((s) => (s === 'ready' ? 'refreshing' : 'loading'));
    service
      .skillsList(signal)
      .then((list) => {
        setSkills(list);
        setSkillsState(list.length === 0 ? 'empty' : 'ready');
      })
      .catch(() => {
        setSkillsState(connected ? 'error' : 'offline');
      });
    setMemoryState((s) => (s === 'ready' ? 'refreshing' : 'loading'));
    service
      .memoryGet(signal)
      .then((m) => {
        setMemory(m);
        setMemoryState('ready');
      })
      .catch(() => {
        setMemoryState(connected ? 'error' : 'offline');
      });
    setBlueprintsState((s) => (s === 'ready' ? 'refreshing' : 'loading'));
    service
      .blueprints(signal)
      .then((bps) => {
        setBlueprints(bps);
        setBlueprintsState(bps.length === 0 ? 'empty' : 'ready');
      })
      .catch(() => {
        setBlueprintsState(connected ? 'error' : 'offline');
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const refreshLibrary = async () => {
    setSkillsState('refreshing');
    setBlueprintsState('refreshing');
    try {
      const [list, bps] = await Promise.all([service.skillsList(), service.blueprints()]);
      setSkills(list);
      setSkillsState(list.length === 0 ? 'empty' : 'ready');
      setBlueprints(bps);
      setBlueprintsState(bps.length === 0 ? 'empty' : 'ready');
    } catch {
      setSkillsState(connected ? 'error' : 'offline');
      setBlueprintsState(connected ? 'error' : 'offline');
    }
  };

  const handleTestKey = async () => {
    if (!newProvKey.trim()) return;
    setTestingKey(true);
    setKeyResult(null);
    setKeyOk(null);
    setTestedKey('');

    const norm = normProvider(newProvType);
    const valid = await service.providersValidate(norm, 'HERMES_API_KEY', newProvKey.trim());
    setTestingKey(false);
    setTestedKey(newProvKey.trim());
    if (valid === true) {
      setKeyOk(true);
      setKeyResult(t('keyValid'));
    } else if (valid === false) {
      setKeyOk(false);
      setKeyResult(t('keyInvalid'));
    } else {
      // null means the gateway could not be reached, so validity is
      // genuinely unknown. Keep the amber state for that real outcome.
      setKeyOk(null);
      setKeyResult(t('keyPattern'));
    }
  };

  const handleRunDoctor = async () => {
    setRunningDoctor(true);
    const report = await service.doctor();
    setDoctorReport(report);
    setRunningDoctor(false);
  };

  const handleRunBackup = async () => {
    if (!window.confirm('Create a local snapshot? It saves workspace sessions, cron schedules, and settings.')) {
      return;
    }
    setRunningBackup(true);
    const res = await service.backup();
    setBackupResult(res);
    setRunningBackup(false);
  };

  const handleShareDebug = async () => {
    if (!window.confirm('Generate a debug bundle? It collects diagnostics for sharing. Secrets are redacted before upload.')) {
      return;
    }
    setSharingDebug(true);
    const res = await service.debugShare();
    setDebugResult(res);
    setSharingDebug(false);
  };

  const handleToggleSkill = async (id: string, current: boolean) => {
    await service.skillToggle(id, !current);
    const updated = await service.skillsList();
    setSkills(updated);
    setSkillsState(updated.length === 0 ? 'empty' : 'ready');
    showToast(!current ? t('skillEnabled') : t('skillDisabled'));
  };

  const handleInstantiateBlueprint = async (id: string) => {
    await service.instantiateBlueprint(id, blueprintSlots);
    setSelectedBlueprint(null);
    setBlueprintSlots({});
    showToast(t('blueprintLaunched'));
  };

  const handleRefreshStatus = async () => {
    setRefreshingStatus(true);
    try {
      await refreshNow();
    } finally {
      setRefreshingStatus(false);
    }
  };

  // Security risk indicators (UX-08)
  const unvalidatedKeys = configuredProviders.filter((p) => !p.validated).length;
  const tokensSet = [settings.tgToken, settings.discordToken, settings.serverKey].filter((v) => (v || '').trim()).length;
  const autoApproveRisk: RiskLevel = settings.autoApproveGlobal ? 'high' : 'off';
  const keysRisk: RiskLevel = configuredProviders.length === 0 ? 'off' : unvalidatedKeys > 0 ? 'medium' : 'low';
  const tokensRisk: RiskLevel = tokensSet === 0 ? 'off' : tokensSet >= 2 ? 'medium' : 'low';
  const riskCount = [autoApproveRisk, keysRisk, tokensRisk].filter((r) => r === 'high' || r === 'medium').length;

  const activeProvider: ConfiguredProvider | undefined = settings.activeProviderId
    ? configuredProviders.find((p) => p.id === settings.activeProviderId)
    : configuredProviders.find((p) => p.provider === settings.provider);

  const sectionChips: Array<{ id: SectionId; label: string }> = [
    { id: 'connection', label: 'Connection' },
    { id: 'security', label: 'Security' },
    { id: 'gateway', label: 'Gateway' },
    { id: 'automation', label: 'Automation' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'advanced', label: 'Advanced' },
  ];

  return (
    <div className="space-y-4 max-w-2xl mx-auto px-4 pt-4 pb-28">
      {/* Toast popup */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold shadow-2xl animate-in fade-in slide-in-from-top-2">
          {toast}
        </div>
      )}

      {/* UX-05: gateway status summary, always visible, tap for details */}
      <div className="rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] shadow-xs overflow-hidden">
        <div className="w-full px-5 py-3.5 flex items-center gap-3">
          <button
            onClick={() => setShowGatewayDetails((v) => !v)}
            aria-expanded={showGatewayDetails}
            className="min-w-0 flex-1 flex items-center gap-3 text-left cursor-pointer"
          >
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-rose-400'}`} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-white truncate">
                {connected ? t('running') : t('stopped')}
                <span className="font-normal text-slate-400"> · 127.0.0.1:8080 · {install}</span>
              </span>
              <span className="block text-[11px] text-slate-500 truncate">
                {gatewayFailed && gatewayFailureReason ? gatewayFailureReason : 'Tap for gateway details'}
              </span>
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${showGatewayDetails ? 'rotate-180' : ''}`} />
          </button>
          <button
            onClick={() => {
              void handleRefreshStatus();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white cursor-pointer shrink-0"
            title={t('refresh')}
            aria-label={t('refresh')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingStatus ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {showGatewayDetails && (
          <div className="px-5 pb-4 pt-1 text-[11px] text-slate-400 space-y-1.5 border-t border-white/[0.06]">
            <div className="flex justify-between pt-2">
              <span>State</span>
              <span className="text-slate-200 font-mono">{gatewayStatus?.gatewayState || install}</span>
            </div>
            <div className="flex justify-between">
              <span>Version</span>
              <span className="text-slate-200 font-mono">{gatewayStatus?.version || 'unknown'}</span>
            </div>
            <div className="flex justify-between">
              <span>Approvals pending</span>
              <span className="text-slate-200 font-mono">{approvals?.length || 0}</span>
            </div>
            <div className="flex justify-between">
              <span>Scheduled jobs</span>
              <span className="text-slate-200 font-mono">{jobs?.length || 0}</span>
            </div>
            {refreshingStatus && <StateNote state="refreshing" message="Refreshing gateway status..." />}
            {!connected && <StateNote state="offline" message={gatewayFailureReason || installError || 'Gateway is stopped. Start it to run diagnostics and automations.'} />}
            {installProgress ? <p className="text-slate-500">{installProgress}</p> : null}
          </div>
        )}
      </div>

      {/* Section quick-jump chips with progressive disclosure */}
      <div className="flex items-center gap-1.5 p-1 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] overflow-x-auto">
        {sectionChips.map((chip) => (
          <button
            key={chip.id}
            onClick={() => toggleSection(chip.id)}
            className={`flex-1 min-h-[40px] px-3 py-2 rounded-xl text-xs font-medium transition-all whitespace-nowrap cursor-pointer ${
              openSections[chip.id]
                ? 'bg-white/[0.08] text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {chip.label}
            {chip.id === 'security' && riskCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 text-[10px] font-semibold">
                {riskCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ========================================================= */}
      {/* CONNECTION: primary task first (active provider), then list */}
      {/* ========================================================= */}
      <Section
        title="Connection"
        subtitle={activeProvider ? `Active: ${activeProvider.name}` : t('providersDesc')}
        open={openSections.connection}
        onToggle={() => toggleSection('connection')}
        badge={
          activeProvider ? (
            <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 text-[10px] font-medium border border-emerald-500/30">
              {t('active')}
            </span>
          ) : undefined
        }
      >
        <Row>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-white">{t('configuredProviders')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t('providersDesc')}</p>
            </div>
            <button
              onClick={() => {
                setEditingProviderId(null);
                setNewProvType('deepseek');
                setNewProvName('DeepSeek');
                setNewProvKey('');
                setNewProvBaseUrl('');
                setNewProvModel(DEFAULT_MODELS['deepseek']?.[0] || 'deepseek/deepseek-chat');
                setKeyResult(null);
                setKeyOk(null);
                setTestedKey('');
                setShowAddModal(true);
              }}
              className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer shrink-0"
            >
              {t('addProvider')}
            </button>
          </div>
        </Row>
        {configuredProviders.length === 0 ? (
          <Row>
            <StateNote state={connected ? 'empty' : 'offline'} message={connected ? t('noProviders') : 'Gateway is offline. Provider profiles are stored locally and can still be edited.'} />
          </Row>
        ) : (
          <Row>
            <div className="divide-y divide-white/[0.04]">
              {configuredProviders.map((prov) => {
                // Active is matched by id so same-slug duplicate profiles
                // do not all light up. Falls back to slug for legacy state.
                const isActive = settings.activeProviderId
                  ? prov.id === settings.activeProviderId
                  : prov.provider === settings.provider;
                return (
                  <div key={prov.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex items-center gap-3">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs uppercase shrink-0 ${
                          isActive ? 'bg-indigo-600 text-white' : 'bg-white/[0.06] text-slate-400'
                        }`}
                      >
                        {prov.provider.slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-semibold text-white truncate">{prov.name}</p>
                          {isActive && (
                            <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 text-[10px] font-medium border border-emerald-500/30">
                              {t('active')}
                            </span>
                          )}
                          {!prov.validated && (
                            <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 text-[10px] font-medium border border-amber-500/30">
                              Untested
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                          {prov.defaultModel || t('defaultModelShort')} · {prov.baseUrl ? t('customProxy') : t('officialEndpoint')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {!isActive ? (
                        <button
                          onClick={() => {
                            activateProvider(prov.id);
                            showToast(`${t('switchedTo')} ${prov.name}`);
                          }}
                          className="px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-slate-200 transition cursor-pointer"
                        >
                          {t('use')}
                        </button>
                      ) : (
                        <span className="text-xs text-indigo-400 font-medium px-2 flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" />
                          <span>{t('active')}</span>
                        </span>
                      )}
                      <button
                        onClick={() => {
                          setEditingProviderId(prov.id);
                          setNewProvType(prov.provider);
                          setNewProvName(prov.name);
                          setNewProvKey(prov.apiKey || '');
                          setNewProvBaseUrl(prov.baseUrl || '');
                          setNewProvModel(prov.defaultModel || '');
                          setKeyResult(null);
                          setKeyOk(null);
                          setTestedKey('');
                          setShowAddModal(true);
                        }}
                        className="px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                      >
                        {t('edit')}
                      </button>
                      <button
                        onClick={() => {
                          const isSole = configuredProviders.length === 1;
                          removeConfiguredProvider(prov.id);
                          if (isSole) {
                            updateSettings({ provider: '', apiKey: '', baseUrl: '', modelId: '' });
                          }
                          showToast(`${t('removedItem')} ${prov.name}`);
                        }}
                        className="p-1.5 rounded-xl text-slate-500 hover:text-rose-400 hover:bg-white/[0.06] transition cursor-pointer"
                        title={t('delete')}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Row>
        )}
      </Section>

      {/* ========================================================= */}
      {/* SECURITY: risk indicators, Lock Now, PIN (UX-06/07/08) */}
      {/* ========================================================= */}
      <Section
        title="Security"
        subtitle={riskCount > 0 ? `${riskCount} item${riskCount > 1 ? 's' : ''} need review` : 'No elevated risks'}
        open={openSections.security}
        onToggle={() => toggleSection('security')}
        badge={
          riskCount > 0 ? (
            <RiskBadge level={autoApproveRisk === 'high' ? 'high' : 'medium'} label={`${riskCount} to review`} />
          ) : (
            <RiskBadge level="off" label="OK" />
          )
        }
      >
        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white">{t('autoApprove')}</p>
              <p className="text-[11px] text-slate-400">{t('autoApproveDesc')}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <RiskBadge level={autoApproveRisk} label={settings.autoApproveGlobal ? 'High risk' : 'Off'} />
              <button
                onClick={() => {
                  const next = !settings.autoApproveGlobal;
                  updateSettings({ autoApproveGlobal: next });
                  showToast(next ? `${t('autoApprove')}: ${t('active')}` : `${t('autoApprove')}: ${t('disabled')}`);
                }}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  settings.autoApproveGlobal
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-white/[0.04] text-slate-400'
                }`}
              >
                {settings.autoApproveGlobal ? t('active') : t('disabled')}
              </button>
            </div>
          </div>
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white">Approval Scope</p>
              <p className="text-[11px] text-slate-400">
                How long an auto-approval lasts once granted. Session scope keeps elevated rights longer.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(settings.approvalScope || 'once') === 'session' && <RiskBadge level="medium" label="Elevated" />}
              <div className="flex items-center gap-1 p-1 bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] rounded-xl">
                {[
                  { id: 'once', label: 'Once' },
                  { id: 'session', label: 'Session' },
                ].map((scope) => (
                  <button
                    key={scope.id}
                    onClick={() => {
                      updateSettings({ approvalScope: scope.id });
                      showToast(`Approval Scope: ${scope.label}`);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                      (settings.approvalScope || 'once') === scope.id
                        ? 'bg-white/[0.12] text-white shadow-xs font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {scope.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white">{appLockTitle} (4-8 digits)</p>
              <p className="text-[11px] text-slate-400">{t('appLockDesc')}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Use 4 to 8 digits. Avoid common or repeated-digit PINs.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => {
                  if (settings.appLockEnabled) {
                    updateSettings({ appLockEnabled: false });
                    setShowPinForm(false);
                    showToast(`${appLockTitle}: ${t('disabled')}`);
                  } else {
                    setPinError(null);
                    setNewPin('');
                    setConfirmPin('');
                    setShowPinForm(true);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  settings.appLockEnabled
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-white/[0.04] text-slate-400'
                }`}
              >
                {settings.appLockEnabled ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                <span>{settings.appLockEnabled ? t('locked') : t('disabled')}</span>
              </button>
            </div>
          </div>

          {settings.appLockEnabled && (
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={() => {
                  lockNow();
                  showToast('App locked');
                }}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Lock Now</span>
              </button>
              <span className="text-[11px] text-slate-500">
                {vaultUnlocked ? 'Vault is unlocked on this device.' : 'Vault is locked.'}
              </span>
              {!showPinForm && (
                <button
                  onClick={() => {
                    setPinError(null);
                    setNewPin('');
                    setConfirmPin('');
                    setShowPinForm(true);
                  }}
                  className="ml-auto text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer"
                >
                  {t('changePin')}
                </button>
              )}
            </div>
          )}

          {showPinForm && (
            <div className="space-y-2 pt-2.5">
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  inputMode="numeric"
                  value={newPin}
                  onChange={(e) => {
                    setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8));
                    setPinError(null);
                  }}
                  placeholder={t('newPinPlaceholder')}
                  maxLength={8}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  value={confirmPin}
                  onChange={(e) => {
                    setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8));
                    setPinError(null);
                  }}
                  placeholder={t('confirmPinPlaceholder')}
                  maxLength={8}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
              {pinError && <p className="text-[11px] text-rose-400">{pinError}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const err = validatePin(newPin);
                    if (err) {
                      setPinError(err);
                      return;
                    }
                    if (newPin !== confirmPin) {
                      setPinError(t('pinMismatch'));
                      return;
                    }
                    updateSettings({ appLockPin: newPin, appLockEnabled: true });
                    setShowPinForm(false);
                    setNewPin('');
                    setConfirmPin('');
                    setPinError(null);
                    showToast(`${appLockTitle}: ${t('enabled')}`);
                  }}
                  className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition cursor-pointer"
                >
                  {settings.appLockEnabled ? t('saveNewPin') : t('setPinEnable')}
                </button>
                <button
                  onClick={() => {
                    setShowPinForm(false);
                    setNewPin('');
                    setConfirmPin('');
                    setPinError(null);
                  }}
                  className="px-3.5 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white transition cursor-pointer"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          )}
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white">Stored API keys</p>
              <p className="text-[11px] text-slate-400">
                {configuredProviders.length} profile{configuredProviders.length === 1 ? '' : 's'} saved
                {unvalidatedKeys > 0 ? `, ${unvalidatedKeys} never validated` : ', all validated'}.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <RiskBadge
                level={keysRisk}
                label={configuredProviders.length === 0 ? 'None stored' : unvalidatedKeys > 0 ? 'Review keys' : 'Keys stored'}
              />
              <button
                onClick={() => setOpenSections((p) => ({ ...p, connection: true }))}
                className="px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-slate-200 transition cursor-pointer"
              >
                Review
              </button>
            </div>
          </div>
        </Row>

        <Row>
          <details className="group">
            <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
              <div>
                <p className="text-xs font-medium text-white">Channel and daemon tokens</p>
                <p className="text-[11px] text-slate-400">Telegram, Discord, and gateway server key. Tap to edit.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <RiskBadge
                  level={tokensRisk}
                  label={tokensSet === 0 ? 'None set' : `${tokensSet} set`}
                />
                <ChevronDown className="w-4 h-4 text-slate-400 group-open:rotate-180 transition-transform" />
              </div>
            </summary>
            <div className="space-y-2.5 pt-3">
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={tgToken}
                  onChange={(e) => setTgToken(e.target.value)}
                  placeholder="bot123456:ABC-DEF..."
                  aria-label={t('telegramBridge')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  onClick={() => {
                    updateSettings({ tgToken: tgToken.trim() });
                    showToast(t('tgSaved'));
                  }}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                >
                  {t('saveShort')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={discordToken}
                  onChange={(e) => setDiscordToken(e.target.value)}
                  placeholder={t('botTokenPlaceholder')}
                  aria-label={t('discordBridge')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  onClick={() => {
                    updateSettings({ discordToken: discordToken.trim() });
                    showToast(t('discordSaved'));
                  }}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                >
                  {t('saveShort')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={serverKey}
                  onChange={(e) => setServerKey(e.target.value)}
                  placeholder={t('serverKeyPlaceholder')}
                  aria-label={t('serverKeyTitle')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  onClick={() => {
                    updateSettings({ serverKey: serverKey.trim() });
                    showToast(t('serverKeySaved'));
                  }}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                >
                  {t('saveShort')}
                </button>
              </div>
            </div>
          </details>
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white">Diagnostic sharing</p>
              <p className="text-[11px] text-slate-400">Debug bundles are manual exports. Secrets are redacted before upload.</p>
            </div>
            <RiskBadge level="low" label="Manual only" />
          </div>
        </Row>
      </Section>

      {/* ========================================================= */}
      {/* GATEWAY */}
      {/* ========================================================= */}
      <Section
        title="Gateway"
        subtitle={`127.0.0.1:8080, ${t('stateLabel')}: ${install}`}
        open={openSections.gateway}
        onToggle={() => toggleSection('gateway')}
        badge={
          <span className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border ${
            connected ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' : 'bg-rose-500/10 text-rose-300 border-rose-500/20'
          }`}>
            {connected ? t('running') : t('stopped')}
          </span>
        }
      >
        <Row>
          <p className="text-xs font-semibold text-white">{t('gatewaySupervisor')}</p>
          <div className="flex items-center gap-2.5 pt-2">
            <button
              onClick={async () => {
                await startGateway();
                showToast(t('gatewayStarted'));
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-white" />
              <span>{t('startDaemon')}</span>
            </button>
            <button
              onClick={() => {
                stopGateway();
                showToast(t('gatewayStopped'));
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 text-xs font-medium transition cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 fill-slate-300" />
              <span>{t('stopShort')}</span>
            </button>
            {(install === 'NOT_INSTALLED' || install === 'FAILED') && (
              <button
                onClick={() => {
                  void installGateway();
                }}
                className="px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 text-xs font-medium transition cursor-pointer"
              >
                Install
              </button>
            )}
          </div>
          {!connected && (
            <div className="pt-2">
              <StateNote state="offline" message={gatewayFailureReason || installError || 'Gateway is stopped.'} />
            </div>
          )}
        </Row>
        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white">{t('autostartTitle')}</p>
              <p className="text-[11px] text-slate-400">{t('autostartDesc')}</p>
            </div>
            <button
              onClick={() => {
                const next = !settings.autostart;
                updateSettings({ autostart: next });
                showToast(next ? t('autostartEnabled') : t('autostartDisabled'));
              }}
              aria-pressed={!!settings.autostart}
              className={`w-11 h-6 flex items-center rounded-full p-1 cursor-pointer transition-colors ${
                settings.autostart ? 'bg-indigo-600' : 'bg-white/[0.1]'
              }`}
            >
              <div
                className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  settings.autostart ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </Row>
      </Section>

      {/* ========================================================= */}
      {/* AUTOMATION: skills, memory, blueprints */}
      {/* ========================================================= */}
      <Section
        title="Automation"
        subtitle={t('skillsCatalogDesc')}
        open={openSections.automation}
        onToggle={() => toggleSection('automation')}
      >
        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-white">{t('skillsCatalog')}</p>
              <p className="text-[11px] text-slate-400">{t('skillsCatalogDesc')}</p>
            </div>
            <button
              onClick={() => {
                void refreshLibrary();
              }}
              className="text-xs text-indigo-400 hover:underline cursor-pointer"
            >
              {t('refresh')}
            </button>
          </div>
          <div className="space-y-2 pt-2.5">
            <StateNote
              state={skillsState}
              message={
                skillsState === 'loading' ? 'Loading skills...' :
                skillsState === 'empty' ? 'No skills installed yet.' :
                skillsState === 'offline' ? 'Gateway is offline. Skill toggles are unavailable.' :
                skillsState === 'error' ? 'Could not load skills.' :
                skillsState === 'refreshing' ? 'Refreshing skills...' : ''
              }
              onRetry={() => {
                void refreshLibrary();
              }}
            />
            {skills.map((sk) => (
              <div key={sk.id} className="flex items-center justify-between gap-3 py-2">
                <div className="pr-3 min-w-0">
                  <p className="text-xs font-semibold text-white">{sk.name}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{sk.description}</p>
                </div>
                <button
                  onClick={() => handleToggleSkill(sk.id, sk.enabled)}
                  aria-pressed={sk.enabled}
                  className={`w-10 h-5 flex items-center rounded-full p-0.5 cursor-pointer transition-colors shrink-0 ${
                    sk.enabled ? 'bg-indigo-600' : 'bg-white/[0.1]'
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                      sk.enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </Row>

        <Row>
          <p className="text-xs font-semibold text-white">{t('memoryTitle')}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {t('providerLabel')}: {memory?.provider || t('localVector')} · {t('entriesLabel')}: {memory?.entries || 0}
          </p>
          <div className="pt-2">
            <StateNote
              state={memoryState}
              message={
                memoryState === 'loading' ? 'Loading memory...' :
                memoryState === 'offline' ? 'Gateway is offline. Memory summary may be stale.' :
                memoryState === 'error' ? 'Could not load memory.' :
                memoryState === 'refreshing' ? 'Refreshing memory...' : ''
              }
            />
            {memoryState === 'ready' && (
              <div className="text-xs text-slate-300 bg-[var(--app-card-subtle,#141920)] p-3 rounded-xl border border-white/[0.06] font-mono leading-relaxed">
                {memory?.summary || t('memoryEmpty')}
              </div>
            )}
          </div>
        </Row>

        <Row>
          <p className="text-xs font-semibold text-white">{t('blueprintsTitle')}</p>
          <div className="pt-2 space-y-2">
            <StateNote
              state={blueprintsState}
              message={
                blueprintsState === 'loading' ? 'Loading blueprints...' :
                blueprintsState === 'empty' ? 'No blueprints available.' :
                blueprintsState === 'offline' ? 'Gateway is offline. Blueprints may be stale.' :
                blueprintsState === 'error' ? 'Could not load blueprints.' :
                blueprintsState === 'refreshing' ? 'Refreshing blueprints...' : ''
              }
              onRetry={() => {
                void refreshLibrary();
              }}
            />
            {blueprints.map((bp) => (
              <div key={bp.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white">{bp.name}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{bp.description}</p>
                </div>
                <button
                  onClick={() => {
                    setSelectedBlueprint(bp);
                    const initialSlots: Record<string, string> = {};
                    bp.parameters?.forEach((p) => {
                      initialSlots[p.name] = p.default || '';
                    });
                    setBlueprintSlots(initialSlots);
                  }}
                  className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer shrink-0"
                >
                  {t('launch')}
                </button>
              </div>
            ))}
          </div>
        </Row>
      </Section>

      {/* ========================================================= */}
      {/* APPEARANCE */}
      {/* ========================================================= */}
      <Section
        title="Appearance"
        subtitle={t('themeSubtitle')}
        open={openSections.appearance}
        onToggle={() => toggleSection('appearance')}
      >
        <Row>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-white">{t('themeTitle')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t('themeSubtitle')}</p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] rounded-xl self-start sm:self-auto">
              {[
                { id: 'light', label: t('light') || 'Light', icon: Sun },
                { id: 'dark', label: t('dark') || 'Dark', icon: Moon },
                { id: 'system', label: t('system') || 'System', icon: Monitor },
              ].map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => {
                    updateSettings({ themeMode: mode.id as ThemeMode });
                    showToast(`${t('themeTitle')}: ${mode.label}`);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                    currentMode === mode.id
                      ? 'bg-white/[0.12] text-white shadow-xs font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <mode.icon className="w-3.5 h-3.5" />
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="relative pt-3">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={themeSearch}
              onChange={(e) => setThemeSearch(e.target.value)}
              placeholder={t('searchThemes')}
              className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 placeholder:text-slate-500"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3">
            {visibleThemes.map((th) => {
              const isSelected = currentTheme === th.id;
              return (
                <button
                  key={th.id}
                  onClick={() => {
                    updateSettings({ themePalette: th.id });
                    showToast(`${t('appliedPrefix')} ${th.name} ${t('themeWord')}`);
                  }}
                  className={`p-3 rounded-2xl border text-left transition-all cursor-pointer flex flex-col justify-between group ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-500/10 ring-1 ring-indigo-500/50 shadow-sm'
                      : 'border-white/[0.08] bg-[var(--app-card-subtle,#141920)]/60 hover:bg-[var(--app-card-subtle,#141920)] hover:border-white/[0.18]'
                  }`}
                >
                  <div
                    className="w-full h-24 rounded-xl border border-white/[0.08] overflow-hidden flex relative mb-3 shadow-inner"
                    style={{ backgroundColor: th.preview.bg }}
                  >
                    <div
                      className="w-12 h-full border-r border-white/[0.06] shrink-0"
                      style={{ backgroundColor: th.preview.sidebar }}
                    />
                    <div className="flex-1 p-2.5 flex flex-col justify-between">
                      <div className="space-y-1.5">
                        <div className="h-2.5 w-20 rounded-full" style={{ backgroundColor: th.preview.bar1 }} />
                        <div className="h-2 w-28 rounded-full" style={{ backgroundColor: th.preview.bar2 }} />
                      </div>
                      <div className="flex justify-end">
                        <div className="h-4 w-12 rounded-full" style={{ backgroundColor: th.preview.pill }} />
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-white group-hover:text-indigo-300 transition-colors">
                        {th.name}
                      </h4>
                      {isSelected && (
                        <span className="w-2 h-2 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug line-clamp-2">
                      {th.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          {filteredThemes.length > 6 && (
            <button
              onClick={() => setShowAllThemes((v) => !v)}
              className="mt-2.5 text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer"
            >
              {showAllThemes ? 'Show fewer themes' : `Show all ${filteredThemes.length} themes`}
            </button>
          )}
        </Row>

        <Row>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-white">{t('languageTitle')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t('languageSubtitle')}</p>
            </div>
            <span className="px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 text-xs font-mono font-medium uppercase">
              {LANGUAGES.find((l) => l.id === (settings.language || 'en'))?.code || 'EN'}
            </span>
          </div>
          <div className="relative pt-2.5">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={langSearch}
              onChange={(e) => setLangSearch(e.target.value)}
              placeholder={t('searchLanguages')}
              className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 placeholder:text-slate-500 font-sans"
            />
          </div>
          <div className="divide-y divide-white/[0.04] max-h-64 overflow-y-auto rounded-2xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.06] mt-2.5">
            {filteredLanguages.map((lang) => {
              const isSelected = (settings.language || 'en') === lang.id;
              return (
                <button
                  key={lang.id}
                  onClick={() => {
                    updateSettings({ language: lang.id });
                    showToast(`${t('languageTitle')}: ${lang.name}`);
                  }}
                  className={`w-full px-4 py-3 flex items-center justify-between transition cursor-pointer hover:bg-white/[0.04] ${
                    isSelected ? 'bg-white/[0.06]' : ''
                  }`}
                >
                  <span className={`text-xs ${isSelected ? 'text-white font-semibold' : 'text-slate-300'}`}>
                    {lang.name}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-slate-500 uppercase font-semibold">{lang.code}</span>
                    {isSelected && <Check className="w-4 h-4 text-indigo-400 stroke-[2.5]" />}
                  </div>
                </button>
              );
            })}
          </div>
        </Row>

        <Row>
          <div className="flex justify-between text-xs text-slate-300">
            <span className="font-medium">{t('fontScale')}</span>
            <span className="font-mono text-slate-400">{Math.round(fontScaleLocal * 100)}%</span>
          </div>
          <input
            type="range"
            min="0.8"
            max="1.3"
            step="0.05"
            value={fontScaleLocal}
            onChange={(e) => setFontScaleLocal(parseFloat(e.target.value))}
            aria-label={t('fontScale')}
            className="w-full accent-indigo-500 mt-2"
          />
          <p className="text-[11px] text-slate-500 pt-1">{t('fontScaleDesc')}</p>
        </Row>
      </Section>

      {/* ========================================================= */}
      {/* ADVANCED: reasoning, diagnostics, snapshot, debug export */}
      {/* ========================================================= */}
      <Section
        title="Advanced"
        subtitle={t('diagnosticsDesc')}
        open={openSections.advanced}
        onToggle={() => toggleSection('advanced')}
      >
        <Row>
          <label className="block text-xs font-medium text-slate-300">{t('reasoningEffort')}</label>
          <div className="grid grid-cols-4 gap-2 pt-2">
            {EFFORT_LEVELS.map(({ id: lvl, label }) => (
              <button
                key={lvl}
                onClick={() => updateSettings({ reasoningEffort: lvl })}
                className={`py-2 rounded-xl text-xs font-medium capitalize cursor-pointer border transition-all ${
                  settings.reasoningEffort === lvl
                    ? 'bg-indigo-600 border-indigo-500 text-white shadow-xs'
                    : 'bg-white/[0.03] border-white/[0.06] text-slate-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-white">{t('diagnosticsTitle')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t('diagnosticsDesc')}</p>
            </div>
            <button
              onClick={handleRunDoctor}
              disabled={runningDoctor}
              className="px-3.5 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-slate-300 hover:text-white transition cursor-pointer disabled:opacity-50 shrink-0"
            >
              {runningDoctor ? t('auditing') : t('runDiagnostics')}
            </button>
          </div>
          <div className="pt-2">
            {runningDoctor && <StateNote state="loading" message="Running diagnostics..." />}
            {!runningDoctor && !doctorReport && (
              <StateNote
                state={connected ? 'empty' : 'offline'}
                message={connected ? 'No diagnostics run yet.' : 'Gateway is offline. Diagnostics need a running gateway.'}
              />
            )}
            {doctorReport && (
              <div className="space-y-2 pt-1">
                <p className="text-xs text-slate-300 font-medium">{doctorReport.summary}</p>
                <div className="space-y-1.5">
                  {doctorReport.checks.map((c, i) => (
                    <div key={i} className="flex items-center gap-2.5 py-2 border-b border-white/[0.04] last:border-0 text-xs">
                      {c.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      )}
                      <span className="text-white font-medium">{c.name}</span>
                      <span className="text-slate-400 ml-auto truncate max-w-[200px]">{c.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Row>

        <Row>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="py-1">
              <p className="text-xs font-semibold text-white">{t('snapshotTitle')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t('snapshotDesc')}</p>
              <button
                onClick={handleRunBackup}
                disabled={runningBackup}
                className="w-full py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-slate-300 hover:text-white transition cursor-pointer mt-2 disabled:opacity-50"
              >
                {runningBackup ? t('backingUp') : t('createSnapshot')}
              </button>
              {runningBackup && <div className="pt-2"><StateNote state="loading" message="Creating snapshot..." /></div>}
              {backupResult && <p className="text-[11px] text-emerald-400 pt-1.5">{backupResult.message}</p>}
            </div>
            <div className="py-1">
              <p className="text-xs font-semibold text-white">{t('debugTitle')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t('debugDesc')}</p>
              <button
                onClick={handleShareDebug}
                disabled={sharingDebug}
                className="w-full py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-slate-300 hover:text-white transition cursor-pointer mt-2 disabled:opacity-50"
              >
                {sharingDebug ? t('exporting') : t('generateBundle')}
              </button>
              {sharingDebug && <div className="pt-2"><StateNote state="loading" message="Redacting secrets and exporting..." /></div>}
              {debugResult && <p className="text-[11px] text-indigo-400 pt-1.5 truncate">{debugResult.summary}</p>}
            </div>
          </div>
        </Row>
      </Section>

      {/* Blueprint Launch Modal */}
      {selectedBlueprint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08]">
              <span className="text-sm font-semibold text-white">{selectedBlueprint.name}</span>
              <button
                onClick={() => setSelectedBlueprint(null)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">{selectedBlueprint.description}</p>
            {selectedBlueprint.parameters && selectedBlueprint.parameters.length > 0 && (
              <div className="space-y-2.5 pt-1">
                {selectedBlueprint.parameters.map((param) => (
                  <div key={param.name}>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{param.label}</label>
                    <input
                      type="text"
                      value={blueprintSlots[param.name] || ''}
                      onChange={(e) =>
                        setBlueprintSlots({
                          ...blueprintSlots,
                          [param.name]: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setSelectedBlueprint(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                onClick={() => handleInstantiateBlueprint(selectedBlueprint.id)}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs cursor-pointer transition"
              >
                {t('launchRoutine')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Multi-Provider Add / Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08]">
              <span className="text-sm font-semibold text-white">
                {editingProviderId ? t('editModelProvider') : t('addModelProvider')}
              </span>
              <button
                onClick={() => setShowAddModal(false)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">{t('modelCatalog')}</label>
                <select
                  value={newProvType}
                  onChange={(e) => {
                    const val = e.target.value;
                    setNewProvType(val);
                    const opt = PROVIDER_OPTIONS.find(([id]) => id === val);
                    if (opt) setNewProvName(opt[1]);
                    const defModel = DEFAULT_MODELS[val]?.[0] || '';
                    if (defModel) setNewProvModel(defModel);
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  {PROVIDER_OPTIONS.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name} ({id})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">{t('profileLabel')}</label>
                <input
                  type="text"
                  value={newProvName}
                  onChange={(e) => setNewProvName(e.target.value)}
                  placeholder={t('profilePlaceholder')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('apiKey')}{' '}
                  {normProvider(newProvType) === 'lmstudio' || normProvider(newProvType) === 'ollama-cloud'
                    ? t('optionalLocal')
                    : '*'}
                </label>
                <div className="relative">
                  <input
                    type={showNewKey ? 'text' : 'password'}
                    value={newProvKey}
                    onChange={(e) => {
                      setNewProvKey(e.target.value);
                      setKeyResult(null);
                    }}
                    placeholder="sk-..."
                    className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewKey(!showNewKey)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                  >
                    {showNewKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <button
                    type="button"
                    onClick={handleTestKey}
                    disabled={!newProvKey.trim() || testingKey}
                    className="px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs text-slate-300 hover:text-white transition cursor-pointer disabled:opacity-40"
                  >
                    {testingKey ? t('testingKey') : t('testKey')}
                  </button>
                  {testingKey && <span className="text-xs text-slate-400">Testing key...</span>}
                  {keyResult && (
                    <span
                      className={`text-xs font-medium ${
                        keyOk === true ? 'text-emerald-400' : keyOk === false ? 'text-rose-400' : 'text-amber-400'
                      }`}
                    >
                      {keyResult}
                    </span>
                  )}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">{t('defaultModel')}</label>
                <input
                  type="text"
                  value={newProvModel}
                  onChange={(e) => setNewProvModel(e.target.value)}
                  placeholder={DEFAULT_MODELS[newProvType]?.[0] || 'e.g. gpt-4o, claude-3-7-sonnet'}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">{t('baseUrl')}</label>
                <input
                  type="text"
                  value={newProvBaseUrl}
                  onChange={(e) => setNewProvBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
            </div>
            {!keysValid(newProvType, newProvKey, newProvBaseUrl) && (
              <p className="text-[11px] text-amber-400">
                {!newProvKey.trim() ? t('keyRequired') : t('unknownProviderUrl')}
              </p>
            )}
            <div className="flex justify-end gap-2.5 pt-3 border-t border-white/[0.06]">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                disabled={!keysValid(newProvType, newProvKey, newProvBaseUrl)}
                onClick={() => {
                  const cleanedKey = newProvKey.trim();
                  const targetModel = newProvModel.trim() || DEFAULT_MODELS[newProvType]?.[0] || `${newProvType}/default`;
                  const label = newProvName.trim() || PROVIDER_OPTIONS.find(([id]) => id === newProvType)?.[1] || newProvType;
                  // Only mark validated after a real successful validation of
                  // the exact key being saved. Untested or failed keys stay
                  // unvalidated; edits keep their prior flag when the key
                  // was not retested.
                  const existing = editingProviderId
                    ? configuredProviders.find((p) => p.id === editingProviderId)
                    : undefined;
                  const freshlyValidated = testedKey === cleanedKey && keyOk === true;
                  const validated = freshlyValidated || (!!editingProviderId && cleanedKey === (existing?.apiKey || '') && !!existing?.validated);

                  if (editingProviderId) {
                    const targetProv = configuredProviders.find((p) => p.id === editingProviderId);
                    const isCurrentlyActive = settings.activeProviderId
                      ? targetProv?.id === settings.activeProviderId
                      : targetProv?.provider === settings.provider;
                    updateConfiguredProvider(editingProviderId, {
                      provider: newProvType,
                      name: label,
                      apiKey: cleanedKey,
                      baseUrl: newProvBaseUrl.trim(),
                      defaultModel: targetModel,
                      validated,
                    });
                    if (isCurrentlyActive) {
                      updateSettings({
                        provider: newProvType,
                        apiKey: cleanedKey,
                        baseUrl: newProvBaseUrl.trim(),
                        modelId: targetModel,
                      });
                    }
                    showToast(`${t('updatedItem')} ${label}`);
                  } else {
                    const newId = addConfiguredProvider({
                      provider: newProvType,
                      name: label,
                      apiKey: cleanedKey,
                      baseUrl: newProvBaseUrl.trim(),
                      defaultModel: targetModel,
                      enabled: true,
                      validated,
                    });
                    // Automatically activate if requested or first
                    activateProvider(newId);
                    showToast(`${t('addedActivated')} ${label}`);
                  }
                  setShowAddModal(false);
                }}
                className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold shadow-xs cursor-pointer transition"
              >
                {editingProviderId ? t('save') : t('saveEnable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
