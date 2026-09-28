import React, { useState, useMemo } from 'react';
import {
  X,
  Plus,
  RefreshCw,
  Share2,
  Search,
  Star,
  Edit2,
  GitFork,
  Trash2,
  Download,
  Copy,
  Check,
  MessageSquare,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { MobileSession } from '../../types/hermes';

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
    newSession,
    deleteSession,
    renameSession,
    forkSession,
    refreshNow,
    pinnedIds,
    togglePin,
    chat,
  } = useHermes();

  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('ALL');
  const [sortMode, setSortMode] = useState<0 | 1 | 2>(0);

  const [renameTarget, setRenameTarget] = useState<MobileSession | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<MobileSession | null>(null);
  const [exportTarget, setExportTarget] = useState<MobileSession | null>(null);
  const [copied, setCopied] = useState(false);

  const presentSources = useMemo(() => {
    return Array.from(new Set(sessions.map((s) => s.source || 'web'))).sort();
  }, [sessions]);

  const visibleSessions = useMemo(() => {
    let list = sessions.filter((s) => {
      const q = query.toLowerCase().trim();
      const matchesQuery =
        !q ||
        s.title.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q);
      const matchesSource =
        sourceFilter === 'ALL' || (s.source || 'web') === sourceFilter;
      return matchesQuery && matchesSource;
    });

    list = [...list].sort((a, b) => {
      if (sortMode === 1) return a.lastActiveAt - b.lastActiveAt;
      if (sortMode === 2) return b.messageCount - a.messageCount;
      return b.lastActiveAt - a.lastActiveAt;
    });

    return list;
  }, [sessions, query, sourceFilter, sortMode]);

  const pinnedSessions = useMemo(() => {
    return visibleSessions.filter((s) => pinnedIds.includes(s.id));
  }, [visibleSessions, pinnedIds]);

  const otherSessions = useMemo(() => {
    return visibleSessions.filter((s) => !pinnedIds.includes(s.id));
  }, [visibleSessions, pinnedIds]);

  const handleExportMarkdown = (sess: MobileSession) => {
    let md = `# ${sess.title}\nID: ${sess.id}\nModel: ${sess.model}\nDate: ${new Date().toISOString()}\n\n---\n\n`;
    for (const msg of chat) {
      md += `### ${msg.sender === 'you' ? 'User' : 'Hermes'}\n\n${msg.content}\n\n`;
      if (msg.thinking) {
        md += `> **Thinking:**\n> ${msg.thinking.replace(/\n/g, '\n> ')}\n\n`;
      }
    }

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sess.title.replace(/[^a-z0-9_-]/gi, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyTranscript = () => {
    let md = `# Session Transcript\n\n`;
    for (const msg of chat) {
      md += `**${msg.sender === 'you' ? 'User' : 'Hermes'}:**\n${msg.content}\n\n`;
    }
    navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity duration-200"
        onClick={onClose}
      />

      {/* Drawer Container */}
      <aside className="relative w-full max-w-xs bg-[#0E1217] border-r border-white/[0.08] h-full flex flex-col z-10 shadow-2xl animate-in slide-in-from-left duration-200">
        {/* Header */}
        <div className="p-4 border-b border-white/[0.08] flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-white tracking-tight">
              Conversations
            </span>
            <span className="text-[11px] text-slate-500 ml-1.5">
              ({sessions.length})
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={async () => {
                const newId = await newSession();
                onSelectSession(newId);
                onClose();
              }}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-indigo-400 hover:text-white hover:bg-white/[0.06] transition"
              title="New Session"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.06] transition ml-1"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="p-3 border-b border-white/[0.06] space-y-2.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations..."
              className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-[#141920] border border-white/[0.06] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Clean Segmented Sort Control */}
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-slate-500 text-[10px] uppercase font-medium mr-1">Sort:</span>
            {[
              { label: 'Newest', mode: 0 },
              { label: 'Oldest', mode: 1 },
              { label: 'Messages', mode: 2 },
            ].map((s) => (
              <button
                key={s.mode}
                onClick={() => setSortMode(s.mode as any)}
                className={`px-2 py-0.5 rounded-md transition ${
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
          {sessions.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              <p>No conversations yet</p>
              <button
                onClick={async () => {
                  const id = await newSession();
                  onSelectSession(id);
                  onClose();
                }}
                className="mt-3 px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-medium cursor-pointer"
              >
                Create First Session
              </button>
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              <p>No conversations match your search</p>
            </div>
          ) : (
            <>
              {/* Pinned Section */}
              {pinnedSessions.length > 0 && (
                <div className="space-y-1 mb-3">
                  <div className="flex items-center gap-1.5 px-2 text-[11px] text-amber-400 font-medium">
                    <Star className="w-3 h-3 fill-amber-400" />
                    <span>Favorites ({pinnedSessions.length})</span>
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
                      }}
                      onFork={() => forkSession(sess.id)}
                      onDelete={() => setDeleteTarget(sess)}
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
                    }}
                    onFork={() => forkSession(sess.id)}
                    onDelete={() => setDeleteTarget(sess)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Rename Dialog */}
      {renameTarget && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-3xl bg-[#0E1217] border border-white/[0.1] p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-white">
              Rename Conversation
            </h3>
            <input
              type="text"
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setRenameTarget(null)}
                className="px-3.5 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (renameTitle.trim()) {
                    renameSession(renameTarget.id, renameTitle.trim());
                  }
                  setRenameTarget(null);
                }}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-3xl bg-[#0E1217] border border-white/[0.1] p-5 shadow-2xl space-y-3">
            <h3 className="text-sm font-semibold text-white">
              Delete Conversation?
            </h3>
            <p className="text-xs text-slate-400">
              Are you sure you want to delete "{deleteTarget.title}"?
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3.5 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteSession(deleteTarget.id);
                  setDeleteTarget(null);
                }}
                className="px-4 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold"
              >
                Delete
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
}) => {
  return (
    <div
      onClick={onSelect}
      className={`group relative p-3 rounded-2xl border transition-all cursor-pointer ${
        isSelected
          ? 'bg-indigo-600/10 border-indigo-500/40 text-white'
          : 'bg-[#141920]/60 hover:bg-[#141920] border-white/[0.05] hover:border-white/[0.1]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-xs font-medium text-slate-200 line-clamp-1 flex-1 leading-snug">
          {session.title || 'Untitled Session'}
        </h4>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className={`p-1 rounded-md transition ${
            isPinned ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100'
          }`}
          title={isPinned ? 'Unpin' : 'Pin to favorites'}
        >
          <Star className={`w-3.5 h-3.5 ${isPinned ? 'fill-amber-400' : ''}`} />
        </button>
      </div>

      <div className="flex items-center justify-between mt-1 text-[11px] text-slate-400">
        <span>{session.messageCount} msgs</span>
        <span>{new Date(session.lastActiveAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </div>

      <div className="mt-2 pt-2 border-t border-white/[0.05] flex items-center justify-end gap-3 text-[11px] text-slate-400">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          className="hover:text-white transition flex items-center gap-1"
        >
          <Edit2 className="w-3 h-3" />
          <span>Rename</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onFork();
          }}
          className="hover:text-indigo-400 transition flex items-center gap-1"
        >
          <GitFork className="w-3 h-3" />
          <span>Branch</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="hover:text-rose-400 transition flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" />
          <span>Delete</span>
        </button>
      </div>
    </div>
  );
};
