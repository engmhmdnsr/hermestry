import React, { useMemo, useState } from 'react';
import {
  MessageSquare,
  Terminal,
  CalendarClock,
  ArrowRight,
  RefreshCw,
  SlidersHorizontal,
  CheckCircle2,
  ChevronRight,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { AgentStatus } from '../../types/hermes';
import { formatHomeAgo } from '../../constants/languages';

interface HomeTabProps {
  onGoChat: () => void;
  onRunCommand: () => void;
  onGoActivity: () => void;
  onGoSettings: () => void;
}

export function homeAgo(ts: number, lang: string = 'en'): string {
  return formatHomeAgo(ts, lang);
}

export const HomeTab: React.FC<HomeTabProps> = ({
  onGoChat,
  onRunCommand,
  onGoActivity,
  onGoSettings,
}) => {
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
    startGateway,
    settings,
    t,
  } = useHermes();

  // Determine Agent Status
  const agentStatus: AgentStatus = useMemo(() => {
    if (gatewayFailed || install === 'FAILED') return 'ERROR';
    if (approvals.length > 0) return 'WAITING';
    if (streaming) {
      const lastMsg = chat[chat.length - 1];
      if (lastMsg && lastMsg.sender === 'hermes' && !lastMsg.thinkingDone) {
        return 'THINKING';
      }
      return 'EXECUTING';
    }
    if (install === 'INSTALLING' || (install === 'RUNNING' && !connected)) {
      return 'CONNECTING';
    }
    if (!connected) return 'OFFLINE';
    return 'ONLINE';
  }, [gatewayFailed, install, approvals.length, streaming, chat, connected]);

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
      desc: `${approvals.length} ${t('approvalNeeded')}`,
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
      accent: 'text-amber-400',
      bgGlow: 'from-amber-500/10 via-transparent to-transparent',
      borderColor: 'border-amber-500/20',
      badgeBg: 'bg-amber-400/10 text-amber-300 border-amber-500/30',
      title: t('agentStatusConnecting'),
      desc: t('starting'),
    },
    ERROR: {
      accent: 'text-rose-400',
      bgGlow: 'from-rose-500/10 via-transparent to-transparent',
      borderColor: 'border-rose-500/20',
      badgeBg: 'bg-rose-400/10 text-rose-300 border-rose-500/30',
      title: t('agentStatusError'),
      desc: gatewayFailureReason || t('agentStatusError'),
    },
  }[agentStatus];

  const currentTaskDesc = useMemo(() => {
    if (streaming) {
      const lastUser = chat.slice().reverse().find((m) => m.sender === 'you')?.content;
      return lastUser ? lastUser : t('agentStatusThinking');
    }
    const latest = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (latest) {
      return `${latest.title || t('newSession')} · ${latest.messageCount} msgs`;
    }
    return t('agentStatusOnlineDesc');
  }, [streaming, chat, sessions, t]);

  const recentSessions = useMemo(() => {
    return [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 4);
  }, [sessions]);

  return (
    <div className="space-y-6 max-w-2xl mx-auto px-4 pt-4 pb-20">
      {/* 1. Hero Presence Banner */}
      <div
        className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${statusConfig.bgGlow} bg-[#0E1217] border ${statusConfig.borderColor} p-5 shadow-sm transition-all`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${
                agentStatus === 'ONLINE' ? 'bg-emerald-400 animate-pulse' :
                agentStatus === 'WAITING' ? 'bg-amber-400' :
                agentStatus === 'EXECUTING' || agentStatus === 'THINKING' ? 'bg-teal-400 animate-ping' :
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
              {statusConfig.desc}
            </p>
          </div>

          <button
            onClick={onGoChat}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-white text-xs font-medium border border-white/[0.1] active:scale-95 transition cursor-pointer shrink-0"
          >
            <span>{t('chat')}</span>
            <ArrowRight className="w-3.5 h-3.5 rtl-flip" />
          </button>
        </div>

        {/* Current task progress strip */}
        <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] text-slate-400 font-medium shrink-0">{t('activeModel')}:</span>
            <ExpandablePill
              value={currentTaskDesc}
              full={currentTaskDesc}
              className="max-w-[280px] text-slate-200"
            />
          </div>
          {streaming && (
            <span className="text-[10px] font-mono text-teal-400 uppercase tracking-wider shrink-0 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-ping" />
              Live
            </span>
          )}
        </div>
      </div>

      {/* Circuit-Breaker Resolution Card (if needed) */}
      {(gatewayFailed || install === 'FAILED' || !connected) && (
        <div className="rounded-2xl bg-rose-950/20 border border-rose-500/20 p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold text-rose-300">{t('agentStatusOffline')}</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {gatewayFailureReason || 'Daemon not accepting connections at localhost:8080'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => startGateway()}
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{t('restartDaemon')}</span>
            </button>
            <button
              onClick={onGoSettings}
              className="px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-slate-300 text-xs font-medium border border-white/[0.08] transition cursor-pointer"
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
            onClick={async () => {
              await newSession();
              onGoChat();
            }}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[#0E1217] border border-white/[0.07] hover:border-indigo-500/40 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <MessageSquare className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">{t('launchChat')}</span>
            <span className="text-[11px] text-slate-400 mt-0.5">{t('launchChatDesc')}</span>
          </button>

          {/* Quick Command */}
          <button
            onClick={onRunCommand}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[#0E1217] border border-white/[0.07] hover:border-teal-500/40 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-teal-500/10 text-teal-400 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <Terminal className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">{t('diagnosticsAction')}</span>
            <span className="text-[11px] text-slate-400 mt-0.5">{t('diagnosticsActionDesc')}</span>
          </button>

          {/* Automation Jobs */}
          <button
            onClick={onGoActivity}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[#0E1217] border border-white/[0.07] hover:border-violet-500/40 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-violet-500/10 text-violet-400 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <CalendarClock className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">{t('cronAction')}</span>
            <span className="text-[11px] text-slate-400 mt-0.5">{jobs.length} {t('jobs')}</span>
          </button>

          {/* Settings / Ops */}
          <button
            onClick={onGoSettings}
            className="flex flex-col items-start p-3.5 rounded-2xl bg-[#0E1217] border border-white/[0.07] hover:border-white/20 hover:bg-white/[0.02] active:scale-[0.98] transition group cursor-pointer text-start"
          >
            <div className="w-8 h-8 rounded-xl bg-slate-500/10 text-slate-300 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-white">{t('settingsAction')}</span>
            <span className="text-[11px] text-slate-400 mt-0.5">{t('settingsActionDesc')}</span>
          </button>
        </div>
      </section>

      {/* 3. Recent Sessions & Activity Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
            {t('recentSessions')}
          </h2>
          <button
            onClick={onGoChat}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium cursor-pointer"
          >
            {t('recentSessions')}
          </button>
        </div>

        {recentSessions.length === 0 ? (
          <div className="p-8 rounded-2xl bg-[#0E1217] border border-white/[0.06] text-center space-y-3">
            <div className="w-10 h-10 rounded-2xl bg-white/[0.03] text-slate-400 flex items-center justify-center mx-auto">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-white">{t('noSessionsYet')}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {t('launchChatDesc')}
              </p>
            </div>
            <button
              onClick={async () => {
                await newSession();
                onGoChat();
              }}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition cursor-pointer"
            >
              {t('newSession')}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {recentSessions.map((s) => {
              const isSelected = s.id === currentSessionId;
              const isLive = streaming && isSelected;

              return (
                <div
                  key={s.id}
                  onClick={() => {
                    selectSession(s.id);
                    onGoChat();
                  }}
                  className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    isSelected
                      ? 'bg-[#141920] border-indigo-500/40 shadow-xs'
                      : 'bg-[#0E1217] border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.02]'
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
                        <span>{s.messageCount} msgs</span>
                        <span>·</span>
                        <span>{homeAgo(s.lastActiveAt, settings.language || 'en')}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isLive && (
                      <span className="px-2 py-0.5 rounded-md bg-teal-500/10 text-teal-300 font-mono text-[10px] font-medium">
                        Streaming
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

      {/* 4. Active Scheduled Jobs Overview */}
      {jobs.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
              {t('scheduledCron')}
            </h2>
            <button
              onClick={onGoActivity}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium cursor-pointer"
            >
              {t('jobs')} ({jobs.length})
            </button>
          </div>

          <div className="space-y-2">
            {jobs.slice(0, 3).map((job) => (
              <div
                key={job.id}
                onClick={onGoActivity}
                className="p-3.5 rounded-2xl bg-[#0E1217] border border-white/[0.06] hover:border-white/[0.12] flex items-center justify-between gap-3 cursor-pointer transition"
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
                <ChevronRight className="w-4 h-4 text-slate-500 shrink-0 rtl-flip" />
              </div>
            ))}
          </div>
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
      className={`text-slate-400 font-mono text-[11px] min-w-0 text-start cursor-pointer ${expanded ? '' : `truncate ${className}`} ${expanded ? 'whitespace-normal break-all' : ''}`}
    >
      {value}
    </button>
  );
};
