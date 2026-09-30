import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageSquare,
  Terminal,
  CalendarClock,
  RefreshCw,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  Download,
  KeyRound,
  Play,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { resolveListUiState } from '../../services/pagination';
import { plainGatewayFailure } from '../../services/plainFailure';
import { deriveUiFlags, type GatewayState } from '../../services/gatewayState';
import { isNativeGateway } from '../../services/nativeGateway';
import { modelLabel } from '../../services/modelLabel';
import { AgentStatus } from '../../types/hermes';
import { formatHomeAgo } from '../../constants/languages';
import { scheduleSummary } from '../../utils/jobTime';
import { AUTH_FAILURE_RE } from '../../constants/tabs';

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
// against the per-list sync envelopes the context already publishes. The
// pattern itself is shared with the header in constants/tabs.ts.

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
    gatewayState,
    gatewayFailed,
    gatewayFailureReason,
    gatewayFailureKind,
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
    models,
    t,
  } = hermes;

  // i18n with an English fallback for strings the locale bundles do not ship.
  // t() returns the key itself only when no locale has it.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Opening prompts for the empty state. Translated, because they are both
  // the chip label and the message Hermes receives.
  const tryPrompts = [
    tx('tryPromptStatus', 'Check that everything is running'),
    tx('tryPromptSessions', 'Summarize my recent chats'),
    tx('tryPromptPlan', 'Help me plan my day'),
  ];

  // Native start failures surface machine strings ("not_installed: run
  // install() first") and, on Android, a bare token ("service_start_blocked").
  // The shared mapper is the only place that turns a reason into words, so
  // Home can never print a token or a raw transport string.
  const sessionMeta: ListMetaLike | undefined = listsMeta['sessions'];
  const jobMeta: ListMetaLike | undefined = listsMeta['jobs'];

  // A rejected key is terminal: /health answered, but an authenticated call
  // came back 401/403. The context carries that as gatewayFailureKind
  // 'unauthorized'; the sessions/jobs envelopes ("HTTP 401") are the fallback
  // for gateways that only report it per list.
  const authFailureFromLists = [sessionMeta, jobMeta].some(
    (m) => !!m?.error && AUTH_FAILURE_RE.test(m.error || '')
  );
  const authFailure = gatewayFailureKind === 'unauthorized' || authFailureFromLists;

  // One rule, shared with the header status pill: a connection counts only
  // when the health check answers AND no failure is on record. `connected`
  // on its own stays true while the key is rejected or a start failed, so
  // every status colour and every "is it up" gate below reads this helper
  // instead. Green means health, and nothing else.
  const effectivelyConnected = connected && !gatewayFailed && !gatewayFailureKind;

  // Worst subsystem wins, and connectivity is tested BEFORE approvals: with a
  // dead gateway the cached approval count is not actionable, so Home must
  // never claim "Action Required" while every resolve would fail.
  const agentStatus: AgentStatus = useMemo(() => {
    if (gatewayFailed || gatewayFailureKind || install === 'FAILED' || authFailure) return 'ERROR';
    if (!effectivelyConnected) {
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
  }, [gatewayFailed, gatewayFailureKind, install, authFailure, effectivelyConnected, approvals.length, streaming, chat]);

  // Status is carried by the semantic status tokens (dot) plus plain copy,
  // never a decorative palette wash. The dot keeps the motion it had before:
  // pulse while waiting to connect, ping while a turn is running.
  const statusConfig = {
    ONLINE: {
      // Green is health only: ONLINE is unreachable unless the shared
      // effectivelyConnected helper says the gateway is really up.
      dot: 'bg-[var(--app-success)]',
      dotAnim: 'animate-pulse',
      title: tx('agentStatusOnlinePlain', 'Hermes is running'),
      desc: tx('agentStatusOnlineDescPlain', 'Ready for chat and scheduled tasks.'),
    },
    THINKING: {
      dot: 'bg-[var(--app-accent)]',
      dotAnim: 'animate-ping',
      title: t('agentStatusThinking'),
      desc: tx('agentStatusThinkingDescPlain', 'Working out the next step.'),
    },
    EXECUTING: {
      dot: 'bg-[var(--app-accent)]',
      dotAnim: 'animate-ping',
      title: tx('agentStatusExecutingPlain', 'Working'),
      desc: tx('agentStatusExecutingDescPlain', 'Running a task and reporting back.'),
    },
    WAITING: {
      dot: 'bg-[var(--app-warning)]',
      dotAnim: '',
      title: tx('agentStatusWaitingPlain', 'Needs your review'),
      desc:
        approvals.length === 1
          ? tx('approvalOneNeedsReview', '1 item needs your review')
          : `${approvals.length} ${tx('approvalsNeedReview', 'items need your review')}`,
    },
    OFFLINE: {
      dot: 'bg-[var(--app-text-dim)]',
      dotAnim: '',
      title: tx('agentStatusOfflinePlain', 'Not running'),
      desc: t('offline'),
    },
    CONNECTING: {
      dot: 'bg-[var(--app-info)]',
      dotAnim: 'animate-pulse',
      title: tx('agentStatusConnectingPlain', 'Starting'),
      desc: tx('agentStatusConnectingDescPlain', 'Bringing Hermes up. This can take a moment.'),
    },
    ERROR: {
      dot: 'bg-[var(--app-danger)]',
      dotAnim: '',
      title: authFailure
        ? tx('agentStatusAuthErrorPlain', 'Connection rejected')
        : tx('agentStatusErrorPlain', 'Could not connect'),
      desc: authFailure
        ? tx(
            'agentStatusAuthErrorDescPlain',
            'Hermes rejected the API key. Add or fix it under Settings.'
          )
        : gatewayFailureReason
          ? plainGatewayFailure(gatewayFailureReason, tx)
          : tx('agentStatusErrorDescPlain', 'Hermes did not respond. Check that it is running.'),
    },
  }[agentStatus];

  // Health can be green while a list endpoint fails; say so instead of
  // repeating "ready to process commands" for a half-working gateway.
  const someDataUnavailable =
    agentStatus === 'ONLINE' && (!!sessionMeta?.error || !!jobMeta?.error);
  const heroDesc = someDataUnavailable
    ? tx(
        'agentStatusPartialPlain',
        'Hermes is running, but some lists did not load. Refresh to try again.'
      )
    : statusConfig.desc;

  // The hero chip names the model the way a person reads it, never as a bare
  // provider token: the live catalog name when the gateway offered one, else
  // the shared resolver (src/services/modelLabel.ts) that Chat uses too, so
  // Home and Chat can never print two names for one model. An empty result
  // means there is no model to name, and the chip stays out of the way.
  const modelName = useMemo(() => {
    const id = (settings.modelId || '').trim();
    const catalog = (models.find((m) => m.id === settings.modelId)?.displayName || '').trim();
    if (catalog && catalog.toLowerCase() !== id.toLowerCase()) return catalog;
    return modelLabel(settings);
  }, [models, settings]);

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
  // newSession() is a live gateway call, so the two "start a chat" entry points
  // below share one in-flight flag: a double tap must not create two chats or
  // post the same chip prompt twice.
  const [isStartingChat, setIsStartingChat] = useState(false);

  // A rejected key cannot be fixed by starting or restarting anything, so the
  // button never spins on that attempt: the moment the failure is known the
  // busy flag is released and the card offers the key fix instead.
  useEffect(() => {
    if (authFailure) setGatewayBusy(false);
  }, [authFailure]);

  // Error vs first-run gating: a real failure (FAILED flag, failed install,
  // rejected API key) turns the status card into the failure card with its
  // fix. A clean offline state (never started / stopped) gets a friendly
  // setup card instead, with no localhost details leaked.
  const isError = gatewayFailed || !!gatewayFailureKind || install === 'FAILED' || authFailure;
  const isInstalling = install === 'INSTALLING';
  const needsInstall = install === 'NOT_INSTALLED';
  const showSetupCard = !effectivelyConnected && !isError && !streaming && !isInstalling;

  // newSession throws truthfully when the gateway is unreachable: surface it
  // instead of navigating to a chat that was never created.
  const handleNewSessionGoChat = async () => {
    if (isStartingChat) return;
    setIsStartingChat(true);
    setActionError(null);
    // Empty-model fast path: creating the session would throw deep in the
    // gateway call and surface as 'not reachable'. Name the real blocker.
    if (!(settings.modelId || '').trim()) {
      setActionError(tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.'));
      setIsStartingChat(false);
      return;
    }
    try {
      await newSession();
      onGoChat();
    } catch {
      setActionError(tx('chatStartFailed', 'Could not start a new chat. Hermes is not reachable.'));
    } finally {
      setIsStartingChat(false);
    }
  };

  // Try-asking chips: a new session is created first, then the chip prompt
  // is sent as the opening message so the tap is never a blank chat.
  const handleChipPromptGoChat = async (prompt: string) => {
    if (isStartingChat) return;
    setIsStartingChat(true);
    setActionError(null);
    if (!(settings.modelId || '').trim()) {
      setActionError(tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.'));
      setIsStartingChat(false);
      return;
    }
    try {
      await newSession();
      sendMessage(prompt);
      onGoChat();
    } catch {
      setActionError(tx('chatStartFailed', 'Could not start a new chat. Hermes is not reachable.'));
    } finally {
      setIsStartingChat(false);
    }
  };

  // Jobs count convention: nav badges show enabled-only; Home surfaces the
  // enabled count with the total as context so the numbers never disagree.
  const enabledJobsCount = useMemo(
    () => jobs.filter((j) => j.enabled).length,
    [jobs]
  );

  // One convention for the scheduled-task count everywhere on this screen:
  // enabled of total, so Home and the Jobs tab never disagree.
  const jobsCountText = `${enabledJobsCount} ${tx('ofWord', 'of')} ${jobs.length} ${tx('enabledWord', 'enabled')}`;

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
        (!connected && sessions.length === 0
          ? tx('notReachable', 'Hermes is not reachable.')
          : undefined),
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
      error:
        jobMeta?.error ||
        (!connected ? tx('notReachable', 'Hermes is not reachable.') : undefined),
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

  // Green means health, nothing else: a job row may claim "Active" only while
  // the gateway is genuinely healthy (effectivelyConnected) and the jobs list
  // itself is not failing or rejected, otherwise the row contradicts the error
  // card above it. Below that the switch position alone is still true, so the
  // row says "Enabled" (the same fact and tone JobsTab shows) and never a
  // second colour for the same word.
  const jobsRunningNow =
    jobsPanelState === null && effectivelyConnected && !jobMeta?.error && !authFailure;

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
      setActionError(tx('refreshFailedPlain', 'Could not refresh. Hermes is still not reachable.'));
    }
  };

  const handleRetryJobs = async () => {
    setActionError(null);
    try {
      await refreshNow();
    } catch {
      setActionError(tx('refreshFailedPlain', 'Could not refresh. Hermes is still not reachable.'));
    }
  };

  const handleStartGateway = async () => {
    if (gatewayBusy) return;
    setActionError(null);
    setGatewayBusy(true);
    try {
      await startGateway();
    } catch {
      setActionError(tx('startFailedPlain', 'Could not start Hermes. Try again.'));
    } finally {
      setGatewayBusy(false);
    }
  };

  // Real restart: stop the process first (a process that is stuck does not
  // recover from a second start), then start it. Both halves report through
  // the context.
  const handleRestartGateway = async () => {
    if (gatewayBusy) return;
    setActionError(null);
    setGatewayBusy(true);
    try {
      await stopGateway();
      await startGateway();
    } catch {
      setActionError(tx('restartFailedPlain', 'Restart failed. Hermes is still not running.'));
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
      setActionError(tx('setupFailedPlain', 'Setup did not finish. Try again.'));
    } finally {
      setGatewayBusy(false);
    }
  };

  // The failure card's ONE action comes from the lifecycle machine, the same
  // source Settings derives Start and Stop from (GATEWAY-03). NOT_INSTALLED
  // is the only state with an install action, so only it offers setup; an
  // installed service that can start offers Start, and a running or degraded
  // service is stopped first and restarted. This used to send every case
  // except NOT_INSTALLED to the install path, so a start failure after a
  // successful 305MB install offered "Try setup again" for a setup that had
  // already worked, while Settings could start the very same state.
  const effectiveGatewayState: GatewayState = isNativeGateway()
    ? gatewayState
    : connected
      ? 'RUNNING'
      : needsInstall
        ? 'NOT_INSTALLED'
        : install === 'FAILED'
          ? 'FAILED'
          : 'STOPPED';
  const uiFlags = deriveUiFlags(effectiveGatewayState);
  const errorCardCta: 'install' | 'start' | 'restart' =
    needsInstall || uiFlags.canInstall
      ? 'install'
      : uiFlags.canStop && !uiFlags.canStart
        ? 'restart'
        : 'start';

  // One entry point, so the button cannot drift from the label above it.
  const runErrorCardCta = (): Promise<void> => {
    if (errorCardCta === 'install') return handleInstallGateway();
    if (errorCardCta === 'start') return handleStartGateway();
    return handleRestartGateway();
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pt-4 hm-tab-bottom">
      {/* 1. Status card: presence, model, and (when something is wrong) the one
          place the failure and its fix live. A single card, so the same
          connection error is never printed twice in two different styles. */}
      <div
        role={isError ? 'alert' : undefined}
        className={`r-md elev-0 overflow-hidden bg-[var(--app-card)] p-5 ${
          isError ? 'border border-[var(--app-danger-border)]' : 'edge'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-3">
            {/* The status title owns its own line and is free to wrap, so it
                never clips to "Hermes is run" next to a width-hungry pill. */}
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${statusConfig.dot} ${statusConfig.dotAnim}`}
              />
              <span
                className={`t-heading min-w-0 break-words ${
                  isError ? 'text-[var(--app-danger)]' : 'text-[var(--app-text)]'
                }`}
              >
                {statusConfig.title}
              </span>
            </div>
            {/* The model sits below the status on its own row, so the status
                and the model name each get the full card width and neither is
                ever clipped. */}
            {modelName && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ExpandablePill
                  value={modelName}
                  full={settings.modelId}
                  label={tx('modelLabel', 'Model')}
                  expandHint={tx('tapToExpand', 'Tap to expand')}
                  collapseHint={tx('tapToCollapse', 'Tap to collapse')}
                  className="max-w-full"
                />
              </div>
            )}
            <p className="t-body pe-2 text-[var(--app-text-muted)]">{heroDesc}</p>
          </div>

          {agentStatus === 'WAITING' && (
            <button
              onClick={onGoChat}
              className="hm-hit r-sm flex min-h-[44px] shrink-0 items-center gap-1 border border-[var(--app-warning-border)] bg-[var(--app-warning-subtle)] px-3 t-label text-[var(--app-warning)] transition cursor-pointer active:scale-95"
            >
              <span>{tx('review', 'Review')} ({approvals.length})</span>
              <ChevronRight className="h-3.5 w-3.5 rtl-flip" />
            </button>
          )}
        </div>

        {/* The fix belongs to the failure, so it lives in the same card. A
            rejected key is terminal: no start or restart is offered there,
            only the key fix and a re-check. */}
        {isError && (
          <div className="mt-4 flex items-center gap-2">
            {authFailure ? (
              <button
                onClick={onGoSettings}
                className="r-sm flex min-h-[40px] flex-1 items-center justify-center gap-2 bg-[var(--app-accent)] px-4 t-label text-[var(--app-on-accent)] transition cursor-pointer hover:bg-[var(--app-accent-hover)]"
              >
                <KeyRound className="h-4 w-4" />
                <span>{tx('fixApiKeyAction', 'Add or fix the key')}</span>
              </button>
            ) : (
              <button
                onClick={() => void runErrorCardCta()}
                disabled={gatewayBusy}
                className="r-sm flex min-h-[40px] flex-1 items-center justify-center gap-2 bg-[var(--app-accent)] px-4 t-label text-[var(--app-on-accent)] transition cursor-pointer hover:bg-[var(--app-accent-hover)] disabled:opacity-60"
              >
                {errorCardCta === 'install' ? (
                  <Download className={`h-4 w-4 ${gatewayBusy ? 'animate-pulse' : ''}`} />
                ) : errorCardCta === 'start' ? (
                  <Play className={`h-4 w-4 ${gatewayBusy ? 'animate-pulse' : ''}`} />
                ) : (
                  <RefreshCw className={`h-4 w-4 ${gatewayBusy ? 'animate-spin' : ''}`} />
                )}
                <span>
                  {errorCardCta === 'install'
                    ? gatewayBusy
                      ? t('installing')
                      : tx('setupHermesAction', 'Set up Hermes')
                    : gatewayBusy
                      ? `${t('starting')}…`
                      : errorCardCta === 'start'
                        ? tx('startService', 'Start')
                        : tx('restartHermes', 'Restart Hermes')}
                </span>
              </button>
            )}
            <button
              onClick={() => void (authFailure ? handleRetrySessions() : onGoSettings())}
              className="r-sm edge elev-0 flex min-h-[40px] items-center justify-center bg-[var(--app-card-subtle)] px-4 t-label text-[var(--app-text-muted)] transition cursor-pointer hover:text-[var(--app-text)]"
            >
              {authFailure ? tx('tryAgainPlain', 'Try again') : tx('settingsTitle', 'Settings')}
            </button>
          </div>
        )}

        {/* Session strip: "Current task" only while a turn is running */}
        {showTaskStrip && (
          <>
          {/* In-card divider: .hairline is a full 1px subtle border, so it sits
              on its own zero-height rule element rather than on the strip. */}
          <div className="mt-4 hairline" aria-hidden="true" />
          <div className="flex items-center justify-between gap-3 pt-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="t-label shrink-0 text-[var(--app-text-muted)]">
                {taskStripLabel}:
              </span>
              <ExpandablePill
                value={stripValue}
                full={stripValue}
                label={taskStripLabel}
                expandHint={tx('tapToExpand', 'Tap to expand')}
                collapseHint={tx('tapToCollapse', 'Tap to collapse')}
                className="max-w-full"
              />
            </div>
            {streaming && (
              <span className="flex shrink-0 items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[var(--app-info)] animate-ping" />
                <span className="pill-info">{tx('live', 'Live')}</span>
              </span>
            )}
          </div>
          </>
        )}
      </div>

      {/* First-run setup card: shown only when nothing is wrong, so it never
          competes with the failure card above. */}
      {showSetupCard && (
        <div className="r-md edge elev-0 flex flex-col gap-4 bg-[var(--app-card)] p-4">
          <div className="flex flex-col gap-1">
            <h3 className="t-heading text-[var(--app-text)]">
              {needsInstall ? tx('setupHermesTitle', 'Set up Hermes') : tx('getStarted', 'Get started')}
            </h3>
            <p className="t-caption text-[var(--app-text-muted)]">
              {needsInstall
                ? tx(
                    'setupHermesHint',
                    'Set up Hermes on this device to start your first chat.'
                  )
                : tx('startHermesHint', 'Start Hermes to begin your first chat.')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void (needsInstall ? handleInstallGateway() : handleStartGateway())}
              disabled={gatewayBusy}
              className="r-sm flex min-h-[40px] flex-1 items-center justify-center gap-2 bg-[var(--app-accent)] px-4 t-label text-[var(--app-on-accent)] transition cursor-pointer hover:bg-[var(--app-accent-hover)] disabled:opacity-60"
            >
              {needsInstall ? (
                <Download className={`h-4 w-4 ${gatewayBusy ? 'animate-pulse' : ''}`} />
              ) : (
                <RefreshCw className={`h-4 w-4 ${gatewayBusy ? 'animate-spin' : ''}`} />
              )}
              <span>
                {needsInstall
                  ? gatewayBusy
                    ? t('installing')
                    : tx('setupHermesAction', 'Set up Hermes')
                  : gatewayBusy
                    ? `${t('starting')}…`
                    : tx('startHermes', 'Start Hermes')}
              </span>
            </button>
            <button
              onClick={onGoSettings}
              className="r-sm edge elev-0 flex min-h-[40px] items-center justify-center bg-[var(--app-card-subtle)] px-4 t-label text-[var(--app-text-muted)] transition cursor-pointer hover:text-[var(--app-text)]"
            >
              {tx('settingsTitle', 'Settings')}
            </button>
          </div>
        </div>
      )}

      {/* 2. Fast actions: one row shape for all four (title plus a single
          caption line), accent reserved for the primary action. */}
      <section className="flex flex-col gap-3">
        <h2 className="t-micro text-[var(--app-text-muted)]">{tx('quickActionsTitle', 'Quick actions')}</h2>

        <div className="flex flex-col gap-2">
          {/* New Chat is the one primary action: accent surface. */}
          <button
            onClick={() => void handleNewSessionGoChat()}
            disabled={isStartingChat}
            className="r-sm edge elev-0 flex w-full items-center gap-3 bg-[var(--app-accent-subtle)] p-3 text-start transition cursor-pointer active:scale-[0.99] disabled:opacity-50"
          >
            <span className="r-sm flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--app-accent)] text-[var(--app-on-accent)]">
              <MessageSquare className="h-5 w-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="t-heading truncate text-[var(--app-text)]">
                {tx('newChat', 'New chat')}
              </span>
              <span className="t-caption truncate text-[var(--app-text-muted)]">
                {tx('chatActionDesc', 'Start a conversation with Hermes')}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-text-dim)] rtl-flip" />
          </button>

          {/* Diagnostics: this row opens the Settings tab, so it says so. */}
          <button
            onClick={onGoDiagnostics}
            aria-label={tx('connectionCheckTitle', 'Check connection')}
            className="r-sm edge elev-0 flex w-full items-center gap-3 bg-[var(--app-card)] p-3 text-start transition cursor-pointer hover:bg-[var(--app-card-hover)] active:scale-[0.99]"
          >
            <span className="r-sm flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--app-card-subtle)] text-[var(--app-text-muted)]">
              <Terminal className="h-5 w-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="t-heading truncate text-[var(--app-text)]">
                {tx('connectionCheckTitle', 'Check connection')}
              </span>
              <span className="t-caption truncate text-[var(--app-text-muted)]">
                {tx('connectionCheckDesc', 'Connection state and recent details')}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-text-dim)] rtl-flip" />
          </button>

          {/* Scheduled tasks: same count convention as the section header. */}
          <button
            onClick={onGoActivity}
            className="r-sm edge elev-0 flex w-full items-center gap-3 bg-[var(--app-card)] p-3 text-start transition cursor-pointer hover:bg-[var(--app-card-hover)] active:scale-[0.99]"
          >
            <span className="r-sm flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--app-card-subtle)] text-[var(--app-text-muted)]">
              <CalendarClock className="h-5 w-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="t-heading truncate text-[var(--app-text)]">
                {tx('scheduledTasksTitle', 'Scheduled tasks')}
              </span>
              <span className="t-caption truncate text-[var(--app-text-muted)]">
                {jobsCountKnown
                  ? jobsCountText
                  : tx('countsUnknownPlain', 'Not available yet')}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-text-dim)] rtl-flip" />
          </button>
          {/* Settings has no tile here: the Settings tab sits in the bottom
              nav (and the desktop sidebar) at all times, so a fourth row
              only duplicated an always-visible destination. The three rows
              above keep the section balanced. */}
        </div>
      </section>

      {/* 3. Recent Sessions & Activity Section */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="t-micro text-[var(--app-text-muted)]">{tx('recentSessionsTitle', 'Recent chats')}</h2>
          {sessions.length > 0 && (
            <button
              onClick={onGoSessions}
              className="hm-hit inline-flex min-h-[44px] items-center px-2 t-label text-[var(--app-accent-text)] transition-colors cursor-pointer hover:text-[var(--app-text)]"
            >
              {tx('viewAll', 'View all')}
            </button>
          )}
        </div>

        {actionError && (
          <div
            role="alert"
            className="r-sm border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)] px-4 py-3 t-caption text-[var(--app-danger)]"
          >
            <p>{actionError}</p>
          </div>
        )}
        {!actionError && (recentListState === 'stale' || recentListState === 'offline') && (
          <div
            role="status"
            className="r-sm border border-[var(--app-warning-border)] bg-[var(--app-warning-subtle)] px-4 py-3 t-caption text-[var(--app-warning)]"
          >
            <p>
              {t('offline')}: {tx('showingSavedSessions', 'showing saved sessions')}
              {sessionsSyncedLabel ? ` · ${sessionsSyncedLabel}` : ''}
            </p>
          </div>
        )}

        {recentListState === 'error' ? (
          <div
            role="alert"
            className={`r-md elev-0 flex flex-col gap-4 border bg-[var(--app-card)] p-4 text-center ${
              isError ? 'edge' : 'border-[var(--app-danger-border)]'
            }`}
          >
            <div className="flex flex-col gap-1">
              <p className="t-heading text-[var(--app-text)]">
                {tx('sessionsUnavailableTitle', 'Could not load your chats')}
              </p>
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx(
                  'sessionsUnavailableBody',
                  'Nothing was lost. Check that Hermes is running, then try again.'
                )}
              </p>
            </div>
            <button
              onClick={() => void handleRetrySessions()}
              className="hm-hit r-sm mx-auto flex min-h-[44px] items-center justify-center bg-[var(--app-accent)] px-4 t-label text-[var(--app-on-accent)] transition cursor-pointer hover:bg-[var(--app-accent-hover)]"
            >
              {t('refresh')}
            </button>
          </div>
        ) : recentSessions.length === 0 ? (
          <div className="r-md edge elev-0 flex flex-col gap-4 bg-[var(--app-card)] p-4 text-center">
            <div className="r-md mx-auto flex h-12 w-12 items-center justify-center bg-[var(--app-card-subtle)] text-[var(--app-text-muted)]">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="t-heading text-[var(--app-text)]">
                {tx('noChatsYet', 'No chats yet')}
              </p>
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx('noChatsYetBody', 'Start a conversation and it will show up here.')}
              </p>
            </div>
            <button
              onClick={() => void handleNewSessionGoChat()}
              disabled={isStartingChat}
              className="hm-hit r-sm mx-auto flex min-h-[44px] items-center justify-center bg-[var(--app-accent)] px-4 t-label text-[var(--app-on-accent)] transition cursor-pointer hover:bg-[var(--app-accent-hover)] disabled:opacity-50"
            >
              {tx('newChat', 'New chat')}
            </button>
            <div className="flex flex-col gap-2 pt-1">
              <p className="t-caption text-[var(--app-text-dim)]">{tx('tryAsking', 'Try asking:')}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {tryPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => void handleChipPromptGoChat(prompt)}
                    disabled={isStartingChat}
                    className="hm-hit r-xs edge flex min-h-[36px] items-center bg-[var(--app-card-subtle)] px-3 t-caption text-[var(--app-text-muted)] transition cursor-pointer hover:text-[var(--app-text)] disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
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
                  className={`r-sm edge relative flex cursor-pointer items-center justify-between gap-3 overflow-hidden p-3 transition ${
                    isSelected
                      ? 'bg-[var(--app-card-subtle)]'
                      : 'bg-[var(--app-card)] hover:bg-[var(--app-card-hover)]'
                  }`}
                >
                  {/* Selection is a surface tint plus a leading accent bar,
                      never a ring that reads as focus or as an error. */}
                  {isSelected && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 start-0 w-[3px] bg-[var(--app-accent)]"
                    />
                  )}
                  <div className="flex min-w-0 items-center gap-3 ps-2">
                    <div
                      className={`r-sm flex h-10 w-10 shrink-0 items-center justify-center ${
                        isLive
                          ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)]'
                          : 'bg-[var(--app-card-subtle)] text-[var(--app-text-muted)]'
                      }`}
                    >
                      <MessageSquare className="h-5 w-5" />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="t-heading truncate text-[var(--app-text)]">
                        {s.title || t('newSession')}
                      </p>
                      <div className="flex items-center gap-2 t-caption text-[var(--app-text-muted)]">
                        <span>{s.messageCount} {s.messageCount === 1 ? tx('messageOne', 'message') : tx('messagesCount', 'messages')}</span>
                        <span>·</span>
                        <span>{homeAgo(s.lastActiveAt, settings.language || 'en')}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {isLive && <span className="pill-info">{tx('live', 'Live')}</span>}
                    <ChevronRight className="h-4 w-4 text-[var(--app-text-dim)] rtl-flip" />
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
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="t-micro text-[var(--app-text-muted)]">
              {tx('scheduledTasksTitle', 'Scheduled tasks')}
            </h2>
            {jobsCountKnown ? (
              <button
                onClick={onGoActivity}
                className="hm-hit inline-flex min-h-[44px] items-center px-2 t-label text-[var(--app-accent-text)] transition-colors cursor-pointer hover:text-[var(--app-text)]"
              >
                {jobsCountText}
              </button>
            ) : (
              <button
                onClick={() => void handleRetryJobs()}
                className="hm-hit inline-flex min-h-[44px] items-center px-2 t-label text-[var(--app-accent-text)] transition-colors cursor-pointer hover:text-[var(--app-text)]"
              >
                {t('refresh')}
              </button>
            )}
          </div>

          {jobsPanelState === 'stale' && (
            <div
              role="status"
              className="r-sm border border-[var(--app-warning-border)] bg-[var(--app-warning-subtle)] px-4 py-3 t-caption text-[var(--app-warning)]"
            >
              <p>
                {t('offline')}:{' '}
                {tx('showingSavedTasks', 'showing saved tasks, so the counts may be out of date')}
                {jobsSyncedLabel ? ` · ${jobsSyncedLabel}` : ''}
              </p>
            </div>
          )}

          {jobsPanelState === 'loading' && (
            <div
              role="status"
              className="r-md edge elev-0 bg-[var(--app-card)] p-4 t-caption text-[var(--app-text-muted)]"
            >
              {tx('loadingTasks', 'Loading your scheduled tasks…')}
            </div>
          )}

          {jobsPanelState === 'error' && (
            <div
              role="alert"
              className="r-md elev-0 flex flex-col gap-4 border border-[var(--app-danger-border)] bg-[var(--app-card)] p-4 text-center"
            >
              <div className="flex flex-col gap-1">
                <p className="t-heading text-[var(--app-text)]">
                  {tx('tasksUnavailableTitle', 'Could not load your scheduled tasks')}
                </p>
                <p className="t-caption text-[var(--app-text-muted)]">
                  {tx('tasksUnavailableBody', 'Nothing was lost. Refresh to try again.')}
                </p>
              </div>
              <button
                onClick={() => void handleRetryJobs()}
                className="hm-hit r-sm mx-auto flex min-h-[44px] items-center justify-center bg-[var(--app-accent)] px-4 t-label text-[var(--app-on-accent)] transition cursor-pointer hover:bg-[var(--app-accent-hover)]"
              >
                {t('refresh')}
              </button>
            </div>
          )}

          {jobs.length > 0 && jobsPanelState !== 'error' && (
            <div className="flex flex-col gap-2">
              {jobs.slice(0, 3).map((job) => (
                <div
                  key={job.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${tx('openScheduledTasks', 'Open scheduled tasks')}: ${job.name}`}
                  onClick={onGoActivity}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onGoActivity();
                    }
                  }}
                  className="r-sm edge elev-0 flex cursor-pointer items-center justify-between gap-3 bg-[var(--app-card)] p-3 transition hover:bg-[var(--app-card-hover)]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="r-sm flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--app-card-subtle)] text-[var(--app-text-muted)]">
                      <CheckCircle2 className="h-5 w-5" />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="t-heading truncate text-[var(--app-text)]">{job.name}</p>
                      <p
                        className="t-caption truncate text-[var(--app-text-muted)]"
                        title={job.scheduleDisplay}
                      >
                        {scheduleSummary(job.scheduleDisplay) || tx('customSchedule', 'Custom schedule')}
                      </p>
                    </div>
                  </div>
                  {/* The word, not the colour, separates the states: "Active"
                      (success) means confirmed running now, "Enabled"
                      (accent) means the switch is on while health is not
                      confirmed, "Stopped" (neutral) means off. Same fact,
                      same tone everywhere: JobsTab labels its accent pill
                      "Enabled" as well, so green and indigo never carry one
                      shared meaning. */}
                  <span
                    className={
                      job.enabled
                        ? jobsRunningNow
                          ? 'pill-success'
                          : 'pill-accent'
                        : 'pill-neutral'
                    }
                  >
                    {job.enabled ? (jobsRunningNow ? t('active') : t('enabled')) : t('stopped')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

// Short, honest model alias for the hero chip: the full id lives in the model
// sheet, so the chip only needs the leading token of the last path segment.
export function modelAlias(id: string): string {
  const seg = (id || '').split('/').pop() || '';
  if (!seg) return '';
  return seg.split(/[-_]/)[0] || seg;
}

// The model name is no longer formatted here: src/services/modelLabel.ts is
// the one resolver Home and Chat both call, so one model id can never read
// as two different names on two screens.

const ExpandablePill: React.FC<{
  value: string;
  full: string;
  /** Human word for what the pill shows, used as the accessible label. */
  label: string;
  expandHint: string;
  collapseHint: string;
  className?: string;
}> = ({ value, full, label, expandHint, collapseHint, className = '' }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      title={full}
      aria-label={`${label}: ${full}. ${expanded ? collapseHint : expandHint}.`}
      className={`hm-hit r-sm edge elev-0 inline-flex min-h-[36px] min-w-0 items-center gap-1 bg-[var(--app-card-subtle)] px-3 t-caption text-[var(--app-text-muted)] cursor-pointer ${className}`}
    >
      {/* Sans, like the rest of this screen, and free to wrap: a session
          title or a model name is copy, not a code token, and it must never
          be cut off inside the pill. */}
      <span className="min-w-0 whitespace-normal break-words">
        {expanded ? full : value}
      </span>
      {/* The chevron follows the real expanded state, so it can never look
          like a menu that opens while it only grows the text. */}
      <ChevronDown
        className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
      />
    </button>
  );
};
