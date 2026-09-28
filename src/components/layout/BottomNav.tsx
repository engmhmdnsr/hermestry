import React from 'react';
import { LayoutGrid, MessageSquare, CalendarClock, SlidersHorizontal } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

interface BottomNavProps {
  currentTab: number;
  onSelectTab: (tab: number) => void;
}

/**
 * Canonical tab label i18n keys. Exported so the header title, the bottom nav
 * and every aria-label read the same word for the same tab. Index order must
 * stay in sync with TAB_HASHES in App.tsx (0 Home, 1 Chat, 2 Jobs, 3 Settings).
 *
 * Short labels on purpose: the phone is 360dp and four long, jargon-heavy
 * labels clip into two lines. One word per tab, one line each.
 */
export const TAB_LABEL_KEYS = ['tabHome', 'tabChat', 'tabJobs', 'tabSettings'] as const;
export const TAB_LABEL_FALLBACKS = ['Home', 'Chat', 'Jobs', 'Settings'] as const;

export const BottomNav: React.FC<BottomNavProps> = ({ currentTab, onSelectTab }) => {
  const { approvals, jobs, t } = useHermes();

  // English fallback for keys a locale bundle does not ship yet, so a missing
  // translation never renders a raw key name or a clipped long label.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  const approvalCount = approvals.length;
  const enabledJobs = jobs.filter((j) => j.enabled).length;

  // Badge meaning (audit item 4): the pending-approvals count stays on the Chat
  // tab, because that is where the ApprovalCard queue is actioned and where the
  // header approvals button also routes. It is made explicit instead of moved:
  // the button's accessible name says "Chat, 3 approvals waiting for you", so it
  // can no longer read as unread messages. The Jobs badge is the enabled-job
  // count and is labelled the same way.
  const tabs = [
    {
      id: 0,
      label: tx(TAB_LABEL_KEYS[0], TAB_LABEL_FALLBACKS[0]),
      icon: LayoutGrid,
      count: 0,
      badgeLabel: '',
    },
    {
      id: 1,
      label: tx(TAB_LABEL_KEYS[1], TAB_LABEL_FALLBACKS[1]),
      icon: MessageSquare,
      count: approvalCount,
      badgeLabel: tx('approvalsWaitingMany', '{count} approvals waiting for you').replace(
        '{count}',
        String(approvalCount)
      ),
    },
    {
      id: 2,
      label: tx(TAB_LABEL_KEYS[2], TAB_LABEL_FALLBACKS[2]),
      icon: CalendarClock,
      count: enabledJobs,
      badgeLabel: tx('jobsTurnedOnCount', '{count} jobs turned on').replace(
        '{count}',
        String(enabledJobs)
      ),
    },
    {
      id: 3,
      label: tx(TAB_LABEL_KEYS[3], TAB_LABEL_FALLBACKS[3]),
      icon: SlidersHorizontal,
      count: 0,
      badgeLabel: '',
    },
  ];

  return (
    <nav
      aria-label={tx('navMainLabel', 'Main navigation')}
      className="shrink-0 z-30 w-full backdrop-blur-xl border-t elev-2 edge"
      style={{
        backgroundColor: 'var(--app-bg)',
        // Edge-to-edge (targetSdk 36): the tab strip clears the home indicator.
        paddingBottom: 'calc(0.25rem + var(--safe-bottom, 0px))',
      }}
    >
      <div
        className="flex items-stretch justify-around max-w-lg mx-auto px-1"
        // Same token the tabs' scroll padding uses (.hm-tab-bottom), so the nav
        // height and the content inset can never drift apart.
        style={{ height: 'var(--bottom-nav-height, 4rem)' }}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;
          const hasBadge = tab.count > 0;
          const badgeText = tab.count > 99 ? '99+' : String(tab.count);

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              aria-label={hasBadge ? `${tab.label}, ${tab.badgeLabel}` : tab.label}
              aria-current={isActive ? 'page' : undefined}
              className={`flex-1 min-w-0 flex flex-col items-center justify-center h-full cursor-pointer min-h-[44px] min-w-[44px] transition-colors duration-150 ${
                isActive
                  ? ''
                  : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
              }`}
              style={isActive ? { color: 'var(--app-accent-text)' } : undefined}
            >
              <div className="relative flex items-center justify-center">
                {/* One visual language for all four tabs: icon plus label always
                    visible. The active tab reads as selected through a surface
                    tint behind the icon plus the accent icon and label, with no
                    scale jump and no per-tab hue. The pill reserves the same
                    box when inactive so nothing shifts on tap. */}
                <span
                  aria-hidden="true"
                  className="flex items-center justify-center w-14 h-7 r-sm transition-colors duration-150"
                  style={{
                    backgroundColor: isActive ? 'var(--app-accent-subtle)' : 'transparent',
                  }}
                >
                  <Icon className="w-5 h-5" />
                </span>
                {hasBadge && (
                  <span
                    aria-hidden="true"
                    // Real badge: shared .pill-danger plus a count that stays
                    // legible at 11px. The meaning travels on the button's
                    // aria-label instead.
                    className="absolute -top-1 -end-1 pill-danger font-mono font-semibold"
                  >
                    {badgeText}
                  </span>
                )}
              </div>
              <span
                className={`t-micro leading-none tracking-tight mt-1 whitespace-nowrap transition-colors ${
                  isActive ? 'font-semibold' : 'font-normal'
                }`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
