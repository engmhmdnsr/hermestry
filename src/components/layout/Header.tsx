import React from 'react';
import {
  Menu,
  AlertCircle,
  SidebarClose,
  SidebarOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface HeaderProps {
  onOpenDrawer: () => void;
  onGoSettings: () => void;
  isDesktop?: boolean;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenDrawer,
  onGoSettings,
  isDesktop = false,
  inspectorOpen = false,
  onToggleInspector,
  sidebarCollapsed = false,
  onToggleSidebar,
}) => {
  const {
    connected,
    install,
    usageIn,
    usageOut,
    approvals,
    settings,
    t,
  } = useHermes();

  const isHealthy = connected;
  const isConnecting = install === 'RUNNING' || install === 'INSTALLING';

  return (
    <header
      className="sticky top-0 z-30 backdrop-blur-xl border-b px-4 py-2.5 h-14 flex items-center justify-between"
      style={{
        backgroundColor: 'var(--app-bg, #090B14)',
        borderColor: 'var(--app-border, rgba(255,255,255,0.07))',
      }}
    >
      {/* Left Area: Mobile Drawer or Desktop Sidebar Toggle + Title */}
      <div className="flex items-center gap-3 min-w-0">
        {!isDesktop ? (
          <button
            onClick={onOpenDrawer}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-slate-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] active:scale-95 transition-all border border-white/[0.06] shrink-0"
            title="Open Conversations"
            aria-label="Open Conversations"
          >
            <Menu className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={onToggleSidebar}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/[0.05] transition"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <SidebarOpen className="w-4 h-4 rtl-flip" /> : <SidebarClose className="w-4 h-4 rtl-flip" />}
          </button>
        )}

        <div className="flex items-center gap-2.5 min-w-0">
          {!isDesktop && (
            <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-indigo-500/20 via-violet-500/20 to-teal-500/20 border border-indigo-500/30 p-1 flex items-center justify-center shrink-0">
              <img
                src="/ic_hermes_logo.png"
                alt="Hermes Logo"
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-white tracking-tight">
                Hermes Agent
              </span>
              <span className="text-[11px] text-slate-500 font-mono hidden sm:inline">
                {settings.modelId.split('/').pop()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right Area: Telemetry + Status + Approvals + Inspector */}
      <div className="flex items-center gap-2.5 shrink-0">
        {/* Token Usage Metrics */}
        <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 font-mono bg-[#11151B] px-2.5 py-1 rounded-lg border border-white/[0.06]">
          <span title="Prompt Input Tokens">↑ {fmtTok(usageIn)}</span>
          <span className="text-slate-600">·</span>
          <span title="Generated Output Tokens">↓ {fmtTok(usageOut)}</span>
        </div>

        {/* Connection status indicator */}
        <div className="flex items-center gap-1.5 text-xs bg-white/[0.02] px-2.5 py-1 rounded-lg border border-white/[0.05]">
          <span
            className={`w-2 h-2 rounded-full ${
              isHealthy
                ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
                : isConnecting
                ? 'bg-amber-400 animate-pulse'
                : 'bg-rose-500'
            }`}
          />
          <span className="text-slate-300 font-medium text-[11px] hidden xs:inline">
            {isHealthy ? (t('connected') || 'Connected') : isConnecting ? (t('starting') || 'Starting') : (t('offline') || 'Offline')}
          </span>
        </div>

        {/* Action-needed approvals badge button */}
        {approvals.length > 0 && (
          <button
            onClick={onGoSettings}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-medium hover:bg-rose-500/25 transition-colors cursor-pointer"
          >
            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
            <span>{approvals.length} {t('approvalNeeded') || 'Approval'}</span>
          </button>
        )}

        {/* Desktop Inspector Panel Toggle Button */}
        {isDesktop && onToggleInspector && (
          <button
            onClick={onToggleInspector}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer border ${
              inspectorOpen
                ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                : 'text-slate-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06]'
            }`}
            title="Toggle Right Inspector & Tools Panel"
          >
            {inspectorOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
            <span className="text-[11px] hidden md:inline">{t('inspector') || 'Inspector'}</span>
          </button>
        )}
      </div>
    </header>
  );
};
