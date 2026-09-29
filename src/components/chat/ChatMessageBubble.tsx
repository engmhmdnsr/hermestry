import React, { memo, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  GitFork,
  MoreHorizontal,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { ChatMessage } from '../../types/hermes';
import { BrandMark } from './BrandMark';
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
 * prose stays selectable text. An unterminated fence at the end of a streaming
 * reply is treated as code too, so a half arrived block does not show raw
 * fence markers.
 */
const splitCodeFences = (content: string): ContentPart[] => {
  if (!content.includes('```')) return [{ text: content, isCode: false, lang: '' }];

  const parts: ContentPart[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(content)) !== null) {
    if (match.index > lastEnd) {
      parts.push({ text: content.slice(lastEnd, match.index), isCode: false, lang: '' });
    }
    parts.push({ text: match[2].replace(/\n+$/, ''), isCode: true, lang: match[1].trim() });
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < content.length) {
    const tail = content.slice(lastEnd);
    const openAt = tail.indexOf('```');
    if (openAt >= 0) {
      if (openAt > 0) parts.push({ text: tail.slice(0, openAt), isCode: false, lang: '' });
      const afterTicks = tail.slice(openAt + 3);
      const lineBreak = afterTicks.indexOf('\n');
      parts.push({
        text: lineBreak >= 0 ? afterTicks.slice(lineBreak + 1) : '',
        isCode: true,
        lang: lineBreak >= 0 ? afterTicks.slice(0, lineBreak).trim() : afterTicks.trim(),
      });
    } else {
      parts.push({ text: tail, isCode: false, lang: '' });
    }
  }

  return parts.length > 0 ? parts : [{ text: content, isCode: false, lang: '' }];
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
    const parts = useMemo(() => splitCodeFences(msg.content), [msg.content]);

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
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setActionsOpen((value) => !value);
        return;
      }
      if (event.key === 'Escape' && actionsOpen) {
        setActionsOpen(false);
      }
    };

    const modelAndDuration = [modelLabel, durationLabel].filter(Boolean).join(' · ');

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
        <div
          role="article"
          aria-label={isUser ? tx('yourMessage', 'Your message') : tx('hermesResponse', 'Reply from Hermes')}
          className={`r-md elev-0 p-3 text-[var(--app-text)] transition-all ${
            isUser
              ? 'w-fit max-w-[85%] bg-[var(--app-accent-subtle)] edge'
              : 'w-full bg-[var(--app-card)] edge'
          }`}
        >
          {/* Label line: who wrote this, on which model, in what state, and
              when. It sits inside the bubble above the content with spacing
              only, so a one word message still reads as a message. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5">
            {!isUser && <BrandMark />}
            <span className="t-micro text-[var(--app-text-dim)]">
              {isUser ? tx('you', 'You') : tx('hermesAgent', 'Hermes Agent')}
            </span>
            {!isUser && modelAndDuration && (
              <span
                className="t-caption font-mono text-[var(--app-text-dim)] truncate min-w-0"
                title={estimated ? estimatedHint : undefined}
              >
                {modelAndDuration}
              </span>
            )}
            <span className="ms-auto flex items-center gap-2 shrink-0">
              {!isUser && stopped && (
                <span className="pill-warning" title={stoppedHint}>
                  {stoppedLabel}
                </span>
              )}
              {!isUser && live && (
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
              {timeLabel && (
                <span className="t-micro text-[var(--app-text-dim)] tabular-nums">{timeLabel}</span>
              )}
            </span>
          </div>

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

          {msg.content ? (
            <div
              className="flex flex-col gap-2 t-body text-[var(--app-text)] select-text"
              style={{ fontSize: 'var(--msg-font-size)', lineHeight: 1.5 }}
            >
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
                        <code className="block t-caption font-mono text-[var(--app-text)] whitespace-pre">
                          {part.text}
                        </code>
                        {caret}
                      </div>
                    </div>
                  );
                }

                if (!part.text) return null;

                return (
                  <div
                    key={index}
                    className="t-body font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
                  >
                    {part.text}
                    {caret}
                  </div>
                );
              })}
            </div>
          ) : live ? (
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
            <div className="relative flex items-center justify-end gap-2 mt-2">
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

ChatMessageBubble.displayName = 'ChatMessageBubble';
