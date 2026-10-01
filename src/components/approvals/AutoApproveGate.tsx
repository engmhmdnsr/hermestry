import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
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
    // ignore, default below
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
  // The gate stays mounted while the policy changes underneath (another
  // surface disables it, a profile switch reloads settings): the draft must
  // follow, or the checkboxes show a policy that is no longer live.
  // Content-keyed, not ref-keyed: normalizePolicy builds a fresh array every
  // render, so depending on the array identity would reset the user's
  // in-progress draft on every render. The serialized key only moves when
  // the actual policy content changes.
  const policyKey = `${policy.enabled ? '1' : '0'}:${[...policy.scopes].sort().join(',')}`;
  useEffect(() => {
    setDraftScopes(policy.scopes);
  }, [policyKey]);
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
    // Disabling keeps the scope selection: re-enabling restores exactly what
    // the user had, instead of punishing the kill-switch with lost config.
    onChange({ enabled: false, scopes: [...policy.scopes] });
    setExpanded(false);
    setConfirmText('');
    setAckRisk(false);
    setError(null);
  };

  if (policy.enabled) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="p-3 r-md elev-0 edge bg-[var(--app-card)] space-y-3"
      >
        <div className="flex items-center gap-2">
          {/* ON reads through the shared badge vocabulary: the warning tone
               carries the AlertTriangle this pill shows (a warning icon in a
               success pill is a lie), neutral for the scopes it covers. */}
          <span className="pill-warning t-caption font-semibold inline-flex items-center gap-1">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {tr('gateOnFor')}{' '}
            {policy.scopes.length > 0
              ? policy.scopes.map((s) => tr(SCOPE_LABEL_KEYS[s])).join(', ')
              : tr('gateOnNone')}
          </span>
        </div>
        <p className="t-caption text-[var(--app-text-muted)]">
          {tr('gateAdvice')}
        </p>
        <button
          onClick={handleDisable}
          className="w-full min-h-[44px] py-2 r-md bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] edge text-[var(--app-text-muted)] t-caption font-semibold cursor-pointer"
        >
          {tr('gateDisable')}
        </button>
      </div>
    );
  }

  return (
    <div className="p-3 r-md elev-0 edge bg-[var(--app-card-subtle)] space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="t-body font-medium text-[var(--app-text)]">{tr('gateTitle')}</p>
          <p className="t-caption text-[var(--app-text-muted)]">
            {tr('gateOffDesc')}
          </p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="auto-approve-options"
          className="px-3 min-h-[44px] r-sm t-caption font-medium bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] edge text-[var(--app-text-muted)] cursor-pointer shrink-0"
        >
          {expanded ? tr('cancel') : tr('enable')}
        </button>
      </div>

      {expanded && (
        <div id="auto-approve-options" className="space-y-2 pt-1">
          <div className="p-2 r-sm flex items-start gap-2 border border-[var(--app-warning-border)] bg-[var(--app-warning-subtle)]">
            <AlertTriangle className="w-4 h-4 text-[var(--app-warning)] shrink-0 mt-1" />
            <p className="t-caption text-[var(--app-warning)] leading-relaxed">
              {tr('gateWarning')}
            </p>
          </div>

          <div className="space-y-1">
            {AUTO_APPROVE_SCOPES.map((scope) => {
              const selected = draftScopes.includes(scope);
              return (
                <label
                  key={scope}
                  // Selected state is structural: an accent surface tint plus a
                  // check, never a straight colour swap.
                  className={`flex items-start gap-2 p-2 r-sm edge cursor-pointer ${
                    selected
                      ? 'bg-[var(--app-accent-subtle)] border-[var(--app-accent)]'
                      : 'bg-[var(--app-card)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleScope(scope)}
                    className="mt-1 accent-[var(--app-accent)]"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="pill-neutral t-micro font-medium inline-block">
                      {tr(SCOPE_LABEL_KEYS[scope])}
                    </span>
                    <span className="block t-caption text-[var(--app-text-muted)] mt-1">
                      {tr(SCOPE_DESC_KEYS[scope])}
                    </span>
                  </span>
                  {selected && (
                    <Check className="w-4 h-4 text-[var(--app-accent-text)] shrink-0 mt-1" />
                  )}
                </label>
              );
            })}
          </div>

          <label className="flex items-start gap-2 t-caption text-[var(--app-text-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={ackRisk}
              onChange={(e) => setAckRisk(e.target.checked)}
              className="mt-1 accent-[var(--app-warning)]"
            />
            {tr('gateAck')}
          </label>

          <div>
            <p className="t-caption text-[var(--app-text-muted)] mb-1">
              {withPhrase('gateTypeToConfirm')}
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              autoComplete="off"
              aria-label={tr('gateConfirmAria')}
              className="w-full px-3 py-2 r-sm edge bg-[var(--app-input-bg)] t-caption text-[var(--app-text)] placeholder:text-[var(--app-text-dim)] outline-none"
            />
          </div>

          {error && <p className="t-caption text-[var(--app-danger)]">{error}</p>}

          <button
            onClick={handleEnable}
            disabled={!canEnable}
            className={`w-full min-h-[44px] py-2 r-md t-caption font-semibold transition cursor-pointer ${
              canEnable
                ? 'bg-[var(--app-danger)] hover:brightness-110 text-[var(--app-bg)]'
                : 'bg-[var(--app-card-subtle)] text-[var(--app-text-dim)] cursor-not-allowed'
            }`}
          >
            {tr('gateEnableFor')}
          </button>
        </div>
      )}
    </div>
  );
};
