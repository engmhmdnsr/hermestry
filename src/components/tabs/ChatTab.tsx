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
  AlertTriangle,
  WifiOff,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { ChatMessage, PendingApproval } from '../../types/hermes';
import { PROVIDER_OPTIONS, normProvider } from '../../constants/providers';
import { getTranslation, speechLocaleForLanguage } from '../../constants/languages';
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
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';

// Reasoning effort levels, in the order the sheet renders them.
const EFFORT_LEVELS = ['none', 'low', 'medium', 'high'] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

interface ChatTabProps {
  onGoSettings: () => void;
  isDesktop?: boolean;
}

interface MessageRowProps {
  msg: ChatMessage;
  isLiveTail: boolean;
  modelLabel: string | null;
  durationLabel: string | null;
  formulatingLabel: string;
  copied: boolean;
  speaking: boolean;
  menuOpen: boolean;
  streamBusy: boolean;
  stopped: boolean;
  stoppedLabel: string;
  stoppedHint: string;
  estimated: boolean;
  estimatedHint: string;
  copyUnavailableLabel: string;
  regenerateSource: string;
  regenerateLabel: string;
  regenerateBusyHint: string;
  menuContainerRef?: React.RefObject<HTMLDivElement | null>;
  onCopy: (id: string, content: string) => void;
  onSpeak: (id: string, content: string) => void;
  onRegenerate: (content: string) => void;
  onFork: () => void;
  onToggleMenu: (id: string | null) => void;
  t: (key: string) => string;
}

type StreamFailureKind = 'auth' | 'quota' | 'model' | 'rate' | 'offline' | 'server' | 'unknown';

interface StreamFailureInfo {
  kind: StreamFailureKind;
  status: number | null;
  detail: string;
}

// Failure text arrives as free form gateway text ('Stream failed: HTTP 404',
// sometimes already prefixed with 'Stream error:'). Prefixes are collapsed so
// the banner shows exactly one, and the kind drives the friendly copy plus a
// real next step. The raw detail stays available behind a details toggle.
const STREAM_ERROR_PREFIX = /^(?:stream\s*error|stream\s*failed|request\s*failed)\s*:?\s*/i;

const classifyStreamFailure = (raw: string): StreamFailureInfo => {
  let detail = (raw || '').trim();
  let prev = '';
  while (prev !== detail && STREAM_ERROR_PREFIX.test(detail)) {
    prev = detail;
    detail = detail.replace(STREAM_ERROR_PREFIX, '').trim();
  }
  const match = /(?:http\s*)?\b([1-5]\d{2})\b/i.exec(detail);
  const status = match ? Number(match[1]) : null;
  const low = detail.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /unauthor|forbidden|invalid api key|authentication|api key/.test(low)
  ) {
    return { kind: 'auth', status, detail };
  }
  if (status === 402 || /quota|billing|insufficient|credit/.test(low)) {
    return { kind: 'quota', status, detail };
  }
  if (status === 404 || /not found|unknown model|no such model/.test(low)) {
    return { kind: 'model', status, detail };
  }
  if (status === 408 || status === 429 || /rate limit|too many requests|timed? ?out/.test(low)) {
    return { kind: 'rate', status, detail };
  }
  if (/failed to fetch|network|econnrefused|unreachable|socket|disconnected|connection/.test(low)) {
    return { kind: 'offline', status, detail };
  }
  if (status !== null && status >= 500) return { kind: 'server', status, detail };
  return { kind: 'unknown', status, detail };
};

// Honest durations: sub second turns read '<1s' instead of '0.0s', and long
// turns stop printing a tenth of a second nobody can use.
const formatDurationMs = (ms: number, underOneSecondLabel: string): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return underOneSecondLabel;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
};

