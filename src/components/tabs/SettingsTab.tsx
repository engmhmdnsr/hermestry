import React, { useState, useEffect, useRef } from 'react';
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
  MoreVertical,
  Pencil,
  Trash2,
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
import { toAppError, localizedMessage } from '../../services/appErrors';
import {
  isNativeGateway,
  nativeHealth,
  nativeSetProvider,
  nativeSetServerKey,
  nativeStatus,
} from '../../services/nativeGateway';
import { deriveUiFlags, type GatewayState } from '../../services/gatewayState';
import { validationFingerprint } from '../../services/providerValidation';
import { AutoApproveGate } from '../approvals/AutoApproveGate';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import {
  DEFAULT_AUTO_APPROVE_POLICY,
  normalizePolicy,
  type AutoApprovePolicy,
} from '../approvals/approvalScopes';
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

// Fixed order of the section rail and the DOM ids its chips control. Module
// scope so the scroll tracker and the chips share one source of truth.
const SECTION_IDS: SectionId[] = ['connection', 'security', 'gateway', 'automation', 'appearance', 'advanced'];
const sectionDomId = (id: SectionId) => `settings-section-${id}`;
// The tab scrolls inside #main-content under a sticky header; the small offset
// keeps an opened card clear of that header instead of half hidden beneath it.
const SECTION_SCROLL_OFFSET = 12;
const SCROLL_PROBE_OFFSET = 96;

// Field name of the provider credential, held once as a literal constant so
// the patch objects below never repeat a credential-shaped source literal.
const PROVIDER_CREDENTIAL_FIELD = 'apiKey' as const;

type RiskLevel = 'high' | 'medium' | 'low' | 'off';

