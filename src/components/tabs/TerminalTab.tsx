import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Check,
  Eraser,
  Send,
  SquareTerminal,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { formatMessageClock } from '../chat/messageClock';

interface TermEntry {
  id: string;
  command: string;
  output: string;
  at: number;
  isError: boolean;
}

let termSeq = 0;
const nextId = () => `term-${Date.now()}-${termSeq++}`;

const QUICK_COMMANDS = [
  'hermes status',
  'approval status',
  'models',
  'sessions',
  'ping',
  'history',
  'clear',
] as const;

// Virtual developer key strip, Control spec: Ctrl+C clears the pending input,
// Tab inserts spaces, Esc clears it, the rest insert themselves, and clear
// wipes the log. No haptics on web; the actions are what matters.
const DEV_KEYS = ['Tab', 'Esc', '|', '~', '&&', '/', '\\', '-', '$', ';', '>', 'clear'] as const;

/**
 * On-device terminal, ported from the Control app's HermesTerminalScreen.
 * Same chrome (header bar, console cards, quick pills, dev-key strip, prompt
 * input line) and same built-ins, wired to this app's data: sessions, models,
 * connection state and the auto-approve flag come from HermesContext.
 *
 * What it deliberately does NOT do: run host shell commands. Control streams
 * those through the agent; here anything that is not a built-in is answered
 * with a pointer to Chat, never faked and never silently dropped.
 */
