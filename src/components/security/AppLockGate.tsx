import React, { useState, useEffect, useRef } from 'react';
import { Lock, Delete, Shield } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface AppLockGateProps {
  onUnlocked: () => void;
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 30;

export const AppLockGate: React.FC<AppLockGateProps> = ({ onUnlocked }) => {
  const { settings, t, unlockSecrets } = useHermes();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [lockoutLeft, setLockoutLeft] = useState(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards double-submit while an async vault unlock is in flight. The PIN
  // is cleared from state the moment it is consumed, so without this the
  // gate would accept overlapping attempts.
  const busyRef = useRef(false);

  const storedPinLen = (() => {
    try {
      return Number(localStorage.getItem('hermes_pinlen')) || 0;
    } catch {
      return 0;
    }
  })();
  const expectedLen = Math.min(
    8,
    Math.max(4, (settings.appLockPin || '').length || storedPinLen || 4),
  );
  const lockedOut = lockoutLeft > 0;

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

  const flashError = (msg: string, keepPin = false) => {
    setError(msg);
    if (!keepPin) {
      clearTimer.current = setTimeout(() => setPin(''), 600);
    }
  };

  const failAttempt = () => {
    const used = attempts + 1;
    setAttempts(used);
    if (used >= MAX_ATTEMPTS) {
      setLockoutLeft(LOCKOUT_SECONDS);
      setPin('');
      setError(`${t('tooManyAttempts')} ${LOCKOUT_SECONDS}s.`);
    } else {
      flashError(`${t('incorrectPin')} ${MAX_ATTEMPTS - used} ${t('attemptsLeft')}.`);
    }
  };

  const handleDigit = (d: string) => {
    if (lockedOut || busyRef.current) return;
    if (pin.length >= expectedLen) return;
    const next = pin + d;
    setPin(next);
    setError(null);
    if (next.length !== expectedLen) return;
    let hasVault = false;
    try {
      hasVault = !!localStorage.getItem('hermes_vault');
    } catch {}
    if (hasVault) {
      // Consume the PIN immediately so it lives in JS state for the
      // shortest possible time. The local copy is the only reference
      // used for the unlock call below.
      const attempted = next;
      setPin('');
      busyRef.current = true;
      unlockSecrets(attempted).then((ok) => {
        busyRef.current = false;
        if (ok) {
          onUnlocked();
        } else {
          failAttempt();
        }
      });
    } else if (next === settings.appLockPin) {
      // Legacy no-vault setup: clear the PIN before leaving the gate.
      setPin('');
      onUnlocked();
    } else {
      failAttempt();
    }
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

  // Physical keyboard support: digits append, Backspace deletes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lockedOut) return;
      if (/^[0-9]$/.test(e.key)) {
        handleDigitRef.current(e.key);
      } else if (e.key === 'Backspace') {
        handleDeleteRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lockedOut]);

  return (
    <div className="fixed inset-0 z-50 bg-[var(--app-bg,#090B0E)] flex flex-col items-center justify-center p-6 text-slate-200">
      <div className="w-16 h-16 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6 shadow-sm">
        <Lock className="w-7 h-7 text-indigo-400" />
      </div>

      <h2 className="text-lg font-semibold text-white tracking-tight mb-1">
        {t('lockedTitle')}
      </h2>
      <p className="text-xs text-slate-400 mb-8">
        {t('enterPin')} {expectedLen}{t('digitPinAccess')}
      </p>

      {/* PIN indicator dots */}
      <div className="flex gap-3 mb-8 flex-wrap justify-center max-w-[240px]" aria-hidden="true">
        {Array.from({ length: expectedLen }).map((_, idx) => {
          const filled = idx < pin.length;
          return (
            <div
              key={idx}
              className={`w-3.5 h-3.5 rounded-full transition-all duration-200 ${
                error
                  ? 'bg-rose-500 scale-110'
                  : filled
                  ? 'bg-indigo-500 scale-110 shadow-xs'
                  : 'bg-white/[0.08] border border-white/[0.08]'
              }`}
            />
          );
        })}
      </div>

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
            disabled={lockedOut}
            aria-label={`${t('digitLabel')} ${digit}`}
            className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
          >
            {digit}
          </button>
        ))}
        <button
          onClick={() => setPin('')}
          disabled={lockedOut}
          aria-label={t('clear')}
          className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-xs font-medium text-slate-400 flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
        >
          {t('clear')}
        </button>
        <button
          onClick={() => handleDigit('0')}
          disabled={lockedOut}
          aria-label={`${t('digitLabel')} 0`}
          className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
        >
          0
        </button>
        <button
          onClick={handleDelete}
          disabled={lockedOut}
          className="h-14 rounded-2xl bg-[var(--app-card,#0E1217)] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-slate-400 hover:text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
          aria-label={t('deleteLabel')}
        >
          <Delete className="w-5 h-5" />
        </button>
      </div>

      <p className="mt-8 text-xs text-slate-500 flex items-center gap-1.5">
        <Shield className="w-3.5 h-3.5" />
        <span>{t('pinLocalOnly')}</span>
      </p>
    </div>
  );
};
