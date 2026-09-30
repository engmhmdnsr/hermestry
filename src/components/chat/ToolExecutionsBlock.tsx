import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleCheck,
  CircleDashed,
  FileText,
  Globe,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import type { ChatMessage } from '../../types/hermes';
import { withFallback, type Translate } from './translate';

type ToolRunStatus = 'running' | 'done' | 'failed' | 'unknown';

interface ToolRun {
  name: string;
  preview: string;
  status: ToolRunStatus;
}

interface ToolExecutionsBlockProps {
  tools: string[];
  toolOutputs: Array<{ toolName: string; output: string }>;
  /** True while this turn is the one still arriving. */
  live: boolean;
  t: Translate;
}

// A tool result that opens with one of these is a failed step. The check is
// deliberately anchored to the start of the output so prose that merely
// mentions an error is not reported as a failure. Besides plain English it
// covers JSON error shapes ({"error": …}, {"ok": false}, {"success": false},
// {"status": "error"}), permission failures, Arabic failure words, and the
// cross mark glyph.
const FAILED_SHAPE =
  /^\s*(?:[✗✘❌⨯]|"(?:error|errors)"\s*:|"(?:ok|success)"\s*:\s*false|\{[^}\n]{0,200}"(?:error|errors)"\s*:|\{[^}\n]{0,200}"(?:ok|success)"\s*:\s*false|\{[^}\n]{0,200}"status"\s*:\s*"(?:error|failed|failure)"|(?:error|failed|failure|exception|traceback|permission denied|operation not permitted|access denied|denied|refused|not found|no such file|timed out|timeout|EACCES|EPERM)\b|(?:خطأ|فشل|فاشل|مرفوض|ممنوع|تعذر|غير مصرح|غير مسموح|استثناء)(?![\p{L}\p{M}]))|(?:^|\s|[("'])(?:command not found|no such file or directory|npm ERR!|pip (?:ERROR|error)|exit (?:code|status)\s*\d+|returned (?:non-zero|a non-zero)|ENOENT|EACCES|EPERM|Traceback \(most recent call last\)|SyntaxError|TypeError|ReferenceError|ModuleNotFoundError|ImportError|FileNotFoundError|PermissionError|go: (?:.*: )?no |cargo: |error\[E\d+\]|FAILED\b)/iu;

const PREVIEW_CHARS = 80;

const normalizePreview = (output: string): string => {
  const flat = (output || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_CHARS) return flat;
  return `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…`;
};

const buildRuns = (
  tools: string[],
  toolOutputs: Array<{ toolName: string; output: string }>,
  live: boolean
): ToolRun[] => {
  const names: string[] = [];
  tools.forEach((name) => {
    if (name && !names.includes(name)) names.push(name);
  });
  toolOutputs.forEach((entry) => {
    if (entry.toolName && !names.includes(entry.toolName)) names.push(entry.toolName);
  });

  return names.map((name) => {
    // A tool can run more than once in a turn; the newest result is the one
    // still true. find() used to pin the first output, which left a retried
    // step stuck on its oldest status and preview.
    let output: string | undefined;
    for (let i = toolOutputs.length - 1; i >= 0; i--) {
      if (toolOutputs[i].toolName === name) {
        output = toolOutputs[i].output;
        break;
      }
    }
    const hasOutput = typeof output === 'string' && output.trim().length > 0;
    // A finished turn with no output for a tool is Unknown, never Finished:
    // a check mark would claim success nothing backs up.
    const status: ToolRunStatus = !hasOutput
      ? live
        ? 'running'
        : 'unknown'
      : FAILED_SHAPE.test(output as string)
        ? 'failed'
        : 'done';
    return {
      name,
      preview: hasOutput ? normalizePreview(output as string) : '',
      status,
    };
  });
};

const IconForTool: React.FC<{ name: string }> = ({ name }) => {
  const lower = name.toLowerCase();
  if (lower.includes('search') || lower.includes('find')) return <Search className="w-[18px] h-[18px]" />;
  if (lower.includes('web')) return <Globe className="w-[18px] h-[18px]" />;
  if (lower.includes('read')) return <FileText className="w-[18px] h-[18px]" />;
  if (lower.includes('write') || lower.includes('patch') || lower.includes('edit')) {
    return <Pencil className="w-[18px] h-[18px]" />;
  }
  if (
    lower.includes('terminal') ||
    lower.includes('shell') ||
    lower.includes('bash') ||
    lower.includes('cmd') ||
    lower.includes('exec')
  ) {
    return <Terminal className="w-[18px] h-[18px]" />;
  }
  if (lower.includes('memory') || lower.includes('skill') || lower.includes('todo')) {
    return <Zap className="w-[18px] h-[18px]" />;
  }
  return <Wrench className="w-[18px] h-[18px]" />;
};

const StatusGlyph: React.FC<{ status: ToolRunStatus; label: string }> = ({ status, label }) => {
  const icon =
    status === 'failed' ? (
      <XCircle className="w-3.5 h-3.5 text-[var(--app-danger)]" />
    ) : status === 'running' ? (
      <LoaderCircle className="w-3.5 h-3.5 text-[var(--app-accent-text)] animate-spin" />
    ) : status === 'unknown' ? (
      <CircleDashed className="w-3.5 h-3.5 text-[var(--app-text-muted)]" />
    ) : (
      <CircleCheck className="w-3.5 h-3.5 text-[var(--app-success)]" />
    );
  return (
    <span className="shrink-0 inline-flex items-center" title={label}>
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
};

/**
 * Tool activity for a reply: one summary row that reads the tool count, and
 * one compact row per tool once it is opened. The block opens itself while the
 * turn is still arriving (so the running step is visible) and rests collapsed
 * when the turn is over. Raw tool output never reaches the collapsed row.
 */
export const ToolExecutionsBlock: React.FC<ToolExecutionsBlockProps> = ({
  tools,
  toolOutputs,
  live,
  t,
}) => {
  const tx = withFallback(t);
  const [expanded, setExpanded] = useState(live);
  // Once the user opens the block by hand it stays open: the live effect
  // below must never auto-collapse it when the turn finishes.
  const userOpenedRef = useRef(false);
  const prevLiveRef = useRef(live);
  const runs = useMemo(() => buildRuns(tools, toolOutputs, live), [tools, toolOutputs, live]);

  useEffect(() => {
    if (live && !prevLiveRef.current) userOpenedRef.current = false;
    prevLiveRef.current = live;
    if (live) setExpanded(true);
    else if (!userOpenedRef.current) setExpanded(false);
  }, [live]);

  if (runs.length === 0) return null;

  const count = runs.length;
  const countLabel =
    count === 1
      ? tx('toolCountOne', '1 tool')
      : tx('toolCountMany', '{count} tools').replace('{count}', String(count));
  const anyRunning = runs.some((run) => run.status === 'running');
  const actionLabel = expanded
    ? tx('hideList', 'Hide')
    : tx('showList', 'Show');

  return (
    <div className="mb-3 r-sm edge bg-[var(--app-card-subtle)] overflow-hidden">
      <button
        type="button"
        onClick={() => {
          userOpenedRef.current = true;
          setExpanded((value) => !value);
        }}
        aria-expanded={expanded}
        aria-label={tx('toolBlockAria', '{count} tools ran for this reply. Tap to {action} the list.')
          .replace('{count}', String(count))
          .replace('{action}', actionLabel)}
        className="w-full min-h-[44px] flex items-center gap-2 ps-3 pe-2 text-start hover:bg-[var(--app-card-hover)] transition cursor-pointer"
      >
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-[var(--app-text-muted)] transition-transform ${
            expanded ? '' : '-rotate-90 rtl-flip'
          }`}
        />
        <span className="t-label text-[var(--app-text)]">{countLabel}</span>
        {anyRunning && (
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-[var(--app-accent)] animate-pulse"
          />
        )}
      </button>

      {expanded && (
        <ul className="px-3 pb-3 space-y-1">
          {runs.map((run) => (
            <li key={run.name} className="flex items-center gap-2 min-w-0">
              <span aria-hidden="true" className={`shrink-0 inline-flex ${run.status === 'running' ? 'text-[var(--app-accent-text)]' : 'text-[var(--app-text-muted)]'}`}>
                <IconForTool name={run.name} />
              </span>
              <span className={`t-label shrink-0 max-w-[45%] truncate ${run.status === 'running' ? 'text-[var(--app-accent-text)]' : 'text-[var(--app-text)]'}`}>
                {run.name}
              </span>
              {run.preview && (
                <span
                  dir="auto"
                  className="t-caption font-mono text-[var(--app-text-muted)] truncate min-w-0 flex-1 [unicode-bidi:plaintext]"
                >
                  {run.preview}
                </span>
              )}
              <span className="ms-auto">
                <StatusGlyph
                  status={run.status}
                  label={
                    run.status === 'failed'
                      ? tx('toolStatusFailed', 'Failed')
                      : run.status === 'running'
                        ? tx('toolStatusRunning', 'Running')
                        : run.status === 'unknown'
                          ? tx('toolStatusUnknown', 'Unknown')
                          : tx('toolStatusDone', 'Finished')
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
