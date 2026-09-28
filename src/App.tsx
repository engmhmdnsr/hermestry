import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useHermes } from './context/HermesContext';
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

function readInitialTab(): number {
  if (typeof window !== 'undefined') {
    const fromHash = (TAB_HASHES as readonly string[]).indexOf(window.location.hash);
    if (fromHash >= 0) return fromHash;
    try {
      const saved = parseInt(localStorage.getItem(TAB_STORAGE_KEY) || '', 10);
      if (saved >= 0 && saved < TAB_HASHES.length) return saved;
    } catch {}
  }
  return 1; // Default to chat like Hermes Desktop
}

export const App: React.FC = () => {
  const { settings, updateSettings, selectSession, newSession, vaultUnlocked } = useHermes();
  const [currentTab, setCurrentTab] = useState<number>(readInitialTab);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isUnlocked, setIsUnlocked] = useState<boolean>(false);

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
  const isFirstTabSync = useRef(true);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, String(currentTab));
    } catch {}
    const hash = TAB_HASHES[currentTab];
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
        backgroundColor: 'var(--app-bg, #090B0E)',
        color: 'var(--app-text, #F3F4F6)',
      }}
    >
      {/* Desktop 3-Panel: Left Sidebar */}
      {isDesktop && (
        <DesktopSidebar
          currentTab={currentTab}
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
          className={`flex-1 min-h-0 ${currentTab === 1 ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
          style={{ backgroundColor: 'var(--app-bg, #090B0E)' }}
        >
          {currentTab === 0 && (
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
          {currentTab === 1 && (
            <ChatTab
              onGoSettings={() => setCurrentTab(3)}
              isDesktop={isDesktop}
            />
          )}
          {currentTab === 2 && (
            <Suspense fallback={<TabPaneSkeleton />}>
              <JobsTab />
            </Suspense>
          )}
          {currentTab === 3 && (
            <Suspense fallback={<TabPaneSkeleton />}>
              <SettingsTab />
            </Suspense>
          )}
        </main>

        {/* Mobile Navigation fallback when on smaller screens */}
        {!isDesktop && (
          <BottomNav
            currentTab={currentTab}
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
