import React from 'react';
import {
  Menu,
  AlertCircle,
  SidebarClose,
  SidebarOpen,
  PanelRightClose,
  PanelRightOpen,
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

  const approvalCount = approvals.length;
  const approvalLabel =
    approvalCount === 1
      ? tx('approvalNeeded', 'Approval')
      : tx('approvalsNeededPlural', 'Approvals');

  return (
    <header
      className="sticky top-0 z-30 backdrop-blur-xl border-b px-4 py-2.5 min-h-14 flex items-center justify-between"
      style={{
        backgroundColor: 'var(--app-bg, #090B14)',
        borderColor: 'var(--app-border, rgba(255,255,255,0.07))',
        // Edge-to-edge (viewport-fit=cover, targetSdk 36): the status bar and
        // notch overlay the top of the viewport, so the header must inset
        // itself or its content sits under the system bar. 0.625rem keeps the
        // previous py-2.5 spacing when the inset is 0 (web/desktop).
        paddingTop: 'calc(0.625rem + env(safe-area-inset-top, 0px))',
      }}
    >
      {/* Left Area: Mobile Drawer or Desktop Sidebar Toggle + Title */}
      <div className="flex items-center gap-3 min-w-0">
        {!isDesktop ? (
          <button
            onClick={onOpenDrawer}
            className="w-8 h-8 min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-slate-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] active:scale-95 transition-all border border-white/[0.06] shrink-0"
            title="Open Conversations"
            aria-label="Open Conversations"
          >
            <Menu className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={onToggleSidebar}
            className="w-8 h-8 min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.05] transition"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <SidebarOpen className="w-4 h-4 rtl-flip" /> : <SidebarClose className="w-4 h-4 rtl-flip" />}
          </button>
        )}

        <div className="flex items-center gap-2.5 min-w-0">
          {!isDesktop && (
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
              <span className="font-semibold text-xs text-white tracking-tight">
                Hermes Agent
              </span>
              <span className="text-[11px] text-slate-500 font-mono hidden sm:inline">
                {settings.modelId.split('/').pop()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right Area: Telemetry + Status + Approvals + Inspector */}
      <div className="flex items-center gap-2.5 shrink-0">
        {/* Token Usage Metrics */}
        <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 font-mono bg-[var(--app-card,#11151B)] px-2.5 py-1 rounded-lg border border-white/[0.06]">
          <span title="Prompt Input Tokens">↑ {fmtTok(usageIn)}</span>
          <span className="text-slate-600">·</span>
          <span title="Generated Output Tokens">↓ {fmtTok(usageOut)}</span>
        </div>

        {/* Connection status indicator. Role=status + aria-label so the colour
            dot is never the only signal on phone widths, and a failed gateway
            keeps a visible text label at every size. */}
        <div
          role="status"
          aria-live="polite"
          aria-label={`${tx('gatewayStatus', 'Gateway status')}: ${statusLabel}`}
          title={statusTitle}
          className="flex items-center gap-1.5 text-xs bg-white/[0.02] px-2.5 py-1 rounded-lg border border-white/[0.05]"
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass}`} aria-hidden="true" />
          <span
            className={`font-medium text-[11px] ${
              statusState === 'connected' ? 'text-slate-300 hidden sm:inline' : 'text-slate-200'
            }`}
          >
            {statusLabel}
          </span>
        </div>

        {/* Action-needed approvals badge button: jumps to the Chat tab
            where the ApprovalCard queue lives. */}
        {approvals.length > 0 && (
          <button
            onClick={onGoApprovals}
            aria-label={`${approvalCount} ${approvalLabel}. Review in Chat.`}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-medium hover:bg-rose-500/25 transition-colors cursor-pointer"
          >
            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
            <span>{approvalCount} {approvalLabel}</span>
          </button>
        )}

        {/* Inspector Panel Toggle Button: available on desktop and phone.
            On phone App.tsx renders the Inspector as a slide-over overlay. */}
        {onToggleInspector && (
          <button
            onClick={onToggleInspector}
            className={`flex items-center gap-1.5 px-2.5 py-1 min-h-[44px] rounded-lg text-xs font-medium transition cursor-pointer border ${
              inspectorOpen
                ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                : 'text-slate-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06]'
            }`}
            title="Toggle Right Inspector & Tools Panel"
            aria-label="Toggle Right Inspector & Tools Panel"
            aria-expanded={inspectorOpen}
          >
            {inspectorOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
            <span className="text-[11px] hidden md:inline">{t('inspector') || 'Inspector'}</span>
          </button>
        )}
      </div>
    </header>
  );
};
