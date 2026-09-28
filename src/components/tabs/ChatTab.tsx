import React, { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import {
  Square,
  RefreshCw,
  Plus,
  Volume2,
  VolumeX,
  Copy,
  Check,
  Search,
  X,
  ChevronDown,
  ChevronUp,
  Mic,
  GitFork,
  Clock,
  Sparkles,
  Sliders,
  MoreHorizontal,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { ChatMessage, PendingApproval } from '../../types/hermes';
import { PROVIDER_OPTIONS, normProvider } from '../../constants/providers';
import { speechLocaleForLanguage } from '../../constants/languages';
import { processAttachBatch, buildTextChoiceNotice, MAX_IMAGE_COUNT } from '../../services/attachments';
import type { AttachmentRef } from '../../services/attachmentRefs';
import {
  appendAttachmentRefs,
  previewUrlFor,
  registerBlob,
  refsFromTexts,
  revokeRef,
} from '../../services/attachmentRefs';
import { ApprovalCard } from '../approvals/ApprovalCard';

interface ChatTabProps {
  onGoSettings: () => void;
  isDesktop?: boolean;
}

interface MessageRowProps {
  msg: ChatMessage;
  isLiveTail: boolean;
  modelLabel: string | null;
  durationLabel: string | null;
  fontScale: number;
  formulatingLabel: string;
  copied: boolean;
  speaking: boolean;
  menuOpen: boolean;
  streamBusy: boolean;
  menuContainerRef?: React.RefObject<HTMLDivElement | null>;
  onCopy: (id: string, content: string) => void;
  onSpeak: (id: string, content: string) => void;
  onRegenerate: (content: string) => void;
  onFork: () => void;
  onToggleMenu: (id: string | null) => void;
}

// Memoized so 50ms batched streaming flushes only re-render the live tail
// row instead of every bubble on every token.
const MessageRow: React.FC<MessageRowProps> = memo(
  ({
    msg,
    isLiveTail,
    modelLabel,
    durationLabel,
    fontScale,
    formulatingLabel,
    copied,
    speaking,
    menuOpen,
    streamBusy,
    menuContainerRef,
    onCopy,
    onSpeak,
    onRegenerate,
    onFork,
    onToggleMenu,
  }) => {
    const isUser = msg.sender === 'you';
    return (
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Bubble Container */}
        <div
          role="article"
          aria-label={isUser ? 'Your message' : 'Hermes response'}
          className={`w-full max-w-[94%] sm:max-w-[88%] rounded-2xl p-4 transition-all ${
            isUser
              ? 'bg-indigo-600/90 text-white shadow-xs'
              : 'bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-slate-200'
          }`}
          style={{
            fontSize: `${fontScale * 14}px`,
          }}
        >
          {/* Clean unboxed metadata row */}
          <div className="flex items-center justify-between gap-4 text-[11px] mb-2 pb-1.5 border-b border-white/[0.08]">
            <span className="font-semibold text-xs tracking-tight text-white/90">
              {isUser ? 'You' : 'Hermes'}
            </span>

            <div className="flex items-center gap-2 text-slate-400 font-mono text-[10px]">
              {!isUser && (modelLabel || durationLabel) && (
                <span>
                  {modelLabel}
                  {durationLabel && ` · ${durationLabel}`}
                </span>
              )}
              <button
                onClick={() => onCopy(msg.id, msg.content || msg.thinking || '')}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-white cursor-pointer ms-1"
                title="Copy message"
                aria-label="Copy message"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* Thinking Block */}
          {msg.thinking && (
            <ThinkingAccordion
              thinking={msg.thinking}
              isDone={msg.thinkingDone !== false}
              fontScale={fontScale}
            />
          )}

          {/* Tool Invocations */}
          {msg.tools && msg.tools.length > 0 && (
            <div className="mb-2.5 space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {msg.tools.map((toolName, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] font-mono text-teal-300"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
                    <span>{toolName}</span>
                  </span>
                ))}
              </div>

              {msg.toolOutputs && msg.toolOutputs.length > 0 && (
                <div className="rounded-xl bg-[var(--app-bg,#090B0E)] p-2.5 border border-white/[0.06] text-xs font-mono text-slate-400 space-y-1">
                  {msg.toolOutputs.map((out, i) => (
                    <div key={i} className="leading-relaxed break-all whitespace-pre-wrap">
                      <span className="text-teal-400 font-medium">{out.toolName}:</span>{' '}
                      <span>{out.output}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Message Body */}
          {msg.content ? (
            <div className="prose dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text font-sans">
              {msg.content}
              {isLiveTail && !isUser && (
                <span className="inline-block w-1.5 h-4 ms-1 bg-indigo-400 animate-pulse align-middle" />
              )}
            </div>
          ) : isLiveTail ? (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-1">
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
              <span>{formulatingLabel}</span>
            </div>
          ) : null}

          {/* Message Actions: Regenerate stays visible, rest behind overflow menu */}
          <div className="relative flex items-center justify-end gap-3 mt-3 pt-2 border-t border-white/[0.06] text-xs">
            {isUser && (
              <button
                onClick={() => onRegenerate(msg.content)}
                disabled={streamBusy || !msg.content.trim()}
                aria-label={streamBusy ? 'Regenerate (disabled while generating)' : 'Regenerate response'}
                title={streamBusy ? 'Wait for generation to finish' : 'Regenerate response'}
                className="min-h-[44px] px-2 hover:text-white cursor-pointer flex items-center gap-1 transition text-white/70 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Regenerate</span>
              </button>
            )}
            <button
              onClick={() => onToggleMenu(menuOpen ? null : msg.id)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-white transition cursor-pointer"
              title="More actions"
              aria-label="More message actions"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div
                ref={menuOpen ? menuContainerRef : undefined}
                role="menu"
                className="absolute bottom-full end-0 mb-1.5 min-w-[140px] rounded-xl bg-[var(--app-card-subtle,#1A2230)] border border-white/[0.1] shadow-2xl py-1 z-20"
              >
                {isUser && (
                  <button
                    onClick={() => {
                      onFork();
                      onToggleMenu(null);
                    }}
                    role="menuitem"
                    className="w-full min-h-[44px] px-3 py-2 flex items-center gap-2 text-start text-slate-300 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                  >
                    <GitFork className="w-3.5 h-3.5" />
                    <span>Branch</span>
                  </button>
                )}
                <button
                  onClick={() => {
                    onSpeak(msg.id, msg.content);
                    onToggleMenu(null);
                  }}
                  role="menuitem"
                  className="w-full min-h-[44px] px-3 py-2 flex items-center gap-2 text-start text-slate-300 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                  title={speaking ? 'Stop audio playback' : 'Read aloud'}
                >
                  {speaking ? (
                    <>
                      <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                      <span className="text-rose-400 font-medium">Stop</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>Read aloud</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
);

export const ChatTab: React.FC<ChatTabProps> = ({ onGoSettings, isDesktop = false }) => {
  const {
    currentSessionId,
    chat,
    streaming,
    streamElapsed,
    turnMeta,
    approvals,
    queuedMessages,
    models,
    settings,
    updateSettings,
    sendMessage,
    sendNow,
    queueMessage,
    cancelQueued,
    stopStream,
    resolveApproval,
    forkSession,
    newSession,
    getDraft,
    setDraft,
    configuredProviders,
    activateProvider,
    retryLast,
    connected,
    gatewayFailed,
    gatewayFailureReason,
    t,
  } = useHermes();

  // Composer and input state
  const [text, setText] = useState('');
  interface AttachedImage {
    previewUrl: string;
    dataUrl: string;
    name: string;
    ref: AttachmentRef;
  }
  const [attached, setAttached] = useState<AttachedImage[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [resolvingRunId, setResolvingRunId] = useState<string | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showModelsSheet, setShowModelsSheet] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<'info' | 'success' | 'error'>('info');
  const [modelPillExpanded, setModelPillExpanded] = useState(false);
  const [confirmSessionRunId, setConfirmSessionRunId] = useState<string | null>(null);
  const [streamErrorDismissed, setStreamErrorDismissed] = useState<string | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Optional context surface (lands with the context owner's stream-error
  // work): the live failure banner below activates when present, and stays
  // hidden otherwise. Never touch HermesContext.tsx from this file.
  const streamError =
    (useHermes() as unknown as { streamError?: string | null }).streamError ?? null;
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef('');
  const attachedRef = useRef<AttachedImage[]>([]);
  const sheetSearchRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const attachAbortRef = useRef<AbortController | null>(null);
  const pendingRefsRef = useRef<AttachmentRef[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const getDraftRef = useRef(getDraft);
  getDraftRef.current = getDraft;
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const showActionToast = (msg: string, kind: 'info' | 'success' | 'error' = 'info') => {
    setActionToast(msg);
    setToastKind(kind);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setActionToast(null);
      toastTimerRef.current = null;
    }, 2500);
  };
  const toastClass =
    toastKind === 'error'
      ? 'bg-rose-600 text-white'
      : toastKind === 'success'
        ? 'bg-emerald-600 text-white'
        : 'bg-slate-800 text-slate-100 border border-white/[0.1]';

  // Abort in-flight speech recognition, attachment processing, and timers on unmount
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort?.();
      } catch {
        /* ignore */
      }
      attachAbortRef.current?.abort();
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      // Revoke composer preview URLs; sent-session blobs stay registered
      // so persisted attachment refs keep resolving.
      pendingRefsRef.current.forEach((r) => {
        try {
          if (r.type === 'image') revokeRef(r);
        } catch {
          /* ignore */
        }
      });
      pendingRefsRef.current = [];
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    const draft = getDraftRef.current(currentSessionId);
    textRef.current = draft;
    setText(draft);
  }, [currentSessionId]);

  // Model selection modal search & category filters
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [modelFilterProvider, setModelFilterProvider] = useState<string>('ALL');

  const getProviderBadgeLabel = (p?: string) => {
    const raw = p || settings.provider || 'deepseek';
    const norm = normProvider(raw);
    const configured = configuredProviders.find(
      (cp) => normProvider(cp.provider) === norm || cp.id === raw
    );
    if (configured?.name) return configured.name;
    const found = PROVIDER_OPTIONS.find(([id]) => id === norm);
    if (found) return found[1];
    if (norm === 'openrouter') return 'OpenRouter';
    if (norm === 'mixture-of-agents' || norm === 'moa') return 'Mixture of Agents';
    if (norm === 'gemini') return 'Google AI Studio';
    if (norm === 'anthropic') return 'Anthropic';
    if (norm === 'deepseek') return 'DeepSeek';
    if (norm === 'openai-api' || norm === 'openai') return 'OpenAI';
    if (norm === 'xai') return 'xAI';
    if (norm === 'ollama-cloud' || norm === 'ollama') return 'Ollama';
    return raw;
  };

  // Only show the providers that are ACTUALLY configured/added
  const providerFilterOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string }> = [];
    const uniqueMap = new Map<string, string>();

    // Scan configured providers
    configuredProviders.forEach((prov) => {
      if (prov.enabled !== false && prov.provider) {
        const norm = normProvider(prov.provider);
        if (!uniqueMap.has(norm)) {
          uniqueMap.set(norm, prov.name || getProviderBadgeLabel(norm));
        }
      }
    });

    // Also include active provider if not already added
    if (settings.provider) {
      const activeNorm = normProvider(settings.provider);
      if (!uniqueMap.has(activeNorm)) {
        uniqueMap.set(activeNorm, getProviderBadgeLabel(activeNorm));
      }
    }

    opts.push({ id: 'ALL', label: 'ALL' });
    uniqueMap.forEach((label, id) => {
      opts.push({ id, label });
    });

    return opts;
  }, [configuredProviders, settings.provider]);

  // Keep selected filter in sync if providers change
  useEffect(() => {
    if (modelFilterProvider !== 'ALL') {
      const exists = providerFilterOptions.some((opt) => opt.id === modelFilterProvider);
      if (!exists) {
        setModelFilterProvider('ALL');
      }
    }
  }, [providerFilterOptions, modelFilterProvider]);

  const filteredModels = useMemo(() => {
    let result = models;
    if (modelFilterProvider !== 'ALL') {
      const target = normProvider(modelFilterProvider);
      result = result.filter((m) => {
        const p = normProvider(m.provider || '');
        return p === target;
      });
    }
    if (modelSearchQuery.trim()) {
      const q = modelSearchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.displayName.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.provider && m.provider.toLowerCase().includes(q))
      );
    }
    return result;
  }, [models, modelFilterProvider, modelSearchQuery]);

  const adjustTextareaHeight = () => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    const newHeight = Math.min(Math.max(textareaRef.current.scrollHeight, 28), 160);
    textareaRef.current.style.height = `${newHeight}px`;
  };

  const handleTextChange = (val: string) => {
    textRef.current = val;
    setText(val);
    setDraft(currentSessionId, val);
  };

  // Keep the dictation-safe ref in sync with attachments for cap accounting
  useEffect(() => {
    attachedRef.current = attached;
  }, [attached]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [text]);

  // Batched streaming updates: sync context chat into local display state at
  // most once per 50ms while streaming so rapid deltas do not re-render every
  // row on every token. Idle updates apply immediately.
  const [displayChat, setDisplayChat] = useState<ChatMessage[]>(chat);
  const chatLatestRef = useRef(chat);
  chatLatestRef.current = chat;
  useEffect(() => {
    if (!streaming) {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      setDisplayChat(chat);
      return;
    }
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      setDisplayChat(chatLatestRef.current);
    }, 50);
  }, [chat, streaming]);

  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    }
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStickToBottom(nearBottom);
  };

  // Stick-to-bottom follow: auto-scroll on every batched token flush while
  // the user is pinned to the tail; never yank them mid-read. A new user
  // turn re-pins. The jump-to-latest pill (below) recovers the tail.
  useEffect(() => {
    if (stickToBottom) scrollToBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayChat, stickToBottom]);

  const visibleMessages = useMemo(() => {
    if (!searchOpen || !searchQuery.trim()) return displayChat;
    const q = searchQuery.toLowerCase();
    return displayChat.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        (m.thinking && m.thinking.toLowerCase().includes(q))
    );
  }, [displayChat, searchOpen, searchQuery]);

  // Stream errors arrive as hermes bubbles from context; surface them as a
  // distinct banner with retry/dismiss instead of rendering error-as-bubble.
  const isStreamError = (m: ChatMessage) =>
    m.sender === 'hermes' && m.content.startsWith('Stream error:');
  const bubbleMessages = useMemo(() => visibleMessages.filter((m) => !isStreamError(m)), [visibleMessages]);
  const errorMessages = useMemo(() => visibleMessages.filter(isStreamError), [visibleMessages]);
  const visibleErrors = useMemo(
    () => errorMessages.filter((m) => !dismissedErrors.includes(m.id)),
    [errorMessages, dismissedErrors]
  );

  // Search-safe live tail: resolved against the unfiltered stream, never the
  // filtered index, so the typing cursor can't land on the wrong bubble.
  const liveTailId = streaming && displayChat.length > 0 ? displayChat[displayChat.length - 1].id : null;

  const pendingApprovals = approvals;

  const attachedPayloads = useMemo(() => attached.map((a) => a.dataUrl), [attached]);

  const hasComposerContent = text.trim().length > 0 || attached.length > 0;
  const canSendNow = hasComposerContent && !!settings.modelId && !attaching;

  const clearComposer = () => {
    handleTextChange('');
    setAttached([]);
    setAttachNotice(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  // Unified guarded send: model guard, trim, failure-safe draft. The draft
  // and attachments clear ONLY on success; a failed send keeps everything.
  const handleSend = () => {
    const raw = textRef.current;
    const trimmed = raw.trim();
    const payloads = attachedRef.current.map((a) => a.dataUrl);
    if (!trimmed && payloads.length === 0) return;
    if (!settings.modelId) {
      showActionToast('Select a model first', 'error');
      setShowModelsSheet(true);
      return;
    }
    const ok = streaming ? queueMessage(trimmed, payloads) : sendMessage(trimmed, payloads);
    if (!ok) {
      showActionToast(streaming ? 'Could not queue message' : 'Send failed , draft kept', 'error');
      return;
    }
    if (streaming) showActionToast('Queued for next turn', 'info');
    // Persist metadata-only refs for history; blobs stay registered so the
    // refs keep resolving. Blobs are revoked only on remove, never on send.
    if (currentSessionId && pendingRefsRef.current.length > 0) {
      appendAttachmentRefs(currentSessionId, pendingRefsRef.current);
      pendingRefsRef.current = [];
    }
    clearComposer();
    setStickToBottom(true);
  };

  // Streaming "Send now": stop-then-send via sendNow with the same guards
  // and failure-safe clear as the unified path.
  const handleSendNow = () => {
    const raw = textRef.current;
    const trimmed = raw.trim();
    const payloads = attachedRef.current.map((a) => a.dataUrl);
    if (!trimmed && payloads.length === 0) return;
    if (!settings.modelId) {
      showActionToast('Select a model first', 'error');
      setShowModelsSheet(true);
      return;
    }
    const result = sendNow(trimmed, payloads);
    if (!result) {
      showActionToast('Send failed , draft kept', 'error');
      return;
    }
    if (result === 'queued') showActionToast('Queued for next turn', 'info');
    if (currentSessionId && pendingRefsRef.current.length > 0) {
      appendAttachmentRefs(currentSessionId, pendingRefsRef.current);
      pendingRefsRef.current = [];
    }
    clearComposer();
    setStickToBottom(true);
  };

  const handleResolveApproval = async (
    approval: PendingApproval,
    allow: boolean,
    scope?: 'once' | 'session'
  ) => {
    // Session-allow is broad: require an explicit two-tap confirm.
    if (allow && scope === 'session' && confirmSessionRunId !== approval.runId) {
      setConfirmSessionRunId(approval.runId);
      showActionToast('Tap Allow Session again to confirm', 'info');
      return;
    }
    setConfirmSessionRunId(null);
    setResolvingRunId(approval.runId);
    try {
      await resolveApproval(approval, allow, scope);
    } finally {
      setResolvingRunId((cur) => (cur === approval.runId ? null : cur));
    }
  };

  const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
    const res = await fetch(dataUrl);
    return res.blob();
  };

  const removeAttachment = (index: number) => {
    setAttached((prev) => {
      const target = prev[index];
      if (target) {
        try {
          revokeRef(target.ref);
        } catch {
          /* ignore */
        }
        pendingRefsRef.current = pendingRefsRef.current.filter((r) => r.id !== target.ref.id);
      }
      return prev.filter((_, idx) => idx !== index);
    });
  };

  const handleImageAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    // Allow reselecting the same file
    e.target.value = '';
    if (files.length === 0 || attaching) return;

    // Abort any in-flight batch from a rapid reselect before starting a new one
    attachAbortRef.current?.abort();
    const ctrl = new AbortController();
    attachAbortRef.current = ctrl;
    setAttaching(true);
    try {
      const batch = await processAttachBatch(files, {
        imageCountAlreadyAttached: attachedRef.current.length,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;

      // Cap without split-brain: only refs for kept items enter the pending
      // list, so attached[] and pendingRefs stay 1:1. Over-cap drops revoke
      // immediately and toast loudly instead of slicing silently.
      const room = Math.max(0, MAX_IMAGE_COUNT - attachedRef.current.length);
      const keptImages = batch.images.slice(0, room);
      const droppedImages = batch.images.slice(room);
      const newItems: AttachedImage[] = [];
      for (const img of keptImages) {
        const blob = await dataUrlToBlob(img.dataUrl);
        const ref = registerBlob(blob, {
          type: 'image',
          name: img.sourceName,
          mime: img.mime,
          size: img.bytes,
          width: img.width,
          height: img.height,
        });
        const previewUrl = previewUrlFor(ref) || img.dataUrl;
        pendingRefsRef.current.push(ref);
        newItems.push({ previewUrl, dataUrl: img.dataUrl, name: img.sourceName, ref });
      }
      if (newItems.length > 0) {
        setAttached((prev) => [...prev, ...newItems]);
      }
      if (droppedImages.length > 0) {
        showActionToast(
          `${droppedImages.length} image${droppedImages.length > 1 ? 's' : ''} omitted: ${MAX_IMAGE_COUNT}-image cap reached`,
          'error'
        );
      }

      if (batch.texts.length > 0) {
        const textRefs = refsFromTexts(batch.texts);
        pendingRefsRef.current.push(...textRefs);
        // Ref-based (no setState-updater side effect): StrictMode-safe.
        const blocks = batch.texts.map((r) => r.block).join('\n\n');
        const base = textRef.current;
        const next = base ? `${base}\n\n${blocks}` : blocks;
        handleTextChange(next);
        const notice = buildTextChoiceNotice(batch.texts);
        if (notice) setAttachNotice(notice);
      }

      if (batch.errors.length > 0) {
        showActionToast(batch.errors.join('\n'), 'error');
      }
    } catch {
      if (!ctrl.signal.aborted) showActionToast('Could not attach files', 'error');
    } finally {
      if (attachAbortRef.current === ctrl) attachAbortRef.current = null;
      setAttaching(false);
    }
  };

  const toggleVoice = () => {
    if (isListening) {
      if (recognitionRef.current) recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert(t('speechUnsupported'));
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = speechLocaleForLanguage(settings.language || 'en');

      recognition.onstart = () => setIsListening(true);
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        // Ref-based: the closure over `text` goes stale while dictating.
        const base = textRef.current;
        handleTextChange(base ? `${base} ${transcript}` : transcript);
        setIsListening(false);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

  const MAX_SPEECH_CHARS = 1500;

  // Strip content that should never be vocalized: fenced code blocks,
  // inline code, and URLs (may contain secrets or tokens)
  const sanitizeForSpeech = (content: string) => {
    let out = content.replace(/```[\s\S]*?```/g, ' code omitted ');
    out = out.replace(/`[^`]*`/g, '');
    out = out.replace(/https?:\/\/\S+/g, ' link omitted ');
    out = out.replace(/[*#_>\-|]/g, '');
    return out.replace(/\s+/g, ' ').trim();
  };

  const handleSpeak = (msgId: string, content: string) => {
    if (!window.speechSynthesis) return;

    if (speakingMsgId === msgId) {
      window.speechSynthesis.cancel();
      setSpeakingMsgId(null);
      return;
    }

    window.speechSynthesis.cancel();
    const cleanText = sanitizeForSpeech(content);
    if (!cleanText) return;
    const truncated = cleanText.length > MAX_SPEECH_CHARS;
    const utter = new SpeechSynthesisUtterance(
      truncated ? cleanText.slice(0, MAX_SPEECH_CHARS) : cleanText
    );
    utter.lang = speechLocaleForLanguage(settings.language || 'en');
    utter.onend = () => setSpeakingMsgId(null);
    utter.onerror = () => setSpeakingMsgId(null);
    setSpeakingMsgId(msgId);
    if (truncated) showActionToast('Message truncated for read-aloud', 'info');
    window.speechSynthesis.speak(utter);
  };

  const handleCopy = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      showActionToast(t('copyFailed'), 'error');
    }
  };

  // Stable callbacks for memoized message rows
  const onCopyMessage = useCallback(
    (id: string, content: string) => {
      void handleCopy(id, content);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  );
  const onSpeakMessage = useCallback(
    (id: string, content: string) => {
      handleSpeak(id, content);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speakingMsgId]
  );
  const onRegenerateMessage = useCallback(
    (content: string) => {
      // Stream guard: never fire a second turn mid-stream; the row button is
      // also disabled, this is the keyboard/edge-path backstop.
      if (streaming) {
        showActionToast('Still generating , wait or stop first', 'info');
        return;
      }
      if (!content.trim()) return;
      const ok = sendMessage(content.trim());
      if (!ok) showActionToast('Regenerate failed', 'error');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendMessage, streaming]
  );
  const onForkMessage = useCallback(() => {
    if (currentSessionId) forkSession(currentSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, forkSession]);
  const onToggleMenu = useCallback((id: string | null) => {
    setOpenMenuId(id);
  }, []);

  // Model sheet: Escape closes, search input autofocuses on open.
  useEffect(() => {
    if (!showModelsSheet) return;
    sheetSearchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowModelsSheet(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showModelsSheet]);

  // Overflow menu: close on outside tap or Escape.
  useEffect(() => {
    if (openMenuId === null) return;
    const onPointer = (e: PointerEvent) => {
      const el = menuRef.current;
      if (el && !el.contains(e.target as Node)) setOpenMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenuId]);

  // A new stream error re-arms the banner after a previous dismiss.
  useEffect(() => {
    setStreamErrorDismissed(null);
  }, [streamError]);

  const curModelName =
    models.find((m) => m.id === settings.modelId)?.displayName ||
    settings.modelId.split('/').pop() ||
    'deepseek-chat';

  const starterChips = [
    'Search recent developments in AI agent frameworks',
    'Summarize current system memory & registered tools',
    'Create an automated daily check job for system state',
  ];

  const slashCommands = [
    { label: '/new', action: () => newSession() },
    {
      label: '/retry',
      action: () => {
        retryLast();
      },
    },
    { label: '/find', action: () => setSearchOpen(true) },
    { label: '/help', action: () => quickSend('/help') },
    { label: '/status', action: () => quickSend('/status') },
  ];

  // Guarded one-shot send for starters + slash shortcuts (bypasses composer).
  const quickSend = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (!settings.modelId) {
      showActionToast('Select a model first', 'error');
      setShowModelsSheet(true);
      return;
    }
    if (streaming) {
      if (!queueMessage(trimmed, [])) showActionToast('Could not queue message', 'error');
      else showActionToast('Queued for next turn', 'info');
      return;
    }
    if (!sendMessage(trimmed, [])) showActionToast('Send failed', 'error');
    else setStickToBottom(true);
  };

  return (
    <div className={`flex flex-col flex-1 min-h-0 h-full ${isDesktop ? 'max-w-4xl mx-auto w-full px-6' : 'px-3 sm:px-4'} pt-2 pb-1`}>
      {actionToast && (
        <div
          role={toastKind === 'error' ? 'alert' : 'status'}
          aria-live={toastKind === 'error' ? 'assertive' : 'polite'}
          className={`fixed top-16 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] px-4 py-2 rounded-xl text-xs font-semibold shadow-2xl max-w-[90vw] break-words ${toastClass}`}
        >
          {actionToast}
        </div>
      )}
      {/* In-chat Search Input */}
      {searchOpen && (
        <div className="flex items-center gap-2 p-2 px-3 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] mb-2 shrink-0 animate-in fade-in duration-150">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversation..."
            className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            className="min-h-[44px] px-3 text-xs text-slate-400 hover:text-white"
          >
            Done
          </button>
        </div>
      )}

      {/* 2. Messages List Scroll Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        aria-label="Conversation messages"
        className="relative flex-1 min-h-0 overflow-y-auto space-y-4 pe-1 pb-2"
      >
        {bubbleMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4 space-y-4">
            {(!connected || gatewayFailed) && (
              <div
                role="alert"
                className="w-full max-w-md px-3.5 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-start"
              >
                <p className="text-xs font-semibold text-rose-300">
                  Gateway offline{gatewayFailed && gatewayFailureReason ? `: ${gatewayFailureReason}` : ''}
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  You are disconnected. New messages will queue until the gateway reconnects.
                </p>
                <button
                  onClick={onGoSettings}
                  className="mt-1.5 min-h-[44px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] text-xs text-white cursor-pointer"
                >
                  Open Settings
                </button>
              </div>
            )}
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-500/20 to-teal-500/20 border border-indigo-500/30 flex items-center justify-center shadow-xs">
              <Sparkles className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white tracking-tight">
                {t('helpToday')}
              </h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm">
                Ask questions, orchestrate local tools, execute sandboxed code, or schedule workflows.
              </p>
            </div>

            {/* Clean suggestion cards */}
            <div className="grid grid-cols-1 gap-2 w-full max-w-md pt-2">
              {starterChips.map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => quickSend(chip)}
                  title={chip}
                  className="px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] hover:border-indigo-500/30 text-xs text-slate-300 text-start transition hover:bg-white/[0.02] cursor-pointer"
                >
                  {chip}
                </button>
              ))}
            </div>
            {(!settings.modelId || configuredProviders.length === 0) && (
              <div
                role="note"
                className="w-full max-w-md px-3.5 py-2.5 rounded-xl bg-sky-500/10 border border-sky-500/30 text-start"
              >
                <p className="text-xs font-semibold text-sky-200">
                  {!settings.modelId ? 'No model selected' : 'No providers configured'}
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {!settings.modelId
                    ? 'Pick a model to start chatting.'
                    : 'Add a provider before picking a model.'}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  {!settings.modelId && models.length > 0 && (
                    <button
                      onClick={() => setShowModelsSheet(true)}
                      className="min-h-[44px] px-3 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold cursor-pointer"
                    >
                      Select a model
                    </button>
                  )}
                  <button
                    onClick={onGoSettings}
                    className="min-h-[44px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] text-xs text-white cursor-pointer"
                  >
                    Open Settings
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          bubbleMessages.map((msg) => {
            const meta = turnMeta[msg.id];
            const modelLabel =
              meta && msg.sender !== 'you' ? meta.model.split('/').pop() || null : null;
            const durationLabel =
              meta && meta.durationMs > 0 ? `${(meta.durationMs / 1000).toFixed(1)}s` : null;
            return (
              <MessageRow
                key={msg.id}
                msg={msg}
                isLiveTail={msg.id === liveTailId}
                modelLabel={modelLabel}
                durationLabel={durationLabel}
                fontScale={settings.fontScale}
                formulatingLabel={t('formulating')}
                copied={copiedId === msg.id}
                speaking={speakingMsgId === msg.id}
                menuOpen={openMenuId === msg.id}
                streamBusy={streaming}
                menuContainerRef={menuRef}
                onCopy={onCopyMessage}
                onSpeak={onSpeakMessage}
                onRegenerate={onRegenerateMessage}
                onFork={onForkMessage}
                onToggleMenu={onToggleMenu}
              />
            );
          })
        )}
        <div ref={messagesEndRef} />
        {!stickToBottom && bubbleMessages.length > 0 && (
          <button
            onClick={() => {
              setStickToBottom(true);
              scrollToBottom(true);
            }}
            aria-label="Jump to latest messages"
            className="sticky bottom-2 ms-auto me-2 min-h-[44px] px-3 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-2xl cursor-pointer flex items-center gap-1.5"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            Latest
          </button>
        )}
      </div>

      <div className="shrink-0 min-h-0 max-h-[32vh] overflow-y-auto space-y-2 overscroll-contain">
            {/* 3. Security Approval Confirmation Queue */}
            {pendingApprovals.length > 0 && (
        <div className="mb-2 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 shadow-lg animate-in slide-in-from-bottom duration-200">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-semibold text-amber-200 tracking-tight">
              {t('approvalTitle')}
            </span>
            <span className="text-[11px] font-mono text-amber-300/80">
              {pendingApprovals.length} {t('pending')}
            </span>
          </div>
          <div className="space-y-3">
            {pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.runId}
                approval={approval}
                resolving={resolvingRunId === approval.runId}
                onDeny={(a) => void handleResolveApproval(a, false)}
                onAllow={(a, scope) => void handleResolveApproval(a, true, scope)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Queued Messages Ribbon */}
      {queuedMessages.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          aria-label={`${queuedMessages.length} messages queued for next turn`}
          className="mb-2 px-3.5 py-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-between gap-2 text-xs text-indigo-300"
        >
          <span className="min-w-0 truncate">
            {queuedMessages.length} queued{queuedMessages[0]?.text ? `: ${queuedMessages[0].text.slice(0, 60)}` : ` ${t('queuedFor')}`}
          </span>
          <button
            onClick={cancelQueued}
            aria-label={`Cancel ${queuedMessages.length} queued messages`}
            className="text-rose-400 hover:underline cursor-pointer shrink-0 min-h-[44px] px-2"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Live stream failure banner (context streamError surface, never a bubble) */}
      {streamError && streamErrorDismissed !== streamError && (
        <div
          role="alert"
          className="mb-2 px-3.5 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs"
        >
          <p className="text-rose-200 break-words leading-relaxed">Stream error: {streamError}</p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => {
                if (streaming) {
                  showActionToast('Still generating , wait or stop first', 'info');
                  return;
                }
                if (!retryLast()) showActionToast('Nothing to retry', 'error');
              }}
              disabled={streaming}
              className="min-h-[44px] px-3 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Retry
            </button>
            <button
              onClick={() => setStreamErrorDismissed(streamError)}
              className="min-h-[44px] px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-slate-300 text-xs cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Legacy stream error bubbles (older persisted history), with retry/dismiss */}
      {visibleErrors.map((err) => (
        <div
          key={err.id}
          role="alert"
          className="mb-2 px-3.5 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs"
        >
          <p className="text-rose-200 break-words leading-relaxed">{err.content}</p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => {
                if (streaming) {
                  showActionToast('Still generating , wait or stop first', 'info');
                  return;
                }
                if (!retryLast()) showActionToast('Nothing to retry', 'error');
              }}
              disabled={streaming}
              className="min-h-[44px] px-3 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Retry
            </button>
            <button
              onClick={() => setDismissedErrors((prev) => [...prev, err.id])}
              className="min-h-[44px] px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-slate-300 text-xs cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {/* Text-file truncation choice notice with included/omitted counts */}
      {attachNotice && (
        <div
          role="status"
          className="mb-2 px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs"
        >
          <p className="text-amber-200 font-semibold">Large text file truncated</p>
          <p className="text-slate-300 mt-0.5 whitespace-pre-wrap break-words">{attachNotice}</p>
          <button
            onClick={() => setAttachNotice(null)}
            className="mt-1.5 min-h-[44px] px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-slate-300 text-xs cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Attached Images preview (object URLs; compressed payloads sent on submit) */}
      {attaching && attached.length === 0 && (
        <div className="mb-2 px-3.5 py-2 rounded-xl bg-white/[0.03] border border-white/[0.08] text-[11px] text-slate-400">
          Processing attachments...
        </div>
      )}
      {attached.length > 0 && (
        <div className="flex items-center gap-2 mb-2 p-2 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] overflow-x-auto">
          {attached.map((item, i) => (
            <div key={item.ref.id} className="relative w-12 h-12 rounded-lg overflow-hidden shrink-0 border border-white/10 group">
              <img src={item.previewUrl} alt={item.name || 'Attached'} className="w-full h-full object-cover" />
              <button
                onClick={() => removeAttachment(i)}
                aria-label={`Remove attachment ${i + 1}`}
                className="absolute -top-2 -end-2 min-w-[44px] min-h-[44px] flex items-start justify-end p-1.5 text-white"
              >
                <span className="p-0.5 rounded-full bg-black/80 flex items-center justify-center">
                  <X className="w-3 h-3" />
                </span>
              </button>
            </div>
          ))}
          <span className="text-[11px] text-slate-400">
            {attached.length}/{MAX_IMAGE_COUNT} attached{attaching ? '...' : ''}
          </span>
        </div>
      )}

      {/* Slash command helpers: visible on empty composer and while typing a / command */}
      {!streaming && (text === '' || text.startsWith('/')) && (
        <div
          role="toolbar"
          aria-label="Slash commands"
          className="flex items-center gap-1.5 mb-2 overflow-x-auto pb-1 text-xs shrink-0"
        >
          {slashCommands
            .filter((cmd) => {
              if (text === '') return true;
              const token = text.trim().split(/\s+/)[0];
              return cmd.label.startsWith(token || '/');
            })
            .map((cmd) => (
            <button
              key={cmd.label}
              onClick={cmd.action}
              aria-label={`Run ${cmd.label} command`}
              className="px-2.5 min-h-[44px] py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-slate-400 hover:text-white transition cursor-pointer shrink-0 font-mono text-[11px]"
            >
              {cmd.label}
            </button>
          ))}
        </div>
      )}
      </div>

      {/* 4. Desktop/Mobile Composer Surface matching modern Hermes aesthetic */}
      <div className="rounded-[22px] sm:rounded-[26px] bg-[var(--app-card,#121721)] border border-white/[0.1] px-3.5 sm:px-4 pt-2.5 pb-2 shadow-2xl shrink-0 transition-all focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/20 mb-1">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              if ((e.nativeEvent as unknown as { isComposing?: boolean })?.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={t('askHermes') || 'Message Hermes or paste instructions...'}
          aria-label={t('askHermes') || 'Message Hermes'}
          aria-describedby="composer-hint"
          className="w-full bg-transparent px-1 py-1 text-[13.5px] sm:text-sm text-slate-100 placeholder-slate-400 focus:outline-none resize-none leading-relaxed font-sans min-h-[32px] max-h-[160px]"
        />
        <p id="composer-hint" className="sr-only">
          Enter sends, Shift plus Enter adds a new line.
        </p>

        {/* Action Toolbar Row: wraps on narrow screens so mic/send never scroll off-canvas */}
        <div className="flex items-center justify-between flex-wrap pt-1.5 gap-1.5 sm:gap-2 border-t border-white/[0.04]">
          {/* Left Action Buttons: Circular + Button, Model Pill, Reasoning Pill */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap py-0.5">
            {/* Circular (+) Attachment Button */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageAttach}
              accept="image/*,.txt,.md,.markdown,.csv,.json"
              multiple
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-7.5 h-7.5 min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-slate-300 hover:text-white bg-[var(--app-card-subtle,#1A2230)] hover:bg-[var(--app-card-subtle,#232D3F)] active:scale-95 transition-all border border-white/[0.08] cursor-pointer shrink-0 shadow-xs"
              title="Attach image or text file (.txt/.md/.csv/.json)"
              aria-label="Attach image or text file (.txt/.md/.csv/.json)"
            >
              <Plus className="w-4 h-4 stroke-[2.2]" />
            </button>

            {/* Model pill: tap name to expand, chevron opens sheet */}
            <div
              className={`min-h-[44px] px-2.5 sm:px-3 rounded-full flex items-center gap-1.5 text-xs text-slate-200 bg-[var(--app-card-subtle,#1A2230)] border border-white/[0.08] shadow-xs min-w-0 ${
                modelPillExpanded ? 'max-w-full' : 'max-w-[130px] sm:max-w-[200px]'
              }`}
            >
              <button
                type="button"
                onClick={() => setModelPillExpanded((v) => !v)}
                aria-expanded={modelPillExpanded}
                title={settings.modelId || 'Select Model'}
                aria-label={`Active model: ${settings.modelId || 'none'}. Tap to ${modelPillExpanded ? 'collapse' : 'expand'}.`}
                className="font-mono text-[11.5px] truncate min-w-0 flex-1 text-start cursor-pointer hover:text-white min-h-[44px] flex items-center"
              >
                {settings.modelId ? curModelName : t('noModel')}
              </button>
              <button
                type="button"
                onClick={() => setShowModelsSheet(true)}
                title="Select model"
                aria-label="Select model"
                className="shrink-0 cursor-pointer hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
              >
                <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
              </button>
            </div>

            {/* Reasoning effort direct-select segmented control */}
            <div
              role="group"
              aria-label="Reasoning effort"
              className="flex items-center gap-0.5 p-0.5 rounded-full bg-sky-950/40 border border-sky-500/30 shrink-0 shadow-xs"
              title="Reasoning effort"
            >
              <Sliders className="w-3 h-3 text-sky-400 shrink-0 ms-1.5" />
              {(['none', 'low', 'medium', 'high'] as const).map((level) => {
                const active = (settings.reasoningEffort || 'medium') === level;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => updateSettings({ reasoningEffort: level })}
                    aria-pressed={active}
                    title={`Reasoning effort: ${level}`}
                    className={`px-2.5 min-w-[44px] min-h-[44px] py-1 rounded-full font-mono font-medium text-[10px] uppercase tracking-wider transition cursor-pointer flex items-center justify-center ${
                      active ? 'bg-sky-500/30 text-sky-100' : 'text-sky-400/70 hover:text-sky-200'
                    }`}
                  >
                    {level === 'none' ? 'Off' : level === 'medium' ? 'Med' : level[0].toUpperCase() + level.slice(1)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Action Buttons: Circular Cyan Mic & Send Button */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Voice Dictation (Cyan Mic) */}
            <button
              type="button"
              onClick={toggleVoice}
              className={`min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center transition-all cursor-pointer border border-white/[0.08] shadow-xs ${
                isListening
                  ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 animate-pulse'
                  : 'bg-[var(--app-card-subtle,#1A2230)] hover:bg-[var(--app-card-subtle,#232D3F)] text-sky-400 hover:text-sky-300'
              }`}
              title={isListening ? 'Listening...' : 'Voice Dictation'}
              aria-label={isListening ? 'Stop voice dictation' : 'Start voice dictation'}
              aria-pressed={isListening}
            >
              {isListening ? (
                <Mic className="w-3.5 h-3.5 text-rose-400" />
              ) : (
                <Mic className="w-3.5 h-3.5 text-sky-400" />
              )}
            </button>

            {/* Send / Stop Generation Button */}
            {streaming ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] text-teal-300 font-mono flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-teal-500/10 border border-teal-500/20">
                  <Clock className="w-2.5 h-2.5 animate-spin" />
                  <span>{String(streamElapsed).padStart(2, '0')}s</span>
                </span>
                <button
                  type="button"
                  onClick={handleSendNow}
                  disabled={!canSendNow}
                  aria-label="Send now (stop and send)"
                  title={!settings.modelId ? 'Select a model first' : 'Stop and send now'}
                  className="px-2 min-h-[44px] py-1 rounded-full text-[11px] font-medium bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 disabled:opacity-40 cursor-pointer"
                >
                  Send
                </button>
                <button
                  type="button"
                  onClick={stopStream}
                  className="min-w-[44px] min-h-[44px] rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center transition cursor-pointer shrink-0 shadow-md"
                  title="Stop generation"
                  aria-label="Stop generation"
                >
                  <Square className="w-3 h-3 fill-white" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSendNow}
                title={!settings.modelId ? (t('noModel') || 'Select a model first') : 'Send Message'}
                aria-label={!settings.modelId ? (t('noModel') || 'Select a model first') : 'Send Message'}
                aria-disabled={!canSendNow}
                className={`min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 shadow-xs border ${
                  canSendNow
                    ? 'bg-white hover:bg-slate-100 text-slate-900 border-white shadow-md active:scale-95'
                    : 'bg-[var(--app-card-subtle,#1A2230)] text-slate-500 border-white/[0.08] opacity-50 cursor-not-allowed'
                }`}
              >
                {/* Slanted Arrow-Paperplane style icon matching user screenshot */}
                <svg
                  className="w-3.5 h-3.5 fill-current transform rotate-45 -translate-y-0.5 -translate-x-0.5"
                  viewBox="0 0 24 24"
                >
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Model Selection Sheet Modal - Exact Hermes Design */}
      {showModelsSheet && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('selectModel') || 'Available Hermes Models'}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowModelsSheet(false);
          }}
        >
          <div className="w-full sm:max-w-lg bg-[var(--app-bg,#0B0F15)] border border-white/[0.09] rounded-t-[28px] sm:rounded-3xl p-4 sm:p-5 shadow-2xl flex flex-col max-h-[85vh] sm:max-h-[80vh] animate-in slide-in-from-bottom-4 duration-200">
            {/* Top Pull Bar / Handle */}
            <div className="w-10 h-1 bg-slate-500/50 rounded-full mx-auto mb-3 shrink-0 sm:hidden" />

            {/* Header: Title + Count & Close button */}
            <div className="flex items-start justify-between pb-3 shrink-0">
              <div>
                <h2 className="text-[#38BDF8] text-[17px] font-mono font-medium tracking-tight">
                  {t('selectModel') || 'Available Hermes Models'}
                </h2>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  {filteredModels.length} / {models.length} models
                </p>
              </div>
              <button
                onClick={() => setShowModelsSheet(false)}
                className="w-7 h-7 min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                title={t('cancel')}
                aria-label={t('cancel') || 'Close model selection'}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search Input Bar */}
            <div className="relative flex items-center px-3.5 py-2.5 rounded-xl bg-[var(--app-card-subtle,#141A23)] border border-white/[0.08] focus-within:border-cyan-500/50 transition shrink-0 mb-3">
              <Search className="w-4 h-4 text-slate-400 me-2.5 shrink-0" />
              <input
                ref={sheetSearchRef}
                type="text"
                value={modelSearchQuery}
                onChange={(e) => setModelSearchQuery(e.target.value)}
                placeholder={t('searchModels') || 'Search models...'}
                aria-label={t('searchModels') || 'Search models'}
                className="flex-1 bg-transparent text-xs sm:text-sm text-slate-200 placeholder-slate-500 focus:outline-none font-mono"
              />
              {modelSearchQuery && (
                <button
                  onClick={() => setModelSearchQuery('')}
                  aria-label="Clear model search"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Filter Pills Bar (Horizontal scroll) */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-2 mb-2 shrink-0 no-scrollbar">
              {providerFilterOptions.map((opt) => {
                const isActive = modelFilterProvider === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setModelFilterProvider(opt.id)}
                    aria-pressed={isActive}
                    className={`px-3 min-h-[44px] py-1 rounded-lg text-xs font-mono transition cursor-pointer shrink-0 border whitespace-nowrap ${
                      isActive
                        ? 'bg-[var(--app-card-subtle,#0E2938)] text-cyan-400 border-cyan-500/60 font-semibold shadow-xs'
                        : 'bg-[var(--app-card-subtle,#131924)] text-slate-400 border-white/[0.08] hover:text-slate-200 hover:bg-[var(--app-card-subtle,#1A2230)] font-normal'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* Models Cards List */}
            <div className="flex-1 overflow-y-auto space-y-2 pe-1 min-h-0">
              {filteredModels.length === 0 ? (
                <div className="text-center py-10 text-slate-500 text-xs font-mono">
                  {modelSearchQuery
                    ? `${t('noModelsMatch')} "${modelSearchQuery}"`
                    : t('noModelsProvider')}
                </div>
              ) : (
                filteredModels.map((m) => {
                  const isSelected = settings.modelId === m.id;
                  const badgeLabel = getProviderBadgeLabel(m.provider);

                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        const providerDiffers =
                          !!m.provider && normProvider(m.provider) !== normProvider(settings.provider);
                        const matchingProv = providerDiffers
                          ? configuredProviders.find(
                              (p) => normProvider(p.provider) === normProvider(m.provider!)
                            )
                          : undefined;
                        // Single settings write: merge model + provider together
                        updateSettings(
                          providerDiffers && !matchingProv
                            ? { modelId: m.id, provider: m.provider }
                            : { modelId: m.id }
                        );
                        if (matchingProv) {
                          (activateProvider as (id: string, keepModelId?: string) => void)(matchingProv.id, m.id);
                        }
                        setShowModelsSheet(false);
                      }}
                      className={`w-full flex flex-col p-3 sm:p-3.5 rounded-2xl border text-start transition cursor-pointer group shadow-xs ${
                        isSelected
                          ? 'bg-[var(--app-card-subtle,#122232)] border-cyan-500/70 text-white'
                          : 'bg-[var(--app-card-subtle,#131924)] border-white/[0.06] hover:border-cyan-500/40 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-white text-[13.5px] sm:text-[14px] tracking-tight group-hover:text-cyan-300 transition-colors truncate">
                            {m.displayName}
                          </span>
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-mono border border-cyan-500/30 bg-cyan-950/40 text-cyan-400 font-medium shrink-0">
                            {badgeLabel}
                          </span>
                        </div>
                        {isSelected && (
                          <div className="flex items-center gap-1 text-cyan-400 text-xs font-mono shrink-0">
                            <Check className="w-4 h-4 stroke-[2.5]" />
                          </div>
                        )}
                      </div>
                      <p className="text-xs font-mono text-slate-400 mt-1 truncate">
                        {m.id}
                      </p>
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer with Manage Settings link */}
            <div className="pt-3 mt-2 border-t border-white/[0.06] flex items-center justify-between text-xs text-slate-400 shrink-0">
              <span className="font-mono text-[11px] text-slate-500">
                Active: <span className="text-slate-300">{settings.modelId.split('/').pop()}</span>
              </span>
              <button
                onClick={() => {
                  setShowModelsSheet(false);
                  onGoSettings();
                }}
                className="min-h-[44px] px-2 text-cyan-400 hover:text-cyan-300 font-medium cursor-pointer transition flex items-center"
              >
                + Manage Providers in Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface ThinkingAccordionProps {
  thinking: string;
  isDone: boolean;
  fontScale: number;
}

const ThinkingAccordion: React.FC<ThinkingAccordionProps> = ({ thinking, isDone, fontScale }) => {
  const [expanded, setExpanded] = useState(!isDone);

  // Follow the live state: expand while reasoning, auto-collapse when done.
  useEffect(() => {
    setExpanded(!isDone);
  }, [isDone]);

  return (
    <div className="mb-3 rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`Reasoning process, ${isDone ? 'finished' : 'in progress'}. Tap to ${expanded ? 'collapse' : 'expand'}.`}
        className="w-full flex items-center justify-between px-3 min-h-[44px] py-2 text-xs text-slate-400 hover:text-white cursor-pointer transition"
      >
        <div className="flex items-center gap-2">
          <span className={isDone ? 'text-emerald-400' : 'text-indigo-400 animate-spin'}>
            {isDone ? '✓' : '◐'}
          </span>
          <span className="font-medium text-slate-200">Reasoning Process</span>
          <span className="text-[11px] text-slate-400">({isDone ? 'finished' : 'reasoning…'})</span>
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {expanded && (
        <div
          className="p-3 font-mono text-xs text-slate-400 border-t border-white/[0.06] whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto bg-black/20"
          style={{ fontSize: `${fontScale * 12}px` }}
        >
          {thinking}
        </div>
      )}
    </div>
  );
};
