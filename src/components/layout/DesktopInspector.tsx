import React, { useState } from 'react';
import {
  FileText,
  Terminal,
  Activity,
  Cpu,
  Database,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  X,
  Code2,
  Folder,
  Layers,
  Wrench,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface DesktopInspectorProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DesktopInspector: React.FC<DesktopInspectorProps> = ({ isOpen, onClose }) => {
  const {
    connected,
    streaming,
    streamElapsed,
    turnMeta,
    usageIn,
    usageOut,
    settings,
    gatewayLogs,
    approvals,
    chat,
  } = useHermes();

  const [activeTab, setActiveTab] = useState<'tools' | 'logs' | 'system'>('tools');

  if (!isOpen) return null;

  // Extract recent tool executions from active session
  const recentToolCalls = chat
    .filter((m) => m.tools && m.tools.length > 0)
    .slice(-4)
    .reverse();

  return (
    <aside className="w-80 h-screen bg-[#080B0E] border-s border-white/[0.07] flex flex-col shrink-0 text-xs">
      {/* 1. Header */}
      <div className="h-14 border-b border-white/[0.06] flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-indigo-400" />
          <span className="font-semibold text-white tracking-tight">Inspector & Telemetry</span>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.05]"
          title="Close Inspector"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 2. Mode Tabs */}
      <div className="flex items-center p-2 border-b border-white/[0.06] bg-[#0A0D11] gap-1">
        {[
          { id: 'tools', label: 'Tool Output', icon: Wrench },
          { id: 'logs', label: 'Daemon Logs', icon: Terminal },
          { id: 'system', label: 'Agent State', icon: Cpu },
        ].map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-medium transition cursor-pointer ${
                isActive
                  ? 'bg-white/[0.08] text-white shadow-xs'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* 3. Panel Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeTab === 'tools' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-semibold uppercase tracking-wider">
                Active Tool Pipeline
              </span>
              <span className="font-mono text-[10px] text-teal-400">
                {streaming ? 'STREAMING' : 'IDLE'}
              </span>
            </div>

            {recentToolCalls.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#0E1217] border border-white/[0.06] text-center text-slate-500">
                No tool executions in current view. Ask Hermes to search the web or execute a command.
              </div>
            ) : (
              recentToolCalls.map((msg, i) => (
                <div
                  key={msg.id || i}
                  className="rounded-xl bg-[#0E1217] border border-white/[0.06] p-3 space-y-2"
                >
                  <div className="flex items-center justify-between text-slate-300">
                    <span className="font-medium text-indigo-300 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-indigo-400" />
                      <span>Invocations</span>
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      {msg.tools?.length} tools
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {msg.tools?.map((t, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded bg-teal-500/10 text-teal-300 font-mono text-[10px] border border-teal-500/20"
                      >
                        {t}
                      </span>
                    ))}
                  </div>

                  {msg.toolOutputs && msg.toolOutputs.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-white/[0.05] space-y-1 font-mono text-[11px] text-slate-400 max-h-36 overflow-y-auto">
                      {msg.toolOutputs.map((out, idx) => (
                        <div key={idx} className="bg-black/30 p-2 rounded leading-relaxed break-all whitespace-pre-wrap">
                          <span className="text-teal-400 font-bold">{out.toolName}</span>: {out.output}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="space-y-2 font-mono">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-semibold uppercase tracking-wider">
                Raw Event Stream
              </span>
              <span className="text-[10px] text-slate-500">
                {gatewayLogs.length} events
              </span>
            </div>

            <div className="p-3 rounded-xl bg-black/40 border border-white/[0.06] text-[11px] text-slate-300 space-y-1 max-h-[calc(100vh-210px)] overflow-y-auto">
              {gatewayLogs.length === 0 ? (
                <span className="text-slate-600">No logs captured yet.</span>
              ) : (
                gatewayLogs.map((log, i) => (
                  <div key={i} className="leading-relaxed break-all">
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'system' && (
          <div className="space-y-3">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Telemetry & Metrics
            </span>

            {/* Token Metrics */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-xl bg-[#0E1217] border border-white/[0.06]">
                <span className="text-[10px] text-slate-500 uppercase block">Input Tokens</span>
                <span className="text-sm font-semibold text-white font-mono">{usageIn.toLocaleString()}</span>
              </div>
              <div className="p-3 rounded-xl bg-[#0E1217] border border-white/[0.06]">
                <span className="text-[10px] text-slate-500 uppercase block">Output Tokens</span>
                <span className="text-sm font-semibold text-white font-mono">{usageOut.toLocaleString()}</span>
              </div>
            </div>

            {/* Inference Model & Endpoint */}
            <div className="p-3 rounded-xl bg-[#0E1217] border border-white/[0.06] space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Active Model</span>
                <span className="font-mono text-white font-medium truncate max-w-[140px]">
                  {settings.modelId.split('/').pop()}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Provider</span>
                <span className="font-mono text-white capitalize">{settings.provider}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Reasoning</span>
                <span className="font-mono text-indigo-400 capitalize">{settings.reasoningEffort}</span>
              </div>
            </div>

            {/* Pending Approvals Summary */}
            <div className="p-3 rounded-xl bg-[#0E1217] border border-white/[0.06] space-y-1.5">
              <span className="text-slate-400 block font-medium">Security Gate</span>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">Pending Actions</span>
                <span className={`font-semibold ${approvals.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {approvals.length} pending
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">Auto-Approve</span>
                <span className="text-slate-300">
                  {settings.autoApproveGlobal ? 'Active' : 'Disabled'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
