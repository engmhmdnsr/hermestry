import React, { useEffect, useState } from 'react';
import {
  Activity,
  Terminal,
  Cpu,
  ChevronDown,
  ChevronUp,
  X,
  Wrench,
  Sparkles,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { redactSecrets } from '../../services/redaction';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';

interface DesktopInspectorProps {
  isOpen: boolean;
  onClose: () => void;
}

type InspectorTab = 'tools' | 'logs' | 'system';

export const DesktopInspector: React.FC<DesktopInspectorProps> = ({ isOpen, onClose }) => {
  const {
    streaming,
    streamElapsed,
    turnMeta,
    usageIn,
    usageOut,
    settings,
    gatewayLogs,
    approvals,
    chat,
    t,
  } = useHermes();

  const [activeTab, setActiveTab] = useState<InspectorTab>('tools');
  const [techOpen, setTechOpen] = useState(false);
  const [isOverlay, setIsOverlay] = useState(false);

  // Escape closes it, the Android back button closes it (overlay stack), and
  // focus is trapped only while the panel is mounted as an overlay dialog
  // (phone). The desktop side panel stays non-modal so the rest of the app
  // remains reachable.
  const rootRef = useOverlayBehavior(isOpen, onClose, undefined, { trapFocus: isOverlay });

  // Plain-language key lookup with an English fallback, so new copy renders
  // correctly before translations land (languages.ts is not edited here).
  const tx = (key: string, fallback: string): string => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };

  useEffect(() => {
    if (!isOpen) return;
    const el = rootRef.current;
    setIsOverlay(!!el?.parentElement?.closest('[role="dialog"]'));
  }, [isOpen, rootRef]);

  if (!isOpen) return null;

  // Extract recent tool executions from the active session.
  const recentToolCalls = chat
    .filter((m) => m.tools && m.tools.length > 0)
    .slice(-4)
    .reverse();

  const tabs: { id: InspectorTab; label: string; icon: typeof Wrench }[] = [
    { id: 'tools', label: tx('inspectorTabSteps', 'Steps'), icon: Wrench },
    { id: 'logs', label: tx('inspectorTabEvents', 'Activity log'), icon: Terminal },
    { id: 'system', label: tx('inspectorTabUsage', 'Usage'), icon: Cpu },
  ];

  const pendingCountText = tx('inspectorPendingCount', '{count} waiting').replace(
    '{count}',
    String(approvals.length),
  );
  const stepCountText = (n: number) =>
    tx('inspectorStepCount', '{count} tools').replace('{count}', String(n));
  const eventCountText = tx('inspectorEventCount', '{count} events').replace(
    '{count}',
    String(gatewayLogs.length),
  );

  return (
    <aside
      ref={rootRef as React.Ref<HTMLElement>}
      role="dialog"
      aria-modal={isOverlay ? true : undefined}
      aria-label={tx('inspectorDialogLabel', 'Inspector panel')}
      style={{ paddingTop: 'var(--safe-top, 0px)' }}
      className="w-80 h-screen bg-[var(--app-bg,#080B0E)] border-s border-white/[0.07] flex flex-col shrink-0 text-xs"
    >
      {/* 1. Header */}
      <div className="min-h-[3.5rem] border-b border-white/[0.06] flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-indigo-400" />
          <span className="font-semibold text-white tracking-tight">{t('inspectorTitle')}</span>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.05] cursor-pointer"
          title={t('inspectorClose')}
          aria-label={t('inspectorClose')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 2. Mode Tabs */}
      <div
        role="tablist"
        aria-label={tx('inspectorTabsLabel', 'Inspector sections')}
        className="flex items-center p-2 border-b border-white/[0.06] bg-[var(--app-bg,#0A0D11)] gap-1"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 min-h-[44px] rounded-lg text-[11px] font-medium transition cursor-pointer ${
                isActive
                  ? 'bg-white/[0.08] text-white shadow-xs'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
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
                {tx('inspectorStepsHeading', 'What Hermes did')}
              </span>
              <span className="font-mono text-[10px] text-teal-400">
                {streaming
                  ? tx('inspectorStatusWorking', 'Working')
                  : tx('inspectorStatusIdle', 'Idle')}
              </span>
            </div>

            {recentToolCalls.length === 0 ? (
              <div className="p-4 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-center text-slate-500">
                {tx('inspectorNoSteps', 'Nothing yet. Hermes steps will appear here.')}
              </div>
            ) : (
              recentToolCalls.map((msg, i) => (
                <div
                  key={msg.id || i}
                  className="rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] p-3 space-y-2"
                >
                  <div className="flex items-center justify-between text-slate-300">
                    <span className="font-medium text-indigo-300 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-indigo-400" />
                      <span>{tx('inspectorActionsTaken', 'Actions taken')}</span>
                    </span>
                    <span
                      className="text-[10px] text-slate-500 font-mono"
                      aria-label={stepCountText(msg.tools?.length ?? 0)}
                    >
                      {stepCountText(msg.tools?.length ?? 0)}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {msg.tools?.map((tool, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded bg-teal-500/10 text-teal-300 font-mono text-[10px] border border-teal-500/20"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>

                  {msg.toolOutputs && msg.toolOutputs.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-white/[0.05] space-y-1 font-mono text-[11px] text-slate-400 max-h-36 overflow-y-auto">
                      {msg.toolOutputs.map((out, idx) => (
                        <div key={idx} className="bg-black/30 p-2 rounded leading-relaxed break-all whitespace-pre-wrap">
                          <span className="text-teal-400 font-bold">{out.toolName}</span>: {redactSecrets(out.output)}
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
                {tx('inspectorEventsHeading', 'Recent activity')}
              </span>
              <span className="text-[10px] text-slate-500" aria-label={eventCountText}>
                {eventCountText}
              </span>
            </div>

            <div className="p-3 rounded-xl bg-black/40 border border-white/[0.06] text-[11px] text-slate-300 space-y-1 max-h-[calc(100vh-210px)] overflow-y-auto overflow-x-hidden">
              {gatewayLogs.length === 0 ? (
                <span className="text-slate-600">
                  {tx('inspectorNoEvents', 'No activity recorded yet.')}
                </span>
              ) : (
                gatewayLogs.map((log, i) => (
                  <div key={i} className="leading-relaxed break-words whitespace-pre-wrap">
                    {redactSecrets(log)}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'system' && (
          <div className="space-y-3">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              {tx('inspectorUsageHeading', 'Session usage')}
            </span>

            {/* Token Metrics */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06]">
                <span className="text-[10px] text-slate-500 uppercase block">
                  {tx('inspectorInputTokens', 'Sent (tokens)')}
                </span>
                <span className="text-sm font-semibold text-white font-mono">{usageIn.toLocaleString()}</span>
              </div>
              <div className="p-3 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06]">
                <span className="text-[10px] text-slate-500 uppercase block">
                  {tx('inspectorOutputTokens', 'Received (tokens)')}
                </span>
                <span className="text-sm font-semibold text-white font-mono">{usageOut.toLocaleString()}</span>
              </div>
            </div>

            {/* Inference model, plain language on the front face */}
            <div className="p-3 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">{tx('inspectorActiveModel', 'Model')}</span>
                <span className="font-mono text-white font-medium truncate max-w-[140px]">
                  {settings.modelId.split('/').pop()}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">{tx('inspectorProvider', 'Provider')}</span>
                <span className="font-mono text-white capitalize">{settings.provider}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">{tx('inspectorThinking', 'Thinking effort')}</span>
                <span className="font-mono text-indigo-400 capitalize">{settings.reasoningEffort}</span>
              </div>
            </div>

            {/* Developer-only values live behind a disclosure, not on the front face. */}
            <div className="rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setTechOpen((v) => !v)}
                aria-expanded={techOpen}
                aria-controls="inspector-tech-details"
                className="w-full min-h-[44px] px-3 flex items-center justify-between text-slate-400 cursor-pointer"
              >
                <span className="text-[11px] font-medium">
                  {tx('inspectorTechDetails', 'Technical details')}
                </span>
                {techOpen ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>
              {techOpen && (
                <div id="inspector-tech-details" className="px-3 pb-3 space-y-1.5 font-mono text-[10px] text-slate-400">
                  <div className="flex justify-between gap-2">
                    <span>{tx('inspectorTechModelId', 'Model ID')}</span>
                    <span className="text-slate-300 break-all text-right">{settings.modelId}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>{tx('inspectorTechProviderId', 'Provider ID')}</span>
                    <span className="text-slate-300 break-all text-right">{settings.provider}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>{tx('inspectorTechEffort', 'Reasoning effort')}</span>
                    <span className="text-slate-300 break-all text-right">{settings.reasoningEffort}</span>
                  </div>
                  {(streaming || turnMeta) && (
                    <div className="flex justify-between gap-2">
                      <span>{tx('inspectorTechElapsed', 'Elapsed (s)')}</span>
                      <span className="text-slate-300 text-right">{streamElapsed}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Approvals summary */}
            <div className="p-3 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] space-y-1.5">
              <span className="text-slate-400 block font-medium">
                {tx('inspectorApprovalsHeading', 'Approvals')}
              </span>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">{tx('inspectorPending', 'Waiting for you')}</span>
                <span
                  className={`font-semibold ${approvals.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}
                  aria-label={pendingCountText}
                >
                  {pendingCountText}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">{tx('inspectorAutoApproveRow', 'Run without asking')}</span>
                <span className="text-slate-300">
                  {settings.autoApproveGlobal
                    ? tx('inspectorAutoApproveOn', 'On')
                    : tx('inspectorAutoApproveOff', 'Off')}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
