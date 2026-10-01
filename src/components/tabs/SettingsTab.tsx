import React, { useState, useEffect, useRef } from 'react';
import { CapacitorHttp } from '@capacitor/core';
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
  Bell,
  BellOff,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  normProvider,
  providerLabel,
  DEFAULT_MODELS,
  keysValid,
  KEYLESS_PROVIDERS,
  PROVIDER_DEFAULT_BASE_URL,
} from '../../constants/providers';
import { THEME_PALETTES, ThemeMode } from '../../constants/themes';
import { LANGUAGES } from '../../constants/languages';
import { toAppError, localizedMessage } from '../../services/appErrors';
import {
  isNativeGateway,
  nativeHealth,
  nativeNotifGranted,
  nativeRequestNotifAlerts,
  nativeSetProvider,
  nativeSetServerKey,
  nativeStatus,
} from '../../services/nativeGateway';
import { deriveUiFlags, type GatewayState } from '../../services/gatewayState';
import { validationFingerprint } from '../../services/providerValidation';
import { plainGatewayFailure, plainResultLine } from '../../services/plainFailure';
import { assertNoPlaintextSecrets } from '../../services/debugSafety';
import { runRedactionSelfTests } from '../../services/redaction';
import { AutoApproveGate } from '../approvals/AutoApproveGate';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import {
  APPROVAL_SCOPES,
  DEFAULT_AUTO_APPROVE_POLICY,
  isApprovalScope,
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

// One badge for every chip in this file. Tone maps onto the shared .pill-* set
// so status reads identically in a section header, a row and a sheet, and
// 'neutral' stays reserved for Off, Disabled and unknown values.
type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

const Badge: React.FC<{
  tone: BadgeTone;
  children: React.ReactNode;
  icon?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}> = ({ tone, children, icon, ariaLabel, className = '' }) => (
  <span
    aria-label={ariaLabel}
    className={`pill-${tone} ${className}`}
  >
    {icon}
    {children}
  </span>
);

// Risk is domain vocabulary, not a colour: high and medium are the two levels
// that need review, low is informational and off is the neutral resting state.
const riskTone = (level: RiskLevel): BadgeTone =>
  level === 'high' ? 'danger' : level === 'medium' ? 'warning' : level === 'low' ? 'info' : 'neutral';

const riskIcon = (level: RiskLevel) =>
  level === 'off' ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />;

// One boolean control for the whole file: Auto-start and every skill toggle.
const Switch: React.FC<{ checked: boolean; onChange: () => void; ariaLabel: string; disabled?: boolean }> = ({
  checked,
  onChange,
  ariaLabel,
  disabled,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={disabled ? undefined : onChange}
    className={`hm-hit w-11 h-6 shrink-0 flex items-center r-full p-1 transition-colors ${
      disabled ? 'opacity-50 cursor-not-allowed ' : 'cursor-pointer '
    }${checked ? 'bg-[var(--app-accent)]' : 'bg-[var(--app-card-hover)]'}`}
  >
    <span
      className={`block bg-[var(--app-text)] w-4 h-4 r-full transition-transform ${
        checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'
      }`}
    />
  </button>
);

// One enumeration control for the whole file: approval scope, theme mode and
// reasoning effort all render as the same segmented strip.
const Segmented: React.FC<{
  groupLabel: string;
  options: Array<{ id: string; label: string; icon?: React.ComponentType<{ className?: string }> }>;
  value: string;
  onSelect: (id: string, label: string) => void;
  pendingId?: string | null;
  stretch?: boolean;
  className?: string;
}> = ({ groupLabel, options, value, onSelect, pendingId = null, stretch = false, className = '' }) => (
  <div
    role="group"
    aria-label={groupLabel}
    className={`flex items-center gap-1 p-1 r-sm bg-[var(--app-card-subtle)] edge ${
      stretch ? 'w-full' : 'shrink-0'
    } ${className}`}
  >
    {options.map((opt) => {
      const selected = value === opt.id;
      const Icon = opt.icon;
      return (
        <button
          key={opt.id}
          type="button"
          onClick={() => onSelect(opt.id, opt.label)}
          aria-pressed={selected}
          aria-label={`${groupLabel}: ${opt.label}`}
          className={`hm-hit flex items-center justify-center gap-2 px-3 py-2 min-h-[36px] r-xs t-label font-medium transition-colors cursor-pointer ${
            stretch ? 'flex-1' : ''
          } ${
            selected
              ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] font-semibold'
              : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
          } ${pendingId === opt.id ? 'ring-1 ring-[var(--app-warning)]' : ''}`}
        >
          {Icon ? <Icon className="w-3.5 h-3.5 shrink-0" /> : null}
          <span>{opt.label}</span>
        </button>
      );
    })}
  </div>
);

type DataState = 'loading' | 'empty' | 'offline' | 'error' | 'stale' | 'refreshing' | 'ready';

const StateNote: React.FC<{
  state: DataState;
  message: string;
  // Optional raw text (installer output, HTTP status). It renders as the mono
  // line under the plain sentence, never as the sentence itself.
  detail?: string;
  onRetry?: () => void;
  // Verb for the action button. A note that says "Start it" has to offer a
  // Start button, so callers pass the label that matches what pressing it
  // actually does; anything else keeps the plain Retry label.
  actionLabel?: string;
}> = ({ state, message, detail, onRetry, actionLabel }) => {
  const { t } = useHermes();
  // Same degrade rule as the tab: a missing key renders the English fallback.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
  if (state === 'ready') return null;
  const styles: Record<DataState, string> = {
    loading: 't-caption text-[var(--app-text-muted)] edge',
    empty: 't-caption text-[var(--app-text-dim)] edge',
    offline: 't-caption text-[var(--app-danger)] border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)]',
    error: 't-caption text-[var(--app-danger)] border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)]',
    stale: 't-caption text-[var(--app-warning)] border border-[var(--app-warning-border)] bg-[var(--app-warning-subtle)]',
    refreshing: 't-caption text-[var(--app-accent-text)] border border-[var(--app-border)] bg-[var(--app-accent-subtle)]',
    ready: '',
  };
  return (
    <div
      className={`flex items-center gap-2 p-4 r-sm border ${styles[state]}`}
      role={state === 'error' || state === 'offline' ? 'alert' : 'status'}
    >
      {state === 'offline' ? (
        <WifiOff className="w-3.5 h-3.5 shrink-0" />
      ) : state === 'refreshing' || state === 'loading' ? (
        <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${state === 'refreshing' ? 'animate-spin' : 'animate-pulse'}`} />
      ) : state === 'error' ? (
        <XCircle className="w-3.5 h-3.5 shrink-0" />
      ) : (
        <Wifi className="w-3.5 h-3.5 shrink-0 opacity-60" />
      )}
      <span className="flex-1">
        {message}
        {detail && (
          <span className="block t-micro normal-case font-mono text-[var(--app-text-dim)] break-words mt-1">
            {detail}
          </span>
        )}
      </span>
      {onRetry && (state === 'error' || state === 'offline') && (
        <button onClick={onRetry} className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm t-label text-[var(--app-accent-text)] hover:text-[var(--app-text)] cursor-pointer shrink-0">
          {actionLabel || tx('retryLabel', 'Retry')}
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
    className="scroll-mt-4 r-md elev-0 bg-[var(--app-card)] edge overflow-hidden"
  >
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="w-full px-5 py-4 flex items-center gap-3 text-start cursor-pointer hover:bg-[var(--app-card-hover)] transition"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="t-heading text-[var(--app-text)] tracking-tight">{title}</h3>
          {badge}
        </div>
        <p className="t-caption text-[var(--app-text-muted)] mt-1 break-words">{subtitle}</p>
      </div>
      <ChevronDown className={`w-4 h-4 text-[var(--app-text-muted)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="px-5 pb-5 pt-1 divide-y divide-[var(--app-border-subtle)]">{children}</div>}
  </section>
);

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="py-3 first:pt-1 last:pb-1">{children}</div>
);

// R1: alert permission row. Reads the live grant state from the bridge (web
// builds have no bridge: the row hides itself). The button re-asks; a hard
// denial can only be flipped in system settings.
const NotificationRow: React.FC = () => {
  const { t } = useHermes();
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
  const [granted, setGranted] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!isNativeGateway()) return;
    void nativeNotifGranted().then((g) => {
      if (g !== null) setGranted(g);
    });
  }, []);
  if (!isNativeGateway()) return null;
  const Icon = granted ? Bell : BellOff;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <Icon className="w-4 h-4 mt-1 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
        <div className="min-w-0">
          <p className="t-body text-[var(--app-text)]">
            {tx('notifAlertsTitle', 'Approval and job alerts')}
          </p>
          <p className="t-caption text-[var(--app-text-muted)]">
            {granted === null
              ? tx('notifAlertsChecking', 'Checking notification permission.')
              : granted
                ? tx('notifAlertsOn', 'On: approvals reach you even with the app closed.')
                : tx('notifAlertsOff', 'Off: approvals wait silently in Chat. Allow them to get alerts.')}
          </p>
        </div>
      </div>
      {granted === false && (
        <button
          type="button"
          disabled={asking}
          onClick={() => {
            setAsking(true);
            void nativeRequestNotifAlerts()
              .then(() => nativeNotifGranted())
              .then((g) => {
                if (g !== null) setGranted(g);
              })
              .finally(() => setAsking(false));
          }}
          className="hm-hit min-h-[36px] px-4 shrink-0 r-sm t-caption font-medium bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] hover:bg-[var(--app-card-hover)] cursor-pointer disabled:opacity-50"
        >
          {tx('notifAllowAction', 'Allow')}
        </button>
      )}
    </div>
  );
};

