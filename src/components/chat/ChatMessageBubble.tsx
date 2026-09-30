import React, { memo, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  GitFork,
  MoreHorizontal,
  RefreshCw,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import type { ChatMessage } from '../../types/hermes';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolExecutionsBlock } from './ToolExecutionsBlock';
import { formatMessageClock } from './messageClock';
import { withFallback, type Translate } from './translate';

export interface ChatMessageBubbleProps {
  msg: ChatMessage;
  /** This row is the tail of the live stream. */
  isLiveTail: boolean;
  modelLabel: string | null;
  durationLabel: string | null;
  formulatingLabel: string;
  copied: boolean;
  speaking: boolean;
  menuOpen: boolean;
  /** A turn is streaming right now, on this row or another one. */
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
  t: Translate;
}

interface ContentPart {
  text: string;
  isCode: boolean;
  lang: string;
}

/**
 * Split a reply on ``` fences so code gets its own bordered surface while the
 * prose stays selectable text. A fence only opens at a line start, or mid-line
 * when a newline follows before the closing fence: a ``` typed inline in a
 * sentence must never swallow the rest of the paragraph (or the rest of the
 * reply) into a code block. An unterminated fence at the end of a streaming
 * reply is treated as code too, so a half arrived block does not show raw
 * fence markers. An empty fence is literal prose, never an empty bordered box.
 */
const splitCodeFences = (content: string): ContentPart[] => {
  if (!content.includes('```')) return [{ text: content, isCode: false, lang: '' }];

  const parts: ContentPart[] = [];
  const atLineStart = (index: number) => index === 0 || content[index - 1] === '\n';
  let proseStart = 0;
  let from = 0;

  for (;;) {
    // First fence that really opens a block; anything else is literal text.
    let openAt = -1;
    for (let i = content.indexOf('```', from); i >= 0; i = content.indexOf('```', i + 3)) {
      const nextClose = content.indexOf('```', i + 3);
      const lineBreak = content.indexOf('\n', i + 3);
      const infoEnd = lineBreak >= 0 && (nextClose < 0 || lineBreak < nextClose) ? lineBreak : nextClose;
      const info = infoEnd >= 0 ? content.slice(i + 3, infoEnd) : '';
      // A mid-line fence only opens when a newline follows before the close,
      // so a ```inline``` run stays literal instead of swallowing the rest
      // of the paragraph into a code block.
      const midLineOpen =
        nextClose > 0 && !/\s/.test(info) && lineBreak >= 0 && lineBreak < nextClose;
      if (atLineStart(i) || midLineOpen) {
        openAt = i;
        break;
      }
    }
    if (openAt < 0) break;

    const closeAt = content.indexOf('```', openAt + 3);
    if (openAt > proseStart) {
      parts.push({ text: content.slice(proseStart, openAt), isCode: false, lang: '' });
    }
    const lineBreak = content.indexOf('\n', openAt + 3);
    const hasLine = lineBreak >= 0 && (closeAt < 0 || lineBreak < closeAt);
    const langEnd = hasLine ? lineBreak : closeAt >= 0 ? closeAt : content.length;
    const bodyEnd = closeAt >= 0 ? closeAt : content.length;
    // Without a newline the info string runs straight into the closing fence,
    // so the body starts there instead of swallowing the language tag.
    const bodyStart = hasLine ? lineBreak + 1 : bodyEnd;
    const bodyText = content.slice(bodyStart, bodyEnd).replace(/[\r\n]+$/, '');
    if (!bodyText) {
      // An empty pair or a bare marker is literal prose, never an empty
      // bordered box.
      parts.push({ text: content.slice(proseStart, openAt + 3), isCode: false, lang: '' });
      proseStart = openAt + 3;
      from = proseStart;
      continue;
    }
    parts.push({
      text: bodyText,
      isCode: true,
      lang: content.slice(openAt + 3, langEnd).trim(),
    });

    if (closeAt < 0) {
      proseStart = content.length;
      break;
    }
    proseStart = closeAt + 3;
    from = proseStart;
  }

  if (proseStart < content.length) {
    parts.push({ text: content.slice(proseStart), isCode: false, lang: '' });
  }

  return parts.length > 0 ? parts : [{ text: content, isCode: false, lang: '' }];
};

/** One prose run: either plain text or a backtick delimited inline code run. */
interface InlineSegment {
  text: string;
  isCode: boolean;
}

