import React, { useState } from 'react';
import {
  LayoutGrid,
  MessageSquare,
  CalendarClock,
  SlidersHorizontal,
  Plus,
  Star,
  Search,
  SidebarClose,
  SidebarOpen,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { resolveListUiState } from '../../services/pagination';

interface DesktopSidebarProps {
  currentTab: number;
  onSelectTab: (tab: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenNewChat: () => void;
}

export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({
  currentTab,
  onSelectTab,
  collapsed,
  onToggleCollapse,
  onOpenNewChat,
}) => {
  const {
    connected,
    sessions,
    currentSessionId,
    selectSession,
    pinnedIds,
    togglePin,
    approvals,
    jobs,
    settings,
    refreshNow,
    t,
  } = useHermes();

  const [sessionSearch, setSessionSearch] = useState('');
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Session list truthfulness: the context list is the cache; when the
  // gateway is unreachable it is stale, not live. Never render it as live.
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const sidebarListState = resolveListUiState(
    {
      live: connected,
      stale: !connected && sessions.length > 0,
      error: !connected && sessions.length === 0 ? 'Gateway unreachable' : undefined,
    },
    sessions.length,
    { offline: browserOffline || !connected }
  );

  const handleRetrySessions = async () => {
    setListError(null);
    try {
      await refreshNow();
    } catch {
      setListError('Retry failed. The gateway is still unreachable.');
    }
  };

  const navItems = [
    { id: 0, label: t('home') || 'Overview', icon: LayoutGrid },
    // Approvals are actioned in Chat (ApprovalCard queue), so the pending
    // count lives here, not on Settings.
    { id: 1, label: t('chat') || 'Workspace Chat', icon: MessageSquare, badge: approvals.length },
    { id: 2, label: t('jobs') || 'Cron & Tasks', icon: CalendarClock, badge: jobs.filter(j => j.enabled).length },
    { id: 3, label: t('settings') || 'Ops & Settings', icon: SlidersHorizontal },
  ];

  const filteredSessions = sessions.filter(s =>
    !sessionSearch.trim() ||
    s.title.toLowerCase().includes(sessionSearch.toLowerCase()) ||
    s.id.toLowerCase().includes(sessionSearch.toLowerCase())
  );

  const pinnedList = filteredSessions.filter(s => pinnedIds.includes(s.id));
  const unpinnedSessions = filteredSessions.filter(s => !pinnedIds.includes(s.id));
  const recentList = showAllRecent ? unpinnedSessions : unpinnedSessions.slice(0, 10);

  return (
    <aside
      className={`h-screen border-e flex flex-col transition-all duration-200 select-none shrink-0 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
      style={{
        backgroundColor: 'var(--app-sidebar, #080B0E)',
        borderColor: 'var(--app-border, rgba(255,255,255,0.07))',
      }}
    >
      {/* 1. App Brand Bar */}
      <div className="h-14 border-b border-white/[0.06] flex items-center justify-between px-3.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-500/20 via-violet-500/20 to-teal-500/20 border border-indigo-500/30 p-1 flex items-center justify-center shrink-0">
            <img
              src="/ic_hermes_logo.png"
              alt="Hermes Logo"
              className="w-full h-full object-contain"
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-xs text-white tracking-tight">
                  Hermes
                </span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-mono">
                  {t('deskTag')}
                </span>
              </div>
              <p className="text-[10px] text-slate-500 truncate leading-none mt-0.5">
                {settings.baseUrl || '127.0.0.1:8080'}
              </p>
            </div>
          )}
        </div>

        <button
          onClick={onToggleCollapse}
          className="w-7 h-7 min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.06] transition"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <SidebarOpen className="w-4 h-4 rtl-flip" /> : <SidebarClose className="w-4 h-4 rtl-flip" />}
        </button>
      </div>

      {/* 2. Primary Navigation */}
      <div className={`p-2 space-y-1 ${collapsed ? '[&>button]:flex-col [&>button]:gap-1 [&>button]:px-1 [&>button]:py-2' : ''}`}>
        {navItems.map((item) => {
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer relative group ${
                isActive
                  ? 'bg-indigo-600/15 text-indigo-300 font-semibold border border-indigo-500/30 shadow-xs'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
              title={item.label}
              aria-label={item.label}
            >
              <item.icon
                className={`w-4 h-4 shrink-0 transition-transform ${
                  isActive ? 'text-indigo-400 scale-105' : 'text-slate-400 group-hover:text-white'
                }`}
              />
              {!collapsed ? (
                <span className="truncate flex-1 text-start">{item.label}</span>
              ) : (
                <span className="text-[9px] leading-tight line-clamp-2 text-center w-full">{item.label}</span>
              )}

              {/* Badges */}
              {item.badge !== undefined && item.badge > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-white/[0.08] text-[10px] text-slate-300 font-mono">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 3. New Chat Button */}
      <div className="p-2.5">
        <button
          onClick={onOpenNewChat}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white text-xs font-semibold shadow-xs transition cursor-pointer"
          title={t('newSession')}
          aria-label={t('newSession')}
        >
          <Plus className="w-4 h-4" />
          {!collapsed && <span>{t('newSession')}</span>}
        </button>
      </div>

      {/* 4. Desktop Sessions Panel */}
      {!collapsed ? (
        <div className="flex-1 overflow-y-auto px-2 space-y-3 pb-3">
          {(sidebarListState === 'stale' || sidebarListState === 'offline') && (
            <div role="status" className="mx-1 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300">
              <p className="font-semibold">Offline, showing cached sessions</p>
            </div>
          )}
          {sidebarListState === 'error' && (
            <div role="alert" className="mx-1 px-2.5 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300 space-y-1.5">
              <p>Could not load sessions. Gateway unreachable.</p>
              <button
                onClick={() => void handleRetrySessions()}
                className="px-2.5 min-h-[44px] rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-200 font-semibold cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}
          {listError && (
            <div role="alert" className="mx-1 px-2.5 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300">
              <p>{listError}</p>
            </div>
          )}
          {/* Quick Search */}
          <div className="relative px-1 pt-1">
            <Search className="w-3.5 h-3.5 absolute start-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              placeholder={t('filterSessions')}
              className="w-full ps-8 pe-2.5 py-1.5 rounded-lg bg-[var(--app-card,#11151B)] border border-white/[0.06] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          {/* Pinned / Starred */}
          {pinnedList.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 px-2 text-[10px] font-semibold text-amber-400 uppercase tracking-wider">
                <Star className="w-2.5 h-2.5 fill-amber-400" />
                <span>Favorites</span>
              </div>
              {pinnedList.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open session ${s.title || t('newSession')}`}
                  onClick={() => {
                    selectSession(s.id);
                    onSelectTab(1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectSession(s.id);
                      onSelectTab(1);
                    }
                  }}
                  className={`group flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition ${
                    s.id === currentSessionId && currentTab === 1
                      ? 'bg-indigo-600/20 text-white font-medium border border-indigo-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                  }`}
                >
                  <span className="truncate flex-1">{s.title || t('newSession')}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus:opacity-100 min-w-[44px] min-h-[44px] flex items-center justify-center text-amber-400 hover:scale-110 transition"
                    title={pinnedIds.includes(s.id) ? 'Unpin from favorites' : 'Pin to favorites'}
                    aria-label={`${pinnedIds.includes(s.id) ? 'Unpin' : 'Pin'} ${s.title || 'Untitled session'}`}
                  >
                    <Star className="w-3 h-3 fill-amber-400" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Recent Sessions */}
          <div className="space-y-1">
            <div className="px-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                {t('recentSessions')}
              </span>
              {unpinnedSessions.length > 10 && (
                <button
                  onClick={() => setShowAllRecent((v) => !v)}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
                >
                  {showAllRecent ? 'Show less' : `View all (${unpinnedSessions.length})`}
                </button>
              )}
            </div>
            {recentList.length === 0 ? (
              sidebarListState === 'error' ? null : (
                <p className="px-2 text-[11px] text-slate-600">{t('noSessionsYet')}</p>
              )
            ) : (
              recentList.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open session ${s.title || t('newSession')}`}
                  onClick={() => {
                    selectSession(s.id);
                    onSelectTab(1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectSession(s.id);
                      onSelectTab(1);
                    }
                  }}
                  className={`group flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition ${
                    s.id === currentSessionId && currentTab === 1
                      ? 'bg-indigo-600/20 text-white font-medium border border-indigo-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                  }`}
                >
                  <span className="truncate flex-1">{s.title || t('newSession')}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus:opacity-100 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:text-amber-400 transition"
                    title={pinnedIds.includes(s.id) ? 'Unpin from favorites' : 'Pin to favorites'}
                    aria-label={`${pinnedIds.includes(s.id) ? 'Unpin' : 'Pin'} ${s.title || 'Untitled session'}`}
                  >
                    <Star className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center py-2 space-y-2">
          {recentList.slice(0, 5).map((s) => (
            <button
              key={s.id}
              onClick={() => {
                selectSession(s.id);
                onSelectTab(1);
              }}
              className={`w-12 min-h-[44px] rounded-xl flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs transition cursor-pointer ${
                s.id === currentSessionId && currentTab === 1
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
              title={s.title || 'Untitled session'}
              aria-label={s.title || 'Untitled session'}
            >
              <MessageSquare className="w-4 h-4 shrink-0" />
              <span className="text-[9px] leading-tight line-clamp-2 text-center w-full">{s.title || 'Untitled'}</span>
            </button>
          ))}
        </div>
      )}

      {/* 5. Desktop Footer: Local System Status */}
      <div className="p-3 border-t border-white/[0.06] bg-[var(--app-bg,#0A0D11)] text-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                connected
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
                  : 'bg-rose-500'
              }`}
            />
            {!collapsed && (
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-slate-300 truncate">
                  {connected ? t('connected') : t('offline')}
                </p>
                <p className="text-[10px] text-slate-500 truncate font-mono">
                  {settings.modelId.split('/').pop()}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
