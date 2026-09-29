import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { withFallback, type Translate } from './translate';

interface ThinkingBlockProps {
  thinking: string;
  isDone: boolean;
  t: Translate;
}

/**
 * Collapsible reasoning block, collapsed by default.
 *
 * One label row with a chevron (the reasoning itself never pushes the answer
 * down the screen), and the body opens in dim mono text on the card-subtle
 * token. While the model is still reasoning the row carries a working pulse so
 * the state is visible without opening the block.
 */
export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking, isDone, t }) => {
  const tx = withFallback(t);
  const [expanded, setExpanded] = useState(false);

  const stateLabel = isDone
    ? tx('reasoningDone', 'finished')
    : tx('reasoningWorking', 'working…');
  const stateText = isDone ? tx('reasoningDone', 'finished') : tx('reasoningWorkingShort', 'working');
  const actionLabel = expanded
    ? tx('thinkingCollapse', 'hide the details')
    : tx('thinkingExpand', 'show the details');

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={tx('thinkingAria', 'Thinking, {state}. Tap to {action}.')
          .replace('{state}', stateLabel)
          .replace('{action}', actionLabel)}
        className="w-full min-h-[44px] flex items-center gap-2 ps-2 pe-1 text-start r-sm hover:bg-[var(--app-card-hover)] transition cursor-pointer"
      >
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-[var(--app-text-muted)] transition-transform ${
            expanded ? '' : '-rotate-90 rtl-flip'
          }`}
        />
        <span className="t-label text-[var(--app-text-muted)]">
          {tx('thinkingLabel', 'Thinking')}
        </span>
        {!isDone && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full bg-[var(--app-accent)] animate-pulse"
            />
            <span className="t-caption text-[var(--app-accent-text)]">{stateText}</span>
          </span>
        )}
      </button>

      {expanded && (
        <div className="r-sm hairline bg-[var(--app-card-subtle)] p-3 t-caption font-mono text-[var(--app-text-muted)] whitespace-pre-wrap break-words [overflow-wrap:anywhere] [unicode-bidi:plaintext] select-text max-h-56 overflow-y-auto">
          {thinking}
        </div>
      )}
    </div>
  );
};
