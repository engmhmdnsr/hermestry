import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Square,
  Plus,
  Check,
  Search,
  X,
  ChevronDown,
  ChevronUp,
  Mic,
  Clock,
  Sparkles,
  Sliders,
  AlertTriangle,
  WifiOff,
  RefreshCw,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { ChatMessage, PendingApproval } from '../../types/hermes';
import { PROVIDER_OPTIONS, normProvider } from '../../constants/providers';
import { speechLocaleForLanguage } from '../../constants/languages';
import { ChatMessageBubble } from '../chat';
import { processAttachBatch, buildTextChoiceNotice, totalPayloadBytes, MAX_IMAGE_COUNT } from '../../services/attachments';
import type { AttachmentRef } from '../../services/attachmentRefs';
import {
  appendAttachmentRefs,
  previewUrlFor,
  registerBlob,
  refsFromTexts,
  revokeRef,
} from '../../services/attachmentRefs';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { approvalKey } from '../approvals/pendingApprovals';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import { isMachineFailure, isTransportFailure, plainGatewayFailure, plainResultLine, localizeAttachmentMessage } from '../../services/plainFailure';
import { modelLabel } from '../../services/modelLabel';
import { isNativeGateway, nativeHealth } from '../../services/nativeGateway';

// Reasoning effort levels, in the order the sheet renders them.
const EFFORT_LEVELS = ['none', 'low', 'medium', 'high'] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

interface ChatTabProps {
  onGoSettings: () => void;
  isDesktop?: boolean;
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

// The details toggle is for humans, never for logs. Classification still sees
// the raw text (that is how 'Failed to fetch' becomes the offline copy), but
// what reaches the DOM goes through the plainFailure rules first, so a fetch
// or TypeError string can never surface behind 'Reply failed'.
const plainFailureDetail = (raw: string): string => {
  const s = (raw || '').trim();
  if (!s) return '';
  // A bare HTTP status is a fact worth showing, not a stack fragment.
  if (/^http\s*\d{3}$/i.test(s)) return s;
  if (isTransportFailure(s) || isMachineFailure(s)) return '';
  return s;
};

// Optional native speech bridge on the HermesGateway Capacitor plugin.
// speechRecognize/ttsSpeak/ttsStop are implemented in HermesGatewayPlugin.kt
// (system recognizer intent + android TextToSpeech); the web path below runs
// only when the bridge is absent. Never import nativeGateway.ts from this file.
interface NativeSpeechBridge {
  speechRecognize?: (options: { locale: string; maxChars: number }) => Promise<{ transcript?: string }>;
  ttsSpeak?: (options: { text: string; locale: string }) => Promise<unknown>;
  ttsStop?: () => Promise<unknown>;
}

const getNativeSpeechBridge = (): NativeSpeechBridge | null => {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
    const plugin = cap?.Plugins?.HermesGateway as NativeSpeechBridge | undefined;
    if (!plugin) return null;
    if (
      typeof plugin.speechRecognize !== 'function' &&
      typeof plugin.ttsSpeak !== 'function' &&
      typeof plugin.ttsStop !== 'function'
    ) {
      return null;
    }
    return plugin;
  } catch {
    return null;
  }
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
    refreshModels,
    modelsLiveInfo,
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
    // Gateway lifecycle: a model or provider switch only reaches the on-device
    // process if it is stopped and started again (see applyModelSwitch below).
    startGateway,
    stopGateway,
    // Save lifecycle: the write owns the native credential mirror the gateway
    // reads at start, so a restart has to wait for it to settle.
    settingsSaveState,
    settingsSaveRevision,
    settingsSaveError,
    retryLast,
    turnImages,
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

