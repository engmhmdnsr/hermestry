import React from 'react';
import { LayoutGrid, MessageSquare, SquareTerminal, SlidersHorizontal } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { formatBadgeCount } from '../../utils/badge';

interface BottomNavProps {
  currentTab: number;
  onSelectTab: (tab: number) => void;
}

/**
 * Canonical tab label i18n keys. Exported so the header title, the bottom nav
 * and every aria-label read the same word for the same tab. Index order must
 * stay in sync with TAB_HASHES in constants/tabs.ts (0 Home, 1 Chat, 2 Terminal, 3 Settings).
 *
 * Short labels on purpose: the phone is 360dp and four long, jargon-heavy
 * labels clip into two lines. One word per tab, one line each.
 */
export const TAB_LABEL_KEYS = ['tabHome', 'tabChat', 'tabTerminal', 'tabSettings'] as const;
export const TAB_LABEL_FALLBACKS = ['Home', 'Chat', 'Terminal', 'Settings'] as const;

export const BottomNav: React.FC<BottomNavProps> = ({ currentTab, onSelectTab }) => {
  const { approvals, t } = useHermes();

  // English fallback for keys a locale bundle does not ship yet, so a missing
  // translation never renders a raw key name or a clipped long label.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  const approvalCount = approvals.length;

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
      hue: 'var(--app-tab-home)',
      soft: 'var(--app-tab-home-soft)',
    },
    {
      id: 1,
      label: tx(TAB_LABEL_KEYS[1], TAB_LABEL_FALLBACKS[1]),
      icon: MessageSquare,
      count: approvalCount,
      hue: 'var(--app-tab-chat)',
      soft: 'var(--app-tab-chat-soft)',
      // Singular when there is exactly one, so the badge never says
      // "1 approvals waiting for you".
      badgeLabel:
        approvalCount === 1
          ? tx('approvalsWaitingOne', '1 approval waiting for you')
          : tx('approvalsWaitingMany', '{count} approvals waiting for you').replace(
              '{count}',
              String(approvalCount)
            ),
    },
    {
      id: 2,
      label: tx(TAB_LABEL_KEYS[2], TAB_LABEL_FALLBACKS[2]),
      icon: SquareTerminal,
      count: 0,
      badgeLabel: '',
      hue: 'var(--app-tab-terminal)',
      soft: 'var(--app-tab-terminal-soft)',
    },
    {
      id: 3,
      label: tx(TAB_LABEL_KEYS[3], TAB_LABEL_FALLBACKS[3]),
      icon: SlidersHorizontal,
      count: 0,
      badgeLabel: '',
      hue: 'var(--app-tab-settings)',
      soft: 'var(--app-tab-settings-soft)',
    },
  ];

  return (
    <nav
      aria-label={tx('navMainLabel', 'Main navigation')}
      className="glass-nav shrink-0 z-30 w-full border-t border-[var(--app-nav-border)]"
      style={{
        // Edge-to-edge (targetSdk 36): the tab strip clears the home indicator.
        paddingBottom: 'calc(0.25rem + var(--safe-bottom, 0px))',
      }}
    >
      <div
        className="flex items-stretch justify-around max-w-lg md:max-w-3xl mx-auto px-1 md:px-6"
        // Same token the tabs' scroll padding uses (.hm-tab-bottom), so the nav
        // height and the content inset can never drift apart.
        style={{ height: 'var(--bottom-nav-height, 4rem)' }}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;
          const hasBadge = tab.count > 0;
          const badgeText = formatBadgeCount(tab.count);

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              aria-label={hasBadge ? `${tab.label}, ${tab.badgeLabel}` : tab.label}
              aria-current={isActive ? 'page' : undefined}
              className={`flex-1 min-w-0 flex flex-col items-center justify-center h-full cursor-pointer min-h-[44px] transition-colors duration-150 ${
                isActive
                  ? ''
                  : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
              }`}
              style={isActive ? { color: tab.hue } : undefined}
            >
              <div className="relative flex items-center justify-center">
                {/* Mockup active tab pill: 20% wash, subtle border, and glow */}
                <span
                  aria-hidden="true"
                  className="flex items-center justify-center px-3.5 py-1 rounded-full transition-all duration-150"
                  style={{
                    backgroundColor: isActive ? tab.soft : 'transparent',
                    border: isActive
                      ? `1px solid color-mix(in srgb, ${tab.hue} 30%, transparent)`
                      : '1px solid transparent',
                    boxShadow: isActive
                      ? `0 0 12px color-mix(in srgb, ${tab.hue} 30%, transparent)`
                      : 'none',
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
                // 4 columns on a 360dp screen is ~88px each: a long translated
                // label must ellipsis inside its own column instead of running
                // under the neighbouring tab.
                className={`font-mono text-[0.6875rem] leading-none tracking-tight mt-1 whitespace-nowrap truncate transition-colors ${
                  isActive ? 'font-bold' : 'font-medium text-[var(--app-text-muted)]'
                }`}
                style={isActive ? { color: tab.hue } : undefined}
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
