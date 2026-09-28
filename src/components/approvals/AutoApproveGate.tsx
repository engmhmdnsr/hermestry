import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  AUTO_APPROVE_SCOPES,
  type AutoApprovePolicy,
  type AutoApproveScope,
} from './approvalScopes';
import { getTranslation } from '../../constants/languages';

interface AutoApproveGateProps {
  policy: AutoApprovePolicy;
  onChange: (next: AutoApprovePolicy) => void;
  // Optional i18n resolver (SettingsTab's t). Falls back to document
  // language so the gate never renders hardcoded copy when used standalone.
  t?: (key: string) => string;
}

// Typed confirmation phrase. Always Latin "ENABLE" in every locale so the
// comparison stays exact; the surrounding prompt text is localized.
const CONFIRM_PHRASE = 'ENABLE';

const SCOPE_LABEL_KEYS: Record<AutoApproveScope, string> = {
  read: 'scopeRead',
  write: 'scopeWrite',
  exec: 'scopeExec',
  network: 'scopeNetwork',
  install: 'scopeInstall',
};

const SCOPE_DESC_KEYS: Record<AutoApproveScope, string> = {
  read: 'scopeDescRead',
  write: 'scopeDescWrite',
  exec: 'scopeDescExec',
  network: 'scopeDescNetwork',
  install: 'scopeDescInstall',
};

const documentLang = (): string => {
  try {
    const l = typeof document !== 'undefined' ? document.documentElement.lang : '';
    if (l) return l.toLowerCase().split('-')[0];
  } catch {
    // ignore , default below
  }
  return 'en';
};

export const AutoApproveGate: React.FC<AutoApproveGateProps> = ({ policy, onChange, t }) => {
  const tr: (key: string) => string =
    t ?? ((key: string) => getTranslation(key, documentLang()));
  // {phrase} is replaced after lookup so the typed Latin token is never
  // translated; wrap it in bidi isolates for RTL rendering.
  const withPhrase = (key: string): string =>
    tr(key).replace('{phrase}', `⁨${CONFIRM_PHRASE}⁩`);
  const [expanded, setExpanded] = useState(false);
  const [draftScopes, setDraftScopes] = useState<AutoApproveScope[]>(policy.scopes);
  const [ackRisk, setAckRisk] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const toggleScope = (scope: AutoApproveScope) => {
    setDraftScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
    setError(null);
  };

  const canEnable = ackRisk && draftScopes.length > 0 && confirmText.trim().toUpperCase() === CONFIRM_PHRASE;

  const handleEnable = () => {
    if (!ackRisk) {
      setError(tr('gateErrAck'));
      return;
    }
    if (draftScopes.length === 0) {
      setError(tr('gateErrScope'));
      return;
    }
    if (confirmText.trim().toUpperCase() !== CONFIRM_PHRASE) {
      setError(withPhrase('gateErrPhrase'));
      return;
    }
    setError(null);
    onChange({ enabled: true, scopes: [...draftScopes] });
    setExpanded(false);
    setConfirmText('');
    setAckRisk(false);
  };

  const handleDisable = () => {
    onChange({ enabled: false, scopes: [] });
    setExpanded(false);
    setConfirmText('');
    setAckRisk(false);
    setError(null);
  };

  if (policy.enabled) {
    return (
      <div className="p-3 rounded-2xl bg-red-500/10 border border-red-500/30 space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-300 shrink-0" />
          <p className="text-xs font-semibold text-red-200">
            {tr('gateOnFor')} {policy.scopes.join(', ') || tr('gateOnNone')}
          </p>
        </div>
        <p className="text-[11px] text-slate-400">
          {tr('gateAdvice')}
        </p>
        <button
          onClick={handleDisable}
          className="w-full min-h-[44px] py-2 rounded-xl bg-white/[0.05] text-slate-200 text-xs font-semibold border border-white/[0.08] cursor-pointer"
        >
          {tr('gateDisable')}
        </button>
      </div>
    );
  }

  return (
    <div className="p-3 rounded-2xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.06] space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-white">{tr('gateTitle')}</p>
          <p className="text-[11px] text-slate-400">
            {tr('gateOffDesc')}
          </p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] text-slate-300 border border-white/[0.08] cursor-pointer shrink-0"
        >
          {expanded ? tr('cancel') : tr('enable')}
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 pt-1">
          <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-200 leading-relaxed">
              {tr('gateWarning')}
            </p>
          </div>

          <div className="space-y-1.5">
            {AUTO_APPROVE_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex items-start gap-2 p-2 rounded-xl bg-black/20 border border-white/[0.06] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={draftScopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  className="mt-0.5 accent-emerald-500"
                />
                <span>
                  <span className="block text-xs font-medium text-slate-200">{tr(SCOPE_LABEL_KEYS[scope])}</span>
                  <span className="block text-[11px] text-slate-400">{tr(SCOPE_DESC_KEYS[scope])}</span>
                </span>
              </label>
            ))}
          </div>

          <label className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={ackRisk}
              onChange={(e) => setAckRisk(e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            {tr('gateAck')}
          </label>

          <div>
            <p className="text-[11px] text-slate-400 mb-1">
              {withPhrase('gateTypeToConfirm')}
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              autoComplete="off"
              aria-label={tr('gateConfirmAria')}
              className="w-full px-3 py-2 rounded-xl bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-slate-500 outline-none"
            />
          </div>

          {error && <p className="text-[11px] text-red-300">{error}</p>}

          <button
            onClick={handleEnable}
            disabled={!canEnable}
            className={`w-full min-h-[44px] py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
              canEnable
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-white/[0.04] text-slate-500 cursor-not-allowed'
            }`}
          >
            {tr('gateEnableFor')}
          </button>
        </div>
      )}
    </div>
  );
};
