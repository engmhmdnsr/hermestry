import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Plus,
  Search,
  Star,
  Edit2,
  GitFork,
  Trash2,
  Download,
  Copy,
  MoreHorizontal,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { GatewayService } from '../../services/gateway';
import { resolveListUiState } from '../../services/pagination';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import { MobileSession } from '../../types/hermes';

const gatewayService = new GatewayService();

interface SessionsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSession: (id: string) => void;
}

export const SessionsDrawer: React.FC<SessionsDrawerProps> = ({
  isOpen,
  onClose,
  onSelectSession,
}) => {
  const {
    sessions,
    currentSessionId,
    connected,
    newSession,
    deleteSession,
    renameSession,
    forkSession,
    refreshNow,
    pinnedIds,
    togglePin,
    t,
  } = useHermes();

  // English fallback for keys constants/languages.ts does not ship yet, so a
  // missing key degrades to English instead of printing the raw key.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<0 | 1 | 2>(0);

  const [renameTarget, setRenameTarget] = useState<MobileSession | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<MobileSession | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [drawerToast, setDrawerToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<'info' | 'success' | 'error'>('info');
  const [renameError, setRenameError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [isSavingRename, setIsSavingRename] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Paginated session list truthfulness (DATA-01/03/04/05). The context owns
  // the first page; pages beyond it accumulate here without clobbering it.
  const [pageMeta, setPageMeta] = useState<{
    live: boolean;
    stale: boolean;
    lastSyncedAt: number | null;
    error?: string;
  }>({ live: true, stale: false, lastSyncedAt: null });
  const [extraSessions, setExtraSessions] = useState<MobileSession[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  // Escape / Android back button / Tab focus trap for the whole drawer. The
  // close handler unwinds the top-most surface first (rename or delete dialog,
  // then the drawer itself) so the back button never skips a dialog.
  const closeTop = useCallback(() => {
    if (renameTarget) {
      setRenameTarget(null);
      setRenameError('');
      return;
    }
    if (deleteTarget) {
      setDeleteTarget(null);
      setDeleteError('');
      return;
    }
    onClose();
  }, [renameTarget, deleteTarget, onClose]);

  const drawerRef = useOverlayBehavior(isOpen, closeTop);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showDrawerToast = (msg: string, kind: 'info' | 'success' | 'error' = 'info') => {
    setDrawerToast(msg);
    setToastKind(kind);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setDrawerToast(null), 2500);
  };

  // First-page sync metadata for the stale/offline banner. Uses the same
  // page the context loads (limit 100, offset 0) so the local cache write
  // inside fetchSessionsPage matches what refreshNow already does.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setMetaLoading(true);
    setPageError(null);
    (async () => {
      try {
        const page = await gatewayService.fetchSessionsPage({ limit: 100, offset: 0 });
        if (cancelled) return;
        setPageMeta({ live: page.live, stale: page.stale, lastSyncedAt: page.lastSyncedAt, error: page.error });
        setHasMore(page.hasMore);
        setNextOffset(page.nextOffset);
      } catch (e) {
        if (cancelled) return;
        setPageError(e instanceof Error ? e.message : tx('couldNotLoadConversations', 'Could not load conversations.'));
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore || nextOffset === null) return;
    setLoadingMore(true);
    setPageError(null);
    try {
      const page = await gatewayService.fetchSessionsPage({ limit: 50, offset: nextOffset });
      setPageMeta({ live: page.live, stale: page.stale, lastSyncedAt: page.lastSyncedAt, error: page.error });
      const knownIds = new Set(sessions.map((s) => s.id));
      setExtraSessions((prev) => {
        const ids = new Set([...knownIds, ...prev.map((s) => s.id)]);
        return [...prev, ...page.items.filter((s) => !ids.has(s.id))];
      });
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
      if (page.error && !page.stale) setPageError(page.error);
    } catch (e) {
      setPageError(e instanceof Error ? e.message : tx('couldNotLoadMore', 'Could not load more conversations.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleRetryList = async () => {
    setPageError(null);
    try {
      await refreshNow();
    } catch {
      // refreshNow signals failure via connected=false; fall through to meta.
    }
    try {
      const page = await gatewayService.fetchSessionsPage({ limit: 100, offset: 0 });
      setPageMeta({ live: page.live, stale: page.stale, lastSyncedAt: page.lastSyncedAt, error: page.error });
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
    } catch (e) {
      setPageError(e instanceof Error ? e.message : tx('couldNotLoadConversations', 'Could not load conversations.'));
    }
  };

  const handleNewSession = async () => {
    try {
      const newId = await newSession();
      onSelectSession(newId);
      onClose();
    } catch {
      showDrawerToast(tx('couldNotCreateSession', 'Could not create session. Gateway unreachable.'), 'error');
    }
  };

  const handleFork = async (id: string) => {
    try {
      await forkSession(id);
    } catch {
      showDrawerToast(tx('forkFailed', 'Fork failed. The conversation was not forked.'), 'error');
    }
  };

  // Context list plus paged-in older sessions, deduped by id.
  const allSessions = useMemo(() => {
    const ids = new Set(sessions.map((s) => s.id));
    return [...sessions, ...extraSessions.filter((s) => !ids.has(s.id))];
  }, [sessions, extraSessions]);

  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const listState = resolveListUiState(
    { live: pageMeta.live, stale: pageMeta.stale, error: pageMeta.error },
    allSessions.length,
    { loading: metaLoading, offline: browserOffline || !connected }
  );
  const syncedLabel = pageMeta.lastSyncedAt
    ? new Date(pageMeta.lastSyncedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  const visibleSessions = useMemo(() => {
    let list = allSessions.filter((s) => {
      const q = query.toLowerCase().trim();
      return (
        !q ||
        (s.title || '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.model || '').toLowerCase().includes(q)
      );
    });

    list = [...list].sort((a, b) => {
      if (sortMode === 1) return a.lastActiveAt - b.lastActiveAt;
      if (sortMode === 2) return b.messageCount - a.messageCount;
      return b.lastActiveAt - a.lastActiveAt;
    });

    return list;
  }, [allSessions, query, sortMode]);

  const pinnedSessions = useMemo(() => {
    return visibleSessions.filter((s) => pinnedIds.includes(s.id));
  }, [visibleSessions, pinnedIds]);

  const otherSessions = useMemo(() => {
    return visibleSessions.filter((s) => !pinnedIds.includes(s.id));
  }, [visibleSessions, pinnedIds]);

  // Prefer gateway history so exports do not silently truncate to whatever
  // happens to be cached locally; fall back to the local cache offline.
  const loadTranscriptMessages = async (sessId: string) => {
    try {
      const server = await gatewayService.sessionMessages(sessId);
      if (server.length > 0) return server;
    } catch {
      // Fall through to the local cache below.
    }
    return gatewayService.loadLocalMessages(sessId);
  };

  const sessionDateStamp = (sess: MobileSession): string => {
    const d = new Date(sess.lastActiveAt);
    return Number.isNaN(d.getTime())
      ? new Date().toISOString().slice(0, 10)
      : d.toISOString().slice(0, 10);
  };

  const sessionFileSlug = (sess: MobileSession): string => {
    const base = (sess.title || 'untitled').replace(/[^a-z0-9_-]/gi, '_');
    return `${base}_${sessionDateStamp(sess)}`;
  };

  const buildTranscriptMarkdown = (
    sess: MobileSession,
    targetMessages: { sender: string; content: string; thinking?: string }[],
  ): string => {
    const dateStamp = sessionDateStamp(sess);
    let md = `# ${sess.title}\nID: ${sess.id}\nModel: ${sess.model}\nDate: ${dateStamp}\n\n---\n\n`;
    for (const msg of targetMessages) {
      md += `### ${msg.sender === 'you' ? 'User' : 'Hermes'}\n\n${msg.content}\n\n`;
      if (msg.thinking) {
        md += `> **Thinking:**\n> ${msg.thinking.replace(/\n/g, '\n> ')}\n\n`;
      }
    }
    return md;
  };

  const shareNative = async (sess: MobileSession, md: string): Promise<boolean> => {
    try {
      const nav = navigator as Navigator & {
        canShare?: (data: { files: File[] }) => boolean;
      };
      if (typeof nav.canShare === 'function') {
        const file = new File([md], `${sessionFileSlug(sess)}.md`, {
          type: 'text/markdown;charset=utf-8',
        });
        if (nav.canShare({ files: [file] }) && typeof navigator.share === 'function') {
          await navigator.share({ files: [file], title: sess.title });
          return true;
        }
      } else if (typeof navigator.share === 'function') {
        await navigator.share({ title: sess.title, text: md });
        return true;
      }
    } catch {
      // User dismissed the sheet or share failed; fall through to download.
    }
    return false;
  };

  const handleExportMarkdown = async (sess: MobileSession) => {
    const targetMessages = await loadTranscriptMessages(sess.id);
    const md = buildTranscriptMarkdown(sess, targetMessages);
    // On mobile WebViews a blob download often goes nowhere, so prefer
    // the native share sheet when it can take the file.
    if (await shareNative(sess, md)) {
      showDrawerToast(tx('transcriptShared', 'Transcript shared.'), 'success');
      return;
    }
    try {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sessionFileSlug(sess)}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showDrawerToast(tx('transcriptExported', 'Transcript exported.'), 'success');
    } catch {
      try {
        await navigator.clipboard.writeText(md);
        showDrawerToast(tx('downloadUnavailableCopied', 'Download unavailable. Transcript copied instead.'), 'info');
      } catch {
        showDrawerToast(tx('exportFailed', 'Export failed: no download, share, or clipboard available.'), 'error');
      }
    }
  };

  const handleCopyTranscript = async (sess: MobileSession) => {
    const targetMessages = await loadTranscriptMessages(sess.id);
    const md = buildTranscriptMarkdown(sess, targetMessages);
    try {
      await navigator.clipboard.writeText(md);
      showDrawerToast(tx('transcriptCopied', 'Transcript copied.'), 'success');
    } catch {
      showDrawerToast(tx('copyFailed', 'Copy failed: clipboard unavailable'), 'error');
    }
  };

  const saveRename = async (target: MobileSession, next: string) => {
    setRenameError('');
    setIsSavingRename(true);
    try {
      await renameSession(target.id, next);
      setRenameTarget(null);
      showDrawerToast(tx('conversationRenamed', 'Conversation renamed.'), 'success');
    } catch {
      setRenameError(tx('renameFailed', 'Rename failed. The conversation was not renamed.'));
    } finally {
      setIsSavingRename(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div ref={drawerRef} className="fixed inset-0 z-50 flex">
      {drawerToast && (
        <div
          role="status"
          aria-live="polite"
          style={{ top: 'calc(4rem + env(safe-area-inset-top, 0px))' }}
          className={`fixed start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] px-4 py-2 rounded-lg text-white text-xs font-semibold shadow-2xl ${toastKind === 'error' ? 'bg-rose-600' : toastKind === 'success' ? 'bg-emerald-600' : 'bg-slate-800 border border-white/[0.1]'}`}
        >
          {drawerToast}
        </div>
      )}
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Container. The panel carries the top safe-area inset itself:
          it is a sibling of the sticky header and would otherwise slide under
          the status bar and notch on Android 15+ (edge-to-edge). */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={tx('conversations', 'Conversations')}
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        className="relative w-full max-w-xs bg-[var(--app-card,#0E1217)] border-e border-white/[0.08] h-full flex flex-col z-10 shadow-2xl animate-in slide-in-from-left rtl:slide-in-from-right duration-200"
      >
        {/* Header: 44px row carrying 36px controls. */}
        <div className="px-3 min-h-[44px] border-b border-white/[0.08] flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold text-white tracking-tight truncate">
              {tx('conversations', 'Conversations')}
            </span>
            <span
              className="text-[11px] text-slate-500 shrink-0"
              aria-label={`${allSessions.length} ${tx('conversations', 'Conversations')}`}
            >
              ({allSessions.length})
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => void handleNewSession()}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-indigo-400 hover:text-white hover:bg-white/[0.06] transition"
              title={tx('newSession', 'New Session')}
              aria-label={tx('newSession', 'New Session')}
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.06] transition"
              title={tx('closeConversations', 'Close conversations')}
              aria-label={tx('closeConversations', 'Close conversations')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="px-3 py-2 border-b border-white/[0.06] space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute start-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tx('searchConversationsPlaceholder', 'Search title, model, or id…')}
              aria-label={tx('searchConversations', 'Search conversations')}
              className="w-full ps-9 pe-9 h-9 rounded-lg bg-[var(--app-card-subtle,#141920)] border border-white/[0.06] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={tx('clearSearch', 'Clear search')}
                className="hm-hit absolute end-0.5 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-white transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {query.trim() && (
            <p className="text-[11px] text-slate-500" role="status">
              {visibleSessions.length} / {allSessions.length} {tx('conversationsMatch', 'conversations match')}
            </p>
          )}

          {/* Segmented sort control: 36px controls, one radius. */}
          <div className="flex items-center gap-1">
            <span className="text-slate-500 text-[11px] uppercase font-medium me-1">
              {tx('sortLabel', 'Sort:')}
            </span>
            {[
              { label: tx('sortNewest', 'Newest'), mode: 0 },
              { label: tx('sortOldest', 'Oldest'), mode: 1 },
              { label: tx('sortMessages', 'Messages'), mode: 2 },
            ].map((s) => (
              <button
                key={s.mode}
                onClick={() => setSortMode(s.mode as any)}
                aria-pressed={sortMode === s.mode}
                className={`px-3 h-9 rounded-lg text-xs transition ${
                  sortMode === s.mode
                    ? 'bg-white/[0.08] text-white font-medium'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Sessions Scroll List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
          {(listState === 'stale' || listState === 'offline') && (
            <div role="status" className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300">
              <p className="font-semibold">{tx('offlineCached', 'Offline, showing cached data')}</p>
              {syncedLabel && (
                <p className="text-amber-300/70 mt-0.5">
                  {tx('lastSynced', 'Last synced')} {syncedLabel}
                </p>
              )}
            </div>
          )}
          {pageError && (
            <div role="alert" className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300 space-y-2">
              <p>{pageError}</p>
              <button
                onClick={() => void handleRetryList()}
                className="h-9 px-3 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-200 font-semibold cursor-pointer"
              >
                {tx('retry', 'Retry')}
              </button>
            </div>
          )}
          {listState === 'loading' ? (
            <div className="py-12 text-center text-xs text-slate-400" role="status" aria-label={tx('loadingConversations', 'Loading conversations…')}>
              <p>{tx('loadingConversations', 'Loading conversations…')}</p>
            </div>
          ) : listState === 'error' ? (
            <div className="py-12 text-center text-xs text-slate-400 space-y-3" role="alert">
              <p>{tx('couldNotLoadConversations', 'Could not load conversations.')}</p>
              {pageMeta.error && <p className="text-[11px] text-slate-500">{pageMeta.error}</p>}
              <button
                onClick={() => void handleRetryList()}
                className="h-9 px-4 rounded-lg bg-indigo-600 text-white text-xs font-medium cursor-pointer"
              >
                {tx('retry', 'Retry')}
              </button>
            </div>
          ) : allSessions.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              <p>{tx('noConversationsYet', 'No conversations yet')}</p>
              <button
                onClick={() => void handleNewSession()}
                className="mt-3 h-9 px-3 rounded-lg bg-indigo-600 text-white text-xs font-medium cursor-pointer"
              >
                {tx('createFirstSession', 'Create First Session')}
              </button>
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              <p>{tx('noConversationsMatch', 'No conversations match your search')}</p>
            </div>
          ) : (
            <>
              {/* Pinned Section */}
              {pinnedSessions.length > 0 && (
                <div className="space-y-1 mb-3">
                  <div className="flex items-center gap-1.5 px-2 text-[11px] text-amber-400 font-medium">
                    <Star className="w-3 h-3 fill-amber-400" />
                    <span aria-label={`${pinnedSessions.length} ${tx('favorites', 'Favorites')}`}>
                      {tx('favorites', 'Favorites')} ({pinnedSessions.length})
                    </span>
                  </div>
                  {pinnedSessions.map((sess) => (
                    <SessionCard
                      key={sess.id}
                      session={sess}
                      isSelected={sess.id === currentSessionId}
                      isPinned={true}
                      onSelect={() => {
                        onSelectSession(sess.id);
                        onClose();
                      }}
                      onTogglePin={() => togglePin(sess.id)}
                      onRename={() => {
                        setRenameTarget(sess);
                        setRenameTitle(sess.title);
                        setRenameError('');
                      }}
                      onFork={() => void handleFork(sess.id)}
                      onDelete={() => { setDeleteError(''); setDeleteTarget(sess); }}
                      onExport={() => void handleExportMarkdown(sess)}
                      onCopy={() => void handleCopyTranscript(sess)}
                      isMenuOpen={openMenuId === sess.id}
                      onToggleMenu={() =>
                        setOpenMenuId((prev) => (prev === sess.id ? null : sess.id))
                      }
                      onCloseMenu={() => setOpenMenuId(null)}
                    />
                  ))}
                </div>
              )}

              {/* Regular Sessions */}
              <div className="space-y-1">
                {otherSessions.map((sess) => (
                  <SessionCard
                    key={sess.id}
                    session={sess}
                    isSelected={sess.id === currentSessionId}
                    isPinned={false}
                    onSelect={() => {
                      onSelectSession(sess.id);
                      onClose();
                    }}
                    onTogglePin={() => togglePin(sess.id)}
                    onRename={() => {
                      setRenameTarget(sess);
                      setRenameTitle(sess.title);
                      setRenameError('');
                    }}
                    onFork={() => void handleFork(sess.id)}
                    onDelete={() => { setDeleteError(''); setDeleteTarget(sess); }}
                    onExport={() => void handleExportMarkdown(sess)}
                    onCopy={() => void handleCopyTranscript(sess)}
                    isMenuOpen={openMenuId === sess.id}
                    onToggleMenu={() =>
                      setOpenMenuId((prev) => (prev === sess.id ? null : sess.id))
                    }
                    onCloseMenu={() => setOpenMenuId(null)}
                  />
                ))}
              </div>
              {hasMore && nextOffset !== null && (
                <button
                  onClick={() => void handleLoadMore()}
                  disabled={loadingMore}
                  className="w-full mt-2 h-9 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.07] disabled:opacity-50 text-xs font-medium text-slate-300 border border-white/[0.07] transition cursor-pointer"
                >
                  {loadingMore ? tx('loadingMore', 'Loading…') : tx('loadMoreConversations', 'Load more conversations')}
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Rename Dialog */}
      {renameTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={tx('renameConversation', 'Rename conversation')}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRenameTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-white">
              {tx('renameConversationTitle', 'Rename Conversation')}
            </h3>
            <input
              type="text"
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameTitle.trim() && !isSavingRename && renameTarget) {
                  e.preventDefault();
                  void saveRename(renameTarget, renameTitle.trim());
                }
              }}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              aria-label={tx('conversationTitle', 'Conversation title')}
              className="w-full px-3.5 h-9 rounded-lg bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
            />
            {renameError && (
              <p className="text-xs text-rose-400" role="alert">{renameError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  setRenameTarget(null);
                  setRenameError('');
                }}
                className="h-9 px-4 rounded-lg text-xs font-medium text-slate-400 hover:text-white"
              >
                {t('cancel') || tx('cancel', 'Cancel')}
              </button>
              <button
                onClick={() => {
                  if (!renameTitle.trim() || !renameTarget) return;
                  void saveRename(renameTarget, renameTitle.trim());
                }}
                disabled={isSavingRename}
                className="h-9 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold"
              >
                {isSavingRename ? tx('saving', 'Saving…') : t('save') || tx('save', 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Dialog */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={tx('deleteConversation', 'Delete conversation')}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-white">
              {tx('deleteConversationTitle', 'Delete Conversation?')}
            </h3>
            <p className="text-xs text-slate-400">
              {tx('deleteConversationLead', 'Are you sure you want to delete')} "{deleteTarget.title}"?
            </p>
            {deleteError && (
              <p className="text-xs text-rose-400" role="alert">{deleteError}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteError('');
                }}
                className="h-9 px-4 rounded-lg text-xs font-medium text-slate-400 hover:text-white"
              >
                {t('cancel') || tx('cancel', 'Cancel')}
              </button>
              <button
                onClick={async () => {
                  if (!deleteTarget) return;
                  setDeleteError('');
                  setIsDeleting(true);
                  try {
                    await deleteSession(deleteTarget.id);
                    setDeleteTarget(null);
                  } catch {
                    setDeleteError(tx('deleteFailed', 'Delete failed. The conversation was not deleted.'));
                  } finally {
                    setIsDeleting(false);
                  }
                }}
                disabled={isDeleting}
                className="h-9 px-4 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold"
              >
                {isDeleting ? tx('deleting', 'Deleting…') : t('delete') || tx('delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface SessionCardProps {
  session: MobileSession;
  isSelected: boolean;
  isPinned: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onFork: () => void;
  onDelete: () => void;
  onExport: () => void;
  onCopy: () => void;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
}

const SessionCard: React.FC<SessionCardProps> = ({
  session,
  isSelected,
  isPinned,
  onSelect,
  onTogglePin,
  onRename,
  onFork,
  onDelete,
  onExport,
  onCopy,
  isMenuOpen,
  onToggleMenu,
  onCloseMenu,
}) => {
  const { t } = useHermes();
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
  const title = session.title || tx('untitledSession', 'Untitled Session');
  const menuItems: {
    label: string;
    icon: React.ReactNode;
    danger?: boolean;
    run: () => void;
  }[] = [
    { label: tx('export', 'Export'), icon: <Download className="w-3.5 h-3.5" />, run: onExport },
    { label: tx('copyTranscript', 'Copy transcript'), icon: <Copy className="w-3.5 h-3.5" />, run: onCopy },
    { label: tx('rename', 'Rename'), icon: <Edit2 className="w-3.5 h-3.5" />, run: onRename },
    { label: t('fork') || tx('fork', 'Fork'), icon: <GitFork className="w-3.5 h-3.5" />, run: onFork },
    { label: t('delete') || tx('delete', 'Delete'), icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, run: onDelete },
  ];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-current={isSelected ? 'true' : undefined}
      aria-label={`${title}${isSelected ? `, ${tx('currentConversation', 'current conversation')}` : ''}`}
      className={`group relative min-h-[44px] p-2.5 rounded-lg border transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        isSelected
          ? 'bg-indigo-600/10 border-indigo-500/40 text-white'
          : 'bg-[var(--app-card-subtle,#141920)]/60 hover:bg-[var(--app-card-subtle,#141920)] border-white/[0.05] hover:border-white/[0.1]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-xs font-medium text-slate-200 line-clamp-1 flex-1 leading-snug">
          {title}
        </h4>
        <div className="flex items-center gap-0.5 -me-0.5 -mt-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition ${
              isPinned ? 'text-amber-400' : 'text-slate-500 hover:text-slate-300'
            }`}
            title={isPinned ? tx('unpin', 'Unpin') : tx('pinToFavorites', 'Pin to favorites')}
            aria-label={`${isPinned ? tx('unpin', 'Unpin') : tx('pin', 'Pin')} ${title}`}
            aria-pressed={isPinned}
          >
            <Star className={`w-3.5 h-3.5 ${isPinned ? 'fill-amber-400' : ''}`} />
          </button>
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleMenu();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onCloseMenu();
              }}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              aria-label={`${tx('moreActions', 'More actions')}: ${title}`}
              className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-500 hover:text-white transition"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {isMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseMenu();
                  }}
                  aria-hidden="true"
                />
                <div
                  role="menu"
                  aria-label={`${tx('moreActions', 'More actions')}: ${title}`}
                  className="absolute end-0 top-full z-50 w-44 rounded-lg bg-[var(--app-card,#0E1217)] border border-white/[0.1] shadow-2xl p-1"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') onCloseMenu();
                  }}
                >
                  {menuItems.map((item) => (
                    <button
                      key={item.label}
                      role="menuitem"
                      onClick={() => {
                        onCloseMenu();
                        item.run();
                      }}
                      className={`w-full h-9 px-2.5 flex items-center gap-2.5 rounded-lg text-xs transition cursor-pointer ${
                        item.danger
                          ? 'text-rose-400 hover:bg-rose-500/10'
                          : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
                      }`}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-0.5 text-[11px] text-slate-400">
        <span aria-label={`${session.messageCount} ${tx('messages', 'messages')}`}>
          {session.messageCount} {tx('msgs', 'msgs')}
        </span>
        <span>{new Date(session.lastActiveAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </div>
    </div>
  );
};
