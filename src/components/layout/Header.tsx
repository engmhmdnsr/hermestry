import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu,
  AlertCircle,
  SidebarClose,
  SidebarOpen,
  PanelRightClose,
  PanelRightOpen,
  Zap,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import { localizedMessage, toAppError } from '../../services/appErrors';
import { AUTH_FAILURE_RE, TAB_HASHES } from '../../constants/tabs';
import { formatBadgeCount } from '../../utils/badge';

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

// The stored-key rejection signal itself is shared with HomeTab, it lives in
// constants/tabs.ts so both banners can never disagree about what counts as
// an auth failure. This broader pattern is only for localised failure *text*,
// which may name the key in words instead of carrying a status code.
const AUTH_FAILURE_PATTERN = /401|403|unauthori[sz]ed|forbidden|rejected the key|invalid (api )?key|server key/i;

const APP_TITLE = 'Hermes Agent';

// Canonical screen names. Keys mirror constants/languages.ts so BottomNav,
// DesktopSidebar and this header never diverge.
const SCREEN_TITLE: Record<number, { key: string; fallback: string }> = {
  0: { key: 'tabHome', fallback: 'Home' },
  1: { key: 'tabChat', fallback: 'Chat' },
  2: { key: 'tabTerminal', fallback: 'Terminal' },
  3: { key: 'tabSettings', fallback: 'Settings' },
};

// App.tsx persists the active tab as this hash (and mirrors it to
// localStorage). When no title/activeTab prop is passed the header reads the
// same read-only signal so the screen name still tracks navigation instead of
// being stuck on the app name. The prop always wins when it is supplied.
// TAB_HASHES comes from constants/tabs.ts, the one list both files use.
const TAB_STORAGE_KEY = 'hermes_current_tab';

function readPersistedTab(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromHash = (TAB_HASHES as readonly string[]).indexOf(window.location.hash);
    if (fromHash >= 0) return fromHash;
    const saved = parseInt(localStorage.getItem(TAB_STORAGE_KEY) || '', 10);
    if (Number.isInteger(saved) && saved >= 0 && saved < TAB_HASHES.length) return saved;
  } catch {
    // Storage can be unavailable (private mode); the app name is the fallback.
  }
  return null;
}

