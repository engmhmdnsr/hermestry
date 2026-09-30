import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { useHermes } from './context/HermesContext';
import { closeTopOverlay } from './services/overlayStack';
import { Header } from './components/layout/Header';
import { BottomNav } from './components/layout/BottomNav';
import { DesktopSidebar } from './components/layout/DesktopSidebar';
import { DesktopInspector } from './components/layout/DesktopInspector';
import { SessionsDrawer } from './components/layout/SessionsDrawer';
import { OnboardingWizard } from './components/wizard/OnboardingWizard';
import { AppLockGate } from './components/security/AppLockGate';
import {
  TabPaneSkeleton,
  TabHeroSkeleton,
  CardSkeleton,
  ChatBubbleSkeleton,
} from './components/ui/Skeleton';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { TAB_HASHES } from './constants/tabs';

// PERF-01: code-split every tab so the initial bundle stays lean. Home and
// Chat used to be imported eagerly and kept a 719KB chunk inside the entry
// bundle, so first paint downloaded both even when the default tab (Home)
// needed one of them. All four tabs now load on demand; every tab is already
// wrapped below in its own Suspense with a geometry-matched fallback, and the
// shell-level Suspense keeps the header, nav and back handling alive while a
// chunk resolves.
const HomeTab = lazy(() =>
  import('./components/tabs/HomeTab').then((m) => ({ default: m.HomeTab }))
);
const ChatTab = lazy(() =>
  import('./components/tabs/ChatTab').then((m) => ({ default: m.ChatTab }))
);
const TerminalTab = lazy(() =>
  import('./components/tabs/TerminalTab').then((m) => ({ default: m.TerminalTab }))
);
const SettingsTab = lazy(() =>
  import('./components/tabs/SettingsTab').then((m) => ({ default: m.SettingsTab }))
);

// Tab ids are stable: 0 Home, 1 Chat, 2 Terminal, 3 Settings. The hash list
// itself lives in constants/tabs.ts so the shell and the header read the same
// route instead of holding copies that can drift.
const TAB_STORAGE_KEY = 'hermes_current_tab';
const HOME_TAB = 0;

// Capacitor "App" plugin handle (hardware/gesture back button, exitApp).
//
// @capacitor/app is NOT in the dependency tree, so it cannot be imported
// directly: adding it would mean a new native plugin plus a gradle sync, and
// this task must not touch package.json or run gradle. `registerPlugin` from
// @capacitor/core (already a dependency) resolves the same native plugin at
// runtime without a new package. If the native side is not synced the call
// rejects, which is caught below so the app never breaks, it just keeps the
// WebView default back behavior.
interface CapacitorAppBackButtonHandle {
  remove: () => Promise<void>;
}
interface CapacitorAppPlugin {
  addListener: (
    eventName: 'backButton',
    listener: (event: { canGoBack: boolean }) => void,
  ) => Promise<CapacitorAppBackButtonHandle>;
  exitApp: () => Promise<void>;
}
const CapacitorApp = registerPlugin<CapacitorAppPlugin>('App');

/** Keep a tab index inside the known range, or fall back to Home. */
function normalizeTab(value: number): number {
  return Number.isInteger(value) && value >= 0 && value < TAB_HASHES.length ? value : HOME_TAB;
}

/**
 * True when a vault cipher is present. This is the line that separates the
 * vault unlock path (PIN re-derives the session key and rehydrates secrets)
 * from the legacy no-vault path (AppLockGate compares the PIN against
 * settings.appLockPin instead). Read from storage on demand, because a vault
 * can appear or disappear during a session.
 */
function vaultExists(): boolean {
  try {
    return !!localStorage.getItem('hermes_vault');
  } catch {
    return false;
  }
}

function readInitialTab(): number {
  if (typeof window !== 'undefined') {
    const fromHash = (TAB_HASHES as readonly string[]).indexOf(window.location.hash);
    if (fromHash >= 0) return fromHash;
    try {
      const saved = parseInt(localStorage.getItem(TAB_STORAGE_KEY) || '', 10);
      // parseInt gives NaN for junk, so a malformed stored value cannot reach
      // the renderer as an out-of-range index.
      if (Number.isInteger(saved) && saved >= 0 && saved < TAB_HASHES.length) return saved;
    } catch {}
  }
  // Default to Home: the same value normalizeTab falls back to, so a first
  // run with no hash and no stored tab opens the tab the docs describe
  // instead of Chat.
  return HOME_TAB;
}

