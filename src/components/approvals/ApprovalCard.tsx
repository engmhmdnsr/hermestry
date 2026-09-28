import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { PendingApproval } from '../../types/hermes';
import { getTranslation } from '../../constants/languages';

interface ApprovalCardProps {
  approval: PendingApproval;
  resolving?: boolean;
  onDeny: (approval: PendingApproval) => void;
  onAllow: (approval: PendingApproval, scope: 'once' | 'session') => void;
  // Optional failure copy for this approval (e.g. ChatTab's approvalFailures
  // entry). Rendered as role="alert" on the card itself.
  error?: string;
  // Optional i18n resolver (ChatTab's t). Falls back to document language
  // so the card never renders hardcoded copy when used standalone.
  t?: (key: string) => string;
}

const documentLang = (): string => {
  try {
    const l = typeof document !== 'undefined' ? document.documentElement.lang : '';
    if (l) return l.toLowerCase().split('-')[0];
  } catch {
    // ignore, default below
  }
  return 'en';
};

// Risk reads through the shared badge vocabulary: high danger, medium warning,
// low or unknown neutral.
function riskPillClass(risk: string | undefined): string {
  const r = (risk || '').toLowerCase();
  if (r === 'high') return 'pill-danger';
  if (r === 'medium') return 'pill-warning';
  return 'pill-neutral';
}

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="min-w-0">
    <p className="t-caption uppercase tracking-wide text-[var(--app-text-dim)]">{label}</p>
    <p className={`t-caption text-[var(--app-text-muted)] break-all leading-relaxed ${mono ? 'font-mono' : ''}`}>
      {value}
    </p>
  </div>
);

export const ApprovalCard: React.FC<ApprovalCardProps> = ({
  approval,
  resolving = false,
  onDeny,
  onAllow,
  error,
  t,
}) => {
  const tr: (key: string) => string =
    t ?? ((key: string) => getTranslation(key, documentLang()));
  const tx = (key: string, fallback: string): string => {
    const value = tr(key);
    return value && value !== key ? value : fallback;
  };
  const argsText = approval.args && approval.args.length > 0 ? approval.args.join(' ') : null;
  const fullCommand = [approval.command, argsText].filter(Boolean).join(' ');
  const disabled = resolving;

  // A destructive (high-risk) approval must not present Allow as the primary
  // action: Deny becomes the strong, expected button and Allow drops to the
  // neutral treatment so the safer choice is the visually obvious one.
  const destructive = (approval.risk || '').toLowerCase() === 'high';
  const riskLabel = (() => {
    const r = (approval.risk || '').toLowerCase();
    if (r === 'high') return tx('apprRiskHigh', 'High');
    if (r === 'medium') return tx('apprRiskMedium', 'Medium');
    if (r === 'low') return tx('apprRiskLow', 'Low');
    return tx('apprRiskUnknown', 'Unknown');
  })();

  const neutralBtn = 'bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] text-[var(--app-text-muted)] edge';
  const denyCls = destructive
    ? 'bg-[var(--app-danger)] hover:brightness-110 text-[var(--app-bg)]'
    : neutralBtn;
  const allowOnceCls = destructive
    ? neutralBtn
    : 'bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)]';
  const allowSessionCls = destructive
    ? neutralBtn
    : 'bg-[var(--app-success)] hover:brightness-110 text-[var(--app-bg)]';

  return (
    <div
      role="group"
      aria-label={approval.summary}
      className={`r-md elev-0 border p-3 ${
        destructive
          ? 'border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)]'
          : 'border-[var(--app-border)] bg-[var(--app-card)]'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`p-2 r-xs shrink-0 ${
            destructive
              ? 'bg-[var(--app-danger-subtle)] text-[var(--app-danger)]'
              : 'bg-[var(--app-warning-subtle)] text-[var(--app-warning)]'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          {/* The summary is the strongest line on the card: body size with
              heading emphasis. */}
          <p className="t-body font-semibold tracking-tight text-[var(--app-text)] leading-relaxed break-words">
            {approval.summary}
          </p>
          {approval.risk && (
            <span
              className={`inline-block t-micro font-semibold ${riskPillClass(approval.risk)}`}
            >
              {tr('apprRisk')}: {riskLabel}
            </span>
          )}
          <div className="grid gap-2">
            {approval.tool && <Field label={tr('apprTool')} value={approval.tool} mono />}
            {fullCommand && <Field label={tr('apprCommand')} value={fullCommand} mono />}
            {approval.path && <Field label={tr('apprPath')} value={approval.path} mono />}
            {approval.cwd && <Field label={tr('apprCwd')} value={approval.cwd} mono />}
            {approval.reason && <Field label={tr('apprReason')} value={approval.reason} />}
            <Field label={tx('apprRequestId', 'Request id')} value={approval.runId} mono />
            {approval.sessionId && <Field label={tx('apprSessionLabel', 'Chat')} value={approval.sessionId} mono />}
          </div>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="mt-3 r-xs px-3 py-2 t-caption border border-[var(--app-danger-border)] bg-[var(--app-danger-subtle)] text-[var(--app-danger)]"
        >
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 mt-3 pt-2 hairline border-t">
        <button
          onClick={() => onDeny(approval)}
          disabled={disabled}
          className={`flex-1 min-h-[44px] py-2 r-md t-caption font-medium transition cursor-pointer disabled:opacity-50 ${denyCls}`}
        >
          {tr('deny')}
        </button>
        <button
          onClick={() => onAllow(approval, 'once')}
          disabled={disabled}
          className={`flex-1 min-h-[44px] py-2 r-md t-caption font-semibold transition cursor-pointer disabled:opacity-50 ${allowOnceCls}`}
        >
          {tx('apprAllowOnce', 'Allow once')}
        </button>
        <button
          onClick={() => onAllow(approval, 'session')}
          disabled={disabled}
          className={`flex-1 min-h-[44px] py-2 r-md t-caption font-semibold transition cursor-pointer disabled:opacity-50 ${allowSessionCls}`}
        >
          {tx('apprAllowSession', 'Allow for this chat')}
        </button>
      </div>
    </div>
  );
};
