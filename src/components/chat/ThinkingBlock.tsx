import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { withFallback, type Translate } from './translate';

interface ThinkingBlockProps {
  thinking: string;
  isDone: boolean;
  t: Translate;
}

/**
 * Collapsible reasoning drawer, mockup shape: a cyan-bordered card with a
 * "Thinking Process" summary row (working pulse while reasoning, a quiet
 * done state after) and the body opening in dim mono text inside.
 * Collapsed by default so the reasoning never pushes the answer down.
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
    <div className="mb-2.5 rounded-xl border border-[var(--app-info-border)]/60 bg-[var(--app-bg)]/80 overflow-hidden transition-all">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={tx('thinkingAria', 'Thinking, {state}. Tap to {action}.')
          .replace('{state}', stateLabel)
          .replace('{action}', actionLabel)}
        className="w-full min-h-[44px] flex items-center justify-between gap-2 px-3 py-2 text-start text-[var(--app-info)] hover:bg-[var(--app-info-subtle)]/30 transition cursor-pointer select-none"
      >
        <span className="flex items-center gap-2 min-w-0">
          {!isDone && (
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full bg-[var(--app-info)] animate-pulse shrink-0"
            />
          )}
          <span className="t-caption font-mono tracking-wide truncate">
            {tx('thinkingProcess', 'Thinking Process')}
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-[var(--app-info)] shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </span>
        <span className="t-micro font-mono text-[var(--app-text-muted)] shrink-0">{stateText}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-[var(--app-info-border)]/40 t-caption font-mono text-[var(--app-text-muted)] whitespace-pre-wrap break-words [overflow-wrap:anywhere] [unicode-bidi:plaintext] select-text max-h-56 overflow-y-auto bg-[var(--app-bg)]/90">
          {thinking}
        </div>
      )}
    </div>
  );
};
