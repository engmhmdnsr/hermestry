import React, { useEffect, useRef, useState } from 'react';
import {
  Menu,
  AlertCircle,
  SidebarClose,
  SidebarOpen,
  PanelRightClose,
  PanelRightOpen,
  MoreVertical,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { localizedMessage, toAppError } from '../../services/appErrors';

interface HeaderProps {
  onOpenDrawer: () => void;
  // Approvals are actioned in the Chat tab (ApprovalCard queue), so the
  // header approvals badge routes there, not to Settings.
  onGoApprovals: () => void;
  isDesktop?: boolean;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  // Which screen is on stage: either an explicit title, or the active tab
  // index (0 Home, 1 Chat, 2 Jobs, 3 Settings). With neither supplied the
  // header keeps its previous behaviour and shows the app name.
  activeTab?: number;
  title?: string;
}

// Gateway failure signals read defensively: the context carries at least
// `connected`, and sibling work adds an explicit failure/unauthorized flag.
// Any of these naming variants is honoured, and the raw failure reason /
// health detail are pattern matched as a fallback so a rejected key never
// renders as a plain "Offline".
interface GatewayFailureSignals {
  gatewayFailed?: boolean;
  gatewayFailureKind?: string;
  gatewayUnauthorized?: boolean;
  gatewayAuthFailed?: boolean;
  gatewayAuthRejected?: boolean;
  unauthorized?: boolean;
  authFailed?: boolean;
  gatewayFailureReason?: string | null;
  gatewayStatus?: { ok?: boolean; detail?: string } | null;
}

const AUTH_FAILURE_PATTERN = /401|403|unauthori[sz]ed|forbidden|rejected the key|invalid (api )?key|server key/i;

const APP_TITLE = 'Hermes Agent';

// Canonical screen names. Keys mirror constants/languages.ts so BottomNav,
// DesktopSidebar and this header never diverge.
const SCREEN_TITLE: Record<number, { key: string; fallback: string }> = {
  0: { key: 'home', fallback: 'Overview' },
  1: { key: 'chat', fallback: 'Workspace Chat' },
  2: { key: 'jobs', fallback: 'Cron & Tasks' },
  3: { key: 'settings', fallback: 'Ops & Settings' },
};

// App.tsx persists the active tab as this hash (and mirrors it to
// localStorage). When no title/activeTab prop is passed the header reads the
// same read-only signal so the screen name still tracks navigation instead of
// being stuck on the app name. The prop always wins when it is supplied.
const TAB_HASHES = ['#/home', '#/chat', '#/jobs', '#/settings'];
const TAB_STORAGE_KEY = 'hermes_current_tab';

function readPersistedTab(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromHash = TAB_HASHES.indexOf(window.location.hash);
    if (fromHash >= 0) return fromHash;
    const saved = parseInt(localStorage.getItem(TAB_STORAGE_KEY) || '', 10);
    if (Number.isInteger(saved) && saved >= 0 && saved < TAB_HASHES.length) return saved;
  } catch {
    // Storage can be unavailable (private mode); the app name is the fallback.
  }
  return null;
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenDrawer,
  onGoApprovals,
  isDesktop = false,
  inspectorOpen = false,
  onToggleInspector,
  sidebarCollapsed = false,
  onToggleSidebar,
  activeTab,
  title,
}) => {
  const hermes = useHermes();
  const {
    connected,
    install,
    usageIn,
    usageOut,
    approvals,
    settings,
    t,
  } = hermes;

  // English fallback for keys a locale bundle does not ship, so a missing key
  // never renders a raw key name in the status pill.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
  const lang = settings?.language || 'en';

  const isHealthy = connected;
  const isConnecting = install === 'RUNNING' || install === 'INSTALLING';

  // A gateway that is reachable but rejects the key is NOT offline: it fails.
  const signals = hermes as unknown as GatewayFailureSignals;
  const failureText = `${signals.gatewayFailureReason || ''} ${signals.gatewayStatus?.detail || ''}`;
  const isUnauthorized =
    signals.gatewayFailureKind === 'unauthorized' ||
    signals.gatewayUnauthorized === true ||
    signals.gatewayAuthFailed === true ||
    signals.gatewayAuthRejected === true ||
    signals.unauthorized === true ||
    signals.authFailed === true ||
    AUTH_FAILURE_PATTERN.test(failureText);
  const isFailed = !isHealthy && (signals.gatewayFailed === true || isUnauthorized);

  const statusState: 'connected' | 'starting' | 'failed' | 'offline' = isHealthy
    ? 'connected'
    : isConnecting
      ? 'starting'
      : isFailed
        ? 'failed'
        : 'offline';

  const statusLabel =
    statusState === 'connected'
      ? tx('connected', 'Connected')
      : statusState === 'starting'
        ? tx('starting', 'Starting')
        : statusState === 'failed'
          ? isUnauthorized
            ? tx('gatewayKeyRejected', 'Key rejected')
            : tx('connectionFailed', 'Connection failed')
          : tx('offline', 'Offline');

  const statusDotClass =
    statusState === 'connected'
      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
      : statusState === 'starting'
        ? 'bg-amber-400 animate-pulse'
        : statusState === 'failed'
          ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]'
          : 'bg-slate-500';

  const statusTitle =
    statusState === 'failed'
      ? isUnauthorized
        ? tx('gatewayKeyRejectedHint', 'The gateway rejected the server key. Check the gateway key in Settings.')
        : signals.gatewayFailureReason
          ? localizedMessage(toAppError(new Error(String(signals.gatewayFailureReason))), lang)
          : tx('connectionFailedHint', 'The gateway did not respond. Check that it is running.')
      : statusLabel;

  // Which screen are we on? An explicit title wins; otherwise the active tab
  // index maps to its canonical name. When neither prop is passed the header
  // falls back to the persisted tab (same signal App.tsx writes), and only
  // with no signal at all does it show the app title.
  const hasTitle = typeof title === 'string' && title.trim().length > 0;
  const hasTabProp = typeof activeTab === 'number';
  const [persistedTab, setPersistedTab] = useState<number | null>(() => readPersistedTab());

  useEffect(() => {
    if (hasTitle || hasTabProp) return;
    const onHashChange = () => setPersistedTab(readPersistedTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [hasTitle, hasTabProp]);

  const tabIndex = hasTabProp ? (activeTab as number) : persistedTab;
  const screenEntry = typeof tabIndex === 'number' ? SCREEN_TITLE[tabIndex] : undefined;
  const screenTitle = hasTitle
    ? (title as string)
    : screenEntry
      ? tabIndex === 0
        ? APP_TITLE
        : tx(screenEntry.key, screenEntry.fallback)
      : APP_TITLE;
  const isHomeTitle = screenTitle === APP_TITLE;

  const approvalCount = approvals.length;
  const approvalLabel =
    approvalCount === 1
      ? tx('approvalNeeded', 'Approval')
      : tx('approvalsNeededPlural', 'Approvals');

  // Overflow menu: the token telemetry, approvals action and inspector toggle
  // used to be three separate bordered pills. At 360dp the pile overflowed the
  // bar and pushed the approvals action into the worst reach zone, so it now
  // collapses into a single control with one menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [menuOpen]);

  // Close the menu whenever the screen changes out from under it.
  useEffect(() => {
    setMenuOpen(false);
  }, [activeTab, isDesktop]);

  return (
    <header
      className="sticky top-0 z-30 backdrop-blur-xl border-b px-4 py-2.5 flex items-center justify-between gap-2"
      style={{
        backgroundColor: 'var(--app-bg, #090B14)',
        borderColor: 'var(--app-border, rgba(255,255,255,0.07))',
        // Edge-to-edge (viewport-fit=cover, targetSdk 36): the status bar and
        // notch overlay the top of the viewport, so the header must inset
        // itself or its content sits under the system bar. 0.625rem keeps the
        // previous py-2.5 spacing when the inset is 0 (web/desktop). minHeight
        // reserves a full 56px content strip BELOW the inset so the bar never
        // measures short and never clips its children.
        paddingTop: 'calc(0.625rem + env(safe-area-inset-top, 0px))',
        minHeight: 'calc(3.5rem + env(safe-area-inset-top, 0px))',
      }}
    >
      {/* Left Area: Mobile Drawer or Desktop Sidebar Toggle + Screen Title */}
      <div className="flex items-center gap-3 min-w-0">
        {!isDesktop ? (
          <button
            onClick={onOpenDrawer}
            className="min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-slate-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] active:scale-95 transition-all border border-white/[0.06] shrink-0"
            title={tx('openConversations', 'Open Conversations')}
            aria-label={tx('openConversations', 'Open Conversations')}
          >
            <Menu className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={onToggleSidebar}
            className="min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.05] transition shrink-0"
            title={sidebarCollapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
            aria-label={sidebarCollapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
          >
            {sidebarCollapsed ? <SidebarOpen className="w-4 h-4 rtl-flip" /> : <SidebarClose className="w-4 h-4 rtl-flip" />}
          </button>
        )}

        <div className="flex items-center gap-2.5 min-w-0">
          {!isDesktop && isHomeTitle && (
            <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-indigo-500/20 via-violet-500/20 to-teal-500/20 border border-indigo-500/30 p-1 flex items-center justify-center shrink-0">
              <img
                src="/ic_hermes_logo.png"
                alt="Hermes Logo"
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-white tracking-tight truncate" aria-live="polite">
                {screenTitle}
              </span>
              {isHomeTitle && (
                <span className="text-[11px] text-slate-500 font-mono hidden sm:inline">
                  {settings.modelId.split('/').pop()}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right Area: one status element + one overflow menu entry. */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Connection status indicator. role=status + aria-label so the colour
            dot is never the only signal, and the text label stays visible at
            every width, including the failed/unauthorized honesty states. */}
        <div
          role="status"
          aria-live="polite"
          aria-label={`${tx('gatewayStatus', 'Gateway status')}: ${statusLabel}`}
          title={statusTitle}
          className="flex items-center gap-1.5 text-xs bg-white/[0.02] px-2.5 h-6 rounded-lg border border-white/[0.05]"
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass}`} aria-hidden="true" />
          <span className="font-medium text-[11px] text-slate-200 whitespace-nowrap">
            {statusLabel}
          </span>
        </div>

        {/* Overflow menu: token telemetry, approvals and the inspector toggle. */}
        <div className="relative" ref={menuWrapRef}>
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            className={`relative min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center transition cursor-pointer border ${
              menuOpen
                ? 'bg-white/[0.08] text-white border-white/[0.1]'
                : 'text-slate-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06]'
            }`}
            title={tx('moreOptions', 'More options')}
            aria-label={tx('moreOptions', 'More options')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreVertical className="w-4 h-4" />
            {approvalCount > 0 && (
              <span
                className="absolute -top-1 -end-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white font-mono text-[9px] font-bold flex items-center justify-center"
                aria-hidden="true"
              >
                {approvalCount}
              </span>
            )}
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuOpen(false)}
                aria-hidden="true"
              />
              <div
                role="menu"
                aria-label={tx('moreOptions', 'More options')}
                className="absolute end-0 top-full mt-2 z-50 w-56 rounded-lg bg-[var(--app-card,#11151B)] border border-white/[0.1] shadow-2xl p-1"
              >
                {/* Token telemetry, formerly its own bordered pill. */}
                <div
                  className="px-2.5 py-1.5 rounded-lg bg-white/[0.03] mb-1"
                  aria-label={tx('tokenUsage', 'Token usage')}
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-slate-400">
                    <span className="text-slate-500">{tx('tokens', 'Tokens')}</span>
                    <span className="flex items-center gap-1.5">
                      <span title={tx('promptTokens', 'Prompt Input Tokens')}>↑ {fmtTok(usageIn)}</span>
                      <span className="text-slate-600">·</span>
                      <span title={tx('outputTokens', 'Generated Output Tokens')}>↓ {fmtTok(usageOut)}</span>
                    </span>
                  </div>
                </div>

                {approvalCount > 0 && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onGoApprovals();
                    }}
                    className="w-full min-h-[44px] px-2.5 flex items-center gap-2.5 rounded-lg text-xs text-rose-300 hover:bg-rose-500/10 transition cursor-pointer"
                  >
                    <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                    <span>{approvalCount} {approvalLabel}</span>
                  </button>
                )}

                {onToggleInspector && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleInspector();
                    }}
                    aria-expanded={inspectorOpen}
                    className={`w-full min-h-[44px] px-2.5 flex items-center gap-2.5 rounded-lg text-xs transition cursor-pointer ${
                      inspectorOpen
                        ? 'bg-indigo-600/20 text-indigo-300'
                        : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
                    }`}
                  >
                    {inspectorOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
                    <span>{t('inspector') || tx('inspector', 'Inspector')}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
};
