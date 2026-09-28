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
import { HomeTab } from './components/tabs/HomeTab';
import { ChatTab } from './components/tabs/ChatTab';
import { TabPaneSkeleton } from './components/ui/Skeleton';

// PERF-01: code-split the heavy routes so the initial bundle stays lean.
// Chat (default tab) and Home stay eager; Jobs (~26KB) and Settings (~67KB,
// incl. Diagnostics/Skills/Memory/Blueprints sections) load on demand.
const JobsTab = lazy(() =>
  import('./components/tabs/JobsTab').then((m) => ({ default: m.JobsTab }))
);
const SettingsTab = lazy(() =>
  import('./components/tabs/SettingsTab').then((m) => ({ default: m.SettingsTab }))
);

// Tab ids are stable: 0 Home, 1 Chat, 2 Jobs, 3 Settings.
const TAB_HASHES = ['#/home', '#/chat', '#/jobs', '#/settings'] as const;
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
  return 1; // Default to chat like Hermes Desktop
}

export const App: React.FC = () => {
  const { settings, updateSettings, selectSession, newSession, vaultUnlocked } = useHermes();
  const [currentTab, setCurrentTab] = useState<number>(readInitialTab);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isUnlocked, setIsUnlocked] = useState<boolean>(false);

  // Latest tab, readable from the back-button listener without re-registering
  // it. The listener must exist exactly once for the lifetime of the app.
  const currentTabRef = useRef<number>(currentTab);
  currentTabRef.current = currentTab;

  // Never render an out-of-range index, whatever a stored value or a stray
  // setCurrentTab() call hands us.
  const activeTab = normalizeTab(currentTab);

  // Android hardware/gesture back button.
  //
  // Order of precedence: the top-most open overlay wins (8 overlays register
  // through the shared overlay stack: provider modal, confirm dialogs, model
  // sheet, keys modal, sessions drawer, inspector, wizard, lock). Only when
  // nothing is open does back mean "go Home", and only from Home does it exit.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | null = null;
    let pending: Promise<CapacitorAppBackButtonHandle> | null = null;

    try {
      pending = CapacitorApp.addListener('backButton', () => {
        // 1. An open overlay consumes the press.
        if (closeTopOverlay()) return;
        // 2. A non-Home tab goes Home before the app is allowed to exit.
        if (currentTabRef.current !== HOME_TAB) {
          setCurrentTab(HOME_TAB);
          return;
        }
        // 3. Nothing left to dismiss: leave the app.
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

  // Background relock: when the vault relocks (AppLock on), drop the
  // unlocked flag so the PIN gate shows again. Legacy no-vault setups
  // keep the previous session-unlock behavior.
  useEffect(() => {
    if (!settings.appLockEnabled || vaultUnlocked) return;
    let hasVault = false;
    try {
      hasVault = !!localStorage.getItem('hermes_vault');
    } catch {}
    if (hasVault) setIsUnlocked(false);
  }, [vaultUnlocked, settings.appLockEnabled]);

  // Desktop layout controls (matchMedia with change listeners, no resize polling)
  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches
  );

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

  // Persist the active tab across reloads and expose hash deep links
  // (#/home, #/chat, #/jobs, #/settings) with back/forward support.
  // Init sync uses replaceState (no extra history entry on load); user tab
  // switches use pushState so back/forward walks the tab trail.
  //
  // Note on the Android back gesture: once the Capacitor App listener is live
  // it owns the press, so back goes to the overlay, then Home, then exit, as
  // specified. The history trail still exists for in-page back/forward and the
  // browser fallback (where the listener never registers and WebView goBack
  // walks these entries instead of leaving the app).
  const isFirstTabSync = useRef(true);
  useEffect(() => {
    const tab = normalizeTab(currentTab);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, String(tab));
    } catch {}
    const hash = TAB_HASHES[tab] ?? TAB_HASHES[HOME_TAB];
    if (typeof window !== 'undefined' && window.location.hash !== hash) {
      if (isFirstTabSync.current) {
        window.history.replaceState(null, '', hash);
      } else {
        window.history.pushState(null, '', hash);
      }
    }
    isFirstTabSync.current = false;
  }, [currentTab]);

  useEffect(() => {
    const handleHashChange = () => {
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
    await newSession();
    setCurrentTab(1);
  };

  return (
    <div
      className="h-screen h-[100dvh] w-screen flex overflow-hidden font-sans selection:bg-indigo-500/30 selection:text-indigo-200"
      style={{
        backgroundColor: 'var(--app-bg, #090B14)',
        color: 'var(--app-text, #F3F4F6)',
      }}
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
          className={`flex-1 min-h-0 ${activeTab === 1 ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
          style={{ backgroundColor: 'var(--app-bg, #090B14)' }}
        >
          {activeTab === 0 && (
            <HomeTab
              onGoChat={() => setCurrentTab(1)}
              // "Verify Gateway Diagnostics" card in HomeTab: the Diagnostics
              // section lives in Settings, so the card navigates there.
              onGoDiagnostics={() => setCurrentTab(3)}
              onGoActivity={() => setCurrentTab(2)}
              onGoSettings={() => setCurrentTab(3)}
              // "View all" on Recent Sessions: opens the sessions drawer so
              // every conversation is reachable, not just the newest four.
              onGoSessions={() => setIsDrawerOpen(true)}
            />
          )}
          {activeTab === 1 && (
            <ChatTab
              onGoSettings={() => setCurrentTab(3)}
              isDesktop={isDesktop}
            />
          )}
          {activeTab === 2 && (
            <Suspense fallback={<TabPaneSkeleton />}>
              <JobsTab />
            </Suspense>
          )}
          {activeTab === 3 && (
            <Suspense fallback={<TabPaneSkeleton />}>
              <SettingsTab />
            </Suspense>
          )}
        </main>

        {/* Mobile Navigation fallback when on smaller screens */}
        {!isDesktop && (
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
          aria-label="Inspector"
        >
          <button
            aria-label="Close Inspector"
            onClick={() => setInspectorOpen(false)}
            className="absolute inset-0 bg-black/60 cursor-pointer"
          />
          <div className="relative h-full max-w-[20rem] w-full flex">
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
