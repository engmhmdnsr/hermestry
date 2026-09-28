// DebugBundlePanel.tsx
// DEBUG-02 + LOG-01 + LOG-02:
// Share requires explicit consent (contents, destination, retention).
// Log lines use a fixed format with severity and correlation ids and
// carry no credentials (redacted before format, never after).
// Every user-visible string goes through the translate function; log lines,
// URLs and paths stay raw mono text.

import React, { useState } from 'react';
import type { DebugShare } from '../../types/hermes';
import { redactSecrets, runRedactionSelfTests } from '../../services/redaction';
import { useHermes } from '../../context/HermesContext';

// Consent facts as translatable pairs with an English fallback. The raw
// endpoint and policy wording stay in the code, not in front of the user.
export const DEBUG_SHARE_CONSENT_SPEC = {
  requiresExplicitConfirm: true,
  contentsKey: 'debugConsentContents',
  contents:
    'the app version and platform, service status and checks, settings with secrets removed, and the last 200 log lines',
  destinationKey: 'debugConsentDestination',
  destination: 'sent to your own Hermes server, and any links come back to this phone only',
  retentionKey: 'debugConsentRetention',
  retention: 'kept on your Hermes server under its own policy, so delete it from the server when you are done',
  redactionNoteKey: 'debugConsentRedaction',
  redactionNote: 'secrets are removed before upload, and the secret-removal self-tests must pass first',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// LOG-02 canonical log line format.
export interface CanonicalLogLine {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  requestId?: string;
  runId?: string;
  sessionId?: string;
}

export const formatLogLine = (line: CanonicalLogLine): string => {
  const safe = redactSecrets(line);
  const corr = [safe.requestId, safe.runId, safe.sessionId].filter(Boolean).join('/');
  const corrSuffix = corr ? ` [${corr}]` : '';
  return `[${safe.timestamp}] ${safe.level.toUpperCase()} ${safe.component}${corrSuffix} ${safe.message}`;
};

export interface DebugBundleInput {
  appVersion: string;
  platform: string;
  gatewayState: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  settings: Record<string, unknown>;
  logs: CanonicalLogLine[];
}

export const buildDebugBundle = (input: DebugBundleInput): Record<string, unknown> => {
  return redactSecrets({
    appVersion: input.appVersion,
    platform: input.platform,
    gatewayState: input.gatewayState,
    checks: input.checks,
    settings: input.settings,
    logs: input.logs.slice(-200).map(formatLogLine),
  });
};

interface DebugBundlePanelProps {
  sharing: boolean;
  result: DebugShare | null;
  onShareDebug: () => void;
  // Translate lookup from the caller (useHermes). Optional: a missing lookup
  // degrades to the English fallback instead of printing the raw key.
  t?: (key: string) => string;
}

export const DebugBundlePanel: React.FC<DebugBundlePanelProps> = ({ sharing, result, onShareDebug, t }) => {
  const [consentContents, setConsentContents] = useState(false);
  const [consentDest, setConsentDest] = useState(false);
  const selfTests = runRedactionSelfTests();
  const ready = consentContents && consentDest && selfTests.passed;
  // The prop wins when a caller passes its own lookup; otherwise the app
  // context supplies it, so this panel translates even when mounted bare.
  const { t: ctxT } = useHermes();
  const lookup = t ?? ctxT;
  const tx = (key: string, fallback: string): string => {
    const v = lookup(key);
    return !v || v === key ? fallback : v;
  };

  return (
    <div className="r-md edge elev-0 bg-[var(--app-card)] p-5 space-y-4">
      <div>
        <h4 className="t-heading text-[var(--app-text)]">{tx('debugBundleTitlePlain', 'Diagnostics bundle')}</h4>
        <p className="t-body text-[var(--app-text-muted)] mt-1">
          {tx('debugBundleIntroPlain', 'Nothing is shared until you tick both boxes. Secrets are removed before upload.')}
        </p>
      </div>
      <div className="t-caption text-[var(--app-text-muted)] space-y-2">
        <p>
          <span className="t-label text-[var(--app-text)]">{tx('debugContentsLabel', 'Contents')}: </span>
          {tx(DEBUG_SHARE_CONSENT_SPEC.contentsKey, DEBUG_SHARE_CONSENT_SPEC.contents)}.
        </p>
        <p>
          <span className="t-label text-[var(--app-text)]">{tx('debugDestinationLabel', 'Where it goes')}: </span>
          {tx(DEBUG_SHARE_CONSENT_SPEC.destinationKey, DEBUG_SHARE_CONSENT_SPEC.destination)}.
        </p>
        <p>
          <span className="t-label text-[var(--app-text)]">{tx('debugRetentionLabel', 'How long it is kept')}: </span>
          {tx(DEBUG_SHARE_CONSENT_SPEC.retentionKey, DEBUG_SHARE_CONSENT_SPEC.retention)}.
        </p>
        <p>
          <span className="t-label text-[var(--app-text)]">{tx('debugSelfTestsLabel', 'Secret-removal self-tests')}: </span>
          {selfTests.passed ? (
            <span className="pill-success">
              {tx('debugSelfTestsPassed', 'Passed')} ({selfTests.checked}/{selfTests.checked})
            </span>
          ) : (
            <span className="pill-danger">
              {tx('debugSelfTestsFailedPill', 'Failed')}: {selfTests.failures.join('; ')}
            </span>
          )}
        </p>
      </div>
      <label className="flex items-start gap-2 t-label text-[var(--app-text)] cursor-pointer">
        <input
          type="checkbox"
          checked={consentContents}
          onChange={(e) => setConsentContents(e.target.checked)}
          className="mt-1"
        />
        <span>{tx('debugConsentContentsAck', 'I agree to share the contents listed above, with secrets removed.')}</span>
      </label>
      <label className="flex items-start gap-2 t-label text-[var(--app-text)] cursor-pointer">
        <input
          type="checkbox"
          checked={consentDest}
          onChange={(e) => setConsentDest(e.target.checked)}
          className="mt-1"
        />
        <span>{tx('debugConsentDestinationAck', 'I understand where it goes and how long it is kept.')}</span>
      </label>
      <button
        onClick={onShareDebug}
        disabled={sharing || !ready}
        title={!selfTests.passed ? tx('debugTestsMustPass', 'Secret-removal self-tests must pass first') : undefined}
        className="inline-flex items-center justify-center px-4 min-h-[44px] r-sm bg-[var(--app-warning)] hover:opacity-90 disabled:opacity-50 text-[var(--app-bg)] t-label font-semibold cursor-pointer"
      >
        {sharing
          ? tx('debugGeneratingPlain', 'Building the bundle…')
          : tx('debugShareAction', 'Build and share the bundle')}
      </button>
      {result && (
        <div
          role="status"
          className="r-sm edge bg-[var(--app-card-subtle)] px-3 py-2 space-y-2"
        >
          <span className="pill-success">{tx('debugSharedPill', 'Shared')}</span>
          <p className="t-caption text-[var(--app-text)] break-words">{result.summary}</p>
          {result.urls.length > 0 && (
            <ul className="space-y-2">
              {result.urls.map((u) => (
                <li key={u} className="t-micro normal-case font-mono text-[var(--app-text-muted)] break-all">
                  {u}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
