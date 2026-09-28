import React from 'react';
import { LayoutGrid, MessageSquare, CalendarClock, SlidersHorizontal } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface BottomNavProps {
  currentTab: number;
  onSelectTab: (tab: number) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ currentTab, onSelectTab }) => {
  const { approvals, jobs, t } = useHermes();

  // Tab labels match the canonical en strings in constants/languages.ts so
  // BottomNav, DesktopSidebar, and i18n never diverge. Ids are stable keys.
  const tabs = [
    { id: 0, label: t('home') || 'Overview', icon: LayoutGrid, badge: 0 },
    { id: 1, label: t('chat') || 'Workspace Chat', icon: MessageSquare, badge: approvals.length },
    { id: 2, label: t('jobs') || 'Cron & Tasks', icon: CalendarClock, badge: jobs.filter((j) => j.enabled).length },
    { id: 3, label: t('settings') || 'Ops & Settings', icon: SlidersHorizontal, badge: 0 },
  ];

  return (
    <nav
      className="shrink-0 z-30 w-full backdrop-blur-xl border-t pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      style={{
        backgroundColor: 'var(--app-bg, #090B0E)',
        borderColor: 'var(--app-border, rgba(255,255,255,0.08))',
      }}
    >
      <div className="flex items-center justify-around max-w-lg mx-auto h-16 px-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center h-full relative cursor-pointer transition-all duration-150 min-h-[44px] min-w-[44px] ${
                isActive
                  ? 'text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <div className="relative">
                <div
                  className={`p-1.5 rounded-xl transition-all duration-200 ${
                    isActive
                      ? 'bg-indigo-500/15 text-indigo-400 scale-105'
                      : 'text-slate-400'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                {tab.badge > 0 && (
                  <span className="absolute -top-1 -end-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white font-mono text-[9px] font-bold flex items-center justify-center ring-2 ring-[var(--app-bg,#090B0E)]">
                    {tab.badge}
                  </span>
                )}
              </div>
              <span className={`text-[11px] tracking-tight mt-1 transition-colors ${
                isActive ? 'font-semibold text-white' : 'font-normal text-slate-400'
              }`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
