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
  const { settings, updateSettings, selectSession, newSession } = useHermes();
  const [currentTab, setCurrentTab] = useState<number>(1); // Default to chat like Hermes Desktop
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isUnlocked, setIsUnlocked] = useState<boolean>(false);

  // Desktop layout controls
  const [isDesktop, setIsDesktop] = useState<boolean>(window.innerWidth >= 1024);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(window.innerWidth >= 1280);

  useEffect(() => {
    const handleResize = () => {
      const desktop = window.innerWidth >= 1024;
      setIsDesktop(desktop);
      if (window.innerWidth < 1280) {
        setInspectorOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
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
    const id = await newSession();
    selectSession(id);
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
          onGoSettings={() => setCurrentTab(3)}
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
