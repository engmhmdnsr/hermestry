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
    // ignore , default below
  }
  return 'en';
};

function riskStyle(risk: string | undefined): string {
  const r = (risk || '').toLowerCase();
  if (r === 'high') return 'bg-red-500/20 text-red-300 border-red-500/30';
  if (r === 'medium') return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
  return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
}

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="min-w-0">
    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
    <p className={`text-xs text-slate-200 break-all leading-relaxed ${mono ? 'font-mono' : ''}`}>
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
    return approval.risk || '';
  })();

  const denyCls = destructive
    ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-xs'
    : 'bg-white/[0.05] hover:bg-white/[0.08] text-slate-300 border border-white/[0.08]';
  const allowOnceCls = destructive
    ? 'bg-white/[0.05] hover:bg-white/[0.08] text-slate-200 border border-white/[0.08]'
    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs';
  const allowSessionCls = destructive
    ? 'bg-white/[0.05] hover:bg-white/[0.08] text-slate-200 border border-white/[0.08]'
    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs';

  return (
    <div
      role="group"
      aria-label={approval.summary}
      className={`rounded-xl border p-3 ${
        destructive ? 'border-rose-500/30 bg-rose-500/[0.06]' : 'border-amber-500/20 bg-black/20'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`p-2 rounded-xl shrink-0 ${
            destructive ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-500/20 text-amber-300'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-xs text-slate-200 leading-relaxed break-words">{approval.summary}</p>
          {approval.risk && (
            <span
              className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${riskStyle(approval.risk)}`}
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
            <Field label={tr('apprRun')} value={approval.runId} mono />
            {approval.sessionId && <Field label={tr('apprSession')} value={approval.sessionId} mono />}
          </div>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-200"
        >
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/[0.08]">
        <button
          onClick={() => onDeny(approval)}
          disabled={disabled}
          className={`flex-1 min-h-[44px] py-2 rounded-xl text-xs font-medium transition cursor-pointer disabled:opacity-50 ${denyCls}`}
        >
          {tr('deny')}
        </button>
        <button
          onClick={() => onAllow(approval, 'once')}
          disabled={disabled}
          className={`flex-1 min-h-[44px] py-2 rounded-xl text-xs font-semibold transition cursor-pointer disabled:opacity-50 ${allowOnceCls}`}
        >
          {tr('allowOnce')}
        </button>
        <button
          onClick={() => onAllow(approval, 'session')}
          disabled={disabled}
          className={`flex-1 min-h-[44px] py-2 rounded-xl text-xs font-semibold transition cursor-pointer disabled:opacity-50 ${allowSessionCls}`}
        >
          {tr('allowSession')}
        </button>
      </div>
    </div>
  );
};