export const App: React.FC = () => {
  const { settings, updateSettings, selectSession, newSession, vaultUnlocked, t } = useHermes();
  const [currentTab, setCurrentTab] = useState<number>(readInitialTab);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isUnlocked, setIsUnlocked] = useState<boolean>(false);

  // i18n with an English fallback, same pattern the tabs use: t() returns the
  // key itself when no locale bundle ships it, and languages.ts is not ours to
  // edit, so every string here is tx('key', 'English fallback').
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Latest tab, readable from the back-button listener without re-registering
  // it. The listener must exist exactly once for the lifetime of the app.
  const currentTabRef = useRef<number>(currentTab);
  currentTabRef.current = currentTab;

  // Android back bookkeeping (used by the listener below).
  // - pushedTabEntriesRef: tab entries the sync effect pushed with pushState
  //   that back has not consumed yet. One press spends exactly one entry, so
  //   back walks the tab trail instead of jumping straight to Home.
  // - backInFlightRef: a history.back() is waiting for its URL to land, so a
  //   second press in the same gesture cannot spend an entry that was never
  //   rendered.
  // - replaceNextTabSyncRef: the Home fallback replaces the current entry
  //   instead of pushing, so the next press cannot bounce back to the tab it
  //   just left.
  const pushedTabEntriesRef = useRef<number>(0);
  const backInFlightRef = useRef<boolean>(false);
  const replaceNextTabSyncRef = useRef<boolean>(false);

  // Never render an out-of-range index, whatever a stored value or a stray
  // setCurrentTab() call hands us.
  const activeTab = normalizeTab(currentTab);

  // Android hardware/gesture back button.
  //
  // Order of precedence: a press that is already waiting on history.back()
  // is swallowed; then the top-most open overlay wins (8 overlays register
  // through the shared overlay stack: provider modal, confirm dialogs, model
  // sheet, keys modal, sessions drawer, inspector, wizard, lock); then back
  // consumes the tab history the sync effect pushed, one entry per press,
  // landing on the previously visited tab. Only when that trail is spent does
  // back mean "go Home", and only from Home does it exit.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | null = null;
    let pending: Promise<CapacitorAppBackButtonHandle> | null = null;

    try {
      pending = CapacitorApp.addListener('backButton', () => {
        // 0. A previous press already called history.back() and its URL has
        //    not landed yet. Swallow the repeat so two fast presses cannot
        //    skip the tab the first one was heading for.
        if (backInFlightRef.current) return;
        // 1. An open overlay consumes the press.
        if (closeTopOverlay()) return;
        // 2. Spend one pushed tab entry: this lands on the previous tab,
        //    which the hashchange listener below turns into setCurrentTab.
        //    The sync effect sees a matching hash and does not push again.
        if (pushedTabEntriesRef.current > 0) {
          pushedTabEntriesRef.current -= 1;
          backInFlightRef.current = true;
          window.history.back();
          // hashchange clears the flag first; the timer only covers a back
          // that lands on an identical URL and never fires the event.
          window.setTimeout(() => {
            backInFlightRef.current = false;
          }, 400);
          return;
        }
        // 3. The pushed history is spent: Home before exit. Replacing the
        //    current entry keeps the count at zero, so the next press exits
        //    instead of returning to the tab being left.
        if (currentTabRef.current !== HOME_TAB) {
          replaceNextTabSyncRef.current = true;
          setCurrentTab(HOME_TAB);
          return;
        }
        // 4. Nothing left to dismiss: leave the app.
        void CapacitorApp.exitApp();
      });
    } catch {
      pending = null;
    }

    if (pending) {
      pending
        .then((handle) => {
          if (cancelled) {
            void handle.remove();
            return;
          }
          remove = () => {
            void handle.remove();
          };
        })
        .catch(() => {
          // Native App plugin not synced (see note above): keep the default.
        });
    }

    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  // Lock bookkeeping for the two relock effects below: the listeners
  // register once and read the latest values through refs.
  const appLockEnabledRef = useRef(settings.appLockEnabled);
  appLockEnabledRef.current = settings.appLockEnabled;
  const isUnlockedRef = useRef(isUnlocked);
  isUnlockedRef.current = isUnlocked;
  const appLockPinRef = useRef(settings.appLockPin);
  appLockPinRef.current = settings.appLockPin;

  // Relock 1, vault setups: when the vault drops its unlocked state
  // (lockNow() or the context's own background handler), drop the local flag
  // so the PIN gate shows again. Keyed on a vault being present, because in
  // the legacy no-vault setup vaultUnlocked is false from boot and never
  // changes: driving the gate from that value alone would slam it shut on a
  // PIN-only user the moment they unlock, which is what would make
  // onUnlocked dead.
  useEffect(() => {
    if (!settings.appLockEnabled || vaultUnlocked) return;
    if (vaultExists()) setIsUnlocked(false);
  }, [vaultUnlocked, settings.appLockEnabled]);

  // Relock 2, legacy no-vault setups: there vaultUnlocked never moves, and
  // the context only calls lockSecrets() on hide when vaultUnlocked is true,
  // so nothing above ever fires and isUnlocked stayed true forever (the
  // audit's "the lock never returns after background"). Sending the app to
  // the background is the lock signal for this setup, and it is safe: the
  // legacy PIN is still in settings, so the gate that reopens can be opened
  // by the same PIN.
  //
  // The guard never re-arms a gate the user could not open. In the legacy
  // setup the only credential AppLockGate checks is settings.appLockPin, and
  // lockSecrets() blanks it while updateSettings() refuses to write a PIN
  // back while locked, so re-arming with it gone would strand a user who has
  // no vault to rehydrate from. That case needs a fix in HermesContext
  // (keep the legacy PIN across lockSecrets) and is reported, not hacked
  // around here.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) return;
      if (!appLockEnabledRef.current || !isUnlockedRef.current) return;
      if (!vaultExists() && !appLockPinRef.current) return;
      setIsUnlocked(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Desktop layout controls (matchMedia with change listeners, no resize polling)
  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches
  );
  // Keyboard open = hide the bottom nav so it never crowds the composer.
  // Same 80px floor ChatTab uses: URL bar shifts are not a keyboard.
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const wideQuery = window.matchMedia('(min-width: 1280px)');
    const handleDesktopChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
    };
    const handleWideChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setInspectorOpen(false);
    };
    desktopQuery.addEventListener('change', handleDesktopChange);
    wideQuery.addEventListener('change', handleWideChange);
    return () => {
      desktopQuery.removeEventListener('change', handleDesktopChange);
      wideQuery.removeEventListener('change', handleWideChange);
    };
  }, []);

  useEffect(() => {
    // adjustResize shrinks window.innerHeight when the keyboard opens while
    // the visual viewport barely moves, so height loss (not vv occlusion)
    // is the keyboard signal here. The max updates on growth (rotation).
    let maxH = window.innerHeight;
    const measureApp = () => {
      if (window.innerHeight > maxH) maxH = window.innerHeight;
      setKeyboardOpen(maxH - window.innerHeight >= 120);
    };
    // Rotation shrinks height without any growth event, so a portrait max
    // would fake an open keyboard for the whole landscape session. Rebase.
    const handleOrientation = () => {
      maxH = window.innerHeight;
      setKeyboardOpen(false);
      // The resize that follows rotation re-measures against the new base.
      window.setTimeout(measureApp, 100);
    };
    measureApp();
    window.addEventListener('resize', measureApp);
    window.addEventListener('orientationchange', handleOrientation);
    return () => {
      window.removeEventListener('resize', measureApp);
      window.removeEventListener('orientationchange', handleOrientation);
    };
  }, []);

  // Persist the active tab across reloads and expose hash deep links
  // (#/home, #/chat, #/terminal, #/settings) with back/forward support.
  // Init sync uses replaceState (no extra history entry on load); user tab
  // switches use pushState so back/forward walks the tab trail, and every
  // pushed entry is counted so the Android back listener can spend it.
  //
  // Note on the Android back gesture: once the Capacitor App listener is live
  // it owns the press, so back goes to the overlay, then through the pushed
  // tab entries one press at a time, then Home, then exit. The same history
  // trail is what the browser fallback walks (where the listener never
  // registers and WebView goBack uses these entries instead of leaving the
  // app).
  const isFirstTabSync = useRef(true);
  useEffect(() => {
    const tab = normalizeTab(currentTab);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, String(tab));
    } catch {}
    const hash = TAB_HASHES[tab] ?? TAB_HASHES[HOME_TAB];
    if (typeof window !== 'undefined' && window.location.hash !== hash) {
      if (isFirstTabSync.current || replaceNextTabSyncRef.current) {
        // First sync, or the Home fallback from the back listener: replace
        // instead of push, so back cannot return to the entry being left.
        window.history.replaceState(null, '', hash);
      } else {
        window.history.pushState(null, '', hash);
        pushedTabEntriesRef.current += 1;
      }
    }
    // Cleared unconditionally: a stale flag must not silently turn the next
    // real tab switch into a replace and corrupt the back count.
    replaceNextTabSyncRef.current = false;
    isFirstTabSync.current = false;
  }, [currentTab]);

  // Document title follows the active tab, so task switchers and screen
  // readers announce which screen the app is on. Same tab vocabulary as
  // BottomNav (tabHome/tabChat/tabTerminal/tabSettings with one-word
  // English fallbacks), placed before the early returns so every tab
  // reports its name.
  useEffect(() => {
    const labels = [
      tx('tabHome', 'Home'),
      tx('tabChat', 'Chat'),
      tx('tabTerminal', 'Terminal'),
      tx('tabSettings', 'Settings'),
    ];
    const label = labels[normalizeTab(activeTab)] ?? labels[HOME_TAB];
    document.title = `${label} - Hermes`;
  }, [activeTab, t]);

  useEffect(() => {
    const handleHashChange = () => {
      // The history.back() issued by the back listener has landed (or an
      // in-page navigation arrived): either way the wait is over.
      backInFlightRef.current = false;
      const idx = (TAB_HASHES as readonly string[]).indexOf(window.location.hash);
      // An unknown or malformed hash is ignored: it cannot select a tab.
      if (idx >= 0) setCurrentTab(idx);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // 1. First run wizard
  if (!settings.onboarded) {
    return (
      <OnboardingWizard
        onDone={() => {
          updateSettings({ onboarded: true });
        }}
      />
    );
  }

  // 2. PIN Security Gate
  if (settings.appLockEnabled && !isUnlocked) {
    return <AppLockGate onUnlocked={() => setIsUnlocked(true)} />;
  }

  const handleOpenNewChat = async () => {
    // newSession awaits a bridge lookup plus gateway round trips. If the
    // user moved to another tab inside that window, stay there instead of
    // yanking them back to Chat after the session lands.
    const tabBefore = currentTabRef.current;
    await newSession();
    if (currentTabRef.current !== tabBefore) return;
    setCurrentTab(1);
  };

  return (
    <div
      className="h-screen h-[100dvh] w-screen flex overflow-hidden font-sans bg-[var(--app-bg)] text-[var(--app-text)] selection:bg-[var(--app-accent-subtle)] selection:text-[var(--app-accent-text)]"
    >
      {/* Desktop 3-Panel: Left Sidebar */}
      {isDesktop && (
        <DesktopSidebar
          currentTab={activeTab}
          onSelectTab={(tab) => setCurrentTab(tab)}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onOpenNewChat={handleOpenNewChat}
        />
      )}

      {/* Main Content Workspace Center */}
      <div className="flex-1 flex flex-col h-full min-h-0 min-w-0 overflow-hidden">
        {/* Global App Header */}
        <Header
          activeTab={activeTab}
          onOpenDrawer={() => setIsDrawerOpen(true)}
          onGoApprovals={() => setCurrentTab(1)}
          isDesktop={isDesktop}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        />

        {/* Tab Viewport */}
        <main
          id="main-content"
          tabIndex={-1}
          className={`flex-1 min-h-0 bg-[var(--app-bg)] ${activeTab === 1 || activeTab === 2 ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
        >
          {/* ONE error boundary for the whole content area. A rejected lazy
              tab chunk (any of the four, now that Home and Chat split too) or
              a render throw inside any tab used to unmount the shell and leave
              a white screen. Now the failure is contained to the content area:
              Header, BottomNav, the sessions drawer and the Android
              back-button override all keep working. */}
          <ErrorBoundary
            onGoHome={() => setCurrentTab(HOME_TAB)}
            labels={{
              title: tx('screenFailedTitle', 'This screen did not load'),
              message: tx(
                'screenFailedBody',
                'The screen failed to load. Your session is still here, so you can retry or go back home.'
              ),
              details: tx('screenFailedDetails', 'Technical details'),
              retry: tx('retryAction', 'Retry'),
              home: tx('goHomeAction', 'Go home'),
            }}
          >
            {/* Shell-level Suspense, which keeps the shared skeleton as the
                generic outer fallback. Tab-level boundaries below resolve
                first, so this only catches a suspension from the shell. */}
            <Suspense fallback={<TabPaneSkeleton label={tx('loadingScreen', 'Loading screen')} />}>
              {activeTab === 0 && (
                <Suspense
                  // Home geometry: hero banner + stacked cards, gap-6/px-4/pt-4
                  // like the real tab. The inset is applied exactly once, here,
                  // never on the primitives, so it cannot double up.
                  fallback={
                    <div
                      role="status"
                      aria-label={tx('loadingHome', 'Loading home')}
                      className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pt-4 hm-tab-bottom"
                    >
                      <TabHeroSkeleton heightRem={8} />
                      <CardSkeleton cards={3} lines={2} />
                    </div>
                  }
                >
                  <HomeTab
                    onGoChat={() => setCurrentTab(1)}
                    // "Verify Gateway Diagnostics" card in HomeTab (the
                    // "Check connection" quick action): the Diagnostics
                    // section lives in Settings, so the card navigates there.
                    // Settings opens at its top, which shows no gateway
                    // details, so the flag below tells SettingsTab to expand
                    // its details disclosure and actually show the connection
                    // state the row promised.
                    onGoDiagnostics={() => {
                      try {
                        sessionStorage.setItem('hm:showGatewayDetails', '1');
                      } catch {}
                      setCurrentTab(3);
                    }}
                    onGoActivity={() => {
                      // Jobs live at the end of the sessions drawer now, so
                      // Activity opens the drawer with that section expanded.
                      try {
                        sessionStorage.setItem('hm:drawerJobs', '1');
                      } catch {}
                      setIsDrawerOpen(true);
                    }}
                    onGoSettings={() => setCurrentTab(3)}
                    // "View all" on Recent Sessions: opens the sessions drawer so
                    // every conversation is reachable, not just the newest four.
                    onGoSessions={() => setIsDrawerOpen(true)}
                  />
                </Suspense>
              )}
              {activeTab === 1 && (
                <Suspense
                  // Chat geometry: transcript bubbles. The label sits on the
                  // first bubble so the announcement happens once, and the
                  // second stays aria-hidden.
                  fallback={
                    <div className="flex flex-1 min-h-0 flex-col gap-3 px-4 pt-4 hm-tab-bottom">
                      <ChatBubbleSkeleton
                        side="start"
                        lines={3}
                        label={tx('loadingChat', 'Loading chat')}
                      />
                      <ChatBubbleSkeleton side="end" lines={2} />
                      <ChatBubbleSkeleton side="start" lines={4} />
                    </div>
                  }
                >
                  <ChatTab
                    onGoSettings={() => setCurrentTab(3)}
                    isDesktop={isDesktop}
                  />
                </Suspense>
              )}
              {activeTab === 2 && (
                <Suspense
                  // Terminal geometry: full-height console column, same as
                  // Chat (the transcript and the console both own their own
                  // scroll instead of the page's).
                  fallback={
                    <div className="flex flex-1 min-h-0 flex-col gap-3 px-4 pt-4 hm-tab-bottom">
                      <CardSkeleton cards={3} lines={2} />
                    </div>
                  }
                >
                  <TerminalTab />
                </Suspense>
              )}
              {activeTab === 3 && (
                <Suspense
                  // Settings geometry: a shorter hero (search/section header)
                  // plus a longer stack of setting cards.
                  fallback={
                    <div
                      role="status"
                      aria-label={tx('loadingSettings', 'Loading settings')}
                      className="space-y-4 max-w-2xl mx-auto px-4 pt-4 hm-tab-bottom"
                    >
                      <TabHeroSkeleton heightRem={6} />
                      <CardSkeleton cards={4} lines={2} />
                    </div>
                  }
                >
                  <SettingsTab />
                </Suspense>
              )}
            </Suspense>
          </ErrorBoundary>
        </main>

        {/* Mobile Navigation fallback when on smaller screens.
            Hidden while the keyboard is open so it never crowds the composer. */}
        {!isDesktop && !keyboardOpen && (
          <BottomNav
            currentTab={activeTab}
            onSelectTab={(tab) => setCurrentTab(tab)}
          />
        )}
      </div>

      {/* Desktop 3-Panel: Right Inspector (Tool pipeline, logs, telemetry) */}
      {isDesktop && inspectorOpen && (
        <DesktopInspector
          isOpen={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
        />
      )}

      {/* Phone Inspector: same panel as a slide-over overlay so the
          header Inspector toggle has a route on small screens too. */}
      {!isDesktop && inspectorOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label={tx('inspector', 'Inspector')}
        >
          <button
            aria-label={tx('inspectorClose', 'Close inspector')}
            onClick={() => setInspectorOpen(false)}
            className="absolute inset-0 bg-[var(--app-scrim)] cursor-pointer"
          />
          {/* Phone slide-over: narrower than the desktop 19.4rem panel so a
              sliver of the chat stays visible and the close scrim reachable. */}
          <div className="relative h-full max-w-[16rem] w-full flex">
            <div className="flex-1 flex min-w-0 [&>aside]:w-full [&>aside]:h-full">
              <DesktopInspector
                isOpen={inspectorOpen}
                onClose={() => setInspectorOpen(false)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Slide-over Sessions Drawer. Rendered on desktop too, because Home's
          "View all" opens it; the backdrop and close button are identical. */}
      <SessionsDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onSelectSession={(id) => {
          selectSession(id);
          setCurrentTab(1);
        }}
      />
    </div>
  );
};

export default App;