/**
 * Split one prose run on paired single backticks so `npm run build` prints as
 * inline code instead of showing its delimiters. Triple fences never reach
 * here (splitCodeFences already gave them their own surface), so a run of two
 * or more backticks is left literal, and so is an unpaired backtick: a half
 * arrived reply must not swallow the rest of the line into code. A pair only
 * opens when its content stays on one line, which keeps the block layout of
 * whitespace-pre-wrap prose intact. Concatenating the segments reproduces the
 * input exactly, so no character is ever dropped.
 */
const splitInlineCode = (text: string): InlineSegment[] => {
  const segments: InlineSegment[] = [];
  let plainStart = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    // Measure the whole backtick run: only a run of one can open or close.
    let run = 0;
    while (i + run < text.length && text[i + run] === '`') run += 1;
    if (run !== 1) {
      i += run;
      continue;
    }

    // Look ahead for a closing run of exactly one backtick on the same line.
    let close = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\n') break;
      if (text[j] !== '`') continue;
      let closeRun = 0;
      while (j + closeRun < text.length && text[j + closeRun] === '`') closeRun += 1;
      if (closeRun === 1) {
        close = j;
        break;
      }
      j += closeRun - 1;
    }

    if (close < 0) {
      // No partner on this line: the backtick is ordinary text.
      i += 1;
      continue;
    }
    if (i > plainStart) segments.push({ text: text.slice(plainStart, i), isCode: false });
    segments.push({ text: text.slice(i + 1, close), isCode: true });
    plainStart = close + 1;
    i = close + 1;
  }

  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), isCode: false });
  return segments.length > 0 ? segments : [{ text, isCode: false }];
};

/**
 * One chat message, in the Hermes Control shape: a label line (name, model and
 * turn state, then the message clock) inside the bubble, an optional reasoning
 * block, an optional tool block, and the answer itself.
 *
 * User turns are filled accent bubbles on the end side, replies are full width
 * cards on the start side. Memoized so a 50ms streaming flush only re-renders
 * the live tail instead of every bubble on the screen.
 */
