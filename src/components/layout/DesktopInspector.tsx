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
import { PROVIDER_OPTIONS, normProvider } from '../../constants/providers';
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

  // Front-face values read as words a phone user recognises: the provider id
  // and the effort level stay raw only in the technical details below.
  const providerLabel = (() => {
    const norm = normProvider(settings.provider || '');
    const found = PROVIDER_OPTIONS.find(([id]) => id === norm);
    if (found) return found[1];
    return settings.provider || tx('inspectorNotSet', 'Not set');
  })();
  const effortWord = (() => {
    const level = (settings.reasoningEffort || '').toLowerCase();
    if (level === 'none') return tx('effortOff', 'Off');
    if (level === 'low') return tx('effortLow', 'Low');
    if (level === 'high') return tx('effortHigh', 'High');
    return tx('effortMedium', 'Med');
  })();

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
      aria-label={tx('inspectorDialogLabel', 'Technical details panel')}
      style={{ paddingTop: 'var(--safe-top, 0px)' }}
      className="w-80 h-screen bg-[var(--app-bg)] border-s edge flex flex-col shrink-0"
    >
      {/* 1. Header */}
      <div className="min-h-[3.5rem] hairline border-b flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[var(--app-accent-text)]" />
          <span className="t-heading font-semibold tracking-tight text-[var(--app-text)]">
            {tx('inspectorTitlePlain', 'Technical details')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="min-w-[44px] min-h-[44px] r-xs flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer"
          title={tx('closeDetails', 'Close the details')}
          aria-label={tx('closeDetails', 'Close the details')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 2. Mode Tabs */}
      <div
        role="tablist"
        aria-label={tx('inspectorTabsLabel', 'Sections')}
        className="flex items-center p-2 hairline border-b bg-[var(--app-bg)] gap-1"
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
              className={`flex-1 flex items-center justify-center gap-2 py-2 min-h-[44px] r-sm t-caption font-medium transition cursor-pointer ${
                isActive
                  ? 'bg-[var(--app-accent-subtle)] text-[var(--app-accent-text)]'
                  : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* 3. Panel Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeTab === 'tools' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="t-caption font-semibold uppercase tracking-wider text-[var(--app-text-muted)]">
                {tx('inspectorStepsHeading', 'What Hermes did')}
              </span>
              <span className="t-micro font-mono text-[var(--app-text-dim)]">
                {streaming
                  ? tx('inspectorStatusWorking', 'Working')
                  : tx('inspectorStatusIdle', 'Idle')}
              </span>
            </div>

            {recentToolCalls.length === 0 ? (
              <div className="p-4 r-md edge bg-[var(--app-card)] text-center t-caption text-[var(--app-text-dim)]">
                {tx('inspectorNoSteps', 'Nothing yet. Hermes steps will appear here.')}
              </div>
            ) : (
              recentToolCalls.map((msg, i) => (
                <div
                  key={msg.id || i}
                  className="r-md elev-0 edge bg-[var(--app-card)] p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="t-caption font-medium text-[var(--app-accent-text)] flex items-center gap-2">
                      <Sparkles className="w-3 h-3 text-[var(--app-accent-text)]" />
                      <span>{tx('inspectorActionsTaken', 'Actions taken')}</span>
                    </span>
                    <span
                      className="t-micro text-[var(--app-text-dim)] font-mono"
                      aria-label={stepCountText(msg.tools?.length ?? 0)}
                    >
                      {stepCountText(msg.tools?.length ?? 0)}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {msg.tools?.map((tool, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-1 r-xs t-micro font-mono border border-[var(--app-info-border)] bg-[var(--app-info-subtle)] text-[var(--app-info)]"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>

                  {msg.toolOutputs && msg.toolOutputs.length > 0 && (
                    <div className="mt-2 pt-2 hairline border-t space-y-1 font-mono t-micro text-[var(--app-text-muted)] max-h-36 overflow-y-auto">
                      {msg.toolOutputs.map((out, idx) => (
                        <div key={idx} className="bg-[var(--app-bg)] p-2 r-xs leading-relaxed break-all whitespace-pre-wrap">
                          <span className="text-[var(--app-info)] font-bold">{out.toolName}</span>: {redactSecrets(out.output)}
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
            <div className="flex items-center justify-between">
              <span className="t-caption font-semibold uppercase tracking-wider text-[var(--app-text-muted)]">
                {tx('inspectorEventsHeading', 'Recent activity')}
              </span>
              <span className="t-micro text-[var(--app-text-dim)]" aria-label={eventCountText}>
                {eventCountText}
              </span>
            </div>

            <div className="p-3 r-md edge bg-[var(--app-bg)] t-micro text-[var(--app-text-muted)] space-y-1 max-h-[calc(100vh-210px)] overflow-y-auto overflow-x-hidden">
              {gatewayLogs.length === 0 ? (
                <span className="text-[var(--app-text-dim)]">
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
            <span className="t-caption font-semibold text-[var(--app-text-muted)] uppercase tracking-wider block">
              {tx('inspectorUsageHeading', 'Session usage')}
            </span>

            {/* Token Metrics */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 r-md elev-0 edge bg-[var(--app-card)]">
                <span className="t-caption text-[var(--app-text-dim)] uppercase block">
                  {tx('inspectorInputTokens', 'Sent (tokens)')}
                </span>
                <span className="t-micro font-mono text-[var(--app-text)]">{usageIn.toLocaleString()}</span>
              </div>
              <div className="p-3 r-md elev-0 edge bg-[var(--app-card)]">
                <span className="t-caption text-[var(--app-text-dim)] uppercase block">
                  {tx('inspectorOutputTokens', 'Received (tokens)')}
                </span>
                <span className="t-micro font-mono text-[var(--app-text)]">{usageOut.toLocaleString()}</span>
              </div>
            </div>

            {/* Inference model, plain language on the front face */}
            <div className="p-3 r-md elev-0 edge bg-[var(--app-card)] space-y-2">
              <div className="flex justify-between items-center">
                <span className="t-caption text-[var(--app-text-muted)]">{tx('inspectorActiveModel', 'Model')}</span>
                <span className="t-micro font-mono text-[var(--app-text)] font-medium truncate max-w-[140px]">
                  {settings.modelId.split('/').pop() || tx('inspectorNotSet', 'Not set')}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="t-caption text-[var(--app-text-muted)]">{tx('inspectorProvider', 'Provider')}</span>
                <span className="t-micro font-mono text-[var(--app-text)]">{providerLabel}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="t-caption text-[var(--app-text-muted)]">{tx('inspectorThinking', 'Thinking effort')}</span>
                <span className="t-micro font-mono text-[var(--app-accent-text)]">{effortWord}</span>
              </div>
            </div>

            {/* Developer-only values live behind a disclosure, not on the front face. */}
            <div className="r-md elev-0 edge bg-[var(--app-card)]">
              <button
                type="button"
                onClick={() => setTechOpen((v) => !v)}
                aria-expanded={techOpen}
                aria-controls="inspector-tech-details"
                className="w-full min-h-[44px] px-3 flex items-center justify-between t-caption text-[var(--app-text-muted)] cursor-pointer"
              >
                <span className="font-medium">
                  {tx('inspectorTechDetails', 'Technical details')}
                </span>
                {techOpen ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>
              {techOpen && (
                <div id="inspector-tech-details" className="px-3 pb-3 space-y-1 font-mono t-micro text-[var(--app-text-muted)]">
                  <div className="flex justify-between gap-2">
                    <span>{tx('inspectorTechModelId', 'Model ID')}</span>
                    <span className="text-[var(--app-text)] break-all text-right">{settings.modelId}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>{tx('inspectorTechProviderId', 'Provider ID')}</span>
                    <span className="text-[var(--app-text)] break-all text-right">{settings.provider}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>{tx('inspectorTechEffort', 'Reasoning effort')}</span>
                    <span className="text-[var(--app-text)] break-all text-right">{settings.reasoningEffort}</span>
                  </div>
                  {(streaming || turnMeta) && (
                    <div className="flex justify-between gap-2">
                      <span>{tx('inspectorTechElapsed', 'Elapsed (s)')}</span>
                      <span className="text-[var(--app-text)] text-right">{streamElapsed}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Approvals summary. Approval states read through the shared
                .pill-* family; Off and unknown are always neutral. */}
            <div className="p-3 r-md elev-0 edge bg-[var(--app-card)] space-y-2">
              <span className="t-caption text-[var(--app-text-muted)] block font-medium">
                {tx('inspectorApprovalsHeading', 'Approvals')}
              </span>
              <div className="flex items-center justify-between">
                <span className="t-caption text-[var(--app-text-dim)]">{tx('inspectorPending', 'Waiting for you')}</span>
                <span
                  className={`t-micro font-semibold ${approvals.length > 0 ? 'pill-warning' : 'pill-neutral'}`}
                  aria-label={pendingCountText}
                >
                  {pendingCountText}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="t-caption text-[var(--app-text-dim)]">{tx('inspectorAutoApproveRow', 'Run without asking')}</span>
                <span
                  className={`t-micro font-semibold ${settings.autoApproveGlobal ? 'pill-warning' : 'pill-neutral'}`}
                >
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
