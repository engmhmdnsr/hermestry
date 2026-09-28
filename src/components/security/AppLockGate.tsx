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
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [lockoutLeft, setLockoutLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lockoutCycles, setLockoutCycles] = useState(readLockoutCycles);
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

  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
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
      setError(`Enter at least ${MIN_PIN_LEN} digits.`);
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
      unlockSecrets(attempted).then((ok) => {
        busyRef.current = false;
        setBusy(false);
        if (ok) {
          clearPenalty();
          onUnlocked();
        } else {
          failAttempt();
        }
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

  // Refs so the global keydown listener always calls the latest handlers.
  const handleDigitRef = useRef(handleDigit);
  handleDigitRef.current = handleDigit;
  const handleDeleteRef = useRef(handleDelete);
  handleDeleteRef.current = handleDelete;
  const tryUnlockRef = useRef(tryUnlock);
  tryUnlockRef.current = tryUnlock;

  // Physical keyboard support: digits append, Backspace deletes, Enter submits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        tryUnlockRef.current();
      } else if (/^[0-9]$/.test(e.key)) {
        handleDigitRef.current(e.key);
      } else if (e.key === 'Backspace') {
        handleDeleteRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-[var(--app-bg,#090B0E)] flex flex-col items-center justify-center p-6 text-slate-200">
      <div className="w-16 h-16 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6 shadow-sm">
        <Lock className="w-7 h-7 text-indigo-400" />
      </div>

      <span className="mb-2 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[11px] font-semibold text-indigo-300">
        {t('appLock')}
      </span>
      <h2 className="text-lg font-semibold text-white tracking-tight mb-1">
        {t('lockedTitle')}
      </h2>
      <p className="text-xs text-slate-400 mb-8">
        Enter your PIN to continue
      </p>

      {/* PIN indicator dots: a fixed number of slots, so the display never
          reveals the real PIN length. Errors surface in the alert text
          below , the dots stay neutral. */}
      <div className="flex gap-3 mb-2 flex-wrap justify-center max-w-[240px]" aria-hidden="true">
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
      <p role="status" className="sr-only">
        {`${pin.length} digits entered, at least ${MIN_PIN_LEN} required`}
      </p>

      {error && (
        <p role="alert" className="text-xs text-rose-400 mb-4 animate-shake text-center max-w-[260px]">
          {error}
        </p>
      )}

      {lockedOut && (
        <p className="text-xs text-amber-300 mb-4 font-mono">
          {t('lockedFor')} {lockoutLeft}s
        </p>
      )}

      {/* Number Keypad */}
      <div className={`grid grid-cols-3 gap-3 w-64 ${lockedOut ? 'opacity-40 pointer-events-none' : ''}`}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            onClick={() => handleDigit(digit)}
            disabled={lockedOut || busy}
            aria-label={`${t('digitLabel')} ${digit}`}
            className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
          >
            {digit}
          </button>
        ))}
        <button
          onClick={() => setPin('')}
          disabled={lockedOut || busy}
          aria-label={t('clear')}
          className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-xs font-medium text-slate-400 flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
        >
          {t('clear')}
        </button>
        <button
          onClick={() => handleDigit('0')}
          disabled={lockedOut || busy}
          aria-label={`${t('digitLabel')} 0`}
          className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
        >
          0
        </button>
        <button
          onClick={handleDelete}
          disabled={lockedOut || busy}
          className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-slate-400 hover:text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
          aria-label={t('deleteLabel')}
        >
          <Delete className="w-5 h-5" />
        </button>
      </div>

      <button
        onClick={() => tryUnlockRef.current()}
        disabled={!ready}
        className={`mt-5 w-64 min-h-[48px] rounded-2xl font-semibold text-sm transition flex items-center justify-center gap-2 ${
          ready
            ? 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'
            : 'bg-white/[0.04] text-slate-600 cursor-not-allowed'
        }`}
      >
        <LogIn className="w-4 h-4" />
        <span>{busy ? 'Unlocking…' : 'Unlock'}</span>
      </button>
      {!lockedOut && (
        <p className="mt-2 text-[11px] text-slate-500 text-center max-w-[260px]">
          {attempts > 0
            ? `${t('incorrectPin')} ${MAX_ATTEMPTS - attempts} ${t('attemptsLeft')}.`
            : `Enter ${MIN_PIN_LEN}–${MAX_PIN_LEN} digits, then press Unlock.`}
        </p>
      )}

      <p className="mt-6 text-xs text-slate-500 flex items-center gap-1.5">
        <Shield className="w-3.5 h-3.5" />
        <span>{t('pinLocalOnly')}</span>
      </p>
      <div className="mt-4 max-w-[300px] space-y-2 text-center">
        <p className="text-[11px] text-amber-300/90 leading-relaxed">
          Forgot your PIN? There is no recovery , clearing the app data is the only reset, and the locked vault goes with it.
        </p>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Tip: lock anytime from Settings → App Lock → Lock Now.
        </p>
        <p className="text-[11px] text-slate-600 leading-relaxed">
          This screen does not block screenshots or screen recording , keep your device screen lock on.
        </p>
      </div>
    </div>
  );
};
