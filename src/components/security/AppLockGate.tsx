import React, { useState } from 'react';
import { Lock, Delete, ArrowRight, Shield } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface AppLockGateProps {
  onUnlocked: () => void;
}

export const AppLockGate: React.FC<AppLockGateProps> = ({ onUnlocked }) => {
  const { settings } = useHermes();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  const handleDigit = (d: string) => {
    if (pin.length < 4) {
      const next = pin + d;
      setPin(next);
      setError(false);
      if (next.length === 4) {
        if (next === settings.appLockPin) {
          onUnlocked();
        } else {
          setError(true);
          setTimeout(() => setPin(''), 600);
        }
      }
    }
  };

  const handleDelete = () => {
    setPin((prev) => prev.slice(0, -1));
    setError(false);
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
        Enter your 4-digit PIN to access Hermes Mobile
      </p>

      {/* PIN indicator dots */}
      <div className="flex gap-4 mb-8">
        {[0, 1, 2, 3].map((idx) => {
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
        <p className="text-xs text-rose-400 mb-4 animate-shake">
          Incorrect PIN. Please try again.
        </p>
      )}

      {/* Number Keypad */}
      <div className="grid grid-cols-3 gap-3 w-64">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            onClick={() => handleDigit(digit)}
            className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer"
          >
            {digit}
          </button>
        ))}
        <button
          onClick={() => setPin('')}
          className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-xs font-medium text-slate-400 flex items-center justify-center transition cursor-pointer"
        >
          Clear
        </button>
        <button
          onClick={() => handleDigit('0')}
          className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-base font-semibold text-white flex items-center justify-center transition cursor-pointer"
        >
          0
        </button>
        <button
          onClick={handleDelete}
          className="h-14 rounded-2xl bg-[#0E1217] hover:bg-white/[0.06] active:scale-95 border border-white/[0.06] text-slate-400 hover:text-white flex items-center justify-center transition cursor-pointer"
          aria-label="Delete"
        >
          <Delete className="w-5 h-5" />
        </button>
      </div>

      <p className="mt-8 text-xs text-slate-400">
        Default passcode: 1234
      </p>
    </div>
  );
};
