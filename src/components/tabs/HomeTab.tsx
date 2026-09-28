import React, { useMemo, useState } from 'react';
import {
  MessageSquare,
  Terminal,
  CalendarClock,
  RefreshCw,
  SlidersHorizontal,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  Download,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { resolveListUiState } from '../../services/pagination';
import { AgentStatus } from '../../types/hermes';
import { formatHomeAgo } from '../../constants/languages';

interface HomeTabProps {
  onGoChat: () => void;
  /**
   * The diagnostics live in the Settings tab (Advanced/Diagnostics section),
   * so the quick action navigates there instead of pretending to run a command.
   */
  onGoDiagnostics: () => void;
  onGoActivity: () => void;
  onGoSettings: () => void;
  /** Opens the sessions list (drawer) holding every conversation, not just 4. */
  onGoSessions: () => void;
}

export function homeAgo(ts: number, lang: string = 'en'): string {
  return formatHomeAgo(ts, lang);
}

// Auth-shape failures on authenticated endpoints (401/403 or an explicit
// "auth failed" message) while /health itself may still be green. Matched
// against the per-list sync envelopes the context already publishes.
const AUTH_FAILURE_RE = /401|403|auth/i;

// List sync envelope shape (subset) read out of context.listsMeta.
interface ListMetaLike {
  live?: boolean;
  stale?: boolean;
  error?: string;
  lastSyncedAt?: number | null;
}

export const HomeTab: React.FC<HomeTabProps> = ({
  onGoChat,
  onGoDiagnostics,
  onGoActivity,
  onGoSettings,
  onGoSessions,
}) => {
  const hermes = useHermes();
  const {
    connected,
    streaming,
    approvals,
    install,
    sessions,
    jobs,
    chat,
    gatewayFailed,
    gatewayFailureReason,
    currentSessionId,
    selectSession,
    newSession,
    sendMessage,
    startGateway,
    stopGateway,
    installGateway,
    refreshNow,
    listsMeta,
    settings,
    t,
  } = hermes;

  // i18n with an English fallback for strings the locale bundles do not ship.
  // t() returns the key itself only when no locale has it.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Native start failures surface machine strings ("not_installed: run
  // install() first"). Never print those verbatim: map the known causes to
  // user copy, and only pass through reasons that are already human-facing.
  const describeGatewayFailure = (raw: string | null | undefined): string | null => {
    const s = (raw || '').trim();
    if (!s) return null;
    if (/not[_\s-]?installed/i.test(s)) {
      return tx(
        'gatewayNotInstalled',
        'The gateway is not installed on this device yet. Install it to continue.'
      );
    }
    if (/install\(\)/i.test(s)) {
      return tx('gatewayNeedsInstall', 'The gateway needs an install step before it can start.');
    }
    return s;
  };

  const sessionMeta: ListMetaLike | undefined = listsMeta['sessions'];
  const jobMeta: ListMetaLike | undefined = listsMeta['jobs'];

  // A sibling owns the context and is adding the explicit gateway failure
  // signal (`gatewayFailureKind: 'start' | 'unhealthy' | 'unauthorized'`).
  // Read it through a shape cast so this screen compiles and behaves the same
  // whether or not those fields have landed yet; every candidate is probed.
  const signalContext = hermes as unknown as {
    gatewayFailureKind?: string | null;
    gatewayUnauthorized?: boolean;
    gatewayAuthFailed?: boolean;
    authFailed?: boolean;
    unauthorized?: boolean;
  };
  const authFailureFlag =
    signalContext.gatewayFailureKind === 'unauthorized' ||
    signalContext.gatewayUnauthorized === true ||
    signalContext.gatewayAuthFailed === true ||
    signalContext.authFailed === true ||
    signalContext.unauthorized === true;

  // Fallback that works today: an authenticated endpoint rejected the request
  // while health was fine (sessions/jobs envelopes carry "HTTP 401").
  const authFailureFromLists = [sessionMeta, jobMeta].some(
    (m) => !!m?.error && AUTH_FAILURE_RE.test(m.error || '')
  );
  const authFailure = authFailureFlag || authFailureFromLists;

  // Worst subsystem wins, and connectivity is tested BEFORE approvals: with a
  // dead gateway the cached approval count is not actionable, so Home must
  // never claim "Action Required" while every resolve would fail.
  const agentStatus: AgentStatus = useMemo(() => {
    if (gatewayFailed || install === 'FAILED' || authFailure) return 'ERROR';
    if (!connected) {
      if (install === 'INSTALLING' || install === 'RUNNING') return 'CONNECTING';
      return 'OFFLINE';
    }
    if (approvals.length > 0) return 'WAITING';
    if (streaming) {
      const lastMsg = chat[chat.length - 1];
      if (lastMsg && lastMsg.sender === 'hermes' && !lastMsg.thinkingDone) {
        return 'THINKING';
      }
      return 'EXECUTING';
    }
    return 'ONLINE';
  }, [gatewayFailed, install, authFailure, connected, approvals.length, streaming, chat]);

  const statusConfig = {
    ONLINE: {
      accent: 'text-emerald-400',
      bgGlow: 'from-emerald-500/10 via-transparent to-transparent',
      borderColor: 'border-emerald-500/20',
      badgeBg: 'bg-emerald-400/10 text-emerald-300 border-emerald-500/30',
      title: t('agentStatusOnline'),
      desc: t('agentStatusOnlineDesc'),
    },
    THINKING: {
      accent: 'text-teal-400',
      bgGlow: 'from-teal-500/10 via-transparent to-transparent',
      borderColor: 'border-teal-500/20',
      badgeBg: 'bg-teal-400/10 text-teal-300 border-teal-500/30',
      title: t('agentStatusThinking'),
      desc: t('agentStatusThinkingDesc'),
    },
    EXECUTING: {
      accent: 'text-indigo-400',
      bgGlow: 'from-indigo-500/10 via-transparent to-transparent',
      borderColor: 'border-indigo-500/20',
      badgeBg: 'bg-indigo-400/10 text-indigo-300 border-indigo-500/30',
      title: t('agentStatusExecuting'),
      desc: t('agentStatusExecutingDesc'),
    },
    WAITING: {
      accent: 'text-amber-400',
      bgGlow: 'from-amber-500/10 via-transparent to-transparent',
      borderColor: 'border-amber-500/20',
      badgeBg: 'bg-amber-400/10 text-amber-300 border-amber-500/30',
      title: t('agentStatusWaiting'),
      desc:
        approvals.length === 1
          ? tx('approvalOneNeedsReview', '1 action needs your review')
          : `${approvals.length} ${tx('approvalsNeedReview', 'actions need your review')}`,
    },
    OFFLINE: {
      accent: 'text-slate-400',
      bgGlow: 'from-slate-500/5 via-transparent to-transparent',
      borderColor: 'border-white/[0.08]',
      badgeBg: 'bg-white/5 text-slate-400 border-white/10',
      title: t('agentStatusOffline'),
      desc: t('offline'),
    },
    CONNECTING: {
      accent: 'text-sky-400',
      bgGlow: 'from-sky-500/10 via-transparent to-transparent',
      borderColor: 'border-sky-500/20',
      badgeBg: 'bg-sky-400/10 text-sky-300 border-sky-500/30',
      title: t('agentStatusConnecting'),
      desc: t('starting'),
    },
    ERROR: {
      accent: 'text-rose-400',
      bgGlow: 'from-rose-500/10 via-transparent to-transparent',
      borderColor: 'border-rose-500/20',
      badgeBg: 'bg-rose-400/10 text-rose-300 border-rose-500/30',
      title: authFailure ? tx('agentStatusAuthError', 'Access Denied') : t('agentStatusError'),
      desc: authFailure
        ? tx(
            'agentStatusAuthErrorDesc',
            'The gateway rejected the API key. Check the key under Ops & Settings.'
          )
        : describeGatewayFailure(gatewayFailureReason) || t('agentStatusError'),
    },
  }[agentStatus];

  // Health can be green while a list endpoint fails; say so instead of
  // repeating "ready to process commands" for a half-working gateway.
  const someDataUnavailable =
    agentStatus === 'ONLINE' && (!!sessionMeta?.error || !!jobMeta?.error);
  const heroDesc = someDataUnavailable
    ? tx(
        'agentStatusPartialDesc',
        'Gateway is up, but some data could not be loaded. Refresh or open Diagnostics.'
      )
    : statusConfig.desc;

  // Session described by the hero strip: always the selected session, so the
  // strip and the highlighted list row never disagree.
  const activeSession = useMemo(
    () => (currentSessionId ? sessions.find((s) => s.id === currentSessionId) || null : null),
    [sessions, currentSessionId]
  );

  // Idle, the strip is not a "current task": it is the last session, so label
  // it as such (and hide it entirely when there is no session to describe).
  const stripValue = useMemo(() => {
    if (streaming) {
      const lastUser = chat.slice().reverse().find((m) => m.sender === 'you')?.content;
      return lastUser ? lastUser : t('agentStatusThinking');
    }
    if (!activeSession) return '';
    const count = activeSession.messageCount;
    const label = count === 1 ? tx('messageOne', 'message') : tx('messagesCount', 'messages');
    return `${activeSession.title || t('newSession')} · ${count} ${label}`;
  }, [streaming, chat, activeSession, t]);
  const showTaskStrip = streaming || !!activeSession;
  const taskStripLabel = streaming
    ? tx('currentTask', 'Current task')
    : tx('lastSession', 'Last session');

  const recentSessions = useMemo(() => {
    return [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 4);
  }, [sessions]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [gatewayBusy, setGatewayBusy] = useState(false);

  // Error vs first-run gating: a real failure (FAILED flag, failed install,
  // rejected API key) gets the alarm card. A clean offline state (never
  // started / stopped) gets a friendly setup card instead, with no localhost
  // details leaked.
  const isError = gatewayFailed || install === 'FAILED' || authFailure;
  const isInstalling = install === 'INSTALLING';
  const needsInstall = install === 'NOT_INSTALLED';
  const showSetupCard = !connected && !isError && !streaming && !isInstalling;

  // newSession throws truthfully when the gateway is unreachable: surface it
  // instead of navigating to a chat that was never created.
  const handleNewSessionGoChat = async () => {
    setActionError(null);
    try {
      await newSession();
      onGoChat();
    } catch {
      setActionError('Could not create session. Gateway unreachable.');
    }
  };

  // Try-asking chips: a new session is created first, then the chip prompt
  // is sent as the opening message so the tap is never a blank chat.
  const handleChipPromptGoChat = async (prompt: string) => {
    setActionError(null);
    try {
      await newSession();
      sendMessage(prompt);
      onGoChat();
    } catch {
      setActionError('Could not create session. Gateway unreachable.');
    }
  };

  // Jobs count convention: nav badges show enabled-only; Home surfaces the
  // enabled count with the total as context so the numbers never disagree.
  const enabledJobsCount = useMemo(
    () => jobs.filter((j) => j.enabled).length,
    [jobs]
  );

  // Recent-session truthfulness: cached list while offline (or while the list
  // endpoint itself failed) is stale, not live. Reads the sync envelope so a
  // green /health cannot pass a failed sessions fetch off as fresh.
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const recentListState = resolveListUiState(
    {
      live: sessionMeta ? sessionMeta.live === true : connected,
      stale: sessionMeta ? sessionMeta.stale === true : !connected && sessions.length > 0,
      error:
        sessionMeta?.error ||
        (!connected && sessions.length === 0 ? 'Gateway unreachable' : undefined),
    },
    sessions.length,
    { offline: browserOffline || !connected }
  );

  // Jobs truthfulness: never assert "0 active - 0 total" (or 0/0) while the
  // jobs list is loading, stale, or errored. Counts render only for states
  // that actually have fresh (or first-fresh) data behind them.
  const jobsListState = resolveListUiState(
    {
      live: jobMeta ? jobMeta.live === true : connected,
      stale: jobMeta ? jobMeta.stale === true : !connected && jobs.length > 0,
      error: jobMeta?.error || (!connected ? 'Gateway unreachable' : undefined),
    },
    jobs.length,
    { offline: browserOffline || !connected }
  );
  const jobsCountKnown =
    jobsListState === 'live' || jobsListState === 'empty' || jobsListState === 'refreshing';
  // Never synced at all counts as loading, not as a failure.
  const jobsPanelState: 'loading' | 'stale' | 'error' | null = jobsCountKnown
    ? null
    : !jobMeta
      ? 'loading'
      : jobsListState === 'stale' || jobsListState === 'offline'
        ? 'stale'
        : 'error';

  const sessionsSyncedLabel = sessionMeta?.lastSyncedAt
    ? `${tx('lastSyncedAt', 'Updated')} ${homeAgo(sessionMeta.lastSyncedAt, settings.language || 'en')}`
    : '';
  const jobsSyncedLabel = jobMeta?.lastSyncedAt
    ? `${tx('lastSyncedAt', 'Updated')} ${homeAgo(jobMeta.lastSyncedAt, settings.language || 'en')}`
    : '';

  const handleRetrySessions = async () => {
    setActionError(null);
    try {
      await refreshNow();
    } catch {
      setActionError('Retry failed. The gateway is still unreachable.');
    }
  };

  const handleRetryJobs = async () => {
    setActionError(null);
    try {
      await refreshNow();
    } catch {
      setActionError('Retry failed. The gateway is still unreachable.');
    }
  };

  const handleStartGateway = async () => {
    if (gatewayBusy) return;
    setActionError(null);
    setGatewayBusy(true);
    try {
      await startGateway();
    } catch {
      setActionError('Could not start the gateway. Try again.');
    } finally {
      setGatewayBusy(false);
    }
  };

  // Real restart: stop the process first (a hung daemon is not fixed by a
  // second start), then start it. Both halves report through the context.
  const handleRestartGateway = async () => {
    if (gatewayBusy) return;
    setActionError(null);
    setGatewayBusy(true);
    try {
      await stopGateway();
      await startGateway();
    } catch {
      setActionError('Restart failed. The gateway was not restarted.');
    } finally {
      setGatewayBusy(false);
    }
  };

  const handleInstallGateway = async () => {
    if (gatewayBusy) return;
    setActionError(null);
    setGatewayBusy(true);
    try {
      await installGateway();
    } catch {
      setActionError('Install failed. Try again.');
    } finally {
      setGatewayBusy(false);
    }
  };

  const errorCardCta = needsInstall || install === 'FAILED' ? 'install' : 'restart';

  return (
    <div className="space-y-6 max-w-2xl mx-auto px-4 pt-4 pb-20">
      {/* 1. Hero Presence Banner */}
      <div
        className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${statusConfig.bgGlow} bg-[var(--app-card,#0E1217)] border ${statusConfig.borderColor} p-5 shadow-sm transition-all`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${
                agentStatus === 'ONLINE' ? 'bg-emerald-400 animate-pulse' :
                agentStatus === 'WAITING' ? 'bg-amber-400' :
                agentStatus === 'CONNECTING' ? 'bg-sky-400 animate-pulse' :
                agentStatus === 'EXECUTING' || agentStatus === 'THINKING' ? 'bg-teal-400 animate-ping' :
                agentStatus === 'ERROR' ? 'bg-rose-400' :
                'bg-slate-400'
              }`} />
              <span className="font-semibold text-white tracking-tight">
                {statusConfig.title}
              </span>
              <span className="text-slate-500">·</span>
              <ExpandablePill
                value={settings.modelId.split('/').pop() || ''}
                full={settings.modelId}
                className="max-w-[120px]"
              />
            </div>
            <p className="text-xs text-slate-400 leading-relaxed pe-2">
              {heroDesc}
            </p>
          </div>

          {agentStatus === 'WAITING' && (
            <button
              onClick={onGoChat}
              className="flex items-center gap-1.5 px-3.5 min-h-[44px] py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-xs font-semibold border border-amber-500/30 active:scale-95 transition cursor-pointer shrink-0"
            >
              <span>{tx('review', 'Review')} ({approvals.length})</span>
              <ChevronRight className="w-3.5 h-3.5 rtl-flip" />
            </button>
          )}
        </div>

        {/* Session strip: "Current task" only while a turn is running */}
        {showTaskStrip && (
          <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] text-slate-400 font-medium shrink-0">
                {taskStripLabel}:
              </span>
              <ExpandablePill
                value={stripValue}
                full={stripValue}
                className="max-w-[280px] text-slate-200"
              />
            </div>
            {streaming && (
              <span className="text-[10px] font-mono text-teal-400 uppercase tracking-wider shrink-0 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-ping" />
                {tx('live', 'Live')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Gateway state card: error alarm OR first-run setup, never both */}
      {isError && (
        <div className="rounded-2xl bg-rose-950/20 border border-rose-500/20 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-rose-300">
              {authFailure ? tx('agentStatusAuthError', 'Access Denied') : t('agentStatusError')}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {authFailure
                ? tx(
                    'agentStatusAuthErrorDesc',
                    'The gateway rejected the API key. Check the key under Ops & Settings.'
                  )
                : describeGatewayFailure(gatewayFailureReason) || t('agentStatusError')}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() =>
                void (errorCardCta === 'install' ? handleInstallGateway() : handleRestartGateway())
              }
              disabled={gatewayBusy}
              className="flex-1 min-h-[44px] flex items-center justify-center gap-2 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              {errorCardCta === 'install' ? (
                <Download className={`w-3.5 h-3.5 ${gatewayBusy ? 'animate-pulse' : ''}`} />
              ) : (
                <RefreshCw className={`w-3.5 h-3.5 ${gatewayBusy ? 'animate-spin' : ''}`} />
              )}
              <span>
                {errorCardCta === 'install'
                  ? gatewayBusy
                    ? t('installing')
                    : install === 'FAILED'
                      ? tx('retrySetup', 'Retry Setup')
                      : tx('installGateway', 'Install Gateway')
                  : gatewayBusy
                    ? `${t('starting')}...`
                    : tx('restartDaemon', 'Restart Daemon')}
              </span>
            </button>
            <button
              onClick={onGoSettings}
              className="px-4 min-h-[44px] py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-slate-300 text-xs font-medium border border-white/[0.08] transition cursor-pointer"
            >
              {t('settings')}
            </button>
          </div>
        </div>
      )}

      {showSetupCard && (
        <div className="rounded-2xl bg-indigo-950/20 border border-indigo-500/20 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              {needsInstall ? tx('gatewaySetupTitle', 'Set up the gateway') : 'Get started'}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {needsInstall
                ? tx(
                    'installGatewayHint',
                    'Install the gateway on this device to begin chatting with Hermes.'
                  )
                : tx('startGatewayHint', 'Start the gateway to begin chatting with Hermes.')}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void (needsInstall ? handleInstallGateway() : handleStartGateway())}
              disabled={gatewayBusy}
              className="flex-1 min-h-[44px] flex items-center justify-center gap-2 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              {needsInstall ? (
                <Download className={`w-3.5 h-3.5 ${gatewayBusy ? 'animate-pulse' : ''}`} />
              ) : (
                <RefreshCw className={`w-3.5 h-3.5 ${gatewayBusy ? 'animate-spin' : ''}`} />
              )}
              <span>
                {needsInstall
                  ? gatewayBusy
                    ? t('installing')
                    : tx('installGateway', 'Install Gateway')
                  : gatewayBusy
                    ? `${t('starting')}...`
                    : tx('startDaemon', 'Start Daemon')}
              </span>
            </button>
            <button
              onClick={onGoSettings}
              className="px-4 min-h-[44px] py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-slate-300 text-xs font-medium border border-white/[0.08] transition cursor-pointer"
            >
              {t('settings')}
            </button>
          </div>
        </div>
      )}

      {/* 2. Primary Fast-Action Grid */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
          {t('quickActions')}
        </h2>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {/* New Chat */}
          <button
            onClick={() => void handleNewSessionGoChat()}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.07] hover:border-indigo-500/40 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <MessageSquare className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">{t('newSession')}</span>
            <span className="text-[11px] text-slate-400 mt-0.5">Start a conversation with Hermes</span>
          </button>

          {/* Diagnostics: this card opens Ops & Settings, so it says so. */}
          <button
            onClick={onGoDiagnostics}
            aria-label={tx(
              'diagnosticsAction',
              'Verify Gateway Diagnostics'
            )}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.07] hover:border-teal-500/40 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-teal-500/10 text-teal-400 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <Terminal className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">
              {tx('diagnosticsAction', 'Verify Gateway Diagnostics')}
            </span>
            <span className="text-[11px] text-slate-400 mt-0.5">
              {tx('diagnosticsActionDesc', 'Gateway status, logs, and connection')}
            </span>
          </button>

          {/* Automation Jobs */}
          <button
            onClick={onGoActivity}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.07] hover:border-violet-500/40 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-violet-500/10 text-violet-400 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <CalendarClock className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">Scheduled jobs</span>
            <span className="text-[11px] text-slate-400 mt-0.5">
              {jobsCountKnown
                ? `${enabledJobsCount} ${t('active')} · ${jobs.length} ${tx('total', 'total')}`
                : tx('countsUnavailable', 'Counts unavailable')}
            </span>
          </button>

          {/* Settings / Ops */}
          <button
            onClick={onGoSettings}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.07] hover:border-white/20 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-slate-500/10 text-slate-300 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">Settings</span>
            <span className="text-[11px] text-slate-400 mt-0.5">Models, appearance, and connections</span>
          </button>
        </div>
      </section>

      {/* 3. Recent Sessions & Activity Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
            {t('recentSessions')}
          </h2>
          {sessions.length > 0 && (
            <button
              onClick={onGoSessions}
              className="min-h-[44px] px-2 inline-flex items-center text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium cursor-pointer"
            >
              {tx('viewAll', 'View all')}
            </button>
          )}
        </div>

        {actionError && (
          <div role="alert" className="px-3.5 py-2.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
            <p>{actionError}</p>
          </div>
        )}
        {!actionError && (recentListState === 'stale' || recentListState === 'offline') && (
          <div role="status" className="px-3.5 py-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
            <p className="font-semibold">
              {t('offline')}: {tx('showingSavedSessions', 'showing saved sessions')}
              {sessionsSyncedLabel ? ` · ${sessionsSyncedLabel}` : ''}
            </p>
          </div>
        )}

        {recentListState === 'error' ? (
          <div className={`p-8 rounded-2xl bg-[var(--app-card,#0E1217)] border text-center space-y-3 ${isError ? 'border-white/[0.06]' : 'border-rose-500/20'}`} role="alert">
            <p className="text-xs font-medium text-white">Could not load sessions.</p>
            <p className="text-[11px] text-slate-400">The gateway is unreachable.</p>
            <button
              onClick={() => void handleRetrySessions()}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition cursor-pointer"
            >
              {t('refresh')}
            </button>
          </div>
        ) : recentSessions.length === 0 ? (
          <div className="p-8 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-center space-y-3">
            <div className="w-10 h-10 rounded-2xl bg-white/[0.03] text-slate-400 flex items-center justify-center mx-auto">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-white">{t('noSessionsYet')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Start a conversation with Hermes.
              </p>
            </div>
            <button
              onClick={() => void handleNewSessionGoChat()}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition cursor-pointer"
            >
              {t('newSession')}
            </button>
            <div className="pt-1">
              <p className="text-[11px] text-slate-500 mb-2">Try asking:</p>
              <div className="flex flex-wrap justify-center gap-2">
                {['Check my system health', 'Summarize my recent sessions', 'Help me plan my day'].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => void handleChipPromptGoChat(prompt)}
                    className="px-3 py-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11px] text-slate-300 transition cursor-pointer"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {recentSessions.map((s) => {
              const isSelected = s.id === currentSessionId;
              const isLive = streaming && isSelected;

              return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${tx('openSession', 'Open session')} ${s.title || t('newSession')}`}
                  onClick={() => {
                    selectSession(s.id);
                    onGoChat();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectSession(s.id);
                      onGoChat();
                    }
                  }}
                  className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    isSelected
                      ? 'bg-[var(--app-card-subtle,#141920)] border-indigo-500/40 shadow-xs'
                      : 'bg-[var(--app-card,#0E1217)] border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                      isLive ? 'bg-teal-500/15 text-teal-400' : 'bg-white/[0.04] text-slate-400'
                    }`}>
                      <MessageSquare className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-white truncate">
                        {s.title || t('newSession')}
                      </p>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                        <span>{s.messageCount} {s.messageCount === 1 ? tx('messageOne', 'message') : tx('messagesCount', 'messages')}</span>
                        <span>·</span>
                        <span>{homeAgo(s.lastActiveAt, settings.language || 'en')}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isLive && (
                      <span className="px-2 py-0.5 rounded-md bg-teal-500/10 text-teal-300 font-mono text-[10px] font-medium">
                        {tx('live', 'Live')}
                      </span>
                    )}
                    <ChevronRight className="w-4 h-4 text-slate-500 rtl-flip" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4. Scheduled Jobs Overview (also shown when the counts are unknown,
          so the unknown state always carries a retry affordance) */}
      {(jobs.length > 0 || jobsPanelState !== null) && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
              {t('scheduledCron')}
            </h2>
            {jobsCountKnown ? (
              <button
                onClick={onGoActivity}
                className="min-h-[44px] px-2 inline-flex items-center text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium cursor-pointer"
              >
                {t('jobs')} ({enabledJobsCount}/{jobs.length})
              </button>
            ) : (
              <button
                onClick={() => void handleRetryJobs()}
                className="min-h-[44px] px-2 inline-flex items-center text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium cursor-pointer"
              >
                {t('refresh')}
              </button>
            )}
          </div>

          {jobsPanelState === 'stale' && (
            <div role="status" className="px-3.5 py-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
              <p className="font-semibold">
                {t('offline')}: {tx('showingSavedJobs', 'showing saved jobs, counts may be out of date')}
                {jobsSyncedLabel ? ` · ${jobsSyncedLabel}` : ''}
              </p>
            </div>
          )}

          {jobsPanelState === 'loading' && (
            <div role="status" className="p-4 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-xs text-slate-400">
              {tx('loadingJobs', 'Loading scheduled jobs...')}
            </div>
          )}

          {jobsPanelState === 'error' && (
            <div role="alert" className="p-4 rounded-2xl bg-[var(--app-card,#0E1217)] border border-rose-500/20 text-center space-y-3">
              <p className="text-xs font-medium text-white">{tx('jobsUnavailable', 'Could not load scheduled jobs.')}</p>
              <p className="text-[11px] text-slate-400">
                {tx('countsUnavailable', 'Counts unavailable')}
              </p>
              <button
                onClick={() => void handleRetryJobs()}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition cursor-pointer"
              >
                {t('refresh')}
              </button>
            </div>
          )}

          {jobs.length > 0 && (
            <div className="space-y-2">
              {jobs.slice(0, 3).map((job) => (
                <div
                  key={job.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${tx('goToJobs', 'Go to Cron & Tasks')}: ${job.name}`}
                  onClick={onGoActivity}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onGoActivity();
                    }
                  }}
                  className="p-3.5 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] hover:border-white/[0.12] flex items-center justify-between gap-3 cursor-pointer transition"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
                      <CheckCircle2 className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-white truncate">
                        {job.name}
                      </p>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                        <span>{job.scheduleDisplay}</span>
                        <span>·</span>
                        <span className={job.enabled ? 'text-emerald-400' : 'text-slate-500'}>
                          {job.enabled ? t('active') : t('stopped')}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

const ExpandablePill: React.FC<{ value: string; full: string; className?: string }> = ({
  value,
  full,
  className = '',
}) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      title={full}
      aria-label={`${full}. Tap to ${expanded ? 'collapse' : 'expand'}.`}
      className={`inline-flex items-center gap-0.5 text-slate-400 font-mono text-[11px] min-w-0 text-start cursor-pointer underline decoration-dotted underline-offset-2 ${expanded ? '' : `truncate ${className}`} ${expanded ? 'whitespace-normal break-all' : ''}`}
    >
      <span className="truncate min-w-0">{value}</span>
      <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </button>
  );
};
