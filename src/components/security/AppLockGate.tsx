import React, { useState, useEffect, useRef } from 'react';
import { Lock, Delete, Shield, LogIn } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface AppLockGateProps {
  onUnlocked: () => void;
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_BASE_SECONDS = 30;
const LOCKOUT_MAX_SECONDS = 300;
const MIN_PIN_LEN = 4;
const MAX_PIN_LEN = 8;

// Escalating backoff: 30s, 60s, 120s, 240s, capped at 300s. Persisted so a
// reload does not reset the penalty.
function lockoutDuration(cycles: number): number {
  return Math.min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * 2 ** Math.max(0, cycles));
}

function readLockoutCycles(): number {
  try {
    return Number(localStorage.getItem('hermes_lockouts')) || 0;
  } catch {
    return 0;
  }
}

export const AppLockGate: React.FC<AppLockGateProps> = ({ onUnlocked }) => {
  const { settings, t, unlockSecrets } = useHermes();
  // New copy may not exist in constants/languages yet: a missing key degrades
  // to the English fallback instead of printing the raw key.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [lockoutLeft, setLockoutLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lockoutCycles, setLockoutCycles] = useState(readLockoutCycles);
  // Coarse (10s granularity) lockout copy for the polite live region. The
  // visible countdown ticks every second; announcing that would spam the
  // screen reader, so only this throttled string is announced.
  const [lockoutAnnounce, setLockoutAnnounce] = useState('');
  // Refs mirror state for use inside async callbacks (stale closures would
  // otherwise under-count attempts or double-spend them).
  const attemptsRef = useRef(0);
  const cyclesRef = useRef<number | null>(null);
  if (cyclesRef.current === null) cyclesRef.current = lockoutCycles;
  const pinRef = useRef('');
  pinRef.current = pin;
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards double-submit while an async vault unlock is in flight. The PIN
  // is cleared from state the moment it is consumed, so without this the
  // gate would accept overlapping attempts.
  const busyRef = useRef(false);
  // The single real input on this screen. It is focused on mount so the
  // hardware/soft keyboard drives entry and Enter submits.
  const pinInputRef = useRef<HTMLInputElement | null>(null);

  const lockedOut = lockoutLeft > 0;
  const ready = pin.length >= MIN_PIN_LEN && !lockedOut && !busy;

  useEffect(() => {
    if (lockoutLeft <= 0) return;
    const id = setInterval(() => {
      setLockoutLeft((prev) => {
        if (prev <= 1) {
          setAttempts(0);
          setError(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [lockoutLeft > 0]);

  // Throttled polite announcement: fires once per 10s bucket, not per second.
  const announceBucket = lockoutLeft > 0 ? Math.ceil(lockoutLeft / 10) : 0;
  useEffect(() => {
    if (announceBucket <= 0) {
      setLockoutAnnounce('');
      return;
    }
    setLockoutAnnounce(`${t('lockedFor')} ${announceBucket * 10}s`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announceBucket]);

  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  // Focus the PIN field once on mount so typing and Enter work immediately.
  // preventScroll keeps the browser from yanking the scroll position, then a
  // block:center scroll brings the field clear of the soft keyboard. The
  // field font is 16px so Android does not zoom the page on focus.
  useEffect(() => {
    const el = pinInputRef.current;
    if (!el) return;
    const id = window.setTimeout(() => {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'center' });
    }, 60);
    return () => window.clearTimeout(id);
  }, []);

  const flashError = (msg: string) => {
    setError(msg);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setPin(''), 600);
  };

  const failAttempt = () => {
    const used = attemptsRef.current + 1;
    attemptsRef.current = used;
    setAttempts(used);
    if (used >= MAX_ATTEMPTS) {
      const cycles = cyclesRef.current ?? 0;
      const duration = lockoutDuration(cycles);
      cyclesRef.current = cycles + 1;
      setLockoutCycles(cycles + 1);
      try {
        localStorage.setItem('hermes_lockouts', String(cycles + 1));
      } catch {}
      setLockoutLeft(duration);
      setPin('');
      setError(`${t('tooManyAttempts')} ${duration}s.`);
    } else {
      flashError(`${t('incorrectPin')} ${MAX_ATTEMPTS - used} ${t('attemptsLeft')}.`);
    }
  };

  const clearPenalty = () => {
    attemptsRef.current = 0;
    setAttempts(0);
    cyclesRef.current = 0;
    setLockoutCycles(0);
    try {
      localStorage.removeItem('hermes_lockouts');
    } catch {}
  };

  // Explicit submit only: typing the last digit never spends an attempt.
  // The user reviews the dots, then presses Unlock (or Enter).
  const tryUnlock = () => {
    if (lockoutLeft > 0 || busyRef.current) return;
    const attempted = pinRef.current;
    if (attempted.length < MIN_PIN_LEN) {
      setError(t('lockMinDigits').replace('{n}', String(MIN_PIN_LEN)));
      return;
    }
    let hasVault = false;
    try {
      hasVault = !!localStorage.getItem('hermes_vault');
    } catch {}
    if (hasVault) {
      // Consume the PIN immediately so it lives in JS state for the
      // shortest possible time. The local copy is the only reference
      // used for the unlock call below.
      setPin('');
      busyRef.current = true;
      setBusy(true);
      unlockSecrets(attempted)
        .then((ok) => {
          busyRef.current = false;
          setBusy(false);
          if (ok) {
            clearPenalty();
            onUnlocked();
          } else {
            failAttempt();
          }
        })
        .catch((e: unknown) => {
          // A rejected unlock is a real failure, never a silent no-op: the
          // button used to stay stuck on "Unlocking" forever with no error.
          // Release the busy guard and surface the cause. A bridge/decrypt
          // fault is not a wrong PIN, so no attempt is spent here.
          busyRef.current = false;
          setBusy(false);
          const detail = e instanceof Error && e.message ? e.message : '';
          const base = tx('unlockFailed', 'Unlock failed. Try again.');
          setError(detail ? `${base} ${detail}` : base);
        });
    } else if (attempted === settings.appLockPin) {
      // Legacy no-vault setup: clear the PIN before leaving the gate.
      setPin('');
      clearPenalty();
      onUnlocked();
    } else {
      failAttempt();
    }
  };

  const handleDigit = (d: string) => {
    if (lockoutLeft > 0 || busyRef.current) return;
    if (pinRef.current.length >= MAX_PIN_LEN) return;
    setPin(pinRef.current + d);
    setError(null);
  };

  const handleDelete = () => {
    if (lockedOut || busyRef.current) return;
    setPin((prev) => prev.slice(0, -1));
    setError(null);
  };

  // Text-input handler: digits only, capped, never longer than MAX_PIN_LEN.
  const handleInput = (raw: string) => {
    if (lockoutLeft > 0 || busyRef.current) return;
    setPin(raw.replace(/\D/g, '').slice(0, MAX_PIN_LEN));
    setError(null);
  };

  // Refs so the global keydown listener always calls the latest handlers.
  const handleDigitRef = useRef(handleDigit);
  handleDigitRef.current = handleDigit;
  const handleDeleteRef = useRef(handleDelete);
  handleDeleteRef.current = handleDelete;
  const tryUnlockRef = useRef(tryUnlock);
  tryUnlockRef.current = tryUnlock;

  // Physical keyboard support when the input is not the event target: digits
  // append, Backspace deletes, Enter submits. Events that originate from the
  // input are ignored so a keystroke is never counted twice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target === pinInputRef.current) return;
      if (e.key === 'Enter') {
        tryUnlockRef.current();
      } else if (/^[0-9]$/.test(e.key)) {
        handleDigitRef.current(e.key);
      } else if (e.key === 'Backspace') {
        handleDeleteRef.current();
      } else {
        return;
      }
      pinInputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // Scrollable, keyboard-safe shell: a fixed full-screen scroller whose
    // column can grow past the viewport, so the PIN pad and the primary
    // action stay reachable on a 360dp device even with the keyboard open.
    <div className="fixed inset-0 z-50 bg-[var(--app-bg,#090B0E)] text-slate-200 overflow-y-auto overflow-x-hidden">
      <div
        className="min-h-[100dvh] w-full flex flex-col items-center px-6"
        style={{
          paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))',
          paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="my-auto w-full max-w-[360px] flex flex-col items-center py-4">
          <div className="w-16 h-16 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6 shadow-sm">
            <Lock className="w-7 h-7 text-indigo-400" />
          </div>

          <span className="mb-2 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[11px] font-semibold text-indigo-300">
            {t('appLock')}
          </span>
          <h2 className="text-lg font-semibold text-white tracking-tight mb-1">
            {t('lockedTitle')}
          </h2>
          <p className="text-xs text-slate-400 mb-6 text-center">
            {t('lockEnterPin').replace('{min}', String(MIN_PIN_LEN)).replace('{max}', String(MAX_PIN_LEN))}
          </p>

          {/* The real PIN field. Its text is transparent: the fixed 8 dots
              underneath are the only visual, so the entered length is never
              revealed. 16px font stops Android from zooming the page. */}
          <div className="relative w-full max-w-[280px] mb-2">
            <input
              ref={pinInputRef}
              id="app-lock-pin"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              enterKeyHint="done"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={tx('lockPinInputLabel', 'App lock PIN')}
              aria-invalid={!!error}
              value={pin}
              onChange={(e) => handleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  tryUnlockRef.current();
                }
              }}
              disabled={lockedOut || busy}
              style={{ fontSize: '16px' }}
              className="w-full h-14 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-center text-transparent caret-transparent focus:outline-none focus:border-indigo-500 disabled:opacity-40"
            />
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3">
              {Array.from({ length: MAX_PIN_LEN }).map((_, idx) => {
                const filled = idx < pin.length;
                return (
                  <div
                    key={idx}
                    className={`w-3.5 h-3.5 rounded-full transition-all duration-200 ${
                      filled
                        ? 'bg-indigo-500 scale-110 shadow-xs'
                        : 'bg-white/[0.08] border border-white/[0.08]'
                    }`}
                  />
                );
              })}
            </div>
          </div>
          <p role="status" className="sr-only">
            {t('lockDigitsStatus').replace('{n}', String(pin.length)).replace('{min}', String(MIN_PIN_LEN))}
          </p>

          {error && (
            <p role="alert" className="text-xs text-rose-400 mt-2 mb-2 animate-shake text-center max-w-[280px]">
              {error}
            </p>
          )}

          {/* Visible countdown is aria-hidden: the throttled polite region
              below announces the remaining time without ticking every second. */}
          {lockedOut && (
            <p aria-hidden="true" className="text-xs text-amber-300 mb-2 font-mono">
              {t('lockedFor')} {lockoutLeft}s
            </p>
          )}
          <span className="sr-only" role="status">
            {lockoutAnnounce}
          </span>

          {/* Number keypad: width-capped so it never overflows a 360dp
              screen; every key is at least 44px tall. */}
          <div className={`grid grid-cols-3 gap-3 w-full max-w-[280px] mt-4 ${lockedOut ? 'opacity-40 pointer-events-none' : ''}`}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                onClick={() => handleDigit(digit)}
                disabled={lockedOut || busy}
                aria-label={`${t('digitLabel')} ${digit}`}
                className="h-14 min-h-[44px] rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
              >
                {digit}
              </button>
            ))}
            <button
              onClick={() => setPin('')}
              disabled={lockedOut || busy}
              aria-label={t('clear')}
              className="h-14 min-h-[44px] rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-xs font-medium text-slate-400 flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
            >
              {t('clear')}
            </button>
            <button
              onClick={() => handleDigit('0')}
              disabled={lockedOut || busy}
              aria-label={`${t('digitLabel')} 0`}
              className="h-14 min-h-[44px] rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
            >
              0
            </button>
            <button
              onClick={handleDelete}
              disabled={lockedOut || busy}
              className="h-14 min-h-[44px] rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-slate-400 hover:text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
              aria-label={t('deleteLabel')}
            >
              <Delete className="w-5 h-5" />
            </button>
          </div>

          <button
            onClick={() => tryUnlockRef.current()}
            disabled={!ready}
            className={`mt-5 w-full max-w-[280px] min-h-[48px] rounded-2xl font-semibold text-sm transition flex items-center justify-center gap-2 ${
              ready
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'
                : 'bg-white/[0.04] text-slate-600 cursor-not-allowed'
            }`}
          >
            <LogIn className="w-4 h-4" />
            <span>{busy ? t('unlocking') : t('unlock')}</span>
          </button>
          {!lockedOut && (
            <p className="mt-2 text-[11px] text-slate-500 text-center max-w-[280px]">
              {attempts > 0
                ? `${t('incorrectPin')} ${MAX_ATTEMPTS - attempts} ${t('attemptsLeft')}.`
                : t('lockHint').replace('{min}', String(MIN_PIN_LEN)).replace('{max}', String(MAX_PIN_LEN))}
            </p>
          )}

          <p className="mt-6 text-xs text-slate-500 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5" />
            <span>{t('pinLocalOnly')}</span>
          </p>
          <div className="mt-4 max-w-[300px] space-y-2 text-center">
            <p className="text-[11px] text-amber-300/90 leading-relaxed">
              {t('lockRecovery')}
            </p>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              {t('lockTip')}
            </p>
            <p className="text-[11px] text-slate-600 leading-relaxed">
              {t('screenshotNote')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
