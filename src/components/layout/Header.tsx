import React, { useEffect, useMemo, useRef, useState } from 'react';
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

// Extra failure-flag spellings, probed in addition to the typed context
// fields. HomeTab probes the same variants, and the two screens must never
// answer differently about one connection.
interface GatewayFailureSignals {
  gatewayUnauthorized?: boolean;
  gatewayAuthFailed?: boolean;
  gatewayAuthRejected?: boolean;
  unauthorized?: boolean;
  authFailed?: boolean;
}

// Exactly the rule HomeTab applies to the list sync envelopes: an
// authenticated list call rejected (HTTP 401/403 while health stayed green)
// means the stored key is stale, not that the server is offline.
const AUTH_FAILURE_RE = /401|403|auth/i;
const AUTH_FAILURE_PATTERN = /401|403|unauthori[sz]ed|forbidden|rejected the key|invalid (api )?key|server key/i;

const APP_TITLE = 'Hermes Agent';

// Canonical screen names. Keys mirror constants/languages.ts so BottomNav,
// DesktopSidebar and this header never diverge.
const SCREEN_TITLE: Record<number, { key: string; fallback: string }> = {
  0: { key: 'tabHome', fallback: 'Home' },
  1: { key: 'tabChat', fallback: 'Chat' },
  2: { key: 'tabJobs', fallback: 'Jobs' },
  3: { key: 'tabSettings', fallback: 'Settings' },
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
    listsMeta,
    models,
    settings,
    gatewayFailed,
    gatewayFailureKind,
    gatewayFailureReason,
    gatewayStatus,
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

  // The pill and the Home status card describe ONE connection, so this reads
  // the same signals in the same order HomeTab does: a reachable server that
  // rejects the key is a failure (not connected), a failed install or start
  // is a failure, and neither may ever be reported as connected just because
  // the health check happens to answer.
  const signals = hermes as unknown as GatewayFailureSignals;
  const failureText = `${gatewayFailureReason || ''} ${gatewayStatus?.detail || ''}`;
  const authFailureFromLists = [listsMeta['sessions'], listsMeta['jobs']].some(
    (meta) => !!meta?.error && AUTH_FAILURE_RE.test(meta.error)
  );
  const isUnauthorized =
    gatewayFailureKind === 'unauthorized' ||
    signals.gatewayUnauthorized === true ||
    signals.gatewayAuthFailed === true ||
    signals.gatewayAuthRejected === true ||
    signals.unauthorized === true ||
    signals.authFailed === true ||
    AUTH_FAILURE_PATTERN.test(failureText) ||
    authFailureFromLists;
  const isFailed = gatewayFailed === true || install === 'FAILED' || isUnauthorized;

  const statusState: 'connected' | 'starting' | 'failed' | 'offline' = isFailed
    ? 'failed'
    : isHealthy
      ? 'connected'
      : isConnecting
        ? 'starting'
        : 'offline';

  const statusLabel =
    statusState === 'connected'
      ? tx('connected', 'Connected')
      : statusState === 'starting'
        ? tx('statusConnecting', 'Connecting…')
        : statusState === 'failed'
          ? isUnauthorized
            ? tx('keyNotAccepted', 'Key not accepted')
            : tx('couldNotConnect', 'Could not connect')
          : tx('notConnected', 'Not connected');

  // The single status pill reads the real gateway state through the shared
  // badge vocabulary: connected success, starting warning, failed and
  // key-rejected danger, offline neutral.
  const statusPillClass =
    statusState === 'connected'
      ? 'pill-success'
      : statusState === 'starting'
        ? 'pill-warning'
        : statusState === 'failed'
          ? 'pill-danger'
          : 'pill-neutral';

  const statusDotColor =
    statusState === 'connected'
      ? 'var(--app-success)'
      : statusState === 'starting'
        ? 'var(--app-warning)'
        : statusState === 'failed'
          ? 'var(--app-danger)'
          : 'var(--app-text-dim)';

  const statusTitle =
    statusState === 'failed'
      ? isUnauthorized
        ? tx('keyNotAcceptedHint', 'The Hermes server did not accept the key. Open Settings and paste the right key.')
        : gatewayFailureReason
          ? localizedMessage(toAppError(new Error(String(gatewayFailureReason))), lang)
          : tx('noReplyFromServer', 'The Hermes server did not respond. Make sure it is running, then retry.')
      : statusState === 'offline'
        ? tx('notConnectedHint', 'Not connected to the Hermes server. Messages you send are kept and sent when it is back.')
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

  // The chip used to print settings.modelId straight out, so a bare provider
  // id read as if it were a model name and an unset model left a dangling
  // colon. Resolve the friendly label from the loaded model list, fall back to
  // the model part of the id, and show no chip when there is no model to name.
  const activeModelLabel = useMemo(() => {
    const id = (settings?.modelId || '').trim();
    if (!id) return null;
    const known = models.find((m) => m.id === id);
    const friendly = (known?.displayName || '').trim();
    if (friendly) return friendly;
    const tail = id.split('/').pop() || '';
    const provider = (settings?.provider || '').trim().toLowerCase();
    // A bare provider id (no model segment) names the provider, not a model.
    if (!tail || (tail === id && tail.toLowerCase() === provider)) return null;
    return tail;
  }, [models, settings?.modelId, settings?.provider]);

  const approvalCount = approvals.length;
  // The badge says what it counts, so a bare "3" can never read as unread
  // messages.
  const approvalsWaiting =
    approvalCount === 1
      ? tx('approvalsWaitingOne', '1 approval waiting for you')
      : tx('approvalsWaitingMany', '{count} approvals waiting for you').replace(
          '{count}',
          String(approvalCount)
        );
  const moreOptionsLabel =
    approvalCount > 0
      ? `${tx('moreOptions', 'More options')}, ${approvalsWaiting}`
      : tx('moreOptions', 'More options');

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
      className="sticky top-0 z-30 backdrop-blur-xl border-b elev-2 edge flex items-center justify-between gap-2 px-3 sm:px-4 py-2"
      style={{
        backgroundColor: 'var(--app-bg)',
        // Edge-to-edge (viewport-fit=cover, targetSdk 36): the status bar and
        // notch overlay the top of the viewport, so the header must inset
        // itself or its content sits under the system bar. minHeight reserves
        // a full 56px content strip BELOW the inset so the bar never measures
        // short and never clips its children.
        paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))',
        minHeight: 'calc(3.5rem + env(safe-area-inset-top, 0px))',
      }}
    >
      {/* Left Area: Mobile Drawer or Desktop Sidebar Toggle + Screen Title.
          With the app name on stage this group never shrinks, so no squeeze
          from the right can reach the name; a screen name may shrink and clip
          instead of pushing the controls out of reach. */}
      <div className={`flex items-center gap-2 ${isHomeTitle ? 'shrink-0' : 'min-w-0'}`}>
        {!isDesktop ? (
          <button
            onClick={onOpenDrawer}
            className="min-w-[44px] min-h-[44px] r-xs edge flex items-center justify-center shrink-0 text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] active:scale-95 transition-all"
            title={tx('openChats', 'Open chats')}
            aria-label={tx('openChats', 'Open chats')}
          >
            <Menu className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={onToggleSidebar}
            className="min-w-[44px] min-h-[44px] r-xs flex items-center justify-center shrink-0 text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition"
            title={sidebarCollapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
            aria-label={sidebarCollapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
          >
            {sidebarCollapsed ? <SidebarOpen className="w-4 h-4 rtl-flip" /> : <SidebarClose className="w-4 h-4 rtl-flip" />}
          </button>
        )}

        <div className="flex items-center gap-2 min-w-0">
          {/* Brand mark. It only earns its 32px beside the app name where the
              bar is wide enough to hold menu + mark + name + status pill
              without squeezing the name; on a 360dp phone it does not, so
              below 400px the name owns the space and the mark stands down. */}
          {!isDesktop && isHomeTitle && (
            <div
              className="hidden min-[400px]:flex w-8 h-8 r-xs edge p-1 items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--app-accent-subtle)' }}
            >
              <img
                src="/ic_hermes_logo.png"
                alt={tx('appLogoAlt', 'Hermes logo')}
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            </div>
          )}
          <div className="flex items-center gap-2 min-w-0">
            {/* The app name is never truncated: it keeps its full width and the
                row gives up space elsewhere. A screen name may truncate, since
                it is a label for the tab you just picked, not an identity. */}
            <span
              className={`t-title font-semibold tracking-tight text-[var(--app-text)] ${
                isHomeTitle ? 'whitespace-nowrap shrink-0' : 'truncate'
              }`}
              aria-live="polite"
            >
              {screenTitle}
            </span>
            {isHomeTitle && activeModelLabel && (
              <span className="t-micro font-mono text-[var(--app-text-dim)] hidden sm:block truncate min-w-0">
                {tx('activeModel', 'Active model')}: {activeModelLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right Area: one status element + one overflow menu entry. It can
          shrink, so on a very narrow screen the pill label ellipsizes before
          the app name does: the colour, the dot, the title and the aria label
          all still carry the full state. */}
      <div className="flex items-center gap-2 min-w-0">
        {/* Connection status indicator. role=status + aria-label so the colour
            dot is never the only signal, and the text label stays visible at
            every width, including the failed/unauthorized honesty states. */}
        <div
          role="status"
          aria-live="polite"
          aria-label={`${tx('connectionStatus', 'Connection status')}: ${statusLabel}`}
          title={statusTitle}
          className={`flex items-center gap-1 min-w-0 h-6 px-2 ${statusPillClass}`}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            aria-hidden="true"
            style={{
              backgroundColor: statusDotColor,
              boxShadow:
                statusState === 'connected' || statusState === 'failed'
                  ? `0 0 8px ${statusDotColor}`
                  : undefined,
            }}
          />
          <span className="t-caption font-medium truncate">
            {statusLabel}
          </span>
        </div>

        {/* Overflow menu: token telemetry, approvals and the inspector toggle. */}
        <div className="relative shrink-0" ref={menuWrapRef}>
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            className={`relative min-w-[44px] min-h-[44px] r-xs edge flex items-center justify-center transition cursor-pointer ${
              menuOpen
                ? 'bg-[var(--app-card-hover)] text-[var(--app-text)]'
                : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)]'
            }`}
            title={moreOptionsLabel}
            aria-label={moreOptionsLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreVertical className="w-4 h-4" />
            {approvalCount > 0 && (
              <span
                className="absolute -top-1 -end-1 pill-danger font-mono font-semibold"
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
                className="absolute end-0 top-full mt-2 z-50 w-56 r-sm edge elev-2 p-1"
                style={{ backgroundColor: 'var(--app-card)' }}
              >
                {/* Token telemetry, formerly its own bordered pill. */}
                <div
                  className="px-3 py-2 r-xs mb-1 bg-[var(--app-card-subtle)]"
                  aria-label={tx('tokenUsage', 'Tokens used')}
                >
                  <div className="flex items-center justify-between gap-2 t-micro font-mono text-[var(--app-text-muted)]">
                    <span className="text-[var(--app-text-dim)]">{tx('tokens', 'Tokens')}</span>
                    <span className="flex items-center gap-2">
                      <span title={tx('promptTokens', 'Tokens sent to the model')}>↑ {fmtTok(usageIn)}</span>
                      <span className="text-[var(--app-text-dim)]">·</span>
                      <span title={tx('outputTokens', 'Tokens received from the model')}>↓ {fmtTok(usageOut)}</span>
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
                    className="w-full min-h-[44px] px-3 flex items-center gap-3 r-xs t-body text-[var(--app-danger)] hover:bg-[var(--app-danger-subtle)] transition cursor-pointer"
                  >
                    <AlertCircle className="w-4 h-4 text-[var(--app-danger)]" />
                    <span>{approvalsWaiting}</span>
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
                    className={`w-full min-h-[44px] px-3 flex items-center gap-3 r-xs t-body transition cursor-pointer ${
                      inspectorOpen
                        ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)]'
                        : 'text-[var(--app-text-muted)] hover:bg-[var(--app-card-hover)] hover:text-[var(--app-text)]'
                    }`}
                  >
                    {inspectorOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
                    <span>{tx('inspectorMenuLabel', 'Technical details')}</span>
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