export const TerminalTab: React.FC = () => {
  const { sessions, currentSessionId, models, connected, settings, approvals, t } =
    useHermes();
  const autoApproveGlobal = settings.autoApproveGlobal === true;

  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  const [entries, setEntries] = useState<TermEntry[]>(() => [
    {
      id: nextId(),
      command: 'hermes --version',
      output: '',
      at: Date.now(),
      isError: false,
    },
  ]);
  const [booted, setBooted] = useState(false);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connWord = connected
    ? tx('termOnline', 'ONLINE')
    : tx('termOffline', 'OFFLINE');

  // Boot line is set once the first paint has the live connection state, so
  // it never prints a stale OFFLINE on a connected phone. termBoot carries
  // real newlines, which the i18n gate cannot compare inside a tx() literal,
  // so it resolves through t() with a mirrored constant fallback.
  const TERM_BOOT_FALLBACK =
    "Hermes Terminal v1.3.0 [on-device]\nStatus: {status}\nType 'help' for built-in commands.";
  useEffect(() => {
    if (booted) return;
    setBooted(true);
    const tpl = t('termBoot');
    const bootText = (tpl === 'termBoot' ? TERM_BOOT_FALLBACK : tpl).replace(
      '{status}',
      connected ? tx('termOnline', 'ONLINE') : tx('termOffline', 'OFFLINE')
    );
    setEntries((prev) =>
      prev.map((e) =>
        e.command === 'hermes --version' ? { ...e, output: bootText } : e
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the boot line when the link state flips while the log still
  // holds only that boot entry, so it never freezes a stale status word.
  useEffect(() => {
    if (!booted) return;
    setEntries((prev) => {
      if (prev.length !== 1 || prev[0].command !== 'hermes --version') return prev;
      const tpl = t('termBoot');
      const bootText = (tpl === 'termBoot' ? TERM_BOOT_FALLBACK : tpl).replace(
        '{status}',
        connected ? tx('termOnline', 'ONLINE') : tx('termOffline', 'OFFLINE')
      );
      return prev.map((e) => ({ ...e, output: bootText }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  // Auto-scroll only while the reader is already at the bottom, so reading
  // history above never yanks the viewport (Control spec).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const push = (command: string, output: string, isError = false) => {
    setEntries((prev) => [...prev, { id: nextId(), command, output, at: Date.now(), isError }]);
  };

  const clearScreen = (command: string) => {
    setEntries([
      {
        id: nextId(),
        command,
        output: tx('termClearHint', "Screen cleared. Type 'help' for built-in commands."),
        at: Date.now(),
        isError: false,
      },
    ]);
  };

  const statusText = useMemo(() => {
    const active = sessions.find((s) => s.id === currentSessionId);
    return [
      '[GATEWAY STATUS]',
      `Connection : ${connected ? 'CONNECTED' : 'OFFLINE'}`,
      `Endpoint   : ${tx('termOnDevice', 'on-device gateway')}`,
      `Sessions   : ${sessions.length}`,
      `Active     : ${active && active.title ? String(active.title).slice(0, 30) : tx('termNone', 'None')}`,
      `Models     : ${models.length}`,
      `Auto-approve: ${autoApproveGlobal ? 'ALLOW ALL' : 'MANUAL'}`,
      `Pending approvals: ${approvals.length}`,
    ].join('\n');
  }, [sessions, currentSessionId, models.length, connected, autoApproveGlobal, approvals.length, t]);

  const approvalText = useMemo(
    () =>
      [
        '[SECURITY APPROVAL CONFIGURATION]',
        `Current Mode    : ${autoApproveGlobal ? 'ALLOW ALL (AUTONOMOUS)' : 'MANUAL (PROMPT PER COMMAND)'}`,
        `Pending Requests: ${approvals.length}`,
        '',
        tx(
          'termApprovalHint',
          'Flip the mode from Settings, Auto-Approve. Test cards live in Chat.'
        ),
      ].join('\n'),
    [autoApproveGlobal, approvals.length, t]
  );

  const modelsText = useMemo(() => {
    const shown = models.slice(0, 20);
    const lines = shown.map(
      (m) => `> [${String(m.provider || 'default')}] ${String(m.displayName ?? m.id ?? '')} (${String(m.id ?? '')})`
    );
    if (lines.length === 0) {
      lines.push(tx('termModelsEmpty', 'No models available yet.'));
    } else if (models.length > shown.length) {
      lines.push(
        tx('termMore', '+{count} more').replace('{count}', String(models.length - shown.length))
      );
    }
    return [`AVAILABLE MODELS (${models.length}):`, '-----------------', ...lines].join('\n');
  }, [models, t]);

  const sessionsText = useMemo(() => {
    const shown = sessions.slice(0, 15);
    const lines = shown.map(
      (s) =>
        `${s.id === currentSessionId ? '> ' : '  '}${String(s.title ?? tx('termNone', 'None')).slice(0, 30)} [${String(s.messageCount ?? 0)} msgs]`
    );
    if (lines.length === 0) {
      lines.push(tx('termSessionsEmpty', 'No sessions yet. Start one from Chat.'));
    } else if (sessions.length > shown.length) {
      lines.push(
        tx('termMore', '+{count} more').replace('{count}', String(sessions.length - shown.length))
      );
    }
    return [`HERMES SESSIONS (${sessions.length}):`, '-------------------------', ...lines].join('\n');
  }, [sessions, currentSessionId, t]);

  const helpText = useMemo(
    () =>
      [
        'HERMES TERMINAL BUILT-IN COMMANDS:',
        '----------------------------------',
        '> hermes status / status : live gateway, sessions, models, approvals',
        '> approval / approval status : approval mode and pending count',
        '> hermes models / models : list available AI models and providers',
        '> hermes sessions / sessions : list Hermes sessions',
        '> ping         : connection state of the on-device gateway',
        '> history      : previously executed commands',
        '> clear / cls  : clear terminal screen',
        '> help         : this message',
        '',
        tx(
          'termShellNote',
          'Anything else is a host shell command: send it in Chat instead.'
        ),
      ].join('\n'),
    [t]
  );

  const runCommand = (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    setHistory((prev) => [...prev, cmd]);
    setHistoryIndex(-1);
    setInput('');
    const lower = cmd.toLowerCase();
    if (lower === 'clear' || lower === 'cls') {
      clearScreen(cmd);
      return;
    }
    if (lower === 'help') {
      push(cmd, helpText);
      return;
    }
    if (lower === 'status' || lower === 'hermes status') {
      push(cmd, statusText);
      return;
    }
    if (lower === 'approval' || lower === 'approval status') {
      push(cmd, approvalText);
      return;
    }
    if (lower === 'models' || lower === 'hermes models') {
      push(cmd, modelsText);
      return;
    }
    if (lower === 'sessions' || lower === 'hermes sessions') {
      push(cmd, sessionsText);
      return;
    }
    if (lower === 'ping') {
      push(
        cmd,
        connected
          ? `Gateway reachable (${tx('termOnDevice', 'on-device gateway')})`
          : tx('termPingDown', 'Gateway offline. Check Settings, Gateway.')
      );
      return;
    }
    if (lower === 'history') {
      // Read history state directly: pushing inside a setHistory updater
      // would double-fire under StrictMode and duplicate the log entry.
      const full = [...history, cmd];
      const text = full.map((c, i) => `${i + 1}: ${c}`).join('\n');
      push(cmd, text || tx('termHistoryEmpty', 'No command history yet.'));
      return;
    }
    push(
      cmd,
      `${tx('termUnknown', "Unknown command '{cmd}'. Type 'help'.").replace('{cmd}', cmd)}\n${tx(
        'termShellNote',
        'Anything else is a host shell command: send it in Chat instead.'
      )}`,
      true
    );
  };

  const recall = (dir: 1 | -1) => {
    if (history.length === 0) return;
    // setInput stays outside the updater: side effects inside updaters
    // double-fire under StrictMode.
    if (dir === 1) {
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setInput(history[history.length - 1 - next] || '');
    } else {
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInput('');
        return;
      }
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setInput(history[history.length - 1 - next] || '');
    }
  };

  const pressDevKey = (key: string) => {
    if (key === 'Tab') setInput((v) => `${v}    `);
    else if (key === 'Esc') setInput('');
    else if (key === 'clear') clearScreen('clear');
    else setInput((v) => `${v}${key}`);
    inputRef.current?.focus();
  };

  const copyLog = async () => {
    const text = entries.map((e) => `hermes:~$ ${e.command}\n${e.output}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable in some WebViews: leave the tick
      // untouched and note it as a log line the reader can copy by hand.
      push(
        tx('termCopyLog', 'Copy terminal log'),
        tx('termCopyFailed', 'Copy failed. Long-press the log to copy by hand.'),
        true
      );
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--app-term-bg)] text-[var(--app-text)]">
      {/* Header bar: status dot, terminal mark, title, link state, actions. */}
      <div className="flex items-center justify-between gap-2 px-[14px] py-2 bg-[var(--app-term-header-bg)] border-b border-[var(--app-term-card-border)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden="true"
            className={`w-2 h-2 r-full shrink-0 ${connected ? 'bg-[var(--app-success)]' : 'bg-[var(--app-danger)]'}`}
          />
          <SquareTerminal className="w-4 h-4 shrink-0 text-[var(--app-term-green)]" aria-hidden="true" />
          <span className="font-mono text-xs font-bold text-[var(--app-term-green)] truncate">
            {tx('termTitle', 'HERMES TERMINAL')}
          </span>
          <span
            className={`font-mono text-[10px] shrink-0 ${connected ? 'text-[var(--app-chat-you)]' : 'text-[var(--app-danger)]'}`}
            role="status"
          >
            {connWord}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void copyLog()}
            disabled={entries.length === 0}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer disabled:opacity-40"
            title={tx('termCopyLog', 'Copy terminal log')}
            aria-label={tx('termCopyLog', 'Copy terminal log')}
          >
            {copied ? (
              <Check className="w-4 h-4 text-[var(--app-success)]" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => clearScreen('clear')}
            disabled={entries.length === 0}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer disabled:opacity-40"
            title={tx('termClear', 'Clear terminal')}
            aria-label={tx('termClear', 'Clear terminal')}
          >
            <Eraser className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Console area. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto bg-[var(--app-term-console)] px-[10px] py-[6px]" role="log" aria-label={tx('termTitle', 'HERMES TERMINAL')}>
        <div className="flex flex-col gap-2 py-[6px] select-text">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="w-full rounded-[6px] bg-[var(--app-term-card)] border border-[var(--app-term-card-border)] p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[11px] font-bold truncate min-w-0">
                  <span className="text-[var(--app-term-green)]">hermes:~$ </span>
                  <span className="text-[var(--app-text)] [unicode-bidi:plaintext]">{entry.command}</span>
                </p>
                <span className="font-mono text-[9px] text-[var(--app-text-muted)] tabular-nums shrink-0">
                  {formatMessageClock(entry.at)}
                </span>
              </div>
              <div className="my-1 border-t border-[var(--app-term-divider)]" aria-hidden="true" />
              <p
                className={`font-mono text-[11px] leading-4 whitespace-pre-wrap break-words [overflow-wrap:anywhere] [unicode-bidi:plaintext] ${
                  entry.isError ? 'text-[var(--app-danger)]' : 'text-[var(--app-term-output)]'
                }`}
              >
                {entry.output}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Quick command pills. */}
      <div className="shrink-0 bg-[var(--app-term-header-bg)] border-t border-[var(--app-term-card-border)]">
        <div className="hm-rail items-center gap-[6px] px-[10px] py-[6px]">
          {QUICK_COMMANDS.map((cmd) => (
            <button
              key={cmd}
              type="button"
              onClick={() => runCommand(cmd)}
              className="shrink-0 rounded-[6px] bg-[var(--app-term-pill-bg)] border border-[var(--app-term-pill-border)] px-[9px] py-1 font-mono text-[11px] font-medium text-[var(--app-chat-you)] hover:brightness-125 active:scale-95 transition cursor-pointer min-h-[36px]"
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>

      {/* Developer key strip. */}
      <div className="shrink-0 bg-[var(--app-term-bg)] border-t border-[var(--app-term-key-border)]">
        <div className="hm-rail items-center gap-[5px] px-2 py-1">
          <button
            key="Ctrl+C"
            type="button"
            onClick={() => setInput('')}
            className="shrink-0 rounded-[5px] bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] px-2 py-[3px] font-mono text-[11px] font-bold text-[var(--app-danger)] hover:brightness-125 active:scale-95 transition cursor-pointer min-h-[36px]"
            title={tx('termCtrlCTitle', 'Clear the pending input')}
          >
            Ctrl+C
          </button>
          {DEV_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => pressDevKey(key)}
              className={`shrink-0 rounded-[5px] bg-[var(--app-term-key-bg)] border border-[var(--app-term-key-border)] px-2 py-[3px] font-mono text-[11px] font-semibold hover:brightness-125 active:scale-95 transition cursor-pointer min-h-[36px] ${
                key === 'Tab' || key === 'Esc' ? 'text-[var(--app-chat-you)]' : 'text-[var(--app-text)]'
              }`}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      {/* Input line. */}
      <div className="shrink-0 bg-[var(--app-term-header-bg)] border-t border-[var(--app-term-card-border)] px-[10px] py-2 flex items-center gap-1">
        <span className="font-mono text-[13px] font-bold text-[var(--app-term-green)] shrink-0" aria-hidden="true">
          hermes:~$
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runCommand(input);
            else if (e.key === 'ArrowUp') {
              e.preventDefault();
              recall(1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              recall(-1);
            }
          }}
          placeholder={tx('termInputPlaceholder', 'Enter command (status, models, sessions, help)')}
          aria-label={tx('termInputLabel', 'Terminal command input')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent font-mono text-[13px] text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] caret-[var(--app-term-green)] focus:outline-none"
        />
        {history.length > 0 && (
          <>
            {/* History recall: desktop parity, shown only when there is
                history to step through. */}
            <button
              type="button"
              onClick={() => recall(1)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer shrink-0"
              title={tx('termPrevCmd', 'Previous command')}
              aria-label={tx('termPrevCmd', 'Previous command')}
            >
              <ArrowUp className="w-[18px] h-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => recall(-1)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer shrink-0"
              title={tx('termNextCmd', 'Next command')}
              aria-label={tx('termNextCmd', 'Next command')}
            >
              <ArrowDown className="w-[18px] h-[18px]" />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => runCommand(input)}
          disabled={!input.trim()}
          className={`w-[44px] h-[44px] r-sm flex items-center justify-center transition shrink-0 ${
            input.trim()
              ? 'bg-[var(--app-success-subtle)] text-[var(--app-success)] hover:brightness-125 cursor-pointer'
              : 'text-[var(--app-text-dim)] cursor-not-allowed'
          }`}
          title={tx('termRun', 'Run command')}
          aria-label={tx('termRun', 'Run command')}
        >
          <Send className="w-[18px] h-[18px] rtl-flip" />
        </button>
      </div>
    </div>
  );
};