export function fmtTok(n: number, lang = 'en'): string {
  // The BCP 47 tag carries the digits: ar/fa render ۱۲۳ natively, others Latin.
  const fmt = (v: number) =>
    v.toLocaleString(lang, { maximumFractionDigits: 1 });
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fmt(n / 1_000)}k`;
  return fmt(n);
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

  // One rule, shared with the Home status card: a connection counts only
  // when the health check answers AND no failure is on record. `connected`
  // alone is not enough, because a rejected key and a failed start both
  // leave it true, so the pill would read green while the key is refused.
  const effectivelyConnected = connected && !gatewayFailed && !gatewayFailureKind;
  const isHealthy = effectivelyConnected;
  const isConnecting = install === 'RUNNING' || install === 'INSTALLING';

  // The pill and the Home status card describe ONE connection: a reachable
  // server that rejects the key is a failure (not connected), a failed
  // install or start is a failure, and neither may ever be reported as
  // connected just because the health check happens to answer. The typed
  // context fields are the whole contract here; the five untyped probe
  // spellings this used to read were never set by any module and are gone.
  const failureText = `${gatewayFailureReason || ''} ${gatewayStatus?.detail || ''}`;
  const authFailureFromLists = [listsMeta['sessions'], listsMeta['jobs']].some(
    (meta) => !!meta?.error && AUTH_FAILURE_RE.test(meta.error)
  );
  const isUnauthorized =
    gatewayFailureKind === 'unauthorized' ||
    AUTH_FAILURE_PATTERN.test(failureText) ||
    authFailureFromLists;
  const isFailed =
    gatewayFailed === true ||
    !!gatewayFailureKind ||
    install === 'FAILED' ||
    isUnauthorized;

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
  // key-rejected danger, offline neutral. Green is health only, because
  // statusState can only reach 'connected' through effectivelyConnected
  // above, and a stopped gateway keeps the neutral pill (text carries the
  // state, never the colour alone).
  // Connection lamp: a green/red dot only, never a text badge. Tapping it
  // shows a floating tooltip (Connected / Not connected) that auto-hides
  // after a few seconds. The aria label always carries the full state so
  // the colour is never the only signal.
  const [statusTipOpen, setStatusTipOpen] = useState(false);
  const statusTipTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (statusTipTimer.current !== null) window.clearTimeout(statusTipTimer.current);
    };
  }, []);
  const lampColor = statusState === 'connected' ? 'var(--app-success)' : 'var(--app-danger)';
  const toggleStatusTip = () => {
    if (statusTipTimer.current !== null) window.clearTimeout(statusTipTimer.current);
    setStatusTipOpen(true);
    statusTipTimer.current = window.setTimeout(() => setStatusTipOpen(false), 2500);
  };

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
  // Mockup header (chat tab): a live dot + "Hermes Chat" title with the
  // active model as a mono subtitle below. Other tabs keep the plain screen
  // name; an explicit title prop always wins.

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

  const isChatTitle = !hasTitle && tabIndex === 1;
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
  // The overflow menu is an overlay like every other popup: Escape, the
  // Android back button and Tab containment come from the shared stack, and
  // focus returns to the trigger when it closes.
  const menuOverlayRef = useOverlayBehavior(menuOpen, () => setMenuOpen(false));

  // Escape is handled once, by useOverlayBehavior above. A second capture
  // listener here would be a duplicate that fires alongside it.

  // Close the menu whenever the screen changes out from under it.
  useEffect(() => {
    setMenuOpen(false);
  }, [activeTab, isDesktop]);

  return (
    <header
      className="glass-nav sticky top-0 z-30 border-b border-[var(--app-border)]/70 flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5"
      style={{
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
      <div className={`flex items-center gap-2 sm:gap-3 ${isHomeTitle ? 'shrink-0' : 'min-w-0'}`}>
        {!isDesktop ? (
          <button
            onClick={onOpenDrawer}
            className="w-10 h-10 min-w-[40px] r-md bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] border border-[var(--app-border)] flex items-center justify-center shrink-0 text-[var(--app-text-muted)] hover:text-[var(--app-text)] active:scale-95 transition-all shadow-sm"
            title={tx('openChats', 'Open chats')}
            aria-label={tx('openChats', 'Open chats')}
          >
            <Menu className="w-5 h-5" />
          </button>
        ) : (
          <button
            onClick={onToggleSidebar}
            className="min-w-[44px] min-h-[44px] r-xs flex items-center justify-center shrink-0 text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition"
            title={sidebarCollapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
            aria-label={sidebarCollapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
          >
            {sidebarCollapsed ? <SidebarOpen className="w-5 h-5 rtl-flip" /> : <SidebarClose className="w-5 h-5 rtl-flip" />}
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
                className="brand-logo-light w-full h-full object-contain"
                onError={(e) => {
                  e.currentTarget.remove();
                }}
              />
              <img
                src="/ic_hermes_logo_dark.png"
                alt={tx('appLogoAlt', 'Hermes logo')}
                className="brand-logo-dark w-full h-full object-contain"
                onError={(e) => {
                  e.currentTarget.remove();
                }}
              />
            </div>
          )}
          <div className="flex items-center gap-2 min-w-0">
            {/* The app name is never truncated: it keeps its full width and the
                row gives up space elsewhere. A screen name may truncate, since
                it is a label for the tab you just picked, not an identity. */}
            {isChatTitle ? (
              <span className="relative flex flex-col min-w-0 leading-tight" aria-live="polite">
                <span className="flex items-center gap-2 min-w-0">
                  {/* Mockup: the live dot carries the connection state, so on
                      this tab it IS the status control (tap = state tooltip)
                      and the duplicate lamp button is hidden. The pulsing ring
                      is decorative, the dot colour is the signal, the aria
                      label names it outright. */}
                  <button
                    type="button"
                    onClick={toggleStatusTip}
                    role="status"
                    aria-label={`${tx('connectionStatus', 'Connection status')}: ${statusLabel}`}
                    aria-expanded={statusTipOpen}
                    title={statusTitle}
                    className="relative flex h-2.5 w-2.5 shrink-0 cursor-pointer hm-hit"
                  >
                    <span
                      aria-hidden="true"
                      className="status-pulse absolute inline-flex h-full w-full r-full"
                      style={{ backgroundColor: lampColor, opacity: 0.75 }}
                    />
                    <span
                      aria-hidden="true"
                      className="relative inline-flex r-full h-2.5 w-2.5"
                      style={{
                        backgroundColor: lampColor,
                        boxShadow: `0 0 8px ${lampColor}`,
                      }}
                    />
                  </button>
                  <h1 className="text-[0.9375rem] font-bold tracking-tight text-[var(--app-text)] truncate">
                    {tx('hermesChat', 'Hermes Chat')}
                  </h1>
                </span>
                {activeModelLabel && (
                  <span className="t-micro font-mono text-[var(--app-text-muted)] tracking-tight ps-[18px] truncate min-w-0">
                    <span dir="ltr" className="inline-block truncate max-w-full">
                      {activeModelLabel}
                    </span>
                  </span>
                )}
                {statusTipOpen && (
                  <span
                    role="status"
                    className="absolute start-4 top-full mt-2 z-50 px-3 py-2 r-sm edge elev-2 t-caption font-medium whitespace-nowrap"
                    style={{ backgroundColor: 'var(--app-card)', color: 'var(--app-text)' }}
                  >
                    {statusLabel}
                  </span>
                )}
              </span>
            ) : (
            <span
              className={`t-title font-semibold tracking-tight text-[var(--app-text)] ${
                isHomeTitle ? 'whitespace-nowrap shrink-0' : 'truncate'
              }`}
              aria-live="polite"
            >
              {screenTitle}
            </span>
            )}
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
        {/* Connection lamp: a green/red dot. Tap shows a floating tooltip
            with the state; it auto-hides after a few seconds. role=status +
            aria-label so the colour is never the only signal. */}
        <div className={`relative shrink-0 ${isChatTitle ? 'hidden' : ''}`}>
          <button
            type="button"
            onClick={toggleStatusTip}
            role="status"
            aria-live="polite"
            aria-label={`${tx('connectionStatus', 'Connection status')}: ${statusLabel}`}
            aria-expanded={statusTipOpen}
            title={statusTitle}
            className="min-w-[44px] min-h-[44px] r-xs edge flex items-center justify-center cursor-pointer hover:bg-[var(--app-card-hover)] active:scale-95 transition-all"
          >
            <span
              className="w-3 h-3 r-full shrink-0"
              aria-hidden="true"
              style={{
                backgroundColor: lampColor,
                boxShadow: `0 0 8px ${lampColor}`,
              }}
            />
          </button>
          {statusTipOpen && (
            <div
              role="status"
              className="absolute end-0 top-full mt-2 z-50 px-3 py-2 r-sm edge elev-2 t-caption font-medium whitespace-nowrap"
              style={{ backgroundColor: 'var(--app-card)', color: 'var(--app-text)' }}
            >
              {statusLabel}
            </div>
          )}
        </div>

        {/* Overflow menu: token telemetry, approvals and the inspector toggle */}
        <div className="relative shrink-0" ref={menuWrapRef}>
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            className={`relative flex items-center gap-1.5 font-mono text-[0.6875rem] text-[var(--app-warning)] tracking-tight font-medium r-full border border-[var(--app-warning-border)] bg-[var(--app-card)] px-2.5 py-1.5 min-h-[36px] shadow-[0_0_12px_var(--app-warning-subtle)] hover:bg-[var(--app-card-hover)] transition active:scale-95 cursor-pointer hm-hit ${
              menuOpen ? 'bg-[var(--app-card-hover)] ring-1 ring-[var(--app-warning-border)]' : ''
            }`}
            title={moreOptionsLabel}
            aria-label={moreOptionsLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Zap className="w-3.5 h-3.5 text-[var(--app-warning)] animate-pulse shrink-0 fill-current" />
            <span className="text-[var(--app-warning)] font-semibold">↑ {fmtTok(usageIn, lang)}</span>
            <span className="text-[var(--app-text-dim)]">·</span>
            <span className="text-[var(--app-success)] font-semibold">↓ {fmtTok(usageOut, lang)}</span>
            {approvalCount > 0 && (
              <span
                className="absolute -top-1 -end-1 pill-danger font-mono font-semibold"
                aria-hidden="true"
              >
                {formatBadgeCount(approvalCount)}
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
                ref={menuOverlayRef}
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
                      <span title={tx('promptTokens', 'Tokens sent to the model')}>↑ {fmtTok(usageIn, lang)}</span>
                      <span className="text-[var(--app-text-dim)]">·</span>
                      <span title={tx('outputTokens', 'Tokens received from the model')}>↓ {fmtTok(usageOut, lang)}</span>
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
                    {inspectorOpen ? <PanelRightClose className="w-4 h-4 rtl-flip" /> : <PanelRightOpen className="w-4 h-4 rtl-flip" />}
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
