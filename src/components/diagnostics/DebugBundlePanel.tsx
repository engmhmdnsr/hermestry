// DebugBundlePanel.tsx
// DEBUG-02 + LOG-01 + LOG-02:
// Share requires explicit consent (contents, destination, retention).
// Log lines use a fixed format with severity and correlation ids and
// carry no credentials (redacted before format, never after).

import React, { useState } from 'react';
import type { DebugShare } from '../../types/hermes';
import { redactSecrets, runRedactionSelfTests } from '../../services/redaction';

export const DEBUG_SHARE_CONSENT_SPEC = {
  requiresExplicitConfirm: true,
  contents: [
    'app version and platform',
    'gateway status and doctor checks',
    'redacted settings (no keys)',
    'recent log lines (redacted, capped at 200)',
  ],
  destination: 'gateway /api/debug/share, URLs returned to this device only',
  retention: 'bundle kept server-side per gateway policy; delete via gateway ops',
  redactionNote: 'central content-aware redaction runs before upload; leak self-tests must pass',
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
}

export const DebugBundlePanel: React.FC<DebugBundlePanelProps> = ({ sharing, result, onShareDebug }) => {
  const [consentContents, setConsentContents] = useState(false);
  const [consentDest, setConsentDest] = useState(false);
  const selfTests = runRedactionSelfTests();
  const ready = consentContents && consentDest && selfTests.passed;

  return (
    <div className="rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] p-5 space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-white">Debug bundle</h4>
        <p className="text-xs text-slate-400 mt-0.5">
          Explicit consent required. Secrets are redacted before upload.
        </p>
      </div>
      <div className="text-[11px] text-slate-400 space-y-1">
        <p><span className="text-slate-200 font-medium">Contents: </span>{DEBUG_SHARE_CONSENT_SPEC.contents.join('; ')}.</p>
        <p><span className="text-slate-200 font-medium">Destination: </span>{DEBUG_SHARE_CONSENT_SPEC.destination}.</p>
        <p><span className="text-slate-200 font-medium">Retention: </span>{DEBUG_SHARE_CONSENT_SPEC.retention}.</p>
        <p>
          <span className="text-slate-200 font-medium">Leak self-tests: </span>
          {selfTests.passed ? (
            <span className="text-emerald-400">passed ({selfTests.checked}/{selfTests.checked})</span>
          ) : (
            <span className="text-rose-400">FAILED: {selfTests.failures.join('; ')}</span>
          )}
        </p>
      </div>
      <label className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={consentContents}
          onChange={(e) => setConsentContents(e.target.checked)}
          className="mt-0.5"
        />
        <span>I agree to share the contents listed above, redacted.</span>
      </label>
      <label className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={consentDest}
          onChange={(e) => setConsentDest(e.target.checked)}
          className="mt-0.5"
        />
        <span>I understand the destination and retention policy above.</span>
      </label>
      <button
        onClick={onShareDebug}
        disabled={sharing || !ready}
        title={!selfTests.passed ? 'Redaction self-tests must pass first' : undefined}
        className="px-3.5 py-2 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
      >
        {sharing ? 'Generating bundle...' : 'Generate and share debug bundle'}
      </button>
      {result && (
        <p role="status" className="text-[11px] text-slate-300">{result.summary}</p>
      )}
    </div>
  );
};
