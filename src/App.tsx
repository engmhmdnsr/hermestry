import React, { useState, useEffect } from 'react';
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
import { JobsTab } from './components/tabs/JobsTab';
import { SettingsTab } from './components/tabs/SettingsTab';

export const App: React.FC = () => {
  const { settings, updateSettings, selectSession, newSession, vaultUnlocked } = useHermes();
  const [currentTab, setCurrentTab] = useState<number>(1); // Default to chat like Hermes Desktop
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
          onGoSettings={() => setCurrentTab(1)}
          isDesktop={isDesktop}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        />

        {/* Tab Viewport */}
        <main
          className={`flex-1 min-h-0 ${currentTab === 1 ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
          style={{ backgroundColor: 'var(--app-bg, #090B0E)' }}
        >
          {currentTab === 0 && (
            <HomeTab
              onGoChat={() => setCurrentTab(1)}
              onRunCommand={() => setCurrentTab(1)}
              onGoActivity={() => setCurrentTab(2)}
              onGoSettings={() => setCurrentTab(3)}
            />
          )}
          {currentTab === 1 && (
            <ChatTab
              onGoSettings={() => setCurrentTab(3)}
              isDesktop={isDesktop}
            />
          )}
          {currentTab === 2 && <JobsTab />}
          {currentTab === 3 && <SettingsTab />}
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

      {/* Slide-over Sessions Drawer (for mobile view) */}
      {!isDesktop && (
        <SessionsDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          onSelectSession={(id) => {
            selectSession(id);
            setCurrentTab(1);
          }}
        />
      )}
    </div>
  );
};

export default App;
