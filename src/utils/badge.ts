/**
 * Badge counts read as plain digits inside a shared .pill-danger badge.
 * Triple-digit counts would burst the pill, so every badge in the app
 * (BottomNav, Header, DesktopSidebar) caps through this one helper.
 */
export function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
