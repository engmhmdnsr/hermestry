import React, { useState, useEffect, useRef } from 'react';
import { Lock, Delete, Shield } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface AppLockGateProps {
  onUnlocked: () => void;
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 30;

export const AppLockGate: React.FC<AppLockGateProps> = ({ onUnlocked }) => {
  const { settings } = useHermes();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [lockoutLeft, setLockoutLeft] = useState(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expectedLen = Math.min(8, Math.max(4, (settings.appLockPin || '').length || 4));
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

  const handleDigit = (d: string) => {
    if (lockedOut) return;
    if (pin.length >= expectedLen) return;
    const next = pin + d;
    setPin(next);
    setError(null);
    if (next.length === expectedLen) {
      if (next === settings.appLockPin) {
        onUnlocked();
      } else {
        const used = attempts + 1;
        setAttempts(used);
        if (used >= MAX_ATTEMPTS) {
          setLockoutLeft(LOCKOUT_SECONDS);
          setPin('');
          setError(`Too many wrong attempts. Try again in ${LOCKOUT_SECONDS}s.`);
        } else {
          flashError(`Incorrect PIN. ${MAX_ATTEMPTS - used} attempts left.`);
        }
      }
    }
  };

  const handleDelete = () => {
    if (lockedOut) return;
    setPin((prev) => prev.slice(0, -1));
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#090B0E] flex flex-col items-center justify-center p-6 text-slate-200">
      <div className="w-16 h-16 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6 shadow-sm">
        <Lock className="w-7 h-7 text-indigo-400" />
      </div>

      <h2 className="text-lg font-semibold text-white tracking-tight mb-1">
        Workspace Locked
      </h2>
      <p className="text-xs text-slate-400 mb-8">
        Enter your {expectedLen}-digit PIN to access Hermes Mobile
      </p>

      {/* PIN indicator dots */}
      <div className="flex gap-3 mb-8 flex-wrap justify-center max-w-[240px]">
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
        <p className="text-xs text-rose-400 mb-4 animate-shake text-center max-w-[260px]">
          {error}
        </p>
      )}

      {lockedOut && (
        <p className="text-xs text-amber-300 mb-4 font-mono">
          Locked for {lockoutLeft}s
        </p>
      )}

      {/* Number Keypad */}
      <div className={`grid grid-cols-3 gap-3 w-64 ${lockedOut ? 'opacity-40 pointer-events-none' : ''}`}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            onClick={() => handleDigit(digit)}
            disabled={lockedOut}
            className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
          >
            {digit}
          </button>
        ))}
        <button
          onClick={() => setPin('')}
          disabled={lockedOut}
          className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-xs font-medium text-slate-400 flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
        >
          Clear
        </button>
        <button
          onClick={() => handleDigit('0')}
          disabled={lockedOut}
          className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
        >
          0
        </button>
        <button
          onClick={handleDelete}
          disabled={lockedOut}
          className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-slate-400 hover:text-white flex items-center justify-center transition cursor-pointer disabled:cursor-not-allowed"
          aria-label="Delete"
        >
          <Delete className="w-5 h-5" />
        </button>
      </div>

      <p className="mt-8 text-xs text-slate-500 flex items-center gap-1.5">
        <Shield className="w-3.5 h-3.5" />
        <span>PIN is stored only on this device</span>
      </p>
    </div>
  );
};