  // Failure text arrives as free form gateway text ('Stream failed: HTTP 404',
  // sometimes already prefixed with 'Stream error:'). Prefixes are collapsed
  // so the banner shows exactly one, and the kind drives the friendly copy
  // plus a real next step. The raw detail stays available behind a details
  // toggle.
  const classifyStreamFailure = (raw: string): StreamFailureInfo => {
    let detail = (raw || '').trim();
    let prev = '';
    while (prev !== detail && STREAM_ERROR_PREFIX.test(detail)) {
      prev = detail;
      detail = detail.replace(STREAM_ERROR_PREFIX, '').trim();
    }
    if (!detail) return { kind: 'unknown', status: null, detail };
    // Friendly copies already carry their verdict: never run the transport
    // matcher over them, or a closed-stream note that mentions the word
    // "connection" would wear the gateway-down costume.
    const friendly: Array<[string, StreamFailureKind]> = [
      [tx('errUnavailable', 'Hermes is unreachable. Make sure it is running, then try again.'), 'offline'],
      [tx('errStreamClosed', 'Hermes closed the connection before the answer finished. Try again.'), 'unknown'],
      [tx('errGatewayAuthHint', 'Hermes rejected the stored key. Check the provider key and Base URL in Settings, then try again.'), 'auth'],
      [tx('errGatewayKeyRejected', 'Hermes rejected the stored key. Check the key and Base URL in Settings, then retry.'), 'auth'],
      [tx('errSessionGone', 'This chat is no longer on the gateway. Start a new chat.'), 'model'],
    ];
    for (const [copy, kind] of friendly) {
      if (detail === copy) return { kind, status: null, detail };
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
    // An explicit status always wins over transport words: a provider 500
    // that mentions "connection" is a server refusal, not a dead gateway.
    // Bare transport words with no status mean the request never arrived.
    if (status !== null && status >= 500) return { kind: 'server', status, detail };
    if (status === null && /failed to fetch|network|econnrefused|unreachable|socket|disconnected|connection/.test(low)) {
      return { kind: 'offline', status, detail };
    }
    if (status !== null) return { kind: 'server', status, detail };
    return { kind: 'unknown', status, detail };
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
  // Slash rails: only while the field is focused, or once the text starts a
  // slash. They used to sit above every empty composer, even unfocused.
  const [composerFocused, setComposerFocused] = useState(false);
  const railsRef = useRef<HTMLDivElement | null>(null);
  // One model switch at a time. The busy flag is what the pill reads while
  // the stop/write/start await runs, so a second tap cannot start a second
  // restart underneath the first.
  const [modelSwitching, setModelSwitching] = useState(false);
  const modelSwitchBusyRef = useRef(false);
  // Save lifecycle read by the async model switch: those reads happen long
  // after this render, so they go through refs instead of the captured values.
  const saveStateRef = useRef(settingsSaveState);
  saveStateRef.current = settingsSaveState;
  const saveRevisionRef = useRef(settingsSaveRevision);
  saveRevisionRef.current = settingsSaveRevision;
  const saveErrorRef = useRef(settingsSaveError);
  saveErrorRef.current = settingsSaveError;
  const [isListening, setIsListening] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  // Every TTS start/cancel bumps this: a delayed route or voice-wait from an
  // older request sees a stale seq and stays silent instead of speaking late.
  const ttsSeqRef = useRef(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<'info' | 'success' | 'error'>('info');
  const [showEffortSheet, setShowEffortSheet] = useState(false);
  const [confirmArm, setConfirmArm] = useState<{ key: string; scope: 'session' | 'always' } | null>(null);
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
  // Staged composer files kept per session: switching chats stashes this
  // session's staged images (and their pending refs) and restores the ones
  // staged for the session being opened.
  const stagedBySessionRef = useRef(new Map<string, { attached: AttachedImage[]; pending: AttachmentRef[] }>());
  const prevSessionRef = useRef<string | null>(currentSessionId);
  // A native dictation request in flight. The plugin promise cannot be
  // cancelled, so a stop tap marks it stale and its transcript is dropped.
  const voiceReqRef = useRef(0);
  const flushTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  // Ephemeral UI timers. They are tracked so the unmount cleanup can drop a
  // pending copy or approval re-check instead of firing it into a component
  // that is already gone.
  const copiedTimerRef = useRef<number | null>(null);
  // One timer PER approval run: a shared ref let one card's resolve check
  // cancel another card's, so a failed decision on A could hide behind B.
  const approvalTimersRef = useRef<Map<string, number>>(new Map());
  // Disarm an armed session-confirm when the user walks away from the card.
  const confirmDisarmRef = useRef<number | null>(null);
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
      // Stashed per-session files die with the tab too; revoke their image
      // blobs instead of leaking object URLs for chats that never sent.
      stagedBySessionRef.current.forEach((s) => {
        s.attached.forEach((a) => {
          try {
            revokeRef(a.ref);
          } catch {
            /* ignore */
          }
        });
      });
      stagedBySessionRef.current.clear();
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      approvalTimersRef.current.forEach((id) => window.clearTimeout(id));
      approvalTimersRef.current.clear();
      if (confirmDisarmRef.current !== null) window.clearTimeout(confirmDisarmRef.current);
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      try {
        void getNativeSpeechBridge()?.ttsStop?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    const draft = getDraftRef.current(currentSessionId);
    textRef.current = draft;
    setText(draft);
    // Staged files are kept per session: stash this render's staged images
    // (and their pending refs) under the session being left, then restore
    // whatever was staged for the session being opened. Picked images never
    // ride into the wrong chat and never vanish when switching back. The
    // stash reads attachedRef, which still holds the session being left (the
    // sync effect below updates it after this one), and the effect only runs
    // when the session id changes, so attaching never clears itself.
    const prev = prevSessionRef.current;
    prevSessionRef.current = currentSessionId;
    if (prev === currentSessionId) return;
    if (prev) {
      const staged = attachedRef.current;
      const pending = pendingRefsRef.current;
      if (staged.length > 0 || pending.length > 0) {
        stagedBySessionRef.current.set(prev, { attached: staged, pending });
        // Bound the stash: drop the oldest session and revoke its image
        // blobs instead of holding every chat's files in memory.
        while (stagedBySessionRef.current.size > 10) {
          const oldest = stagedBySessionRef.current.keys().next();
          if (oldest.done) break;
          const dropped = stagedBySessionRef.current.get(oldest.value);
          stagedBySessionRef.current.delete(oldest.value);
          dropped?.attached.forEach((a) => {
            try {
              revokeRef(a.ref);
            } catch {
              /* ignore */
            }
          });
        }
      } else {
        stagedBySessionRef.current.delete(prev);
      }
    }
    const restored = currentSessionId ? stagedBySessionRef.current.get(currentSessionId) : undefined;
    pendingRefsRef.current = restored?.pending ?? [];
    setAttached(restored?.attached ?? []);
    setAttachNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  // The composer never takes focus on its own: on Android the soft keyboard
  // would otherwise open the moment the chat tab appears. Nothing in this file
  // focuses the field, so if the shell or a restored focus hands the caret over
  // anyway, it is dropped once here. Tapping the field still focuses it.
  useEffect(() => {
    const field = textareaRef.current;
    if (field && document.activeElement === field) field.blur();
  }, []);

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

  // Keep the send-path ref in sync with attachments for cap accounting
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
        (m.content || '').toLowerCase().includes(q) ||
        (m.thinking && m.thinking.toLowerCase().includes(q))
    );
  }, [displayChat, searchOpen, searchQuery]);

  // Stream errors arrive as hermes bubbles from context; surface them as a
  // distinct banner with retry/dismiss instead of rendering error-as-bubble.
  // The || '' keeps a record from older local history from throwing inside a
  // filter, which would blank the whole transcript at render time.
  const isStreamError = (m: ChatMessage) =>
    m.sender === 'hermes' && (m.content || '').startsWith('Stream error:');
  // Approval failures are injected by the context as assistant style bubbles.
  // They belong on the approval card, so they are pulled out of the transcript
  // here and rendered next to the card that is still pending.
  const isApprovalFailure = (m: ChatMessage) =>
    m.sender === 'hermes' && /^approval (grant|deny) failed:/i.test((m.content || '').trim());
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

  // A settled assistant turn with an empty body and a failure verdict in its
  // meta (error from the stream runner, or stopped for a zero-char abort) is
  // a failed turn, never a reply: it renders as an inline failure card with
  // Retry instead of a silent empty bubble. The streaming tail is excluded
  // because every turn starts empty before its first delta arrives.
  const isFailedEmptyTurn = (m: ChatMessage): boolean => {
    if (m.sender === 'you') return false;
    if (streaming && m.id === liveTailId) return false;
    const bodyEmpty =
      !(m.content || '').trim() &&
      !(m.thinking || '').trim() &&
      (m.tools?.length ?? 0) === 0 &&
      (m.toolOutputs?.length ?? 0) === 0;
    if (!bodyEmpty) return false;
    const meta = turnMeta[m.id];
    return !!meta?.error || !!meta?.stopped;
  };

  const pendingApprovals = approvals;

  const hasComposerContent = text.trim().length > 0 || attached.length > 0;
  const canSendNow = hasComposerContent && !!settings.modelId && !attaching;

  // The send button is disabled whenever it cannot send, so a greyed circle
  // never lies about being ready. The reasons still have to be said out loud
  // somewhere: sendHint below is that copy, and the keyboard path (Enter) runs
  // requireModel, which opens the model list for a composer with no model.
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
      // WCAG 2.5.3: the accessible name must contain the visible label
      // ('Stop, then send'), so both use the same string here.
      : tx('stopThenSend', 'Stop, then send');

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

  // One model guard for every path that starts a turn. With no model there is
  // nothing to send to, so the sheet opens here and only here: the send button
  // is disabled without a model, so this guard (keyboard Enter, queue, retry,
  // regenerate) is the path that both explains it and offers the fix, and none
  // of them may post into a turn that 404s on session creation.
  const requireModel = (): boolean => {
    if (settings.modelId) return true;
    showActionToast(tx('sendNeedsModel', 'Select a model first. Tap send to open the model list.'), 'error');
    setShowModelsSheet(true);
    return false;
  };

  // One renderer for both the live banner and legacy persisted error bubbles,
  // so neither shows a doubled prefix or a bare transport string.
  const renderFailureCard = (raw: string, onDismiss: () => void, key: string) => {
    const failure = classifyStreamFailure(raw);
    const described = describeFailure(failure);
    const detail = plainFailureDetail(failure.detail || raw);
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
        {detail && (
          <details className="mt-2">
            <summary className="t-caption text-[var(--app-danger)] cursor-pointer">
              {tx('showErrorDetail', 'Show details')}
            </summary>
            <p className="mt-1 font-mono t-caption text-[var(--app-danger)] break-all">{detail}</p>
          </details>
        )}
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
              if (!requireModel()) return;
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
    if (!requireModel()) return;
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
          'Not connected. Kept for later: send it from the queue bar, or it sends when the connection is back.'
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
    if (!requireModel()) return;
    // stopStream drops the next-turn queue (context stop contract): say so
    // with a count instead of discarding pending messages silently.
    const dropped = queuedMessages.length;
    const result = sendNow(trimmed, payloads);
    if (dropped > 0)
      showActionToast(
        tx('stopDroppedQueued', '{count} waiting message(s) discarded by the stop').replace('{count}', String(dropped)),
        'info'
      );
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
    if (!requireModel()) return;
    const rest = queuedMessages.slice(1);
    cancelQueued();
    rest.forEach((m) => queueMessage(m.text, m.images));
    if (!sendMessage(first.text, first.images)) {
      // Order-preserving requeue: the failed head goes back first so the
      // queue order the user saw is the order that will send later.
      cancelQueued();
      queueMessage(first.text, first.images);
      rest.forEach((m) => queueMessage(m.text, m.images));
      showActionToast(tx('sendFailedDraftKept', 'Send failed, draft kept'), 'error');
    } else {
      setStickToBottom(true);
    }
  };

  const handleResolveApproval = async (
    approval: PendingApproval,
    allow: boolean,
    scope?: 'once' | 'session' | 'always'
  ) => {
    // Session-allow and always-allow are broad: require an explicit two-tap
    // confirm, and disarm automatically so an aged tap cannot silently widen
    // the grant. The arm binds run AND scope: tapping session then always
    // starts a new arm, it never inherits the session tap's confirmation.
    const key = approvalKey(approval);
    const needsConfirm = allow && (scope === 'session' || scope === 'always');
    if (needsConfirm && (confirmArm?.key !== key || confirmArm?.scope !== scope)) {
      setConfirmArm({ key, scope });
      if (confirmDisarmRef.current !== null) window.clearTimeout(confirmDisarmRef.current);
      confirmDisarmRef.current = window.setTimeout(() => {
        confirmDisarmRef.current = null;
        setConfirmArm((cur) => (cur?.key === key ? null : cur));
      }, 5000);
      showActionToast(
        scope === 'always'
          ? tx('approveAlwaysConfirm', 'Tap Always allow again to confirm.')
          : tx('approveSessionConfirm', 'Tap Allow for this chat again to confirm.'),
        'info'
      );
      return;
    }
    if (confirmDisarmRef.current !== null) {
      window.clearTimeout(confirmDisarmRef.current);
      confirmDisarmRef.current = null;
    }
    setConfirmArm(null);
    setResolvingRunId(key);
    try {
      await resolveApproval(approval, allow, scope);
      // A card that is still pending means the gateway did not confirm the
      // decision. Report it on the card itself instead of letting the failure
      // hide in a chat bubble that is not persisted.
      const prevTimer = approvalTimersRef.current.get(key);
      if (prevTimer !== undefined) window.clearTimeout(prevTimer);
      const timer = window.setTimeout(() => {
        approvalTimersRef.current.delete(key);
        if (approvalsRef.current.some((a) => approvalKey(a) === key)) {
          setApprovalFailures((prev) => ({
            ...prev,
            [key]: tx(
              'approvalNotConfirmedPlain',
              'Hermes did not confirm this decision, so it is still waiting. Retry it, and check the connection if it repeats.'
            ),
          }));
        }
      }, 250);
      approvalTimersRef.current.set(key, timer);
    } finally {
      setResolvingRunId((cur) => (cur === key ? null : cur));
    }
  };

  const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
    const res = await fetch(dataUrl);
    return res.blob();
  };