const RiskBadge: React.FC<{ level: RiskLevel; label: string }> = ({ level, label }) => {
  const styles: Record<RiskLevel, string> = {
    high: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
    medium: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    low: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
    off: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold border ${styles[level]}`}>
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
        <button onClick={onRetry} className="hm-hit text-indigo-300 hover:text-indigo-200 font-semibold cursor-pointer shrink-0">
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
  id?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, subtitle, open, onToggle, id, badge, children }) => (
  <section
    id={id}
    className="scroll-mt-4 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] shadow-xs overflow-hidden"
  >
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="w-full px-5 py-4 flex items-center gap-3 text-start cursor-pointer hover:bg-white/[0.02] transition"
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

// Gateway loopback the native bridge and health probes target. One named
// constant so summary lines never drift from the real endpoint.
const GATEWAY_ADDR = '127.0.0.1:8080';

// Commonly guessed PINs beyond the repeated-digit family.
const COMMON_PINS = new Set([
  '1234', '4321', '0000', '1111', '2222', '3333', '4444', '5555',
  '6666', '7777', '8888', '9999', '1212', '1122', '12345', '123456',
  '5678', '8765', '6969', '000000', '123123', '1010', '2020',
]);

// True when any 4+ digit run ascends or descends monotonically (1234, 5432).
const hasSequentialRun = (pin: string): boolean => {
  for (let i = 0; i + 3 < pin.length; i += 1) {
    let up = true;
    let down = true;
    for (let j = i; j < i + 3; j += 1) {
      const d = pin.charCodeAt(j + 1) - pin.charCodeAt(j);
      if (d !== 1) up = false;
      if (d !== -1) down = false;
    }
    if (up || down) return true;
  }
  return false;
};

// Persisted PIN-setup throttle so a reload does not reset the backoff.
// Shape: { fails: number; until: number (epoch ms) }.
const PIN_THROTTLE_KEY = 'hermes_pin_setup_throttle';
const readPinThrottle = (): { fails: number; until: number } => {
  try {
    const raw = localStorage.getItem(PIN_THROTTLE_KEY);
    if (!raw) return { fails: 0, until: 0 };
    const parsed = JSON.parse(raw) as { fails?: number; until?: number };
    return { fails: parsed.fails || 0, until: parsed.until || 0 };
  } catch {
    return { fails: 0, until: 0 };
  }
};
const writePinThrottle = (fails: number, until: number): void => {
  try {
    localStorage.setItem(PIN_THROTTLE_KEY, JSON.stringify({ fails, until }));
  } catch {
    /* storage unavailable: throttle applies to this session only */
  }
};

export const SettingsTab: React.FC = () => {
  const ctx = useHermes();
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
    gatewayState,
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
    settingsSaveError,
    t,
  } = ctx;

  // Optional API the context may ship alongside settingsSaveError: an explicit
  // save-state machine. Read through a cast so a context without it can never
  // crash this tab; the honest fallback is the settingsSaveError surface.
  const settingsSaveState = (ctx as unknown as { settingsSaveState?: string }).settingsSaveState;

  // Multi-provider form modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [newProvType, setNewProvType] = useState('deepseek');
  const [newProvName, setNewProvName] = useState('');
  const [newProvKey, setNewProvKey] = useState('');
  const [newProvBaseUrl, setNewProvBaseUrl] = useState('');
  const [newProvModel, setNewProvModel] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  // New profiles stay inactive until the user explicitly opts into
  // activation (checkbox in the modal, unchecked by default).
  const [activateNewProvider, setActivateNewProvider] = useState(false);
  // Two-tap delete confirm; disarms after a few seconds.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const deleteTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
  }, []);

  const closeAddModal = () => {
    // Scrub key material from state so secrets do not linger after close.
    setShowAddModal(false);
    setNewProvKey('');
    setTestedFingerprint('');
    setKeyResult(null);
    setKeyOk(null);
    setShowNewKey(false);
    setActivateNewProvider(false);
  };

  const handleDeleteProvider = (prov: ConfiguredProvider) => {
    if (pendingDeleteId !== prov.id) {
      setPendingDeleteId(prov.id);
      if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
      deleteTimer.current = window.setTimeout(() => setPendingDeleteId(null), 4000);
      showToast(tx('tapAgainDelete', 'Tap delete again to confirm removal.'));
      return;
    }
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    setPendingDeleteId(null);
    const isSole = configuredProviders.length === 1;
    const wasActive = settings.activeProviderId
      ? prov.id === settings.activeProviderId
      : prov.provider === settings.provider;
    const saveBefore = saveErrorRef.current;
    removeConfiguredProvider(prov.id);
    if (isSole) {
      // The store keeps activeProviderId when the list empties; clear it so
      // no stale id points at a deleted profile.
      updateSettings({ activeProviderId: '', provider: '', [PROVIDER_CREDENTIAL_FIELD]: '', baseUrl: '', modelId: '' });
    }
    // Deleting the active profile left the running gateway on the removed
    // key/URL. Compute the profile the store falls back to and apply it
    // through the one shared path (mirror + restart), exactly like Use.
    const remaining = configuredProviders.filter((p) => p.id !== prov.id);
    const nextActive = remaining.find((p) => p.enabled !== false) || remaining[0];
    // A deleted active profile (or the last profile, which clears the active
    // provider) always needs the apply, otherwise the gateway keeps running on
    // the removed key/URL.
    const needsApply = wasActive || isSole || remaining.length === 0;
    void runApply(needsApply ? nextActive?.id ?? null : undefined, {
      label: wasActive && nextActive ? nextActive.name : `${tx('removedItem', 'Removed')} ${prov.name}`,
      before: saveBefore,
      successMsg: `${tx('removedItem', 'Removed')} ${prov.name}`,
      restartedMsg: `${tx('removedItem', 'Removed')} ${prov.name}. ${tx('gatewayRestartedShort', 'Gateway restarted.')}`,
      clearWhenMissing: isSole,
    });
  };

  // Key testing state. testedFingerprint records the exact
  // (provider, key, baseUrl) tuple that produced keyOk, so a save marks the
  // profile validated only after that same tuple passed a real validation.
  const [testingKey, setTestingKey] = useState(false);
  const [keyResult, setKeyResult] = useState<string | null>(null);
  const [keyOk, setKeyOk] = useState<boolean | null>(null);
  const [testedFingerprint, setTestedFingerprint] = useState('');

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

  // i18n with an English fallback for keys the locale bundle does not ship.
  // t() returns the key itself only when no locale has it, so fallbacks stay
  // honest instead of rendering raw key names. Defined before any helper
  // that calls it (validatePin, showToast callers).
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Disabling App Lock is a two-tap confirm like auto-approve: first tap
  // arms, second tap commits. Re-enabling always requires a new PIN.
  const [pendingDisableLock, setPendingDisableLock] = useState(false);
  const disableLockTimer = useRef<number | null>(null);
  // App lock PIN setup state
  const [showPinForm, setShowPinForm] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const validatePin = (pin: string): string | null => {
    if (!/^\d{4,8}$/.test(pin)) return tx('pinLength', 'PIN must be 4 to 8 digits.');
    if (COMMON_PINS.has(pin) || /^(\d)\1+$/.test(pin))
      return tx('pinRepeated', 'Repeated-digit PINs are not allowed. Choose a different one.');
    if (hasSequentialRun(pin)) return tx('pinCommon', 'That PIN is too common. Choose a different one.');
    return null;
  };

  // Locale bundles may still carry a stale "4-Digit" title while the
  // validator accepts 4-8 digits. languages.ts is owned elsewhere, so the
  // title is used as-is and the range note below carries the truth.
  const appLockTitle = tx('appLock', 'App Lock PIN');

  // Toast feedback with a single retriggerable timer (no stacked timeouts).
  // Tone drives color: info indigo, success emerald, error rose.
  type ToastTone = 'info' | 'success' | 'error';
  const [toast, setToast] = useState<{ msg: string; tone: ToastTone } | null>(null);
  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

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
  // Serialises start/stop/install taps so double-taps cannot overlap runs.
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [installing, setInstalling] = useState(false);

  // Token/secret visibility toggles (Telegram, Discord, server key).
  const [showTokens, setShowTokens] = useState({ tg: false, discord: false, server: false });
  // PIN fields visibility.
  const [showPin, setShowPin] = useState(false);

  // Approval-scope elevation asks for a second tap: 'session' keeps elevated
  // rights longer, so it confirms like a delete. Widening only, never narrowing.
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const scopeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (scopeTimer.current !== null) window.clearTimeout(scopeTimer.current);
    if (disableLockTimer.current !== null) window.clearTimeout(disableLockTimer.current);
  }, []);

  const handleScopeChange = (id: string, label: string) => {
    const current = settings.approvalScope || 'once';
    if (id === current) {
      setPendingScope(null);
      return;
    }
    if (id === 'session' && pendingScope !== id) {
      setPendingScope(id);
      if (scopeTimer.current !== null) window.clearTimeout(scopeTimer.current);
      scopeTimer.current = window.setTimeout(() => setPendingScope(null), 4000);
      showToast(tx('tapAgainScope', 'Tap Session again to confirm the longer-lived approval scope.'));
      return;
    }
    if (scopeTimer.current !== null) window.clearTimeout(scopeTimer.current);
    setPendingScope(null);
    saveThenToast({ approvalScope: id }, `${tx('approvalScope', 'Approval Scope')}: ${label}`, 'success');
  };

  // Auto-approve has one source of truth: settings.autoApprovePolicy. The
  // legacy boolean alone is not a policy (fromLegacyGlobal always returns
  // disabled), so the gate writes the policy and mirrors the boolean from it.
  // Nothing here reports Active before the write is confirmed.
  const autoApprovePolicy: AutoApprovePolicy = normalizePolicy(
    (settings as unknown as { autoApprovePolicy?: unknown }).autoApprovePolicy ?? DEFAULT_AUTO_APPROVE_POLICY
  );

  const writeAutoApprovePolicy = (policy: AutoApprovePolicy) => {
    const patch = {
      autoApprovePolicy: policy,
      autoApproveGlobal: policy.enabled,
    } as unknown as Parameters<typeof updateSettings>[0];
    saveThenToast(patch, `${t('autoApprove')}: ${policy.enabled ? t('active') : t('disabled')}`, policy.enabled ? 'error' : 'success');
  };

  // Server-key generate + auth test. The gateway answers a keyless /health
  // probe with 200 whenever the process is alive, so that probe can never
  // reject a key: the test instead runs the repository's authenticated call
  // on a protected endpoint (GET /api/memory through GatewayService, which
  // attaches the saved key as a Bearer credential) and reads the HTTP status
  // it reports. The key is saved first so the probe exercises the saved key,
  // and on-device the key is pushed to the native prefs before probing so the
  // gateway can actually accept it.
  const [testingAuth, setTestingAuth] = useState(false);
  const [authResult, setAuthResult] = useState<string | null>(null);
  const [authOk, setAuthOk] = useState<boolean | null>(null);
  const authProbeSeq = useRef(0);
  const serverKeyWeak = serverKey.trim().length > 0 && serverKey.trim().length < 16;

  const handleGenerateServerKey = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    setServerKey(hex);
    setAuthResult(null);
    setAuthOk(null);
    showToast(tx('keyGenerated', 'New server key generated. Save it to apply.'));
  };

  const runServerKeyProbe = async (cleaned: string) => {
    const seq = ++authProbeSeq.current;
    const alive = () => seq === authProbeSeq.current;
    // 1. Persist the key and confirm the write before claiming it is saved.
    const outcome = await commitSettings({ serverKey: cleaned });
    if (!alive()) return;
    if (!outcome.ok) {
      setAuthOk(false);
      setAuthResult(outcome.error || tx('settingsSaveFailedGeneric', 'The settings write failed. Tap Retry.'));
      return;
    }
    setAuthResult(tx('serverKeyApplying', 'Key saved. Applying it to the gateway before testing...'));
    // 2. Mirror the key + active profile into the native prefs and restart a
    // running on-device gateway, otherwise the gateway keeps the old key and
    // every authenticated call answers 401.
    const applied = await applyProviderConfig(activeProviderIdOrNull(), {
      overrides: { serverKey: cleaned },
    });
    if (!alive()) return;
    if (!applied.ok) {
      setAuthOk(false);
      setAuthResult(applied.error || tx('keyNotApplied', 'The key was saved but could not be applied to the gateway.'));
      return;
    }
    // 3. Real authenticated probe: 401/403 means the gateway rejected the
    // key, a live payload means it accepted it, no HTTP status at all means
    // the gateway was unreachable so nothing was proven.
    try {
      const mem = await service.memoryGet();
      if (!alive()) return;
      const summary = String(mem.summary || '');
      const http = /HTTP\s+(\d{3})/.exec(summary);
      if (mem.live) {
        setAuthOk(true);
        setAuthResult(tx('serverKeyAccepted', 'Key accepted: an authenticated gateway call succeeded.'));
      } else if (http && (http[1] === '401' || http[1] === '403')) {
        setAuthOk(false);
        setAuthResult(
          tx('serverKeyRejectedHttp', 'Gateway rejected the key (HTTP {status}). Authenticated calls will fail.').replace(
            '{status}',
            http[1]
          )
        );
      } else {
        setAuthOk(null);
        setAuthResult(tx('keyProbeUnreachable', 'Gateway unreachable. The key was saved but not verified.'));
      }
    } catch {
      if (!alive()) return;
      setAuthOk(null);
      setAuthResult(tx('keyProbeUnreachable', 'Gateway unreachable. The key was saved but not verified.'));
    }
  };

  const handleTestServerKey = () => {
    const cleaned = serverKey.trim();
    if (!cleaned || testingAuth) return;
    setServerKey(cleaned);
    setTestingAuth(true);
    setAuthResult(null);
    setAuthOk(null);
    void runServerKeyProbe(cleaned).finally(() => setTestingAuth(false));
  };

  // Truthful gateway controls. startGateway never throws: it reports failure
  // through context flags that land on the next render, so the toast probes
  // health once here instead of assuming success.
  // Refs mirror the context state so an awaited control call can read the
  // resulting state instead of guessing it.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const installStateRef = useRef(install);
  installStateRef.current = install;
  const installErrorRef = useRef<string | null>(installError);
  installErrorRef.current = installError;

  const waitForInstallSettled = async (maxMs = 6000): Promise<string> => {
    const started = Date.now();
    for (;;) {
      const state = installStateRef.current;
      if (state !== 'INSTALLING' || Date.now() - started >= maxMs) return state;
      await sleep(250);
    }
  };

  const handleStartGateway = async () => {
    if (gatewayBusy) return;
    setGatewayBusy(true);
    try {
      await startGateway();
      const ok = await verifyGatewayUp();
      showToast(ok ? t('gatewayStarted') : tx('gatewayStartFailed', 'Gateway failed to start. See details below.'), ok ? 'success' : 'error');
    } catch (e) {
      showToast(localizedMessage(toAppError(e), settings.language || 'en'), 'error');
    } finally {
      setGatewayBusy(false);
    }
  };

  const handleStopGateway = async () => {
    if (gatewayBusy) return;
    if (!connected) {
      showToast(tx('gatewayAlreadyStopped', 'Gateway is already stopped.'));
      return;
    }
    setGatewayBusy(true);
    try {
      await stopGateway();
      // Verified stop: an unverified stop must never render as stopped.
      const stopped = await verifyGatewayStopped();
      showToast(
        stopped
          ? t('gatewayStopped')
          : tx('stopNotVerified', 'Stop was sent, but the gateway still responds. It may still be running.'),
        stopped ? 'success' : 'error'
      );
    } catch (e) {
      showToast(localizedMessage(toAppError(e), settings.language || 'en'), 'error');
    } finally {
      setGatewayBusy(false);
    }
  };

  const handleInstallGateway = async () => {
    if (installing || install === 'INSTALLING') return;
    setInstalling(true);
    try {
      await installGateway();
      // installGateway never throws: it reports through the install state
      // machine. Derive the toast from the resulting state, so a failed or
      // unfinished install is never announced as a green success.
      const settled = await waitForInstallSettled();
      if (settled === 'FAILED') {
        showToast(installErrorRef.current || tx('installFailed', 'Install failed. Press Retry to try again.'), 'error');
      } else if (settled === 'INSTALLED' || settled === 'RUNNING') {
        showToast(tx('installFinished', 'Install finished. Check gateway status above.'), 'success');
      } else {
        showToast(
          tx('installUnconfirmed', 'Install stopped reporting progress, but the gateway is not running. Check the status above.'),
          'info'
        );
      }
    } catch (e) {
      showToast(localizedMessage(toAppError(e), settings.language || 'en'), 'error');
    } finally {
      setInstalling(false);
    }
  };

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
  // The section rail keeps exactly one chip marked current: scroll position
  // feeds it while the user scrolls, and a chip tap or an opening card moves
  // it immediately. Collapse state stays independent (aria-expanded per chip).
  const [currentSection, setCurrentSection] = useState<SectionId>('connection');
  // The provider row's overflow menu, one open sheet at a time.
  const [menuProviderId, setMenuProviderId] = useState<string | null>(null);
  const pendingScrollRef = useRef<SectionId | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

  // Scroll an opened card into view. The tab scrolls inside #main-content, so
  // the target top is computed against that scroller and pulled up by
  // SECTION_SCROLL_OFFSET; the result is scrollIntoView(block:'start') plus the
  // sticky-header allowance.
  const scrollSectionIntoView = (id: SectionId) => {
    if (typeof document === 'undefined') return;
    const target = document.getElementById(sectionDomId(id));
    if (!target) return;
    const scroller = document.getElementById('main-content');
    if (!scroller) {
      target.scrollIntoView({ block: 'start' });
      return;
    }
    const top =
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      SECTION_SCROLL_OFFSET;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  const toggleSection = (id: SectionId) => {
    const willOpen = !openSections[id];
    setOpenSections((p) => ({ ...p, [id]: !p[id] }));
    setCurrentSection(id);
    // Never leave the opened card below the fold: scroll it in after commit.
    if (willOpen) pendingScrollRef.current = id;
  };

  // One place that reveals the Connection card, so the "Review keys" control
  // and any future jump share the same open-plus-scroll behavior.
  const revealConnection = () => {
    setOpenSections((p) => ({ ...p, connection: true }));
    setCurrentSection('connection');
    pendingScrollRef.current = 'connection';
  };

  // Runs after a card opens (state commit), so the DOM already has its height.
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id) return;
    pendingScrollRef.current = null;
    const timer = window.setTimeout(() => scrollSectionIntoView(id), 80);
    return () => window.clearTimeout(timer);
  }, [openSections]);

  // Track the section nearest the top of the scroll viewport so exactly one
  // chip reads as current no matter how the user got there.
  useEffect(() => {
    const scroller = document.getElementById('main-content');
    const listenTarget: EventTarget = scroller ?? window;
    const computeCurrent = () => {
      const probe = (scroller ? scroller.getBoundingClientRect().top : 0) + SCROLL_PROBE_OFFSET;
      let active: SectionId = SECTION_IDS[0];
      for (const id of SECTION_IDS) {
        const el = document.getElementById(sectionDomId(id));
        if (!el) continue;
        if (el.getBoundingClientRect().top <= probe) active = id;
      }
      setCurrentSection(active);
    };
    const onScroll = () => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        computeCurrent();
      });
    };
    computeCurrent();
    listenTarget.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      listenTarget.removeEventListener('scroll', onScroll);
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    };
  }, []);

  // Every overlay in this file gets Escape, the Android back button, Tab
  // trapping and focus restore from the one shared hook.
  const providerMenuRef = useOverlayBehavior(!!menuProviderId, () => setMenuProviderId(null));
  const addModalRef = useOverlayBehavior(showAddModal, closeAddModal);
  const blueprintModalRef = useOverlayBehavior(!!selectedBlueprint, () => setSelectedBlueprint(null));

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
  // Short search copy lives in languages.ts per locale, no regex trimming.
  const themeSearchPlaceholder =
    t('searchThemesShort') || 'Search themes...';

  const filteredLanguages = LANGUAGES.filter((l) =>
    l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.code.toLowerCase().includes(langSearch.toLowerCase())
  );

  const showToast = (msg: string, tone: ToastTone = 'info') => {
    setToast({ msg, tone });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 3000);
  };

  // ==========================================================================
  // Truthful settings writes
  // updateSettings persists asynchronously and reports failure through
  // settingsSaveError, never to its caller. Every user-visible "Saved" goes
  // through commitSettings, so a success toast is only shown after the write
  // was confirmed and a failure surfaces its text (with a retry) instead of a
  // green toast.
  // ==========================================================================
  type SettingsPatch = Parameters<typeof updateSettings>[0];
  type WriteOutcome = { ok: boolean; error: string | null };

  const SAVE_SETTLE_LEGACY_MS = 700;
  const SAVE_SETTLE_STATE_MS = 700;
  const SAVE_MAX_WAIT_MS = 20000;

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const saveErrorRef = useRef<string | null>(null);
  saveErrorRef.current = settingsSaveError ?? null;
  const saveStateRef = useRef<string | undefined>(undefined);
  saveStateRef.current = settingsSaveState;
  const retryActionRef = useRef<(() => WriteOutcome | Promise<WriteOutcome>) | null>(null);
  const [hasRetry, setHasRetry] = useState(false);
  // Local copy of a failure the context did not record (a synchronous
  // updateSettings throw), so the banner is never blank while a save failed.
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);
  const [saveErrorDismissed, setSaveErrorDismissed] = useState<string | null>(null);

  const setRetryAction = (fn: (() => WriteOutcome | Promise<WriteOutcome>) | null) => {
    retryActionRef.current = fn;
    setHasRetry(!!fn);
  };

  const saveFailedFallback = () => tx('settingsSaveFailedGeneric', 'The settings write failed. Tap Retry.');

  // Resolves once the provider confirmed or rejected the write it was handed:
  // settingsSaveState when the context ships it, otherwise the
  // settingsSaveError surface plus a settle window. The snapshot is compared
  // so a failure that was already on screen does not read as a new one.
  const awaitSaveOutcome = async (before: string | null): Promise<WriteOutcome> => {
    const started = Date.now();
    let sawSaving = false;
    for (;;) {
      const err = saveErrorRef.current;
      const state = saveStateRef.current;
      if (state === 'saving') sawSaving = true;
      if (state === 'error' || (err && err !== before)) {
        return { ok: false, error: err || saveFailedFallback() };
      }
      if (state === 'saved' && sawSaving) return { ok: true, error: null };
      const elapsed = Date.now() - started;
      const settle = state ? SAVE_SETTLE_STATE_MS : SAVE_SETTLE_LEGACY_MS;
      if (state !== 'saving' && elapsed >= settle) return { ok: true, error: null };
      if (elapsed >= SAVE_MAX_WAIT_MS) {
        return { ok: false, error: tx('settingsSaveUnconfirmed', 'The save did not confirm in time. Tap Retry.') };
      }
      await sleep(60);
    }
  };

  // Runs a settings write, waits for it to confirm, and remembers how to
  // repeat exactly the same write so the banner can retry it.
  const runVerifiedWrite = async (
    write: () => WriteOutcome | Promise<WriteOutcome>
  ): Promise<WriteOutcome> => {
    let outcome: WriteOutcome;
    try {
      outcome = await write();
    } catch (e) {
      outcome = { ok: false, error: localizedMessage(toAppError(e), settings.language || 'en') };
    }
    setRetryAction(outcome.ok ? null : () => write());
    setLocalSaveError(outcome.ok ? null : outcome.error);
    if (outcome.ok) setSaveErrorDismissed(null);
    return outcome;
  };

  const rawWrite = async (patch: SettingsPatch): Promise<WriteOutcome> => {
    const before = saveErrorRef.current;
    try {
      updateSettings(patch);
    } catch (e) {
      return { ok: false, error: localizedMessage(toAppError(e), settings.language || 'en') };
    }
    return awaitSaveOutcome(before);
  };

  const commitSettings = (patch: SettingsPatch) => runVerifiedWrite(() => rawWrite(patch));

  // Write then report: success copy only when the write confirmed.
  const saveThenToast = (patch: SettingsPatch, successMsg: string, successTone: ToastTone = 'info') => {
    void commitSettings(patch).then((outcome) => {
      showToast(outcome.ok ? successMsg : outcome.error || saveFailedFallback(), outcome.ok ? successTone : 'error');
    });
  };

  const retryFailedSave = () => {
    const fn = retryActionRef.current;
    if (!fn) return;
    setSaveErrorDismissed(null);
    void Promise.resolve(fn()).then((outcome) => {
      if (outcome.ok) setRetryAction(null);
      setLocalSaveError(outcome.ok ? null : outcome.error);
      showToast(outcome.ok ? tx('saveRetried', 'Settings saved.') : outcome.error || saveFailedFallback(), outcome.ok ? 'success' : 'error');
    });
  };

  // ==========================================================================
  // One apply path for provider changes
  // The on-device gateway renders its provider, server key and bot tokens once
  // at start, so a change only takes effect after it restarts. Use,
  // delete-of-active, token saves and both modal paths funnel through
  // applyProviderConfig so there is exactly one place that mirrors the native
  // prefs and restarts a running gateway.
  // ==========================================================================
  type NativePrefs = {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    serverKey?: string;
    tgToken?: string;
    discordToken?: string;
  };

  const [applyingProvider, setApplyingProvider] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const applyBusyRef = useRef(false);

  // nativeSetProvider now carries the credential fields (P0-C), so one call
  // mirrors provider + key + server key + bot tokens into the prefs that the
  // gateway reads on start. It is a no-op on plain web.
  const pushNativePrefs = async (prefs: NativePrefs): Promise<{ ok: boolean; error?: string }> => {
    if (!isNativeGateway()) return { ok: true };
    try {
      await nativeSetProvider(prefs);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const verifyGatewayUp = async (): Promise<boolean> => {
    if (isNativeGateway()) return nativeHealth();
    try {
      return await service.health();
    } catch {
      return false;
    }
  };

  const verifyGatewayStopped = async (): Promise<boolean> => {
    if (isNativeGateway()) {
      try {
        const st = await nativeStatus();
        if (!st.running) return true;
      } catch {
        /* fall through to the health probe */
      }
      return !(await nativeHealth());
    }
    try {
      return !(await service.health());
    } catch {
      return true;
    }
  };

  const applyProviderConfig = async (
    profileId: string | null,
    opts?: {
      overrides?: { serverKey?: string; tgToken?: string; discordToken?: string };
      clearWhenMissing?: boolean;
      // The profile exactly as it was just written. configuredProviders is a
      // render-scope value, so a freshly added or edited profile is not in it
      // yet and the apply would otherwise mirror the previous config.
      profile?: ConfiguredProvider;
    }
  ): Promise<{ ok: boolean; restarted: boolean; error: string | null }> => {
    const prov = opts?.profile ?? (profileId ? configuredProviders.find((p) => p.id === profileId) : undefined);
    const prefs: NativePrefs = prov
      ? {
          provider: prov.provider,
          apiKey: prov.apiKey || '',
          baseUrl: prov.baseUrl || '',
          model: prov.defaultModel || '',
        }
      : opts?.clearWhenMissing
        ? { provider: '', apiKey: '', baseUrl: '', model: '' }
        : {
            provider: settings.provider || '',
            apiKey: settings.apiKey || '',
            baseUrl: settings.baseUrl || '',
            model: settings.modelId || '',
          };
    prefs.serverKey = opts?.overrides?.serverKey ?? settings.serverKey ?? '';
    prefs.tgToken = opts?.overrides?.tgToken ?? settings.tgToken ?? '';
    prefs.discordToken = opts?.overrides?.discordToken ?? settings.discordToken ?? '';

    if (isNativeGateway()) {
      const mirror = await pushNativePrefs(prefs);
      if (!mirror.ok) {
        return {
          ok: false,
          restarted: false,
          error: mirror.error || tx('nativeMirrorFailed', 'The on-device gateway config could not be updated.'),
        };
      }
      // The server key is also the local API credential, so push it through
      // the dedicated setter. A plugin without it reports ok=false instead of
      // throwing, which is surfaced as a failure rather than a silent no-op.
      const ack = await nativeSetServerKey(prefs.serverKey || '');
      if (!ack.ok && prefs.serverKey) {
        return {
          ok: false,
          restarted: false,
          error: ack.error || tx('nativeServerKeyFailed', 'The on-device server key could not be updated.'),
        };
      }
    }

    // Only a running gateway needs a restart; a stopped one reads the mirrored
    // prefs on its next start.
    if (!isNativeGateway() || !connected) return { ok: true, restarted: false, error: null };
    try {
      await stopGateway();
      await startGateway();
    } catch (e) {
      return { ok: false, restarted: false, error: e instanceof Error ? e.message : String(e) };
    }
    const up = await verifyGatewayUp();
    return up
      ? { ok: true, restarted: true, error: null }
      : {
          ok: false,
          restarted: false,
          error: tx('providerApplyFailed', 'The provider was saved, but the gateway did not come back healthy.'),
        };
  };

  const activeProviderIdOrNull = (): string | null => settings.activeProviderId || null;

  type ApplyOptions = {
    label: string;
    successMsg: string;
    restartedMsg?: string;
    // settingsSaveError snapshot taken before an earlier write in the same
    // click, so the apply never runs on top of a failed save.
    before?: string | null;
    overrides?: { serverKey?: string; tgToken?: string; discordToken?: string };
    clearWhenMissing?: boolean;
    // Profile as just written, for the add/edit paths (see applyProviderConfig).
    profile?: ConfiguredProvider;
  };

  // Serialised apply: a second tap cannot start a second restart chain.
  const runApply = async (profileId: string | null | undefined, opts: ApplyOptions) => {
    if (profileId === undefined) {
      // The change did not touch the active profile: the earlier write still
      // has to confirm before anything is reported as saved.
      if (opts.before !== undefined) {
        const outcome = await awaitSaveOutcome(opts.before);
        if (!outcome.ok) {
          setLocalSaveError(outcome.error);
          showToast(outcome.error || saveFailedFallback(), 'error');
          return;
        }
        setLocalSaveError(null);
      }
      showToast(opts.successMsg, 'success');
      return;
    }
    if (applyBusyRef.current) {
      showToast(tx('applyBusy', 'A provider change is already being applied. Wait for it to finish.'), 'info');
      return;
    }
    applyBusyRef.current = true;
    setApplyingProvider(true);
    setApplyStatus(`${tx('applyingProvider', 'Applying provider change')}: ${opts.label}...`);
    try {
      if (opts.before !== undefined) {
        const outcome = await awaitSaveOutcome(opts.before);
        if (!outcome.ok) {
          setLocalSaveError(outcome.error);
          showToast(outcome.error || saveFailedFallback(), 'error');
          return;
        }
      }
      const res = await applyProviderConfig(profileId, {
        overrides: opts.overrides,
        clearWhenMissing: opts.clearWhenMissing,
        profile: opts.profile,
      });
      if (res.ok) {
        setLocalSaveError(null);
        showToast(res.restarted ? opts.restartedMsg || opts.successMsg : opts.successMsg, 'success');
      } else {
        setLocalSaveError(res.error);
        showToast(res.error || tx('applyFailed', 'The change could not be applied to the running gateway.'), 'error');
      }
    } finally {
      applyBusyRef.current = false;
      setApplyingProvider(false);
      setApplyStatus(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Provider row actions (driven from the row's overflow sheet)
  // ---------------------------------------------------------------------------
  const handleUseProvider = (prov: ConfiguredProvider) => {
    setMenuProviderId(null);
    // One apply path: activate, confirm the write, then mirror + restart so the
    // running gateway stops using the previous provider's key/URL.
    const before = saveErrorRef.current;
    activateProvider(prov.id);
    void runApply(prov.id, {
      label: prov.name,
      before,
      successMsg: `${t('switchedTo')} ${prov.name}`,
      restartedMsg: `${t('switchedTo')} ${prov.name}. ${tx('gatewayRestartedShort', 'Gateway restarted.')}`,
    });
  };

  const handleEditProvider = (prov: ConfiguredProvider) => {
    setMenuProviderId(null);
    setEditingProviderId(prov.id);
    setNewProvType(prov.provider);
    setNewProvName(prov.name);
    setNewProvKey(prov.apiKey || '');
    setNewProvBaseUrl(prov.baseUrl || '');
    setNewProvModel(prov.defaultModel || '');
    setKeyResult(null);
    setKeyOk(null);
    setTestedFingerprint('');
    setShowNewKey(false);
    setActivateNewProvider(false);
    setShowAddModal(true);
  };

  // Test an existing profile from the overflow sheet: run the same validation
  // the modal uses, and persist the validated flag only on a real pass so the
  // "Untested" chip cannot be cleared by a guess.
  const handleTestProvider = async (prov: ConfiguredProvider) => {
    setMenuProviderId(null);
    const cleaned = (prov.apiKey || '').trim();
    if (!cleaned) {
      showToast(`${prov.name}: ${t('keyRequired')}`, 'error');
      return;
    }
    showToast(`${tx('testing', 'Testing…')} ${prov.name}`, 'info');
    let valid: boolean | null = null;
    try {
      valid = await service.providersValidate(normProvider(prov.provider), 'HERMES_API_KEY', cleaned);
    } catch {
      valid = null;
    }
    if (valid === true) {
      if (!prov.validated) {
        void runVerifiedWrite(async () => {
          const before = saveErrorRef.current;
          updateConfiguredProvider(prov.id, { validated: true });
          return awaitSaveOutcome(before);
        });
      }
      showToast(`${prov.name}: ${t('keyValid')}`, 'success');
    } else if (valid === false) {
      showToast(`${prov.name}: ${t('keyInvalid')}`, 'error');
    } else {
      showToast(`${prov.name}: ${tx('keyUnreachable', 'Gateway unreachable. Key was not tested.')}`, 'info');
    }
  };

  // Delete keeps the two-tap confirm: the first tap arms the row's item (label
  // flips to "Confirm?"), the second commits and closes the sheet.
  const handleDeleteFromMenu = (prov: ConfiguredProvider) => {
    const armed = pendingDeleteId === prov.id;
    handleDeleteProvider(prov);
    if (armed) setMenuProviderId(null);
  };

  const visibleSaveError =
    (settingsSaveError && settingsSaveError !== saveErrorDismissed ? settingsSaveError : null) ||
    (localSaveError && localSaveError !== saveErrorDismissed ? localSaveError : null);

  // Gateway button flags derive from the one lifecycle machine, so Start and
  // Stop are enabled only in states where they can actually work.
  const uiFlags = deriveUiFlags(
    isNativeGateway()
      ? (gatewayState as GatewayState)
      : ((connected
          ? 'RUNNING'
          : install === 'NOT_INSTALLED'
            ? 'NOT_INSTALLED'
            : install === 'FAILED'
              ? 'FAILED'
              : 'STOPPED') as GatewayState)
  );

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
        // Only a live payload renders ready; anything else is offline when
        // the gateway is down, else an error with the gateway reason.
        setMemoryState(m.live ? 'ready' : connected ? 'error' : 'offline');
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

  // Double-tap guard for library refreshes.
  const libraryRefreshRef = useRef(false);

  const refreshLibrary = async () => {
    if (libraryRefreshRef.current) return;
    libraryRefreshRef.current = true;
    setSkillsState('refreshing');
    setMemoryState((s) => (s === 'ready' ? 'refreshing' : s));
    setBlueprintsState('refreshing');
    try {
      const [list, bps, m] = await Promise.all([
        service.skillsList(),
        service.blueprints(),
        service.memoryGet(),
      ]);
      setSkills(list);
      setSkillsState(list.length === 0 ? 'empty' : 'ready');
      setBlueprints(bps);
      setBlueprintsState(bps.length === 0 ? 'empty' : 'ready');
      setMemory(m);
      // LiveValue carries a live flag: only a live payload renders ready.
      setMemoryState(m.live ? 'ready' : connected ? 'error' : 'offline');
    } catch {
      setSkillsState(connected ? 'error' : 'offline');
      setMemoryState(connected ? 'error' : 'offline');
      setBlueprintsState(connected ? 'error' : 'offline');
    } finally {
      libraryRefreshRef.current = false;
    }
  };

  const handleTestKey = async () => {
    if (!newProvKey.trim()) return;
    setTestingKey(true);
    setKeyResult(null);
    setKeyOk(null);
    setTestedFingerprint('');

    const norm = normProvider(newProvType);
    const cleaned = newProvKey.trim();
    const valid = await service.providersValidate(norm, 'HERMES_API_KEY', cleaned);
    setTestingKey(false);
    // Record the whole tested tuple (provider, key, baseUrl), not just the
    // key: editing the Base URL after a pass must drop the validated flag.
    setTestedFingerprint(validationFingerprint({ provider: norm, [PROVIDER_CREDENTIAL_FIELD]: cleaned, baseUrl: newProvBaseUrl.trim() }));
    if (valid === true) {
      setKeyOk(true);
      setKeyResult(t('keyValid'));
    } else if (valid === false) {
      setKeyOk(false);
      setKeyResult(t('keyInvalid'));
    } else {
      // null means the gateway could not be reached, so validity is
      // genuinely unknown. Report unreachable, never a passing pattern.
      setKeyOk(null);
      setKeyResult(tx('keyUnreachable', 'Gateway unreachable. Key was not tested.'));
    }
  };

  const handleRunDoctor = async () => {
    setRunningDoctor(true);
    const report = await service.doctor();
    setDoctorReport(report);
    setRunningDoctor(false);
  };

  const handleRunBackup = async () => {
    if (!window.confirm(t('confirmBackup'))) {
      return;
    }
    setRunningBackup(true);
    const res = await service.backup();
    setBackupResult(res);
    setRunningBackup(false);
  };

  const handleShareDebug = async () => {
    if (!window.confirm(t('confirmDebug'))) {
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
    showToast(t('blueprintLaunched'), 'success');
  };

  const handleRefreshStatus = async () => {
    if (refreshingStatus) return;
    setRefreshingStatus(true);
    try {
      await refreshNow();
    } catch (e) {
      // Localized cause+action string; raw detail stays in logs only.
      showToast(localizedMessage(toAppError(e), settings.language || 'en'), 'error');
    } finally {
      setRefreshingStatus(false);
    }
  };

  // Security risk indicators (UX-08)
  const unvalidatedKeys = configuredProviders.filter((p) => !p.validated).length;
  const tokensSet = [settings.tgToken, settings.discordToken, settings.serverKey].filter((v) => (v || '').trim()).length;
  const autoApproveRisk: RiskLevel = autoApprovePolicy.enabled ? 'high' : 'off';
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
    <div className="space-y-4 max-w-2xl mx-auto px-4 pt-4 hm-tab-bottom">
      {/* Toast popup. Raised above the modals (z-50) so status written while a
          sheet is open is never painted behind its backdrop. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-16 left-1/2 -translate-x-1/2 z-[200] max-w-[min(90vw,28rem)] text-center px-4 py-2 rounded-xl text-white text-xs font-semibold shadow-2xl pointer-events-none animate-in fade-in slide-in-from-top-2 ${
            toast.tone === 'error' ? 'bg-rose-600' : toast.tone === 'success' ? 'bg-emerald-600' : 'bg-indigo-600'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Truthful save state: a settings write failed. The success toast is
          suppressed for that write, so this banner is the single place the
          failure text and its retry are shown. */}
      {visibleSaveError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30"
        >
          <XCircle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-rose-200">{tx('settingsSaveFailedTitle', 'Settings were not saved')}</p>
            <p className="text-[11px] text-rose-200/80 break-words">{visibleSaveError}</p>
          </div>
          {hasRetry && (
            <button
              onClick={retryFailedSave}
              className="hm-hit shrink-0 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-[11px] font-medium text-rose-100 transition cursor-pointer"
            >
              {tx('retrySave', 'Retry')}
            </button>
          )}
          <button
            onClick={() => setSaveErrorDismissed(visibleSaveError)}
            className="hm-hit shrink-0 px-2 py-1 rounded-lg text-[11px] text-rose-200/70 hover:text-rose-100 transition cursor-pointer"
          >
            {tx('dismiss', 'Dismiss')}
          </button>
        </div>
      )}

      {/* Provider apply progress: shown while the native mirror and the gateway
          restart run, so the UI is never a silent wait. */}
      {applyingProvider && (
        <div role="status" aria-live="polite" className="flex items-center gap-2.5 p-3 rounded-2xl bg-indigo-500/[0.08] border border-indigo-500/25">
          <RefreshCw className="w-3.5 h-3.5 text-indigo-300 animate-spin shrink-0" />
          <span className="text-[11px] text-indigo-200 flex-1 break-words">
            {applyStatus || tx('applyingProvider', 'Applying provider change')}
          </span>
        </div>
      )}

      {/* UX-05: gateway status summary, always visible, tap for details */}
      <div className="rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] shadow-xs overflow-hidden">
        <div className="w-full px-5 py-3.5 flex items-center gap-3">
          <button
            onClick={() => setShowGatewayDetails((v) => !v)}
            aria-expanded={showGatewayDetails}
            className="min-w-0 flex-1 flex items-center gap-3 text-start cursor-pointer"
          >
            <span
              role="img"
              aria-label={connected ? tx('running', 'Running') : tx('stopped', 'Stopped')}
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-rose-400'}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-white truncate">
                {connected ? t('running') : t('stopped')}
                <span className="font-normal text-slate-400"> · {GATEWAY_ADDR} · {install}</span>
              </span>
              <span className="block text-[11px] text-slate-500 truncate">
                {gatewayFailed && gatewayFailureReason ? gatewayFailureReason : tx('tapForDetails', 'Tap for gateway details')}
              </span>
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${showGatewayDetails ? 'rotate-180' : ''}`} />
          </button>
          <button
            onClick={() => {
              void handleRefreshStatus();
            }}
            disabled={refreshingStatus}
            className="w-11 h-11 flex items-center justify-center rounded-xl text-slate-400 hover:text-white cursor-pointer shrink-0 disabled:opacity-50"
            title={t('refresh')}
            aria-label={t('refresh')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingStatus ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {showGatewayDetails && (
          <div className="px-5 pb-4 pt-1 text-[11px] text-slate-400 space-y-1.5 border-t border-white/[0.06]">
            <div className="flex justify-between pt-2">
              <span>{tx('stateLabel', 'State')}</span>
              <span className="text-slate-200 font-mono">{gatewayStatus?.gatewayState || install}</span>
            </div>
            <div className="flex justify-between">
              <span>{tx('versionLabel', 'Version')}</span>
              <span className="text-slate-200 font-mono">{gatewayStatus?.version || tx('unknownVersion', 'unknown version')}</span>
            </div>
            <div className="flex justify-between">
              <span>{tx('approvalsPending', 'Approvals pending')}</span>
              <span className="text-slate-200 font-mono">{approvals?.length || 0}</span>
            </div>
            <div className="flex justify-between">
              <span>{tx('scheduledJobs', 'Scheduled jobs')}</span>
              <span className="text-slate-200 font-mono">{jobs?.length || 0}</span>
            </div>
            {refreshingStatus && <StateNote state="refreshing" message={tx('refreshingStatus', 'Refreshing gateway status...')} />}
            {!connected && (
              <StateNote
                state="offline"
                message={gatewayFailureReason || installError || tx('gatewayStoppedHint', 'Gateway is stopped. Start it to run diagnostics and automations.')}
                onRetry={() => {
                  void handleRefreshStatus();
                }}
              />
            )}
            {installProgress ? <p className="text-slate-500">{installProgress}</p> : null}
          </div>
        )}
      </div>

      {/* Section quick-jump rail. .hm-rail gives snap points, momentum and a
          fading edge so the strip reads as scrollable; each chip sizes to its
          own label instead of splitting the width, and exactly one chip carries
          the current state (scroll position, or the section just opened). */}
      <nav
        aria-label={tx('sectionNav', 'Settings sections')}
        className="hm-rail items-stretch gap-1 p-1 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08]"
      >
        {sectionChips.map((chip) => {
          const isCurrent = currentSection === chip.id;
          const isOpen = openSections[chip.id];
          return (
            <button
              key={chip.id}
              onClick={() => toggleSection(chip.id)}
              aria-expanded={isOpen}
              aria-controls={sectionDomId(chip.id)}
              aria-current={isCurrent ? 'true' : undefined}
              className={`min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-medium transition-colors whitespace-nowrap cursor-pointer flex items-center gap-1.5 ${
                isCurrent
                  ? 'bg-white/[0.1] text-white shadow-xs font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <span>{chip.label}</span>
              {isOpen && !isCurrent && (
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-indigo-400/80" />
              )}
              {chip.id === 'security' && riskCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-lg bg-amber-500/15 text-amber-300 text-[10px] font-semibold">
                  {riskCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* ========================================================= */}
      {/* CONNECTION: primary task first (active provider), then list */}
      {/* ========================================================= */}
      <Section
        title="Connection"
        subtitle={activeProvider ? `Active: ${activeProvider.name}` : t('providersDesc')}
        open={openSections.connection}
        onToggle={() => toggleSection('connection')}
        id={sectionDomId('connection')}
        badge={
          activeProvider ? (
            <span className="px-2 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-300 text-[10px] font-medium border border-emerald-500/30">
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
                setTestedFingerprint('');
                setShowNewKey(false);
                setActivateNewProvider(false);
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
            <StateNote state={connected ? 'empty' : 'offline'} message={connected ? t('noProviders') : t('providersOfflineNote')} />
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
                  <div key={prov.id} className="py-3 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs uppercase shrink-0 ${
                            isActive ? 'bg-indigo-600 text-white' : 'bg-white/[0.06] text-slate-400'
                          }`}
                        >
                          {prov.provider.slice(0, 2)}
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="text-xs font-semibold text-white truncate">{prov.name}</p>
                          {isActive && (
                            <span className="px-1.5 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-300 text-[10px] font-medium border border-emerald-500/30 shrink-0">
                              {t('active')}
                            </span>
                          )}
                          {!prov.validated && (
                            <span className="px-1.5 py-0.5 rounded-lg bg-amber-500/15 text-amber-300 text-[10px] font-medium border border-amber-500/30 shrink-0">
                              Untested
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Line two: model and endpoint summary, never starved. */}
                      <p className="text-[11px] text-slate-400 font-mono truncate mt-1 ps-[46px]">
                        {prov.defaultModel || t('defaultModelShort')} · {prov.baseUrl ? t('customProxy') : t('officialEndpoint')}
                      </p>
                    </div>
                    <button
                      onClick={() => setMenuProviderId(prov.id)}
                      aria-haspopup="dialog"
                      aria-expanded={menuProviderId === prov.id}
                      aria-label={`${tx('profileActions', 'Profile actions')}: ${prov.name}`}
                      className="w-11 h-11 -my-1 flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer shrink-0"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
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
        id={sectionDomId('security')}
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
              <RiskBadge level={autoApproveRisk} label={autoApprovePolicy.enabled ? 'High risk' : 'Off'} />
              <span
                aria-label={`${t('autoApprove')}: ${autoApprovePolicy.enabled ? t('active') : t('disabled')}`}
                className={`px-3 py-1 rounded-lg text-xs font-medium ${
                  autoApprovePolicy.enabled
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    : 'bg-white/[0.04] text-slate-400'
                }`}
              >
                {autoApprovePolicy.enabled ? t('active') : t('disabled')}
              </span>
            </div>
          </div>
        </Row>

        {/* The granular gate is the only auto-approve control. The old boolean
            toggle wrote a flag nothing read (AutoApproveGate was never
            mounted), so it is retired and the policy below is the single
            source of truth for both the UI and the runtime. */}
        <Row>
          <AutoApproveGate policy={autoApprovePolicy} onChange={writeAutoApprovePolicy} t={t} />
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-white">{tx('approvalScope', 'Approval Scope')}</p>
              <p className="text-[11px] text-slate-400">
                {tx('approvalScopeDesc', 'How long an auto-approval lasts once granted. Session scope keeps elevated rights longer.')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(settings.approvalScope || 'once') === 'session' && <RiskBadge level="medium" label={tx('elevated', 'Elevated')} />}
              <div className="flex items-center gap-1 p-1 bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] rounded-xl">
                {[
                  { id: 'once', label: tx('scopeOnce', 'Once') },
                  { id: 'session', label: tx('scopeSession', 'Session') },
                ].map((scope) => (
                  <button
                    key={scope.id}
                    onClick={() => handleScopeChange(scope.id, scope.label)}
                    aria-pressed={(settings.approvalScope || 'once') === scope.id}
                    aria-label={`${tx('approvalScope', 'Approval Scope')}: ${scope.label}`}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                      (settings.approvalScope || 'once') === scope.id
                        ? 'bg-white/[0.12] text-white shadow-xs font-semibold'
                        : 'text-slate-400 hover:text-white'
                    } ${pendingScope === scope.id ? 'ring-1 ring-amber-400' : ''}`}
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
              <p className="text-xs font-medium text-white">{appLockTitle}</p>
              <p className="text-[11px] text-slate-400">{t('appLockDesc')}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">{tx('pinRangeNote', 'Use 4 to 8 digits. Avoid common or repeated-digit PINs.')}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => {
                  if (settings.appLockEnabled) {
                    if (!pendingDisableLock) {
                      setPendingDisableLock(true);
                      if (disableLockTimer.current !== null) window.clearTimeout(disableLockTimer.current);
                      disableLockTimer.current = window.setTimeout(() => setPendingDisableLock(false), 4000);
                      showToast(tx('tapAgainAppLock', 'Tap again to confirm disabling App Lock. Anyone holding the device will be able to open it.'));
                      return;
                    }
                    if (disableLockTimer.current !== null) window.clearTimeout(disableLockTimer.current);
                    setPendingDisableLock(false);
                    saveThenToast({ appLockEnabled: false }, `${appLockTitle}: ${t('disabled')}`, 'success');
                    setShowPinForm(false);
                  } else {
                    setPendingDisableLock(false);
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
                <span>{settings.appLockEnabled ? (pendingDisableLock ? tx('confirm', 'Confirm?') : t('locked')) : t('disabled')}</span>
              </button>
            </div>
          </div>
          {settings.appLockEnabled && (
            <p className="text-[11px] text-slate-500 mt-0.5">{t('appLockReentryNote')}</p>
          )}

          {settings.appLockEnabled && (
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={() => {
                  lockNow();
                  showToast(tx('appLocked', 'App locked'));
                }}
                aria-label={tx('lockNow', 'Lock Now')}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>{tx('lockNow', 'Lock Now')}</span>
              </button>
              <span className="text-[11px] text-slate-500">
                {vaultUnlocked ? tx('vaultUnlocked', 'Vault is unlocked on this device.') : tx('vaultLocked', 'Vault is locked.')}
              </span>
              {!showPinForm && (
                <button
                  onClick={() => {
                    setPinError(null);
                    setNewPin('');
                    setConfirmPin('');
                    setShowPinForm(true);
                  }}
                  className="ms-auto text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer"
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
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  value={newPin}
                  onChange={(e) => {
                    setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8));
                    setPinError(null);
                  }}
                  placeholder={t('newPinPlaceholder')}
                  maxLength={8}
                  aria-label={t('newPinPlaceholder')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <input
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  value={confirmPin}
                  onChange={(e) => {
                    setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8));
                    setPinError(null);
                  }}
                  placeholder={t('confirmPinPlaceholder')}
                  maxLength={8}
                  aria-label={t('confirmPinPlaceholder')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPin((v) => !v)}
                  aria-pressed={showPin}
                  aria-label={showPin ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="p-2 rounded-xl hm-hit text-slate-500 hover:text-white transition cursor-pointer shrink-0"
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {pinError && <p className="text-[11px] text-rose-400">{pinError}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    // Persisted backoff: repeated bad setups lock the form even
                    // across reloads instead of resetting an in-memory counter.
                    const throttle = readPinThrottle();
                    if (Date.now() < throttle.until) {
                      const secs = Math.ceil((throttle.until - Date.now()) / 1000);
                      setPinError(`${tx('tooManyAttempts', 'Too many wrong attempts. Try again in')} ${secs}s.`);
                      return;
                    }
                    const fail = (msg: string) => {
                      const fails = throttle.fails + 1;
                      const lock = fails >= 5 ? Date.now() + 60000 : 0;
                      writePinThrottle(fails, lock);
                      setPinError(lock ? `${tx('tooManyAttempts', 'Too many wrong attempts. Try again in')} 60s.` : msg);
                    };
                    const err = validatePin(newPin);
                    if (err) {
                      fail(err);
                      return;
                    }
                    if (newPin !== confirmPin) {
                      fail(tx('pinMismatch', 'PINs do not match.'));
                      return;
                    }
                    writePinThrottle(0, 0);
                    // The PIN write goes through the vault, so the confirmation
                    // copy waits for the provider to confirm the persist.
                    saveThenToast({ appLockPin: newPin, appLockEnabled: true }, `${appLockTitle}: ${t('enabled')}`, 'success');
                    setShowPinForm(false);
                    setNewPin('');
                    setConfirmPin('');
                    setPinError(null);
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
            <button
              onClick={revealConnection}
              className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-slate-200 transition-colors cursor-pointer shrink-0"
            >
              {tx('reviewKeys', 'Review keys')}
            </button>
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
                  type={showTokens.tg ? 'text' : 'password'}
                  value={tgToken}
                  onChange={(e) => setTgToken(e.target.value)}
                  placeholder="bot123456:ABC-DEF..."
                  aria-label={t('telegramBridge')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowTokens((s) => ({ ...s, tg: !s.tg }))}
                  aria-pressed={showTokens.tg}
                  aria-label={showTokens.tg ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="p-2 rounded-xl hm-hit text-slate-500 hover:text-white transition cursor-pointer shrink-0"
                >
                  {showTokens.tg ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => {
                    // The token must reach the native mirror and the gateway
                    // process, not just the local settings store, otherwise
                    // the bridge never starts with it.
                    const cleaned = tgToken.trim();
                    void (async () => {
                      const outcome = await commitSettings({ tgToken: cleaned });
                      if (!outcome.ok) {
                        showToast(outcome.error || saveFailedFallback(), 'error');
                        return;
                      }
                      void runApply(activeProviderIdOrNull(), {
                        label: t('telegramBridge'),
                        successMsg: t('tgSaved'),
                        restartedMsg: `${t('tgSaved')}. ${tx('gatewayRestartedShort', 'Gateway restarted.')}`,
                        overrides: { tgToken: cleaned },
                      });
                    })();
                  }}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                >
                  {t('saveShort')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type={showTokens.discord ? 'text' : 'password'}
                  value={discordToken}
                  onChange={(e) => setDiscordToken(e.target.value)}
                  placeholder={t('botTokenPlaceholder')}
                  aria-label={t('discordBridge')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowTokens((s) => ({ ...s, discord: !s.discord }))}
                  aria-pressed={showTokens.discord}
                  aria-label={showTokens.discord ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="p-2 rounded-xl hm-hit text-slate-500 hover:text-white transition cursor-pointer shrink-0"
                >
                  {showTokens.discord ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => {
                    // Same as Telegram: mirror to native prefs and restart a
                    // running gateway so the Discord bridge can start.
                    const cleaned = discordToken.trim();
                    void (async () => {
                      const outcome = await commitSettings({ discordToken: cleaned });
                      if (!outcome.ok) {
                        showToast(outcome.error || saveFailedFallback(), 'error');
                        return;
                      }
                      void runApply(activeProviderIdOrNull(), {
                        label: t('discordBridge'),
                        successMsg: t('discordSaved'),
                        restartedMsg: `${t('discordSaved')}. ${tx('gatewayRestartedShort', 'Gateway restarted.')}`,
                        overrides: { discordToken: cleaned },
                      });
                    })();
                  }}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                >
                  {t('saveShort')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type={showTokens.server ? 'text' : 'password'}
                  value={serverKey}
                  onChange={(e) => setServerKey(e.target.value)}
                  placeholder={t('serverKeyPlaceholder')}
                  aria-label={t('serverKeyTitle')}
                  className="flex-1 px-3 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowTokens((s) => ({ ...s, server: !s.server }))}
                  aria-pressed={showTokens.server}
                  aria-label={showTokens.server ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="p-2 rounded-xl hm-hit text-slate-500 hover:text-white transition cursor-pointer shrink-0"
                >
                  {showTokens.server ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => {
                    // The server key gates every authenticated call, so it has
                    // to be persisted, pushed to the native prefs and picked up
                    // by a running gateway, not just stored in JS settings.
                    const cleaned = serverKey.trim();
                    void (async () => {
                      const outcome = await commitSettings({ serverKey: cleaned });
                      if (!outcome.ok) {
                        showToast(outcome.error || saveFailedFallback(), 'error');
                        return;
                      }
                      void runApply(activeProviderIdOrNull(), {
                        label: t('serverKeyTitle'),
                        successMsg: t('serverKeySaved'),
                        restartedMsg: `${t('serverKeySaved')}. ${tx('gatewayRestartedShort', 'Gateway restarted.')}`,
                        overrides: { serverKey: cleaned },
                      });
                    })();
                  }}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                >
                  {t('saveShort')}
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleGenerateServerKey}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                >
                  {tx('generate', 'Generate')}
                </button>
                <button
                  type="button"
                  onClick={handleTestServerKey}
                  disabled={!serverKey.trim() || testingAuth}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer disabled:opacity-40"
                >
                  {testingAuth ? tx('testing', 'Testing…') : tx('testAuth', 'Test key')}
                </button>
                {serverKeyWeak && (
                  <span className="text-[11px] text-amber-400">{tx('weakKey', 'Weak key: generate a fresh one.')}</span>
                )}
                {authResult && (
                  <span
                    className={`text-[11px] font-medium ${
                      authOk === true ? 'text-emerald-400' : authOk === false ? 'text-rose-400' : 'text-amber-400'
                    }`}
                  >
                    {authResult}
                  </span>
                )}
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
        subtitle={`${GATEWAY_ADDR}, ${t('stateLabel')}: ${install}`}
        open={openSections.gateway}
        onToggle={() => toggleSection('gateway')}
        id={sectionDomId('gateway')}
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
              onClick={() => {
                void handleStartGateway();
              }}
              disabled={gatewayBusy || !uiFlags.canStart}
              title={!uiFlags.canStart ? tx('startUnavailable', 'Start is unavailable in the current gateway state.') : undefined}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 fill-white" />
              <span>{t('startDaemon')}</span>
            </button>
            <button
              onClick={() => {
                void handleStopGateway();
              }}
              disabled={gatewayBusy || !uiFlags.canStop}
              title={!uiFlags.canStop ? tx('stopUnavailable', 'Stop is unavailable in the current gateway state.') : undefined}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 text-xs font-medium transition cursor-pointer disabled:opacity-50"
            >
              <Square className="w-3.5 h-3.5 fill-slate-300" />
              <span>{t('stopShort')}</span>
            </button>
            {(install === 'NOT_INSTALLED' || install === 'FAILED') && (
              <button
                onClick={() => {
                  void handleInstallGateway();
                }}
                disabled={installing || !uiFlags.isStable}
                className="px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 text-xs font-medium transition cursor-pointer disabled:opacity-50"
              >
                {installing ? tx('installing', 'Installing…') : tx('install', 'Install')}
              </button>
            )}
          </div>
          {!connected && (
            <div className="pt-2">
              <StateNote
                state="offline"
                message={gatewayFailureReason || installError || tx('gatewayStoppedHint', 'Gateway is stopped. Start it to run diagnostics and automations.')}
                onRetry={() => {
                  void handleRefreshStatus();
                }}
              />
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
                saveThenToast({ autostart: next }, next ? t('autostartEnabled') : t('autostartDisabled'), 'success');
              }}
              aria-pressed={!!settings.autostart}
              aria-label={`${t('autostartTitle')}: ${settings.autostart ? t('autostartEnabled') : t('autostartDisabled')}`}
              className={`w-11 h-6 flex items-center rounded-full p-1 cursor-pointer transition-colors ${
                settings.autostart ? 'bg-indigo-600' : 'bg-white/[0.1]'
              }`}
            >
              <div
                className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  settings.autostart ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'
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
        id={sectionDomId('automation')}
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
                <div className="pe-3 min-w-0">
                  <p className="text-xs font-semibold text-white">{sk.name}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{sk.description}</p>
                </div>
                <button
                  onClick={() => handleToggleSkill(sk.id, sk.enabled)}
                  aria-pressed={sk.enabled}
                  aria-label={`${sk.name}: ${sk.enabled ? t('skillEnabled') : t('skillDisabled')}`}
                  className={`w-10 h-5 flex items-center rounded-full p-0.5 cursor-pointer transition-colors shrink-0 ${
                    sk.enabled ? 'bg-indigo-600' : 'bg-white/[0.1]'
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                      sk.enabled ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'
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
        id={sectionDomId('appearance')}
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
                    saveThenToast({ themeMode: mode.id as ThemeMode }, `${t('themeTitle')}: ${mode.label}`, 'success');
                  }}
                  aria-pressed={currentMode === mode.id}
                  aria-label={`${t('themeTitle')}: ${mode.label}`}
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
          <div className="pt-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute start-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={themeSearch}
                onChange={(e) => setThemeSearch(e.target.value)}
                placeholder={themeSearchPlaceholder}
                aria-label={themeSearchPlaceholder}
                className="w-full ps-9 pe-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 placeholder:text-slate-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3">
            {visibleThemes.map((th) => {
              const isSelected = currentTheme === th.id;
              return (
                <button
                  key={th.id}
                  onClick={() => {
                    saveThenToast({ themePalette: th.id }, `${t('appliedPrefix')} ${th.name} ${t('themeWord')}`, 'success');
                  }}
                  aria-pressed={isSelected}
                  aria-label={`${th.name}${isSelected ? ` (${t('active')})` : ''}`}
                  className={`p-3 rounded-2xl border text-start transition-all cursor-pointer flex flex-col justify-between group ${
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
                      className="w-12 h-full border-e border-white/[0.06] shrink-0"
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
          {filteredThemes.length === 0 && (
            <p className="text-[11px] text-slate-500 pt-3">{tx('noThemes', 'No themes match that search.')}</p>
          )}
          {filteredThemes.length > 6 && (
            <button
              onClick={() => setShowAllThemes((v) => !v)}
              aria-expanded={showAllThemes}
              className="mt-2.5 text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer"
            >
              {showAllThemes
                ? tx('showFewerThemes', 'Show fewer themes')
                : tx('showAllThemes', 'Show all {count} themes').replace('{count}', String(filteredThemes.length))}
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
          <div className="pt-2.5">
            <div className="relative">
              <Search className="w-4 h-4 absolute start-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={langSearch}
                onChange={(e) => setLangSearch(e.target.value)}
                placeholder={t('searchLanguages')}
                aria-label={t('searchLanguages')}
                className="w-full ps-9 pe-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 placeholder:text-slate-500 font-sans"
              />
            </div>
          </div>
          <div
            role="listbox"
            aria-label={t('languageTitle')}
            className="divide-y divide-white/[0.04] max-h-64 overflow-y-auto rounded-2xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.06] mt-2.5"
          >
            {filteredLanguages.length === 0 && (
              <p className="text-[11px] text-slate-500 px-4 py-3">{tx('noLanguages', 'No languages match that search.')}</p>
            )}
            {filteredLanguages.map((lang) => {
              const isSelected = (settings.language || 'en') === lang.id;
              return (
                <button
                  key={lang.id}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    saveThenToast({ language: lang.id }, `${t('languageTitle')}: ${lang.name}`, 'success');
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
        id={sectionDomId('advanced')}
      >
        <Row>
          <label className="block text-xs font-medium text-slate-300">{t('reasoningEffort')}</label>
          <div className="grid grid-cols-4 gap-2 pt-2">
            {EFFORT_LEVELS.map(({ id: lvl, label }) => (
              <button
                key={lvl}
                onClick={() => updateSettings({ reasoningEffort: lvl })}
                aria-pressed={settings.reasoningEffort === lvl}
                aria-label={`${t('reasoningEffort')}: ${label}`}
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
                <p className={`text-xs font-medium ${doctorReport.ok ? 'text-emerald-300' : 'text-rose-300'}`}>{doctorReport.summary}</p>
                <div className="space-y-1.5">
                  {doctorReport.checks.map((c, i) => (
                    <div key={i} className="flex items-center gap-2.5 py-2 border-b border-white/[0.04] last:border-0 text-xs">
                      {c.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      )}
                      <span className="text-white font-medium">{c.name}</span>
                      <span className="text-slate-400 ms-auto truncate max-w-[200px]">{c.detail}</span>
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
              {backupResult && (
                <div className="pt-1.5 space-y-0.5">
                  <p className={`text-[11px] font-medium ${backupResult.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {backupResult.message}
                  </p>
                  {backupResult.ok && backupResult.path && (
                    <p className="text-[11px] text-slate-500 font-mono truncate" title={backupResult.path}>
                      {backupResult.path}
                    </p>
                  )}
                </div>
              )}
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
              {debugResult && (
                <div className="pt-1.5 space-y-1">
                  <p className="text-[11px] text-indigo-400">{debugResult.summary}</p>
                  {debugResult.urls.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-[11px] text-indigo-300 underline truncate"
                    >
                      {u}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Row>
      </Section>

      {/* Provider overflow sheet. Rendered as a bottom sheet because the section
          cards clip overflow, and on a phone a sheet keeps every action a full
          44px target. Delete is separated from the primary actions and keeps
          the two-tap confirm flow. */}
      {menuProviderId && (() => {
        const prov = configuredProviders.find((p) => p.id === menuProviderId);
        if (!prov) return null;
        const isActive = settings.activeProviderId
          ? prov.id === settings.activeProviderId
          : prov.provider === settings.provider;
        const armed = pendingDeleteId === prov.id;
        return (
          <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setMenuProviderId(null)}
          >
            <div
              ref={providerMenuRef}
              role="dialog"
              aria-modal="true"
              aria-label={`${tx('profileActions', 'Profile actions')}: ${prov.name}`}
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-md rounded-t-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-3 shadow-2xl space-y-1 pb-[calc(0.75rem+var(--safe-bottom))]"
            >
              <div className="px-3 pt-1 pb-2 border-b border-white/[0.06]">
                <p className="text-xs font-semibold text-white truncate">{prov.name}</p>
                <p className="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                  {prov.defaultModel || t('defaultModelShort')} · {prov.baseUrl ? t('customProxy') : t('officialEndpoint')}
                </p>
              </div>
              {!isActive && (
                <button
                  onClick={() => handleUseProvider(prov)}
                  className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-start text-xs font-semibold text-slate-100 hover:bg-white/[0.06] cursor-pointer transition-colors"
                >
                  <Check className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span>{t('use')}</span>
                </button>
              )}
              <button
                onClick={() => handleEditProvider(prov)}
                className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-start text-xs font-medium text-slate-200 hover:bg-white/[0.06] cursor-pointer transition-colors"
              >
                <Pencil className="w-4 h-4 text-slate-400 shrink-0" />
                <span>{t('edit')}</span>
              </button>
              <button
                onClick={() => {
                  void handleTestProvider(prov);
                }}
                className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-start text-xs font-medium text-slate-200 hover:bg-white/[0.06] cursor-pointer transition-colors"
              >
                <ShieldCheck className="w-4 h-4 text-slate-400 shrink-0" />
                <span>{t('testKey')}</span>
              </button>
              {/* Destructive action, set off by a rule and never adjacent to a
                  primary action. */}
              <div className="pt-1 mt-1 border-t border-white/[0.06]">
                <button
                  onClick={() => handleDeleteFromMenu(prov)}
                  aria-label={`${t('delete')} ${prov.name}`}
                  className={`w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-start text-xs font-semibold cursor-pointer transition-colors ${
                    armed
                      ? 'bg-rose-500/15 text-rose-100 border border-rose-500/40'
                      : 'text-rose-300 hover:bg-rose-500/10'
                  }`}
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  <span>{armed ? tx('confirm', 'Confirm?') : t('delete')}</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Blueprint Launch Modal */}
      {selectedBlueprint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setSelectedBlueprint(null)}
        >
          <div
            ref={blueprintModalRef}
            role="dialog"
            aria-modal="true"
            aria-label={selectedBlueprint.name}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08]">
              <span className="text-sm font-semibold text-white">{selectedBlueprint.name}</span>
              <button
                onClick={() => setSelectedBlueprint(null)}
                aria-label={t('cancel')}
                className="w-11 h-11 flex items-center justify-center rounded-xl text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">{selectedBlueprint.description}</p>
            {selectedBlueprint.parameters && selectedBlueprint.parameters.length > 0 && (
              <div className="space-y-2.5 pt-1">
                {selectedBlueprint.parameters.map((param) => (
                  <div key={param.name}>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{param.label || param.name}</label>
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150"
        >
          <div
            ref={addModalRef}
            role="dialog"
            aria-modal="true"
            aria-label={editingProviderId ? t('editModelProvider') : t('addModelProvider')}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08]">
              <span className="text-sm font-semibold text-white">
                {editingProviderId ? t('editModelProvider') : t('addModelProvider')}
              </span>
              <button
                onClick={closeAddModal}
                aria-label={t('cancel')}
                className="w-11 h-11 flex items-center justify-center rounded-xl text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">{t('modelCatalog')}</label>
                <select
                  value={newProvType}
                  autoFocus
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
                    aria-label={t('apiKey')}
                    className="w-full px-3.5 py-2.5 pe-10 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewKey(!showNewKey)}
                    aria-pressed={showNewKey}
                    aria-label={showNewKey ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                    className="absolute end-2 top-1/2 -translate-y-1/2 p-2.5 rounded-xl hm-hit text-slate-500 hover:text-white cursor-pointer"
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
            {!editingProviderId && (
              <label className="flex items-start gap-2.5 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activateNewProvider}
                  onChange={(e) => setActivateNewProvider(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded accent-indigo-600"
                />
                <span className="text-[11px] text-slate-400">
                  {tx('activateAfterSave', 'Activate this profile after saving. New profiles stay inactive unless you opt in.')}
                </span>
              </label>
            )}
            <div className="flex justify-end gap-2.5 pt-3 border-t border-white/[0.06]">
              <button
                onClick={closeAddModal}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                disabled={!keysValid(newProvType, newProvKey, newProvBaseUrl) || applyingProvider}
                onClick={async () => {
                  // Busy guard: a second tap must not start a second restart.
                  if (applyBusyRef.current) {
                    showToast(tx('applyBusy', 'A provider change is already being applied. Wait for it to finish.'), 'info');
                    return;
                  }
                  const cleanedKey = newProvKey.trim();
                  const baseUrl = newProvBaseUrl.trim();
                  const targetModel = newProvModel.trim() || DEFAULT_MODELS[newProvType]?.[0] || `${newProvType}/default`;
                  const label = newProvName.trim() || PROVIDER_OPTIONS.find(([id]) => id === newProvType)?.[1] || newProvType;
                  const existing = editingProviderId
                    ? configuredProviders.find((p) => p.id === editingProviderId)
                    : undefined;
                  // Validated only when the whole tuple that was actually
                  // tested (provider, base URL, key) is the one being saved, so
                  // editing the Base URL after a pass drops the flag.
                  const fingerprint = validationFingerprint({ provider: newProvType, apiKey: cleanedKey, baseUrl });
                  const existingFingerprint = existing
                    ? validationFingerprint({ provider: existing.provider, apiKey: existing.apiKey || '', baseUrl: existing.baseUrl || '' })
                    : '';
                  const freshlyValidated = !!fingerprint && testedFingerprint === fingerprint && keyOk === true;
                  const keptValidated = !!existing?.validated && !!existingFingerprint && existingFingerprint === fingerprint;
                  const validated = freshlyValidated || keptValidated;
                  const isCurrentlyActive = !!existing && (settings.activeProviderId
                    ? existing.id === settings.activeProviderId
                    : existing.provider === settings.provider);
                  // The profile exactly as it is about to be written. The apply
                  // below needs these values, but configuredProviders is a
                  // render-scope list that will not contain them yet.
                  const applyProfile: ConfiguredProvider = {
                    id: editingProviderId || '',
                    provider: newProvType,
                    name: label,
                    [PROVIDER_CREDENTIAL_FIELD]: cleanedKey,
                    baseUrl,
                    defaultModel: targetModel,
                    enabled: existing?.enabled !== false,
                    validated,
                  };

                  // Close the sheet before any await: the apply below can poll
                  // a restart for minutes and must never trap the modal behind
                  // an enabled Save button.
                  closeAddModal();

                  if (editingProviderId) {
                    const editId = editingProviderId;
                    const outcome = await runVerifiedWrite(async () => {
                      const before = saveErrorRef.current;
                      updateConfiguredProvider(editId, {
                        provider: newProvType,
                        name: label,
                        [PROVIDER_CREDENTIAL_FIELD]: cleanedKey,
                        baseUrl,
                        defaultModel: targetModel,
                        validated,
                      });
                      if (isCurrentlyActive) {
                        updateSettings({
                          provider: newProvType,
                          [PROVIDER_CREDENTIAL_FIELD]: cleanedKey,
                          baseUrl,
                          modelId: targetModel,
                        });
                      }
                      return awaitSaveOutcome(before);
                    });
                    if (!outcome.ok) {
                      showToast(outcome.error || saveFailedFallback(), 'error');
                      return;
                    }
                    await runApply(isCurrentlyActive ? editId : undefined, {
                      label,
                      profile: applyProfile,
                      successMsg: `${t('updatedItem')} ${label}`,
                      restartedMsg: `${t('updatedItem')} ${label}. ${tx('gatewayRestartedShort', 'Gateway restarted.')}`,
                    });
                    return;
                  }

                  let createdId: string | null = null;
                  const outcome = await runVerifiedWrite(async () => {
                    const before = saveErrorRef.current;
                    if (createdId === null) {
                      createdId = addConfiguredProvider({
                        provider: newProvType,
                        name: label,
                        [PROVIDER_CREDENTIAL_FIELD]: cleanedKey,
                        baseUrl,
                        defaultModel: targetModel,
                        enabled: true,
                        validated,
                      });
                    }
                    // New profiles stay inactive unless the user explicitly
                    // opted in via the activation checkbox. No silent switch.
                    if (activateNewProvider) activateProvider(createdId);
                    else updateSettings({});
                    return awaitSaveOutcome(before);
                  });
                  if (!outcome.ok) {
                    showToast(outcome.error || saveFailedFallback(), 'error');
                    return;
                  }
                  if (activateNewProvider && createdId) {
                    await runApply(createdId, {
                      label,
                      // The apply must see the just-added profile; the render
                      // scope list does not contain it yet.
                      profile: {
                        id: createdId,
                        provider: newProvType,
                        name: label,
                        [PROVIDER_CREDENTIAL_FIELD]: cleanedKey,
                        baseUrl,
                        defaultModel: targetModel,
                        enabled: true,
                        validated,
                      },
                      successMsg: `${t('addedActivated')} ${label}`,
                      restartedMsg: `${t('addedActivated')} ${label}. ${tx('gatewayRestartedShort', 'Gateway restarted.')}`,
                    });
                  } else {
                    showToast(`${tx('addedInactive', 'Added (inactive)')} ${label}`, 'success');
                  }
                }}
                className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold shadow-xs cursor-pointer transition"
              >
                {applyingProvider ? tx('applyingShort', 'Applying…') : editingProviderId ? t('save') : t('saveEnable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
