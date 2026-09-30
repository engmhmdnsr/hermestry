import React, { useState, useMemo, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
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
  CalendarClock,
  ChevronDown,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { GatewayService } from '../../services/gateway';
import { resolveListUiState } from '../../services/pagination';
import { plainListStale, plainServiceFailure } from '../../services/plainFailure';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import { MobileSession } from '../../types/hermes';

// Jobs live at the end of this drawer now (the bottom tab is Terminal).
// Lazy so the 70KB schedules UI only loads when the section opens.
const JobsTab = lazy(() =>
  import('../tabs/JobsTab').then((m) => ({ default: m.JobsTab }))
);

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
    deletedSessionIds,
    jobs,
    t,
  } = useHermes();

  // English fallback for keys constants/languages.ts does not ship yet, so a
  // missing key degrades to English instead of printing the raw key.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Jobs section at the end of the drawer. Collapsed by default; Home's
  // Activity card opens the drawer with it expanded through hm:drawerJobs.
  const [jobsOpen, setJobsOpen] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    try {
      if (sessionStorage.getItem('hm:drawerJobs') === '1') {
        sessionStorage.removeItem('hm:drawerJobs');
        setJobsOpen(true);
      }
    } catch {}
  }, [isOpen]);
  const enabledJobs = jobs.filter((j) => j.enabled).length;

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
  // newSession() awaits a bridge lookup plus two gateway round trips before it
  // returns, so a second tap inside that window would mint a second chat.
  const [isCreatingSession, setIsCreatingSession] = useState(false);
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

  // Escape and the Android back button route per layer, not per drawer: the
  // card menu, the rename dialog and the delete dialog each own their own
  // overlay stack entry with their own close handler. Before this, back popped
  // the drawer's single entry while closeTop only closed an inner card, so the
  // next back jumped to Home with the drawer still open and a third back
  // exited over it. Focus trapping stays with the drawer (these layers live
  // inside it); what each layer owns is stack membership and top-only Escape.
  //
  // Declared before the drawer hook on purpose: the layers only ever open
  // while the drawer is already open (so the drawer always registers first),
  // and on cleanup their focus restore then runs ahead of the drawer's, leaving
  // focus on the drawer trigger instead of on a card that is about to unmount.
  const closeMenuLayer = useCallback(() => setOpenMenuId(null), []);
  const closeRenameLayer = useCallback(() => {
    setRenameTarget(null);
    setRenameError('');
  }, []);
  const closeDeleteLayer = useCallback(() => {
    setDeleteTarget(null);
    setDeleteError('');
  }, []);
  // Gated on isOpen as well: closing the drawer must drop its inner entries in
  // the same commit, because the dialogs are not rendered while it is closed.
  const menuLayerRef = useOverlayBehavior(isOpen && !!openMenuId, closeMenuLayer, undefined, {
    trapFocus: false,
  });
  const renameLayerRef = useOverlayBehavior(isOpen && !!renameTarget, closeRenameLayer, undefined, {
    trapFocus: false,
  });
  const deleteLayerRef = useOverlayBehavior(isOpen && !!deleteTarget, closeDeleteLayer, undefined, {
    trapFocus: false,
  });

  // Tap outside the panel: the scrim unwinds the top-most surface first (open
  // card menu, then rename or delete dialog, then the drawer itself) so a tap
  // can never skip a layer.
  const closeTop = useCallback(() => {
    if (openMenuId) {
      setOpenMenuId(null);
      return;
    }
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
  }, [openMenuId, renameTarget, deleteTarget, onClose]);

  const drawerRef = useOverlayBehavior(isOpen, closeTop);

  // Reopening the drawer must never resurrect a dialog the previous visit
  // left open, so the inner layers are cleared when it closes.
  useEffect(() => {
    if (isOpen) return;
    setOpenMenuId(null);
    setRenameTarget(null);
    setDeleteTarget(null);
  }, [isOpen]);

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
        setPageError(plainServiceFailure(e, tx));
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
      if (page.error && !page.stale)
        setPageError(plainListStale(tx('couldNotLoadMoreChats', 'Could not load more chats.'), page.error, tx));
    } catch (e) {
      setPageError(plainServiceFailure(e, tx));
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
      setPageError(plainServiceFailure(e, tx));
    }
  };

  const handleNewSession = async () => {
    if (isCreatingSession) return;
    setIsCreatingSession(true);
    try {
      const newId = await newSession();
      onSelectSession(newId);
      onClose();
    } catch {
      showDrawerToast(tx('couldNotCreateSession', 'Could not start a chat. The Hermes server did not answer.'), 'error');
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleFork = async (id: string) => {
    try {
      await forkSession(id);
    } catch {
      showDrawerToast(tx('branchFailed', 'Could not start a copy of this chat. The original chat is unchanged.'), 'error');
    }
  };

  // Context list plus paged-in older sessions, deduped by id and minus
  // ids deleted after the page was loaded (context refresh never reprunes
  // these stale pages).
  const allSessions = useMemo(() => {
    const gone = new Set(deletedSessionIds);
    const ids = new Set(sessions.map((s) => s.id));
    return [...sessions, ...extraSessions.filter((s) => !ids.has(s.id) && !gone.has(s.id))];
  }, [sessions, extraSessions, deletedSessionIds]);

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

  // A blob anchor click has no success callback: the browser either throws
  // (a detached document, a blocked URL API, a refused node insert) or it
  // silently takes over, and this WebView exposes no download event to script.
  // So the only honest verdicts are "the click failed" and "dispatched but
  // unconfirmed". Revoking immediately can also abort a transfer that is still
  // starting, so the URL lives long enough for the download manager to read it.
  const dispatchDownload = (sess: MobileSession, md: string): boolean => {
    try {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sessionFileSlug(sess)}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      return true;
    } catch {
      return false;
    }
  };

  const handleExportMarkdown = async (sess: MobileSession) => {
    const targetMessages = await loadTranscriptMessages(sess.id);
    const md = buildTranscriptMarkdown(sess, targetMessages);
    // On mobile WebViews a blob download often goes nowhere, so prefer
    // the native share sheet when it can take the file. That path reports a
    // real result, so it is the only one allowed to claim success.
    if (await shareNative(sess, md)) {
      showDrawerToast(tx('transcriptShared', 'Transcript shared.'), 'success');
      return;
    }
    if (!dispatchDownload(sess, md)) {
      // The download path itself refused: copy instead, which is verifiable.
      try {
        await navigator.clipboard.writeText(md);
        showDrawerToast(tx('downloadUnavailableCopied', 'Download unavailable. Transcript copied instead.'), 'info');
      } catch {
        showDrawerToast(tx('exportFailed', 'Export failed: no download, share, or clipboard available.'), 'error');
      }
      return;
    }
    // Dispatched, not confirmed: say so without claiming the file landed.
    showDrawerToast(tx('exporting', 'Exporting…'), 'info');
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
      showDrawerToast(tx('chatRenamed', 'Chat renamed.'), 'success');
    } catch {
      setRenameError(tx('renameFailed', 'Could not rename this chat. The name is unchanged.'));
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
          className={`fixed start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] px-4 py-2 r-sm elev-3 t-caption font-semibold max-w-[min(20rem,calc(100vw-2rem))] text-center ${
            toastKind === 'error'
              ? 'bg-[var(--app-danger-solid)] text-[var(--app-on-danger)]'
              : toastKind === 'success'
                ? 'bg-[var(--app-success-solid)] text-[var(--app-on-success)]'
                : 'edge text-[var(--app-text)]'
          }`}
        >
          {drawerToast}
        </div>
      )}
      {/* Backdrop. It unwinds the top-most surface like Escape and Android
          back do, so a tap-outside can never skip an open menu or dialog. */}
      <div
        className="fixed inset-0 bg-[var(--app-scrim)] backdrop-blur-xs transition-opacity duration-200"
        onClick={closeTop}
        aria-hidden="true"
      />

      {/* Drawer Container. The panel carries the top safe-area inset itself:
          it is a sibling of the sticky header and would otherwise slide under
          the status bar and notch on Android 15+ (edge-to-edge). */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={tx('chats', 'Chats')}
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          backgroundColor: 'var(--app-card)',
        }}
        className="relative w-full max-w-[min(20rem,85vw)] border-e edge h-full flex flex-col z-10 elev-3 animate-in slide-in-from-left rtl:slide-in-from-right duration-200"
      >
        {/* Header: 44px row carrying 36px controls. */}
        <div className="px-3 min-h-[44px] hairline border-b flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="t-body font-semibold text-[var(--app-text)] tracking-tight truncate">
              {tx('chats', 'Chats')}
            </span>
            <span
              className="t-caption text-[var(--app-text-dim)] shrink-0"
              aria-label={`${allSessions.length} ${tx('chats', 'Chats')}`}
            >
              ({allSessions.length})
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => void handleNewSession()}
              disabled={isCreatingSession}
              className="w-9 h-9 r-sm flex items-center justify-center text-[var(--app-accent-text)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
              title={tx('newChat', 'New chat')}
              aria-label={tx('newChat', 'New chat')}
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="w-9 h-9 r-sm flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition"
              title={tx('closeChats', 'Close chats')}
              aria-label={tx('closeChats', 'Close chats')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="px-3 py-2 hairline border-b space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-[var(--app-text-dim)] pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tx('searchChatsPlaceholder', 'Search chats by title, model, or id…')}
              aria-label={tx('searchChats', 'Search chats')}
              className="w-full ps-9 pe-9 h-9 r-sm edge bg-[var(--app-input-bg)] t-caption text-[var(--app-text)] placeholder:text-[var(--app-text-dim)] focus:outline-none focus:border-[var(--app-accent)]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={tx('clearSearch', 'Clear the search')}
                className="hm-hit absolute end-0 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center r-sm text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          {query.trim() && (
            <p className="t-caption text-[var(--app-text-dim)]" role="status">
              {visibleSessions.length} / {allSessions.length} {tx('chatsMatch', 'chats match')}
            </p>
          )}

          {/* Segmented sort control: 36px controls, one radius. */}
          <div className="flex items-center gap-1">
            <span className="t-caption text-[var(--app-text-dim)] uppercase font-medium me-1">
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
                className={`px-3 h-9 r-sm t-caption transition ${
                  sortMode === s.mode
                    ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] font-medium'
                    : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Sessions Scroll List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {(listState === 'stale' || listState === 'offline') && (
            <div role="status" className="px-3 py-2 r-sm t-caption border border-[var(--app-warning-border)] bg-[var(--app-warning-subtle)] text-[var(--app-warning)]">
              <p className="font-semibold">{tx('offlineCached', 'Not connected. Showing chats saved on this phone.')}</p>
              {syncedLabel && (
                <p className="mt-1 opacity-80">
                  {tx('lastSynced', 'Last synced')} {syncedLabel}
                </p>
              )}
            </div>
          )}
          {pageError && (
            <div role="alert" className="px-3 py-2 r-sm t-caption border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)] text-[var(--app-danger)] space-y-2">
              <p>{pageError}</p>
              <button
                onClick={() => void handleRetryList()}
                className="h-9 px-3 r-sm bg-[var(--app-card-hover)] text-[var(--app-danger)] font-semibold cursor-pointer"
              >
                {tx('retry', 'Retry')}
              </button>
            </div>
          )}
          {listState === 'loading' ? (
            <div className="py-12 text-center t-caption text-[var(--app-text-muted)]" role="status" aria-label={tx('loadingChats', 'Loading chats…')}>
              <p>{tx('loadingChats', 'Loading chats…')}</p>
            </div>
          ) : listState === 'error' ? (
            <div className="py-12 text-center t-caption text-[var(--app-text-muted)] space-y-3" role="alert">
              <p>
                {plainListStale(
                  tx('couldNotLoadChats', 'Could not load chats. The Hermes server did not answer.'),
                  pageMeta.error,
                  tx
                )}
              </p>
              <button
                onClick={() => void handleRetryList()}
                className="h-9 px-4 r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] t-caption font-medium cursor-pointer"
              >
                {tx('retry', 'Retry')}
              </button>
            </div>
          ) : allSessions.length === 0 ? (
            <div className="py-12 text-center t-caption text-[var(--app-text-muted)]">
              <p>{tx('noChatsYet', 'No chats yet')}</p>
              <button
                onClick={() => void handleNewSession()}
                disabled={isCreatingSession}
                className="mt-3 h-9 px-3 r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] disabled:opacity-50 text-[var(--app-on-accent)] t-caption font-medium cursor-pointer"
              >
                {tx('startFirstChat', 'Start your first chat')}
              </button>
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="py-12 text-center t-caption text-[var(--app-text-muted)]">
              <p>{tx('noChatsMatch', 'No chats match your search')}</p>
            </div>
          ) : (
            <>
              {/* Pinned Section */}
              {pinnedSessions.length > 0 && (
                <div className="space-y-1 mb-3">
                  <div className="flex items-center gap-2 px-2 t-micro text-[var(--app-warning)] font-medium">
                    <Star className="w-3 h-3 text-[var(--app-warning)]" />
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
                      menuRef={menuLayerRef}
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
                  className="w-full mt-2 h-9 px-3 r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] disabled:opacity-50 t-caption font-medium text-[var(--app-text-muted)] transition cursor-pointer"
                >
                  {loadingMore ? tx('loadingMore', 'Loading…') : tx('loadMoreChats', 'Load more chats')}
                </button>
              )}
            </>
          )}
        </div>

        {/* Scheduled Jobs at the end of the drawer: the full schedules UI
            (create, pause, resume, run, delete) embedded in a collapsible
            section, so nothing from the old Jobs tab is lost. */}
        <div className="shrink-0 hairline border-t">
          <button
            type="button"
            onClick={() => setJobsOpen((v) => !v)}
            aria-expanded={jobsOpen}
            className="w-full min-h-[44px] px-3 flex items-center gap-2 text-start cursor-pointer"
          >
            <CalendarClock className="w-4 h-4 shrink-0 text-[var(--app-tab-jobs)]" aria-hidden="true" />
            <span className="t-body font-semibold text-[var(--app-text)] flex-1 truncate">
              {tx('scheduledJobsTitle', 'Scheduled tasks')}
            </span>
            {enabledJobs > 0 && (
              <span
                className="t-micro font-mono text-[var(--app-tab-jobs)] shrink-0"
                aria-label={tx('jobsTurnedOnCount', '{count} jobs turned on').replace(
                  '{count}',
                  String(enabledJobs)
                )}
              >
                {enabledJobs}
              </span>
            )}
            <ChevronDown
              className={`w-4 h-4 shrink-0 text-[var(--app-text-muted)] transition-transform ${jobsOpen ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
          {jobsOpen && (
            <div className="max-h-[60vh] overflow-y-auto border-t hairline">
              <Suspense
                fallback={
                  <div className="p-4 text-center t-caption text-[var(--app-text-muted)]" role="status">
                    {tx('loadingJobs', 'Loading jobs')}
                  </div>
                }
              >
                <JobsTab />
              </Suspense>
            </div>
          )}
        </div>
      </aside>

      {/* Rename Dialog */}
      {renameTarget && (
        <div
          ref={renameLayerRef}
          role="dialog"
          aria-modal="true"
          aria-label={tx('renameChat', 'Rename chat')}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-[var(--app-scrim)] backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRenameTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm r-md elev-3 edge bg-[var(--app-card)] p-4 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="t-heading font-semibold text-[var(--app-text)]">
              {tx('renameChatTitle', 'Rename chat')}
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
              aria-label={tx('chatTitle', 'Chat title')}
              className="w-full px-3 h-9 r-sm edge bg-[var(--app-input-bg)] t-caption text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)]"
            />
            {renameError && (
              <p className="t-caption text-[var(--app-danger)]" role="alert">{renameError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  setRenameTarget(null);
                  setRenameError('');
                }}
                className="h-9 px-4 r-sm t-caption font-medium text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
              >
                {t('cancel') || tx('cancel', 'Cancel')}
              </button>
              <button
                onClick={() => {
                  if (!renameTitle.trim() || !renameTarget) return;
                  void saveRename(renameTarget, renameTitle.trim());
                }}
                disabled={isSavingRename}
                className="h-9 px-4 r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] disabled:opacity-50 text-[var(--app-on-accent)] t-caption font-semibold"
              >
                {isSavingRename ? tx('saving', 'Saving…') : tx('saveShort', 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Dialog */}
      {deleteTarget && (
        <div
          ref={deleteLayerRef}
          role="dialog"
          aria-modal="true"
          aria-label={tx('deleteChat', 'Delete chat')}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-[var(--app-scrim)] backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm r-md elev-3 edge bg-[var(--app-card)] p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="t-heading font-semibold text-[var(--app-text)]">
              {tx('deleteChatTitle', 'Delete this chat')}
            </h3>
            <p className="t-caption text-[var(--app-text-muted)]">
              {tx('deleteChatLead', 'Are you sure you want to delete')} "{deleteTarget.title}"?
            </p>
            {deleteError && (
              <p className="t-caption text-[var(--app-danger)]" role="alert">{deleteError}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteError('');
                }}
                className="h-9 px-4 r-sm t-caption font-medium text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
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
                    setDeleteError(tx('deleteFailed', 'Could not delete this chat. It is still here.'));
                  } finally {
                    setIsDeleting(false);
                  }
                }}
                disabled={isDeleting}
                className="h-9 px-4 r-sm bg-[var(--app-danger-solid)] hover:brightness-110 disabled:opacity-50 text-[var(--app-on-danger)] t-caption font-semibold"
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
  // The open menu registers its own overlay stack entry (Android back and
  // Escape close the menu first, then the drawer), so the drawer hands the
  // hook ref down to the popup it does not render itself.
  menuRef?: React.RefObject<HTMLDivElement | null>;
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
  menuRef,
}) => {
  const { t } = useHermes();
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
  const title = session.title || tx('untitledChat', 'Untitled chat');
  const menuItems: {
    label: string;
    icon: React.ReactNode;
    danger?: boolean;
    run: () => void;
  }[] = [
    { label: tx('export', 'Export'), icon: <Download className="w-4 h-4" />, run: onExport },
    { label: tx('copyTranscript', 'Copy transcript'), icon: <Copy className="w-4 h-4" />, run: onCopy },
    { label: tx('rename', 'Rename'), icon: <Edit2 className="w-4 h-4" />, run: onRename },
    { label: tx('duplicateChat', 'Duplicate chat'), icon: <GitFork className="w-4 h-4" />, run: onFork },
    { label: t('delete') || tx('delete', 'Delete'), icon: <Trash2 className="w-4 h-4" />, danger: true, run: onDelete },
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
      aria-label={`${title}${isSelected ? `, ${tx('currentChat', 'current chat')}` : ''}`}
      className={`group relative min-h-[44px] p-2 r-sm border transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
        isSelected
          ? 'bg-[var(--app-accent-subtle)] border-[var(--app-accent)] text-[var(--app-accent-text)]'
          : 'bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="t-body font-medium text-[var(--app-text)] line-clamp-1 flex-1 leading-snug">
          {title}
        </h4>
        <div className="flex items-center gap-1 -me-1 -mt-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className={`w-9 h-9 flex items-center justify-center r-sm transition ${
              isPinned ? 'text-[var(--app-warning)]' : 'text-[var(--app-text-dim)] hover:text-[var(--app-text)]'
            }`}
            title={isPinned ? tx('unpinFromFavorites', 'Remove from favorites') : tx('pinToFavorites', 'Add to favorites')}
            aria-label={`${isPinned ? tx('unpinFromFavorites', 'Remove from favorites') : tx('pinToFavorites', 'Add to favorites')}: ${title}`}
            aria-pressed={isPinned}
          >
            <Star className={`w-4 h-4 ${isPinned ? 'text-[var(--app-warning)]' : ''}`} />
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
              className="w-9 h-9 flex items-center justify-center r-sm text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition"
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
                  ref={menuRef}
                  role="menu"
                  aria-label={`${tx('moreActions', 'More actions')}: ${title}`}
                  className="absolute end-0 top-full z-50 w-44 r-sm elev-2 edge bg-[var(--app-card)] p-1"
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
                      className={`w-full h-9 px-3 flex items-center gap-3 r-sm t-caption transition cursor-pointer ${
                        item.danger
                          ? 'text-[var(--app-danger)] hover:bg-[var(--app-danger-subtle)]'
                          : 'text-[var(--app-text-muted)] hover:bg-[var(--app-card-hover)] hover:text-[var(--app-text)]'
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

      <div className="flex items-center justify-between mt-1 t-caption text-[var(--app-text-muted)]">
        <span aria-label={`${session.messageCount} ${tx('messages', 'messages')}`}>
          {session.messageCount} {tx('msgs', 'msgs')}
        </span>
        <span>{new Date(session.lastActiveAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </div>
    </div>
  );
};
