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
// Same tab vocabulary as the bottom nav, so a tab never reads as two names.
import { TAB_LABEL_KEYS, TAB_LABEL_FALLBACKS } from './BottomNav';

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

  // English fallback for keys constants/languages.ts does not ship yet, so a
  // missing key degrades to English instead of printing the raw key.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

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
      error: !connected && sessions.length === 0 ? tx('serverUnreachable', 'Hermes server unreachable') : undefined,
    },
    sessions.length,
    { offline: browserOffline || !connected }
  );

  const handleRetrySessions = async () => {
    setListError(null);
    try {
      await refreshNow();
    } catch {
      setListError(tx('listRetryFailed', 'Could not reach the Hermes server again. Check that it is running, then retry.'));
    }
  };

  const navItems = [
    { id: 0, label: tx(TAB_LABEL_KEYS[0], TAB_LABEL_FALLBACKS[0]), icon: LayoutGrid },
    // Approvals are actioned in Chat (ApprovalCard queue), so the pending
    // count lives here, not on Settings.
    { id: 1, label: tx(TAB_LABEL_KEYS[1], TAB_LABEL_FALLBACKS[1]), icon: MessageSquare, badge: approvals.length },
    { id: 2, label: tx(TAB_LABEL_KEYS[2], TAB_LABEL_FALLBACKS[2]), icon: CalendarClock, badge: jobs.filter(j => j.enabled).length },
    { id: 3, label: tx(TAB_LABEL_KEYS[3], TAB_LABEL_FALLBACKS[3]), icon: SlidersHorizontal },
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
        backgroundColor: 'var(--app-sidebar)',
        borderColor: 'var(--app-border)',
      }}
    >
      {/* 1. App Brand Bar */}
      <div className="h-14 hairline border-b flex items-center justify-between px-4">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-8 h-8 r-xs edge p-1 flex items-center justify-center shrink-0"
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
          {!collapsed && (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="t-heading font-semibold tracking-tight text-[var(--app-text)]">
                  Hermes
                </span>
                <span className="pill-accent t-micro font-mono">
                  {tx('deskTag', 'DESK')}
                </span>
              </div>
              <p className="t-micro text-[var(--app-text-dim)] truncate leading-none mt-1">
                {settings.baseUrl || '127.0.0.1:8080'}
              </p>
            </div>
          )}
        </div>

        <button
          onClick={onToggleCollapse}
          className="min-w-[44px] min-h-[44px] r-xs flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition"
          title={collapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
          aria-label={collapsed ? tx('expandSidebar', 'Expand sidebar') : tx('collapseSidebar', 'Collapse sidebar')}
        >
          {collapsed ? <SidebarOpen className="w-4 h-4 rtl-flip" /> : <SidebarClose className="w-4 h-4 rtl-flip" />}
        </button>
      </div>

      {/* 2. Primary Navigation. Same active vocabulary as BottomNav: an accent
          surface tint plus an accent icon and label, one label size. */}
      <div className={`p-2 space-y-1 ${collapsed ? '[&>button]:flex-col [&>button]:gap-1 [&>button]:px-1 [&>button]:py-2' : ''}`}>
        {navItems.map((item) => {
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2 r-sm t-micro font-medium transition cursor-pointer relative group ${
                isActive
                  ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] font-semibold border border-[var(--app-accent)]'
                  : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] border border-transparent'
              }`}
              title={item.label}
              aria-label={item.label}
            >
              <item.icon
                className={`w-4 h-4 shrink-0 transition-colors ${
                  isActive ? 'text-[var(--app-accent-text)]' : 'text-[var(--app-text-muted)] group-hover:text-[var(--app-text)]'
                }`}
              />
              {!collapsed ? (
                <span className="truncate flex-1 text-start">{item.label}</span>
              ) : (
                <span className="t-micro leading-tight line-clamp-2 text-center w-full">{item.label}</span>
              )}

              {/* Badges: the same real badge as BottomNav. */}
              {item.badge !== undefined && item.badge > 0 && (
                <span className="pill-danger font-mono font-semibold">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 3. New Chat Button */}
      <div className="p-2">
        <button
          onClick={onOpenNewChat}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] active:scale-[0.99] text-[var(--app-on-accent)] t-caption font-semibold shadow-xs transition cursor-pointer"
          title={tx('newChat', 'New chat')}
          aria-label={tx('newChat', 'New chat')}
        >
          <Plus className="w-4 h-4" />
          {!collapsed && <span>{tx('newChat', 'New chat')}</span>}
        </button>
      </div>

      {/* 4. Desktop Sessions Panel */}
      {!collapsed ? (
        <div className="flex-1 overflow-y-auto px-2 space-y-3 pb-3">
          {(sidebarListState === 'stale' || sidebarListState === 'offline') && (
            <div role="status" className="mx-1 px-3 py-2 r-sm t-caption border border-[var(--app-warning-border)] bg-[var(--app-warning-subtle)] text-[var(--app-warning)]">
              <p className="font-semibold">{tx('offlineCachedSessions', 'Not connected. Showing chats saved on this phone.')}</p>
            </div>
          )}
          {sidebarListState === 'error' && (
            <div role="alert" className="mx-1 px-3 py-2 r-sm t-caption border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)] text-[var(--app-danger)] space-y-2">
              <p>{tx('couldNotLoadChats', 'Could not load chats. The Hermes server did not answer.')}</p>
              <button
                onClick={() => void handleRetrySessions()}
                className="px-3 min-h-[44px] r-sm bg-[var(--app-danger-subtle)] hover:bg-[var(--app-card-hover)] edge text-[var(--app-danger)] font-semibold cursor-pointer"
              >
                {tx('retry', 'Retry')}
              </button>
            </div>
          )}
          {listError && (
            <div role="alert" className="mx-1 px-3 py-2 r-sm t-caption border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)] text-[var(--app-danger)]">
              <p>{listError}</p>
            </div>
          )}
          {/* Quick Search */}
          <div className="relative px-1 pt-1">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-[var(--app-text-dim)] pointer-events-none" />
            <input
              type="text"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              placeholder={tx('filterChats', 'Find a chat…')}
              aria-label={tx('filterChats', 'Find a chat…')}
              className="w-full ps-9 pe-3 py-2 r-sm edge bg-[var(--app-input-bg)] t-caption text-[var(--app-text)] placeholder:text-[var(--app-text-dim)] focus:outline-none focus:border-[var(--app-accent)]"
            />
          </div>

          {/* Pinned / Starred */}
          {pinnedList.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 px-2 t-micro font-semibold text-[var(--app-warning)] uppercase tracking-wider">
                <Star className="w-3 h-3 text-[var(--app-warning)]" />
                <span>{tx('favorites', 'Favorites')}</span>
              </div>
              {pinnedList.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-label={tx('openChatNamed', 'Open chat: {name}').replace('{name}', String(s.title || tx('untitledChat', 'Untitled chat')))}
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
                  className={`group flex items-center justify-between gap-2 px-2 py-2 min-h-[44px] r-sm t-caption cursor-pointer transition border ${
                    s.id === currentSessionId && currentTab === 1
                      ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] font-medium border-[var(--app-accent)]'
                      : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] border-transparent'
                  }`}
                >
                  <span className="truncate flex-1">{s.title || tx('untitledChat', 'Untitled chat')}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus:opacity-100 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-warning)] transition"
                    title={pinnedIds.includes(s.id) ? tx('unpinFromFavorites', 'Remove from favorites') : tx('pinToFavorites', 'Add to favorites')}
                    aria-label={`${pinnedIds.includes(s.id) ? tx('unpinFromFavorites', 'Remove from favorites') : tx('pinToFavorites', 'Add to favorites')}: ${s.title || tx('untitledChat', 'Untitled chat')}`}
                  >
                    <Star className="w-3 h-3 text-[var(--app-warning)]" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Recent Sessions */}
          <div className="space-y-1">
            <div className="px-2 flex items-center justify-between">
              <span className="t-micro font-semibold text-[var(--app-text-dim)] uppercase tracking-wider">
                {tx('recentChats', 'Recent chats')}
              </span>
              {unpinnedSessions.length > 10 && (
                <button
                  onClick={() => setShowAllRecent((v) => !v)}
                  className="t-micro text-[var(--app-accent-text)] hover:brightness-110 font-medium cursor-pointer"
                >
                  {showAllRecent
                    ? tx('showLess', 'Show less')
                    : tx('showAllChats', 'Show all {count}').replace('{count}', String(unpinnedSessions.length))}
                </button>
              )}
            </div>
            {recentList.length === 0 ? (
              sidebarListState === 'error' ? null : (
                <p className="px-2 t-caption text-[var(--app-text-dim)]">{tx('noChatsYet', 'No chats yet')}</p>
              )
            ) : (
              recentList.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-label={tx('openChatNamed', 'Open chat: {name}').replace('{name}', String(s.title || tx('untitledChat', 'Untitled chat')))}
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
                  className={`group flex items-center justify-between gap-2 px-2 py-2 min-h-[44px] r-sm t-caption cursor-pointer transition border ${
                    s.id === currentSessionId && currentTab === 1
                      ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] font-medium border-[var(--app-accent)]'
                      : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] border-transparent'
                  }`}
                >
                  <span className="truncate flex-1">{s.title || tx('untitledChat', 'Untitled chat')}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus:opacity-100 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-dim)] hover:text-[var(--app-warning)] transition"
                    title={pinnedIds.includes(s.id) ? tx('unpinFromFavorites', 'Remove from favorites') : tx('pinToFavorites', 'Add to favorites')}
                    aria-label={`${pinnedIds.includes(s.id) ? tx('unpinFromFavorites', 'Remove from favorites') : tx('pinToFavorites', 'Add to favorites')}: ${s.title || tx('untitledChat', 'Untitled chat')}`}
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
              className={`w-12 min-h-[44px] r-sm flex flex-col items-center justify-center gap-1 px-1 py-2 t-micro transition cursor-pointer border ${
                s.id === currentSessionId && currentTab === 1
                  ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] border-[var(--app-accent)]'
                  : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] border-transparent'
              }`}
              title={s.title || tx('untitledChat', 'Untitled chat')}
              aria-label={s.title || tx('untitledChat', 'Untitled chat')}
            >
              <MessageSquare className="w-4 h-4 shrink-0" />
              <span className="t-caption text-[var(--app-text-dim)] leading-tight line-clamp-2 text-center w-full">{s.title || tx('untitledChat', 'Untitled chat')}</span>
            </button>
          ))}
        </div>
      )}

      {/* 5. Desktop Footer: Local System Status */}
      <div className="p-3 hairline border-t bg-[var(--app-bg)] t-caption">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{
                backgroundColor: connected ? 'var(--app-success)' : 'var(--app-danger)',
                boxShadow: connected ? '0 0 8px var(--app-success)' : undefined,
              }}
            />
            {!collapsed && (
              <div className="min-w-0">
                <p className="t-caption font-medium text-[var(--app-text)] truncate">
                  {connected ? tx('connected', 'Connected') : tx('notConnected', 'Not connected')}
                </p>
                <p className="t-micro text-[var(--app-text-dim)] truncate font-mono">
                  {tx('activeModel', 'Active model')}: {settings.modelId.split('/').pop()}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