// Turn a machine key into words a person reads: 'repo_url' -> 'Repo url'. The
// raw key stays visible as the mono detail line under the field.
const humanizeKey = (key: string): string =>
  key
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

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
    refreshModels,
    ensureServerKey,
    install,
    installProgress,
    installError,
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
    service,
    approvals,
    jobs,
    skills: ctxSkills,
    setSkills: ctxSetSkills,
    blueprints: ctxBlueprints,
    memory: ctxMemory,
    setMemory: ctxSetMemory,
    lockNow,
    unlockSecrets,
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
  const [newProvType, setNewProvType] = useState('');
  const [newProvName, setNewProvName] = useState('');
  const [newProvKey, setNewProvKey] = useState('');
  const [newProvBaseUrl, setNewProvBaseUrl] = useState('');
  const [newProvModel, setNewProvModel] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  // Explicit custom-model mode for the model picker: the text input used to
  // be derived from !testedModels.includes(model), so typing a prefix of a
  // listed model unmounted the field mid-keystroke and stole focus.
  const [customModelMode, setCustomModelMode] = useState(false);
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
    setTestedModels([]);
    setKeyResult(null);
    setKeyOk(null);
    setShowNewKey(false);
    setActivateNewProvider(false);
    setCustomModelMode(false);
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
    const saveBefore = saveSnapshot();
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
      restartedMsg: `${tx('removedItem', 'Removed')} ${prov.name}. ${tx('serverRestartedShort', 'Hermes restarted.')}`,
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
  // Live model ids returned by the last successful key test, so the default
  // model can be picked from a list instead of typed by hand.
  const [testedModels, setTestedModels] = useState<string[]>([]);

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

  // Machine and platform reasons are logs, not sentences, so they are mapped
  // to plain copy by the shared mapper (services/plainFailure). Settings and
  // Home use the same rules, which is why a bare token such as
  // "service_start_blocked" can never render here.

  // Disabling App Lock keeps the two-tap confirm, but the second tap only
  // arms the PIN prompt: appLockEnabled flips to false once the current PIN
  // verifies. appLockDesc promises PIN unlock, so a bare second tap would
  // drop that promise on the way out.
  const [pendingDisableLock, setPendingDisableLock] = useState(false);
  const disableLockTimer = useRef<number | null>(null);
  const [disablePinPrompt, setDisablePinPrompt] = useState(false);
  const [disablePin, setDisablePin] = useState('');
  const [showDisablePin, setShowDisablePin] = useState(false);
  const [disablePinBusy, setDisablePinBusy] = useState(false);
  const [disablePinError, setDisablePinError] = useState<string | null>(null);

  const closeDisablePinPrompt = () => {
    if (disableLockTimer.current !== null) window.clearTimeout(disableLockTimer.current);
    setPendingDisableLock(false);
    setDisablePinPrompt(false);
    setDisablePin('');
    setShowDisablePin(false);
    setDisablePinError(null);
    setDisablePinBusy(false);
  };

  // Same acceptance rule the lock screen uses: a vault is checked through
  // unlockSecrets, a legacy no-vault setup compares the stored PIN. The flag
  // only moves after that check passes.
  const confirmDisableLock = () => {
    if (disablePinBusy || !disablePin) return;
    const throttle = readPinThrottle();
    const now = Date.now();
    if (now < throttle.until) {
      const secs = Math.ceil((throttle.until - now) / 1000);
      setDisablePinError(`${tx('tooManyAttempts', 'Too many wrong attempts. Try again in')} ${secs}s.`);
      return;
    }
    const attempted = disablePin;
    setDisablePin('');
    setDisablePinBusy(true);
    setDisablePinError(null);
    const done = (accepted: boolean) => {
      setDisablePinBusy(false);
      if (!accepted) {
        const fails = readPinThrottle().fails + 1;
        writePinThrottle(fails, fails >= 5 ? Date.now() + 60000 : 0);
        setDisablePinError(
          fails >= 5
            ? `${tx('tooManyAttempts', 'Too many wrong attempts. Try again in')} 60s.`
            : tx('incorrectPin', 'Incorrect PIN.')
        );
        return;
      }
      writePinThrottle(0, 0);
      closeDisablePinPrompt();
      setShowPinForm(false);
      saveThenToast({ appLockEnabled: false }, `${appLockTitle}: ${t('disabled')}`, 'success');
    };
    let hasVault = false;
    try {
      hasVault = !!localStorage.getItem('hermes_vault');
    } catch {
      /* storage unavailable: fall back to the stored-PIN comparison */
    }
    if (hasVault) {
      unlockSecrets(attempted)
        .then((accepted) => done(accepted === true))
        .catch(() => done(false));
    } else {
      done(attempted === settings.appLockPin);
    }
  };
  // App lock PIN setup state
  const [showPinForm, setShowPinForm] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const validatePin = (pin: string): string | null => {
    if (!/^\d{6,8}$/.test(pin)) return tx('pinLength', 'PIN must be 6 to 8 digits.');
    if (COMMON_PINS.has(pin) || /^(\d)\1+$/.test(pin))
      return tx('pinRepeated', 'Repeated-digit PINs are not allowed. Choose a different one.');
    if (hasSequentialRun(pin)) return tx('pinCommon', 'That PIN is too common. Choose a different one.');
    return null;
  };

  // Locale bundles may still carry a stale "4-Digit" title while the
  // validator accepts 4-8 digits. languages.ts is owned elsewhere, so the
  // title is used as-is and the range note below carries the truth.
  const appLockTitle = tx('appLock', 'App Lock PIN');

  // Machine install and gateway states rendered as words a person reads. The
  // raw value stays in the logs and in the details disclosure.
  const installStateLabel = (state: string): string => {
    switch (state) {
      case 'NOT_INSTALLED':
        return tx('setupStateNotInstalled', 'Not set up');
      case 'INSTALLING':
        return tx('setupStateInstalling', 'Setting up');
      case 'INSTALLED':
        return tx('setupStateInstalled', 'Set up');
      case 'RUNNING':
        return tx('setupStateRunning', 'Running');
      case 'FAILED':
        return tx('setupStateFailed', 'Setup failed');
      case 'STOPPED':
        return tx('setupStateStopped', 'Stopped');
      default:
        return tx('setupStateUnknown', 'Unknown');
    }
  };

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
  const [skills, setSkills] = useState<SkillInfo[]>(() => ctxSkills || []);
  const [skillsState, setSkillsState] = useState<DataState>(() => (ctxSkills && ctxSkills.length > 0 ? 'ready' : 'loading'));
  // Neutral-case note: when the on-device server answers 500 the list is
  // empty-but-live with a reason. The note renders inside the modal and the
  // View button drops its ratio until a real catalog confirms it.
  const [skillsNote, setSkillsNote] = useState<string>('');
  // Same honest-reason pattern as skills: a dead blueprints route must not
  // present as "no routines".
  const [blueprintsNote, setBlueprintsNote] = useState<string>('');
  // Dead-switch latches: when the gateway is up but a toggle route is
  // absent (guaranteed failure), the switch disables with a plain reason
  // instead of inviting another doomed tap. A later success clears it.
  const [skillToggleDead, setSkillToggleDead] = useState<boolean>(false);
  const [memoryToggleDead, setMemoryToggleDead] = useState<boolean>(false);
  const [memory, setMemory] = useState<MemoryInfo | null>(() => ctxMemory || null);
  const [memoryState, setMemoryState] = useState<DataState>(() => (ctxMemory ? 'ready' : 'loading'));
  const [blueprints, setBlueprints] = useState<Blueprint[]>(() => ctxBlueprints || []);
  const [blueprintsState, setBlueprintsState] = useState<DataState>(() => (ctxBlueprints && ctxBlueprints.length > 0 ? 'ready' : 'loading'));
  const [selectedBlueprint, setSelectedBlueprint] = useState<Blueprint | null>(null);
  const [showSkillsModal, setShowSkillsModal] = useState(false);
  const [blueprintSlots, setBlueprintSlots] = useState<Record<string, string>>({});
  const [memoryToggling, setMemoryToggling] = useState(false);

  useEffect(() => {
    if (ctxSkills && ctxSkills.length > 0) {
      setSkills(ctxSkills);
      setSkillsState('ready');
    }
  }, [ctxSkills]);

  useEffect(() => {
    if (ctxMemory) {
      setMemory(ctxMemory);
      setMemoryState('ready');
    }
  }, [ctxMemory]);

  useEffect(() => {
    if (ctxBlueprints && ctxBlueprints.length > 0) {
      setBlueprints(ctxBlueprints);
      setBlueprintsState('ready');
    }
  }, [ctxBlueprints]);

  // Gateway status summary entry point (UX-05): always visible, tap for details
  const [showGatewayDetails, setShowGatewayDetails] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  // Serialises start/stop/install taps so double-taps cannot overlap runs.
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [installing, setInstalling] = useState(false);

  // Home's "Check connection" action flags this tab to open the disclosure
  // it is about to jump into. The key is read once and cleared here, so one
  // tap never leaves the panel stuck open later.
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem('hm:showGatewayDetails') !== '1') return;
      window.sessionStorage.removeItem('hm:showGatewayDetails');
      setShowGatewayDetails(true);
    } catch {
      /* storage unavailable: the disclosure simply stays collapsed */
    }
  }, []);

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
    settings.autoApprovePolicy ?? DEFAULT_AUTO_APPROVE_POLICY
  );

  const writeAutoApprovePolicy = (policy: AutoApprovePolicy) => {
    const patch = {
      autoApprovePolicy: policy,
      autoApproveGlobal: policy.enabled,
    };
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
      setAuthResult(outcome.error || tx('settingsSaveFailedPlain', 'Your change was not saved. Your earlier settings are still in effect. Tap Retry to try again.'));
      return;
    }
    setAuthResult(tx('serverKeyApplyingPlain', 'Key saved. Applying it to the connection before testing…'));
    // 2. Mirror the key + active profile into the native prefs and restart a
    // running on-device gateway, otherwise the gateway keeps the old key and
    // every authenticated call answers 401.
    const applied = await applyProviderConfig(activeProviderIdOrNull(), {
      overrides: { serverKey: cleaned },
    });
    if (!alive()) return;
    if (!applied.ok) {
      setAuthOk(false);
      setAuthResult(applied.error || tx('applyFailedPlain', 'The change was saved, but Hermes did not pick it up. Restart Hermes, then try again.'));
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
        setAuthResult(tx('serverKeyAcceptedPlain', 'The key works. Hermes answered an authenticated call.'));
      } else if (http && (http[1] === '401' || http[1] === '403')) {
        setAuthOk(false);
        setAuthResult(
          tx('serverKeyRejectedPlain', 'Hermes rejected this key, so authenticated calls will fail. Generate a new key, then test again.').replace(
            '{status}',
            http[1]
          )
        );
      } else {
        setAuthOk(null);
        setAuthResult(tx('keyUnreachablePlain', 'Hermes did not answer, so the key was not tested. Start Hermes, then test again.'));
      }
    } catch {
      if (!alive()) return;
      setAuthOk(null);
      setAuthResult(tx('keyUnreachablePlain', 'Hermes did not answer, so the key was not tested. Start Hermes, then test again.'));
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
      showToast(ok ? t('gatewayStarted') : tx('startFailedPlain', 'Could not start Hermes. Try again.'), ok ? 'success' : 'error');
    } catch (e) {
      showToast(localizedMessage(toAppError(e), settings.language || 'en'), 'error');
    } finally {
      setGatewayBusy(false);
    }
  };

  const handleStopGateway = async () => {
    if (gatewayBusy) return;
    if (!connected) {
      showToast(tx('alreadyStoppedPlain', 'Hermes is already stopped.'));
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
          : tx('stopNotVerifiedPlain', 'Stop was sent, but Hermes still answers, so it may still be running.'),
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
        showToast(tx('installFailedPlain', 'Setup failed. Nothing that was already on your phone was changed. Press Retry to try again.'), 'error');
      } else if (settled === 'INSTALLED' || settled === 'RUNNING') {
        showToast(tx('installFinishedPlain', 'Setup finished. Check the status above.'), 'success');
      } else {
        showToast(
          tx('installUnconfirmedPlain', 'Setup stopped reporting progress and Hermes is not running. Check the status above, then start it again.'),
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
  const skillsModalRef = useOverlayBehavior(showSkillsModal, () => setShowSkillsModal(false));

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
  const themeSearchPlaceholder = tx('searchThemesPlain', 'Search themes…');

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
  // One number that always moves once per attempt: the context bumps it when
  // a persist attempt finishes, so a caller can tell "my write has completed"
  // from "the screen still holds the previous attempt".
  const saveRevisionRef = useRef<number>(0);
  saveRevisionRef.current = (ctx as unknown as { settingsSaveRevision?: number }).settingsSaveRevision ?? 0;
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

  const saveFailedFallback = () =>
    tx('settingsSaveFailedPlain', 'Your change was not saved. Your earlier settings are still in effect. Tap Retry to try again.');

  // A pre-write snapshot of every surface that carries a save verdict. Taken
  // before updateSettings is called, so anything still equal to it when the
  // poll runs belongs to an earlier attempt.
  type SaveSnapshot = {
    error: string | null;
    state: string | undefined;
    revision: number;
    // False when the context ships no revision counter: then there is nothing
    // to count and the error text plus the state stay the only observables.
    countsRevisions: boolean;
  };
  const saveSnapshot = (): SaveSnapshot => ({
    error: saveErrorRef.current,
    state: saveStateRef.current,
    revision: saveRevisionRef.current,
    countsRevisions:
      (ctx as unknown as { settingsSaveRevision?: number }).settingsSaveRevision !== undefined,
  });

  // Resolves once the provider confirmed or rejected the write it was handed.
  // Two guarantees, both kept: (1) one failure left on screen by an earlier
  // attempt must not poison this save, so 'error' is only trusted once the
  // state, the error text or the revision moved away from the snapshot; and
  // (2) a fast genuine failure must not report ok:true, so no early return
  // happens before that movement, and a save that never moves still hits the
  // 20s bound and reports "did not confirm".
  // A third case sits between them: a save already mid-flight when this one
  // was queued finishes first and its verdict is not this write's, so while
  // the snapshot says 'saving' one extra revision bump is owed before any
  // 'saved' or 'error' may be read as this attempt's.
  const awaitSaveOutcome = async (before: SaveSnapshot): Promise<WriteOutcome> => {
    const started = Date.now();
    const owed = before.countsRevisions && before.state === 'saving' ? 2 : 1;
    let bumps = 0;
    let seenRevision = before.revision;
    for (;;) {
      const err = saveErrorRef.current;
      const state = saveStateRef.current;
      const revision = saveRevisionRef.current;
      if (revision !== seenRevision) {
        bumps += Math.max(1, revision - seenRevision);
        seenRevision = revision;
      }
      const moved = state !== before.state || err !== before.error || bumps > 0;
      // 'ready': enough of this write has landed for what follows to be its
      // own verdict instead of the previous attempt's.
      const ready = before.countsRevisions ? bumps >= owed : moved;
      if (ready) {
        // A brand-new failure text after the snapshot is this write's verdict
        // even when the tab has no save-state machine to say so.
        if (err && err !== before.error) return { ok: false, error: err };
        if (state === 'error') return { ok: false, error: err || saveFailedFallback() };
        if (state === 'saved') return { ok: true, error: null };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= SAVE_MAX_WAIT_MS) {
        return {
          ok: false,
          error: tx('settingsSaveUnconfirmedPlain', 'The save did not confirm in time, so the change may not be in effect. Tap Retry to try again.'),
        };
      }
      // Only a context that ships no save-state machine (state stays
      // undefined) may settle on the timer alone; a machine that has not
      // moved yet is still holding this write, so it keeps waiting. Without
      // a state machine the settle also waits for the revision bump, so a
      // slow write is never declared saved before it finished.
      if (
        state !== 'saving' &&
        state !== 'error' &&
        state !== 'saved' &&
        elapsed >= (state ? SAVE_SETTLE_STATE_MS : SAVE_SETTLE_LEGACY_MS) &&
        (!before.countsRevisions || ready)
      ) {
        return { ok: true, error: null };
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
    const before = saveSnapshot();
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
    // Profile identity for the native converge logic: a blank apiKey on the
    // wire means 'unknown', and only with the profile id can native restore
    // that profile's stored key (or clear a previous profile's key instead
    // of leaking it into the new profile's session).
    activeProfileId?: string;
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
      return {
        ok: false,
        error: plainResultLine(
          e instanceof Error ? e.message : String(e),
          saveFailedFallback(),
          tx
        ),
      };
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
          ...(profileId ? { activeProfileId: profileId } : {}),
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
          error: mirror.error || tx('nativeMirrorFailedPlain', 'The on-device settings could not be updated, so nothing was applied.'),
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
          error: ack.error || tx('nativeServerKeyFailedPlain', 'The on-device server key could not be updated, so nothing was applied.'),
        };
      }
    }

    // Only a running gateway needs a restart; a stopped one reads the mirrored
    // prefs on its next start.
    if (!isNativeGateway() || !connected) return { ok: true, restarted: false, error: null };
    // The gateway reads provider, key, base URL, and bot tokens once at
    // process start, but the model travels with each chat turn. Restart only
    // when a connection value actually changed; a model-only edit applies
    // with a mirror and takes effect on the next message, no ~100s restart.
    const connChanged =
      (prefs.provider || '') !== (settings.provider || '') ||
      (prefs.apiKey || '') !== (settings.apiKey || '') ||
      (prefs.baseUrl || '') !== (settings.baseUrl || '') ||
      (prefs.serverKey || '') !== (settings.serverKey || '') ||
      (prefs.tgToken || '') !== (settings.tgToken || '') ||
      (prefs.discordToken || '') !== (settings.discordToken || '') ||
      // Profile identity: two profiles can look identical from render scope
      // (blank keys when the vault is locked) while holding different stored
      // keys natively. A switch to another profile always restarts, so the
      // gateway can never keep the previous profile's runtime key.
      (profileId != null && profileId !== (settings.activeProviderId || undefined) && profileId !== '');
    if (!connChanged) return { ok: true, restarted: false, error: null };
    try {
      await stopGateway();
      await startGateway();
    } catch (e) {
      return {
        ok: false,
        restarted: false,
        error: plainResultLine(
          e instanceof Error ? e.message : String(e),
          saveFailedFallback(),
          tx
        ),
      };
    }
    const up = await verifyGatewayUp();
    return up
      ? { ok: true, restarted: true, error: null }
      : {
          ok: false,
          restarted: false,
          error: tx('applyFailedPlain', 'The change was saved, but Hermes did not pick it up. Restart Hermes, then try again.'),
        };
  };

  const activeProviderIdOrNull = (): string | null => settings.activeProviderId || null;

  type ApplyOptions = {
    label: string;
    successMsg: string;
    restartedMsg?: string;
    // settingsSaveError snapshot taken before an earlier write in the same
    // click, so the apply never runs on top of a failed save.
    before?: SaveSnapshot;
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
    setApplyStatus(`${tx('applyingProviderPlain', 'Applying the change')}: ${opts.label}…`);
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
        void refreshModels();
      } else {
        setLocalSaveError(res.error);
        showToast(res.error || tx('applyFailedPlain', 'The change was saved, but Hermes did not pick it up. Restart Hermes, then try again.'), 'error');
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
    const before = saveSnapshot();
    activateProvider(prov.id);
    void runApply(prov.id, {
      label: prov.name,
      before,
      successMsg: `${t('switchedTo')} ${prov.name}`,
      restartedMsg: `${t('switchedTo')} ${prov.name}. ${tx('serverRestartedShort', 'Hermes restarted.')}`,
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
    setTestedModels([]);
    setShowNewKey(false);
    setActivateNewProvider(false);
    setCustomModelMode(false);
    setShowAddModal(true);
  };

  // Test an existing profile from the overflow sheet: run the same validation
  // the modal uses, and persist the validated flag only on a real pass so the
  // "Untested" chip cannot be cleared by a guess.
  const handleTestProvider = async (prov: ConfiguredProvider) => {
    setMenuProviderId(null);
    const cleaned = (prov.apiKey || '').trim();
    // Keyless local providers are tested by reachability, not by key.
    if (!cleaned && !KEYLESS_PROVIDERS.has(normProvider(prov.provider))) {
      showToast(`${prov.name}: ${t('keyRequired')}`, 'error');
      return;
    }
    showToast(`${t('testing')} ${prov.name}`, 'info');
    let valid: boolean | null = null;
    try {
      valid = await service.providersValidate(normProvider(prov.provider), 'HERMES_API_KEY', cleaned, prov.baseUrl || '');
    } catch {
      valid = null;
    }
    if (valid === true) {
      if (!prov.validated) {
        void runVerifiedWrite(async () => {
          const before = saveSnapshot();
          updateConfiguredProvider(prov.id, { validated: true });
          return awaitSaveOutcome(before);
        });
      }
      showToast(`${prov.name}: ${tx('keyValidPlain', 'This key works.')}`, 'success');
    } else if (valid === false) {
      showToast(`${prov.name}: ${tx('keyInvalidPlain', 'The provider refused this key.')}`, 'error');
    } else {
      showToast(`${prov.name}: ${tx('keyUnreachablePlain', 'Hermes did not answer, so the key was not tested. Start Hermes, then test again.')}`, 'info');
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

  // One status fact for the gateway card, the section badge and the details
  // row: reachable AND not rejected. Reading `connected` alone would paint
  // green Running while the key is refused, so every gateway surface below
  // uses this helper (same rule the header and Home use). Text carries the
  // state as well as colour, so a chip is never colour alone.
  const gatewayHealthy = connected && !gatewayFailed && !gatewayFailureKind;
  const gatewayFailing = gatewayFailed === true || !!gatewayFailureKind;
  const gatewayStatusText = gatewayHealthy
    ? tx('running', 'Running')
    : gatewayFailing
      ? gatewayFailureKind === 'unauthorized'
        ? tx('keyNotAccepted', 'Key not accepted')
        : tx('couldNotConnect', 'Could not connect')
      : tx('stopped', 'Stopped');
  const gatewayStatusTone: BadgeTone = gatewayHealthy ? 'success' : gatewayFailing ? 'danger' : 'neutral';
  // The dot under the headline: green only for healthy, red for a failure,
  // dim for a service that is simply not up (never red for a normal stop).
  const gatewayStatusDot = gatewayHealthy
    ? 'bg-[var(--app-success)] shadow-[0_0_8px_var(--app-success)]'
    : gatewayFailing
      ? 'bg-[var(--app-danger)] shadow-[0_0_8px_var(--app-danger)]'
      : 'bg-[var(--app-text-dim)]';
  // Words for a machine state the card is waiting on, from the locale
  // bundle: the machine's own label is English-only, which is why it is not
  // rendered.
  const gatewayProgressLabel = (state: GatewayState): string =>
    state === 'INSTALLING'
      ? tx('installing', 'Installing…')
      : state === 'STARTING'
        ? tx('starting', 'Starting')
        : state === 'STOPPING'
          ? tx('stopping', 'Stopping…')
          : tx('statusConnecting', 'Connecting…');

  // Gateway button flags derive from the one lifecycle machine, so Start and
  // Stop are enabled only in states where they can actually work. A gateway
  // that fails health or key checks is a failed service, not a running one.
  const gatewayMachine: GatewayState = isNativeGateway()
    ? (gatewayState as GatewayState)
    : ((gatewayHealthy
        ? 'RUNNING'
        : install === 'NOT_INSTALLED'
          ? 'NOT_INSTALLED'
          : install === 'FAILED'
            ? 'FAILED'
            : 'STOPPED') as GatewayState);
  const uiFlags = deriveUiFlags(gatewayMachine);

  // The stopped-service note says "Start it", so its button starts the service
  // instead of only re-probing status. Retry stays for a service that is
  // running but failing, where one more probe is the honest action, and for a
  // machine where Start is not available (setup still running, not installed).
  const stoppedNoteStartsService = !gatewayFailing && uiFlags.canStart;

  // One rule for the library lists: a payload that is not live is an
  // offline/error note, never an empty one. These services envelope their
  // failures instead of throwing, so without this check a dead gateway
  // renders as "nothing here".
  const listStateFrom = (live: boolean, count: number): DataState =>
    live ? (count === 0 ? 'empty' : 'ready') : connected ? 'error' : 'offline';

  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;
    setSkillsState((s) => (s === 'ready' ? 'refreshing' : 'loading'));
    service
      .skillsWithState(signal)
      .then((list) => {
        setSkills(list.items);
        setSkillsNote(list.error || '');
        setSkillsState(listStateFrom(list.live, list.items.length));
      })
      .catch(() => {
        setSkillsNote('');
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
      .blueprintsWithState(signal)
      .then((res) => {
        setBlueprints(res.items);
        setBlueprintsState(listStateFrom(res.live, res.items.length));
        setBlueprintsNote(res.error || '');
      })
      .catch(() => {
        setBlueprintsState(connected ? 'error' : 'offline');
        setBlueprintsNote('');
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
      // Adopt the local API key before the library calls: without it every
      // authenticated route answers 401 and memory/skills render a red error
      // for a key problem, not a data problem. Never blocks on failure.
      try {
        await ensureServerKey();
      } catch {
        /* the fetches below report their own outcome */
      }
      const [list, bpRes, m] = await Promise.all([
        service.skillsWithState(),
        service.blueprintsWithState(),
        service.memoryGet(),
      ]);
      setSkills(list.items);
      setSkillsNote(list.error || '');
      setSkillsState(listStateFrom(list.live, list.items.length));
      ctxSetSkills?.(list.items);
      setBlueprints(bpRes.items);
      setBlueprintsState(listStateFrom(bpRes.live, bpRes.items.length));
      setMemory(m);
      ctxSetMemory?.(m);
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
    const norm = normProvider(newProvType);
    // Keyless local providers prove reachability, not a key.
    if (!newProvKey.trim() && !KEYLESS_PROVIDERS.has(norm)) return;
    setTestingKey(true);
    setKeyResult(null);
    setKeyOk(null);
    setTestedFingerprint('');
    setTestedModels([]);

    const cleaned = newProvKey.trim();
    const directBase = (newProvBaseUrl.trim() || PROVIDER_DEFAULT_BASE_URL[norm] || '').replace(
    /\/+$/,
    ''
  );
    // The on-device gateway has no key-validation route (POST
    // /api/providers/validate 404s there), so testing through it always
    // reports 'Hermes did not answer'. For OpenAI-compatible providers the
    // key is tested directly against the provider's own model catalog:
    // GET {baseUrl}/models with the key as bearer. 200 proves the key and
    // returns the real model list; 401/403 proves the key is refused.
    // Direct provider GET that survives WebView CORS: CapacitorHttp runs on the
    // native stack (no origin check); on web it falls back to fetch.
    const directModelsFetch = async (url: string, key: string, signal: AbortSignal) => {
      try {
        const native = await CapacitorHttp.get({
          url,
          headers: { Authorization: `Bearer ${key}` },
          connectTimeout: 15000,
          readTimeout: 15000,
        });
        return {
          ok: native.status >= 200 && native.status < 300,
          status: native.status,
          json: async () => native.data as unknown,
        };
      } catch {
        const res = await fetch(url, { signal, headers: { Authorization: `Bearer ${key}` } });
        return { ok: res.ok, status: res.status, json: () => res.json() };
      }
    };
    // Providers with their own auth scheme (Anthropic, Gemini) and an empty
    // base URL keep the gateway path below.
    const directEligible = !!directBase && norm !== 'anthropic' && norm !== 'gemini';
    if (directEligible) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await directModelsFetch(`${directBase}/models`, cleaned, ctrl.signal);
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json().catch(() => null);
          const arr = data && Array.isArray((data as { data?: unknown }).data)
            ? (data as { data: Array<{ id?: unknown }> }).data
            : [];
          const live = arr.map((m) => String(m?.id || '')).filter((m) => m.trim());
          // An empty model list proves nothing about the key (captive portal
          // pages and error JSON also arrive as 200 OK): stay inconclusive
          // and let the gateway path below report its own outcome.
          if (live.length === 0) {
            // fall through to the gateway validation below
          } else {
            // Some catalog endpoints are public (no key needed): a 200 here
            // would declare ANY string a working key. Control probe with no
            // key: if it also returns models, this endpoint cannot prove the
            // key and the result stays inconclusive.
            const ctrl2 = new AbortController();
            const timer2 = setTimeout(() => ctrl2.abort(), 15000);
            let publicCatalog = false;
            try {
              const bare = await directModelsFetch(`${directBase}/models`, '', ctrl2.signal);
              if (bare.ok) {
                const bareData = await bare.json().catch(() => null);
                const bareArr = bareData && Array.isArray((bareData as { data?: unknown }).data)
                  ? (bareData as { data: Array<{ id?: unknown }> }).data
                  : [];
                publicCatalog = bareArr.some((m) => String((m as { id?: unknown })?.id || '').trim());
              }
            } catch {
              // No-key probe failed: the endpoint wants auth, keyed 200 stands.
            } finally {
              clearTimeout(timer2);
            }
            if (!publicCatalog || KEYLESS_PROVIDERS.has(norm)) {
              // Keyless providers are public by design: the model list is
              // the whole point of the test, no key to prove.
              setTestingKey(false);
              setTestedFingerprint(validationFingerprint({ provider: norm, [PROVIDER_CREDENTIAL_FIELD]: cleaned, baseUrl: newProvBaseUrl.trim() }));
              setKeyOk(true);
              setKeyResult(tx('keyValidPlain', 'This key works.'));
              setTestedModels(live);
              if (live.length > 0 && !newProvModel.trim()) {
                setNewProvModel(live[0]);
                setCustomModelMode(false);
              }
              return;
            }
            // Public catalog: fall through to the gateway validation below
            // instead of stamping an unproven key as working.
          }
        }
        if (res.status === 401 || res.status === 403) {
          setTestingKey(false);
          setTestedFingerprint(validationFingerprint({ provider: norm, [PROVIDER_CREDENTIAL_FIELD]: cleaned, baseUrl: newProvBaseUrl.trim() }));
          setKeyOk(false);
          setKeyResult(tx('keyInvalidPlain', 'The provider refused this key.'));
          return;
        }
        // Any other HTTP status is inconclusive for this path: fall through
        // to the gateway validation below instead of guessing.
      } catch {
        // Unreachable provider from this phone: fall through to the gateway
        // path, which reports its own outcome honestly.
      }
    }
    const res = await service.providersValidateWithModels(norm, 'HERMES_API_KEY', cleaned, newProvBaseUrl.trim());
    setTestingKey(false);
    // Record the whole tested tuple (provider, key, baseUrl), not just the
    // key: editing the Base URL after a pass must drop the validated flag.
    setTestedFingerprint(validationFingerprint({ provider: norm, [PROVIDER_CREDENTIAL_FIELD]: cleaned, baseUrl: newProvBaseUrl.trim() }));
    const valid = res === null ? null : res.valid;
    if (valid === true) {
      setKeyOk(true);
      setKeyResult(tx('keyValidPlain', 'This key works.'));
      const live = (res?.models || []).filter((m) => typeof m === 'string' && m.trim());
      setTestedModels(live);
      // Pre-fill the default model when empty so nothing must be typed.
      if (live.length > 0 && !newProvModel.trim()) {
        setNewProvModel(live[0]);
        setCustomModelMode(false);
      }
    } else if (valid === false) {
      setKeyOk(false);
      setKeyResult(tx('keyInvalidPlain', 'The provider refused this key.'));
    } else {
      // null means the gateway could not be reached, so validity is
      // genuinely unknown. Report unreachable, never a passing pattern.
      setKeyOk(null);
      setKeyResult(tx('keyUnreachablePlain', 'Hermes did not answer, so the key was not tested. Start Hermes, then test again.'));
    }
  };

  const handleRunDoctor = async () => {
    setRunningDoctor(true);
    const report = await service.doctor();
    setDoctorReport(report);
    setRunningDoctor(false);
  };

  const handleRunBackup = async () => {
    if (!window.confirm(tx('confirmSnapshotPlain', 'Create a snapshot now? It saves your chats, scheduled tasks, and settings. Keys are not included.'))) {
      return;
    }
    setRunningBackup(true);
    const res = await service.backup();
    setRunningBackup(false);
    // Same export gate as the debug bundle: a snapshot that still carries
    // key material is refused instead of shown or saved.
    const knownSecrets = [
      settings.apiKey,
      settings.serverKey,
      settings.tgToken,
      settings.discordToken,
      settings.appLockPin,
      ...configuredProviders.map((p) => p.apiKey || ''),
    ];
    const leaked = assertNoPlaintextSecrets(res, knownSecrets);
    if (leaked.length > 0) {
      const blocked = tx('debugFailedPlain', 'The diagnostics bundle was not exported. Try again.');
      setBackupResult({ ok: false, path: '', message: blocked });
      showToast(blocked, 'error');
      return;
    }
    setBackupResult(res);
  };

  const handleShareDebug = async () => {
    if (!window.confirm(tx('confirmDebugPlain', 'Share a diagnostics bundle? It includes the app version, service status, and recent logs, with secrets removed.'))) {
      return;
    }
    // Two gates before any link is shown. The redaction engine has to pass its
    // own self-test first, then the payload that came back is scanned against
    // every secret this phone still holds. Either gate failing exports nothing,
    // so a plain-text key can never leave the device inside a bundle.
    if (!runRedactionSelfTests().passed) {
      showToast(tx('debugFailedPlain', 'The diagnostics bundle was not exported. Try again.'), 'error');
      return;
    }
    setSharingDebug(true);
    const res = await service.debugShare();
    setSharingDebug(false);
    const knownSecrets = [
      settings.apiKey,
      settings.serverKey,
      settings.tgToken,
      settings.discordToken,
      settings.appLockPin,
      ...configuredProviders.map((p) => p.apiKey || ''),
    ];
    const leaked = assertNoPlaintextSecrets(res, knownSecrets);
    if (leaked.length > 0) {
      // The reasons are fixed strings, never the values, so this log line
      // stays safe to read while explaining why the export was refused.
      console.warn('[debugSafety] bundle blocked:', leaked);
      const blocked = tx('debugFailedPlain', 'The diagnostics bundle was not exported. Try again.');
      setDebugResult({ ok: false, urls: [], summary: blocked });
      showToast(blocked, 'error');
      return;
    }
    setDebugResult(res);
  };

  const handleToggleSkill = async (id: string, current: boolean) => {
    // The gateway answers with a boolean, so a rejected toggle must not be
    // announced as a success: read the state back and report the outcome.
    const ok = await service.skillToggle(id, !current);
    if (ok) setSkillToggleDead(false);
    else if (connected) setSkillToggleDead(true);
    try {
      const list = await service.skillsWithState();
      setSkills(list.items);
      setSkillsNote(list.error || '');
      setSkillsState(listStateFrom(list.live, list.items.length));
      ctxSetSkills?.(list.items);
    } catch {
      setSkillsState(connected ? 'error' : 'offline');
    }
    showToast(
      ok
        ? !current
          ? t('skillEnabled')
          : t('skillDisabled')
        : connected
          ? `${tx('toggleUnsupportedPlain', 'This server does not support that switch.')}${service.lastToggleStatus ? ` (HTTP ${service.lastToggleStatus})` : ''}`
          : tx('opsUnreachablePlain', 'Hermes is not reachable, so that did not finish.'),
      ok ? 'info' : 'error'
    );
  };

  const handleToggleMemory = async (target: boolean) => {
    setMemoryToggling(true);
    try {
      const ok = await service.memoryToggle(target);
      if (ok) setMemoryToggleDead(false);
      else if (connected) setMemoryToggleDead(true);
      const m = await service.memoryGet();
      setMemory(m);
      setMemoryState(m.live ? 'ready' : connected ? 'error' : 'offline');
      ctxSetMemory?.(m);
      showToast(
        ok
          ? target
            ? tx('memoryEnabledToast', 'Memory enabled')
            : tx('memoryDisabledToast', 'Memory disabled')
          : connected
            ? `${tx('toggleUnsupportedPlain', 'This server does not support that switch.')}${service.lastToggleStatus ? ` (HTTP ${service.lastToggleStatus})` : ''}`
            : tx('opsUnreachablePlain', 'Hermes is not reachable, so that did not finish.'),
        ok ? 'info' : 'error'
      );
    } catch {
      setMemoryState(connected ? 'error' : 'offline');
      showToast(tx('opsUnreachablePlain', 'Hermes is not reachable, so that did not finish.'), 'error');
    } finally {
      setMemoryToggling(false);
    }
  };

  const handleInstantiateBlueprint = async (id: string) => {
    const ok = await service.instantiateBlueprint(id, blueprintSlots);
    setSelectedBlueprint(null);
    setBlueprintSlots({});
    // No navigation follows: the toast must not claim the chat shows it.
    showToast(
      ok
        ? tx('routineSentPlain', 'Routine sent. Open the chat to see it start.')
        : tx('opsUnreachablePlain', 'Hermes is not reachable, so that did not finish.'),
      ok ? 'success' : 'error'
    );
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

  // Count phrasing carries a singular form, so "1 key saved" never renders as
  // "1 keys saved" and "1 item needs review" never renders as "need".
  const savedKeysLine =
    configuredProviders.length === 1
      ? tx('savedKeyOne', '1 key saved')
      : tx('savedKeyMany', '{count} keys saved').replace('{count}', String(configuredProviders.length));
  const validatedLine =
    unvalidatedKeys === 0
      ? tx('allKeysTested', ', all tested.')
      : unvalidatedKeys === 1
        ? tx('oneKeyUntested', ', 1 not tested yet.')
        : tx('manyKeysUntested', ', {count} not tested yet.').replace('{count}', String(unvalidatedKeys));
  const tokensBadgeLabel =
    tokensSet === 0
      ? tx('tokensNone', 'None set')
      : tokensSet === 1
        ? tx('tokensSetOne', '1 set')
        : tx('tokensSetMany', '{count} set').replace('{count}', String(tokensSet));

  const activeProvider: ConfiguredProvider | undefined = settings.activeProviderId
    ? configuredProviders.find((p) => p.id === settings.activeProviderId)
    : configuredProviders.find((p) => p.provider === settings.provider);

  const sectionChips: Array<{ id: SectionId; label: string }> = [
    { id: 'connection', label: tx('sectionConnection', 'Connection') },
    { id: 'security', label: tx('sectionSecurity', 'Security') },
    { id: 'gateway', label: tx('sectionServer', 'Hermes server') },
    { id: 'automation', label: tx('sectionAutomation', 'Automation') },
    { id: 'appearance', label: tx('sectionAppearance', 'Appearance') },
    { id: 'advanced', label: tx('sectionAdvanced', 'Advanced') },
  ];

  return (
    <div className="space-y-4 max-w-2xl mx-auto px-4 pt-4 hm-tab-bottom">
      {/* Toast popup. Raised above the modals (z-50) so status written while a
          sheet is open is never painted behind its backdrop. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-[calc(4rem+env(safe-area-inset-top,0px))] start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[200] max-w-[min(90vw,28rem)] text-center px-4 py-2 r-sm elev-2 hairline t-label pointer-events-none animate-in fade-in slide-in-from-top-2 ${
            toast.tone === 'error'
              ? 'bg-[var(--app-danger-subtle)] text-[var(--app-danger)]'
              : toast.tone === 'success'
                ? 'bg-[var(--app-success-subtle)] text-[var(--app-success)]'
                : 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)]'
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
          className="flex items-start gap-3 p-4 r-md bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)]"
        >
          <XCircle className="w-4 h-4 text-[var(--app-danger)] shrink-0 mt-1" />
          <div className="min-w-0 flex-1">
            <p className="t-body text-[var(--app-danger)]">
              {tx('settingsSaveFailedTitlePlain', 'Your change was not saved')}
            </p>
            <p className="t-caption text-[var(--app-text-muted)] break-words">{visibleSaveError}</p>
          </div>
          {hasRetry && (
            <button
              onClick={retryFailedSave}
              className="hm-hit inline-flex shrink-0 items-center px-3 py-2 min-h-[36px] r-xs t-label bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] text-[var(--app-danger)] transition cursor-pointer"
            >
              {tx('retrySave', 'Retry')}
            </button>
          )}
          <button
            onClick={() => setSaveErrorDismissed(visibleSaveError)}
            className="hm-hit inline-flex shrink-0 items-center px-3 py-2 min-h-[36px] r-xs t-label bg-[var(--app-card-subtle)] border border-[var(--app-border-subtle)] text-[var(--app-text-muted)] transition cursor-pointer"
          >
            {tx('dismiss', 'Dismiss')}
          </button>
        </div>
      )}

      {/* Provider apply progress: shown while the native mirror and the gateway
          restart run, so the UI is never a silent wait. */}
      {applyingProvider && (
        <div role="status" aria-live="polite" className="flex items-center gap-3 p-4 r-md bg-[var(--app-accent-subtle)] border border-[var(--app-border)]">
          <RefreshCw className="w-3.5 h-3.5 text-[var(--app-accent-text)] animate-spin shrink-0" />
          <span className="t-caption text-[var(--app-accent-text)] flex-1 break-words">
            {applyStatus || tx('applyingProviderPlain', 'Applying the change')}
          </span>
        </div>
      )}

      {/* UX-05: gateway status summary, always visible, tap for details */}
      <div className="r-md elev-0 bg-[var(--app-card)] edge overflow-hidden">
        <div className="w-full px-5 py-3 flex items-center gap-3">
          <button
            onClick={() => setShowGatewayDetails((v) => !v)}
            aria-expanded={showGatewayDetails}
            className="min-w-0 flex-1 flex items-center gap-3 text-start cursor-pointer"
          >
            <span
              role="img"
              aria-label={gatewayStatusText}
              className={`w-3 h-3 r-full shrink-0 ${gatewayStatusDot}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block t-body text-[var(--app-text)] break-words">
                {gatewayStatusText}
                <span className="t-caption font-normal text-[var(--app-text-muted)]">
                  {' '}
                  · {tx('localMemory', 'On this phone')} · {installStateLabel(install)}
                </span>
              </span>
              <span className="block t-caption text-[var(--app-text-dim)] break-words">
                {gatewayFailing && gatewayFailureReason
                  ? plainGatewayFailure(gatewayFailureReason, tx)
                  : tx('tapForDetailsPlain', 'Tap for details')}
              </span>
            </span>
            <ChevronDown className={`w-4 h-4 text-[var(--app-text-muted)] shrink-0 transition-transform ${showGatewayDetails ? 'rotate-180' : ''}`} />
          </button>
          <button
            onClick={() => {
              void handleRefreshStatus();
            }}
            disabled={refreshingStatus}
            className="w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer shrink-0 disabled:opacity-50"
            title={t('refresh')}
            aria-label={t('refresh')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingStatus ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {showGatewayDetails && (
          <div className="px-5 pb-4 pt-1 t-caption text-[var(--app-text-muted)] space-y-2 border-t border-[var(--app-border-subtle)]">
            <div className="flex justify-between pt-2">
              <span>{tx('stateLabel', 'State')}</span>
              <span className="t-micro text-[var(--app-text)] font-mono">
                {/* The status payload carries lower-case tokens ('running',
                    'ready', 'down') that this label never matched, so the row
                    printed "Unknown" under a card that said Running. The
                    status words come from the same helper as the card. */}
                {gatewayStatusText}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{tx('versionLabel', 'Version')}</span>
              <span className="t-micro text-[var(--app-text)] font-mono">{gatewayStatus?.version || tx('unknownVersion', 'unknown version')}</span>
            </div>
            <div className="flex justify-between">
              <span>{tx('approvalsPending', 'Approvals pending')}</span>
              <span className="t-micro text-[var(--app-text)] font-mono">{approvals?.length || 0}</span>
            </div>
            <div className="flex justify-between">
              <span>{tx('scheduledJobs', 'Scheduled jobs')}</span>
              <span className="t-micro text-[var(--app-text)] font-mono">{jobs?.length || 0}</span>
            </div>
            {refreshingStatus && <StateNote state="refreshing" message={tx('refreshingStatusPlain', 'Refreshing status…')} />}
            {!gatewayHealthy && (
              <StateNote
                state={gatewayFailing ? 'error' : 'offline'}
                message={
                  gatewayFailing
                    ? gatewayFailureReason
                      ? plainGatewayFailure(gatewayFailureReason, tx)
                      : tx('couldNotConnect', 'Could not connect')
                    : tx('serverStoppedHint', 'Hermes is stopped. Start it to run diagnostics and scheduled tasks.')
                }
                detail={
                  gatewayFailing
                    ? undefined
                    : installError
                      ? plainResultLine(installError, '', tx) || undefined
                      : undefined
                }
                actionLabel={stoppedNoteStartsService ? tx('startService', 'Start') : undefined}
                onRetry={() => {
                  if (stoppedNoteStartsService) void handleStartGateway();
                  else void handleRefreshStatus();
                }}
              />
            )}
            {installProgress ? <p className="t-caption text-[var(--app-text-dim)]">{installProgress}</p> : null}
          </div>
        )}
      </div>

      {/* Section quick-jump rail. .hm-rail gives snap points, momentum and a
          fading edge so the strip reads as scrollable; each chip sizes to its
          own label instead of splitting the width, and exactly one chip carries
          the current state (scroll position, or the section just opened). */}
      <nav
        aria-label={tx('sectionNav', 'Settings sections')}
        className="hm-rail items-stretch gap-1 p-1 r-md elev-2 bg-[var(--app-card)] edge"
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
              className={`hm-hit min-h-[36px] px-3 py-2 r-xs t-label transition-colors whitespace-nowrap cursor-pointer flex items-center gap-2 ${
                isCurrent
                  ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)]'
                  : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
              }`}
            >
              <span>{chip.label}</span>
              {isOpen && !isCurrent && (
                <span aria-hidden="true" className="w-2 h-2 r-full bg-[var(--app-accent)]" />
              )}
            </button>
          );
        })}
      </nav>

      {/* ========================================================= */}
      {/* CONNECTION: primary task first (active provider), then list */}
      {/* ========================================================= */}
      <Section
        title={tx('sectionConnection', 'Connection')}
        subtitle={activeProvider ? `${t('active')}: ${activeProvider.name}` : t('providersDesc')}
        open={openSections.connection}
        onToggle={() => toggleSection('connection')}
        id={sectionDomId('connection')}
        badge={activeProvider ? <Badge tone="accent">{t('active')}</Badge> : undefined}
      >
        <Row>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="t-body text-[var(--app-text)]">{t('configuredProviders')}</p>
              <p className="t-caption text-[var(--app-text-muted)] mt-1">{t('providersDesc')}</p>
            </div>
            <button
              onClick={() => {
                setEditingProviderId(null);
                setNewProvType('');
                setNewProvName('');
                setNewProvKey('');
                setNewProvBaseUrl('');
                setNewProvModel('');
                setKeyResult(null);
                setKeyOk(null);
                setTestedFingerprint('');
                setShowNewKey(false);
                setActivateNewProvider(false);
                setCustomModelMode(false);
                setShowAddModal(true);
              }}
              className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] t-label text-[var(--app-on-accent)] transition cursor-pointer shrink-0"
            >
              {t('addProvider')}
            </button>
          </div>
        </Row>
        {configuredProviders.length === 0 ? (
          <Row>
            <StateNote
              state={connected ? 'empty' : 'offline'}
              message={connected ? t('noProviders') : tx('providersOfflinePlain', 'Hermes is offline. Saved keys stay on this phone and can still be edited.')}
            />
          </Row>
        ) : (
          <Row>
            <div className="divide-y divide-[var(--app-border-subtle)]">
              {configuredProviders.map((prov) => {
                // Active is matched by id so same-slug duplicate profiles
                // do not all light up. Falls back to slug for legacy state.
                const isActive = settings.activeProviderId
                  ? prov.id === settings.activeProviderId
                  : prov.provider === settings.provider;
                return (
                  <div key={prov.id} className="py-3 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={`w-9 h-9 r-sm flex items-center justify-center t-label font-mono uppercase shrink-0 ${
                            isActive ? 'bg-[var(--app-accent)] text-[var(--app-on-accent)]' : 'bg-[var(--app-card-subtle)] text-[var(--app-text-muted)]'
                          }`}
                        >
                          {providerLabel(prov.provider).slice(0, 2)}
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="t-label text-[var(--app-text)] truncate">{prov.name}</p>
                          {isActive && <Badge tone="accent" className="shrink-0">{t('active')}</Badge>}
                          {!prov.validated && <Badge tone="warning" className="shrink-0">{tx('untested', 'Untested')}</Badge>}
                        </div>
                      </div>
                      {/* Line two: model and endpoint summary. Two lines, so a
                          long model id plus the endpoint never gets cut to a
                          fragment the way a single-line truncate did. */}
                      <p className="t-micro text-[var(--app-text-dim)] line-clamp-2 mt-1 ps-[46px]">
                        {prov.defaultModel || t('defaultModelShort')} · {prov.baseUrl ? t('customProxy') : t('officialEndpoint')}
                      </p>
                    </div>
                    <button
                      onClick={() => setMenuProviderId(prov.id)}
                      aria-haspopup="dialog"
                      aria-expanded={menuProviderId === prov.id}
                      aria-label={`${tx('profileActions', 'Profile actions')}: ${prov.name}`}
                      className="w-11 h-11 -my-1 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition-colors cursor-pointer shrink-0"
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
        title={tx('sectionSecurity', 'Security')}
        subtitle={
          riskCount > 0
            ? tx('riskNeedsReview', riskCount === 1 ? '1 item needs review' : `${riskCount} items need review`)
            : tx('noElevatedRisks', 'No elevated risks')
        }
        open={openSections.security}
        onToggle={() => toggleSection('security')}
        id={sectionDomId('security')}
        badge={riskCount > 0 ? <Badge tone={riskTone('medium')}>{riskCount}</Badge> : <Badge tone="neutral">{tx('noRiskShort', 'Clear')}</Badge>}
      >
        {/* One auto-approve block, not two. The gate below already carries the
            title, the plain ON / OFF status and the only Enable / Disable
            control, so the summary row that repeated the same setting with a
            second Disabled badge is gone. The section badge still counts the
            risk from autoApproveRisk. The policy the gate writes stays the
            single source of truth for both the UI and the runtime. */}
        <Row>
          <AutoApproveGate policy={autoApprovePolicy} onChange={writeAutoApprovePolicy} t={t} />
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="t-body text-[var(--app-text)]">{tx('approvalScope', 'Approval Scope')}</p>
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx('approvalScopeDesc', 'How long an auto-approval lasts once granted. Session scope keeps elevated rights longer.')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(settings.approvalScope || 'once') === 'session' && (
                <Badge tone="warning" icon={riskIcon('medium')}>{tx('elevated', 'Elevated')}</Badge>
              )}
              {/* The picker is built from the shared scope list, so a scope
                  added there shows up here without a second hand-written copy,
                  and a malformed stored value falls back to Once instead of
                  rendering a strip with nothing selected. */}
              <Segmented
                groupLabel={tx('approvalScope', 'Approval Scope')}
                options={APPROVAL_SCOPES.map((scope) => ({
                  id: scope,
                  label: scope === 'session' ? tx('scopeSession', 'Session') : tx('scopeOnce', 'Once'),
                }))}
                value={isApprovalScope(settings.approvalScope) ? settings.approvalScope : 'once'}
                onSelect={handleScopeChange}
                pendingId={pendingScope}
              />
            </div>
          </div>
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="t-body text-[var(--app-text)]">{appLockTitle}</p>
              <p className="t-caption text-[var(--app-text-muted)]">{t('appLockDesc')}</p>
              <p className="t-caption text-[var(--app-text-dim)] mt-1">{tx('pinRangeNote', 'Use 4 to 8 digits. Avoid common or repeated-digit PINs.')}</p>
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
                    // The second tap only opens the prompt: the PIN below is
                    // what turns the flag off.
                    setDisablePin('');
                    setShowDisablePin(false);
                    setDisablePinError(null);
                    setDisablePinPrompt(true);
                  } else {
                    setPendingDisableLock(false);
                    setPinError(null);
                    setNewPin('');
                    setConfirmPin('');
                    setShowPinForm(true);
                  }
                }}
                className={`hm-hit min-h-[36px] cursor-pointer transition ${
                  settings.appLockEnabled ? (pendingDisableLock ? 'pill-warning' : 'pill-accent') : 'pill-neutral'
                }`}
              >
                {settings.appLockEnabled ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                <span>{settings.appLockEnabled ? (pendingDisableLock ? tx('confirm', 'Confirm?') : t('locked')) : t('disabled')}</span>
              </button>
            </div>
          </div>
          {disablePinPrompt && (
            <div
              className="mt-3 p-3 r-sm edge bg-[var(--app-card-subtle)] space-y-2"
              role="group"
              aria-label={tx('lockPinInputLabel', 'App lock PIN')}
            >
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx('lockPinInputLabel', 'App lock PIN')}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type={showDisablePin ? 'text' : 'password'}
                  inputMode="numeric"
                  autoFocus
                  value={disablePin}
                  onChange={(e) => {
                    setDisablePin(e.target.value.replace(/\D/g, '').slice(0, 8));
                    setDisablePinError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmDisableLock();
                  }}
                  placeholder={tx('confirmPinPlaceholder', 'Confirm PIN')}
                  aria-label={tx('lockPinInputLabel', 'App lock PIN')}
                  disabled={disablePinBusy}
                  className="flex-1 min-w-0 px-3 py-2.5 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] font-mono focus:outline-none focus:border-[var(--app-accent)] disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowDisablePin((v) => !v)}
                  disabled={disablePinBusy}
                  aria-label={showDisablePin ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="hm-hit w-9 h-9 inline-flex items-center justify-center r-sm edge bg-[var(--app-card-subtle)] text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer disabled:opacity-50"
                >
                  {showDisablePin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  onClick={confirmDisableLock}
                  disabled={disablePinBusy || disablePin.length < 1}
                  className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] transition cursor-pointer disabled:opacity-50"
                >
                  {disablePinBusy ? tx('unlocking', 'Unlocking…') : tx('confirm', 'Confirm?')}
                </button>
                <button
                  onClick={closeDisablePinPrompt}
                  disabled={disablePinBusy}
                  className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm t-label edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] text-[var(--app-text)] transition cursor-pointer disabled:opacity-50"
                >
                  {t('cancel')}
                </button>
              </div>
              {disablePinError && (
                <p className="t-caption text-[var(--app-danger)]" role="alert">
                  {disablePinError}
                </p>
              )}
            </div>
          )}
          {settings.appLockEnabled && (
            <p className="t-caption text-[var(--app-text-dim)] mt-1">{t('appLockReentryNote')}</p>
          )}

          {settings.appLockEnabled && (
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => {
                  lockNow();
                  showToast(tx('appLocked', 'App locked'));
                }}
                aria-label={tx('lockNow', 'Lock Now')}
                className="hm-hit inline-flex items-center gap-2 px-4 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] transition cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>{tx('lockNow', 'Lock Now')}</span>
              </button>
              <span className="t-caption text-[var(--app-text-dim)]">
                {vaultUnlocked
                  ? tx('secretsUnlocked', 'Your saved keys can be read on this phone.')
                  : tx('secretsLocked', 'Your saved keys are locked.')}
              </span>
              {!showPinForm && (
                <button
                  onClick={() => {
                    setPinError(null);
                    setNewPin('');
                    setConfirmPin('');
                    setShowPinForm(true);
                  }}
                  className="ms-auto hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm t-label text-[var(--app-accent-text)] hover:text-[var(--app-text)] cursor-pointer"
                >
                  {t('changePin')}
                </button>
              )}
            </div>
          )}

          {showPinForm && (
            <div className="space-y-2 pt-3">
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
                  className="flex-1 px-3 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
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
                  className="flex-1 px-3 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPin((v) => !v)}
                  aria-pressed={showPin}
                  aria-label={showPin ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="w-11 h-11 flex items-center justify-center r-sm hm-hit shrink-0 text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition cursor-pointer"
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {pinError && <p className="t-caption text-[var(--app-danger)]">{pinError}</p>}
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
                  className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] transition cursor-pointer"
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
                  className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm t-label text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer"
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
              <p className="t-body text-[var(--app-text)]">{tx('savedKeysTitle', 'Saved keys')}</p>
              <p className="t-caption text-[var(--app-text-muted)]">
                {savedKeysLine}
                {validatedLine}
              </p>
            </div>
            <button
              onClick={revealConnection}
              className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition-colors cursor-pointer shrink-0"
            >
              {tx('reviewKeys', 'Review keys')}
            </button>
          </div>
        </Row>

        <Row>
          <details className="group">
            <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
              <div>
                <p className="t-body text-[var(--app-text)]">{tx('tokensTitle', 'Bot and server keys')}</p>
                <p className="t-caption text-[var(--app-text-muted)]">
                  {tx('tokensDesc', 'Telegram, Discord, and the key that reaches your Hermes server. Tap to edit.')}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge tone={riskTone(tokensRisk)} icon={riskIcon(tokensRisk)}>
                  {tokensBadgeLabel}
                </Badge>
                <ChevronDown className="w-4 h-4 text-[var(--app-text-muted)] group-open:rotate-180 transition-transform" />
              </div>
            </summary>
            <div className="space-y-3 pt-3">
              <div className="flex items-center gap-2">
                <input
                  type={showTokens.tg ? 'text' : 'password'}
                  value={tgToken}
                  onChange={(e) => setTgToken(e.target.value)}
                  placeholder="bot123456:ABC-DEF…"
                  aria-label={t('telegramBridge')}
                  className="flex-1 px-3 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowTokens((s) => ({ ...s, tg: !s.tg }))}
                  aria-pressed={showTokens.tg}
                  aria-label={showTokens.tg ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="w-11 h-11 flex items-center justify-center r-sm hm-hit shrink-0 text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition cursor-pointer"
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
                        restartedMsg: `${t('tgSaved')}. ${tx('serverRestartedShort', 'Hermes restarted.')}`,
                        overrides: { tgToken: cleaned },
                      });
                    })();
                  }}
                  className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer"
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
                  className="flex-1 px-3 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowTokens((s) => ({ ...s, discord: !s.discord }))}
                  aria-pressed={showTokens.discord}
                  aria-label={showTokens.discord ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="w-11 h-11 flex items-center justify-center r-sm hm-hit shrink-0 text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition cursor-pointer"
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
                        restartedMsg: `${t('discordSaved')}. ${tx('serverRestartedShort', 'Hermes restarted.')}`,
                        overrides: { discordToken: cleaned },
                      });
                    })();
                  }}
                  className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer"
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
                  className="flex-1 px-3 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowTokens((s) => ({ ...s, server: !s.server }))}
                  aria-pressed={showTokens.server}
                  aria-label={showTokens.server ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                  className="w-11 h-11 flex items-center justify-center r-sm hm-hit shrink-0 text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition cursor-pointer"
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
                        restartedMsg: `${t('serverKeySaved')}. ${tx('serverRestartedShort', 'Hermes restarted.')}`,
                        overrides: { serverKey: cleaned },
                      });
                    })();
                  }}
                  className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer"
                >
                  {t('saveShort')}
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleGenerateServerKey}
                  className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer"
                >
                  {tx('generate', 'Generate')}
                </button>
                <button
                  type="button"
                  onClick={handleTestServerKey}
                  disabled={!serverKey.trim() || testingAuth}
                  className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer disabled:opacity-40"
                >
                  {testingAuth ? tx('testing', 'Testing…') : tx('testAuth', 'Test key')}
                </button>
                {serverKeyWeak && (
                  <span className="t-caption text-[var(--app-warning)]">{tx('weakKey', 'Weak key: generate a fresh one.')}</span>
                )}
                {authResult && (
                  <span
                    className={`t-caption ${
                      authOk === true ? 'text-[var(--app-success)]' : authOk === false ? 'text-[var(--app-danger)]' : 'text-[var(--app-warning)]'
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
              <p className="t-body text-[var(--app-text)]">{tx('diagnosticSharingTitle', 'Diagnostic sharing')}</p>
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx('diagnosticSharingDesc', 'Bundles are exports you start yourself. Secrets are removed before upload.')}
              </p>
            </div>
            <Badge tone="info">{tx('manualOnly', 'Manual only')}</Badge>
          </div>
        </Row>
      </Section>

      {/* ========================================================= */}
      {/* GATEWAY */}
      {/* ========================================================= */}
      <Section
        title={tx('sectionServer', 'Hermes server')}
        subtitle={`${tx('localMemory', 'On this phone')}, ${installStateLabel(install)}`}
        open={openSections.gateway}
        onToggle={() => toggleSection('gateway')}
        id={sectionDomId('gateway')}
        badge={<Badge tone={gatewayStatusTone}>{gatewayStatusText}</Badge>}
      >
        <Row>
          <p className="t-body text-[var(--app-text)]">{tx('serverServiceTitle', 'Background service')}</p>
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={() => {
                void handleStartGateway();
              }}
              disabled={gatewayBusy || !uiFlags.canStart}
              title={!uiFlags.canStart ? tx('startUnavailablePlain', 'Start is not available right now.') : undefined}
              className="hm-hit inline-flex items-center gap-2 px-4 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] transition cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 fill-[var(--app-on-accent)]" />
              <span>{tx('startService', 'Start')}</span>
            </button>
            <button
              onClick={() => {
                void handleStopGateway();
              }}
              disabled={gatewayBusy || !uiFlags.canStop}
              title={!uiFlags.canStop ? tx('stopUnavailablePlain', 'Stop is not available right now.') : undefined}
              className="hm-hit inline-flex items-center gap-2 px-4 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer disabled:opacity-50"
            >
              <Square className="w-3.5 h-3.5 fill-[var(--app-text-muted)]" />
              <span>{t('stopShort')}</span>
            </button>
            {(uiFlags.canInstall || install === 'FAILED') && (
              <button
                onClick={() => {
                  void handleInstallGateway();
                }}
                disabled={installing || !uiFlags.isStable}
                className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer disabled:opacity-50"
              >
                {installing ? tx('installing', 'Installing…') : tx('install', 'Install')}
              </button>
            )}
            {uiFlags.showRetry && (
              <button
                onClick={() => {
                  // A failed install restarts it; a degraded service is worth
                  // another probe before anything heavier is attempted.
                  if (uiFlags.canStart) void handleStartGateway();
                  else void handleRefreshStatus();
                }}
                disabled={gatewayBusy || refreshingStatus}
                className="hm-hit inline-flex items-center gap-2 px-4 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{tx('retry', 'Retry')}</span>
              </button>
            )}
          </div>
          {uiFlags.showProgress && !installProgress && !refreshingStatus && (
            <div className="pt-2">
              <StateNote state="refreshing" message={gatewayProgressLabel(gatewayMachine)} />
            </div>
          )}
          {!gatewayHealthy && (
            <div className="pt-2">
              <StateNote
                state={gatewayFailing ? 'error' : 'offline'}
                message={
                  gatewayFailing
                    ? gatewayFailureReason
                      ? plainGatewayFailure(gatewayFailureReason, tx)
                      : tx('couldNotConnect', 'Could not connect')
                    : tx('serverStoppedHint', 'Hermes is stopped. Start it to run diagnostics and scheduled tasks.')
                }
                detail={
                  gatewayFailing
                    ? undefined
                    : installError
                      ? plainResultLine(installError, '', tx) || undefined
                      : undefined
                }
                actionLabel={stoppedNoteStartsService ? tx('startService', 'Start') : undefined}
                onRetry={() => {
                  if (stoppedNoteStartsService) void handleStartGateway();
                  else void handleRefreshStatus();
                }}
              />
            </div>
          )}
        </Row>
        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="t-body text-[var(--app-text)]">{t('autostartTitle')}</p>
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx('autostartPlainDesc', 'Hermes starts again by itself each time you open the app, and keeps running while your phone is locked.')}
              </p>
            </div>
            <Switch
              checked={!!settings.autostart}
              onChange={() => {
                const next = !settings.autostart;
                saveThenToast({ autostart: next }, next ? t('autostartEnabled') : t('autostartDisabled'), 'success');
              }}
              ariaLabel={`${t('autostartTitle')}: ${settings.autostart ? t('autostartEnabled') : t('autostartDisabled')}`}
            />
          </div>
        </Row>
        {/* R1: alert permission state. Approvals and job results can only
            reach a closed app when this is granted; a denial is flipped in
            system settings, so the button re-asks (or the user goes there). */}
        <Row>
          <NotificationRow />
        </Row>
      </Section>

      {/* ========================================================= */}
      {/* AUTOMATION: skills, memory, blueprints */}
      {/* ========================================================= */}
      <Section
        title={tx('sectionAutomation', 'Automation')}
        subtitle={tx('automationSubtitle', 'Skills, memory, and routine templates')}
        open={openSections.automation}
        onToggle={() => toggleSection('automation')}
        id={sectionDomId('automation')}
      >
        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="t-body text-[var(--app-text)]">{tx('skillsTitle', 'Skills')}</p>
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx('skillsCatalogPlain', 'Extra abilities you can switch on. Each one adds tools the assistant can use.')}
              </p>
            </div>
            <button
              onClick={() => {
                setShowSkillsModal(true);
                void refreshLibrary();
              }}
              className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] transition cursor-pointer shrink-0"
            >
              {skills.length > 0 && !skillsNote
                ? `${tx('viewPlain', 'View')} (${skills.filter((s) => s.enabled).length}/${skills.length})`
                : tx('viewPlain', 'View')}
            </button>
          </div>
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <p className="t-body text-[var(--app-text)]">{tx('memoryTitlePlain', 'Memory')}</p>
                <Badge tone={memory?.enabled ? 'success' : 'neutral'}>
                  {memory?.enabled ? t('active') : t('disabled')}
                </Badge>
              </div>
              <p className="t-caption text-[var(--app-text-muted)] mt-1">
                {t('providerLabel')}: {memory?.provider || tx('localMemory', 'On this phone')} · {t('entriesLabel')}:{' '}
                {memory?.entries || 0}
              </p>
            </div>
            <Switch
              checked={Boolean(memory?.enabled)}
              onChange={() => void handleToggleMemory(!memory?.enabled)}
              disabled={memoryToggling || memoryToggleDead || memoryState !== 'ready'}
              ariaLabel={`${tx('memoryTitlePlain', 'Memory')}: ${memory?.enabled ? t('active') : t('disabled')}`}
            />
          </div>
          {memoryToggleDead && connected && (
            <p className="t-caption text-[var(--app-text-dim)] pt-1">
              {tx('toggleUnsupportedPlain', 'This server does not support that switch.')}
            </p>
          )}
          <div className="pt-2">
            <StateNote
              state={memoryState}
              message={
                memoryState === 'loading' ? tx('memoryLoadingPlain', 'Loading memory…') :
                memoryState === 'offline' ? tx('memoryOfflinePlain', 'Hermes is offline. This summary may be out of date.') :
                memoryState === 'error' ? tx('memoryErrorPlain', 'Memory could not load.') :
                memoryState === 'refreshing' ? tx('memoryRefreshingPlain', 'Refreshing memory…') : ''
              }
              onRetry={() => {
                void refreshLibrary();
              }}
            />
            {memoryState === 'ready' && (
              <div className="t-caption text-[var(--app-text)] bg-[var(--app-card-subtle)] p-4 r-sm hairline font-mono leading-relaxed">
                {memory?.summary || (memory?.enabled ? t('memoryEmpty') : tx('memoryDisabledPlain', 'Semantic memory is disabled.'))}
              </div>
            )}
          </div>
        </Row>

        <Row>
          <p className="t-body text-[var(--app-text)]">{tx('routinesTitle', 'Routine templates')}</p>
          <div className="pt-2 space-y-2">
            <StateNote
              state={blueprintsState}
              message={
                blueprintsState === 'loading' ? tx('routinesLoadingPlain', 'Loading routines…') :
                blueprintsState === 'empty' && blueprintsNote ? blueprintsNote :
                blueprintsState === 'empty' ? tx('routinesEmptyPlain', 'No routines available.') :
                blueprintsState === 'offline' ? tx('routinesOfflinePlain', 'Hermes is offline. Routines may be out of date.') :
                blueprintsState === 'error' ? tx('routinesErrorPlain', 'Routines could not load.') :
                blueprintsState === 'refreshing' ? tx('routinesRefreshingPlain', 'Refreshing routines…') : ''
              }
              onRetry={() => {
                void refreshLibrary();
              }}
            />
            {blueprints.map((bp) => (
              <div key={bp.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="t-label text-[var(--app-text)]">{bp.name}</p>
                  <p className="t-caption text-[var(--app-text-muted)] mt-1">{bp.description}</p>
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
                  className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] transition cursor-pointer shrink-0"
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
        title={tx('sectionAppearance', 'Appearance')}
        subtitle={t('themeSubtitle')}
        open={openSections.appearance}
        onToggle={() => toggleSection('appearance')}
        id={sectionDomId('appearance')}
      >
        <Row>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="t-body text-[var(--app-text)]">{t('themeTitle')}</p>
              <p className="t-caption text-[var(--app-text-muted)] mt-1">{t('themeSubtitle')}</p>
            </div>
            <Segmented
              groupLabel={t('themeTitle')}
              className="self-start sm:self-auto"
              options={[
                { id: 'light', label: t('light') || 'Light', icon: Sun },
                { id: 'dark', label: t('dark') || 'Dark', icon: Moon },
                { id: 'system', label: t('system') || 'System', icon: Monitor },
              ]}
              value={currentMode}
              onSelect={(id, label) => {
                saveThenToast({ themeMode: id as ThemeMode }, `${t('themeTitle')}: ${label}`, 'success');
              }}
            />
          </div>
          <div className="pt-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-[var(--app-text-muted)] pointer-events-none" />
              <input
                type="text"
                value={themeSearch}
                onChange={(e) => setThemeSearch(e.target.value)}
                placeholder={themeSearchPlaceholder}
                aria-label={themeSearchPlaceholder}
                className="w-full ps-9 pe-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] placeholder:text-[var(--app-text-dim)]"
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
                  className={`p-3 r-sm border text-start transition-all cursor-pointer flex flex-col justify-between group ${
                    isSelected
                      ? 'border-[var(--app-accent)] bg-[var(--app-accent-subtle)] ring-1 ring-[var(--app-accent)] elev-1'
                      : 'edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)]'
                  }`}
                >
                  <div
                    className="w-full h-24 r-sm hairline overflow-hidden flex relative mb-3"
                    style={{ backgroundColor: currentMode === 'light' ? th.light.bg : th.preview.bg }}
                  >
                    <div
                      className="w-12 h-full border-e border-[var(--app-border-subtle)] shrink-0"
                      style={{ backgroundColor: currentMode === 'light' ? th.light.sidebar : th.preview.sidebar }}
                    />
                    <div className="flex-1 p-3 flex flex-col justify-between">
                      <div className="space-y-2">
                        <div className="h-3 w-20 r-full" style={{ backgroundColor: currentMode === 'light' ? th.light.textMuted : th.preview.bar1 }} />
                        <div className="h-2 w-28 r-full" style={{ backgroundColor: currentMode === 'light' ? th.light.textMuted : th.preview.bar2 }} />
                      </div>
                      <div className="flex justify-end">
                        <div className="h-4 w-12 r-full" style={{ backgroundColor: currentMode === 'light' ? th.light.accent : th.preview.pill }} />
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <h4 className="t-label text-[var(--app-text)] group-hover:text-[var(--app-accent-text)] transition-colors">
                        {th.name}
                      </h4>
                      {isSelected && (
                        <span className="w-2 h-2 r-full bg-[var(--app-accent)] shadow-[0_0_8px_var(--app-accent)]" />
                      )}
                    </div>
                    <p className="t-caption text-[var(--app-text-muted)] mt-1 leading-snug line-clamp-2">
                      {th.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          {filteredThemes.length === 0 && (
            <p className="t-caption text-[var(--app-text-dim)] pt-3">{tx('noThemes', 'No themes match that search.')}</p>
          )}
          {filteredThemes.length > 6 && (
            <button
              onClick={() => setShowAllThemes((v) => !v)}
              aria-expanded={showAllThemes}
              className="mt-3 hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm t-label text-[var(--app-accent-text)] hover:text-[var(--app-text)] cursor-pointer"
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
              <p className="t-body text-[var(--app-text)]">{t('languageTitle')}</p>
              <p className="t-caption text-[var(--app-text-muted)] mt-1">{t('languageSubtitle')}</p>
            </div>
            <span className="t-micro text-[var(--app-text-muted)] font-mono">
              {LANGUAGES.find((l) => l.id === (settings.language || 'en'))?.code || 'EN'}
            </span>
          </div>
          <div className="pt-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-[var(--app-text-muted)] pointer-events-none" />
              <input
                type="text"
                value={langSearch}
                onChange={(e) => setLangSearch(e.target.value)}
                placeholder={tx('searchLanguagesPlain', 'Search languages…')}
                aria-label={tx('searchLanguagesPlain', 'Search languages…')}
                className="w-full ps-9 pe-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] placeholder:text-[var(--app-text-dim)] font-sans"
              />
            </div>
          </div>
          <div
            role="listbox"
            aria-label={t('languageTitle')}
            className="divide-y divide-[var(--app-border-subtle)] max-h-64 overflow-y-auto r-md hairline bg-[var(--app-card-subtle)] mt-3"
          >
            {filteredLanguages.length === 0 && (
              <p className="t-caption text-[var(--app-text-dim)] px-4 py-3">{tx('noLanguages', 'No languages match that search.')}</p>
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
                  className={`w-full px-4 py-3 min-h-[44px] flex items-center justify-between transition cursor-pointer hover:bg-[var(--app-card-hover)] ${
                    isSelected ? 'bg-[var(--app-card-hover)]' : ''
                  }`}
                >
                  <span className={`t-label ${isSelected ? 'text-[var(--app-text)]' : 'text-[var(--app-text-muted)]'}`}>
                    {lang.name}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="t-micro font-mono text-[var(--app-text-dim)]">{lang.code}</span>
                    {isSelected && <Check className="w-4 h-4 text-[var(--app-accent-text)] stroke-[2.5]" />}
                  </div>
                </button>
              );
            })}
          </div>
        </Row>

        <Row>
          <div className="flex justify-between t-label text-[var(--app-text)]">
            <span>{t('fontScale')}</span>
            <span className="t-micro font-mono text-[var(--app-text-muted)]">{Math.round(fontScaleLocal * 100)}%</span>
          </div>
          <input
            type="range"
            min="0.8"
            max="1.3"
            step="0.05"
            value={fontScaleLocal}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setFontScaleLocal(val);
              document.documentElement.style.setProperty('--font-scale', String(val));
            }}
            aria-label={t('fontScale')}
            className="w-full accent-[var(--app-accent)] mt-2"
          />
          <p className="t-caption text-[var(--app-text-dim)] pt-1">{t('fontScaleDesc')}</p>
        </Row>
      </Section>

      {/* ========================================================= */}
      {/* ADVANCED: reasoning, diagnostics, snapshot, debug export */}
      {/* ========================================================= */}
      <Section
        title={tx('sectionAdvanced', 'Advanced')}
        subtitle={t('diagnosticsDesc')}
        open={openSections.advanced}
        onToggle={() => toggleSection('advanced')}
        id={sectionDomId('advanced')}
      >
        <Row>
          <label className="block t-label text-[var(--app-text-muted)]">{t('reasoningEffort')}</label>
          <div className="pt-2">
            <Segmented
              stretch
              groupLabel={t('reasoningEffort')}
              options={EFFORT_LEVELS.map(({ id: lvl, label }) => ({ id: lvl, label }))}
              value={settings.reasoningEffort}
              onSelect={(lvl) => {
                const opt = EFFORT_LEVELS.find((o) => o.id === lvl);
                saveThenToast(
                  { reasoningEffort: lvl },
                  `${t('reasoningEffort')}: ${opt ? opt.label : lvl}`,
                  'success'
                );
              }}
            />
          </div>
        </Row>

        <Row>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="t-body text-[var(--app-text)]">{t('diagnosticsTitle')}</p>
              <p className="t-caption text-[var(--app-text-muted)] mt-1">{t('diagnosticsDesc')}</p>
            </div>
            <button
              onClick={handleRunDoctor}
              disabled={runningDoctor}
              className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer disabled:opacity-50 shrink-0"
            >
              {runningDoctor ? tx('diagnosticsRunning', 'Running diagnostics…') : t('runDiagnostics')}
            </button>
          </div>
          <div className="pt-2">
            {runningDoctor && (
              <StateNote state="loading" message={tx('diagnosticsRunning', 'Running diagnostics…')} />
            )}
            {!runningDoctor && !doctorReport && (
              <StateNote
                state={connected ? 'empty' : 'offline'}
                message={
                  connected
                    ? tx('diagnosticsNone', 'No diagnostics run yet.')
                    : tx('diagnosticsOffline', 'Hermes is offline. Diagnostics need it running.')
                }
              />
            )}
            {doctorReport && (
              <div className="space-y-2 pt-1">
                <p className={`t-label ${doctorReport.ok ? 'text-[var(--app-success)]' : 'text-[var(--app-danger)]'}`} role="status">
                  {plainResultLine(
                    doctorReport.summary,
                    tx('diagnosticsFailedPlain', 'The diagnostics run did not finish. Try again.'),
                    tx,
                  )}
                </p>
                <div className="space-y-2">
                  {doctorReport.checks.map((c, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 border-b border-[var(--app-border-subtle)] last:border-0 t-label">
                      {c.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-[var(--app-success)] shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-[var(--app-danger)] shrink-0" />
                      )}
                      <span className="min-w-0 break-words text-[var(--app-text)]">{c.name}</span>
                      <span className="t-caption text-[var(--app-text-dim)] ms-auto min-w-0 max-w-full break-words">{c.detail}</span>
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
              <p className="t-body text-[var(--app-text)]">{tx('snapshotTitlePlain', 'Snapshot')}</p>
              <p className="t-caption text-[var(--app-text-muted)] mt-1">
                {tx('snapshotDescPlain', 'Saves your chats, scheduled tasks, and settings. Keys are not included.')}
              </p>
              <button
                onClick={handleRunBackup}
                disabled={runningBackup}
                className="hm-hit w-full inline-flex items-center justify-center px-4 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer mt-2 disabled:opacity-50"
              >
                {runningBackup ? t('backingUp') : t('createSnapshot')}
              </button>
              {runningBackup && <div className="pt-2"><StateNote state="loading" message={tx('snapshotRunning', 'Saving the snapshot…')} /></div>}
              {backupResult && (
                <div className="pt-2 space-y-2">
                  <p className={`t-caption ${backupResult.ok ? 'text-[var(--app-success)]' : 'text-[var(--app-danger)]'}`} role="status">
                    {backupResult.ok
                      ? tx('backupOkPill', 'Saved')
                      : plainResultLine(
                          backupResult.message,
                          tx('snapshotFailedPlain', 'The snapshot was not saved. Try again.'),
                          tx,
                        )}
                  </p>
                  {backupResult.ok && backupResult.path && (
                    <p className="t-micro text-[var(--app-text-dim)] font-mono truncate" title={backupResult.path}>
                      {backupResult.path}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="py-1">
              <p className="t-body text-[var(--app-text)]">{tx('debugTitlePlain', 'Diagnostics bundle')}</p>
              <p className="t-caption text-[var(--app-text-muted)] mt-1">
                {tx('debugDescPlain', 'Exports the app version, service status, and recent logs, with secrets removed.')}
              </p>
              <button
                onClick={handleShareDebug}
                disabled={sharingDebug}
                className="hm-hit w-full inline-flex items-center justify-center px-4 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer mt-2 disabled:opacity-50"
              >
                {sharingDebug ? t('exporting') : t('generateBundle')}
              </button>
              {sharingDebug && <div className="pt-2"><StateNote state="loading" message={tx('debugRunning', 'Removing secrets and exporting…')} /></div>}
              {debugResult && (
                <div className="pt-2 space-y-2">
                  <p
                    className={`t-caption ${debugResult.ok ? 'text-[var(--app-accent-text)]' : 'text-[var(--app-danger)]'}`}
                    role="status"
                  >
                    {plainResultLine(
                      debugResult.summary,
                      tx('debugFailedPlain', 'The diagnostics bundle was not exported. Try again.'),
                      tx,
                    )}
                  </p>
                  {debugResult.urls.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="block t-caption text-[var(--app-accent-text)] underline truncate"
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
            className="fixed inset-0 z-[60] flex items-end justify-center bg-[var(--app-scrim)] backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setMenuProviderId(null)}
          >
            <div
              ref={providerMenuRef}
              role="dialog"
              aria-modal="true"
              aria-label={`${tx('profileActions', 'Profile actions')}: ${prov.name}`}
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-md r-md elev-3 bg-[var(--app-card)] edge p-4 space-y-1 pb-[calc(6.5rem+var(--safe-bottom))]"
            >
              <div className="px-3 pt-1 pb-3 border-b border-[var(--app-border-subtle)]">
                <p className="t-body text-[var(--app-text)] truncate">{prov.name}</p>
                <p className="t-micro text-[var(--app-text-dim)] font-mono truncate mt-1">
                  {prov.defaultModel || t('defaultModelShort')} · {prov.baseUrl ? t('customProxy') : t('officialEndpoint')}
                </p>
              </div>
              {!isActive && (
                <button
                  onClick={() => handleUseProvider(prov)}
                  className="w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-label text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition-colors"
                >
                  <Check className="w-4 h-4 text-[var(--app-accent-text)] shrink-0" />
                  <span>{t('use')}</span>
                </button>
              )}
              <button
                onClick={() => handleEditProvider(prov)}
                className="w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-label text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition-colors"
              >
                <Pencil className="w-4 h-4 text-[var(--app-text-muted)] shrink-0" />
                <span>{t('edit')}</span>
              </button>
              <button
                onClick={() => {
                  void handleTestProvider(prov);
                }}
                className="w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-label text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition-colors"
              >
                <ShieldCheck className="w-4 h-4 text-[var(--app-text-muted)] shrink-0" />
                <span>{t('testKey')}</span>
              </button>
              {/* Destructive action, set off by a rule and never adjacent to a
                  primary action. */}
              <div className="pt-2 mt-2 border-t border-[var(--app-border-subtle)]">
                <button
                  onClick={() => handleDeleteFromMenu(prov)}
                  aria-label={`${t('delete')} ${prov.name}`}
                  className={`w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-label cursor-pointer transition-colors ${
                    armed
                      ? 'bg-[var(--app-danger-subtle)] text-[var(--app-danger)] border border-[var(--app-danger-border)]'
                      : 'text-[var(--app-danger)] hover:bg-[var(--app-danger-subtle)]'
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
      {showSkillsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--app-scrim)] backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowSkillsModal(false)}
        >
          <div
            ref={skillsModalRef}
            role="dialog"
            aria-modal="true"
            aria-label={tx('skillsTitle', 'Skills')}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm r-md elev-3 bg-[var(--app-card)] edge p-5 space-y-4 max-h-[80vh] overflow-y-auto overflow-x-clip"
          >
            <div className="flex items-center justify-between pb-3 border-b border-[var(--app-border-subtle)]">
              <span className="t-heading text-[var(--app-text)]">{tx('skillsTitle', 'Skills')}</span>
              <button
                onClick={() => setShowSkillsModal(false)}
                aria-label={t('cancel')}
                className="w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <StateNote
              state={skillsState}
              message={
                skillsState === 'loading' ? tx('skillLoadingPlain', 'Loading skills…') :
                skillsState === 'empty' && skillsNote ? skillsNote :
                skillsState === 'empty' ? tx('skillEmptyPlain', 'No skills installed yet.') :
                skillsState === 'offline' ? tx('skillOfflinePlain', 'Hermes is offline. Skill switches are unavailable.') :
                skillsState === 'error' ? tx('skillErrorPlain', 'Skills could not load.') :
                skillsState === 'refreshing' ? tx('skillRefreshingPlain', 'Refreshing skills…') : ''
              }
              onRetry={() => {
                void refreshLibrary();
              }}
            />
            {skillToggleDead && (
              <p className="t-caption text-[var(--app-text-dim)]">
                {tx('toggleUnsupportedPlain', 'This server does not support that switch.')}
              </p>
            )}
            {skills.map((sk) => (
              <div key={sk.id} className="flex items-center justify-between gap-3 py-2">
                <div className="pe-3 min-w-0">
                  <p className="t-label text-[var(--app-text)]">{sk.name}</p>
                  <p className="t-caption text-[var(--app-text-muted)] mt-1">{sk.description}</p>
                </div>
                <Switch
                  checked={sk.enabled}
                  disabled={skillToggleDead}
                  onChange={() => handleToggleSkill(sk.id, sk.enabled)}
                  ariaLabel={`${sk.name}: ${sk.enabled ? t('skillEnabled') : t('skillDisabled')}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {selectedBlueprint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--app-scrim)] backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setSelectedBlueprint(null)}
        >
          <div
            ref={blueprintModalRef}
            role="dialog"
            aria-modal="true"
            aria-label={selectedBlueprint.name}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm r-md elev-3 bg-[var(--app-card)] edge p-5 space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-[var(--app-border-subtle)]">
              <span className="t-heading text-[var(--app-text)]">{selectedBlueprint.name}</span>
              <button
                onClick={() => setSelectedBlueprint(null)}
                aria-label={t('cancel')}
                className="w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="t-caption text-[var(--app-text-muted)]">{selectedBlueprint.description}</p>
            {selectedBlueprint.parameters && selectedBlueprint.parameters.length > 0 && (
              <div className="space-y-3 pt-1">
                {selectedBlueprint.parameters.map((param) => (
                  <div key={param.name}>
                    <label className="block t-label text-[var(--app-text-muted)] mb-1">
                      {param.label || humanizeKey(param.name)}
                    </label>
                    <input
                      type="text"
                      value={blueprintSlots[param.name] || ''}
                      onChange={(e) =>
                        setBlueprintSlots({
                          ...blueprintSlots,
                          [param.name]: e.target.value,
                        })
                      }
                      className="w-full px-3 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)]"
                    />
                    {/* Raw parameter key kept as the mono detail line. */}
                    <p className="t-micro text-[var(--app-text-dim)] font-mono mt-1">{param.name}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setSelectedBlueprint(null)}
                className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm t-label text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                onClick={() => handleInstantiateBlueprint(selectedBlueprint.id)}
                className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] cursor-pointer transition"
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
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--app-scrim)] backdrop-blur-xs animate-in fade-in duration-150"
        >
          <div
            ref={addModalRef}
            role="dialog"
            aria-modal="true"
            aria-label={editingProviderId ? t('editModelProvider') : t('addModelProvider')}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md r-md elev-3 bg-[var(--app-card)] edge p-5 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between pb-3 border-b border-[var(--app-border-subtle)]">
              <span className="t-heading text-[var(--app-text)]">
                {editingProviderId ? t('editModelProvider') : t('addModelProvider')}
              </span>
              <button
                onClick={closeAddModal}
                aria-label={t('cancel')}
                className="w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block t-label text-[var(--app-text-muted)] mb-1">{t('modelCatalog')}</label>
                <select
                  value={newProvType}
                  autoFocus
                  onChange={(e) => {
                    const val = e.target.value;
                    setNewProvType(val);
                    const opt = PROVIDER_OPTIONS.find(([id]) => id === val);
                    if (opt) setNewProvName(opt[1]);
                    // A provider change invalidates everything tested before:
                    // key verdict, fingerprint, model list. Without this the
                    // modal keeps showing the previous provider's green
                    // "works" next to the new provider's name.
                    setKeyResult(null);
                    setKeyOk(null);
                    setTestedFingerprint('');
                    setTestedModels([]);
                    setCustomModelMode(false);
                    // Pre-fill the static default so Save is not stuck
                    // disabled behind a placeholder that looks populated.
                    if (!newProvModel.trim()) {
                      const def = DEFAULT_MODELS[val]?.[0] || '';
                      if (def) setNewProvModel(def);
                    }
                  }}
                  className="w-full px-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)]"
                >
                  <option value="" disabled>
                    {t('selectProvider')}
                  </option>
                  {PROVIDER_OPTIONS.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block t-label text-[var(--app-text-muted)] mb-1">{t('profileLabel')}</label>
                <input
                  type="text"
                  value={newProvName}
                  onChange={(e) => setNewProvName(e.target.value)}
                  placeholder={t('profilePlaceholder')}
                  className="w-full px-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)]"
                />
              </div>
              <div>
                <label className="block t-label text-[var(--app-text-muted)] mb-1">
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
                    placeholder="sk-…"
                    aria-label={t('apiKey')}
                    className="w-full px-4 py-3 pe-10 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewKey(!showNewKey)}
                    aria-pressed={showNewKey}
                    aria-label={showNewKey ? tx('hideToken', 'Hide token') : tx('showToken', 'Show token')}
                    className="absolute end-2 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center r-sm hm-hit text-[var(--app-text-dim)] hover:text-[var(--app-text)] cursor-pointer"
                  >
                    {showNewKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <button
                    type="button"
                    onClick={handleTestKey}
                    disabled={(!newProvKey.trim() && !KEYLESS_PROVIDERS.has(normProvider(newProvType))) || testingKey}
                    className="hm-hit inline-flex items-center px-3 py-2 min-h-[36px] r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition cursor-pointer disabled:opacity-40"
                  >
                    {testingKey ? t('testingKey') : t('testKey')}
                  </button>
                  {testingKey && <span className="t-caption text-[var(--app-text-muted)]">{tx('testingKeyPlain', 'Testing…')}</span>}
                  {keyResult && (
                    <span
                      className={`t-caption ${
                        keyOk === true ? 'text-[var(--app-success)]' : keyOk === false ? 'text-[var(--app-danger)]' : 'text-[var(--app-warning)]'
                      }`}
                    >
                      {keyResult}
                    </span>
                  )}
                </div>
              </div>
              <div>
                <label className="block t-label text-[var(--app-text-muted)] mb-1">{t('defaultModel')}</label>
                {testedModels.length > 0 ? (
                  <>
                    <select
                      value={customModelMode || !testedModels.includes(newProvModel) ? '__custom' : newProvModel}
                      onChange={(e) => {
                        if (e.target.value === '__custom') {
                          // Enter custom mode without clearing: the typed text
                          // stays, and typing a listed prefix no longer
                          // unmounts the input mid-keystroke.
                          setCustomModelMode(true);
                        } else {
                          setCustomModelMode(false);
                          setNewProvModel(e.target.value);
                        }
                      }}
                      className="w-full px-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono cursor-pointer"
                    >
                      {testedModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom">
                        {tx('customModelPlain', 'Custom model…')}
                      </option>
                    </select>
                    {(customModelMode || !testedModels.includes(newProvModel)) && (
                      <input
                        type="text"
                        value={newProvModel}
                        onChange={(e) => setNewProvModel(e.target.value)}
                        placeholder={tx('customModelPlaceholder', 'Type the exact model id')}
                        className="mt-2 w-full px-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                      />
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    value={newProvModel}
                    onChange={(e) => setNewProvModel(e.target.value)}
                    placeholder={DEFAULT_MODELS[newProvType]?.[0] || 'e.g. gpt-4o, claude-3-7-sonnet'}
                    className="w-full px-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                  />
                )}
              </div>
              <div>
                <label className="block t-label text-[var(--app-text-muted)] mb-1">{t('baseUrl')}</label>
                <input
                  type="text"
                  value={newProvBaseUrl}
                  onChange={(e) => setNewProvBaseUrl(e.target.value)}
                  placeholder={tx('baseUrlPlaceholder', 'https://api.openai.com/v1')}
                  className="w-full px-4 py-3 r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] font-mono"
                />
              </div>
            </div>
            {!keysValid(newProvType, newProvKey, newProvBaseUrl) && (
              <p className="t-caption text-[var(--app-warning)]">
                {!newProvKey.trim() ? t('keyRequired') : t('unknownProviderUrl')}
              </p>
            )}
            {!editingProviderId && (
              <label className="flex items-start gap-3 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activateNewProvider}
                  onChange={(e) => setActivateNewProvider(e.target.checked)}
                  className="mt-1 w-4 h-4 r-xs accent-[var(--app-accent)]"
                />
                <span className="t-caption text-[var(--app-text-muted)]">
                  {tx('activateAfterSave', 'Activate this profile after saving. New profiles stay inactive unless you opt in.')}
                </span>
              </label>
            )}
            <div className="flex justify-end gap-2 pt-3 border-t border-[var(--app-border-subtle)]">
              <button
                onClick={closeAddModal}
                className="hm-hit inline-flex items-center px-4 py-2 min-h-[36px] r-sm t-label text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                disabled={!keysValid(newProvType, newProvKey, newProvBaseUrl) || !newProvModel.trim() || applyingProvider}
                onClick={async () => {
                  // Busy guard: a second tap must not start a second restart.
                  if (applyBusyRef.current) {
                    showToast(tx('applyBusy', 'A provider change is already being applied. Wait for it to finish.'), 'info');
                    return;
                  }
                  const cleanedKey = newProvKey.trim();
                  const baseUrl = newProvBaseUrl.trim();
                  // No silent model fallback: the profile stores exactly the
                  // model the user typed. Save stays disabled until one is set.
                  const targetModel = newProvModel.trim();
                  const label = newProvName.trim() || PROVIDER_OPTIONS.find(([id]) => id === newProvType)?.[1] || providerLabel(newProvType);
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
                      const before = saveSnapshot();
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
                      restartedMsg: `${t('updatedItem')} ${label}. ${tx('serverRestartedShort', 'Hermes restarted.')}`,
                    });
                    return;
                  }

                  let createdId: string | null = null;
                  const outcome = await runVerifiedWrite(async () => {
                    const before = saveSnapshot();
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
                      restartedMsg: `${t('addedActivated')} ${label}. ${tx('serverRestartedShort', 'Hermes restarted.')}`,
                    });
                  } else {
                    showToast(`${tx('addedInactive', 'Added (inactive)')} ${label}`, 'success');
                    void refreshModels();
                  }
                }}
                className="hm-hit inline-flex items-center px-5 py-2 min-h-[36px] r-sm t-label bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] disabled:opacity-40 text-[var(--app-on-accent)] cursor-pointer transition"
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