// Memoized so 50ms batched streaming flushes only re-render the live tail
// row instead of every bubble on every token.
const MessageRow: React.FC<MessageRowProps> = memo(
  ({
    msg,
    isLiveTail,
    modelLabel,
    durationLabel,
    formulatingLabel,
    copied,
    speaking,
    menuOpen,
    streamBusy,
    stopped,
    stoppedLabel,
    stoppedHint,
    estimated,
    estimatedHint,
    copyUnavailableLabel,
    regenerateSource,
    regenerateLabel,
    regenerateBusyHint,
    menuContainerRef,
    onCopy,
    onSpeak,
    onRegenerate,
    onFork,
    onToggleMenu,
    t,
  }) => {
  // English fallback for keys the locale bundle does not ship yet, so a
  // message action never renders a raw key name.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
    const isUser = msg.sender === 'you';
    // Actions are revealed on tap (or Enter when the row has focus) instead of
    // adding a full action band under every bubble on a phone screen.
    const [actionsOpen, setActionsOpen] = useState(false);
    const showActions = actionsOpen || menuOpen;
    const handleBubbleClick = (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      // Never steal a tap meant for a control, a menu, or a text selection.
      if (target.closest('button, a, input, textarea, summary, [role="menu"]')) return;
      if ((window.getSelection?.()?.toString() || '').length > 0) return;
      setActionsOpen((v) => !v);
    };

    const handleBubbleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setActionsOpen((v) => !v);
        return;
      }
      if (event.key === 'Escape' && actionsOpen) {
        setActionsOpen(false);
      }
    };

    return (
      <div
        className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
        tabIndex={0}
        role="group"
        aria-label={`${isUser ? tx('yourMessage', 'Your message') : tx('hermesResponse', 'Reply from Hermes')}. ${
          showActions
            ? tx('messageActionsShown', 'Actions shown. Press Escape to hide them.')
            : tx('messageActionsHint', 'Press Enter for message actions.')
        }`}
        onClick={handleBubbleClick}
        onKeyDown={handleBubbleKeyDown}
      >
        {/* Bubble Container: user turns size to their content, replies stay full width */}
        <div
          role="article"
          aria-label={isUser ? tx('yourMessage', 'Your message') : tx('hermesResponse', 'Reply from Hermes')}
          className={`r-md t-body p-4 transition-all ${
            isUser
              ? 'w-fit max-w-[80%] bg-[var(--app-accent)] text-[var(--app-on-accent)]'
              : 'w-full max-w-[94%] sm:max-w-[88%] bg-[var(--app-card)] edge text-[var(--app-text)]'
          }`}
          style={{
            fontSize: 'var(--msg-font-size)',
            lineHeight: 1.5,
          }}
        >
          {/* Unboxed metadata row: no rule brackets the bubble any more, so a
              one word message reads as a message instead of a truncated table. */}
          <div className="flex items-center justify-between gap-3 mb-3">
            <span
              className={`t-micro font-semibold tracking-tight ${
                isUser ? 'text-[var(--app-on-accent)]' : 'text-[var(--app-text)]'
              }`}
            >
              {isUser ? tx('you', 'You') : tx('hermes', 'Hermes')}
            </span>

            {!isUser && (stopped || modelLabel || durationLabel) && (
              <div className="flex items-center gap-2">
                {stopped && (
                  <span className="pill-warning t-micro font-mono" title={stoppedHint}>
                    {stoppedLabel}
                  </span>
                )}
                {(modelLabel || durationLabel) && (
                  <span
                    className="pill-neutral t-micro font-mono"
                    title={estimated ? estimatedHint : undefined}
                  >
                    {modelLabel}
                    {durationLabel && ` · ${durationLabel}`}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Thinking Block */}
          {msg.thinking && (
            <ThinkingAccordion thinking={msg.thinking} isDone={msg.thinkingDone !== false} />
          )}

          {/* Tool Invocations */}
          {msg.tools && msg.tools.length > 0 && (
            <div className="mb-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                {msg.tools.map((toolName, idx) => (
                  <span
                    key={idx}
                    className="pill-neutral t-micro font-mono inline-flex items-center gap-2"
                  >
                    <span className="w-2 h-2 rounded-full bg-[var(--app-accent)]" />
                    <span>{toolName}</span>
                  </span>
                ))}
              </div>

              {msg.toolOutputs && msg.toolOutputs.length > 0 && (
                <div className="r-sm edge bg-[var(--app-bg)] p-3 t-caption font-mono text-[var(--app-text-muted)] space-y-2">
                  {msg.toolOutputs.map((out, i) => (
                    <div key={i} className="leading-relaxed break-all whitespace-pre-wrap">
                      <span className="text-[var(--app-info)] font-medium">{out.toolName}:</span>{' '}
                      <span>{out.output}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Message Body */}
          {msg.content ? (
            <div className="t-body max-w-none whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text font-sans">
              {msg.content}
              {isLiveTail && !isUser && (
                <span className="inline-block w-1.5 h-4 ms-1 bg-[var(--app-accent)] animate-pulse align-middle" />
              )}
            </div>
          ) : isLiveTail ? (
            <div className="flex items-center gap-2 t-caption text-[var(--app-text-muted)] py-1">
              <span className="w-2 h-2 rounded-full bg-[var(--app-accent)] animate-ping" />
              <span>{formulatingLabel}</span>
            </div>
          ) : null}

          {/* Message actions: revealed on tap and separated from the text by
              spacing only (no rule under the bubble). Regenerate belongs to
              assistant turns and resends the prompt that produced them; user
              turns keep copy and the overflow menu. */}
          {showActions && (
          <div className="relative flex items-center justify-end gap-2 mt-3">
            <button
              onClick={() => onCopy(msg.id, msg.content)}
              disabled={!msg.content.trim()}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title={msg.content.trim() ? t('copy') : copyUnavailableLabel}
              aria-label={msg.content.trim() ? t('copy') : copyUnavailableLabel}
            >
              {copied ? (
                <Check className="w-4 h-4 text-[var(--app-success)]" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
            {!isUser && (
              <button
                onClick={() => onRegenerate(regenerateSource)}
                disabled={streamBusy || !regenerateSource}
                aria-label={streamBusy ? regenerateBusyHint : regenerateLabel}
                title={streamBusy ? regenerateBusyHint : regenerateLabel}
                className="hm-hit r-xs min-h-[36px] px-3 flex items-center gap-2 t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw className="w-4 h-4" />
                <span>{regenerateLabel}</span>
              </button>
            )}
            <button
              onClick={() => onToggleMenu(menuOpen ? null : msg.id)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer"
              title={tx('moreActions', 'More actions')}
              aria-label={tx('moreMessageActions', 'More message actions')}
              aria-expanded={menuOpen}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div
                ref={menuOpen ? menuContainerRef : undefined}
                role="menu"
                className="absolute bottom-full end-0 mb-2 min-w-[160px] r-sm elev-2 edge bg-[var(--app-card-subtle)] py-1 z-20"
              >
                {isUser && (
                  <button
                    onClick={() => {
                      onFork();
                      onToggleMenu(null);
                    }}
                    role="menuitem"
                    className="w-full min-h-[44px] px-4 py-2 flex items-center gap-2 text-start t-caption text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition cursor-pointer"
                  >
                    <GitFork className="w-4 h-4" />
                    <span>{tx('duplicateChat', 'Duplicate chat')}</span>
                  </button>
                )}
                <button
                  onClick={() => {
                    onSpeak(msg.id, msg.content);
                    onToggleMenu(null);
                  }}
                  role="menuitem"
                  className="w-full min-h-[44px] px-4 py-2 flex items-center gap-2 text-start t-caption text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition cursor-pointer"
                  title={speaking ? tx('stopReading', 'Stop reading out loud') : tx('readAloud', 'Read aloud')}
                >
                  {speaking ? (
                    <>
                      <VolumeX className="w-4 h-4 text-[var(--app-danger)]" />
                      <span className="text-[var(--app-danger)] font-medium">{t('stopShort')}</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-4 h-4" />
                      <span>{tx('readAloud', 'Read aloud')}</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
          )}
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
    streamError,
    gatewayFailed,
    gatewayFailureReason,
    refreshNow,
    t,
  } = useHermes();

  // i18n with an English fallback for keys the locale bundle does not ship
  // yet. t() returns the key itself when no locale has it, so the fallback
  // stays honest instead of rendering a raw key name.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

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
  const [showEffortSheet, setShowEffortSheet] = useState(false);
  const [confirmSessionRunId, setConfirmSessionRunId] = useState<string | null>(null);
  const [streamErrorDismissed, setStreamErrorDismissed] = useState<string | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  // Approvals: the count is always visible, the queue body is deliberately
  // opened, and gateway-side failures are shown on the card they belong to.
  const [approvalsExpanded, setApprovalsExpanded] = useState(true);
  const [approvalFailures, setApprovalFailures] = useState<Record<string, string>>({});

  // One polite announcement channel for events a screen reader must hear once
  // (stream start/stop, queue changes) instead of per render.
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  // On-screen keyboard inset, measured from the visual viewport. The app is
  // edge-to-edge on Android 15+, so the composer would otherwise sit behind the
  // keyboard. See the effect below for the resize assumption.
  const [keyboardInset, setKeyboardInset] = useState(0);

  // Optional context surface (lands with the context owner's stream-error
  // work): the live failure banner below activates when present, and stays
  // hidden otherwise. Never touch HermesContext.tsx from this file.
  const liveStreamError = streamError ?? null;
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
  // Latest turn metadata for the stop announcement. Kept in a ref so the
  // announcement effect depends on the streaming transition alone.
  const turnMetaRef = useRef(turnMeta);
  turnMetaRef.current = turnMeta;
  const prevStreamingRef = useRef(streaming);
  const prevQueuedCountRef = useRef(queuedMessages.length);
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
      ? 'bg-[var(--app-danger-solid)] text-[var(--app-on-danger)]'
      : toastKind === 'success'
        ? 'bg-[var(--app-success-solid)] text-[var(--app-on-success)]'
        : 'bg-[var(--app-card-subtle)] edge text-[var(--app-text)]';

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

    opts.push({ id: 'ALL', label: tx('filterAllProviders', 'All') });
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
  // Latest pending approvals, so an async resolve can tell whether the gateway
  // actually confirmed the decision (the card only stays when it did not).
  const approvalsRef = useRef<PendingApproval[]>(approvals);
  approvalsRef.current = approvals;
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
  // Approval failures are injected by the context as assistant style bubbles.
  // They belong on the approval card, so they are pulled out of the transcript
  // here and rendered next to the card that is still pending.
  const isApprovalFailure = (m: ChatMessage) =>
    m.sender === 'hermes' && /^approval (grant|deny) failed:/i.test(m.content.trim());
  const bubbleMessages = useMemo(
    () => visibleMessages.filter((m) => !isStreamError(m) && !isApprovalFailure(m)),
    [visibleMessages]
  );
  const errorMessages = useMemo(() => visibleMessages.filter(isStreamError), [visibleMessages]);
  const approvalFailureBubbles = useMemo(
    () => visibleMessages.filter(isApprovalFailure),
    [visibleMessages]
  );
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

  // The send button stays tappable even when it cannot send: every tap runs a
  // guard that says why and offers the fix, so the control never sits dead.
  const gatewayOffline = !connected || gatewayFailed;
  const sendHint = !settings.modelId
    ? tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.')
    : !hasComposerContent
      ? tx('sendNeedsText', 'Type a message first, then send.')
      : tx('sendMessage', 'Send message');
  const sendNowHint = !settings.modelId
    ? tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.')
    : !hasComposerContent
      ? tx('sendNeedsText', 'Type a message first, then send.')
      : tx('stopAndSend', 'Stop this turn and send now');

  // Friendly copy plus a real next step per failure kind. One prefix is shown
  // once, and the action maps to a screen the user can actually fix things in.
  const describeFailure = (
    info: StreamFailureInfo
  ): { title: string; message: string; actions: Array<{ label: string; onClick: () => void; primary?: boolean }> } => {
    const title = tx('replyFailedTitle', 'Reply failed');
    const startNewChat = () => {
      void newSession().catch(() =>
        showActionToast(tx('newChatFailed', 'Could not start a new chat. Check the connection to the Hermes server.'), 'error')
      );
    };
    switch (info.kind) {
      case 'auth':
        return {
          title,
          message: tx(
            'errAuthMessage',
            'The provider rejected the request. Check the API key and provider profile, then retry.'
          ),
          actions: [{ label: tx('openProviderSettings', 'Open provider settings'), onClick: onGoSettings, primary: true }],
        };
      case 'quota':
        return {
          title,
          message: tx(
            'errQuotaMessage',
            'The provider refused the request for billing or quota reasons. Check the provider account, then retry.'
          ),
          actions: [{ label: tx('openProviderSettings', 'Open provider settings'), onClick: onGoSettings, primary: true }],
        };
      case 'model':
        return {
          title,
          message: tx(
            'errModelMessage',
            'The selected model or endpoint was not found. Pick another model, or adjust the provider profile.'
          ),
          actions: [
            models.length > 0
              ? {
                  label: tx('chooseAnotherModel', 'Choose another model'),
                  onClick: () => setShowModelsSheet(true),
                  primary: true,
                }
              : { label: tx('openProviderSettings', 'Open provider settings'), onClick: onGoSettings, primary: true },
            { label: tx('startNewChat', 'Start a new chat'), onClick: startNewChat },
          ],
        };
      case 'rate':
        return {
          title,
          message: tx('errRateMessage', 'The provider is rate limiting or the request timed out. Wait a moment, then retry.'),
          actions: [],
        };
      case 'offline':
        return {
          title,
          message: tx('errOfflineMessagePlain', 'The app could not reach the Hermes server. Start or restart it, then retry.'),
          actions: [{ label: tx('openConnectionSettings', 'Open connection settings'), onClick: onGoSettings, primary: true }],
        };
      case 'server':
        return {
          title,
          message: tx('errServerMessagePlain', 'The Hermes server or the provider returned an error. Retry, and check the connection if it repeats.'),
          actions: [{ label: tx('startNewChat', 'Start a new chat'), onClick: startNewChat }],
        };
      default:
        return {
          title,
          message: tx('errUnknownMessage', 'The turn ended before the model finished. Retry, or start a new chat.'),
          actions: [{ label: tx('startNewChat', 'Start a new chat'), onClick: startNewChat }],
        };
    }
  };

  // One renderer for both the live banner and legacy persisted error bubbles,
  // so neither shows a doubled prefix or a bare transport string.
  const renderFailureCard = (raw: string, onDismiss: () => void, key: string) => {
    const failure = classifyStreamFailure(raw);
    const described = describeFailure(failure);
    return (
      <div
        key={key}
        role="alert"
        className="mb-2 px-4 py-3 r-md t-caption bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)]"
      >
        <p className="text-[var(--app-danger)] break-words leading-relaxed">
          <span className="font-semibold">{described.title}: </span>
          {described.message}
        </p>
        <details className="mt-2">
          <summary className="t-caption text-[var(--app-danger)] cursor-pointer">
            {tx('showErrorDetail', 'Show details')}
          </summary>
          <p className="mt-1 font-mono t-caption text-[var(--app-danger)] break-all">
            {failure.detail || raw}
          </p>
        </details>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {described.actions.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              className={`hm-hit r-xs min-h-[36px] px-4 t-caption font-semibold cursor-pointer ${
                action.primary
                  ? 'bg-[var(--app-danger-solid)] hover:brightness-110 text-[var(--app-on-danger)]'
                  : 'bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] text-[var(--app-text)] edge'
              }`}
            >
              {action.label}
            </button>
          ))}
          <button
            onClick={() => {
              if (streaming) {
                showActionToast(tx('stillGenerating', 'Still generating, wait or stop first'), 'info');
                return;
              }
              if (!retryLast()) showActionToast(tx('nothingToRetry', 'Nothing to retry yet'), 'info');
            }}
            disabled={streaming}
            className="hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-danger-solid)] hover:brightness-110 text-[var(--app-on-danger)] t-caption font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {tx('retry', 'Retry')}
          </button>
          <button
            onClick={onDismiss}
            className="hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] text-[var(--app-text)] t-caption cursor-pointer edge"
          >
            {tx('dismiss', 'Dismiss')}
          </button>
        </div>
      </div>
    );
  };

  // Attachment refs are persisted for history exactly once per send; blobs stay
  // registered so the refs keep resolving (revoked only on remove).
  const persistAttachmentRefs = () => {
    if (currentSessionId && pendingRefsRef.current.length > 0) {
      appendAttachmentRefs(currentSessionId, pendingRefsRef.current);
      pendingRefsRef.current = [];
    }
  };

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
  // origin 'keyboard' keeps an empty Enter press silent; a send button tap
  // always explains itself instead of sitting dead.
  const handleSend = (origin: 'button' | 'keyboard' = 'button') => {
    if (attaching) {
      showActionToast(tx('attachmentsBusy', 'Still preparing attachments. Try again in a moment.'), 'info');
      return;
    }
    const raw = textRef.current;
    const trimmed = raw.trim();
    const payloads = attachedRef.current.map((a) => a.dataUrl);
    if (!trimmed && payloads.length === 0) {
      if (origin === 'button') showActionToast(tx('sendNeedsText', 'Type a message first, then send.'), 'info');
      return;
    }
    if (!settings.modelId) {
      showActionToast(tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.'), 'error');
      setShowModelsSheet(true);
      return;
    }
    if (gatewayOffline) {
      // Offline: hold it in the visible queue instead of posting into a stream
      // that cannot succeed and then reporting a raw transport error.
      if (!queueMessage(trimmed, payloads)) {
        showActionToast(tx('queueFailed', 'Could not queue message'), 'error');
        return;
      }
      showActionToast(
        tx(
          'queuedOfflinePlain',
          'Not connected. Kept for later: it sends automatically when the connection is back, or send it from the queue bar.'
        ),
        'info'
      );
      persistAttachmentRefs();
      clearComposer();
      setStickToBottom(true);
      return;
    }
    const ok = streaming ? queueMessage(trimmed, payloads) : sendMessage(trimmed, payloads);
    if (!ok) {
      showActionToast(
        streaming ? tx('queueFailed', 'Could not queue message') : tx('sendFailedDraftKept', 'Send failed, draft kept'),
        'error'
      );
      return;
    }
    if (streaming) showActionToast(tx('queuedNextTurn', 'Queued for next turn'), 'info');
    persistAttachmentRefs();
    clearComposer();
    setStickToBottom(true);
  };

  // Streaming "Send now": stop-then-send via sendNow with the same guards
  // and failure-safe clear as the unified path.
  const handleSendNow = () => {
    if (attaching) {
      showActionToast(tx('attachmentsBusy', 'Still preparing attachments. Try again in a moment.'), 'info');
      return;
    }
    const raw = textRef.current;
    const trimmed = raw.trim();
    const payloads = attachedRef.current.map((a) => a.dataUrl);
    if (!trimmed && payloads.length === 0) {
      showActionToast(tx('sendNeedsText', 'Type a message first, then send.'), 'info');
      return;
    }
    if (!settings.modelId) {
      showActionToast(tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.'), 'error');
      setShowModelsSheet(true);
      return;
    }
    const result = sendNow(trimmed, payloads);
    if (!result) {
      showActionToast(tx('sendFailedDraftKept', 'Send failed, draft kept'), 'error');
      return;
    }
    if (result === 'queued') showActionToast(tx('queuedNextTurn', 'Queued for next turn'), 'info');
    persistAttachmentRefs();
    clearComposer();
    setStickToBottom(true);
  };

  // Send the oldest queued message immediately, leaving the rest queued in
  // order. Used by the queue bar so pending items are never a dead end.
  const sendFirstQueued = () => {
    const first = queuedMessages[0];
    if (!first) return;
    if (streaming) {
      showActionToast(tx('stillGenerating', 'Still generating, wait or stop first'), 'info');
      return;
    }
    if (gatewayOffline) {
      showActionToast(
        tx('offlineCannotSendNowPlain', 'Not connected. Waiting messages send automatically once the connection is back.'),
        'info'
      );
      return;
    }
    const rest = queuedMessages.slice(1);
    cancelQueued();
    rest.forEach((m) => queueMessage(m.text, m.images));
    if (!sendMessage(first.text, first.images)) {
      queueMessage(first.text, first.images);
      showActionToast(tx('sendFailedDraftKept', 'Send failed, draft kept'), 'error');
    } else {
      setStickToBottom(true);
    }
  };

  const handleResolveApproval = async (
    approval: PendingApproval,
    allow: boolean,
    scope?: 'once' | 'session'
  ) => {
    // Session-allow is broad: require an explicit two-tap confirm.
    if (allow && scope === 'session' && confirmSessionRunId !== approval.runId) {
      setConfirmSessionRunId(approval.runId);
      showActionToast(
        tx('approveSessionConfirm', 'Tap Allow for this chat again to confirm.'),
        'info'
      );
      return;
    }
    setConfirmSessionRunId(null);
    setResolvingRunId(approval.runId);
    try {
      await resolveApproval(approval, allow, scope);
      // A card that is still pending means the gateway did not confirm the
      // decision. Report it on the card itself instead of letting the failure
      // hide in a chat bubble that is not persisted.
      window.setTimeout(() => {
        if (approvalsRef.current.some((a) => a.runId === approval.runId)) {
          setApprovalFailures((prev) => ({
            ...prev,
            [approval.runId]: tx(
              'approvalNotConfirmedPlain',
              'Hermes did not confirm this decision, so it is still waiting. Retry it, and check the connection if it repeats.'
            ),
          }));
        }
      }, 250);
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
          tx('imagesCapReached', '{count} images not added: the limit is {max} per message.')
            .replace('{count}', String(droppedImages.length))
            .replace('{max}', String(MAX_IMAGE_COUNT)),
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
      if (!ctrl.signal.aborted) showActionToast(tx('attachFailed', 'Could not add those files. Nothing was attached.'), 'error');
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
    let spoken = cleanText;
    if (truncated) {
      // Cut at a sentence or word boundary so read-aloud never stops
      // mid-word; fall back to a hard cut only when no boundary exists.
      const window_ = cleanText.slice(0, MAX_SPEECH_CHARS);
      const sentenceEnd = Math.max(
        window_.lastIndexOf('. '),
        window_.lastIndexOf('! '),
        window_.lastIndexOf('? '),
        window_.lastIndexOf('\n')
      );
      const wordEnd = window_.lastIndexOf(' ');
      const cut = sentenceEnd > MAX_SPEECH_CHARS / 2 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : MAX_SPEECH_CHARS;
      spoken = window_.slice(0, cut).trimEnd();
    }
    const utter = new SpeechSynthesisUtterance(spoken);
    const locale = speechLocaleForLanguage(settings.language || 'en');
    utter.lang = locale;
    try {
      const voices = window.speechSynthesis.getVoices?.() || [];
      const match =
        voices.find((v) => v.lang === locale) ||
        voices.find((v) => v.lang?.startsWith(locale.split('-')[0]));
      if (match) utter.voice = match;
    } catch {
      // Voice lookup is best-effort; utter.lang already carries the locale.
    }
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
      return;
    } catch {
      // Fall through to the legacy execCommand path below.
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      // eslint-disable-next-line deprecation/deprecation
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('execCommand copy failed');
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
        showActionToast(tx('stillGenerating', 'Still generating, wait or stop first'), 'info');
        return;
      }
      if (!content.trim()) return;
      const ok = sendMessage(content.trim());
      if (!ok) showActionToast(tx('regenerateFailedPlain', 'Could not write a new reply. Check the connection, then retry.'), 'error');
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

  // Model and effort sheets: Escape and the Android back button close them,
  // Tab focus stays inside, and focus returns to the trigger on close. The
  // sheet roots carry role=dialog / aria-modal.
  const closeModelsSheet = useCallback(() => setShowModelsSheet(false), []);
  const closeEffortSheet = useCallback(() => setShowEffortSheet(false), []);
  const modelsSheetRef = useOverlayBehavior(showModelsSheet, closeModelsSheet);
  const effortSheetRef = useOverlayBehavior(showEffortSheet, closeEffortSheet);

  // Model sheet: focus the search field on pointer/keyboard devices only, so
  // opening the sheet on a phone does not drop the soft keyboard over the list.
  useEffect(() => {
    if (!showModelsSheet) return;
    let finePointer = false;
    try {
      finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch {
      finePointer = false;
    }
    if (finePointer) sheetSearchRef.current?.focus();
  }, [showModelsSheet]);

  // Keyboard awareness. The tab is padded by the measured occlusion instead of
  // trusting the WebView to be resized, so it holds with and without
  // adjustResize in the Android manifest:
  //   innerHeight shrinks (adjustResize) -> occlusion is ~0, no padding added
  //   only the visual viewport shrinks   -> occlusion pads the composer up
  // The 80px floor ignores URL bar and chrome shifts that are not a keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const occlusion = Math.max(
        0,
        Math.round(window.innerHeight - (vv.height + vv.offsetTop))
      );
      const next = occlusion >= 80 ? occlusion : 0;
      setKeyboardInset((prev) => (Math.abs(prev - next) > 2 ? next : prev));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // The keyboard moves the composer, so keep the newest message in view while
  // the user is pinned to the tail.
  useEffect(() => {
    if (!stickToBottom) return;
    const timer = window.setTimeout(() => scrollToBottom(keyboardInset === 0), 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardInset, stickToBottom]);

  // Announce stream start and stop once per transition, never per render.
  useEffect(() => {
    if (streaming === prevStreamingRef.current) return;
    prevStreamingRef.current = streaming;
    if (streaming) {
      setLiveAnnouncement(tx('announceStreamStarted', 'Hermes is responding.'));
      return;
    }
    const lastId = chatLatestRef.current[chatLatestRef.current.length - 1]?.id;
    const stopped = !!lastId && !!turnMetaRef.current[lastId]?.stopped;
    setLiveAnnouncement(
      stopped
        ? tx('announceStreamStopped', 'Response stopped.')
        : tx('announceStreamFinished', 'Hermes finished responding.')
    );
  }, [streaming, tx]);

  // Queue changes go through the same polite region, once per count change.
  useEffect(() => {
    const count = queuedMessages.length;
    if (count === prevQueuedCountRef.current) return;
    prevQueuedCountRef.current = count;
    setLiveAnnouncement(
      count === 0
        ? tx('announceQueueCleared', 'Message queue is empty.')
        : `${count} ${
            count === 1
              ? tx('announceQueueQueued', 'message queued')
              : tx('announceQueueQueuedMany', 'messages queued')
          }`
    );
  }, [queuedMessages.length, tx]);

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
  }, [liveStreamError]);

  // Drop stale approval-failure notices once their card is gone: a confirmed
  // decision removes the runId from approvals, which clears the notice with it.
  useEffect(() => {
    setApprovalFailures((prev) => {
      const ids = new Set(approvals.map((a) => a.runId));
      const kept = Object.entries(prev).filter(([id]) => ids.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [approvals]);

  const curModelName =
    models.find((m) => m.id === settings.modelId)?.displayName ||
    settings.modelId.split('/').pop() ||
    'deepseek-chat';

  // Reasoning effort: one label per level, shared by the compact pill and the
  // sheet so they can never disagree.
  const effortLevel: EffortLevel = (EFFORT_LEVELS as readonly string[]).includes(
    settings.reasoningEffort
  )
    ? (settings.reasoningEffort as EffortLevel)
    : 'medium';
  const effortLabelFor = (level: EffortLevel): string =>
    level === 'none'
      ? tx('effortOff', 'Off')
      : level === 'low'
        ? tx('effortLow', 'Low')
        : level === 'medium'
          ? tx('effortMedium', 'Med')
          : tx('effortHigh', 'High');
  const effortLabel = effortLabelFor(effortLevel);

  const starterChips = [
    tx('starterChip1', 'Search for recent AI agent news'),
    tx('starterChip2', 'Summarize what this phone and its tools can do'),
    tx('starterChip3', 'Set up a check that runs every morning'),
  ];

  // Slash chips are honest about what they do: app actions run locally,
  // messages are sent to the model as your next turn. /retry says so when
  // there is nothing to retry instead of no-oping silently.
  const slashCommands: Array<{
    label: string;
    kind: 'action' | 'message';
    hint: string;
    blockedWhileStreaming?: boolean;
    run: () => void;
  }> = [
    {
      label: '/new',
      kind: 'action',
      hint: tx('slashNewHintPlain', 'App action: starts a new chat. Nothing is sent to the model.'),
      // Switching sessions mid-stream would split the in-flight turn from the
      // session it belongs to, so this one waits for a stop.
      blockedWhileStreaming: true,
      run: () => {
        void newSession().catch(() =>
          showActionToast(tx('newChatFailed', 'Could not start a new chat. Check the connection to the Hermes server.'), 'error')
        );
      },
    },
    {
      label: '/retry',
      kind: 'action',
      hint: tx(
        'slashRetryHint',
        'App action: resends your last message. Nothing is sent when there is nothing to retry.'
      ),
      run: () => {
        if (streaming) {
          showActionToast(tx('stillGenerating', 'Still generating, wait or stop first'), 'info');
          return;
        }
        if (!retryLast()) showActionToast(tx('nothingToRetry', 'Nothing to retry yet'), 'info');
      },
    },
    {
      label: '/find',
      kind: 'action',
      hint: tx('slashFindHintPlain', 'App action: searches this chat. Nothing is sent to the model.'),
      run: () => setSearchOpen(true),
    },
    {
      label: '/help',
      kind: 'message',
      hint: tx('slashMessageHint', 'Message: sends this text to the model as your next message.'),
      run: () => quickSend('/help'),
    },
    {
      label: '/status',
      kind: 'message',
      hint: tx('slashMessageHint', 'Message: sends this text to the model as your next message.'),
      run: () => quickSend('/status'),
    },
  ];

  const visibleSlashCommands = slashCommands.filter((cmd) => {
    if (text === '') return true;
    const token = text.trim().split(/\s+/)[0];
    return cmd.label.startsWith(token || '/');
  });
  const slashActions = visibleSlashCommands.filter((cmd) => cmd.kind === 'action');
  const slashMessages = visibleSlashCommands.filter((cmd) => cmd.kind === 'message');

  // Guarded one-shot send for starters + slash shortcuts (bypasses composer).
  const quickSend = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (!settings.modelId) {
      showActionToast(tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.'), 'error');
      setShowModelsSheet(true);
      return;
    }
    if (gatewayOffline) {
      if (!queueMessage(trimmed, [])) showActionToast(tx('queueFailed', 'Could not queue message'), 'error');
      else showActionToast(tx('queuedOfflinePlain', 'Not connected. Kept for later: send it from the queue bar, or it sends when the connection is back.'), 'info');
      return;
    }
    if (streaming) {
      if (!queueMessage(trimmed, [])) showActionToast(tx('queueFailed', 'Could not queue message'), 'error');
      else showActionToast(tx('queuedNextTurn', 'Queued for next turn'), 'info');
      return;
    }
    if (!sendMessage(trimmed, [])) showActionToast(tx('sendFailedDraftKept', 'Send failed, draft kept'), 'error');
    else setStickToBottom(true);
  };

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 h-full ${
        isDesktop ? 'max-w-4xl mx-auto w-full px-6' : 'px-3 sm:px-4'
      } pt-2`}
      style={keyboardInset > 0 ? { paddingBottom: `calc(${keyboardInset}px + 0.5rem)` } : undefined}
    >
      {/* One polite channel for events a screen reader must hear once: stream
          start/stop and queue changes. It is not inside the message list, so a
          streaming token flush can never re-announce it. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveAnnouncement}
      </div>
      {actionToast && (
        <div
          role={toastKind === 'error' ? 'alert' : 'status'}
          aria-live={toastKind === 'error' ? 'assertive' : 'polite'}
          className={`fixed top-16 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] px-4 py-3 r-sm elev-2 t-caption font-semibold max-w-[90vw] break-words ${toastClass}`}
        >
          {actionToast}
        </div>
      )}
      {/* In-chat Search Input */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-4 py-2 r-sm edge bg-[var(--app-input-bg)] mb-2 shrink-0 animate-in fade-in duration-150">
          <Search className="w-4 h-4 text-[var(--app-text-muted)] shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tx('searchChatPlaceholder', 'Search this chat…')}
            aria-label={tx('searchChatPlaceholder', 'Search this chat…')}
            className="flex-1 bg-transparent t-caption text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              aria-label={tx('clearSearch', 'Clear the search')}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            className="hm-hit r-xs min-h-[36px] px-4 t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
          >
            {tx('done', 'Done')}
          </button>
        </div>
      )}

      {/* 2. Messages List Scroll Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={streaming}
        aria-label={tx('chatLogLabel', 'Chat messages')}
        className="relative flex-1 min-h-0 overflow-y-auto space-y-4 pe-1 pb-2"
      >
        {bubbleMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4 space-y-4">
            {(!connected || gatewayFailed) && (
              <div
                role="alert"
                className="w-full max-w-md px-4 py-3 r-md bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] text-start"
              >
                <p
                  className="t-caption font-semibold text-[var(--app-danger)] flex items-center gap-2"
                  title={gatewayFailed && gatewayFailureReason ? gatewayFailureReason : undefined}
                >
                  <WifiOff className="w-3.5 h-3.5 shrink-0" />
                  {tx('notConnected', 'Not connected')}
                </p>
                <p className="t-caption text-[var(--app-text-muted)] mt-1">
                  {tx(
                    'offlineQueuedBodyPlain',
                    'Not connected. Messages you send now are kept, not lost. They send automatically when the connection is back, and you can send them yourself from the queue bar.'
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <button
                    onClick={onGoSettings}
                    className="hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge t-caption text-[var(--app-text)] cursor-pointer"
                  >
                    {tx('openSettings', 'Open Settings')}
                  </button>
                  <button
                    onClick={() => void refreshNow()}
                    className="hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge t-caption text-[var(--app-text)] cursor-pointer"
                  >
                    {tx('reconnectNow', 'Reconnect now')}
                  </button>
                </div>
              </div>
            )}
            <div className="w-12 h-12 r-md bg-gradient-to-tr from-[var(--app-accent-subtle)] to-[var(--app-info-subtle)] border border-[var(--app-accent)] flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-[var(--app-accent-text)]" />
            </div>
            <div>
              <h3 className="t-heading font-semibold text-[var(--app-text)] tracking-tight">
                {t('helpToday')}
              </h3>
              <p className="t-caption text-[var(--app-text-muted)] mt-1 max-w-sm">
                {tx('emptyStateLead', 'Ask a question, run a command, or set up a task that repeats.')}
              </p>
            </div>

            {/* Clean suggestion cards */}
            <div className="grid grid-cols-1 gap-2 w-full max-w-md pt-2">
              {starterChips.map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => quickSend(chip)}
                  title={chip}
                  className="px-4 py-3 r-sm elev-0 edge bg-[var(--app-card)] t-caption text-[var(--app-text)] text-start transition hover:bg-[var(--app-card-hover)] cursor-pointer"
                >
                  {chip}
                </button>
              ))}
            </div>
            {(!settings.modelId || configuredProviders.length === 0) && (
              <div
                role="note"
                className="w-full max-w-md px-4 py-3 r-md bg-[var(--app-info-subtle)] border border-[var(--app-info-border)] text-start"
              >
                <p className="t-caption font-semibold text-[var(--app-info)]">
                  {!settings.modelId
                    ? tx('noModelSelected', 'No model selected')
                    : tx('noProvidersConfigured', 'No providers added')}
                </p>
                <p className="t-caption text-[var(--app-text-muted)] mt-1">
                  {!settings.modelId
                    ? tx('pickModelToChat', 'Pick a model to start chatting.')
                    : tx('addProviderFirst', 'Add a provider before picking a model.')}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  {!settings.modelId && models.length > 0 && (
                    <button
                      onClick={() => setShowModelsSheet(true)}
                      className="hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] t-caption font-semibold cursor-pointer"
                    >
                      {tx('selectModelAction', 'Pick a model')}
                    </button>
                  )}
                  <button
                    onClick={onGoSettings}
                    className="hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge t-caption text-[var(--app-text)] cursor-pointer"
                  >
                    Open Settings
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          bubbleMessages.map((msg, index) => {
            const meta = turnMeta[msg.id];
            const modelLabel =
              meta && msg.sender !== 'you' ? meta.model.split('/').pop() || null : null;
            const durationLabel =
              meta && meta.durationMs > 0
                ? `${meta.estimated ? '~' : ''}${formatDurationMs(meta.durationMs, tx('durUnderOneSecond', '<1s'))}`
                : null;
            // Regenerate lives on assistant turns and re-sends the user turn
            // that produced them, so it can never echo the reply back at the
            // model. Empty when no preceding user turn exists (then disabled).
            const regenerateSource =
              msg.sender === 'you'
                ? ''
                : (() => {
                    for (let i = index - 1; i >= 0; i--) {
                      if (bubbleMessages[i].sender === 'you') return bubbleMessages[i].content;
                    }
                    return '';
                  })();
            return (
              <MessageRow
                key={msg.id}
                msg={msg}
                isLiveTail={msg.id === liveTailId}
                modelLabel={modelLabel}
                durationLabel={durationLabel}
                formulatingLabel={tx('formulatingLive', 'Writing the reply…')}
                copied={copiedId === msg.id}
                speaking={speakingMsgId === msg.id}
                menuOpen={openMenuId === msg.id}
                streamBusy={streaming}
                stopped={!!meta?.stopped}
                stoppedLabel={tx('stoppedChip', 'Stopped')}
                stoppedHint={tx('stoppedHint', 'This response was stopped before it finished.')}
                estimated={!!meta?.estimated}
                estimatedHint={tx('estimatedDurationHintPlain', 'Estimated time: no usage data arrived for this turn.')}
                copyUnavailableLabel={tx('nothingToCopy', 'Nothing to copy in this message.')}
                regenerateSource={regenerateSource}
                regenerateLabel={tx('regenerateResponse', 'Regenerate')}
                regenerateBusyHint={tx('regenerateBusyHint', 'Wait for generation to finish.')}
                menuContainerRef={menuRef}
                onCopy={onCopyMessage}
                onSpeak={onSpeakMessage}
                onRegenerate={onRegenerateMessage}
                onFork={onForkMessage}
                onToggleMenu={onToggleMenu}
                t={t}
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
            aria-label={tx('jumpToLatest', 'Jump to the latest messages')}
            className="hm-hit r-xs min-h-[36px] px-4 sticky bottom-2 ms-auto me-2 bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] t-caption font-semibold elev-2 cursor-pointer flex items-center gap-2"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            {tx('latestShort', 'Latest')}
          </button>
        )}
      </div>

      <div className="shrink-0 min-h-0 max-h-[32vh] overflow-y-auto space-y-2 overscroll-contain">
            {/* 3. Security Approval Confirmation Queue: the count is always
                visible, the body opens deliberately, and gateway failures
                render on the card they belong to (never as a chat bubble). */}
            {pendingApprovals.length > 0 && (
        <div className="mb-2 r-md bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] animate-in slide-in-from-bottom duration-200">
          <button
            type="button"
            onClick={() => setApprovalsExpanded((v) => !v)}
            aria-expanded={approvalsExpanded}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 min-h-[44px] text-start cursor-pointer"
          >
            <span className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="w-4 h-4 text-[var(--app-warning)] shrink-0" />
              <span className="t-caption font-semibold text-[var(--app-warning)] tracking-tight truncate">
                {tx('approvalsWaitingMany', '{count} approvals waiting for you').replace(
                '{count}',
                String(pendingApprovals.length)
              )}
              </span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span className="t-caption font-mono text-[var(--app-warning)]">{t('approvalTitle')}</span>
              {approvalsExpanded ? (
                <ChevronUp className="w-3.5 h-3.5 text-[var(--app-warning)]" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-[var(--app-warning)]" />
              )}
            </span>
          </button>
          {!approvalsExpanded && (
            <p className="px-3 pb-3 t-caption text-[var(--app-warning)] truncate" title={pendingApprovals[0].summary}>
              {pendingApprovals[0].summary}
            </p>
          )}
          {approvalsExpanded && (
            <div className="px-3 pb-3 space-y-3">
              {pendingApprovals.map((approval) => (
                <div key={approval.runId} className="space-y-2">
                  <ApprovalCard
                    approval={approval}
                    error={approvalFailures[approval.runId]}
                    resolving={resolvingRunId === approval.runId}
                    onDeny={(a) => void handleResolveApproval(a, false)}
                    onAllow={(a, scope) => void handleResolveApproval(a, true, scope)}
                  />
                </div>
              ))}
              {approvalFailureBubbles.map((m) => (
                <p
                  key={m.id}
                  role="alert"
                  className="r-xs border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)] px-4 py-2 t-caption text-[var(--app-danger)]"
                >
                  {m.content}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Approval failures whose card is already gone still get surfaced. */}
      {pendingApprovals.length === 0 && approvalFailureBubbles.length > 0 && (
        <div className="mb-2 px-4 py-3 r-md bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] t-caption space-y-2">
          {approvalFailureBubbles.map((m) => (
            <p key={m.id} role="alert" className="text-[var(--app-danger)] break-words leading-relaxed">
              {m.content}
            </p>
          ))}
        </div>
      )}

      {/* Queued Messages Ribbon: queued items are visibly pending and can be
          sent now, so the queue is never a dead end waiting on the connection. */}
      {queuedMessages.length > 0 && (
        <div
          aria-label={tx('queueAriaLabel', 'Messages waiting to send').concat(
            ': ',
            String(queuedMessages.length),
            queuedMessages[0]?.text ? `. ${queuedMessages[0].text.slice(0, 60)}` : ''
          )}
          className="mb-2 px-4 py-2 r-md bg-[var(--app-accent-subtle)] border border-[var(--app-accent)] flex items-center justify-between gap-2 t-caption text-[var(--app-accent-text)]"
        >
          <span className="min-w-0 flex flex-col">
            <span className="truncate">
              {tx('queuedCount', '{count} waiting to send').replace('{count}', String(queuedMessages.length))}
              {queuedMessages[0]?.text ? `: ${queuedMessages[0].text.slice(0, 60)}` : ''}
            </span>
            <span className="t-micro text-[var(--app-text-muted)]">
              {streaming
                ? tx('queuedAutoHint', 'Pending: sends automatically when this turn finishes.')
                : tx('queuedManualHintPlain', 'Waiting. Sends automatically when the connection is back, or tap Send now.')}
            </span>
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <button
              onClick={sendFirstQueued}
              disabled={streaming}
              className="hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] t-caption font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {tx('sendNow', 'Send now')}
            </button>
            <button
              onClick={cancelQueued}
              aria-label={tx('cancelQueuedAria', 'Cancel {count} waiting messages').replace(
                '{count}',
                String(queuedMessages.length)
              )}
              className="hm-hit r-xs min-h-[36px] px-4 text-[var(--app-danger)] hover:underline cursor-pointer shrink-0 t-caption"
            >
              {tx('cancel', 'Cancel')}
            </button>
          </span>
        </div>
      )}

      {/* Live stream failure banner (context streamError surface, never a bubble) */}
      {liveStreamError &&
        streamErrorDismissed !== liveStreamError &&
        renderFailureCard(
          liveStreamError,
          () => setStreamErrorDismissed(liveStreamError),
          'live-stream-error'
        )}

      {/* Legacy stream error bubbles (older persisted history), same renderer
          so neither path can print a doubled prefix or a raw transport string */}
      {visibleErrors.map((err) =>
        renderFailureCard(err.content, () => setDismissedErrors((prev) => [...prev, err.id]), err.id)
      )}

      {/* Text-file truncation choice notice with included/omitted counts */}
      {attachNotice && (
        <div
          role="status"
          className="mb-2 px-4 py-3 r-md bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] t-caption"
        >
          <p className="text-[var(--app-warning)] font-semibold">{tx('largeFileTruncated', 'Large text file shortened')}</p>
          <p className="text-[var(--app-text)] mt-1 whitespace-pre-wrap break-words">{attachNotice}</p>
          <button
            onClick={() => setAttachNotice(null)}
            className="mt-2 hm-hit r-xs min-h-[36px] px-4 bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] text-[var(--app-text)] t-caption cursor-pointer edge"
          >
            {tx('dismiss', 'Dismiss')}
          </button>
        </div>
      )}

      {/* Attached Images preview (object URLs; compressed payloads sent on submit) */}
      {attaching && attached.length === 0 && (
        <div className="mb-2 px-4 py-3 r-sm edge bg-[var(--app-card-subtle)] t-caption text-[var(--app-text-muted)]">
          {tx('preparingAttachments', 'Preparing attachments…')}
        </div>
      )}
      {attached.length > 0 && (
        <div className="hm-rail items-center gap-2 mb-2 p-3 r-sm edge bg-[var(--app-card)]">
          {attached.map((item, i) => (
            <div key={item.ref.id} className="relative w-12 h-12 r-sm overflow-hidden shrink-0 edge group">
              <img
                src={item.previewUrl}
                alt={item.name || tx('attachedFile', 'Attached file')}
                className="w-full h-full object-cover"
              />
              {/* Remove badge: the tap target is the badge plus a small margin
                  (28px), not a 44px box that overlaps the neighbouring tile. */}
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                aria-label={tx('removeAttachmentAria', 'Remove attachment: {name}').replace(
                  '{name}',
                  item.name ||
                    tx('attachmentFallbackName', 'attachment {number}').replace('{number}', String(i + 1))
                )}
                className="absolute -top-1 -end-1 w-7 h-7 rounded-full flex items-center justify-center text-white cursor-pointer"
              >
                <span className="w-4 h-4 rounded-full bg-[var(--app-scrim)] edge flex items-center justify-center">
                  <X className="w-2.5 h-2.5" />
                </span>
              </button>
            </div>
          ))}
          <span className="t-caption text-[var(--app-text-muted)]">
            {tx('attachedCount', '{count} of {max} attached')
              .replace('{count}', String(attached.length))
              .replace('{max}', String(MAX_IMAGE_COUNT))}
            {attaching ? '…' : ''}
          </span>
        </div>
      )}

      {/* Slash command helpers: reachable while the composer is empty or a /
          command is being typed, grouped so app actions are never mistaken for
          messages sent to the model. */}
      {(text === '' || text.startsWith('/')) && visibleSlashCommands.length > 0 && (
        <div role="toolbar" aria-label={tx('slashCommandsLabel', 'Slash commands')} className="mb-2 space-y-2 shrink-0">
          {slashActions.length > 0 && (
            <div className="hm-rail items-center gap-4 pb-2 t-caption">
              <span className="shrink-0 font-mono t-micro text-[var(--app-text-muted)]">
                {tx('slashAppActions', 'App actions')}
              </span>
              {slashActions.map((cmd) => {
                const blocked = streaming && !!cmd.blockedWhileStreaming;
                return (
                  <button
                    key={cmd.label}
                    onClick={cmd.run}
                    disabled={blocked}
                    title={blocked ? tx('stopTurnFirst', 'Stop the current turn first.') : cmd.hint}
                    aria-label={`${cmd.label}: ${
                      blocked ? tx('stopTurnFirst', 'Stop the current turn first.') : cmd.hint
                    }`}
                    className="hm-hit r-xs min-h-[36px] px-4 inline-flex items-center justify-center min-w-[72px] bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer shrink-0 font-mono t-caption disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {cmd.label}
                  </button>
                );
              })}
            </div>
          )}
          {slashMessages.length > 0 && (
            <div className="hm-rail items-center gap-4 pb-2 t-caption">
              <span className="shrink-0 font-mono t-micro text-[var(--app-text-muted)]">
                {tx('slashSentToModel', 'Sent to model')}
              </span>
              {slashMessages.map((cmd) => (
                <button
                  key={cmd.label}
                  onClick={cmd.run}
                  title={cmd.hint}
                  aria-label={`${cmd.label}: ${cmd.hint}`}
                  className="hm-hit r-xs min-h-[36px] px-4 inline-flex items-center justify-center min-w-[72px] bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge text-[var(--app-info)] hover:text-[var(--app-text)] transition cursor-pointer shrink-0 font-mono t-caption"
                >
                  {cmd.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      {/* Compact model + effort row: one tap target each, both open a sheet, and
          the composer bar below keeps only attach, mic and send. Pills are 36px
          tall with a hm-hit expanded tap area; the 16px gap equals that
          expansion, so neighbouring hit areas never overlap. */}
      <div
        role="group"
        aria-label={tx('composerSettings', 'Model and reasoning effort')}
        className="flex items-center gap-4 mb-2 px-1 shrink-0"
      >
        <button
          type="button"
          onClick={() => setShowModelsSheet(true)}
          title={settings.modelId || t('noModel')}
          aria-label={`${tx('activeModel', 'Active model')}: ${
            settings.modelId ? curModelName : t('noModel')
          }. ${tx('opensModelList', 'Opens the model list.')}`}
          className="hm-hit min-h-[36px] min-w-0 max-w-[62%] pill-neutral font-mono cursor-pointer"
        >
          <span className="truncate">{settings.modelId ? curModelName : t('noModel')}</span>
          <ChevronDown className="w-4 h-4 shrink-0" />
        </button>
        <button
          type="button"
          onClick={() => setShowEffortSheet(true)}
          title={tx('reasoningEffortPlain', 'Reasoning effort')}
          aria-label={`${tx('reasoningEffortPlain', 'Reasoning effort')}: ${effortLabel}. ${tx(
            'opensEffortOptions',
            'Opens the reasoning effort options.'
          )}`}
          className="hm-hit min-h-[36px] pill-neutral font-mono cursor-pointer"
        >
          <Sliders className="w-4 h-4 shrink-0" />
          <span>{effortLabel}</span>
          <ChevronDown className="w-4 h-4 shrink-0" />
        </button>
      </div>

      {/* 4. Desktop/Mobile Composer Surface matching modern Hermes aesthetic */}
      <div className="r-lg elev-2 edge bg-[var(--app-card)] px-4 pt-3 pb-2 shrink-0 transition-all focus-within:ring-1 focus-within:ring-[var(--app-accent)] mb-1">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              if ((e.nativeEvent as unknown as { isComposing?: boolean })?.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              handleSend('keyboard');
            }
          }}
          placeholder={tx('askHermesPlaceholder', 'Message Hermes or paste instructions…')}
          aria-label={tx('askHermesLabel', 'Message Hermes')}
          aria-describedby="composer-hint"
          className="w-full bg-transparent px-1 py-1 t-body text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] focus:outline-none resize-none font-sans min-h-[32px] max-h-[160px]"
        />
        <p id="composer-hint" className="sr-only">
          {tx('composerHint', 'Enter sends. Shift plus Enter adds a new line.')}
        </p>

        {/* Action Bar: attach on the left, mic and send on the right. Model and
            effort now live in the compact row above the composer. */}
        <div className="flex items-center justify-between gap-2 pt-2 mt-2 border-t border-[var(--app-border-subtle)]">
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
            className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[var(--app-text)] bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] active:scale-95 transition-all edge cursor-pointer shrink-0"
            title={tx('attachAction', 'Attach an image or a text file')}
            aria-label={tx('attachAction', 'Attach an image or a text file')}
          >
            <Plus className="w-4 h-4 stroke-[2.2]" />
          </button>

          {/* Right Action Buttons: neutral mic and the single accent send */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Voice Dictation (Cyan Mic) */}
            <button
              type="button"
              onClick={toggleVoice}
              className={`min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center transition-all cursor-pointer ${
                isListening
                  ? 'bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] text-[var(--app-danger)] animate-pulse'
                  : 'bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
              }`}
              title={isListening ? tx('voiceListening', 'Listening…') : tx('voiceDictation', 'Voice dictation')}
              aria-label={
                isListening
                  ? tx('voiceStop', 'Stop voice dictation')
                  : tx('voiceStart', 'Start voice dictation')
              }
              aria-pressed={isListening}
            >
              {isListening ? (
                <Mic className="w-4 h-4 text-[var(--app-danger)]" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>

            {/* Send / Stop Generation Button */}
            {streaming ? (
              <div className="flex items-center gap-2">
                <span className="pill-neutral font-mono">
                  <Clock className="w-4 h-4 animate-spin" />
                  <span>{streamElapsed < 1 ? tx('durUnderOneSecond', '<1s') : `${streamElapsed}s`}</span>
                </span>
                <button
                  type="button"
                  onClick={handleSendNow}
                  aria-label={sendNowHint}
                  title={sendNowHint}
                  className="hm-hit r-xs min-h-[36px] px-4 t-caption font-medium bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)] hover:bg-[var(--app-card-hover)] cursor-pointer"
                >
                  {t('send')}
                </button>
                <button
                  type="button"
                  onClick={stopStream}
                  className="min-w-[44px] min-h-[44px] rounded-full bg-[var(--app-danger-solid)] hover:brightness-110 text-[var(--app-on-danger)] flex items-center justify-center transition cursor-pointer shrink-0"
                  title={tx('stopGenerating', 'Stop generating')}
                  aria-label={tx('stopGenerating', 'Stop generating')}
                >
                  <Square className="w-3 h-3 fill-[var(--app-on-danger)]" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleSend('button')}
                title={sendHint}
                aria-label={sendHint}
                className={`min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 border ${
                  canSendNow
                    ? 'bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] border-[var(--app-accent)] active:scale-95'
                    : 'bg-[var(--app-card-subtle)] text-[var(--app-text-dim)] border-[var(--app-border)]'
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
          aria-label={tx('modelSheetTitle', 'Pick a model')}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[var(--app-scrim)] backdrop-blur-sm p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowModelsSheet(false);
          }}
        >
          <div
            ref={modelsSheetRef}
            className="r-lg elev-3 edge bg-[var(--app-bg)] p-4 sm:p-5 flex flex-col max-h-[85vh] sm:max-h-[80vh] animate-in slide-in-from-bottom-4 duration-200"
          >
            {/* Top Pull Bar / Handle */}
            <div className="w-10 h-1 bg-[var(--app-border)] rounded-full mx-auto mb-3 shrink-0 sm:hidden" />

            {/* Header: Title + Count & Close button */}
            <div className="flex items-start justify-between pb-3 shrink-0">
              <div>
                <h2 className="t-heading text-[var(--app-accent-text)] font-mono font-medium tracking-tight">
                  {tx('modelSheetTitle', 'Pick a model')}
                </h2>
                <p className="t-caption text-[var(--app-text-muted)] font-mono mt-1">
                  {tx('modelCount', '{shown} of {total} models')
                    .replace('{shown}', String(filteredModels.length))
                    .replace('{total}', String(models.length))}
                </p>
              </div>
              <button
                onClick={() => setShowModelsSheet(false)}
                className="min-w-[44px] min-h-[44px] r-xs flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition cursor-pointer"
                title={t('cancel')}
                aria-label={tx('closeModelList', 'Close the model list')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search Input Bar */}
            <div className="relative flex items-center px-4 py-3 r-sm edge bg-[var(--app-input-bg)] focus-within:ring-1 focus-within:ring-[var(--app-accent)] transition shrink-0 mb-3">
              <Search className="w-4 h-4 text-[var(--app-text-muted)] me-3 shrink-0" />
              <input
                ref={sheetSearchRef}
                type="text"
                value={modelSearchQuery}
                onChange={(e) => setModelSearchQuery(e.target.value)}
                placeholder={tx('searchModelsPlaceholder', 'Search models…')}
                aria-label={tx('searchModelsLabel', 'Search models')}
                className="flex-1 bg-transparent t-caption text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] focus:outline-none font-mono"
              />
              {modelSearchQuery && (
                <button
                  onClick={() => setModelSearchQuery('')}
                  aria-label={tx('clearModelSearch', 'Clear the model search')}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Filter Pills Bar (Horizontal scroll) */}
            <div className="hm-rail items-center gap-4 pb-2 mb-2 shrink-0">
              {providerFilterOptions.map((opt) => {
                const isActive = modelFilterProvider === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setModelFilterProvider(opt.id)}
                    aria-pressed={isActive}
                    className={`hm-hit min-h-[36px] font-mono transition cursor-pointer shrink-0 whitespace-nowrap ${
                      isActive ? 'pill-accent font-semibold' : 'pill-neutral'
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
                <div className="text-center py-10 text-[var(--app-text-muted)] t-caption font-mono">
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
                      className={`w-full flex flex-col p-4 r-sm elev-0 border text-start transition cursor-pointer group ${
                        isSelected
                          ? 'bg-[var(--app-accent-subtle)] border-[var(--app-accent)]'
                          : 'bg-[var(--app-card-subtle)] border-[var(--app-border)] hover:border-[var(--app-accent)]'
                      } text-[var(--app-text)]`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-[var(--app-text)] t-body tracking-tight group-hover:text-[var(--app-accent-text)] transition-colors truncate">
                            {m.displayName}
                          </span>
                          <span className="pill-accent t-micro font-mono font-medium shrink-0">
                            {badgeLabel}
                          </span>
                        </div>
                        {isSelected && (
                          <div className="flex items-center gap-1 text-[var(--app-accent-text)] t-caption font-mono shrink-0">
                            <Check className="w-4 h-4 stroke-[2.5]" />
                          </div>
                        )}
                      </div>
                      <p className="t-caption font-mono text-[var(--app-text-muted)] mt-1 truncate">
                        {m.id}
                      </p>
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer with Manage Settings link */}
            <div className="pt-3 mt-2 border-t border-[var(--app-border-subtle)] flex items-center justify-between t-caption text-[var(--app-text-muted)] shrink-0">
              <span className="font-mono t-caption text-[var(--app-text-muted)]">
                {tx('inUse', 'In use')}:{' '}
                <span className="text-[var(--app-text)]">{settings.modelId.split('/').pop()}</span>
              </span>
              <button
                onClick={() => {
                  setShowModelsSheet(false);
                  onGoSettings();
                }}
                className="hm-hit r-xs min-h-[36px] px-4 t-caption text-[var(--app-accent-text)] font-medium cursor-pointer transition flex items-center"
              >
                {tx('manageProviders', 'Manage providers in Settings')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reasoning effort sheet: same overlay contract (Escape, Android back,
          focus trap) as the model sheet. */}
      {showEffortSheet && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={tx('reasoningEffortPlain', 'Reasoning effort')}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[var(--app-scrim)] backdrop-blur-sm p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowEffortSheet(false);
          }}
        >
          <div
            ref={effortSheetRef}
            className="r-lg elev-3 edge bg-[var(--app-bg)] p-4 sm:p-5 flex flex-col max-h-[80vh] animate-in slide-in-from-bottom-4 duration-200"
          >
            <div className="w-10 h-1 bg-[var(--app-border)] rounded-full mx-auto mb-3 shrink-0 sm:hidden" />
            <div className="flex items-start justify-between pb-3 shrink-0">
              <div>
                <h2 className="t-heading text-[var(--app-accent-text)] font-mono font-medium tracking-tight">
                  {tx('reasoningEffortPlain', 'Reasoning effort')}
                </h2>
                <p className="t-caption text-[var(--app-text-muted)] font-mono mt-1">
                  {tx('effortCurrent', 'Current')}: {effortLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowEffortSheet(false)}
                className="min-w-[44px] min-h-[44px] r-xs flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition cursor-pointer"
                title={t('cancel')}
                aria-label={tx('closeEffortOptions', 'Close the reasoning effort options')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto min-h-0 pe-1">
              {EFFORT_LEVELS.map((level) => {
                const active = effortLevel === level;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => {
                      updateSettings({ reasoningEffort: level });
                      setShowEffortSheet(false);
                    }}
                    aria-pressed={active}
                    className={`w-full flex items-center justify-between gap-2 p-4 r-sm elev-0 border text-start transition cursor-pointer ${
                      active
                        ? 'bg-[var(--app-accent-subtle)] border-[var(--app-accent)]'
                        : 'bg-[var(--app-card-subtle)] border-[var(--app-border)] hover:border-[var(--app-accent)]'
                    } text-[var(--app-text)]`}
                  >
                    <span className="flex flex-col">
                      <span className="t-body font-semibold">{effortLabelFor(level)}</span>
                      <span className="t-caption text-[var(--app-text-muted)] mt-1">
                        {level === 'none'
                          ? tx('effortNoneHint', 'No reasoning step is requested.')
                          : level === 'low'
                            ? tx('effortLowHint', 'Short reasoning budget.')
                            : level === 'medium'
                              ? tx('effortMediumHint', 'Balanced reasoning budget.')
                              : tx('effortHighHint', 'Longest reasoning budget.')}
                      </span>
                    </span>
                    {active && <Check className="w-4 h-4 text-[var(--app-accent-text)] stroke-[2.5] shrink-0" />}
                  </button>
                );
              })}
            </div>
            <p className="pt-3 mt-2 border-t border-[var(--app-border-subtle)] t-caption text-[var(--app-text-muted)] shrink-0">
              {tx(
                'effortSheetHint',
                'Applies to the next turn. Providers that do not support reasoning effort ignore this setting.'
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

interface ThinkingAccordionProps {
  thinking: string;
  isDone: boolean;
}

const ThinkingAccordion: React.FC<ThinkingAccordionProps> = ({ thinking, isDone }) => {
  const [expanded, setExpanded] = useState(!isDone);

  // The accordion sits outside the i18n provider, so it reads the same bundle
  // through the document language and keeps an English fallback.
  const tx = (key: string, fallback: string): string => {
    const docLang =
      typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en';
    const value = getTranslation(key, docLang.toLowerCase().split('-')[0] || 'en');
    return value && value !== key ? value : fallback;
  };

  // Follow the live state: expand while reasoning, auto-collapse when done.
  useEffect(() => {
    setExpanded(!isDone);
  }, [isDone]);

  return (
    <div className="mb-3 r-sm elev-0 edge bg-[var(--app-card-subtle)] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={tx('thinkingAria', 'Thinking, {state}. Tap to {action}.')
          .replace('{state}', isDone ? tx('reasoningDone', 'finished') : tx('reasoningWorking', 'working…'))
          .replace(
            '{action}',
            expanded ? tx('thinkingCollapse', 'hide the details') : tx('thinkingExpand', 'show the details')
          )}
        className="w-full flex items-center justify-between px-4 min-h-[44px] py-2 t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer transition"
      >
        <div className="flex items-center gap-2">
          <span className={isDone ? 'text-[var(--app-success)]' : 'text-[var(--app-accent)] animate-spin'}>
            {isDone ? '✓' : '◐'}
          </span>
          <span className="font-medium text-[var(--app-text)]">{tx('thinkingLabel', 'Thinking')}</span>
          <span className="t-caption text-[var(--app-text-muted)]">({isDone ? tx('reasoningDone', 'finished') : tx('reasoningWorking', 'working…')})</span>
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {expanded && (
        <div
          className="p-4 font-mono t-caption text-[var(--app-text-muted)] border-t border-[var(--app-border-subtle)] whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto bg-[var(--app-bg)]"
        >
          {thinking}
        </div>
      )}
    </div>
  );
};