export const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = memo(
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
    const tx = withFallback(t);
    const isUser = msg.sender === 'you';
    // The live badge and the reasoning pulse belong to the turn that is still
    // arriving, never to a finished bubble further up the transcript.
    const live = isLiveTail && streamBusy;
    const timeLabel = formatMessageClock(msg.timestamp);
    // Local history is persisted JSON and an older build can hand back a
    // record without a body; one missing field must not take the whole
    // transcript down at render time.
    const content = typeof msg.content === 'string' ? msg.content : '';
    const parts = useMemo(() => splitCodeFences(content), [content]);

    // Actions are revealed on tap (or Enter when the row has focus) instead of
    // adding a full action band under every bubble on a phone screen.
    const [actionsOpen, setActionsOpen] = useState(false);
    const showActions = actionsOpen || menuOpen;

    const handleBubbleClick = (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      // Never steal a tap meant for a control, a menu, or a text selection.
      if (target.closest('button, a, input, textarea, summary, [role="menu"]')) return;
      if ((window.getSelection?.()?.toString() || '').length > 0) return;
      setActionsOpen((value) => !value);
    };

    const handleBubbleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && actionsOpen) {
        setActionsOpen(false);
        return;
      }
      // Enter/Space only toggle the actions while the bubble itself holds
      // focus. A focused menu item keeps its own native activation, so its
      // default action must not be cancelled by the bubble handler.
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setActionsOpen((value) => !value);
      }
    };

    // The model id is never cut mid-word visually: it truncates with ellipsis
    // inside a capped badge while the full id stays in title for copy/read.
    const modelAndDuration = [modelLabel, durationLabel].filter(Boolean).join(' · ');

    return (
      // Logical end/start alignment: the user turn hugs the inline end in
      // both LTR and RTL. Physical items-end would pin it to the physical
      // right under RTL instead.
      <div
        className={`flex flex-col ${isUser ? '[align-items:end]' : '[align-items:start]'}`}
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
        {/* Sender meta header, mockup shape: icon box + HERMES + model badge
            + latency chip on the start side, clock plus compact copy and
            read-aloud on the end side for replies, always visible. User turns
            keep a tight YOU + clock line. */}
        {isUser ? (
          <div className="w-full flex items-center [justify-content:end] gap-2 mb-1 pe-1 text-[0.6875rem] font-medium text-[var(--app-chat-violet-light)]">
            <span className="tracking-wider uppercase font-semibold text-[var(--app-chat-violet-light)]">
              {tx('you', 'You')}
            </span>
            {timeLabel && <span className="font-mono text-[var(--app-text-dim)]">{timeLabel}</span>}
          </div>
        ) : (
          <div className="w-full flex items-center justify-between gap-1.5 mb-1.5 px-0.5 text-xs">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                aria-hidden="true"
                className="w-5 h-5 rounded-md bg-[var(--app-chat-violet)]/20 border border-[var(--app-chat-violet)]/40 flex items-center justify-center text-[var(--app-chat-violet-light)] shrink-0"
              >
                <Zap className="w-3 h-3 fill-current" />
              </span>
              <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-[var(--app-chat-violet-light)] truncate max-w-[110px]">
                {tx('hermesAgent', 'Hermes Agent')}
              </span>
              {modelLabel && (
                <span
                  className="text-[0.5625rem] font-mono uppercase px-1.5 py-0.5 rounded border border-[var(--app-chat-violet)]/40 bg-[var(--app-chat-violet)]/20 text-[var(--app-chat-violet-light)] whitespace-nowrap shrink-0 max-w-[120px] truncate"
                  dir="ltr"
                  title={estimated ? `${modelAndDuration}. ${estimatedHint}` : modelAndDuration}
                >
                  {modelLabel}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 text-[var(--app-text-muted)] shrink-0">
              {stopped && (
                <span className="pill-warning" title={stoppedHint}>
                  {stoppedLabel}
                </span>
              )}
              {live && (
                <span
                  className="pill-warning"
                  role="status"
                  aria-label={tx('streamingBadge', 'Streaming')}
                >
                  <span
                    aria-hidden="true"
                    className="w-1.5 h-1.5 rounded-full bg-[var(--app-warning)] animate-pulse"
                  />
                  {tx('streamingBadge', 'Streaming')}
                </span>
              )}
              {(durationLabel || timeLabel) && (
                <div className="flex items-center gap-1 font-mono text-[10px] text-[var(--app-text-dim)] bg-[var(--app-card)]/80 px-1.5 py-0.5 rounded border border-[var(--app-border-subtle)] whitespace-nowrap" dir="ltr">
                  {durationLabel && <span>{durationLabel}</span>}
                  {durationLabel && timeLabel && <span className="text-[var(--app-border)]">·</span>}
                  {timeLabel && <span>{timeLabel}</span>}
                </div>
              )}
              <button
                onClick={() => onCopy(msg.id, content)}
                disabled={!content.trim()}
                className="p-1 rounded text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hm-hit"
                title={content.trim() ? t('copy') : copyUnavailableLabel}
                aria-label={content.trim() ? t('copy') : copyUnavailableLabel}
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-[var(--app-success)]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                onClick={() => onSpeak(msg.id, content)}
                disabled={!content.trim()}
                className="p-1 rounded text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hm-hit"
                title={speaking ? tx('stopReading', 'Stop reading out loud') : tx('readAloud', 'Read aloud')}
                aria-label={speaking ? tx('stopReading', 'Stop reading out loud') : tx('readAloud', 'Read aloud')}
              >
                {speaking ? (
                  <VolumeX className="w-3.5 h-3.5 text-[var(--app-danger)]" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        )}
        {/* Roving focus: the row owns tabIndex 0, the bubble is reachable by
            tap or programmatic focus and passes Enter/Space through to the
            same toggle via key bubbling. */}
        <div
          role="article"
          aria-label={isUser ? tx('yourMessage', 'Your message') : tx('hermesResponse', 'Reply from Hermes')}
          tabIndex={-1}
          onKeyDown={handleBubbleKeyDown}
          className={`relative overflow-hidden transition-all ${
            isUser
              ? 'w-fit max-w-[80%] bg-gradient-to-r from-[var(--app-chat-violet)] to-[var(--app-accent)] border border-[var(--app-chat-violet)]/30 text-[var(--app-on-accent)] px-4 py-2.5 rounded-2xl rounded-se-sm shadow-md shadow-[var(--app-chat-violet)]/20'
              : 'w-full bg-[var(--app-card)]/90 border border-[var(--app-border)]/80 rounded-2xl rounded-ss-sm p-3.5 shadow-lg relative overflow-hidden backdrop-blur-sm text-[var(--app-text)]'
          }`}
        >
          {/* Mockup glow blob, replies only, never intercepting taps. */}
          {!isUser && (
            <div
              aria-hidden="true"
              className="absolute -top-12 -end-12 w-28 h-28 rounded-full blur-2xl bg-[var(--app-chat-violet)]/10 pointer-events-none"
            />
          )}

          {/* Reasoning first, then tool activity, then the answer. */}
          {msg.thinking && (
            <ThinkingBlock thinking={msg.thinking} isDone={msg.thinkingDone !== false} t={t} />
          )}

          {(msg.tools?.length ?? 0) > 0 && (
            <ToolExecutionsBlock
              tools={msg.tools ?? []}
              toolOutputs={msg.toolOutputs ?? []}
              live={live}
              t={t}
            />
          )}

          {content ? (
            <div className={`relative flex flex-col gap-2 t-body font-medium select-text ${isUser ? 'text-[var(--app-on-accent)]' : 'text-[var(--app-text)]'}`}>
              {parts.map((part, index) => {
                const isLast = index === parts.length - 1;
                const caret =
                  live && !isUser && isLast ? (
                    <span
                      aria-hidden="true"
                      className="inline-block w-1.5 h-4 ms-1 bg-[var(--app-accent)] animate-pulse align-middle"
                    />
                  ) : null;

                if (part.isCode) {
                  return (
                    <div key={index} dir="ltr" className="r-sm edge bg-[var(--app-bg)] overflow-hidden">
                      {part.lang && (
                        <div className="px-3 py-1 t-micro font-mono text-[var(--app-text-dim)] border-b border-[var(--app-border-subtle)]">
                          {part.lang}
                        </div>
                      )}
                      <div className="px-3 py-2 overflow-x-auto">
                        {/* The caret rides inside the pre formatted block so it
                            sits at the end of the last code line instead of
                            dropping onto a line of its own. */}
                        <code className="block t-caption font-mono text-[var(--app-text)] whitespace-pre">
                          {part.text}
                          {caret}
                        </code>
                      </div>
                    </div>
                  );
                }

                if (!part.text) return null;

                // Prose runs in sans like the mockup thread; inline code keeps
                // its tinted chip so it still stands out from the reply text,
                // and the fences around it are stripped.
                return (
                  <div
                    key={index}
                    dir="auto"
                    className="t-body font-medium whitespace-pre-wrap break-words [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
                  >
                    {splitInlineCode(part.text).map((segment, segIndex) =>
                      segment.isCode ? (
                        <code
                          key={segIndex}
                          className="font-mono r-xs bg-[var(--app-card-subtle)] px-1 py-0.5 [unicode-bidi:plaintext]"
                        >
                          {segment.text}
                        </code>
                      ) : (
                        <React.Fragment key={segIndex}>{segment.text}</React.Fragment>
                      )
                    )}
                    {caret}
                  </div>
                );
              })}
            </div>
          ) : live && !isUser ? (
            <div className="flex items-center gap-2 t-caption text-[var(--app-text-muted)] py-1">
              <span
                aria-hidden="true"
                className="w-2 h-2 rounded-full bg-[var(--app-accent)] animate-ping"
              />
              <span>{formulatingLabel}</span>
            </div>
          ) : null}

          {/* Message actions: revealed on tap and separated from the text by
              spacing only (no rule under the bubble). Regenerate belongs to
              replies and resends the prompt that produced them; user turns
              keep copy and the overflow menu. */}
          {showActions && (
            <div className="relative flex items-center [justify-content:end] gap-2 mt-2">
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
              {isUser && (
              <>
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
                    <button
                      onClick={() => {
                        onCopy(msg.id, content);
                        onToggleMenu(null);
                      }}
                      role="menuitem"
                      disabled={!content.trim()}
                      className="w-full min-h-[44px] px-4 py-2 flex items-center gap-2 text-start t-caption text-[var(--app-text)] hover:bg-[var(--app-card-hover)] transition cursor-pointer disabled:opacity-40"
                    >
                      {copied ? (
                        <Check className="w-4 h-4 text-[var(--app-success)]" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                      <span>{content.trim() ? t('copy') : copyUnavailableLabel}</span>
                    </button>
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
                </div>
              )}
              </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
);

ChatMessageBubble.displayName = 'ChatMessageBubble';
