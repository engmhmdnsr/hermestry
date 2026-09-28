import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { PendingApproval } from '../../types/hermes';

interface ApprovalCardProps {
  approval: PendingApproval;
  resolving?: boolean;
  onDeny: (approval: PendingApproval) => void;
  onAllow: (approval: PendingApproval, scope: 'once' | 'session') => void;
}

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
}) => {
  const argsText = approval.args && approval.args.length > 0 ? approval.args.join(' ') : null;
  const fullCommand = [approval.command, argsText].filter(Boolean).join(' ');
  const disabled = resolving;

  return (
    <div className="rounded-xl border border-amber-500/20 bg-black/20 p-3">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-amber-500/20 text-amber-300 shrink-0">
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-xs text-slate-200 leading-relaxed break-words">{approval.summary}</p>
          {approval.risk && (
            <span
              className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${riskStyle(approval.risk)}`}
            >
              Risk: {approval.risk}
            </span>
          )}
          <div className="grid gap-2">
            {approval.tool && <Field label="Tool" value={approval.tool} mono />}
            {fullCommand && <Field label="Command" value={fullCommand} mono />}
            {approval.path && <Field label="Path" value={approval.path} mono />}
            {approval.cwd && <Field label="Working directory" value={approval.cwd} mono />}
            {approval.reason && <Field label="Reason" value={approval.reason} />}
            <Field label="Run" value={approval.runId} mono />
            {approval.sessionId && <Field label="Session" value={approval.sessionId} mono />}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-amber-500/20">
        <button
          onClick={() => onDeny(approval)}
          disabled={disabled}
          className="flex-1 min-h-[44px] py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-slate-300 text-xs font-medium border border-white/[0.08] transition cursor-pointer disabled:opacity-50"
        >
          Deny
        </button>
        <button
          onClick={() => onAllow(approval, 'once')}
          disabled={disabled}
          className="flex-1 min-h-[44px] py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer disabled:opacity-50"
        >
          Allow Once
        </button>
        <button
          onClick={() => onAllow(approval, 'session')}
          disabled={disabled}
          className="flex-1 min-h-[44px] py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer disabled:opacity-50"
        >
          Allow Session
        </button>
      </div>
    </div>
  );
};