  const removeAttachment = (index: number) => {
    // Side effects stay out of the state updater: StrictMode may invoke the
    // updater twice, which would double revoke and double filter the refs.
    const target = attachedRef.current[index];
    if (target) {
      try {
        revokeRef(target.ref);
      } catch {
        /* ignore */
      }
      pendingRefsRef.current = pendingRefsRef.current.filter((r) => r.id !== target.ref.id);
    }
    setAttached((prev) => prev.filter((_, idx) => idx !== index));
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
        imagePayloadBytesAlreadyAttached: totalPayloadBytes(attachedRef.current.map((a) => a.dataUrl)),
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
        if (notice) setAttachNotice(localizeAttachmentMessage(notice, tx) || notice);
      }

      if (batch.errors.length > 0) {
        // Service file errors are plain sentences, but anything machine-shaped
        // must reach the user as the friendly attach fallback, not as raw text.
        showActionToast(
          batch.errors
            .map((err) => localizeAttachmentMessage(err, tx) || plainResultLine(err, tx('attachFailed', 'Could not add those files. Nothing was attached.'), tx))
            .join('\n'),
          'error'
        );
      }
    } catch {
      if (!ctrl.signal.aborted) showActionToast(tx('attachFailed', 'Could not add those files. Nothing was attached.'), 'error');
    } finally {
      if (attachAbortRef.current === ctrl) attachAbortRef.current = null;
      setAttaching(false);
    }
  };

  const voiceTapAtRef = useRef(0);
  const toggleVoice = () => {
    // Rapid re-taps race recognition startup; the second tap lands while the
    // first start is still in flight and flips the mic straight back off.
    const now = Date.now();
    if (now - voiceTapAtRef.current < 800) return;
    voiceTapAtRef.current = now;
    if (isListening) {
      // A native request cannot be cancelled mid-flight; mark it stale so a
      // late transcript is dropped instead of landing after the stop tap.
      voiceReqRef.current += 1;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      setIsListening(false);
      return;
    }

    const locale = speechLocaleForLanguage(settings.language || 'en');
    const MAX_VOICE_CHARS = 2000;
    const appendVoiceTranscript = (transcript: string) => {
      const clean = (transcript || '').trim();
      if (!clean) {
        showActionToast(tx('voiceHeardNothing', 'Did not catch that. Try again.'), 'info');
        return;
      }
      // Ref-based: the closure over `text` goes stale while dictating.
      const base = textRef.current;
      const next = base ? `${base} ${clean}` : clean;
      // Dictation is a note, not a paste: cap it so one long session can
      // never flood the composer, and say so briefly.
      if (next.length > MAX_VOICE_CHARS) {
        handleTextChange(next.slice(0, MAX_VOICE_CHARS));
        showActionToast(tx('voiceTruncated', 'Voice note shortened to fit'), 'info');
      } else {
        handleTextChange(next);
      }
    };

    // Native bridge first: the Capacitor WebView ships no SpeechRecognition,
    // so on-device dictation can only come from the HermesGateway plugin.
    // getNativeSpeechBridge returns null until a native build ships
    // speechRecognize, and the web path below runs instead.
    const bridge = getNativeSpeechBridge();
    if (bridge && typeof bridge.speechRecognize === 'function') {
      const req = voiceReqRef.current + 1;
      voiceReqRef.current = req;
      setIsListening(true);
      bridge
        .speechRecognize({ locale, maxChars: MAX_VOICE_CHARS })
        .then((res) => {
          if (voiceReqRef.current !== req) return;
          appendVoiceTranscript(res?.transcript || '');
        })
        .catch(() => {
          if (voiceReqRef.current !== req) return;
          showActionToast(tx('voiceFailed', 'Voice dictation failed. Try again.'), 'error');
        })
        .finally(() => {
          if (voiceReqRef.current === req) setIsListening(false);
        });
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      // No web API and no native bridge yet: this is the Capacitor WebView
      // until the native build ships speechRecognize, so say so plainly.
      showActionToast(tx('speechUnsupported', 'Speech recognition is not supported in this browser.'), 'error');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = locale;

      recognition.onstart = () => setIsListening(true);
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        appendVoiceTranscript(transcript);
        setIsListening(false);
      };
      recognition.onerror = (event: any) => {
        setIsListening(false);
        const kind = event?.error || '';
        // 'aborted' is our own stop tap and 'no-speech' means silence, not a
        // failure. Anything else failed loudly enough to deserve a toast.
        if (kind && kind !== 'aborted' && kind !== 'no-speech') {
          showActionToast(tx('voiceFailed', 'Voice dictation failed. Try again.'), 'error');
        }
      };
      recognition.onend = () => {
        setIsListening(false);
        // Terminal state: a stale non-null ref would let a later stop tap
        // call stop() on a dead recognizer while a new one is starting.
        if (recognitionRef.current === recognition) recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setIsListening(false);
      showActionToast(tx('voiceFailed', 'Voice dictation failed. Try again.'), 'error');
    }
  };

  const MAX_SPEECH_CHARS = 1500;

  // Strip content that should never be vocalized: fenced code blocks and
  // URLs (may contain secrets or tokens). Inline code stays spoken, with
  // its delimiters dropped; markdown markers become spaces so hyphenated
  // words keep their hyphens and table cells never glue together.
  const sanitizeForSpeech = (content: string) => {
    let out = content.replace(/```[\s\S]*?```/g, ' code omitted ');
    // An unterminated fence (still streaming when TTS starts) is code too,
    // never raw backticks read aloud.
    out = out.replace(/```[\s\S]*$/g, ' code omitted ');
    // Markdown links: speak the label, drop the URL and its brackets.
    out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
    out = out.replace(/`([^`]*)`/g, ' $1 ');
    out = out.replace(/https?:\/\/\S+/g, ' link omitted ');
    out = out.replace(/[*#_>|]/g, ' ');
    out = out.replace(/^\s*[-+*]\s+/gm, ' ');
    // Horizontal rules only: CLI switches (--verbose) keep their hyphens.
    out = out.replace(/(?<![\w-])-{3,}(?![\w-])/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
  };

  const handleSpeak = (msgId: string, content: string) => {
    const bridge = getNativeSpeechBridge();
    const stopNative = () => {
      try {
        void bridge?.ttsStop?.();
      } catch {
        /* ignore */
      }
    };
    if (speakingMsgId === msgId) {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
      stopNative();
      setSpeakingMsgId(null);
      ttsSeqRef.current += 1;
      return;
    }

    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    stopNative();
    ttsSeqRef.current += 1;
    const cleanText = sanitizeForSpeech(content);
    if (!cleanText) {
      showActionToast(tx('nothingToSpeak', 'Nothing to read in this message.'), 'info');
      return;
    }
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
    const locale = speechLocaleForLanguage(settings.language || 'en');

    // Native bridge when the WebView itself cannot speak and the plugin ships
    // TTS. The promise resolves when the utterance is queued, not finished,
    // so the speaking badge clears there; the toggle above still stops it.
    // Route only after voices settle (bounded): getVoices() starts empty in
    // most WebViews, and branching on that first snapshot misroutes speech
    // (native instead of web, or voiceless instead of native). route() always
    // runs async, after the utterance helpers below are initialized.
    const seq = ttsSeqRef.current;
    const route = () => {
      if (seq !== ttsSeqRef.current) return;
      const webVoiceless =
        !window.speechSynthesis || window.speechSynthesis.getVoices().length === 0;
      if (webVoiceless && bridge && typeof bridge.ttsSpeak === 'function') {
        setSpeakingMsgId(msgId);
        if (truncated) showActionToast(tx('ttsTruncated', 'Long message: reading the first part aloud'), 'info');
        bridge
          .ttsSpeak({ text: spoken, locale })
          .catch(() => {
            showActionToast(tx('ttsFailed', 'Could not read this message aloud.'), 'error');
          })
          .finally(() => {
            setSpeakingMsgId((cur) => (cur === msgId ? null : cur));
          });
        return;
      }
      if (!window.speechSynthesis) {
        // No web voice and no native bridge yet: say so instead of going silent.
        showActionToast(tx('ttsUnsupported', 'Read aloud is not supported on this device.'), 'error');
        return;
      }
      speakOrWait();
    };
    try {
      const voices = window.speechSynthesis?.getVoices?.() || [];
      if (voices.length > 0) {
        queueMicrotask(route);
      } else {
        let settled = false;
        const go = () => {
          if (settled) return;
          settled = true;
          route();
        };
        try {
          window.speechSynthesis.addEventListener('voiceschanged', go, { once: true });
        } catch {
          /* older WebViews take no options; the timeout below still fires */
        }
        window.setTimeout(go, 800);
      }
    } catch {
      queueMicrotask(route);
    }

    const utter = new SpeechSynthesisUtterance(spoken);
    utter.lang = locale;
    const speakWithVoice = () => {
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
      utter.onerror = (e) => {
        setSpeakingMsgId(null);
        // A manual stop fires 'canceled': that is the user succeeding,
        // not a failure worth a red toast.
        const err = (e as SpeechSynthesisErrorEvent)?.error;
        if (err && err !== 'canceled' && err !== 'interrupted') {
          showActionToast(tx('ttsFailed', 'Could not read this message aloud.'), 'error');
        }
      };
      setSpeakingMsgId(msgId);
      if (truncated) showActionToast(tx('ttsTruncated', 'Long message: reading the first part aloud'), 'info');
      window.speechSynthesis.speak(utter);
      // The WebView often starts paused with no error event; resume unblocks
      // it and is a no-op where speech is already running.
      try {
        window.speechSynthesis.resume();
      } catch {
        /* ignore */
      }
    };
    // Voices already settled in route(): speak at once, unless a cancel or a
    // newer request bumped the seq while routing.
    const speakOrWait = () => {
      if (seq !== ttsSeqRef.current) return;
      speakWithVoice();
    };
  };

  const handleCopy = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopiedId(null), 1800);
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
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopiedId(null), 1800);
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
    (content: string, images: string[] = []) => {
      // Stream guard: never fire a second turn mid-stream; the row button is
      // also disabled, this is the keyboard/edge-path backstop.
      if (streaming) {
        showActionToast(tx('stillGenerating', 'Still generating, wait or stop first'), 'info');
        return;
      }
      if (!content.trim()) return;
      // Same model guard as the send button: without a model the turn would
      // post into session creation and fail with a gateway error instead of
      // the plain 'pick a model' copy the rest of the chat shows.
      if (!requireModel()) return;
      // Image turns carry their payload along: history persists text only,
      // so resending the text alone would silently drop the pictures.
      const ok = sendMessage(content.trim(), images);
      if (!ok) showActionToast(tx('regenerateFailedPlain', 'Could not write a new reply. Check the connection, then retry.'), 'error');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendMessage, streaming, settings.modelId]
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

  // The message overflow menu is an overlay like the sheets: Android back has
  // to close it instead of jumping out of the Chat tab, Escape has to reach it
  // before the layers below (the window listener further down never sees the
  // key once this one stops propagation), and focus returns to the overflow
  // button when it closes.
  const closeMessageMenu = useCallback(() => setOpenMenuId(null), []);
  useOverlayBehavior(openMenuId !== null, closeMessageMenu, menuRef);

  // Model sheet: focus the search field on pointer/keyboard devices only, so
  // opening the sheet on a phone does not drop the soft keyboard over the list.
  // Re-sync the live catalog every time the sheet opens: the boot fetch may
  // have landed on a bad key (silent empty), and providersKey does not change
  // when keys are fixed, so without this the list stays stale forever.
  useEffect(() => {
    if (!showModelsSheet) return;
    // Await the refresh so the banner reports the outcome of THIS open, not
    // whatever the boot-time attempt left behind.
    void refreshModels();
  }, [showModelsSheet, refreshModels]);

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

  // Overflow menu: close on a tap outside it. Escape and the Android back
  // button go through useOverlayBehavior (see closeMessageMenu above), whose
  // document-phase listener stops the key before it reaches a window listener.
  useEffect(() => {
    if (openMenuId === null) return;
    const onPointer = (e: PointerEvent) => {
      const el = menuRef.current;
      if (el && !el.contains(e.target as Node)) setOpenMenuId(null);
    };
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [openMenuId]);

  // A new stream error re-arms the banner after a previous dismiss.
  useEffect(() => {
    setStreamErrorDismissed(null);
  }, [liveStreamError]);

  // A failed turn toasts once with the same copy its inline card shows.
  // Seeded on mount so reopening a chat with an old persisted failure does
  // not replay its toast; only newly failed turns announce.
  const seenFailedTurnsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const current = new Set<string>();
    for (const m of bubbleMessages) {
      if (isFailedEmptyTurn(m)) current.add(m.id);
    }
    if (seenFailedTurnsRef.current === null) {
      seenFailedTurnsRef.current = current;
      return;
    }
    const prev = seenFailedTurnsRef.current;
    for (const id of current) {
      if (!prev.has(id)) {
        const described = describeFailure(classifyStreamFailure(turnMeta[id]?.error || ''));
        showActionToast(`${described.title}: ${described.message}`, 'error');
      }
    }
    seenFailedTurnsRef.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubbleMessages, turnMeta, streaming, liveTailId]);

  // Drop stale approval-failure notices once their card is gone: a confirmed
  // decision removes the runId from approvals, which clears the notice with it.
  useEffect(() => {
    setApprovalFailures((prev) => {
      const ids = new Set(approvals.map((a) => a.runId));
      const kept = Object.entries(prev).filter(([id]) => ids.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [approvals]);

  // Model name for the composer pill and the sheet heading: the catalog's own
  // display name when it has one, otherwise the shared resolver, and 'No model'
  // when nothing real is selected (a bare provider id is not a model).
  const curModelName =
    models.find((m) => m.id === settings.modelId)?.displayName ||
    modelLabel(settings) ||
    tx('noModel', 'No model');

  // Wait for the settings write this switch just queued to settle. Reaching
  // 'saved' is what proves the native credential mirror landed, and that
  // mirror is the only place the gateway reads provider and model from at
  // start, so restarting before it settles would start the old provider
  // again. Bounded: a write that never resolves must not hold the composer
  // hostage.
  const awaitSettingsWrite = async (before: number, writes: number): Promise<boolean> => {
    const deadline = Date.now() + 10000;
    while (saveRevisionRef.current < before + writes) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return saveStateRef.current === 'saved' && !saveErrorRef.current;
  };

  // Model (and provider) switch from the chat sheet. The on-device gateway
  // reads provider, model and credentials only when it starts, so a running
  // process keeps serving the old one until it is stopped and started again.
  // Same sequence SettingsTab.applyProviderConfig performs: write (the persist
  // owns the native mirror), then stop, then start, then probe and report only
  // what the probe says.
  const applyModelSwitch = async (m: { id: string; provider?: string }): Promise<void> => {
    if (modelSwitchBusyRef.current) return;
    // Never switch mid-stream: the restart path kills the live stream and
    // the no-restart path would still split one turn across two models.
    if (streaming) {
      showActionToast(tx('stillGenerating', 'Still generating, wait or stop first'), 'info');
      return;
    }
    const providerDiffers = !!m.provider && normProvider(m.provider) !== normProvider(settings.provider);
    const matchingProv = providerDiffers
      ? configuredProviders.find((p) => normProvider(p.provider) === normProvider(m.provider as string))
      : undefined;
    const patch =
      providerDiffers && !matchingProv ? { modelId: m.id, provider: m.provider } : { modelId: m.id };
    // Pin the last-used model into the owning profile's defaultModel, so it
    // survives everything that falls back to the default: app boot, provider
    // switches, profile edits, and the native mirror. It changes again only
    // when the user picks another model here or edits the profile form.
    // A model from a provider with no stored profile has no owner to pin.
    const pinId = matchingProv ? matchingProv.id : !providerDiffers ? settings.activeProviderId : '';
    const pinProviders = pinId
      ? configuredProviders.map((p) => (p.id === pinId ? { ...p, defaultModel: m.id } : p))
      : undefined;
    // The mirror rides inside the persist, so this counts the writes queued
    // below: the settings patch, plus activateProvider's own write when it runs.
    const writes = matchingProv ? 2 : 1;
    // Only a running on-device process is holding the old provider; a stopped
    // one reads the mirrored prefs on its next start. A model-only change
    // needs no restart at all: the model id rides in every turn request.
    const needsRestart = isNativeGateway() && connected && providerDiffers;
    const saveBefore = saveRevisionRef.current;
    const saveErrorBefore = saveErrorRef.current;

    modelSwitchBusyRef.current = true;
    setModelSwitching(true);
    setShowModelsSheet(false);
    try {
      updateSettings(pinProviders ? { ...patch, providers: pinProviders } : patch);
      if (matchingProv) {
        (activateProvider as (id: string, keepModelId?: string) => void)(matchingProv.id, m.id);
      }
      if (!needsRestart) return;

      // Do not restart before the mirror landed: starting with the previous
      // prefs would reproduce exactly the bug this restart exists to fix.
      const mirrorOk = await awaitSettingsWrite(saveBefore, writes);
      if (!mirrorOk) {
        const saveCopy = saveErrorRef.current && saveErrorRef.current !== saveErrorBefore ? saveErrorRef.current : null;
        showActionToast(
          saveCopy ||
            tx(
              'applyFailedPlain',
              'The change was saved, but Hermes did not pick it up. Restart Hermes, then try again.'
            ),
          'error'
        );
        return;
      }

      showActionToast(tx('applyingProviderPlain', 'Applying the change'), 'info');
      await stopGateway();
      await startGateway();
      // Claim nothing the app did not just verify: the health probe is the
      // restart verdict, the save verdict is the mirror the gateway reads.
      let up = false;
      try {
        up = await nativeHealth();
      } catch {
        up = false;
      }
      showActionToast(
        up
          ? tx('serverRestartedShort', 'Hermes restarted.')
          : tx('restartFailedPlain', 'Restart failed. Hermes is still not running.'),
        up ? 'success' : 'error'
      );
    } catch {
      // The change itself landed (the write above is local and is not rolled
      // back); what is missing is a running process that picked it up, so say
      // exactly that instead of blaming the write.
      showActionToast(
        tx(
          'applyFailedPlain',
          'The change was saved, but Hermes did not pick it up. Restart Hermes, then try again.'
        ),
        'error'
      );
    } finally {
      modelSwitchBusyRef.current = false;
      setModelSwitching(false);
    }
  };

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
      // Rails gate mid-stream with `disabled` (not a toast-on-tap); /retry
      // joins them so keyboard and screen-reader users meet the same wall.
      blockedWhileStreaming: true,
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
  const slashRailCommands = visibleSlashCommands;

  // Guarded one-shot send for starters + slash shortcuts (bypasses composer).
  const quickSend = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (!requireModel()) return;
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
      className={`flex flex-col flex-1 min-h-0 h-full overflow-x-clip ${
        // The 16px gutter every other tab uses, on every width; the old
        // px-3 below the sm breakpoint put chat 8px tighter than Settings.
        isDesktop ? 'max-w-4xl mx-auto w-full px-6' : 'px-4 md:max-w-3xl md:mx-auto md:w-full'
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
          className={`fixed top-[calc(4rem+env(safe-area-inset-top,0px))] start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] px-4 py-3 r-sm elev-2 t-caption font-semibold max-w-[90vw] break-words ${toastClass}`}
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
        className="relative flex-1 min-h-0 overflow-y-auto overflow-x-clip space-y-4 pe-1 pb-2 bg-[var(--app-bg)]"
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
                  title={
                    gatewayFailed && gatewayFailureReason
                      ? plainGatewayFailure(gatewayFailureReason, tx)
                      : undefined
                  }
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

            {/* Hacker-style suggestion strip: one line, tiny mono, horizontal scroll */}
            <div className="flex gap-1.5 w-full max-w-md pt-2 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]">
              {starterChips.map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => quickSend(chip)}
                  title={chip}
                  className="hack-chip shrink-0 px-2 py-1 r-sm bg-[var(--app-success-subtle)] border border-[var(--app-success-border)] font-mono text-[0.625rem] leading-4 text-[var(--app-success)] text-start transition hover:brightness-125 cursor-pointer max-w-[220px] overflow-hidden text-ellipsis"
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
                    {tx('openSettings', 'Open Settings')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          bubbleMessages.map((msg) => {
            const meta = turnMeta[msg.id];
            // Full model id, never truncated: the header shows the whole id
            // and wraps it instead of cutting it (see ChatMessageBubble).
            const modelLabel =
              meta && msg.sender !== 'you' ? (meta.model || '').trim() || null : null;
            const durationLabel =
              meta && meta.durationMs > 0
                ? `${meta.estimated ? '~' : ''}${formatDurationMs(meta.durationMs, tx('durUnderOneSecond', '<1s'))}`
                : null;
            // Failed turn, inline at its own position: the same failure card
            // as the banner (same copy, Retry on the retryLast path), so the
            // dead turn is never a silent empty bubble. Dismiss removes the
            // card, never the turn itself.
            if (isFailedEmptyTurn(msg) && !dismissedErrors.includes(msg.id)) {
              return renderFailureCard(
                meta?.error || '',
                () => setDismissedErrors((prev) => [...prev, msg.id]),
                msg.id
              );
            }
            // Regenerate lives on assistant turns and re-sends the user turn
            // that produced them, so it can never echo the reply back at the
            // model. Empty when no preceding user turn exists (then disabled).
            const regenerateSource =
              msg.sender === 'you'
                ? ''
                : (() => {
                    // Search and error bubbles both hide turns from this list,
                    // so walk the full conversation by id: re-send the user
                    // turn that produced this reply, never an older match.
                    const at = displayChat.findIndex((m) => m.id === msg.id);
                    if (at < 0) return '';
                    for (let i = at - 1; i >= 0; i--) {
                      if (displayChat[i].sender === 'you') return displayChat[i].content || '';
                    }
                    return '';
                  })();
            return (
              <ChatMessageBubble
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
                onRegenerate={(content) => {
                  // The bubble passes the source text; the payload lives in
                  // the turn map keyed by the preceding user message id.
                  const idx = chat.findIndex((x) => x.id === msg.id);
                  let imgs: string[] = [];
                  for (let i = idx - 1; i >= 0; i--) {
                    if (chat[i].sender === 'you') { imgs = turnImages(chat[i].id); break; }
                  }
                  onRegenerateMessage(content, imgs);
                }}
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
                {pendingApprovals.length === 1
                  ? tx('approvalsWaitingOne', '1 approval waiting for you')
                  : tx('approvalsWaitingMany', '{count} approvals waiting for you').replace(
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
            <p className="px-3 pb-3 t-caption text-[var(--app-warning)] break-words" title={pendingApprovals[0].summary}>
              {pendingApprovals[0].summary}
            </p>
          )}
          {approvalsExpanded && (
            <div className="px-3 pb-3 space-y-3">
              {pendingApprovals.map((approval) => (
                <div key={approvalKey(approval)} className="space-y-2">
                  <ApprovalCard
                    approval={approval}
                    error={approvalFailures[approvalKey(approval)]}
                    resolving={resolvingRunId === approvalKey(approval)}
                    confirmingScope={
                      confirmArm?.key === approvalKey(approval) ? confirmArm.scope : null
                    }
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
                : gatewayOffline
                  // No Send-now offered offline: the button above is disabled
                  // there, so the copy must not promise it.
                  ? tx('queuedOfflineHintPlain', 'Waiting. Sends automatically when the connection is back.')
                  : tx('queuedManualHintPlain', 'Waiting. Sends automatically when the connection is back, or tap Send now.')}
            </span>
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {/* Offline the button would only toast a refusal, so disable it
                and let the hint below name the automatic path instead. */}
            <button
              onClick={sendFirstQueued}
              disabled={streaming || gatewayOffline}
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
                className="absolute -top-1 -end-1 w-7 h-7 rounded-full flex items-center justify-center text-[var(--app-on-accent)] cursor-pointer"
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

      {/* Slash command helpers: visible while the composer has focus, or as
          soon as the text starts a / command. Grouped so app actions are never
          mistaken for messages sent to the model. They used to sit above every
          empty composer, including a field nobody was typing into. */}
      {(composerFocused || text.startsWith('/')) && visibleSlashCommands.length > 0 && (
        <div
          ref={railsRef}
          role="toolbar"
          aria-label={tx('slashCommandsLabel', 'Slash commands')}
          onFocus={() => setComposerFocused(true)}
          className="mb-2 shrink-0 flex gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]"
        >
          {slashRailCommands.map((cmd) => {
            const blocked = streaming && (cmd.kind === 'message' || !!cmd.blockedWhileStreaming);
            return (
              <button
                key={cmd.label}
                onClick={cmd.run}
                // Tapping a rail must not blur the composer: the rails
                // hang off focus, so a blur here would unmount them before
                // this click lands.
                onMouseDown={(e) => e.preventDefault()}
                disabled={blocked}
                title={blocked ? tx('stopTurnFirst', 'Stop the current turn first.') : cmd.hint}
                aria-label={`${cmd.label}: ${
                  blocked ? tx('stopTurnFirst', 'Stop the current turn first.') : cmd.hint
                }`}
                className={`hack-chip shrink-0 px-2 py-1 r-sm font-mono text-[0.625rem] leading-4 border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  cmd.kind === 'message'
                    ? 'bg-[var(--app-info-subtle)] border-[var(--app-info-border)] text-[var(--app-info)]'
                    : 'bg-[var(--app-success-subtle)] border-[var(--app-success-border)] text-[var(--app-success)]'
                } hover:brightness-125`}
              >
                {cmd.label}
              </button>
            );
          })}
        </div>
      )}
      </div>

      {/* 4. Integrated Floating Input Bar Component matching code.html */}
      <div className="glass-input-card rounded-2xl p-2.5 shadow-2xl flex flex-col gap-2.5 shrink-0 mb-1">
        {/* Main Text Input Field */}
        <div className="flex items-center w-full px-1">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onFocus={() => setComposerFocused(true)}
            onBlur={(e) => {
              // Focus moving into the rails keeps them up; anywhere else hides
              // them. Without this a tap on a rail would race its own unmount.
              const next = e.relatedTarget as HTMLElement | null;
              if (next && railsRef.current?.contains(next)) return;
              setComposerFocused(false);
            }}
            onKeyDown={(e) => {
              // Enter inserts a newline; sending is only via the send
              // button, so multi-line messages stay editable.
              if (e.key === 'Enter' && !e.shiftKey) {
                if ((e.nativeEvent as unknown as { isComposing?: boolean })?.isComposing || e.keyCode === 229) return;
              }
            }}
            placeholder={tx('askHermesPlaceholder', 'Message…')}
            aria-label={tx('askHermesLabel', 'Message Hermes')}
            aria-describedby="composer-hint"
            className="w-full bg-transparent border-none text-[15px] font-medium text-[var(--app-text)] placeholder:text-[var(--app-text-dim)] caret-[var(--app-chat-you)] focus:outline-none focus:ring-0 resize-none p-0 min-h-[28px] max-h-[160px]"
          />
        </div>
        <p id="composer-hint" className="sr-only">
          {tx('composerHint', 'Enter adds a new line. Send with the send button.')}
        </p>

        {/* Action Tools & Model Controls Row */}
        <div
          role="group"
          aria-label={tx('composerSettings', 'Model and reasoning effort')}
          className="flex items-center justify-between gap-1.5 sm:gap-2 pt-1.5 border-t border-[var(--app-border-subtle)]"
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImageAttach}
            accept="image/jpeg,image/png,image/webp,image/gif,text/plain,.txt,.md,.markdown,.csv,.json"
            multiple
            className="hidden"
          />
          {/* Left Controls: Add Attachment, Model Dropdown Selection, and Parameters */}
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attaching}
              className={`w-9 h-9 min-w-[36px] rounded-xl bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] border border-[var(--app-border)] text-[var(--app-text-muted)] hover:text-[var(--app-text)] flex items-center justify-center transition active:scale-95 shrink-0 ${
                attaching ? 'opacity-60 cursor-wait' : 'cursor-pointer'
              }`}
              title={
                attaching
                  ? tx('attachingFiles', 'Adding files…')
                  : tx('attachAction', 'Attach an image or a text file')
              }
              aria-label={
                attaching
                  ? tx('attachingFiles', 'Adding files…')
                  : tx('attachAction', 'Attach an image or a text file')
              }
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
            </button>

            {/* Model Badge Pill / Dropdown Selector */}
            <button
              type="button"
              onClick={() => setShowModelsSheet(true)}
              disabled={modelSwitching}
              aria-busy={modelSwitching}
              title={
                modelSwitching
                  ? tx('applyingProviderPlain', 'Applying the change')
                  : settings.modelId || t('noModel')
              }
              aria-label={
                modelSwitching
                  ? tx('applyingProviderPlain', 'Applying the change')
                  : `${tx('activeModel', 'Active model')}: ${
                      settings.modelId ? curModelName : t('noModel')
                    }. ${tx('opensModelList', 'Opens the model list.')}`
              }
              className={`h-9 px-2.5 sm:px-3 rounded-xl bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] border border-[var(--app-border)] flex items-center gap-1.5 t-caption text-[var(--app-text)] transition active:scale-95 min-w-0 flex-1 max-w-[170px] ${
                modelSwitching ? 'cursor-wait opacity-70' : 'cursor-pointer'
              }`}
            >
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-[var(--app-chat-violet)] shrink-0" />
              <span className="font-medium truncate min-w-0">{settings.modelId ? curModelName : t('noModel')}</span>
              {modelSwitching ? (
                <RefreshCw className="w-3.5 h-3.5 text-[var(--app-text-dim)] shrink-0 animate-spin" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-[var(--app-text-dim)] shrink-0" />
              )}
            </button>

            {/* Parameters Filter / Sliders Button */}
            <button
              type="button"
              onClick={() => setShowEffortSheet(true)}
              title={`${tx('reasoningEffortPlain', 'Reasoning effort')}: ${effortLabel}`}
              aria-label={`${tx('reasoningEffortPlain', 'Reasoning effort')}: ${effortLabel}. ${tx(
                'opensEffortOptions',
                'Opens the reasoning effort options.'
              )}`}
              className="w-9 h-9 min-w-[36px] rounded-xl bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] border border-[var(--app-border)] text-[var(--app-text-muted)] hover:text-[var(--app-chat-violet-light)] flex items-center justify-center transition active:scale-95 shrink-0 cursor-pointer"
            >
              <Sliders className="w-4 h-4" />
            </button>
          </div>

          {/* Right Controls: Voice Input & Send Action */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ms-auto">
            {/* Voice Input Button */}
            <button
              type="button"
              onClick={toggleVoice}
              className={`w-9 h-9 min-w-[36px] rounded-xl flex items-center justify-center transition active:scale-95 cursor-pointer border ${
                isListening
                  ? 'bg-[var(--app-danger-subtle)] border-[var(--app-danger-border)] text-[var(--app-danger)] animate-pulse'
                  : 'bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] border-[var(--app-border)] text-[var(--app-text-muted)] hover:text-[var(--app-chat-you)]'
              }`}
              title={isListening ? tx('voiceListening', 'Listening…') : tx('voiceDictation', 'Voice dictation')}
              aria-label={
                isListening
                  ? tx('voiceStop', 'Stop voice dictation')
                  : tx('voiceStart', 'Start voice dictation')
              }
              aria-pressed={isListening}
            >
              <Mic className="w-4 h-4" />
            </button>

            {/* Send / Stop Generation Button */}
            {streaming ? (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] text-[var(--app-warning)] px-2 py-1 rounded-xl bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 animate-spin" />
                  <span>{streamElapsed < 1 ? tx('durUnderOneSecond', '<1s') : `${streamElapsed}s`}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const dropped = queuedMessages.length;
                    void stopStream();
                    if (dropped > 0)
                      showActionToast(
                        tx('stopDroppedQueued', '{count} waiting message(s) discarded by the stop').replace('{count}', String(dropped)),
                        'info'
                      );
                  }}
                  className="w-9 h-9 min-w-[36px] rounded-xl bg-[var(--app-danger-solid)] hover:brightness-110 text-[var(--app-on-danger)] flex items-center justify-center transition active:scale-95 cursor-pointer shrink-0"
                  title={tx('stopGenerating', 'Stop generating')}
                  aria-label={tx('stopGenerating', 'Stop generating')}
                >
                  <Square className="w-3 h-3 fill-current" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleSend('button')}
                disabled={!canSendNow}
                aria-disabled={!canSendNow}
                title={sendHint}
                aria-label={sendHint}
                className={`w-9 h-9 min-w-[36px] rounded-xl flex items-center justify-center transition active:scale-95 shrink-0 ${
                  canSendNow
                    ? 'bg-gradient-to-tr from-[var(--app-chat-violet)] to-[var(--app-accent)] hover:brightness-110 text-[var(--app-on-accent)] shadow-glow-purple cursor-pointer'
                    : 'bg-[var(--app-send-off-bg)] text-[var(--app-text-dim)] border border-[var(--app-send-off-border)] cursor-not-allowed opacity-60'
                }`}
              >
                {/* Heroicons paperplane rotated 90deg in LTR and 270deg in RTL */}
                <svg
                  className="w-4 h-4 rotate-90 transform translate-x-0.5 rtl:rotate-[270deg] rtl:-translate-x-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
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
            className="w-full sm:w-[430px] r-lg elev-3 edge bg-[var(--app-bg)] p-4 sm:p-5 flex flex-col max-h-[85vh] sm:max-h-[80vh] animate-in slide-in-from-bottom-4 duration-200"
          >
            {/* Top Pull Bar / Handle */}
            <div className="w-10 h-1 bg-[var(--app-border)] rounded-full mx-auto mb-3 shrink-0 sm:hidden" />

            {/* Header: Title + count badge & Close button */}
            <div className="flex items-start justify-between pb-3 shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <h2 className="t-heading text-[var(--app-accent-text)] font-mono font-medium tracking-tight truncate">
                    {tx('modelSheetTitle', 'Pick a model')}
                  </h2>
                  <span className="t-micro font-mono px-2 py-0.5 rounded-full border border-[var(--app-chip-border)] text-[var(--app-text-muted)] shrink-0">
                    {tx('modelCount', '{shown} of {total} models')
                      .replace('{shown}', String(filteredModels.length))
                      .replace('{total}', String(models.length))}
                  </span>
                </div>
                {/* Honest live-catalog status: the static rows stay visible, but
                    honest banners say WHY the list is fallback (bad key / 401, offline, etc.)
                    with a manual refresh trigger. */}
                {modelsLiveInfo.error === 'auth' || modelsLiveInfo.error?.includes('401') ? (
                  <div className="flex items-center justify-between gap-2 mt-2 px-3 py-2 r-sm bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--app-danger)] shrink-0" />
                      <p className="t-caption text-[var(--app-danger-text)] font-mono truncate">
                        {tx('modelLiveAuthFailed', 'Authentication failed (HTTP 401): check API key')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshModels()}
                      disabled={modelsLiveInfo.isRefreshing}
                      aria-label={tx('refreshCatalogAction', 'Refresh catalog')}
                      className="text-[var(--app-danger-text)] hover:opacity-80 p-1 cursor-pointer shrink-0 disabled:opacity-40"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${modelsLiveInfo.isRefreshing ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                ) : modelsLiveInfo.error === 'network' ? (
                  <div className="flex items-center justify-between gap-2 mt-2 px-3 py-2 r-sm bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--app-danger)] shrink-0" />
                      <p className="t-caption text-[var(--app-danger-text)] font-mono truncate">
                        {tx('modelLiveOffline', 'Live catalog unreachable (offline)')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshModels()}
                      disabled={modelsLiveInfo.isRefreshing}
                      aria-label={tx('refreshCatalogAction', 'Refresh catalog')}
                      className="text-[var(--app-danger-text)] hover:opacity-80 p-1 cursor-pointer shrink-0 disabled:opacity-40"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${modelsLiveInfo.isRefreshing ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                ) : modelsLiveInfo.error ? (
                  <div className="flex items-center justify-between gap-2 mt-2 px-3 py-2 r-sm bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--app-danger)] shrink-0" />
                      <p className="t-caption text-[var(--app-danger-text)] font-mono truncate">
                        {tx('modelLiveFailed', 'Live catalog failed ({code})').replace('{code}', modelsLiveInfo.error)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshModels()}
                      disabled={modelsLiveInfo.isRefreshing}
                      aria-label={tx('refreshCatalogAction', 'Refresh catalog')}
                      className="text-[var(--app-danger-text)] hover:opacity-80 p-1 cursor-pointer shrink-0 disabled:opacity-40"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${modelsLiveInfo.isRefreshing ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                ) : modelsLiveInfo.liveCount > 0 ? (
                  <div className="flex items-center justify-between gap-2 mt-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--app-accent)] shrink-0" />
                      <p className="t-caption text-[var(--app-text-muted)] font-mono truncate">
                        {tx('modelLiveOk', '{n} live models from the gateway').replace('{n}', String(modelsLiveInfo.liveCount))}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshModels()}
                      disabled={modelsLiveInfo.isRefreshing}
                      aria-label={tx('refreshCatalogAction', 'Refresh catalog')}
                      className="text-[var(--app-text-muted)] hover:text-[var(--app-text)] p-1 cursor-pointer shrink-0 disabled:opacity-40"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${modelsLiveInfo.isRefreshing ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 mt-2 px-3 py-1.5 r-sm bg-[var(--app-card-subtle)] edge">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--app-text-dim)] shrink-0" />
                      <p className="t-caption text-[var(--app-text-muted)] font-mono truncate">
                        {tx('modelOfflineFallbackActive', 'Showing offline fallback catalog')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshModels()}
                      disabled={modelsLiveInfo.isRefreshing}
                      aria-label={tx('refreshCatalogAction', 'Refresh catalog')}
                      className="text-[var(--app-text-muted)] hover:text-[var(--app-text)] p-1 cursor-pointer shrink-0 disabled:opacity-40"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${modelsLiveInfo.isRefreshing ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                )}
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
                      disabled={streaming}
                      onClick={() => {
                        // The restart runs inside applyModelSwitch, so the
                        // busy state has to outlive this click.
                        void applyModelSwitch(m);
                      }}
                      className={`w-full flex flex-col p-4 r-sm border text-start transition cursor-pointer group active:scale-[0.99] ${
                        isSelected
                          ? 'bg-[var(--app-accent-subtle)] border-[var(--app-accent)] ring-1 ring-[var(--app-accent)]'
                          : 'bg-[var(--app-card-subtle)] border-[var(--app-border)] hover:border-[var(--app-accent-border)]'
                      } text-[var(--app-text)]`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-[var(--app-text)] t-body tracking-tight group-hover:text-[var(--app-accent-text)] transition-colors truncate">
                            {m.displayName}
                          </span>
                          <span className="t-micro font-mono font-medium shrink-0 px-2 py-0.5 rounded-full border border-[var(--app-accent-border)] text-[var(--app-accent-text)]">
                            {badgeLabel}
                          </span>
                          {m.source === 'live' ? (
                            <span className="t-micro font-mono shrink-0 px-1.5 py-0.2 rounded border border-[var(--app-chip-border)] text-[var(--app-accent-text)]">
                              {tx('modelTagLive', 'Live')}
                            </span>
                          ) : m.source === 'offline-fallback' ? (
                            <span className="t-micro font-mono shrink-0 px-1.5 py-0.2 rounded border border-[var(--app-chip-border)] text-[var(--app-text-dim)]">
                              {tx('modelTagFallback', 'Fallback')}
                            </span>
                          ) : null}
                        </div>
                        {isSelected && (
                          <span className="w-5 h-5 rounded-full bg-[var(--app-accent)] text-[var(--app-on-accent)] flex items-center justify-center shrink-0">
                            <Check className="w-3 h-3 stroke-[3]" />
                          </span>
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
